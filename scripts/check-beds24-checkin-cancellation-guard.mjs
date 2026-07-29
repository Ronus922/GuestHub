#!/usr/bin/env node
// check:beds24-checkin-cancellation-guard — D93's checked-in policy on EVERY
// inbound route, not just the one it was first written for.
//
// WHY. D93 decided that a guest who is physically in the room is never
// released automatically: an OTA cancellation for such a stay raises a loud
// alert and a human decides. That rule lived in the reconciliation loop and in
// the operator's supervised-release action — but NOT in applyCancellation, the
// import core every route funnels through. So the ordinary 5-minute window
// pull (the route D93's own status-filter fix made the dominant one) flipped a
// checked_in reservation straight to cancelled and freed the room, silently.
// check:beds24-cancellation-sync never caught it: its checked-in case is
// driven through runBeds24BookingReconciliation with the booking explicitly
// hidden from the window pulls.
//
// WHAT IS PROVEN. Four distinct routes reach applyCancellation. Each is driven
// here through the REAL compiled worker modules against a disposable DB, with
// a mock that encodes Beds24's real contract (repeated status params; a by-id
// fetch returns any status; the window default hides cancelled):
//   window pull · convergence sweep · targeted by-id pull · reconciliation
// A checked-in guest survives all four; a pre-check-in guest is released by
// all of them exactly as before.
//
// TWO GROUPS, and the difference matters when this goes red.
//
//   GROUP A — BEHAVIORAL. Read back from the DATABASE: reservation status,
//   inventory-blocking, republished ARI ranges, the operator alert row, the
//   audit row, the revision's import_status. These are D93's promises and they
//   are layer-agnostic — a red here means a guest's room was really taken away,
//   or the operator was really not told. THIS GROUP DECIDES CORRECTNESS.
//
//   GROUP B — STRUCTURAL / DEFENSE-IN-DEPTH. Read back from a summary counter
//   that names a specific layer, or from the source shape. These are bound to
//   the current implementation ON PURPOSE: they hold the two-layer arrangement
//   in place. A red here can mean the behavior is still fine and only the
//   arrangement changed — so each one says so in its own failure message and
//   says what to do about it. Never weaken one of these to get green; either
//   restore the arrangement or update the assertion deliberately.
//
// Behavioral runs first. When this guard goes red it must name the defect that
// matters, not a grep. A guard whose only teeth are a source regex is the
// failure mode this repo has already been bitten by.
//
// Usage: node scripts/check-beds24-checkin-cancellation-guard.mjs
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
process.env.CHANNEL_SECRETS_KEY = "check-beds24-checkin-cancellation-key";

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };
const ROOT = process.cwd();

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
const imp = require2(join(OUT, "lib/channel/beds24-booking-import.js"));
const { encryptSecret } = require2(join(OUT, "lib/channel/crypto.js"));

// ---- the Beds24 contract mock (same shape as check:beds24-cancellation-sync) ----
const iso = (d) => d.toISOString().slice(0, 10);
const day = (offset) => iso(new Date(Date.now() + offset * 86_400_000));
const PROPERTY = "997001";
const B24_ROOM = "709100";
/** id → { booking, hiddenFromWindows } */
const source = new Map();
function b24(id, status, extra = {}) {
  return {
    id: Number(id), status, propertyId: Number(PROPERTY), roomId: Number(B24_ROOM),
    // a stay that has already started — the only kind a guest can be checked into
    arrival: day(-1), departure: day(2), price: 500, currency: "ILS",
    modifiedTime: extra.modifiedTime ?? new Date().toISOString().slice(0, 19) + "Z",
    channel: "booking", apiReference: `ref-${id}`, firstName: "בדיקה", lastName: `אורח-${id}`,
    ...extra,
  };
}
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  assert.equal(u.host, "api.beds24.com", `unexpected outbound host: ${u.host}`);
  if (!u.pathname.endsWith("/bookings")) {
    return new Response(JSON.stringify({ success: false }), { status: 404 });
  }
  const statuses = u.searchParams.getAll("status");
  if (statuses.some((s) => s.includes(","))) {
    // the REAL Beds24 rejects a CSV status value
    return new Response(JSON.stringify({ success: false }), { status: 400 });
  }
  const idFilter = u.searchParams.get("id");
  let rows;
  if (idFilter) {
    // a by-id fetch returns the booking in ANY status (proven against the live API)
    rows = [...source.values()].filter((b) => String(b.booking.id) === idFilter).map((b) => b.booking);
  } else {
    const visible = [...source.values()].filter((b) => !b.hiddenFromWindows).map((b) => b.booking);
    rows = statuses.length > 0
      ? visible.filter((b) => statuses.includes(b.status))
      : visible.filter((b) => b.status !== "cancelled"); // the default hides cancelled
  }
  return new Response(JSON.stringify({ success: true, data: rows, pages: { nextPageExists: false } }), { status: 200 });
};

const sql = postgres(TEST_URL, { max: 1, prepare: false, onnotice: () => {} });
const slug = `b24-checkin-cancel-${Date.now()}`;
let tenantId;

// bookings that were CHECKED IN when their cancellation arrived — the closing
// invariant re-reads every one of them, whichever route delivered it
const checkedInAtCancellation = new Set();

try {
  // ---- staging scaffold: tenant, room, ACTIVE inbound connection ----
  const [tenant] = await sql`
    INSERT INTO guesthub.tenants (name, slug) VALUES ('Beds24 Checkin Cancel Guard', ${slug}) RETURNING id`;
  tenantId = tenant.id;
  const [rt] = await sql`
    INSERT INTO guesthub.room_types (tenant_id, name, base_price)
    VALUES (${tenantId}, 'Guard Type', 400) RETURNING id`;
  const [room] = await sql`
    INSERT INTO guesthub.rooms (tenant_id, room_number, room_type_id, status, is_active)
    VALUES (${tenantId}, 'GRD-1', ${rt.id}, 'available', true) RETURNING id`;
  const [room2] = await sql`
    INSERT INTO guesthub.rooms (tenant_id, room_number, room_type_id, status, is_active)
    VALUES (${tenantId}, 'GRD-2', ${rt.id}, 'available', true) RETURNING id`;
  const [conn] = await sql`
    INSERT INTO guesthub.channel_connections
      (tenant_id, provider, environment, state, is_active_provider,
       inbound_sync_enabled, outbound_sync_enabled, full_sync_required,
       api_key_ciphertext, access_token_ciphertext, access_token_expires_at)
    VALUES
      (${tenantId}, 'beds24', 'production', 'active', true, true, true, false,
       ${encryptSecret("guard-refresh-token")}, ${encryptSecret("guard-access-token")},
       now() + interval '12 hours')
    RETURNING id, tenant_id, api_key_ciphertext, access_token_ciphertext,
              access_token_expires_at, last_inbound_import_at`;
  // two mapped Beds24 rooms so overlapping stays never collide on availability
  await sql`
    INSERT INTO guesthub.channel_beds24_room_mappings
      (tenant_id, connection_id, beds24_property_id, beds24_room_id, room_id, status)
    VALUES (${tenantId}, ${conn.id}, ${PROPERTY}, ${B24_ROOM}, ${room.id}, 'mapped'),
           (${tenantId}, ${conn.id}, ${PROPERTY}, ${String(Number(B24_ROOM) + 1)}, ${room2.id}, 'mapped')`;
  // non-null last_inbound_import_at keeps the first-run backfill out of the way
  await sql`UPDATE guesthub.channel_connections SET last_inbound_import_at = now() WHERE id = ${conn.id}`;
  const inbound = { ...conn, last_inbound_import_at: new Date() };
  const ROOM_B = String(Number(B24_ROOM) + 1);

  const localOf = async (bookingId) => (await sql`
    SELECT id, status, reservation_number, cancelled_at, cancellation_origin,
           external_cancellation_confirmed_at
    FROM guesthub.reservations
    WHERE tenant_id = ${tenantId} AND external_booking_id = ${bookingId}`)[0];
  const alertsFor = async (reservationId) => (await sql`
    SELECT COUNT(*)::int AS n FROM guesthub.channel_sync_errors
    WHERE tenant_id = ${tenantId} AND error_code = 'cancelled_at_source_checked_in'
      AND context->>'reservation_id' = ${reservationId}`)[0].n;
  const auditsFor = async (reservationId, action) => (await sql`
    SELECT COUNT(*)::int AS n FROM guesthub.audit_logs
    WHERE tenant_id = ${tenantId} AND entity_id = ${reservationId} AND action = ${action}`)[0].n;
  // markAriDirty COALESCES overlapping pending ranges, so a row count can stay
  // flat across a genuine release. The only honest probe is to empty the
  // scratch connection's outbox first and see whether the step under test puts
  // anything back — "released inventory" is exactly "republished ARI".
  const clearDirty = async () => {
    await sql`DELETE FROM guesthub.channel_dirty_ranges WHERE connection_id = ${conn.id}`;
  };
  const dirtyCount = async () => (await sql`
    SELECT COUNT(*)::int AS n FROM guesthub.channel_dirty_ranges
    WHERE connection_id = ${conn.id}`)[0].n;
  const revisionStatus = async (bookingId) => (await sql`
    SELECT import_status FROM guesthub.channel_booking_revisions
    WHERE connection_id = ${conn.id} AND provider_booking_id = ${bookingId}
    ORDER BY created_at DESC LIMIT 1`)[0]?.import_status;
  const checkIn = async (bookingId) => {
    const r = await localOf(bookingId);
    await sql`UPDATE guesthub.reservations SET status = 'checked_in'
              WHERE id = ${r.id} AND tenant_id = ${tenantId}`;
    checkedInAtCancellation.add(bookingId);
    return r;
  };

  // ---- scaffold: two in-house stays, ONE PER ROOM (overlapping stays on the
  // same room would quarantine on availability and prove nothing) ----
  const LIVE = { modifiedTime: "2026-07-25T09:00:00Z" };
  source.set("777001", { booking: b24("777001", "new", LIVE) });
  source.set("777002", { booking: b24("777002", "new", { ...LIVE, roomId: Number(ROOM_B) }) });
  let summary = await imp.runBeds24InboundPull(sql, inbound);
  assert.equal(summary.imported, 2, `cycle 1 imported 2 (got ${JSON.stringify(summary)})`);
  for (const id of ["777001", "777002"]) {
    assert.equal((await localOf(id))?.status, "confirmed", `booking ${id} imported as confirmed`);
  }
  ok("scaffold: two live bookings imported as confirmed, occupying reservations");

  // ████████████████████████████████████████████████████████████████
  // GROUP A — BEHAVIORAL. Everything below is read back from the DB.
  // A red here means a real guest's room was released, or a real
  // operator was never told. Nothing here is bound to a layer.
  // ████████████████████████████████████████████████████████████████

  // ================================================================
  // ROUTE 1 — the ordinary 5-minute window pull (the defect's route)
  // ================================================================
  await checkIn("777001");
  const r1 = await localOf("777001");
  assert.equal(r1.status, "checked_in", "the guest is in the room");
  await clearDirty();

  source.get("777001").booking = b24("777001", "cancelled", {
    modifiedTime: "2026-07-25T10:00:00Z", cancelTime: "2026-07-25T10:00:00Z",
  });
  summary = await imp.runBeds24InboundPull(sql, inbound);

  const after1 = await localOf("777001");
  assert.equal(after1.status, "checked_in",
    `a CHECKED-IN guest survives the ordinary window pull (got ${after1.status})`);
  const [blocking1] = await sql`
    SELECT COUNT(*)::int AS n FROM guesthub.reservations
    WHERE id = ${r1.id} AND status = ANY(guesthub.inventory_blocking_statuses())`;
  assert.equal(blocking1.n, 1, "the room is still consumed by this reservation");
  assert.equal(await dirtyCount(), 0,
    "no inventory was republished — nothing was released");
  ok("route 1 (window pull): a checked-in guest's room is NOT released");

  assert.equal(await alertsFor(r1.id), 1, "exactly one loud operator alert");
  ok("route 1: the conflict raises the cancelled_at_source_checked_in alert");

  assert.equal(await auditsFor(r1.id, "channel_import_cancel_blocked"), 1,
    "a reasoned audit records that the cancellation arrived and was NOT applied");
  assert.equal(await auditsFor(r1.id, "channel_import_cancel"), 0,
    "the cancel audit is NOT written — nothing was cancelled");
  ok("route 1: a distinct audit action, never the one that means 'cancelled'");

  assert.equal(await revisionStatus("777001"), "imported",
    "the cancellation is still CAPTURED as a revision (not lost, not retried forever)");
  assert.ok(after1.external_cancellation_confirmed_at,
    "the row records WHEN the channel confirmed the cancellation");
  assert.equal(after1.cancelled_at, null, "the row is not marked cancelled");
  ok("route 1: the cancellation is recorded as a revision + a derivable 'needs a decision' row state");

  // idempotence — the same cancelled booking on the next cycle changes nothing
  const alertsAfterFirst = await alertsFor(r1.id);
  summary = await imp.runBeds24InboundPull(sql, inbound);
  assert.equal((await localOf("777001")).status, "checked_in", "still not released on re-poll");
  assert.equal(await alertsFor(r1.id), alertsAfterFirst,
    "an unchanged cancelled booking does not re-alert every 5 minutes");
  ok("route 1: repeated polls of the same cancellation are a no-op");

  // ================================================================
  // ROUTE 2 — the convergence sweep (a revision left pending by a crash)
  // ================================================================
  await sql`
    UPDATE guesthub.channel_booking_revisions SET import_status = 'pending'
    WHERE connection_id = ${conn.id} AND provider_booking_id = '777001'
      AND revision_kind = 'cancelled'`;
  await clearDirty();
  summary = await imp.runBeds24InboundPull(sql, inbound);
  assert.equal((await localOf("777001")).status, "checked_in",
    "the sweep re-import does not release the checked-in guest either");
  assert.equal(await dirtyCount(), 0, "the sweep released no inventory");
  assert.equal(await revisionStatus("777001"), "imported", "the swept revision converged");
  ok("route 2 (convergence sweep): a checked-in guest's room is NOT released");

  // ================================================================
  // ROUTE 3 — the targeted by-id pull (escape hatch / reconciliation engine)
  // ================================================================
  source.get("777001").booking = b24("777001", "cancelled", {
    modifiedTime: "2026-07-25T11:00:00Z", cancelTime: "2026-07-25T10:00:00Z",
  });
  await clearDirty();
  summary = await imp.runBeds24InboundPull(sql, inbound, { bookingId: "777001" });
  assert.equal((await localOf("777001")).status, "checked_in",
    "the targeted by-id pull does not release the checked-in guest");
  assert.equal(await dirtyCount(), 0, "the targeted pull released no inventory");
  ok("route 3 (targeted by-id pull): a checked-in guest's room is NOT released");

  // ================================================================
  // ROUTE 4 — reconciliation (D93's original gate, now the shared one)
  // ================================================================
  await checkIn("777002");
  const r2 = await localOf("777002");
  source.get("777002").booking = b24("777002", "cancelled", {
    roomId: Number(ROOM_B), modifiedTime: "2026-07-25T12:00:00Z", cancelTime: "2026-07-25T12:00:00Z",
  });
  source.get("777002").hiddenFromWindows = true; // the >7d window gap
  await clearDirty();
  const rec = await imp.runBeds24BookingReconciliation(sql, inbound);
  assert.equal((await localOf("777002")).status, "checked_in",
    "reconciliation does not release the checked-in guest");
  assert.equal(await dirtyCount(), 0, "reconciliation released no inventory");
  assert.equal(await alertsFor(r2.id), 1, "the operator is told, exactly once");
  ok("route 4 (reconciliation): a checked-in guest's room is NOT released");
  // rec.alerts / rec.released name a LAYER, so they belong to group B below.

  // ================================================================
  // CONTROL — a guest who has NOT checked in is released exactly as before
  // ================================================================
  source.set("777005", {
    booking: b24("777005", "new", { arrival: day(5), departure: day(7), modifiedTime: "2026-07-25T13:00:00Z" }),
  });
  summary = await imp.runBeds24InboundPull(sql, inbound);
  const pre = await localOf("777005");
  assert.equal(pre.status, "confirmed", "the control booking imported as confirmed");

  source.get("777005").booking = b24("777005", "cancelled", {
    arrival: day(5), departure: day(7),
    modifiedTime: "2026-07-25T14:00:00Z", cancelTime: "2026-07-25T14:00:00Z",
  });
  await clearDirty();
  summary = await imp.runBeds24InboundPull(sql, inbound);
  const post = await localOf("777005");
  assert.equal(post.status, "cancelled",
    `a pre-check-in guest IS released, unchanged behavior (got ${post.status})`);
  assert.equal(post.cancellation_origin, "ota_revision", "released through the canonical OTA path");
  assert.ok(post.cancelled_at, "the cancellation history is written");
  // the SAME probe that read 0 on every blocked route reads non-zero here —
  // proof that the probe can actually see a release
  assert.ok(await dirtyCount() > 0, "the release republished the room's ARI range");
  assert.equal(await alertsFor(post.id), 0, "no operator alert for an ordinary release");
  assert.equal(await auditsFor(post.id, "channel_import_cancel"), 1, "the ordinary cancel audit is written");
  ok("control: a guest who has NOT checked in is still auto-released, with its ARI push and audit");

  // ================================================================
  // THE INVARIANT — zero checked-in stays were released, by any route
  // ================================================================
  const released = [];
  for (const bookingId of checkedInAtCancellation) {
    const r = await localOf(bookingId);
    if (!r || r.status !== "checked_in") released.push(`${bookingId}→${r?.status ?? "missing"}`);
  }
  assert.equal(released.length, 0,
    `checked-in stays released by an inbound cancellation: ${released.join(", ")}`);

  // and the same thing asked of the whole tenant from the data side: no
  // reservation may be cancelled while carrying the "blocked" audit
  const [contradiction] = await sql`
    SELECT COUNT(*)::int AS n
    FROM guesthub.reservations r
    JOIN guesthub.audit_logs a
      ON a.entity_id = r.id AND a.action = 'channel_import_cancel_blocked'
    WHERE r.tenant_id = ${tenantId} AND r.status = 'cancelled'`;
  assert.equal(contradiction.n, 0,
    "a stay whose cancellation was BLOCKED must never end up cancelled by the import");
  ok("invariant: zero checked-in stays released across all four inbound routes");

  // ████████████████████████████████████████████████████████████████
  // GROUP B — STRUCTURAL / DEFENSE-IN-DEPTH. Deliberately bound to the
  // current two-layer arrangement. A red below can coexist with a
  // perfectly protected room; each message says exactly that, and says
  // what to do. Do NOT weaken these to get green.
  // ████████████████████████████████████████████████████████████████

  // ---- B1. the reconciliation gate must stay the one that classifies ----
  // Why this is not redundant with the import gate, measured (2026-07-25) on
  // the disposable DB with the reconciliation gate removed and the import gate
  // left in place, in the window-gap scenario the two sub-cases below:
  //
  //   window gap, room still mapped  → room held, D93 alert raised (by the
  //     import gate), but the reconcile summary reports alerts:0 and pushes
  //     "שחרור … לא הושלם" — a FALSE failure, re-reported every cycle for the
  //     rest of the stay, and one Beds24 credit burned each time.
  //   window gap, room UNMAPPED      → runBeds24InboundPull returns at
  //     `mappings.size === 0` (beds24-booking-import.ts) BEFORE any revision is
  //     imported, so applyCancellation is never reached and the D93 alert count
  //     is ZERO. Nobody is told at all. No other gate covers this.
  //
  // So the reconciliation gate owns a scenario of its own. It is not dead code
  // and must not be removed — see the comment at its definition.
  assert.ok(rec.alerts >= 1,
    "the reconciliation gate (beds24-booking-import.ts, `blocksAutomaticRelease(r.status)`) " +
    "no longer classifies this conflict.\n" +
    "      NOTE: this is a CONTRACT failure, not a behavioral one — the room was NOT " +
    "released (group A above is green).\n" +
    "      That gate covers a window-gap scenario the import gate cannot reach: a " +
    "cancellation stamped older than\n" +
    "      LOOKBACK_DAYS=7 never reaches applyCancellation, and if the booking's room is " +
    "unmapped the targeted pull\n" +
    "      returns before importing anything — zero D93 alerts are raised by anyone. It " +
    "also keeps reconciliation from\n" +
    "      reporting a false \"release did not complete\" every cycle and from burning a " +
    "credit per cycle.\n" +
    "      If removing it was DELIBERATE, update this assertion explicitly and say why. " +
    "Do not delete it to get green.\n" +
    `      observed summary: ${JSON.stringify(rec)}`);
  assert.equal(rec.released, 0,
    "reconciliation must report zero releases for a checked-in stay " +
    `(contract, same gate as above; observed: ${JSON.stringify(rec)})`);
  ok("B1 (defense-in-depth): the reconciliation gate still owns the window-gap classification");

  // ---- B2. ONE definition of the gate, shared by every release surface ----
  const rules = readFileSync(join(ROOT, "src/lib/inventory-rules.ts"), "utf8");
  assert.match(rules, /export function blocksAutomaticRelease\(status: string\): boolean/,
    "the predicate lives in the pure rules module");
  assert.match(rules, /AUTO_RELEASE_BLOCKED_STATUSES = \["checked_in"\] as const/,
    "checked_in is the blocked status");
  const defs = execSync(
    "grep -rn 'function blocksAutomaticRelease' src/ || true",
    { encoding: "utf8" },
  ).trim().split("\n").filter(Boolean);
  assert.equal(defs.length, 1, `the gate is defined exactly once (found: ${defs.join(" | ")})`);
  for (const f of [
    "src/lib/channel/booking-import.ts",
    "src/lib/channel/beds24-booking-import.ts",
    "src/app/(dashboard)/reservations/actions.ts",
  ]) {
    assert.match(readFileSync(join(ROOT, f), "utf8"), /blocksAutomaticRelease\(/,
      `${f} consumes the shared gate rather than re-deciding locally`);
  }
  ok("B2 (structure): one definition of the gate, consumed by all three release surfaces");

  console.log(`\ncheck-beds24-checkin-cancellation-guard: all ${n} assertions passed`);
} finally {
  // scratch-tenant cleanup (dependency order) — testdb only
  if (tenantId) {
    for (const t of [
      "channel_sync_errors", "channel_dirty_ranges", "channel_booking_revisions",
      "channel_sync_jobs", "channel_beds24_room_mappings", "channel_connections",
      // the branch's inbound-cancellation seam legitimately writes
      // communication_events rows for these reservations, and their FK is
      // ON DELETE RESTRICT by design (036: the events are evidence of what
      // was sent to a guest) — teardown must clear them (messages first:
      // outbound_messages RESTRICTs on events) before the reservations.
      "outbound_messages", "communication_events",
      "audit_logs", "reservation_rooms", "reservations", "guests", "rooms",
      "room_types", "tenants",
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
