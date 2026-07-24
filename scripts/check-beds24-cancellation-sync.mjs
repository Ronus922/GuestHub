#!/usr/bin/env node
// check:beds24-cancellation-sync — the OTA-cancellation lifecycle, end to end.
//
// WHY. Beds24's GET /bookings silently EXCLUDES cancelled bookings unless an
// explicit `status` filter asks for them (repeated params; a CSV value is
// HTTP 400). The window pulls sent no status filter, so an OTA cancellation
// never reached the import and the room stayed occupying (reservation 1021,
// 2026-07-24). This check encodes Beds24's REAL contract in a mock — so it
// FAILS on unfixed code — and proves the full staging scenario on the
// isolated test DB (:5433) through the REAL compiled worker modules:
//   imported → cancelled at source → auto-released within ONE pull cycle,
//   missed-window gap → released by reconciliation (canonical path only),
//   checked-in guest → NEVER auto-released, loud alert instead,
//   end state → ZERO cancelled-at-source-still-occupying reservations.
//
// Usage: node scripts/check-beds24-cancellation-sync.mjs
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
process.env.CHANNEL_SECRETS_KEY = "check-beds24-cancellation-sync-key";

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };
const ROOT = process.cwd();

// ---- static: both window pulls carry the explicit repeated status filter ----
const src = readFileSync(join(ROOT, "src/lib/channel/beds24-booking-import.ts"), "utf8");
assert.match(src, /BEDS24_STATUS_FILTER = \["confirmed", "new", "request", "cancelled", "black", "inquiry"\]/,
  "the exported status list includes cancelled");
assert.match(src, /map\(\(s\) => `status=\$\{s\}`\)\s*\n?\s*\.join\("&"\)/,
  "statuses are REPEATED params, never a CSV value");
const windows = [...src.matchAll(/\$\{propertyFilter\}&\$\{BEDS24_STATUS_FILTER\}/g)];
assert.equal(windows.length, 2, "BOTH window pulls (incremental + backfill) carry the filter");
ok("static: repeated status params (incl. cancelled) on both window pulls");

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

// ---- the Beds24 contract mock (matches the behavior proven on 2026-07-24) ----
const iso = (d) => d.toISOString().slice(0, 10);
const day = (offset) => iso(new Date(Date.now() + offset * 86_400_000));
const PROPERTY = "999001";
const B24_ROOM = "707100";
/** id → booking; hiddenFromWindows simulates a cancellation older than the
 *  modifiedFrom lookback (the gap reconciliation exists for) */
const source = new Map();
const windowRequests = [];
function b24(id, status, extra = {}) {
  return {
    id: Number(id), status, propertyId: Number(PROPERTY), roomId: Number(B24_ROOM),
    arrival: day(5), departure: day(7), price: 500, currency: "ILS",
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
    // a by-id fetch returns the booking in ANY status (proven)
    rows = [...source.values()].filter((b) => String(b.booking.id) === idFilter).map((b) => b.booking);
  } else {
    windowRequests.push(u.search);
    const visible = [...source.values()].filter((b) => !b.hiddenFromWindows).map((b) => b.booking);
    rows = statuses.length > 0
      ? visible.filter((b) => statuses.includes(b.status))
      : visible.filter((b) => b.status !== "cancelled"); // THE TRAP: default hides cancelled
  }
  return new Response(JSON.stringify({ success: true, data: rows, pages: { nextPageExists: false } }), { status: 200 });
};

const sql = postgres(TEST_URL, { max: 1, prepare: false, onnotice: () => {} });
const slug = `b24-cancel-${Date.now()}`;
let tenantId;

try {
  // ---- staging scaffold: tenant, room, ACTIVE inbound+outbound connection ----
  const [tenant] = await sql`
    INSERT INTO guesthub.tenants (name, slug) VALUES ('Beds24 Cancel Check', ${slug}) RETURNING id`;
  tenantId = tenant.id;
  const [rt] = await sql`
    INSERT INTO guesthub.room_types (tenant_id, name, base_price)
    VALUES (${tenantId}, 'Check Type', 400) RETURNING id`;
  const [room] = await sql`
    INSERT INTO guesthub.rooms (tenant_id, room_number, room_type_id, status, is_active)
    VALUES (${tenantId}, 'B24-1', ${rt.id}, 'available', true) RETURNING id`;
  const [conn] = await sql`
    INSERT INTO guesthub.channel_connections
      (tenant_id, provider, environment, state, is_active_provider,
       inbound_sync_enabled, outbound_sync_enabled, full_sync_required,
       api_key_ciphertext, access_token_ciphertext, access_token_expires_at)
    VALUES
      (${tenantId}, 'beds24', 'production', 'active', true,
       true, true, false,
       ${encryptSecret("check-refresh-token")}, ${encryptSecret("check-access-token")},
       now() + interval '12 hours')
    RETURNING id, tenant_id, api_key_ciphertext, access_token_ciphertext,
              access_token_expires_at, last_inbound_import_at`;
  await sql`
    INSERT INTO guesthub.channel_beds24_room_mappings
      (tenant_id, connection_id, beds24_property_id, beds24_room_id, room_id, status)
    VALUES (${tenantId}, ${conn.id}, ${PROPERTY}, ${B24_ROOM}, ${room.id}, 'mapped')`;
  // hold last_inbound_import_at non-null so the first-run backfill stays out of the way
  await sql`UPDATE guesthub.channel_connections SET last_inbound_import_at = now() WHERE id = ${conn.id}`;
  const inbound = { ...conn, last_inbound_import_at: new Date() };

  const localOf = async (bookingId) => (await sql`
    SELECT id, status, reservation_number FROM guesthub.reservations
    WHERE tenant_id = ${tenantId} AND external_booking_id = ${bookingId}`)[0];

  // ---- cycle 1: three live bookings import ----
  source.set("555001", { booking: b24("555001", "new", { modifiedTime: "2026-07-24T10:00:00Z" }) });
  source.set("555002", { booking: b24("555002", "new", { arrival: day(10), departure: day(12), modifiedTime: "2026-07-24T10:00:01Z" }) });
  source.set("555003", { booking: b24("555003", "new", { arrival: day(0), departure: day(2), modifiedTime: "2026-07-24T10:00:02Z" }) });
  let summary = await imp.runBeds24InboundPull(sql, inbound);
  assert.equal(summary.imported, 3, `cycle 1 imported 3 (got ${JSON.stringify(summary)})`);
  for (const id of ["555001", "555002", "555003"]) {
    assert.equal((await localOf(id))?.status, "confirmed", `booking ${id} imported as confirmed`);
  }
  ok("cycle 1: three live bookings imported as confirmed reservations");

  // ---- cycle 2: 555001 cancelled at source → released within ONE cycle ----
  source.get("555001").booking = b24("555001", "cancelled", {
    modifiedTime: "2026-07-24T11:00:00Z", cancelTime: "2026-07-24T11:00:00Z",
  });
  summary = await imp.runBeds24InboundPull(sql, inbound);
  assert.equal((await localOf("555001")).status, "cancelled", "released in the same cycle");
  const [dirty] = await sql`
    SELECT 1 AS x FROM guesthub.channel_dirty_ranges
    WHERE connection_id = ${conn.id} AND room_id = ${room.id} LIMIT 1`;
  assert.ok(dirty, "the release republished the room's ARI range");
  ok("cycle 2: source cancellation lands and releases inventory within ONE pull cycle");
  assert.ok(
    windowRequests.some((q) => q.includes("status=cancelled") && q.includes("status=confirmed")),
    "the window pull really asked Beds24 for cancelled bookings (repeated params)",
  );
  ok("wire proof: the incremental window carries repeated status params incl. cancelled");

  // ---- reconciliation: a cancellation the windows MISSED (the >7d gap) ----
  source.get("555002").booking = b24("555002", "cancelled", {
    arrival: day(10), departure: day(12),
    modifiedTime: "2026-07-24T11:30:00Z", cancelTime: "2026-07-24T11:30:00Z",
  });
  source.get("555002").hiddenFromWindows = true;
  summary = await imp.runBeds24InboundPull(sql, inbound);
  assert.equal((await localOf("555002")).status, "confirmed", "the window pull cannot see the gap booking");
  const rec1 = await imp.runBeds24BookingReconciliation(sql, inbound);
  assert.equal((await localOf("555002")).status, "cancelled", "reconciliation released the gap booking");
  assert.ok(rec1.released >= 1, "reconcile summary counts the release");
  const [recErr] = await sql`
    SELECT 1 AS x FROM guesthub.channel_sync_errors
    WHERE tenant_id = ${tenantId} AND error_code = 'cancellation_reconciled' LIMIT 1`;
  assert.ok(recErr, "the release is loudly recorded (cancellation_reconciled)");
  ok("reconciliation: a window-missed cancellation is released through the canonical path + loud audit");

  // ---- checked-in guard: cancelled at source but the guest is IN the room ----
  const r3 = await localOf("555003");
  await sql`UPDATE guesthub.reservations SET status = 'checked_in' WHERE id = ${r3.id}`;
  source.get("555003").booking = b24("555003", "cancelled", {
    arrival: day(0), departure: day(2),
    modifiedTime: "2026-07-24T12:00:00Z", cancelTime: "2026-07-24T12:00:00Z",
  });
  source.get("555003").hiddenFromWindows = true;
  const rec2 = await imp.runBeds24BookingReconciliation(sql, inbound);
  assert.equal((await localOf("555003")).status, "checked_in", "a checked-in guest is NEVER auto-released");
  assert.equal(rec2.alerts, 1, "the conflict raises exactly one alert");
  const [alertErr] = await sql`
    SELECT 1 AS x FROM guesthub.channel_sync_errors
    WHERE tenant_id = ${tenantId} AND error_code = 'cancelled_at_source_checked_in' LIMIT 1`;
  assert.ok(alertErr, "the checked-in conflict is loudly recorded");
  ok("checked-in guard: no auto-release, a loud operator alert instead");

  // ---- THE assertion: zero cancelled-at-source reservations still occupying ----
  const stuck = [];
  const occupying = await sql`
    SELECT external_booking_id, status FROM guesthub.reservations
    WHERE tenant_id = ${tenantId} AND external_booking_id IS NOT NULL
      AND status = 'confirmed'`;
  for (const r of occupying) {
    const s = source.get(r.external_booking_id);
    if (s && s.booking.status === "cancelled") stuck.push(r.external_booking_id);
  }
  assert.equal(stuck.length, 0, `cancelled-at-source still occupying: ${stuck.join(", ")}`);
  ok("zero cancelled-at-source reservations still occupy inventory (the 1021 invariant)");

  console.log(`\ncheck-beds24-cancellation-sync: all ${n} assertions passed`);
} finally {
  // scratch-tenant cleanup (dependency order) — testdb only
  if (tenantId) {
    for (const t of [
      "channel_sync_errors", "channel_dirty_ranges", "channel_booking_revisions",
      "channel_sync_jobs", "channel_beds24_room_mappings", "channel_connections",
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
