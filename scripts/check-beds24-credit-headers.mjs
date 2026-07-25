#!/usr/bin/env node
// check:beds24-credit-headers — the Beds24 credit meter actually measures.
//
// WHY. beds24-http.ts read `x-fivemincreditlimit-remaining`. Beds24 sends
// `x-five-min-limit-remaining`. The name never matched, so the credit meter
// was null in ALL 220 evidence rows and `x-request-cost` was never read at all
// — the meter did not break, it never worked. A guard that greps for a header
// NAME would have passed for those 220 rows just as happily, because the wrong
// name is still a string in the file. So this check never looks at the source:
// every assertion is on a VALUE that came back through the real client.
//
// Six legs, all behavioural:
//   1 metered      — a stub speaking the live header names → both numbers parse
//   2 unmetered    — a stub sending NO credit headers → measured:false, nulls,
//                    never a 0 that reads like a measurement
//   3 casing       — the same headers upper-cased → still parsed
//   4 charged fail — HTTP 429 still reports what the rejected call BURNED
//   5 live         — one real read-only GET to Beds24 → both numbers present
//   6 ledger       — the live reading round-trips through the REAL evidence
//                    writer/reader inside a transaction that is ROLLED BACK
//
// Leg 5 needs DATABASE_URL + a live beds24 connection; set SKIP_LIVE=1 to run
// only the offline legs (CI without credentials). Legs 1-4 and 6 are enough to
// fail every form of this bug.
//
// Usage: node --env-file=.env.local scripts/check-beds24-credit-headers.mjs
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import Module from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };
const ROOT = process.cwd();
const SKIP_LIVE = process.env.SKIP_LIVE === "1";

// ---- compile the REAL source under test, so a stale dist/ can never mask a
// regression and so `git checkout origin/main -- src/` is immediately visible.
const OUT = mkdtempSync(join(tmpdir(), "credit-headers-"));
writeFileSync(join(OUT, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    module: "commonjs", moduleResolution: "node10", target: "es2022",
    lib: ["es2023"], types: ["node"], typeRoots: [join(ROOT, "node_modules/@types")],
    esModuleInterop: true, skipLibCheck: true, strict: true, noEmitOnError: true,
    baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
    rootDir: join(ROOT, "src"), outDir: join(OUT, "build"),
  },
  include: [join(ROOT, "src/lib/channel/beds24-ari.ts")],
}));
execSync(`"${join(ROOT, "node_modules/.bin/tsc")}" -p "${join(OUT, "tsconfig.json")}"`, {
  stdio: "pipe", cwd: ROOT,
});
const BUILD = join(OUT, "build");
const DIST = join(ROOT, "dist", "worker");
const STUB = join(ROOT, "scripts", "server-only-stub.cjs");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return STUB;
  if (request.startsWith("@/")) {
    // prefer the freshly-compiled tree; fall back to dist for modules outside it
    try { return origResolve.call(this, join(BUILD, request.slice(2)), ...rest); }
    catch { return origResolve.call(this, join(DIST, request.slice(2)), ...rest); }
  }
  return origResolve.call(this, request, ...rest);
};
const require_ = createRequire(import.meta.url);
const { pushBeds24Calendar } = require_(join(BUILD, "lib/channel/beds24-ari.js"));

// ---- a stub that answers exactly like Beds24, headers configurable ----
const CALENDAR_OK = [{ roomId: 707490, success: true }];
async function withStub(headers, status, fn) {
  const server = createServer((req, res) => {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.setHeader("content-type", "application/json");
    res.writeHead(status);
    res.end(JSON.stringify(CALENDAR_OK));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const ENTRIES = [{ roomId: 707490, calendar: [{ from: "2026-07-25", to: "2026-07-25", numAvail: 0 }] }];
const push = (baseUrl) => pushBeds24Calendar({}, { token: "stub-token", baseUrl, entries: ENTRIES });

try {
  // ---- leg 1: metered response, live header names ----
  const metered = await withStub({
    "x-five-min-limit-remaining": "97.8",
    "x-five-min-limit-resets-in": "146",
    "x-request-cost": "1",
  }, 200, push);
  assert.equal(metered.ok, true, "a 200 with a success envelope is a successful push");
  assert.equal(typeof metered.credits.remaining, "number",
    "creditsRemaining must be a NUMBER — the header name the client reads does not match what Beds24 sends");
  assert.equal(metered.credits.remaining, 97.8, "the remaining-credit value is parsed exactly");
  assert.equal(typeof metered.credits.requestCost, "number",
    "requestCost must be a NUMBER — x-request-cost is not being read");
  assert.equal(metered.credits.requestCost, 1, "the per-request cost is parsed exactly");
  ok(`metered response → creditsRemaining=${metered.credits.remaining}, requestCost=${metered.credits.requestCost}`);

  // ---- leg 2: an UNMETERED endpoint must look unmeasured, never free ----
  const unmetered = await withStub({}, 200, push);
  assert.equal(unmetered.ok, true, "an unmetered response is still a valid push");
  assert.equal(unmetered.credits.remaining, null,
    "a missing credit header must surface as null — never 0, which reads as 'no credits left'");
  assert.equal(unmetered.credits.requestCost, null,
    "a missing cost header must surface as null — never 0, which reads as 'this call was free'");
  ok("unmetered response → nulls, not zeros (not-measured stays distinguishable)");

  // ---- leg 3: header casing must not decide whether we can measure ----
  const cased = await withStub({
    "X-Five-Min-Limit-Remaining": "42.5",
    "X-Request-Cost": "3",
  }, 200, push);
  assert.equal(cased.credits.remaining, 42.5, "header lookup must be case-insensitive");
  assert.equal(cased.credits.requestCost, 3, "cost lookup must be case-insensitive");
  ok("upper-cased headers still parse (case-insensitive lookup)");

  // ---- leg 4: a REJECTED call still burns credit — the meter must say so ----
  const throttled = await withStub({
    "x-five-min-limit-remaining": "0.2",
    "x-request-cost": "1",
    "retry-after": "42",
  }, 429, push);
  assert.equal(throttled.ok, false, "429 is a failure");
  assert.equal(throttled.category, "rate_limited", "429 maps to rate_limited");
  assert.equal(throttled.credits.remaining, 0.2, "a throttled call still reports remaining credit");
  assert.equal(throttled.credits.requestCost, 1, "a throttled call still reports what it consumed");
  ok("429 still reports remaining + cost (a rejected call is not a free call)");

  if (SKIP_LIVE) {
    console.log(`\nBEDS24 CREDIT HEADERS: ${n} PASSED (live legs skipped via SKIP_LIVE=1)`);
    process.exit(0);
  }

  // ---- leg 5: the real provider, through the real client ----
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  try {
    const [conn] = await sql`
      SELECT id, tenant_id, api_key_ciphertext, access_token_ciphertext,
             access_token_expires_at, environment
      FROM guesthub.channel_connections
      WHERE provider = 'beds24' AND is_active_provider = true AND state = 'active'
      LIMIT 1`;
    assert.ok(conn, "an active beds24 connection is required for the live legs");

    const { getBeds24AccessToken } = require_(join(DIST, "lib/channel/beds24-token.js"));
    const { beds24Request } = require_(join(BUILD, "lib/channel/beds24-http.js"));
    const { beds24BaseUrl } = require_(join(DIST, "lib/channel/config.js"));
    const access = await getBeds24AccessToken(sql, conn);
    assert.equal(access.ok, true, "a cached access token is required for the live legs");

    // read-only, metered endpoint; no ARI is written by this check
    const live = await beds24Request({
      token: access.token, baseUrl: beds24BaseUrl(),
      method: "GET", path: "/properties?includeAllRooms=false&page=1",
    });
    assert.equal(live.status, 200, "the live probe must succeed");
    assert.equal(live.credits.measured, true,
      "the live provider response must be recognised as metered — it is not being measured");
    assert.equal(typeof live.credits.remaining, "number",
      "the live remaining-credit header must parse to a number");
    assert.equal(typeof live.credits.requestCost, "number",
      "the live per-request cost header must parse to a number");
    assert.ok(live.credits.remaining > 0 && live.credits.remaining <= 100,
      "remaining credit sits inside the documented 100-per-5-minute window");
    assert.ok(live.credits.requestCost >= 1, "a metered call costs at least one credit");
    ok(`live Beds24 read → remaining=${live.credits.remaining}, cost=${live.credits.requestCost}, resetsIn=${live.credits.resetsInSec}s`);

    // ---- leg 6: the reading survives the REAL evidence writer AND reader ----
    // Everything below happens inside a transaction that is rolled back, so the
    // production ledger is not touched.
    const { recordAriEvidence } = require_(join(DIST, "lib/channel/evidence.js"));
    const ROLLBACK = Symbol("rollback");
    let ledger = null;
    try {
      await sql.begin(async (tx) => {
        await recordAriEvidence(tx, {
          tenantId: conn.tenant_id,
          connectionId: conn.id,
          environment: conn.environment,
          scenarioKey: "credit_header_guard",
          kind: "probe",
          requestCount: 1,
          outcome: "success",
          context: {
            creditsRemaining: live.credits.remaining,
            requestCost: live.credits.requestCost,
            creditsResetInSec: live.credits.resetsInSec,
          },
        });
        const [row] = await tx`
          SELECT context FROM guesthub.channel_evidence_ledger
          WHERE tenant_id = ${conn.tenant_id} AND scenario_key = 'credit_header_guard'
          ORDER BY created_at DESC LIMIT 1`;
        ledger = row ? row.context : null;
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    assert.ok(ledger, "the evidence row must be readable back from the ledger");
    assert.notEqual(ledger.creditsRemaining, null,
      "the ledger must carry a non-null creditsRemaining — this is the field that was null in all 220 rows");
    assert.equal(typeof ledger.creditsRemaining, "number", "creditsRemaining lands as a number");
    assert.equal(typeof ledger.requestCost, "number", "requestCost is recorded alongside it");
    ok(`ledger round-trip (rolled back) → creditsRemaining=${ledger.creditsRemaining}, requestCost=${ledger.requestCost}`);

    const [left] = await sql`
      SELECT count(*)::int AS c FROM guesthub.channel_evidence_ledger
      WHERE scenario_key = 'credit_header_guard'`;
    assert.equal(left.c, 0, "the guard leaves no evidence rows behind");
    ok("no trace left in the production ledger");
  } finally {
    await sql.end();
  }

  console.log(`\nBEDS24 CREDIT HEADERS: ${n} PASSED`);
} catch (e) {
  console.error(`\nBEDS24 CREDIT HEADERS FAILED: ${e.message}`);
  process.exit(1);
}
