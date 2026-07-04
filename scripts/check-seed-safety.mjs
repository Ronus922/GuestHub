// Regression tests for the destructive-seed safety guard + owner-mapping recreation
// (added after the 2026-07-04 incident where `pnpm db:seed` truncated production and
// deleted the owner user r@bios.co.il).
//
// These tests DO NOT run the destructive seed against any real database. They exercise
// the guard's pure decision logic, the pure owner-row builder, and — for the "no
// TRUNCATE on rejection" case — spawn seed.mjs as a subprocess with guard-failing env
// and assert it exits BEFORE the truncate step (fake, unreachable DATABASE_URL).
//
// Usage: node scripts/check-seed-safety.mjs        (no DB access, no --env-file needed)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  evaluateSeedGuard,
  ownerUserRow,
  parseDbTarget,
  PROD_MARKERS,
  OWNER,
  OWNER_AUTH_USER_ID,
} from "./seed.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = join(HERE, "seed.mjs");
let n = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); n++; };

// A baseline env that WOULD pass, so each test can flip exactly one condition.
const approvedDevEnv = {
  DATABASE_URL: "postgresql://dev_user:pw@localhost:5432/guesthub_dev",
  ALLOW_DESTRUCTIVE_SEED: "1",
  SEED_ENV: "development",
  NODE_ENV: "development",
};

// ---- 1. seed refuses to run against production ----
{
  // NODE_ENV=production blocks
  const prod = evaluateSeedGuard({ ...approvedDevEnv, NODE_ENV: "production" });
  assert.equal(prod.ok, false);
  assert.ok(prod.reasons.some((r) => r.includes("NODE_ENV=production")));

  // the real production DB target blocks even WITH the opt-in + dev marker set
  const prodUrl = evaluateSeedGuard({
    ...approvedDevEnv,
    DATABASE_URL: "postgresql://postgres.bios-vps:pw@localhost:5432/postgres",
  });
  assert.equal(prodUrl.ok, false);
  assert.ok(prodUrl.reasons.some((r) => r.includes("production marker")));

  // a production marker anywhere (app URL) blocks
  const prodApp = evaluateSeedGuard({ ...approvedDevEnv, NEXT_PUBLIC_APP_URL: "https://guesthub.bios.co.il" });
  assert.equal(prodApp.ok, false);

  // fail-closed: empty env is blocked (missing opt-in + missing dev marker)
  const empty = evaluateSeedGuard({});
  assert.equal(empty.ok, false);
  assert.ok(empty.reasons.length >= 2);

  // missing opt-in alone blocks; missing dev/test marker alone blocks
  assert.equal(evaluateSeedGuard({ ...approvedDevEnv, ALLOW_DESTRUCTIVE_SEED: undefined }).ok, false);
  assert.equal(evaluateSeedGuard({ ...approvedDevEnv, SEED_ENV: "staging" }).ok, false);

  // the approved dev env DOES pass (control)
  assert.equal(evaluateSeedGuard(approvedDevEnv).ok, true);

  // parseDbTarget never leaks the password
  const t = parseDbTarget("postgresql://postgres.bios-vps:SUPERSECRET@localhost:5432/postgres");
  assert.equal(t.host, "localhost"); assert.equal(t.db, "postgres"); assert.equal(t.user, "postgres.bios-vps");
  assert.ok(!JSON.stringify(t).includes("SUPERSECRET"), "password must never appear in the target");
  assert.ok(PROD_MARKERS.includes("bios-vps"));
  ok("seed refuses to run against production (NODE_ENV, prod DB target, app URL, fail-closed default); no credential leak");
}

// ---- 2. no TRUNCATE occurs when the guard rejects execution ----
{
  // Spawn the real seed with guard-failing env and a fake, unreachable DB.
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: "production",                              // guaranteed block
    DATABASE_URL: "postgresql://u:p@127.0.0.1:1/devnull", // unreachable even if it proceeded
    // deliberately NO ALLOW_DESTRUCTIVE_SEED / SEED_ENV
  };
  const res = spawnSync(process.execPath, [SEED], { env, encoding: "utf8", timeout: 20000 });
  const out = `${res.stdout || ""}\n${res.stderr || ""}`;
  assert.notEqual(res.status, 0, "seed must exit non-zero when blocked");
  assert.ok(/BLOCKED/.test(out), "must announce it is blocked");
  assert.ok(!/truncating guesthub schema/i.test(out), "must NOT reach the truncate step");
  assert.ok(!/seed complete/i.test(out), "must NOT complete a seed");

  // second variant: opt-in set but production marker present → still blocked, still no truncate
  const env2 = {
    PATH: process.env.PATH,
    DATABASE_URL: "postgresql://postgres.bios-vps:p@127.0.0.1:1/postgres",
    ALLOW_DESTRUCTIVE_SEED: "1",
    SEED_ENV: "development",
  };
  const res2 = spawnSync(process.execPath, [SEED], { env: env2, encoding: "utf8", timeout: 20000 });
  const out2 = `${res2.stdout || ""}\n${res2.stderr || ""}`;
  assert.notEqual(res2.status, 0);
  assert.ok(!/truncating guesthub schema/i.test(out2), "prod marker blocks truncate even with opt-in");
  ok("no TRUNCATE occurs when the guard rejects (exits before truncate; prod marker overrides opt-in)");
}

// ---- 3. an approved development reseed recreates the owner mapping ----
{
  const row = ownerUserRow("TENANT-ID", "SUPER-ADMIN-ROLE-ID");
  assert.equal(row.email, "r@bios.co.il");
  assert.equal(row.username, "ronen");
  assert.equal(row.full_name, "Ronen Meshulam");
  assert.equal(row.auth_user_id, OWNER_AUTH_USER_ID);
  assert.equal(row.auth_user_id, "d94e462c-0eda-4edd-8e7c-3458b9277e2d");
  assert.equal(row.allow_google_auth, true);
  assert.equal(row.is_active, true);
  assert.equal(OWNER.email, "r@bios.co.il");
  // the approved env reaches this insert step
  assert.equal(evaluateSeedGuard(approvedDevEnv).ok, true);
  ok("approved development reseed recreates the owner mapping (super_admin, google-enabled, active)");
}

// ---- 4. owner maps to the GENERATED tenant + super_admin role (not hardcoded ids) ----
{
  const a = ownerUserRow("tenant-AAA", "role-BBB");
  assert.equal(a.tenant_id, "tenant-AAA", "tenant_id must be the passed generated id");
  assert.equal(a.role_id, "role-BBB", "role_id must be the passed generated id");
  const b = ownerUserRow("tenant-XYZ", "role-123");
  assert.equal(b.tenant_id, "tenant-XYZ");
  assert.equal(b.role_id, "role-123");
  // must refuse to build without generated ids (guards against hardcoding/omission)
  assert.throws(() => ownerUserRow(null, "role"), /required/);
  assert.throws(() => ownerUserRow("tenant", undefined), /required/);
  ok("owner maps to the generated tenant_id and super_admin role_id (derived, never hardcoded)");
}

// ---- 5. rerunning the approved seed does not create duplicates ----
{
  const src = readFileSync(SEED, "utf8");
  // idempotency-by-truncate: guesthub.users is truncated, then the owner is inserted once,
  // and the truncate precedes the owner insert — so a rerun cannot accumulate rows.
  assert.ok(/TRUNCATE[\s\S]*guesthub\.users/.test(src), "seed truncates guesthub.users");
  const ownerInserts = src.match(/ownerUserRow\(tenantId, roleId\.super_admin\)/g) || [];
  assert.equal(ownerInserts.length, 1, "owner is inserted exactly once per run");
  const truncateIdx = src.indexOf("TRUNCATE");
  const ownerIdx = src.indexOf("ownerUserRow(tenantId, roleId.super_admin)");
  assert.ok(truncateIdx !== -1 && ownerIdx !== -1 && truncateIdx < ownerIdx, "truncate precedes owner insert");
  // owner-row builder is deterministic (same inputs → identical row), so no drift across runs
  assert.deepEqual(ownerUserRow("t", "r"), ownerUserRow("t", "r"));
  ok("rerunning the approved seed does not create duplicates (truncate-first, single deterministic owner insert)");
}

console.log(`\nALL ${n} SEED-SAFETY CHECKS PASSED`);
