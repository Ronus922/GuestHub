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
  PROD_TENANT_ID,
  SEED_EMAILS,
  foreignEmails,
  assertNoForeignUsers,
  assertNoProductionTenant,
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

// ============================================================
// Live-DB guards: the seed must ask the DATABASE who is in it, not the env.
// The env guard cannot see real accounts; these do. Helpers below drive the
// guards with a fake postgres tag so nothing touches a real database.
// ============================================================

// A postgres-style tagged template that resolves to fixed rows / rejects.
const clientReturning = (rows) => () => Promise.resolve(rows);
const clientFailing = (err) => () => Promise.reject(err);
const pgError = (code, message) => Object.assign(new Error(message), { code });

// Run a guard with console captured and exit recorded — never terminates.
async function runGuard(guard, client) {
  const codes = [];
  const lines = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  try {
    const passed = await guard(client, (c) => codes.push(c));
    return { passed, codes, out: lines.join("\n") };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

// ---- 6. CHECK A refuses ANY account the seed does not itself create ----
{
  const seedRows = SEED_EMAILS.map((email) => ({ email }));

  // the real lockout case: an account outside the seed, present alongside seed rows
  const efrat = await runGuard(assertNoForeignUsers, clientReturning([
    ...seedRows,
    { email: "efratmax76@gmail.com" },
  ]));
  assert.equal(efrat.passed, false, "a non-seed account must block the seed");
  assert.deepEqual(efrat.codes, [1], "must exit(1)");
  assert.ok(/efratmax76@gmail\.com/.test(efrat.out), "must name the offending account");
  assert.ok(/BLOCKED/.test(efrat.out));

  // categorical, not a special case: an unrelated address blocks identically
  const other = await runGuard(assertNoForeignUsers, clientReturning([{ email: "someone.else@example.org" }]));
  assert.equal(other.passed, false, "any non-seed account blocks, not just the known one");
  assert.deepEqual(other.codes, [1]);
  assert.ok(/someone\.else@example\.org/.test(other.out));

  // a row with no email is not a seed account either — refuse rather than skip it
  const nameless = await runGuard(assertNoForeignUsers, clientReturning([{ email: null }]));
  assert.equal(nameless.passed, false, "a user row with no email must block (it is not a seed account)");
  assert.deepEqual(nameless.codes, [1]);
  assert.ok(/no email address/.test(nameless.out), "must say the row has no address");

  // …and the guard hardcodes no address: the allowlist is the seed's own list
  const src = readFileSync(SEED, "utf8");
  assert.ok(!/efratmax76/i.test(src), "seed.mjs must not special-case any real user's address");
  assert.deepEqual(
    foreignEmails(["efratmax76@gmail.com", "someone@else.test", ...SEED_EMAILS]),
    ["efratmax76@gmail.com", "someone@else.test"],
    "foreignEmails returns exactly the accounts the seed does not own",
  );
  ok("CHECK A refuses any account the seed does not create (categorical — efratmax76@gmail.com only as an instance)");
}

// ---- 7. CHECK A passes when only seed-owned accounts are present (control) ----
{
  const seedOnly = await runGuard(assertNoForeignUsers, clientReturning(SEED_EMAILS.map((email) => ({ email }))));
  assert.equal(seedOnly.passed, true, "seed-owned accounts alone must not block");
  assert.deepEqual(seedOnly.codes, [], "control must not exit");

  // case-insensitive: the same accounts in different casing are still seed-owned
  const cased = await runGuard(assertNoForeignUsers, clientReturning(SEED_EMAILS.map((email) => ({ email: email.toUpperCase() }))));
  assert.equal(cased.passed, true, "email comparison must be case-insensitive");

  // an empty table and a fresh install (no such relation) both pass
  assert.equal((await runGuard(assertNoForeignUsers, clientReturning([]))).passed, true);
  const fresh = await runGuard(assertNoForeignUsers, clientFailing(pgError("42P01", 'relation "guesthub.users" does not exist')));
  assert.equal(fresh.passed, true, "a fresh install must still be seedable");
  assert.deepEqual(fresh.codes, []);

  // the owner is seed-owned (the seed recreates the mapping) and must not block
  assert.ok(SEED_EMAILS.includes(OWNER.email));
  assert.deepEqual(foreignEmails([OWNER.email]), []);
  ok("CHECK A passes when only the seed's own accounts are present (control: seeded set, casing, empty table, fresh install)");
}

// ---- 8. CHECK B refuses the production tenant, passes without it ----
{
  assert.equal(PROD_TENANT_ID, "68139d06-58c4-4043-b256-4691f83e1556");

  const prod = await runGuard(assertNoProductionTenant, clientReturning([{ id: PROD_TENANT_ID }]));
  assert.equal(prod.passed, false, "the production tenant must block the seed");
  assert.deepEqual(prod.codes, [1], "must exit(1)");
  assert.ok(/PRODUCTION data/.test(prod.out) && new RegExp(PROD_TENANT_ID).test(prod.out));

  // control: the tenant is absent → the query returns no rows → passes
  const absent = await runGuard(assertNoProductionTenant, clientReturning([]));
  assert.equal(absent.passed, true, "a DB without the production tenant must be seedable");
  assert.deepEqual(absent.codes, []);
  const freshB = await runGuard(assertNoProductionTenant, clientFailing(pgError("3F000", 'schema "guesthub" does not exist')));
  assert.equal(freshB.passed, true, "a fresh install must still be seedable");

  // no flag or env var can turn this check off
  const src = readFileSync(SEED, "utf8");
  const guardSrc = src.slice(src.indexOf("export async function assertNoForeignUsers"), src.indexOf("async function main()"));
  assert.ok(!/process\.env/.test(guardSrc), "the live-DB guards must read no env — there is no override");
  ok("CHECK B refuses when the production tenant is present, passes when it is absent (no override path)");
}

// ---- 9. both guards FAIL CLOSED when the database cannot be read ----
{
  const unreachable = pgError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:1");
  for (const [name, guard] of [["CHECK A", assertNoForeignUsers], ["CHECK B", assertNoProductionTenant]]) {
    const r = await runGuard(guard, clientFailing(unreachable));
    assert.equal(r.passed, false, `${name} must refuse when the DB cannot be read`);
    assert.deepEqual(r.codes, [1], `${name} must exit(1) on a DB error`);
    assert.ok(/BLOCKED/.test(r.out), `${name} must say why`);
  }
  // a driver error must never carry a connection string into the log
  const leaky = pgError("28P01", 'auth failed for postgresql://postgres.bios-vps:SUPERSECRET@db:5432/postgres'); // no-secrets-allow: synthetic DSN — this line IS the redaction fixture
  const red = await runGuard(assertNoForeignUsers, clientFailing(leaky));
  assert.equal(red.passed, false);
  assert.ok(!/SUPERSECRET/.test(red.out) && !/postgresql:\/\//.test(red.out), "must not print connection strings or passwords");
  ok("both live-DB guards fail closed on a DB error (refuse, never pass) without leaking credentials");
}

// ---- 10. the live-DB guards refuse BEFORE any TRUNCATE ----
{
  // Env guard PASSES here, so only the live-DB layer can stop this run. The DB is
  // unreachable → fail-closed refusal. Nothing is truncated (and the DB is fake).
  const env = {
    PATH: process.env.PATH,
    DATABASE_URL: "postgresql://u:p@127.0.0.1:1/devnull", // unreachable, no prod marker
    ALLOW_DESTRUCTIVE_SEED: "1",
    SEED_ENV: "development",
    NODE_ENV: "development",
  };
  const res = spawnSync(process.execPath, [SEED], { env, encoding: "utf8", timeout: 20000 });
  const out = `${res.stdout || ""}\n${res.stderr || ""}`;
  assert.ok(/seed guard passed/.test(out), "the env guard must pass, so the live-DB layer is what refuses");
  assert.notEqual(res.status, 0, "an unreachable DB must refuse, not pass");
  assert.ok(/BLOCKED/.test(out), "must announce it is blocked");
  assert.ok(!/truncating guesthub schema/i.test(out), "must NOT reach the truncate step");
  assert.ok(!/seed complete/i.test(out), "must NOT complete a seed");

  // …and in source both live checks sit before the TRUNCATE statement
  const src = readFileSync(SEED, "utf8");
  const truncateIdx = src.indexOf("await sql.unsafe(`TRUNCATE");
  const aIdx = src.indexOf("await assertNoForeignUsers(sql)");
  const bIdx = src.indexOf("await assertNoProductionTenant(sql)");
  assert.ok(truncateIdx > 0 && aIdx > 0 && bIdx > 0, "both live checks must be called in main()");
  assert.ok(aIdx < truncateIdx && bIdx < truncateIdx, "both live checks must run before the TRUNCATE");
  ok("the live-DB guards refuse before any TRUNCATE (env guard passed, unreachable DB blocked, call sites precede the truncate)");
}

console.log(`\nALL ${n} SEED-SAFETY CHECKS PASSED`);
