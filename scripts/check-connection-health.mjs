#!/usr/bin/env node
// ============================================================
// check:connection-health — the six conditions of the Beds24 connection health
// signal (D133), plus the wiring that feeds them.
//
// WHY THIS GUARD EXISTS. The signal it replaces keyed on
// `access_token_expires_at <= now() + interval '24 hours'` against a token with
// a 24-hour lifetime: true 100% of the time, on every load, for months. No
// guard covered the alerts window at all, so nothing went red. The defect was
// found by hand. This is the guard that would have caught it — and the reason
// its first assertion is that ZERO is reachable.
//
// THE STANDARD IT IS HELD TO (B2). The condition suite runs TWICE: once against
// the real module, which must pass, and once against a MUTANT compiled from the
// same source with the semantic core neutralised — `connectionHealth` returning
// the healthy verdict for every input while every export, type and threshold
// stays intact. The mutant run MUST throw. A guard that only proves the module
// loads is not a guard.
//
// No database, no network: the rule is a pure module precisely so its verdict
// can be asserted directly. The DB-facing half is covered by static assertions
// on the query that feeds it (§C) — the shape a wrong query would take is a
// resurrected token predicate or a lost scope, and both are visible in source.
//
// Usage: node scripts/check-connection-health.mjs
// ============================================================
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve from THIS FILE's location — a guard must test the tree it lives in
// (check:guard-roots, D100).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

const SRC = join(ROOT, "src/lib/channel/connection-health.ts");
const DATA = join(ROOT, "src/app/(dashboard)/dashboard/data.ts");
const WINDOW = join(ROOT, "src/app/(dashboard)/dashboard/windows/AlertsWindow.tsx");

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

// ---- compile the pure module (and, later, its mutant) ----------------------
function compile(tsPath, label) {
  const out = mkdtempSync(join(tmpdir(), `connection-health-${label}-`));
  const cfg = join(out, "tsconfig.json");
  // `files` resolves relative to the tsconfig, which lives in /tmp — so the
  // entry is absolute, and rootDir pins the output layout.
  writeFileSync(
    cfg,
    JSON.stringify({
      compilerOptions: {
        outDir: out,
        module: "commonjs",
        target: "es2022",
        moduleResolution: "node10",
        skipLibCheck: true,
        strict: true,
        rootDir: dirname(tsPath),
      },
      files: [tsPath],
    }),
  );
  execSync(`pnpm exec tsc -p ${cfg}`, { stdio: "inherit", cwd: ROOT });
  return createRequire(import.meta.url)(join(out, "connection-health.js"));
}

const M = compile(SRC, "real");

// ---- fixtures ---------------------------------------------------------------
const NOW = Date.parse("2026-08-03T20:00:00Z");
const MIN = 60_000;

/** A connection with NOTHING wrong. Every fixture below is this, with exactly
 *  one field moved — so a row that appears is attributable to that one field. */
const HEALTHY = {
  state: "active",
  hasRefreshToken: true,
  consecutiveFailures: 0,
  circuitOpenUntilMs: null,
  inboundSyncEnabled: true,
  lastSuccessfulPullMs: NOW - 2 * MIN,
  workerBeatMs: NOW - 20_000,
};

const codes = (input) => M.connectionHealth(input, NOW).map((f) => f.code);

// ============================================================
// A. the six conditions — each in isolation, plus the all-clear
// ============================================================
function conditionSuite(mod) {
  const only = (input, code) => {
    const found = mod.connectionHealth(input, NOW);
    assert.deepEqual(
      found.map((f) => f.code),
      [code],
      `expected exactly [${code}], got [${found.map((f) => f.code).join(", ")}]`,
    );
    assert.ok(found[0].detail.length > 0, `${code} must carry its own Hebrew label`);
    return found[0];
  };

  // ---- 0. ZERO IS REACHABLE, and it is the normal state --------------------
  // The whole point of D133. This assertion is what the old predicate could
  // never have satisfied: it was true for every healthy connection ever.
  assert.deepEqual(mod.connectionHealth(HEALTHY, NOW), [], "a healthy connection reports NOTHING");

  // ---- 1. state is a failed state ------------------------------------------
  only({ ...HEALTHY, state: "error" }, "state_error");
  // 'paused' is an OPERATOR DECISION, not a failure (D133) — alerting on it
  // would nag about a choice the operator made deliberately.
  assert.deepEqual(mod.connectionHealth({ ...HEALTHY, state: "paused" }, NOW), [],
    "a paused connection is not an alert");

  // ---- 2. the breaker is open ----------------------------------------------
  {
    // realistic: the breaker only ever opens by counting failures, so the
    // fixture carries both — and the EXCLUSION must still yield one row.
    const f = only(
      { ...HEALTHY, consecutiveFailures: 5, circuitOpenUntilMs: NOW + 4 * MIN },
      "circuit_open",
    );
    assert.match(f.detail, /5/, "the open breaker reports the failure count that opened it");
    // a breaker whose cooldown has ELAPSED is half-open, not open: it allows a
    // trial, so it is not a standing alert.
    assert.deepEqual(
      mod.connectionHealth({ ...HEALTHY, circuitOpenUntilMs: NOW - MIN }, NOW).map((x) => x.code),
      [],
      "an elapsed cooldown (half-open) is not an alert",
    );
  }

  // ---- 3. consecutive outbound failures ------------------------------------
  {
    const f = only({ ...HEALTHY, consecutiveFailures: 2 }, "outbound_failures");
    // persistCircuit (beds24-ari-sync.ts:178-183) is the ONLY writer of this
    // counter and it runs on the outbound drain. The label must not claim the
    // whole connection is down.
    assert.match(f.detail, /היוצא/, "the label must name the OUTGOING sync, not the connection");
  }

  // ---- 4. the refresh token is missing -------------------------------------
  only({ ...HEALTHY, hasRefreshToken: false }, "refresh_token_missing");

  // ---- 5. no successful pull within 3 poll cycles --------------------------
  assert.equal(mod.PULL_STALE_MINUTES, 15, "the pull threshold is 3 × INBOUND_POLL_MINUTES");
  only({ ...HEALTHY, lastSuccessfulPullMs: NOW - 16 * MIN }, "pull_stale");
  only({ ...HEALTHY, lastSuccessfulPullMs: null }, "pull_stale");
  // 14 minutes is TWO missed cycles — jitter, not a pattern. The boundary is
  // asserted from both sides so a threshold drift cannot pass silently.
  assert.deepEqual(mod.connectionHealth({ ...HEALTHY, lastSuccessfulPullMs: NOW - 14 * MIN }, NOW), [],
    "two missed poll cycles are not yet an alert");
  // a connection that deliberately does not pull is never told it has not
  // pulled — that would be a permanent row, i.e. the D133 defect rebuilt.
  assert.deepEqual(
    mod.connectionHealth({ ...HEALTHY, inboundSyncEnabled: false, lastSuccessfulPullMs: null }, NOW),
    [],
    "inbound disabled ⇒ no pull alert",
  );

  // ---- 6. the worker is not beating ----------------------------------------
  assert.equal(mod.WORKER_STALE_SECONDS, 90, "the worker threshold is the rates-sync.ts:23 figure");
  only({ ...HEALTHY, workerBeatMs: NOW - 91_000 }, "worker_down");
  only({ ...HEALTHY, workerBeatMs: null }, "worker_down");
  assert.deepEqual(mod.connectionHealth({ ...HEALTHY, workerBeatMs: NOW - 89_000 }, NOW), [],
    "89 seconds is still a live worker");

  // ---- the EXCLUSION RULE ---------------------------------------------------
  // A dead worker is WHY nothing pulled. Both conditions are true here and the
  // signal must report ONE row — the cause, not the symptom.
  {
    const found = mod.connectionHealth(
      { ...HEALTHY, workerBeatMs: NOW - 10 * MIN, lastSuccessfulPullMs: NOW - 45 * MIN },
      NOW,
    );
    assert.deepEqual(found.map((f) => f.code), ["worker_down"],
      "a dead worker AND a stale pull must produce exactly one row: the worker");
  }
  // The same shape one level down: an open breaker is the escalation of the
  // failure count, never a second finding beside it.
  {
    const found = mod.connectionHealth(
      { ...HEALTHY, consecutiveFailures: 7, circuitOpenUntilMs: NOW + 2 * MIN },
      NOW,
    );
    assert.deepEqual(found.map((f) => f.code), ["circuit_open"],
      "an open breaker and its own failure count must produce exactly one row");
  }

  // ---- independence: six broken things report six rows ----------------------
  // Suppression must be SPECIFIC, not a cap. With every unsuppressed condition
  // true, four rows stand (worker_down eats pull_stale, circuit_open eats
  // outbound_failures).
  {
    const found = mod.connectionHealth(
      {
        state: "error",
        hasRefreshToken: false,
        consecutiveFailures: 9,
        circuitOpenUntilMs: NOW + MIN,
        inboundSyncEnabled: true,
        lastSuccessfulPullMs: null,
        workerBeatMs: null,
      },
      NOW,
    );
    assert.deepEqual(
      [...found.map((f) => f.code)].sort(),
      ["circuit_open", "refresh_token_missing", "state_error", "worker_down"],
      "conditions are independent — suppression is per-cause, not a cap",
    );
    assert.equal(new Set(found.map((f) => f.detail)).size, found.length,
      "every condition carries a DISTINCT label");
  }
}

conditionSuite(M);
ok("zero is reachable and is the normal state for a healthy connection");
ok("each of the six conditions fires alone, with its own Hebrew label");
ok("thresholds: pull 15 min = 3 × INBOUND_POLL_MINUTES, worker 90 s = rates-sync.ts:23");
ok("boundaries hold from both sides (14/16 min, 89/91 s) — a drift cannot pass");
ok("paused is not an alert; inbound-disabled is never told it has not pulled");
ok("exclusion: dead worker ⇒ one row; open breaker ⇒ one row");

// ============================================================
// B. the token predicate is GONE, and cannot come back
// ============================================================
{
  const rule = readFileSync(SRC, "utf8");
  const codeOf = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  assert.doesNotMatch(codeOf(rule), /access_token_expires_at|accessTokenExpires/,
    "the rule must not read the access token's expiry — it is a constant, not a signal");
  assert.doesNotMatch(codeOf(rule), /api_key_expires_at|apiKeyExpires/,
    "api_key_expires_at is Hospitable-only (migration 044) and must never feed this signal");

  const data = codeOf(readFileSync(DATA, "utf8"));
  assert.doesNotMatch(data, /24 hours/, "the 24-hour token predicate must not exist");
  assert.doesNotMatch(data, /access_token_expires_at/,
    "the alerts query must not select the access token's expiry");
  ok("no token-TTL predicate survives in the rule or in the query that feeds it");
}

// ============================================================
// C. the query wiring — scope, inputs, and no second verdict
// ============================================================
{
  const data = readFileSync(DATA, "utf8");
  const block = data.slice(data.indexOf("async function dashboardAlerts"));
  assert.ok(block.length > 0, "dashboardAlerts not found");

  assert.match(block, /is_active_provider = true/,
    "the connection scope is is_active_provider");
  // The old scope ALSO required state='active', which made the state condition
  // unreachable: a row in state='error' could never be selected in order to be
  // reported as being in error.
  assert.doesNotMatch(block, /state = 'active'/,
    "state='active' must not scope this query — it makes the state condition unreachable");

  for (const input of [
    /api_key_ciphertext IS NOT NULL/,
    /consecutive_failures/,
    /circuit_open_until/,
    /inbound_sync_enabled/,
    /job_type = 'pull_booking_revisions'/,
    /status = 'succeeded'/,
    /channel_worker_state/,
    /now\(\)::text AS db_now/,
  ]) {
    assert.match(block, input, `the query must load ${input}`);
  }
  // The verdict lives in ONE place. A threshold written into SQL would be a
  // second definition that the guard above could never see.
  assert.doesNotMatch(block, /interval '\d+ (minutes|hours|seconds)'/,
    "no threshold may be written into the alerts SQL — the rule module owns them");
  assert.match(data, /from "@\/lib\/channel\/connection-health"/,
    "data.ts must import the rule, not restate it");

  const win = readFileSync(WINDOW, "utf8");
  assert.doesNotMatch(win, /\btoken\s*:/, "the alert window must no longer carry a 'token' kind");
  assert.match(win, /connection:\s*"channels"/, "the connection alerts need their icon");
  ok("the query loads the six inputs, scopes on is_active_provider, and owns no threshold");
}

// ============================================================
// D. B2 — neutralise the semantic core; this guard MUST die
// ============================================================
{
  const src = readFileSync(SRC, "utf8");
  const ANCHOR = "\n  return out;\n}";
  assert.equal(src.split(ANCHOR).length, 2,
    "the B2 mutation anchor is not unique — re-derive it before trusting this guard");
  // The verdict is discarded at the return: every export, type, threshold,
  // condition and signature survives and still COMPILES, while the answer
  // becomes "healthy" for every input. Exactly the failure this guard exists to
  // catch, injected on purpose. (Neutralising by early-return instead would
  // leave the conditions unreachable, and unreachable code loses TypeScript's
  // narrowing — the mutant would fail to build rather than to answer, which
  // proves nothing about the assertions.)
  const mutantDir = mkdtempSync(join(tmpdir(), "connection-health-mutant-src-"));
  const mutantPath = join(mutantDir, "connection-health.ts");
  writeFileSync(mutantPath, src.replace(ANCHOR, "\n  return [];\n}"));

  const MUT = compile(mutantPath, "mutant");
  assert.deepEqual(MUT.connectionHealth({ ...HEALTHY, state: "error" }, NOW), [],
    "the mutant must actually be neutralised");
  assert.equal(MUT.PULL_STALE_MINUTES, 15, "the mutant must keep its structure intact");

  let died = false;
  try {
    conditionSuite(MUT);
  } catch {
    died = true;
  }
  assert.ok(died, "B2 FAILED: the condition suite passed against a neutralised rule");
  ok("B2: the suite dies against a mutant that always reports healthy");
}

// codes() is the compact form used while developing a new condition; keeping it
// exercised means it cannot rot into a lie.
assert.deepEqual(codes({ ...HEALTHY, hasRefreshToken: false }), ["refresh_token_missing"]);

console.log(`\nCONNECTION HEALTH CHECK: ${n} PASSED`);
