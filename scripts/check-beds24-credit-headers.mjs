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
// Three tiers (D138 — the suite measures code, liveness measures the live
// system), selected via CREDIT_HEADERS_TIERS (comma-separated, default "pure"):
//   pure  legs 1-4 — a local stub speaking the live header names: metered,
//         unmetered, casing, charged-fail. No DB, no network. Runs everywhere.
//   db    leg 6 — the reading round-trips through the REAL evidence
//         writer/reader inside a transaction that is ROLLED BACK. Needs only
//         DATABASE_URL; the suite hands the guard its own clone. Suite only —
//         never in liveness (B2: the liveness session is read-only, absolute).
//   live  leg 5 — one real read-only GET to Beds24 through the real client.
//         Liveness only (run-liveness.mjs). Token resolution is CACHE-ONLY:
//         the probe reads the token the WORKER maintains and NEVER mints or
//         persists one. An absent/expired cache is the finding — worker token
//         maintenance stopped — and minting here would mask exactly that
//         defect (and burn a Beds24 credit doing it). Inside the resolver's
//         5-minute refresh margin the leg still runs, with a warning (the
//         worker may be mid-refresh; not an alarm).
//
// run-checks.mjs supplies CREDIT_HEADERS_TIERS=pure,db; the liveness key
// supplies pure,live. Unknown tier tokens refuse loudly (exit 2).
//
// Usage: CREDIT_HEADERS_TIERS=pure[,db][,live] node --env-file=.env.local scripts/check-beds24-credit-headers.mjs
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
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

// ---- tier gate (D138). The default is the pure legs only — safe anywhere.
const KNOWN_TIERS = ["pure", "db", "live"];
const TIERS = (process.env.CREDIT_HEADERS_TIERS ?? "pure").split(",").map((s) => s.trim()).filter(Boolean);
const UNKNOWN = TIERS.filter((t) => !KNOWN_TIERS.includes(t));
if (UNKNOWN.length) {
  console.error(`CREDIT_HEADERS_TIERS: unknown tier(s) "${UNKNOWN.join('", "')}" — known: ${KNOWN_TIERS.join(", ")}`);
  process.exit(2);
}
const TIER = Object.fromEntries(KNOWN_TIERS.map((t) => [t, TIERS.includes(t)]));
console.log(`tiers: ${KNOWN_TIERS.map((t) => `${t}=${TIER[t] ? "RUN" : "skip"}`).join("  ")}`);

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
  // evidence/crypto/config are compiled explicitly so no tier ever needs a
  // prebuilt dist/ — the suite's worktrees have none.
  include: [
    join(ROOT, "src/lib/channel/beds24-ari.ts"),
    join(ROOT, "src/lib/channel/evidence.ts"),
    join(ROOT, "src/lib/channel/crypto.ts"),
    join(ROOT, "src/lib/channel/config.ts"),
  ],
}));
execSync(`"${join(ROOT, "node_modules/.bin/tsc")}" -p "${join(OUT, "tsconfig.json")}"`, {
  stdio: "pipe", cwd: ROOT,
});
const BUILD = join(OUT, "build");
const DIST = join(ROOT, "dist", "worker");
const STUB = join(ROOT, "scripts", "server-only-stub.cjs");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "server-only") return STUB;
  if (request.startsWith("@/")) {
    // prefer the freshly-compiled tree; fall back to dist for modules outside it
    try { return origResolve.call(this, join(BUILD, request.slice(2)), parent, ...rest); }
    catch { return origResolve.call(this, join(DIST, request.slice(2)), parent, ...rest); }
  }
  try { return origResolve.call(this, request, parent, ...rest); }
  catch (err) {
    // modules compiled into the tmp BUILD tree resolve bare imports (e.g.
    // "postgres") from the repo's node_modules — /tmp has none to walk up to
    if (parent?.filename?.startsWith(OUT)) {
      return origResolve.call(this, join(ROOT, "node_modules", request), parent, ...rest);
    }
    throw err;
  }
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
  if (TIER.pure) {
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
  }

  // ---- tier db (leg 6): the reading survives the REAL evidence writer AND
  // reader. Everything happens inside a transaction that is rolled back, so
  // the ledger is not touched. The ledger has no FK parents (migration 038),
  // so a fixture identity round-trips on a from-zero clone — nothing needs to
  // pre-exist.
  if (TIER.db) {
    const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
    try {
      const { recordAriEvidence } = require_(join(BUILD, "lib/channel/evidence.js"));
      const FIXTURE_TENANT = "00000000-0000-4000-8000-0000c4ed17c0";
      // leg-1's stub numbers: this leg proves the writer/reader CARRY the
      // fields; that the numbers are real is the live tier's job.
      const reading = { creditsRemaining: 97.8, requestCost: 1, creditsResetInSec: 146 };
      const ROLLBACK = Symbol("rollback");
      let ledger = null;
      try {
        await sql.begin(async (tx) => {
          await recordAriEvidence(tx, {
            tenantId: FIXTURE_TENANT,
            connectionId: null,
            environment: "production",
            scenarioKey: "credit_header_guard",
            kind: "probe",
            requestCount: 1,
            outcome: "success",
            context: reading,
          });
          const [row] = await tx`
            SELECT context FROM guesthub.channel_evidence_ledger
            WHERE tenant_id = ${FIXTURE_TENANT} AND scenario_key = 'credit_header_guard'
            ORDER BY created_at DESC LIMIT 1`;
          ledger = row ? row.context : null;
          throw ROLLBACK;
        });
      } catch (e) {
        if (e !== ROLLBACK) throw e;
      }
      assert.ok(ledger, "the evidence row must be readable back from the ledger");
      if (ledger) {
        assert.notEqual(ledger.creditsRemaining, null,
          "the ledger must carry a non-null creditsRemaining — this is the field that was null in all 220 rows");
        assert.equal(typeof ledger.creditsRemaining, "number", "creditsRemaining lands as a number");
        assert.equal(typeof ledger.requestCost, "number", "requestCost is recorded alongside it");
        ok(`ledger round-trip (rolled back) → creditsRemaining=${ledger.creditsRemaining}, requestCost=${ledger.requestCost}`);
      }
      const [left] = await sql`
        SELECT count(*)::int AS c FROM guesthub.channel_evidence_ledger
        WHERE scenario_key = 'credit_header_guard'`;
      assert.equal(left.c, 0, "the guard leaves no evidence rows behind");
      ok("no trace left in the ledger");
    } finally {
      await sql.end();
    }
  }

  // ---- tier live (leg 5): the real provider, through the real client.
  // CACHE-ONLY token doctrine (D138): a liveness probe OBSERVES. It reads the
  // access token the WORKER maintains; it never calls /authentication/token
  // and never persists anything.
  if (TIER.live) {
    const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
    try {
      const [conn] = await sql`
        SELECT id, tenant_id, api_key_ciphertext, access_token_ciphertext,
               access_token_expires_at, environment
        FROM guesthub.channel_connections
        WHERE provider = 'beds24' AND is_active_provider = true AND state = 'active'
        LIMIT 1`;
      assert.ok(conn, "an active beds24 connection is required for the live legs");

      if (conn) {
        // same reuse margin as the resolver (beds24-token.ts): inside it the
        // worker may already be mid-refresh, so a short remainder is a
        // warning. At/past expiry it is a RED — and still no mint.
        const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;
        const expRaw = conn.access_token_expires_at ?? null;
        const expMs = expRaw === null ? NaN : (expRaw instanceof Date ? expRaw.getTime() : Date.parse(expRaw));
        const msLeft = Number.isFinite(expMs) ? expMs - Date.now() : NaN;
        const cacheDefect = !conn.access_token_ciphertext
          ? "no access token cached"
          : !Number.isFinite(expMs)
            ? "cached token has no readable expiry"
            : msLeft <= 0
              ? `cached token expired ${Math.round(-msLeft / 60_000)}m ago`
              : null;
        assert.ok(cacheDefect === null,
          `${cacheDefect} — worker token maintenance is not keeping the token fresh; this probe NEVER mints (cache-only)`);

        if (cacheDefect === null) {
          if (msLeft <= TOKEN_REUSE_MARGIN_MS)
            console.log(`  ⚠ cached token expires in ${Math.round(msLeft / 1000)}s — inside the resolver's 5-minute refresh margin; the worker may be mid-refresh (not an alarm)`);
          const { decryptSecret } = require_(join(BUILD, "lib/channel/crypto.js"));
          let token = null;
          try {
            token = decryptSecret(conn.access_token_ciphertext);
          } catch {
            // recorded below — an undecryptable cache is a finding, not a crash
          }
          assert.ok(token, "cached access token failed to decrypt — has CHANNEL_SECRETS_KEY changed?");
          if (token) {
            const { beds24Request } = require_(join(BUILD, "lib/channel/beds24-http.js"));
            const { beds24BaseUrl } = require_(join(BUILD, "lib/channel/config.js"));
            // read-only, metered endpoint; no ARI is written by this check
            const live = await beds24Request({
              token, baseUrl: beds24BaseUrl(),
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
          }
        }
      }
    } finally {
      await sql.end();
    }
  }

  const SKIPPED = KNOWN_TIERS.filter((t) => !TIER[t]);
  console.log(`\nBEDS24 CREDIT HEADERS: ${n} PASSED (tiers run: ${TIERS.join("+")}${SKIPPED.length ? `; skipped: ${SKIPPED.join("+")}` : ""})`);
} catch (e) {
  console.error(`\nBEDS24 CREDIT HEADERS FAILED: ${e.message}`);
  process.exit(1);
}
