#!/usr/bin/env node
// check:beds24-ari-readback — the OUTBOUND half of the overbooking hole.
//
// WHY. D93 closed the inbound direction: an OTA cancellation that never reached
// the import left a room blocked here. The mirror-image failure was still open:
// Beds24 keeps SELLING a room that is occupied in our system, because nothing
// ever compared what Beds24 HOLDS against what we intended to publish — the
// outbound path only ever looked at what it sent. A push can be lost, rejected
// per-value on a 200, or overwritten at the provider, and no cycle noticed.
//
// This check injects real drift and proves it is detected:
//   agreement            → zero drift, a success evidence row, no operator alert
//   room occupied here,  → OVERSELL drift, an ari_readback_oversell alert
//     Beds24 still 1
//   repeat cycle         → the alert does NOT flood (one unresolved row)
//   price changed at     → price drift, its own alert code
//     the provider
//   blocked date (we     → availability drift ONLY; the provider's leftover
//     publish no price)     price is NOT a false positive
//   more pages than the  → bounded at BEDS24_READBACK_MAX_REQUESTS, reported
//     bound
//   the WORKER's own     → the reconcile cadence enqueues the job, the job RUNS
//     reconcile job         the read-back, and the evidence row carries that
//                           job's id (§7 — nothing here is a text match)
//   Beds24 unreachable   → the operator is told the inventory could not be
//                           VERIFIED, and the reconcile job still succeeds:
//                           a blind read-back must never fail the D93
//                           cancellation half of the same job (§8)
//   every request        → GET, to /inventory/rooms/calendar, and nothing else
//
// ------------------------------------------------------------------
// CONTRACT vs BEHAVIOUR (phase-2 B2 rebuild, 2026-07-25).
// Assertions in this file come in two kinds and say which they are:
//   · BEHAVIOUR — the module (or the worker) is executed and the values it
//     produces / writes to the DB are read back. These are the guard.
//   · CONTRACT  — a text-level statement about the source (an import that must
//     not exist, the single call site, the one path literal). They protect a
//     design rule that has no runtime signature in this fixture. Every one of
//     them fails with "CONTRACT breach (source text, not behaviour)" so a red
//     run is never mistaken for a detected overbooking.
//
// B2 RECORD. The version of this check that shipped on PR #106 stayed GREEN
// under four semantic neuterings (predicate killed, every name/import/call site
// left in place) — measured, not assumed:
//   1. worker.ts: `if (readbackWired && drainable) await runBeds24AriReadback(...)`
//      → the read-back is never called by the job; the grep at §2 still matched.
//   2. worker.ts: the drainable half of ensureReconcileJobs targets nothing
//      → an outbound-only connection never gets a reconcile job at all.
//   3. beds24-ari-readback.ts: the `ari_readback_failed` branch disabled
//      → a read-back that cannot reach Beds24 says nothing to the operator.
//   4. beds24-ari-readback.ts: a transport failure THROWS instead of being
//      recorded → the reconcile job fails, taking the D93 cancellation half
//      with it.
// §7 and §8 below exist to make those four red. The pure-diff neuterings
// (availability comparison, oversell signature) were already red and stay red.
// ------------------------------------------------------------------
//
// The Beds24 mock encodes the contract MEASURED live on 2026-07-24 with the
// production token: `roomId` as REPEATED params, calendar answers RANGE-
// COMPRESSED with an INCLUSIVE `to`, no includeX parameter ⇒ an EMPTY calendar
// array, and the real response header names
//   x-request-cost / x-five-min-limit-remaining / x-five-min-limit-resets-in
// (NOT the X-RequestCost / X-FiveMinCreditLimit-Remaining spellings apiV2.yaml
// documents — the server does not send those).
//
// DB: the disposable test DB only (guesthub-testdb, :5433 — never staging, never
// production). The check SEEDS IT ITSELF when the schema is absent, so it is
// runnable standalone and its A/B2 experiments are reproducible; it does not
// depend on another check having replayed the migration chain first.
//
// Usage: node scripts/check-beds24-ari-readback.mjs
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import Module from "node:module";
import { join } from "node:path";
import postgres from "postgres";

const TEST_URL =
  process.env.TEST_DATABASE_URL ||
  "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (TEST_URL.includes(marker)) {
    console.error(`REFUSED: TEST_DATABASE_URL contains production marker "${marker}"`);
    process.exit(1);
  }
}
process.env.DATABASE_URL = TEST_URL;
process.env.CHANNEL_SECRETS_KEY = "check-beds24-ari-readback-key";

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };
const ROOT = process.cwd();
/** every text-level assertion says so, in its own failure message */
const CONTRACT = (m) => `CONTRACT breach (source text, not behaviour): ${m}`;

// ---- §0. the subject must exist, and the test DB must have a schema ----
const MODULE_REL = "src/lib/channel/beds24-ari-readback.ts";
assert.ok(existsSync(join(ROOT, MODULE_REL)),
  `MISSING SUBJECT: ${MODULE_REL} is not in this tree — the ARI read-back (the OUTBOUND half of the overbooking hole) does not exist here`);

{
  // Self-seeding. The migration chain replays only on a virgin schema (054
  // renamed channex_*→external_*), and it must be applied by the schema OWNER:
  // `docker exec … psql -U postgres -c "DROP SCHEMA guesthub CASCADE"` fails
  // with "must be owner of schema guesthub" AND STILL EXITS 0, so a run that
  // relies on it is silently working on the previous run's schema. Here the
  // chain is applied over the SAME connection string this check uses.
  const boot = postgres(TEST_URL, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const [{ present }] = await boot`
      SELECT (to_regclass('guesthub.channel_evidence_ledger') IS NOT NULL) AS present`;
    if (!present) {
      const dir = join(ROOT, "db/migrations");
      const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
      for (const f of files) {
        await boot.unsafe(readFileSync(join(dir, f), "utf8")).simple();
      }
      const [{ c }] = await boot`
        SELECT count(*)::int AS c FROM pg_tables WHERE schemaname = 'guesthub'`;
      console.log(`→ test DB was empty: replayed ${files.length} migrations (${c} tables)`);
    }
  } finally {
    await boot.end();
  }
}

// ---- §1. CONTRACT: the read-back cannot write, structurally ----
// comments are stripped first: the module's own header DESCRIBES what it must
// never do, and a naive grep would read that prose as the code doing it.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
const src = stripComments(readFileSync(join(ROOT, MODULE_REL), "utf8"));
assert.ok(!/from "\.\/beds24-ari"/.test(src),
  CONTRACT("the read-back must not import the calendar PUSH client — a fix-up path must not be reachable"));
assert.ok(!/pushBeds24Calendar/.test(src), CONTRACT("pushBeds24Calendar must never be called here"));
const methods = [...src.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]);
assert.deepEqual([...new Set(methods)], ["GET"], CONTRACT(`only GET may appear; found ${methods.join(",")}`));
assert.equal([...src.matchAll(/beds24Request\(/g)].length, 1, CONTRACT("exactly ONE Beds24 call site"));
assert.match(src, /const READBACK_PATH = "\/inventory\/rooms\/calendar";/,
  CONTRACT("the one path is the calendar read endpoint"));
ok("CONTRACT: read-only by construction — one GET call site, no push import (runtime proof in §9)");

// ---- §2. CONTRACT: no second job type was invented ----
// (that the read-back actually RUNS inside reconcile_inventory is proven by
// executing the worker in §7 — this is only the "no parallel cadence" rule.)
assert.ok(!/"ari_readback"[^\n]*ChannelJobType|ari_readback".*\|/.test(
  readFileSync(join(ROOT, "src/lib/channel/queue.ts"), "utf8")),
  CONTRACT("no new job type may be invented for the read-back"));
ok("CONTRACT: no second job type, no second cadence");

// ---- compile the real worker graph and require it the worker's own way ----
execSync("pnpm exec tsc -p tsconfig.worker.json", { stdio: "inherit" });
const OUT = join(ROOT, "dist", "worker");
const STUB = join(ROOT, "scripts", "server-only-stub.cjs");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return STUB;
  if (request.startsWith("@/")) return origResolve.call(this, join(OUT, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};
const require2 = createRequire(import.meta.url);
const rb = require2(join(OUT, "lib/channel/beds24-ari-readback.js"));
const ariSync = require2(join(OUT, "lib/channel/beds24-ari-sync.js"));
const worker = require2(join(OUT, "lib/channel/worker.js"));
const workerDb = require2(join(OUT, "lib/db.js")); // the pool runTick() uses
const { encryptSecret } = require2(join(OUT, "lib/channel/crypto.js"));

// ---- §3. the cadence arithmetic, tied to the REAL cadence constant ----
assert.equal(rb.BEDS24_READBACK_DAYS, 14, "the window is 14 days forward, not the 500-day horizon");
assert.equal(rb.BEDS24_READBACK_REQUEST_COST, 1, "measured x-request-cost of one read-back call");
assert.equal(rb.BEDS24_CREDIT_CEILING, 100, "Beds24 ceiling: 100 credits per rolling 5 minutes");
assert.equal(rb.BEDS24_READBACK_BURST_CREDITS, 3, "page bound × cost = the worst case one cycle can spend");
assert.equal(worker.RECONCILE_MINUTES, 20, "the read-back rides the 20-minute reconcile cadence");
const perWindow = rb.beds24ReadbackCreditsPerWindow(worker.RECONCILE_MINUTES);
assert.equal(perWindow, 0.75, "3 credits × (5/20) = 0.75 credits per rolling 5-minute window");
assert.ok(rb.BEDS24_READBACK_BURST_CREDITS <= rb.BEDS24_CREDIT_CEILING / 10,
  "even the burst stays inside a tenth of the ceiling");
assert.ok(perWindow / rb.BEDS24_CREDIT_CEILING < 0.01, "amortised cost is under 1% of the ceiling");
ok(`cadence derivation: ${rb.BEDS24_READBACK_BURST_CREDITS} credits/cycle at ${worker.RECONCILE_MINUTES}min = ${perWindow}/5min window = ${(100 * perWindow / rb.BEDS24_CREDIT_CEILING).toFixed(2)}% of the ceiling`);

// ---- §4. the diff itself, on hand-built cells (no DB, no network) ----
{
  const win = { from: "2026-08-01", toInclusive: "2026-08-03" };
  const expected = rb.expandBeds24Calendar(
    [{ beds24RoomId: 1, calendar: [{ from: "2026-08-01", to: "2026-08-03", numAvail: 0, price1: 500 }] }], win);
  assert.equal(expected.size, 3, "an inclusive range expands to one cell per day");
  const remote = rb.expandBeds24Calendar(
    [{ beds24RoomId: 1, calendar: [
      { from: "2026-08-01", to: "2026-08-01", numAvail: 1, price1: 500 },   // oversell
      { from: "2026-08-02", to: "2026-08-02", numAvail: 0, price1: 450 },   // price drift
    ] }], win);
  const d = rb.diffBeds24Calendar(expected, remote);
  assert.equal(d.length, 3, `three drifts expected, got ${JSON.stringify(d)}`);
  assert.deepEqual(d.map((x) => x.kind), ["availability", "price", "missing"]);
  assert.equal(d.filter((x) => x.oversell).length, 1, "exactly one cell carries the oversell signature");
  assert.equal(d[2].date, "2026-08-03", "a date the provider never stated is drift, not silence");
  // a cell we publish WITHOUT a price must never raise price drift
  const blocked = rb.expandBeds24Calendar(
    [{ beds24RoomId: 1, calendar: [{ from: "2026-08-01", to: "2026-08-01", numAvail: 0, price1: null }] }],
    { from: "2026-08-01", toInclusive: "2026-08-01" });
  const stale = rb.expandBeds24Calendar(
    [{ beds24RoomId: 1, calendar: [{ from: "2026-08-01", to: "2026-08-01", numAvail: 0, price1: 999 }] }],
    { from: "2026-08-01", toInclusive: "2026-08-01" });
  assert.equal(rb.diffBeds24Calendar(blocked, stale).length, 0,
    "a blocked date's leftover provider price is NOT drift (fail-closed pushes no price)");
}
ok("diff: oversell, price and missing drift detected; blocked-date leftovers are not false positives");

// ============================================================
// the Beds24 mock — the contract measured live on 2026-07-24
// ============================================================
// dates come from the SAME helpers the module uses — the compared window is
// property-local (Asia/Jerusalem), which is NOT today in UTC after 21:00.
const dates = require2(join(OUT, "lib/dates.js"));
const TODAY = dates.todayInTz("Asia/Jerusalem");
const day = (offset) => dates.addDays(TODAY, offset);
const PROPERTY = "999042";
const B24_ROOM = 708100;
/** what Beds24 HOLDS: roomId → date → { numAvail, price1|null } */
const provider = new Map([[B24_ROOM, new Map()]]);
let forceNextPage = false;
/** when set, every call answers with this HTTP status (§8: the provider is down) */
let forceStatus = 0;
const seen = [];
const violations = [];
/** measured header names — present so the check proves the module does not
 *  silently depend on the spellings apiV2.yaml documents but never sends */
const MEASURED_HEADERS = {
  "content-type": "application/json",
  "x-request-cost": "1",
  "x-five-min-limit-remaining": "97.8",
  "x-five-min-limit-resets-in": "288",
};

const nextDay = (d) => dates.addDays(d, 1);

function compressProviderDays(roomId, start, end, includeAvail, includePrices) {
  const cells = provider.get(roomId) ?? new Map();
  const ranges = [];
  let run = null;
  const flush = () => { if (run) ranges.push(run.range); run = null; };
  let d = start;
  for (let guard = 0; d <= end && guard < 400; guard++, d = nextDay(d)) {
    const cell = cells.get(d);
    // a date the provider has no statement about simply does not appear
    if (!cell) { flush(); continue; }
    if (run && run.numAvail === cell.numAvail && run.price1 === cell.price1) {
      run.range.to = d; // consecutive identical days collapse — the real shape
      continue;
    }
    flush();
    const range = { from: d, to: d };
    // the API returns ONLY what an includeX parameter asked for
    if (includeAvail) range.numAvail = cell.numAvail;
    if (includePrices && cell.price1 !== null) range.price1 = cell.price1;
    run = { numAvail: cell.numAvail, price1: cell.price1, range };
  }
  flush();
  return ranges;
}

globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  const method = init?.method ?? "GET";
  seen.push({ method, path: u.pathname });
  if (u.host !== "api.beds24.com") violations.push(`host ${u.host}`);
  if (method !== "GET") violations.push(`${method} ${u.pathname}`);
  if (u.pathname !== "/v2/inventory/rooms/calendar") violations.push(`path ${u.pathname}`);
  if (init?.body !== undefined) violations.push("a request body left the read-back");
  if (violations.length > 0) return new Response(JSON.stringify({ success: false }), { status: 405 });

  if (forceStatus !== 0) {
    return new Response(JSON.stringify({ success: false, errors: [{ message: "upstream" }] }),
      { status: forceStatus, headers: MEASURED_HEADERS });
  }
  const roomIds = u.searchParams.getAll("roomId");
  // the REAL Beds24 does not accept a CSV list value for a repeated filter
  if (roomIds.some((r) => r.includes(","))) {
    return new Response(JSON.stringify({ success: false }), { status: 400, headers: MEASURED_HEADERS });
  }
  const includeAvail = u.searchParams.get("includeNumAvail") === "true";
  const includePrices = u.searchParams.get("includePrices") === "true";
  const start = u.searchParams.get("startDate");
  const end = u.searchParams.get("endDate");
  const data = roomIds.map((rid) => ({
    roomId: Number(rid),
    propertyId: Number(PROPERTY),
    name: "check",
    // "By default no data will be returned. You should include at least one
    // includeX parameter." — the documented, verified behaviour.
    calendar: includeAvail || includePrices
      ? compressProviderDays(Number(rid), start, end, includeAvail, includePrices)
      : [],
  }));
  return new Response(
    JSON.stringify({
      success: true, type: "calendar", count: data.length,
      pages: { nextPageExists: forceNextPage, nextPageLink: null }, data,
    }),
    { status: 200, headers: MEASURED_HEADERS },
  );
};

const sql = postgres(TEST_URL, { max: 1, prepare: false, onnotice: () => {} });
const slug = `b24-readback-${Date.now()}`;
let tenantId;

const errorsWithCode = async (code) => (await sql`
  SELECT id FROM guesthub.channel_sync_errors
  WHERE tenant_id = ${tenantId} AND error_code = ${code} AND resolved_at IS NULL`).length;
const latestEvidence = async () => (await sql`
  SELECT outcome, error_code, context, job_id FROM guesthub.channel_evidence_ledger
  WHERE tenant_id = ${tenantId} AND scenario_key = 'ari_readback'
  ORDER BY created_at DESC, id DESC LIMIT 1`)[0];

try {
  // ---- fixture: one exclusive room, one designated tenant plan, ONE price ----
  const [tenant] = await sql`
    INSERT INTO guesthub.tenants (name, slug, timezone, currency)
    VALUES ('Beds24 Readback Check', ${slug}, 'Asia/Jerusalem', 'ILS') RETURNING id`;
  tenantId = tenant.id;
  const [rt] = await sql`
    INSERT INTO guesthub.room_types (tenant_id, name, base_price)
    VALUES (${tenantId}, 'Readback Type', 610) RETURNING id`;
  const [room] = await sql`
    INSERT INTO guesthub.rooms (tenant_id, room_number, room_type_id, status, is_active)
    VALUES (${tenantId}, 'RB-1', ${rt.id}, 'available', true) RETURNING id`;
  const [su] = await sql`
    INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id)
    VALUES (${tenantId}, 'RB-1', 'יחידת בדיקה', ${rt.id}) RETURNING id`;
  await sql`
    INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id)
    VALUES (${tenantId}, ${su.id}, ${room.id})`;
  const [plan] = await sql`
    INSERT INTO guesthub.pricing_plans
      (tenant_id, sellable_unit_id, code, name, plan_kind, is_active, is_visible_channels)
    VALUES (${tenantId}, NULL, 'flex', 'מחיר גמיש', 'base', true, true) RETURNING id`;
  await sql`
    INSERT INTO guesthub.pricing_plan_units (tenant_id, pricing_plan_id, sellable_unit_id, is_active)
    VALUES (${tenantId}, ${plan.id}, ${su.id}, true)`;
  const [connRow] = await sql`
    INSERT INTO guesthub.channel_connections
      (tenant_id, provider, environment, state, is_active_provider,
       inbound_sync_enabled, outbound_sync_enabled, full_sync_required,
       api_key_ciphertext, access_token_ciphertext, access_token_expires_at)
    VALUES
      (${tenantId}, 'beds24', 'production', 'active', true,
       false, true, false,
       ${encryptSecret("check-refresh-token")}, ${encryptSecret("check-access-token")},
       now() + interval '12 hours')
    RETURNING id`;
  await sql`
    INSERT INTO guesthub.channel_beds24_room_mappings
      (tenant_id, connection_id, beds24_property_id, beds24_room_id, room_id,
       local_rate_plan_id, status)
    VALUES (${tenantId}, ${connRow.id}, ${PROPERTY}, ${String(B24_ROOM)}, ${room.id},
            ${plan.id}, 'mapped')`;

  // the connection the read-back runs on is the one the DRAIN predicate yields —
  // no baseline, no comparison.
  const [conn] = (await ariSync.loadDrainableBeds24Connections(sql)).filter((c) => c.id === connRow.id);
  assert.ok(conn, "the fixture connection has an established outbound baseline");

  // ---- seed the provider with EXACTLY what we intend to publish ----
  const projection = await require2(join(OUT, "lib/channel/beds24-ari-projection.js"))
    .projectBeds24Ari(sql, {
      tenantId, connectionId: conn.id, dateFrom: day(0), dateTo: day(14), roomIds: [room.id],
    });
  const payloads = require2(join(OUT, "lib/channel/beds24-ari-payloads.js"));
  const built = payloads.buildBeds24CalendarRequests(projection, [{
    roomId: room.id, beds24PropertyId: PROPERTY, beds24RoomId: String(B24_ROOM),
    localRatePlanId: plan.id,
  }]);
  const baseline = rb.expandBeds24Calendar(rb.expectedEntriesOf(built.requests),
    { from: day(0), toInclusive: day(13) });
  assert.equal(baseline.size, 14, `the published window is 14 days (got ${baseline.size})`);
  const seedProvider = () => {
    const cells = new Map();
    for (const cell of baseline.values()) cells.set(cell.date, { numAvail: cell.numAvail, price1: cell.price1 });
    provider.set(B24_ROOM, cells);
  };
  seedProvider();

  // Every cycle is asserted read-only the moment it returns, so a write that
  // slipped past the static guards is reported AS a read-only violation and not
  // as whatever downstream symptom it happens to produce first.
  const readback = async () => {
    const summary = await rb.runBeds24AriReadback(sql, conn, null);
    assert.deepEqual(violations, [], `READ-ONLY VIOLATED: ${violations.join("; ")}`);
    return summary;
  };

  // ---- scenario 1: agreement ----
  let s = await readback();
  assert.deepEqual(s.errors, [], `no errors on the happy path (${s.errors.join("; ")})`);
  assert.equal(s.requests, 1, "ONE request covers every mapped room for the whole window");
  assert.equal(s.comparedCells, 14, "14 compared cells");
  assert.equal(s.driftCells, 0, `agreement means zero drift, got ${JSON.stringify(s.drift)}`);
  assert.equal(await errorsWithCode("ari_readback_drift"), 0, "no alert when nothing drifted");
  assert.equal(await errorsWithCode("ari_readback_oversell"), 0, "no oversell alert when nothing drifted");
  assert.equal((await latestEvidence())?.outcome, "success", "a success evidence row is written every cycle");
  ok("agreement: one GET, 14 cells compared, zero drift, no operator alert");

  // ---- scenario 2: THE injected drift — occupied here, still selling there ----
  const [guest] = await sql`
    INSERT INTO guesthub.guests (tenant_id, first_name, last_name, full_name)
    VALUES (${tenantId}, 'בדיקה', 'קריאה־חוזרת', 'בדיקה קריאה־חוזרת') RETURNING id`;
  const [res] = await sql`
    INSERT INTO guesthub.reservations
      (tenant_id, reservation_number, primary_guest_id, status, check_in, check_out, total_price)
    VALUES (${tenantId}, 'RB-0001', ${guest.id}, 'confirmed', ${day(3)}, ${day(4)}, 610)
    RETURNING id`;
  await sql`
    INSERT INTO guesthub.reservation_rooms (tenant_id, reservation_id, room_id, check_in, check_out, adults)
    VALUES (${tenantId}, ${res.id}, ${room.id}, ${day(3)}, ${day(4)}, 2)`;

  s = await readback();
  assert.equal(s.driftCells, 1, `exactly the occupied night drifts, got ${JSON.stringify(s.drift)}`);
  assert.equal(s.drift[0].kind, "availability");
  assert.equal(s.drift[0].date, day(3), "the drifting date is the occupied night");
  assert.equal(s.drift[0].expected, 0, "we hold the room");
  assert.equal(s.drift[0].remote, 1, "Beds24 is still selling it");
  assert.equal(s.oversellCells, 1, "the oversell signature is counted");
  assert.equal(await errorsWithCode("ari_readback_oversell"), 1, "the operator is alerted, loudly");
  const ev2 = await latestEvidence();
  assert.equal(ev2.outcome, "partial", "drift is recorded as a partial cycle");
  assert.equal(ev2.error_code, "ari_readback_oversell");
  assert.equal(ev2.context.oversellCells, 1, "the evidence context carries the count");
  assert.equal(ev2.context.sample[0].date, day(3), "and a bounded sample of the drifting cells");
  ok("INJECTED DRIFT DETECTED: room occupied here, numAvail 1 at Beds24 → oversell alert + evidence");

  // ---- scenario 3: the alert must not flood the 10-row diagnostics list ----
  s = await readback();
  assert.equal(s.oversellCells, 1, "the drift is still detected on the next cycle");
  assert.equal(await errorsWithCode("ari_readback_oversell"), 1,
    "a persisting drift keeps ONE unresolved alert, not one per 20 minutes");
  assert.equal((await sql`
    SELECT count(*)::int AS c FROM guesthub.channel_evidence_ledger
    WHERE tenant_id = ${tenantId} AND scenario_key = 'ari_readback'`)[0].c, 3,
    "the append-only evidence trail still records every cycle");
  ok("repeat cycle: drift still detected, alert not duplicated, evidence still appended");

  // ---- scenario 4: price drift gets its own code ----
  await sql`UPDATE guesthub.reservations SET status = 'cancelled' WHERE id = ${res.id}`;
  provider.get(B24_ROOM).set(day(5), { numAvail: 1, price1: 555 });
  s = await readback();
  assert.equal(s.oversellCells, 0, "the cancelled stay no longer blocks the night");
  assert.equal(s.driftCells, 1, `only the price drifts now, got ${JSON.stringify(s.drift)}`);
  assert.equal(s.drift[0].kind, "price");
  assert.equal(s.drift[0].expected, 610);
  assert.equal(s.drift[0].remote, 555, "a price Beds24 holds but we never published is drift");
  assert.equal(await errorsWithCode("ari_readback_drift"), 1, "price drift alerts under its own code");
  ok("price drift: a stale provider price is detected and alerted separately from oversell");

  // ---- scenario 5: no false positive on a date we publish with NO price ----
  seedProvider(); // provider back in agreement, still holding price1 = 610 everywhere
  await sql`UPDATE guesthub.pricing_plans SET valid_until = ${day(6)} WHERE id = ${plan.id}`;
  s = await readback();
  const kinds = [...new Set(s.drift.map((d) => d.kind))];
  assert.deepEqual(kinds, ["availability"],
    `an unpriced (blocked) date drifts on availability ONLY, got ${JSON.stringify(s.drift)}`);
  assert.equal(s.driftCells, 7, `days ${day(7)}..${day(13)} fall outside the plan (got ${s.driftCells})`);
  assert.equal(s.oversellCells, 7, "each of them is a room Beds24 still sells and we closed");
  await sql`UPDATE guesthub.pricing_plans SET valid_until = NULL WHERE id = ${plan.id}`;
  ok("fail-closed dates: availability drift only — the provider's leftover price is not alerted");

  // ---- scenario 6: pagination is bounded and the truncation is reported ----
  seedProvider();
  forceNextPage = true;
  s = await readback();
  assert.equal(s.requests, rb.BEDS24_READBACK_MAX_REQUESTS, "the page walk stops at the bound");
  assert.equal(s.truncated, true, "and says so, instead of pretending the comparison was complete");
  forceNextPage = false;
  ok(`pagination bounded at ${rb.BEDS24_READBACK_MAX_REQUESTS} requests (${rb.BEDS24_READBACK_BURST_CREDITS} credits worst case), truncation reported`);

  // ============================================================
  // §7. THE WIRING, EXECUTED. Everything above calls the module directly, which
  // proves the comparison but says nothing about whether anything ever CALLS it
  // in production. Here the real worker tick runs: the reconcile cadence must
  // enqueue a job for a connection that has NO inbound sync (the read-back is
  // the only reason such a connection needs one), the tick must run that job,
  // and the evidence row must carry THAT job's id. A dead call site or a
  // cadence that skips outbound-only connections fails here, with every name,
  // import and call-site string still in place.
  // ============================================================
  const workerLog = [];
  const jobsOfConn = async () => sql`
    SELECT id, status, idempotency_key, created_at FROM guesthub.channel_sync_jobs
    WHERE connection_id = ${conn.id} AND job_type = 'reconcile_inventory'
    ORDER BY created_at DESC, id DESC`;

  seedProvider();
  await sql`UPDATE guesthub.reservations SET status = 'confirmed' WHERE id = ${res.id}`;
  assert.equal((await jobsOfConn()).length, 0, "no reconcile job exists before the first tick");

  const tick1 = await worker.runTick("check-readback-worker", (m) => workerLog.push(m));
  assert.deepEqual(violations, [], `READ-ONLY VIOLATED inside the worker: ${violations.join("; ")}`);
  const jobs1 = await jobsOfConn();
  assert.equal(jobs1.length, 1,
    "the reconcile cadence must enqueue exactly one job for an OUTBOUND-ONLY connection — without it the ARI read-back has no cadence at all");
  assert.equal(jobs1[0].idempotency_key, `booking_reconcile:${conn.id}`,
    "and it reuses the existing reconcile job key — no parallel job type");
  assert.equal(jobs1[0].status, "succeeded", `the reconcile job must succeed (worker log: ${workerLog.join(" | ")})`);
  assert.equal(tick1.failed, 0, `no job may fail in this tick (worker log: ${workerLog.join(" | ")})`);
  const [evJob1] = await sql`
    SELECT outcome, error_code, context, job_id FROM guesthub.channel_evidence_ledger
    WHERE tenant_id = ${tenantId} AND scenario_key = 'ari_readback' AND job_id = ${jobs1[0].id}`;
  assert.ok(evJob1,
    "the read-back must RUN inside the reconcile job — no evidence row carries that job's id, so the job did not call it");
  assert.equal(evJob1.error_code, "ari_readback_oversell",
    "the job-driven cycle must detect the same oversell the direct call detects");
  assert.equal(evJob1.context.oversellCells, 1, "and record how many nights Beds24 is still selling");
  ok("WORKER-DRIVEN: the reconcile cadence enqueued the job, the job ran the read-back (evidence row carries its job_id) and the oversell was detected");

  // ============================================================
  // §8. A BLIND READ-BACK IS AN ALERT, NEVER A FAILED JOB. If Beds24 cannot be
  // reached, "no drift found" would be a lie — the operator must be told the
  // published inventory could not be VERIFIED. And the failure must stay inside
  // the read-back: the same job carries the D93 cancellation half, which must
  // not be marked failed (and retried) because a read timed out.
  // ============================================================
  await sql`
    UPDATE guesthub.channel_sync_jobs SET created_at = now() - make_interval(mins => 120)
    WHERE connection_id = ${conn.id} AND job_type = 'reconcile_inventory'`;
  forceStatus = 500; // the provider is down for this whole cycle
  const tick2 = await worker.runTick("check-readback-worker", (m) => workerLog.push(m));
  forceStatus = 0;
  assert.deepEqual(violations, [], `READ-ONLY VIOLATED inside the worker: ${violations.join("; ")}`);
  const jobs2 = await jobsOfConn();
  assert.equal(jobs2.length, 2, "the cadence enqueued the next cycle's job");
  const failedCycleJob = jobs2.find((j) => j.id !== jobs1[0].id);
  assert.ok(failedCycleJob, "the second reconcile job exists");
  assert.equal(failedCycleJob.status, "succeeded",
    `an unreachable Beds24 must NOT fail the reconcile job — the D93 cancellation half rides in it (worker log: ${workerLog.join(" | ")})`);
  assert.equal(tick2.failed, 0, "and the tick reports no failed job");
  assert.equal(await errorsWithCode("ari_readback_failed"), 1,
    "a read-back that could not reach Beds24 must ALERT: silence would read as 'no drift'");
  const [evJob2] = await sql`
    SELECT outcome, error_code, context, job_id FROM guesthub.channel_evidence_ledger
    WHERE tenant_id = ${tenantId} AND scenario_key = 'ari_readback' AND job_id = ${failedCycleJob.id}`;
  assert.ok(evJob2, "the failed cycle is still evidenced against its job");
  assert.equal(evJob2.outcome, "failed", "and recorded as a FAILED verification, not a clean one");
  assert.equal(evJob2.error_code, "ari_readback_failed");
  ok("provider unreachable: the operator is alerted that inventory could not be verified, and the reconcile job still succeeds");

  // ---- §9. the standing invariant: nothing but GETs to the calendar ever left ----
  assert.deepEqual(violations, [], `read-only violated: ${violations.join("; ")}`);
  assert.ok(seen.length > 0, "the read-back really talked to the mock");
  assert.deepEqual([...new Set(seen.map((r) => r.method))], ["GET"], "every request was a GET");
  assert.deepEqual([...new Set(seen.map((r) => r.path))], ["/v2/inventory/rooms/calendar"],
    "and every request went to the calendar read endpoint");
  assert.equal((await sql`
    SELECT count(*)::int AS c FROM guesthub.channel_dirty_ranges WHERE tenant_id = ${tenantId}`)[0].c, 0,
    "the read-back never enqueued outbound work of its own");
  ok(`read-only proven at runtime: ${seen.length} requests, all GET /inventory/rooms/calendar, zero writes`);

  console.log(`\ncheck-beds24-ari-readback: all ${n} assertions passed`);
} finally {
  // scratch-tenant cleanup (dependency order) — testdb only
  if (tenantId) {
    for (const t of [
      "channel_evidence_ledger", "channel_sync_errors", "channel_dirty_ranges",
      "channel_booking_revisions", "channel_sync_jobs", "channel_beds24_room_mappings",
      "channel_connections", "audit_logs", "reservation_rooms", "reservations", "guests",
      "pricing_plan_unit_rates", "pricing_plan_units", "pricing_plan_rates", "pricing_plans",
      "sellable_unit_rooms", "sellable_units", "rooms", "room_types", "tenants",
    ]) {
      await sql.unsafe(
        t === "tenants"
          ? `DELETE FROM guesthub.tenants WHERE id = '${tenantId}'`
          : `DELETE FROM guesthub.${t} WHERE tenant_id = '${tenantId}'`,
      );
    }
  }
  await sql.end();
  await workerDb.sql.end(); // runTick's own pool — otherwise the process hangs
}
