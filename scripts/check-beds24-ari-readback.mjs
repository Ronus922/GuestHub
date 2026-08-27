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
//   every request        → GET, to /inventory/rooms/calendar, and nothing else
//
// The Beds24 mock encodes the contract MEASURED live on 2026-07-24 with the
// production token: `roomId` as REPEATED params, calendar answers RANGE-
// COMPRESSED with an INCLUSIVE `to`, no includeX parameter ⇒ an EMPTY calendar
// array, and the real response header names
//   x-request-cost / x-five-min-limit-remaining / x-five-min-limit-resets-in
// (NOT the X-RequestCost / X-FiveMinCreditLimit-Remaining spellings apiV2.yaml
// documents — the server does not send those).
//
// Usage: node scripts/check-beds24-ari-readback.mjs
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
// B2 mutant suites must DIE on the first wrong answer, not record and continue:
// a recorded failure would let a neutralised module finish the suite and look
// alive. Mutant bodies therefore assert with the real, throwing assert.
import hard from "node:assert/strict";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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

// ---- static: the read-back cannot write, structurally ----
// comments are stripped first: the module's own header DESCRIBES what it must
// never do, and a naive grep would read that prose as the code doing it.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
const src = stripComments(readFileSync(join(ROOT, "src/lib/channel/beds24-ari-readback.ts"), "utf8"));
assert.ok(!/from "\.\/beds24-ari"/.test(src),
  "the read-back does not import the calendar PUSH client — a fix-up path is not reachable");
assert.ok(!/pushBeds24Calendar/.test(src), "pushBeds24Calendar is never called here");
const methods = [...src.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]);
assert.deepEqual([...new Set(methods)], ["GET"], `only GET may appear; found ${methods.join(",")}`);
assert.equal([...src.matchAll(/beds24Request\(/g)].length, 1, "exactly ONE Beds24 call site");
assert.match(src, /const READBACK_PATH = "\/inventory\/rooms\/calendar";/,
  "the one path is the calendar read endpoint");
ok("static: read-only by construction — one GET call site, no push import");

// ---- static: the worker runs it inside the EXISTING reconcile job ----
const workerSrc = readFileSync(join(ROOT, "src/lib/channel/worker.ts"), "utf8");
const reconcileBranch = workerSrc.slice(workerSrc.indexOf('jobType === "reconcile_inventory"'));
assert.match(reconcileBranch.slice(0, 2000), /runBeds24AriReadback\(sql, drainable, jobId\)/,
  "the read-back runs inside the existing reconcile_inventory job (no parallel job type)");
assert.ok(!/"ari_readback"[^\n]*ChannelJobType|ari_readback".*\|/.test(
  readFileSync(join(ROOT, "src/lib/channel/queue.ts"), "utf8")),
  "no new job type was invented");
ok("static: extends reconcile_inventory — no second job, no second cadence");

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
const RB_JS = join(OUT, "lib/channel/beds24-ari-readback.js");
const rb = require2(RB_JS);
const ariSync = require2(join(OUT, "lib/channel/beds24-ari-sync.js"));
const worker = require2(join(OUT, "lib/channel/worker.js"));
const { encryptSecret } = require2(join(OUT, "lib/channel/crypto.js"));

// ============================================================
// B2 — the scenarios prove THEMSELVES, every run
// ============================================================
// A scenario that asserts "the row is still open" proves nothing until the
// module that keeps it open is taken away and the scenario is watched to fail.
// Each lifecycle scenario below is therefore a FUNCTION of (module, assert),
// run twice: once against the real module, where it must pass, and once
// against a module whose specific predicate has been neutralised, where it
// must die. The neutralisation happens on the COMPILED artefact, is restored
// immediately after the require reads it, and the restoration is proven by
// sha256 — a guard that leaves the tree mutated is a guard that breaks
// everything downstream of itself.
const RB_PRISTINE = readFileSync(RB_JS, "utf8");
const RB_SHA256 = createHash("sha256").update(RB_PRISTINE).digest("hex");
const sha = (t) => createHash("sha256").update(t).digest("hex");

/** Load a copy of the read-back module with `edits` ([anchor, replacement]…)
 *  applied. Every anchor must appear EXACTLY ONCE — a stale battery mutates
 *  the wrong line, or nothing, and then proves nothing. */
function loadMutant(label, edits) {
  let text = RB_PRISTINE;
  for (const [anchor, replacement] of edits) {
    assert.equal(text.split(anchor).length - 1, 1,
      `B2 battery is stale: anchor for mutant "${label}" is not unique in the compiled module — re-derive it`);
    text = text.replace(anchor, replacement);
  }
  assert.notEqual(text, RB_PRISTINE, `B2 battery is stale: mutant "${label}" changes nothing`);
  writeFileSync(RB_JS, text);
  let mod;
  try {
    delete require2.cache[require2.resolve(RB_JS)];
    mod = require2(RB_JS);
  } finally {
    // restore before ANYTHING else can read it, success or throw
    writeFileSync(RB_JS, RB_PRISTINE);
    delete require2.cache[require2.resolve(RB_JS)];
  }
  assert.equal(sha(readFileSync(RB_JS, "utf8")), RB_SHA256,
    `B2: the compiled module was not restored byte-identically after mutant "${label}"`);
  return mod;
}

/** Run a scenario body against a neutralised module and require it to DIE. */
async function mustDie(label, edits, body) {
  const mutant = loadMutant(label, edits);
  let died = false;
  try {
    await body(mutant, hard);
  } catch (err) {
    if (!(err instanceof hard.AssertionError)) throw err; // a crash is a crash
    died = true;
  }
  assert.ok(died, `B2 FAILED: the scenario PASSED against mutant "${label}" — it does not prove its predicate`);
  console.log(`  ✓ B2 mutant rejected: ${label}`);
}

// ---- the cadence arithmetic, tied to the REAL cadence constant ----
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

// ---- the diff itself, on hand-built cells (no DB, no network) ----
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
/** requests still allowed to SUCCEED; every further request answers 500. Infinity =
 *  the provider is healthy. Drives the failed and partial-page scenarios. */
let okBudget = Infinity;
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

  // a provider that stops answering PART-WAY through the page walk is the
  // difference between "failed" and "partial", and the two must never be
  // collapsed: one saw nothing, the other saw half.
  if (okBudget <= 0) {
    return new Response(JSON.stringify({ success: false }), { status: 500, headers: MEASURED_HEADERS });
  }
  okBudget -= 1;

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
  SELECT outcome, error_code, context FROM guesthub.channel_evidence_ledger
  WHERE tenant_id = ${tenantId} AND scenario_key = 'ari_readback'
  ORDER BY created_at DESC, id DESC LIMIT 1`)[0];
/** 086 — the whole lifecycle of ONE open alert row, not just its existence */
const openRow = async (code) => (await sql`
  SELECT id, error_message, context, date_from, date_to,
         occurrence_count, last_seen_at, created_at, resolved_at
  FROM guesthub.channel_sync_errors
  WHERE tenant_id = ${tenantId} AND error_code = ${code} AND resolved_at IS NULL
  ORDER BY created_at DESC LIMIT 1`)[0];
const openReadbackRows = async () => (await sql`
  SELECT id FROM guesthub.channel_sync_errors
  WHERE tenant_id = ${tenantId} AND error_code LIKE 'ari_readback_%'
    AND resolved_at IS NULL`).length;
const allReadbackRows = async () => await sql`
  SELECT error_code, resolved_at FROM guesthub.channel_sync_errors
  WHERE tenant_id = ${tenantId} AND error_code LIKE 'ari_readback_%'`;
/** between a real run and its mutant run the alert table must start level —
 *  otherwise the mutant "passes" on rows the real run happened to leave. */
const clearAlerts = async () => {
  await sql`DELETE FROM guesthub.channel_sync_errors WHERE tenant_id = ${tenantId}`;
};

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
  // UNMODIFIED in its original assertions (086 must not change the one-row
  // invariant), and EXTENDED: the suppressed repeat used to be pure silence,
  // so the row froze at its first message and its first timestamp. It is now
  // refreshed in place — same row, higher count, later sighting.
  const seenOnce = await openRow("ari_readback_oversell");
  assert.equal(seenOnce.occurrence_count, 1, "the first sighting counts once");
  assert.ok(seenOnce.last_seen_at !== null, "and records WHEN it was seen");
  assert.equal(new Date(seenOnce.last_seen_at).getTime(), new Date(seenOnce.created_at).getTime(),
    "on the FIRST sighting last_seen_at IS created_at — not a second, later clock read");

  s = await readback();
  assert.equal(s.oversellCells, 1, "the drift is still detected on the next cycle");
  assert.equal(await errorsWithCode("ari_readback_oversell"), 1,
    "a persisting drift keeps ONE unresolved alert, not one per 20 minutes");
  assert.equal((await sql`
    SELECT count(*)::int AS c FROM guesthub.channel_evidence_ledger
    WHERE tenant_id = ${tenantId} AND scenario_key = 'ari_readback'`)[0].c, 3,
    "the append-only evidence trail still records every cycle");

  const seenTwice = await openRow("ari_readback_oversell");
  assert.equal(seenTwice.id, seenOnce.id, "it is the SAME row — a refresh, never a second insert");
  assert.equal(seenTwice.occurrence_count, 2, "the second sighting is COUNTED, not swallowed");
  assert.ok(new Date(seenTwice.last_seen_at) > new Date(seenOnce.last_seen_at),
    "and dated: last_seen_at advances with the cycle that re-proved it");
  assert.equal(new Date(seenTwice.created_at).getTime(), new Date(seenOnce.created_at).getTime(),
    "created_at still means FIRST seen — the refresh must not rewrite history");
  ok("repeat cycle: drift still detected, alert not duplicated — and the one row now carries ×2 and a fresh last_seen_at");

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
  // DELIBERATELY CHANGED (086, owner decision 4). These 7 nights used to be
  // counted as oversell and alerted as "סכנת overbooking". They are not: the
  // rooms are EMPTY, and we declined to sell them because the plan expired —
  // no price, therefore fail-closed. A guest cannot be double-booked into an
  // empty room. Calling seven empty nights an overbooking every 20 minutes is
  // how an operator learns to ignore the one alert that means a real bed.
  // They are now commercialBlockCells under their own code; the availability-
  // only assertion (the ORIGINAL point of this scenario — a blocked date's
  // leftover provider price is not drift) is unchanged and still binding.
  seedProvider(); // provider back in agreement, still holding price1 = 610 everywhere
  await sql`UPDATE guesthub.pricing_plans SET valid_until = ${day(6)} WHERE id = ${plan.id}`;
  s = await readback();
  const kinds = [...new Set(s.drift.map((d) => d.kind))];
  assert.deepEqual(kinds, ["availability"],
    `an unpriced (blocked) date drifts on availability ONLY, got ${JSON.stringify(s.drift)}`);
  assert.equal(s.driftCells, 7, `days ${day(7)}..${day(13)} fall outside the plan (got ${s.driftCells})`);
  assert.equal(s.commercialBlockCells, 7,
    "we closed them for a COMMERCIAL reason (no price) — the rooms are empty");
  assert.equal(s.oversellCells, 0,
    "and NONE of them is an overbooking: nobody can be double-booked into an empty room");
  assert.equal(await errorsWithCode("ari_readback_commercial"), 1,
    "a purely commercial gap gets its own code, not the overbooking alarm");
  assert.equal(await errorsWithCode("ari_readback_oversell"), 1,
    "the oversell row from scenario 2 is untouched — one row per code, still");
  const commercialRow = await openRow("ari_readback_commercial");
  assert.match(commercialRow.error_message, /פער מסחרי, לא סכנת double-booking/,
    "and says so in words the operator can act on");
  assert.equal(commercialRow.context.commercial_block_cells, 7, "the split travels in the context");
  assert.equal(commercialRow.context.oversell_cells, 0, "both halves, always");
  await sql`UPDATE guesthub.pricing_plans SET valid_until = NULL WHERE id = ${plan.id}`;
  ok("fail-closed dates: availability drift only, counted as a COMMERCIAL gap (086) — not as overbooking");

  // ---- scenario 6: pagination is bounded and the truncation is reported ----
  seedProvider();
  forceNextPage = true;
  s = await readback();
  assert.equal(s.requests, rb.BEDS24_READBACK_MAX_REQUESTS, "the page walk stops at the bound");
  assert.equal(s.truncated, true, "and says so, instead of pretending the comparison was complete");
  forceNextPage = false;
  ok(`pagination bounded at ${rb.BEDS24_READBACK_MAX_REQUESTS} requests (${rb.BEDS24_READBACK_BURST_CREDITS} credits worst case), truncation reported`);

  // ============================================================
  // 086 — THE LIFECYCLE. Every scenario below runs TWICE: once against the
  // real module, where it must pass, and once against a module whose specific
  // predicate has been neutralised, where it must die (see loadMutant/mustDie).
  // ============================================================

  // ---- S-physical: a PHYSICALLY taken night is the loud one ----------------
  const physicalScenario = async (mod, a) => {
    seedProvider(); // the provider sells all 14 nights; we hold day+3
    const sum = await mod.runBeds24AriReadback(sql, conn, null);
    a.deepEqual(violations, [], `READ-ONLY VIOLATED: ${violations.join("; ")}`);
    a.equal(sum.driftCells, 1, `exactly the occupied night drifts, got ${JSON.stringify(sum.drift)}`);
    a.equal(sum.oversellCells, 1, "a room somebody is sleeping in, still on sale, IS an oversell");
    a.equal(sum.commercialBlockCells, 0, "and is never filed as a commercial gap");
    const row = await openRow("ari_readback_oversell");
    a.ok(row, "the overbooking code is what reaches the operator");
    a.match(row.error_message, /תפוסים\/סגורים אצלנו — סכנת overbooking/,
      `the physical wording, got: ${row?.error_message}`);
    a.equal(row.context.oversell_cells, 1, "the split travels in the context");
    a.equal(row.context.commercial_block_cells, 0, "both halves, always");
  };
  await sql`UPDATE guesthub.reservations SET status = 'confirmed' WHERE id = ${res.id}`;
  await clearAlerts();
  await physicalScenario(rb, assert);
  ok("S-physical: an occupied night Beds24 still sells → oversellCells, the overbooking words");
  await clearAlerts();
  await mustDie(
    "cause split neutralised — every closed night filed as commercial",
    [[
      "                oversell: stillSelling && physicallyTaken,\n                commercialBlock: stillSelling && !physicallyTaken,",
      "                oversell: false,\n                commercialBlock: stillSelling,",
    ]],
    physicalScenario,
  );
  await clearAlerts();

  // ---- S-close: a clean cycle closes what it disproved --------------------
  await sql`UPDATE guesthub.reservations SET status = 'cancelled' WHERE id = ${res.id}`;
  const closeScenario = async (mod, a) => {
    seedProvider();
    provider.get(B24_ROOM).set(day(9), { numAvail: 1, price1: 444 }); // a price the provider invented
    let sum = await mod.runBeds24AriReadback(sql, conn, null);
    a.equal(sum.driftCells, 1, `the injected drift is detected, got ${JSON.stringify(sum.drift)}`);
    a.ok((await openReadbackRows()) > 0, "and an alert is standing");

    seedProvider(); // the operator ran a Full Sync; the provider agrees again
    sum = await mod.runBeds24AriReadback(sql, conn, null);
    a.equal(sum.driftCells, 0, `the cycle is clean, got ${JSON.stringify(sum.drift)}`);
    a.deepEqual(sum.errors, [], "with nothing failing");
    a.equal(await openReadbackRows(), 0,
      "and it CLOSES every open ari_readback_* row — nobody had to press a button");
    const rows = await allReadbackRows();
    a.ok(rows.length > 0, "the rows are still there — resolved, never deleted");
    a.ok(rows.every((r) => r.resolved_at !== null), "each carrying the moment it stopped being true");
  };
  await closeScenario(rb, assert);
  ok("S-close: drift alert open → clean cycle → resolved_at set, list no longer reports a fixed problem");
  await clearAlerts();
  await mustDie(
    "the closer removed — the alert outlives the condition",
    [["        await resolveReadbackAlerts(db, conn);", "        void 0;"]],
    closeScenario,
  );
  await clearAlerts();

  // ---- S-noclose-failed: a cycle that saw NOTHING disproves nothing -------
  const failedScenario = async (mod, a) => {
    seedProvider();
    provider.get(B24_ROOM).set(day(9), { numAvail: 1, price1: 444 });
    await mod.runBeds24AriReadback(sql, conn, null);
    a.equal(await errorsWithCode("ari_readback_drift"), 1, "a drift alert is standing");

    // the provider goes dark. Note the drift is ALSO gone from the fixture —
    // the condition may well be over, and that is exactly the point: we did
    // not SEE it end, so we do not get to say it ended.
    seedProvider();
    okBudget = 0;
    const sum = await mod.runBeds24AriReadback(sql, conn, null);
    okBudget = Infinity;

    a.ok(sum.errors.length > 0, "the cycle failed");
    a.equal(sum.comparedCells, 14, "we still built the 14 cells we intend to publish");
    a.equal(sum.driftCells, 0, "and compared them against nothing at all");
    a.equal(await errorsWithCode("ari_readback_failed"), 1, "the failure itself is alerted");
    a.equal(await errorsWithCode("ari_readback_drift"), 1,
      "and the drift alert STAYS OPEN — silence is not a clean bill of health");
    a.equal((await latestEvidence()).outcome, "failed", "the ledger calls the cycle failed");
  };
  await failedScenario(rb, assert);
  ok("S-noclose-failed: a failed cycle raises its own alert and closes NOTHING");
  await clearAlerts();
  await mustDie(
    "the failed path closes the alerts it never disproved",
    [[
      "            raw: failureRaw,\n        });",
      "            raw: failureRaw,\n        });\n        await resolveReadbackAlerts(db, conn);",
    ]],
    failedScenario,
  );
  await clearAlerts();

  // ---- S-noclose-partial: HALF an answer is not an answer ------------------
  // one of the unanswered nights is a room we HOLD — the exact cell a careless
  // reader turns into a phantom oversell, and the exact cell that must not let
  // a half-read cycle look clean.
  const [pRes] = await sql`
    INSERT INTO guesthub.reservations
      (tenant_id, reservation_number, primary_guest_id, status, check_in, check_out, total_price)
    VALUES (${tenantId}, 'RB-0002', ${guest.id}, 'confirmed', ${day(10)}, ${day(11)}, 610)
    RETURNING id`;
  await sql`
    INSERT INTO guesthub.reservation_rooms (tenant_id, reservation_id, room_id, check_in, check_out, adults)
    VALUES (${tenantId}, ${pRes.id}, ${room.id}, ${day(10)}, ${day(11)}, 2)`;
  // the provider agrees about the held night: numAvail 0, price still stated
  const seedWithHold = () => {
    seedProvider();
    provider.get(B24_ROOM).set(day(10), { numAvail: 0, price1: 610 });
  };
  const partialScenario = async (mod, a) => {
    seedWithHold();
    provider.get(B24_ROOM).set(day(9), { numAvail: 1, price1: 444 });
    await mod.runBeds24AriReadback(sql, conn, null);
    a.equal(await errorsWithCode("ari_readback_drift"), 1, "a drift alert is standing");

    seedWithHold();
    for (const off of [10, 11, 12, 13]) provider.get(B24_ROOM).delete(day(off));
    forceNextPage = true;
    okBudget = 1; // page 1 answers, page 2 dies
    const sum = await mod.runBeds24AriReadback(sql, conn, null);
    forceNextPage = false;
    okBudget = Infinity;

    a.ok(sum.errors.length > 0, "the page walk died part-way");
    a.equal(sum.requests, 2, "page 1 answered, page 2 did not");
    a.deepEqual([...new Set(sum.drift.map((d) => d.kind))], ["missing"],
      `the unanswered nights are 'missing', got ${JSON.stringify(sum.drift)}`);
    a.equal(sum.driftCells, 4, `four nights went unanswered (got ${sum.driftCells})`);
    a.equal(sum.oversellCells, 0,
      "including the night we HOLD: no statement from the provider is not proof it is selling");
    a.equal(sum.commercialBlockCells, 0, "and not proof of a commercial gap either");
    a.equal(await errorsWithCode("ari_readback_drift"), 1,
      "half an answer does not close the alert the other half might still justify");
    a.equal((await latestEvidence()).outcome, "partial", "the ledger calls the cycle partial");
  };
  await partialScenario(rb, assert);
  ok("S-noclose-partial: unanswered nights are drift, never oversell, and never a clean cycle");
  await clearAlerts();
  await mustDie(
    "a partial page read as clean — missing cells dropped and the error term removed",
    [
      [
        "                oversell: false, commercialBlock: false,\n            });\n            continue;",
        "                oversell: false, commercialBlock: false,\n            });\n            drift.pop();\n            continue;",
      ],
      [
        "else if (summary.requests > 0 && summary.errors.length === 0 && summary.comparedCells > 0) {",
        "else if (summary.requests > 0 && summary.comparedCells > 0) {",
      ],
    ],
    partialScenario,
  );
  await clearAlerts();
  await sql`UPDATE guesthub.reservations SET status = 'cancelled' WHERE id = ${pRes.id}`;
  seedProvider();

  // ---- S-411: a token that will not resolve is not "nothing to report" -----
  const tokenScenario = async (mod, a) => {
    // the resolver reads the credential off the connection object it is handed
    // (beds24-token.ts issues no SELECT of its own), so a connection with no
    // refresh token reproduces the live failure without a network call.
    const broken = {
      ...conn,
      api_key_ciphertext: null,
      access_token_ciphertext: null,
      access_token_expires_at: null,
    };
    const evidenceBefore = (await sql`
      SELECT count(*)::int AS c FROM guesthub.channel_evidence_ledger
      WHERE tenant_id = ${tenantId} AND scenario_key = 'ari_readback'`)[0].c;
    const requestsBefore = seen.length;

    const sum = await mod.runBeds24AriReadback(sql, broken, null);

    a.equal(sum.errors.length, 1, "the token failure is on the summary");
    a.equal(sum.requests, 0, "and nothing left the process — there was no token to send");
    a.equal(seen.length, requestsBefore, "the mock was never called");
    a.equal(await errorsWithCode("ari_readback_failed"), 1,
      "the operator is TOLD the comparison could not run — this exit used to be pure silence");
    const row = await openRow("ari_readback_failed");
    a.equal(row.context.stage, "token",
      "and told WHERE it stopped, so a dead credential is not mistaken for a dead network");
    const ev = await latestEvidence();
    a.equal(ev.outcome, "failed", "a failed ledger row is written");
    a.equal(ev.error_code, "ari_readback_failed", "under the failure code");
    a.equal((await sql`
      SELECT count(*)::int AS c FROM guesthub.channel_evidence_ledger
      WHERE tenant_id = ${tenantId} AND scenario_key = 'ari_readback'`)[0].c, evidenceBefore + 1,
      "exactly one row, appended");
  };
  await tokenScenario(rb, assert);
  ok("S-411: a token failure writes a failed ledger row AND a failed alert — no longer a silent return");
  await clearAlerts();
  await mustDie(
    "the token path returns in silence again",
    [[
      "        summary.errors.push(access.error);\n        await alertOnce(db, conn, {",
      "        summary.errors.push(access.error);\n        return summary;\n        await alertOnce(db, conn, {",
    ]],
    tokenScenario,
  );
  await clearAlerts();

  // ---- the standing invariant: nothing but GETs to the calendar ever left ----
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
}
