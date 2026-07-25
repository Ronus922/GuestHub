#!/usr/bin/env node
// ============================================================
// check:beds24-connection — TARGET 2.7, rebuilt to the B2 standard.
//
// WHAT IT USED TO BE (measured 2026-07-25, clean origin/main 5b171bd):
//   `node --env-file=.env.local scripts/check-beds24-connection.mjs` — it read
//   process.env.DATABASE_URL and asserted five things about the LIVE
//   PRODUCTION connection row. Two consequences:
//     · pointing an automated guard at production data is forbidden;
//     · in any worktree it died with `node: .env.local: not found` (exit 9)
//       before assertion #1 — red whether the system was healthy or broken.
//   Under experiment B2 (circuitAllowsRequest() semantically neutered in
//   src/lib/channel/circuit-breaker.ts) its output was BYTE-IDENTICAL: it
//   imported no application code, so no defect in src/ could turn it red.
//
// WHAT IT IS NOW. Five rules (C1..C5) live in scripts/lib/beds24-health-rules
// as pure predicates. Each is exercised TWICE against STAGING, on state read
// BACK out of the database:
//     ACCEPT arm — a satisfying fixture; the rule must return ok.
//     REJECT arm — a fixture violating exactly that one rule; the rule must
//                  return not-ok. This arm is what makes a neutered rule red.
// C1/C3 additionally run the SHIPPED selector loadDrainableBeds24Connections()
// from src/lib/channel/beds24-ari-sync.ts over the same fixture, and C5 runs
// the SHIPPED circuitPhase()/circuitAllowsRequest() from
// src/lib/channel/circuit-breaker.ts — so a semantic neutering of either file
// now turns THIS guard red.
//
// Everything happens inside ONE transaction that is always rolled back; the
// row counts are re-checked afterwards and a single leaked row fails the run.
//
// HONEST LIMIT (see docs/GUARD_BEDS24_FOUR_B2.md §findings): C1..C5 assert
// that the RULES are correct, not that the live production connection is
// healthy. The live-state observation is preserved as an explicit, opt-in
// `--observe` mode that requires a DSN to be named on purpose; it is never the
// default and it is never what a green tick means.
//
// Usage: node scripts/check-beds24-connection.mjs
//        node scripts/check-beds24-connection.mjs --observe   (ops probe)
// ============================================================
import assert from "node:assert/strict";
import postgres from "postgres";
import { resolveCheckDbUrl, redactDsn } from "./lib/check-db-target.mjs";
import {
  ruleSingleActiveBeds24Connection,
  ruleActiveConnectionIsProduction,
  ruleBothSyncDirectionsEnabled,
  ruleRefreshTokenPresent,
  ruleCircuitBreakerClosed,
} from "./lib/beds24-health-rules.mjs";
import {
  withRollback,
  countFixtureTables,
  assertNoNetRows,
  seedConnection,
  readActiveConnections,
  loadWorkerModules,
} from "./lib/beds24-staging-fixture.mjs";

const CHECK = "check:beds24-connection";
const OBSERVE = process.argv.includes("--observe");
const url = resolveCheckDbUrl(CHECK);
const sql = postgres(url, { prepare: false, max: 1 });

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

/** BEHAVIOURAL: the rule must ACCEPT state read back from the database. */
function expectAccept(id, verdict) {
  assert.ok(verdict.ok, `BEHAVIOUR BREACH — ${id} rejected a healthy fixture: ${verdict.detail}`);
  ok(`${id} accepts a healthy fixture — ${verdict.detail}`);
}

/** BEHAVIOURAL: the rule must REJECT state read back from the database.
 *  This is the arm a neutered predicate cannot survive. */
function expectReject(id, verdict) {
  assert.ok(!verdict.ok, `BEHAVIOUR BREACH — ${id} ACCEPTED a broken fixture (the rule detects nothing): ${verdict.detail}`);
  ok(`${id} rejects the matching defect — ${verdict.detail}`);
}

/** CONTRACT: an agreement between the guard and shipped application code. Its
 *  failure is a CONTRACT breach, not a behaviour breach. */
function expectContract(id, cond, msg) {
  assert.ok(cond, `CONTRACT BREACH (not a behaviour breach) — ${id}: ${msg}`);
  ok(`${id} [CONTRACT] ${msg}`);
}

// Observation helper (opt-in mode only): the whole-database view the guard
// used to assert on. Kept so the operational question ("is the live connection
// healthy right now?") is still answerable — but never as an automated tick.
async function readActiveConnectionsGlobal(db) {
  return db`
    SELECT provider, environment, state, inbound_sync_enabled, outbound_sync_enabled,
           (api_key_ciphertext IS NOT NULL) AS has_refresh_token,
           circuit_open_until, consecutive_failures
    FROM guesthub.channel_connections WHERE state = 'active'`;
}

try {
  if (OBSERVE) {
    console.log(`  · OBSERVE mode against ${redactDsn(url)} — this is a probe, not a guard`);
    const rows = await readActiveConnectionsGlobal(sql);
    for (const r of [
      ruleSingleActiveBeds24Connection(rows),
      ruleActiveConnectionIsProduction(rows[0]),
      ruleBothSyncDirectionsEnabled(rows[0]),
      ruleRefreshTokenPresent(rows[0]),
      ruleCircuitBreakerClosed(rows[0], Date.now()),
    ]) console.log(`  ${r.ok ? "·" : "!"} ${r.detail}`);
    console.log("\nOBSERVE COMPLETE (informational — no assertions were scored)");
  } else {
    const mods = loadWorkerModules(url);
    const before = await countFixtureTables(sql);

    await withRollback(sql, async (tx) => {
      // ---------- ACCEPT arm: one healthy Beds24 connection ----------
      const healthy = await seedConnection(tx, {});
      const rows = await readActiveConnections(tx, healthy.tenantId);
      expectContract("C0", rows.length === 1, "the fixture is visible through the read-back query");

      expectAccept("C1", ruleSingleActiveBeds24Connection(rows));
      expectAccept("C2", ruleActiveConnectionIsProduction(rows[0]));
      expectAccept("C3", ruleBothSyncDirectionsEnabled(rows[0]));
      expectAccept("C4", ruleRefreshTokenPresent(rows[0]));
      expectAccept("C5", ruleCircuitBreakerClosed(rows[0], Date.now()));

      // ---------- REJECT arms: one violating fixture per rule ----------
      // C1 — a second active connection for a decommissioned provider (D91).
      const twoActive = await seedConnection(tx, {});
      await tx`
        INSERT INTO guesthub.channel_connections
          (tenant_id, provider, environment, state, api_key_ciphertext, is_active_provider)
        VALUES (${twoActive.tenantId}, 'channex', 'production', 'active',
                'fixture::not-a-secret::presence-only', false)`;
      expectReject("C1", ruleSingleActiveBeds24Connection(await readActiveConnections(tx, twoActive.tenantId)));

      // C2 — the active connection points at the provider's sandbox.
      const sandbox = await seedConnection(tx, { environment: "staging" });
      expectReject("C2", ruleActiveConnectionIsProduction((await readActiveConnections(tx, sandbox.tenantId))[0]));

      // C3 — inbound armed, outbound silently off.
      const oneWay = await seedConnection(tx, { outbound: false });
      expectReject("C3", ruleBothSyncDirectionsEnabled((await readActiveConnections(tx, oneWay.tenantId))[0]));

      // C4 — no refresh token: the resolver can never mint an access token.
      const noToken = await seedConnection(tx, { refreshToken: false });
      expectReject("C4", ruleRefreshTokenPresent((await readActiveConnections(tx, noToken.tenantId))[0]));

      // C5 — the breaker is in cooldown right now.
      const tripped = await seedConnection(tx, {
        circuitOpenUntilSql: "now() + interval '10 minutes'",
        consecutiveFailures: 7,
      });
      const trippedRow = (await readActiveConnections(tx, tripped.tenantId))[0];
      expectReject("C5", ruleCircuitBreakerClosed(trippedRow, Date.now()));

      // ---------- the SHIPPED code must agree with the rules ----------
      // C5 vs src/lib/channel/circuit-breaker.ts. The persisted state is read
      // back from the database, handed to the application's OWN breaker, and
      // the two verdicts must match in BOTH directions.
      const { circuitPhase, circuitAllowsRequest } = mods.circuitBreaker;
      const asState = (row) => ({
        consecutiveFailures: row.consecutive_failures,
        openUntil: row.circuit_open_until ? new Date(row.circuit_open_until).getTime() : null,
      });
      const now = Date.now();
      expectContract(
        "C5-src",
        circuitAllowsRequest(asState(rows[0]), now) === true &&
          circuitPhase(asState(rows[0]), now) === "closed",
        "the shipped circuitAllowsRequest()/circuitPhase() call the healthy fixture CLOSED",
      );
      expectContract(
        "C5-src",
        circuitAllowsRequest(asState(trippedRow), now) === false &&
          circuitPhase(asState(trippedRow), now) === "open",
        "the shipped circuitAllowsRequest()/circuitPhase() BLOCK the tripped fixture",
      );

      // C1/C3 vs src/lib/channel/beds24-ari-sync.ts. The shipped drain selector
      // must pick up the healthy connection and must NOT pick up the one whose
      // outbound direction is off.
      const { loadDrainableBeds24Connections } = mods.ariSync;
      const drainable = await loadDrainableBeds24Connections(tx);
      const ids = new Set(drainable.map((c) => c.id));
      expectContract("C1-src", ids.has(healthy.connectionId),
        "the shipped loadDrainableBeds24Connections() returns the healthy fixture connection");
      expectContract("C3-src", !ids.has(oneWay.connectionId),
        "the shipped loadDrainableBeds24Connections() excludes the outbound-disabled connection");
    });

    const after = await countFixtureTables(sql);
    ok(`fixture rolled back — ${assertNoNetRows(before, after)}`);
    console.log(`\nBEDS24 CONNECTION CHECK: ${n} PASSED`);
  }
} catch (e) {
  console.error(`BEDS24 CONNECTION CHECK FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
