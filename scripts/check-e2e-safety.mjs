// Safety test for the write-capable-E2E and production-deploy guards.
// Pure evaluation — no DB, no browser, no production data touched.
// Usage: node scripts/check-e2e-safety.mjs
import assert from "node:assert/strict";
import {
  evaluateE2EGuard, launchGuardedBrowser, GuardBlocked,
  assertExactCleanup, forbidBroadPredicate, PROD_TENANT,
} from "./lib/e2e-write-guard.mjs";
import { isAncestorOfOriginMain, evaluateDeployGuard } from "./production-deploy-guard.mjs";

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
// 9. production deploy rejects a commit not reachable from origin/main
{
  assert.equal(isAncestorOfOriginMain("origin/main"), true, "origin/main is trivially reachable");
  assert.equal(isAncestorOfOriginMain("HEAD"), false, "unmerged phase-4a HEAD is NOT reachable");
  const d = evaluateDeployGuard({ PROD_DEPLOY_OK: "1" });
  assert.equal(d.ok, false);
  assert.ok(d.reasons.some((x) => x.includes("not reachable from origin/main")));
  ok("9. production deploy rejects a commit not reachable from origin/main");
}

console.log(`\nALL ${n} E2E/DEPLOY SAFETY CHECKS PASSED`);
