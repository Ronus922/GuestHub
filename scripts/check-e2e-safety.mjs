// Safety test for the write-capable-E2E and production-deploy guards.
// Pure evaluation — no DB, no browser, no production data touched. The deploy
// guard is exercised against a THROWAWAY git repo built in a temp dir, so the
// verdicts are independent of the developer's current branch (the old check 9
// broke whenever the checkout sat on main == origin/main).
// Usage: node scripts/check-e2e-safety.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateE2EGuard, launchGuardedBrowser, GuardBlocked,
  assertExactCleanup, forbidBroadPredicate, PROD_TENANT,
} from "./lib/e2e-write-guard.mjs";
import { isAncestorOfOriginMain } from "./production-deploy-guard.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = join(ROOT, "scripts/production-deploy-guard.mjs");

let n = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); n++; };

// A fully-valid, isolated FAKE TEST environment (nothing production about it).
const TEST_TENANT = "11111111-1111-1111-1111-111111111111";
const GOOD_ENV = {
  E2E_WRITE_OK: "1", E2E_ENV: "test",
  DATABASE_URL: "postgres://test_user:pw@localhost:5433/guesthub_test",
  E2E_DB_MARKER: "guesthub_test",
  E2E_TEST_TENANTS: TEST_TENANT,
  NEXT_PUBLIC_APP_URL: "http://localhost:3999",
};
const GOOD_OPTS = { baseUrl: "http://localhost:3999", port: 3999, tenantId: TEST_TENANT };
const withEnv = (o) => ({ ...GOOD_ENV, ...o });
const withOpts = (o) => ({ ...GOOD_OPTS, ...o });

// 6 (baseline first, so the negatives are meaningful): fake test env is allowed
assert.equal(evaluateE2EGuard(GOOD_ENV, GOOD_OPTS).ok, true);
ok("6. a fully-isolated fake test environment is ALLOWED");

// 1. production URL rejected
{
  const r = evaluateE2EGuard(GOOD_ENV, withOpts({ baseUrl: "https://guesthub.bios.co.il" }));
  assert.equal(r.ok, false); assert.ok(r.reasons.some((x) => x.includes("guesthub.bios.co.il")));
  ok("1. production application URL is rejected");
}
// 2. production port 3007 rejected
{
  const r = evaluateE2EGuard(GOOD_ENV, withOpts({ port: 3007 }));
  assert.equal(r.ok, false); assert.ok(r.reasons.some((x) => x.includes("3007")));
  ok("2. production port 3007 is rejected");
}
// 3. production tenant rejected
{
  const r = evaluateE2EGuard(GOOD_ENV, withOpts({ tenantId: PROD_TENANT }));
  assert.equal(r.ok, false); assert.ok(r.reasons.some((x) => x.toLowerCase().includes("production tenant")));
  ok("3. production tenant is rejected");
}
// 4. production database marker rejected
{
  const r = evaluateE2EGuard(withEnv({ DATABASE_URL: "postgres://postgres.bios-vps:pw@localhost:5432/postgres" }), GOOD_OPTS);
  assert.equal(r.ok, false); assert.ok(r.reasons.some((x) => x.includes("bios-vps")));
  ok("4. production database marker is rejected");
}
// 5. missing opt-in rejected
{
  const env = withEnv({}); delete env.E2E_WRITE_OK;
  const r = evaluateE2EGuard(env, GOOD_OPTS);
  assert.equal(r.ok, false); assert.ok(r.reasons.some((x) => x.includes("E2E_WRITE_OK")));
  ok("5. missing opt-in is rejected");
}
// 7. refusal happens BEFORE browser launch/write
await (async () => {
  let launched = false;
  await assert.rejects(
    () => launchGuardedBrowser(() => { launched = true; return "browser"; }, GOOD_ENV, withOpts({ port: 3007 })),
    (e) => e instanceof GuardBlocked,
  );
  assert.equal(launched, false, "launch thunk must never run when blocked");
  ok("7. refusal occurs before browser launch / any write");
})();
// 8. cleanup requires exact ids / run ids; broad predicates refused
{
  assert.throws(() => assertExactCleanup([]));
  assert.throws(() => assertExactCleanup("all"));
  assert.equal(assertExactCleanup(["e2e_abc12345", "9f13945b-cf18-453b-9eda-2cd30ef32664"]), true);
  assert.throws(() => forbidBroadPredicate("DELETE FROM guesthub.pricing_plan_rates WHERE price = 900"));
  assert.throws(() => forbidBroadPredicate("DELETE FROM guesthub.pricing_plan_rates WHERE tenant_id = $1"));
  assert.equal(forbidBroadPredicate("DELETE FROM guesthub.pricing_plan_rates WHERE id = ANY($1)"), true);
  ok("8. cleanup helpers require exact ids/run ids and refuse broad predicates");
}
// 9. deploy-guard verdict matrix against a THROWAWAY git repo — every scenario
// is constructed explicitly, so the results never depend on the developer's
// current branch. The REAL guard script runs as a subprocess in that repo.
{
  // branch-independent sanity on the real repo first
  assert.equal(isAncestorOfOriginMain("origin/main"), true, "origin/main is trivially reachable");
  assert.equal(
    isAncestorOfOriginMain("0000000000000000000000000000000000000000"),
    false, "a commit not on origin/main is NOT reachable (fail-closed)",
  );

  const repo = mkdtempSync(join(tmpdir(), "gh-deploy-guard-"));
  const git = (...args) =>
    execFileSync("git", ["-C", repo, "-c", "user.email=guard@test", "-c", "user.name=guard", ...args],
      { encoding: "utf8" }).trim();
  const runGuard = (env = {}) => {
    try {
      execFileSync("node", [GUARD], {
        cwd: repo, encoding: "utf8",
        env: { ...process.env, PROD_DEPLOY_OK: "1", ...env },
      });
      return { ok: true, output: "" };
    } catch (e) {
      return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };

  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "app.txt"), "v1\n");
    git("add", "app.txt");
    git("commit", "-qm", "release v1");
    // simulate the fetched remote: origin/main == main
    git("update-ref", "refs/remotes/origin/main", "main");

    // (a) approved main: on main, clean, HEAD == origin/main → ALLOWED
    assert.equal(runGuard().ok, true, "clean approved main must deploy");

    // (b) missing explicit opt-in → BLOCKED
    {
      const r = runGuard({ PROD_DEPLOY_OK: "" });
      assert.equal(r.ok, false, "missing PROD_DEPLOY_OK must block");
      assert.ok(r.output.includes("PROD_DEPLOY_OK"), "reason names the opt-in");
    }

    // (c) dirty tracked tree → BLOCKED
    {
      writeFileSync(join(repo, "app.txt"), "dirty\n");
      const r = runGuard();
      assert.equal(r.ok, false, "dirty tree must block");
      assert.ok(r.output.includes("not clean"), "reason names the dirty tree");
      git("checkout", "-q", "--", "app.txt");
    }

    // (d) feature branch with an unapproved commit → BLOCKED (non-main branch
    //     + commit not reachable from origin/main)
    {
      git("checkout", "-qb", "feature/unapproved");
      writeFileSync(join(repo, "app.txt"), "v2\n");
      git("add", "app.txt");
      git("commit", "-qm", "unreviewed change");
      const r = runGuard();
      assert.equal(r.ok, false, "unapproved feature branch must block");
      assert.ok(r.output.includes("not reachable from origin/main"), "reason names reachability");
    }

    // (e) migration drift: a migration added outside the approved release →
    //     BLOCKED with the migrations reason (three-dot diff vs origin/main)
    {
      mkdirSync(join(repo, "db/migrations"), { recursive: true });
      writeFileSync(join(repo, "db/migrations/999_drift.sql"), "SELECT 1;\n");
      git("add", "db/migrations/999_drift.sql");
      git("commit", "-qm", "unapproved migration");
      const r = runGuard({ APPROVED_MAIN_COMMIT: git("rev-parse", "HEAD") });
      assert.equal(r.ok, false, "migration drift must block");
      assert.ok(r.output.includes("migrations outside approved release"), "reason names the migration");
    }

    // (f) back on approved main → ALLOWED again (the matrix is symmetric)
    {
      git("checkout", "-q", "main");
      assert.equal(runGuard().ok, true, "returning to approved main deploys again");
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }

  // (g) invalid deployment location: the canonical deploy script must keep the
  // production-runtime marker check that pins it to the marked checkout.
  const deploySh = readFileSync(join(ROOT, "scripts/deploy-production.sh"), "utf8");
  assert.ok(deploySh.includes(".production-runtime"), "deploy script pins the marked production runtime");

  ok("9. deploy-guard matrix: approved main deploys; opt-in, dirty tree, unapproved branch, migration drift and unmarked location all block");
}

console.log(`\nALL ${n} E2E/DEPLOY SAFETY CHECKS PASSED`);
