#!/usr/bin/env node
// check:beds24-quarantine-selfheal — a revision parked for an unmapped room
// must import ITSELF once the operator fixes the mapping.
//
// WHY. Beds24 has no revisions feed and no ack endpoint: a booking is persisted
// under the SYNTHETIC revision id "{id}:{modifiedTime}", and the UNIQUE
// (connection_id, provider_revision_id) makes a re-poll of an UNCHANGED booking
// a hard no-op — insertRevisionRow returns null and processBooking returns
// immediately. So for a booking that was quarantined (its Beds24 room had no
// local mapping yet) there is exactly ONE way back: sweepUnimportedRows, which
// re-imports rows still pending/quarantined/failed from the STORED, REDACTED
// payload. Delete that sweep, narrow its status list, widen its connection
// scope, or let redactPayload eat a field the normalizer needs, and the
// booking stays parked forever — an OTA-confirmed stay that never reaches the
// calendar, with no error after the first pull to say so.
//
// This check runs the REAL compiled worker modules against an isolated test DB
// (:5433) behind a mock that encodes Beds24's REAL /bookings contract, and
// proves the whole lifecycle:
//   unmapped room  → visible quarantine + loud unmapped_room alert, no guessed room
//   still unmapped → re-tried every pull, attempts climb, still no reservation
//   mapping fixed  → SELF-HEALS from the stored payload alone (the booking is
//                    hidden from the window pulls, so only the sweep can do it)
//   settled        → an imported revision is never swept again (no duplicates)
//   other tenant   → another connection's quarantined revision is NEVER touched
//
// Usage: node scripts/check-beds24-quarantine-selfheal.mjs
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
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
process.env.CHANNEL_SECRETS_KEY = "check-beds24-quarantine-selfheal-key";

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

// ============================================================
// The Beds24 /bookings contract mock
// ============================================================
const ACCESS_TOKEN = "check-quarantine-access-token";
const PROPERTY = "999003";
const B24_ROOM_MAPPED = "707201";
const B24_ROOM_UNMAPPED = "707202";

const iso = (d) => d.toISOString().slice(0, 10);
const day = (offset) => iso(new Date(Date.now() + offset * 86_400_000));

/** id → { booking, hiddenFromWindows } */
const source = new Map();
/** every booking id a window pull actually served, this cycle */
let served = [];
// beds24-http CATCHES every throw out of fetch and turns it into a
// `network_error`, so an assert inside the mock would be SWALLOWED and the pull
// would merely look "transiently failed". Wire-contract breaches are therefore
// RECORDED and asserted by the caller after every pull.
const violations = [];
const must = (cond, msg) => { if (!cond) violations.push(msg); };
const noViolations = () => {
  assert.equal(violations.length, 0,
    `Beds24 wire-contract violation(s): ${violations.join(" | ")}`);
};

function b24(id, roomId, extra = {}) {
  return {
    id: Number(id),
    status: "new",
    propertyId: Number(PROPERTY),
    roomId: Number(roomId),
    arrival: day(5),
    departure: day(7),
    price: 640,
    currency: "ILS",
    modifiedTime: extra.modifiedTime ?? "2026-07-24T09:00:00Z",
    channel: "booking",
    apiReference: `ref-${id}`,
    firstName: "בדיקה",
    lastName: `אורח-${id}`,
    ...extra,
  };
}

globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  must(u.host === "api.beds24.com", `unexpected outbound host: ${u.host}`);
  must(u.pathname === "/v2/bookings",
    `the inbound pull called ${u.pathname} — it may only GET /v2/bookings (a token mint here would burn credits every cycle)`);
  must((init?.method ?? "GET") === "GET", `a booking pull is a GET (got ${init?.method})`);
  const headers = Object.fromEntries(
    Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  must(headers.token === ACCESS_TOKEN,
    "Beds24 v2 takes the 24h ACCESS token in a bare `token` header");
  must(headers.authorization === undefined,
    "an Authorization/Bearer header was sent — that is not the Beds24 v2 scheme");

  const statuses = u.searchParams.getAll("status");
  // the REAL Beds24 rejects a CSV status value (repeated params only)
  if (statuses.some((s) => s.includes(","))) {
    return new Response(JSON.stringify({ success: false }), { status: 400 });
  }
  const idFilter = u.searchParams.get("id");
  let rows;
  if (idFilter) {
    // a by-id fetch returns the booking in ANY status
    rows = [...source.values()].filter((b) => String(b.booking.id) === idFilter).map((b) => b.booking);
  } else {
    // a window pull is ALWAYS property-scoped — a propertyId-less list call
    // would pull the whole Beds24 account
    must(!!u.searchParams.get("propertyId"), "a window pull must be property-scoped");
    const visible = [...source.values()].filter((b) => !b.hiddenFromWindows).map((b) => b.booking);
    rows = statuses.length > 0
      ? visible.filter((b) => statuses.includes(b.status))
      : visible.filter((b) => b.status !== "cancelled"); // Beds24's default hides cancelled
  }
  served.push(...rows.map((b) => String(b.id)));
  return new Response(
    JSON.stringify({ success: true, data: rows, pages: { nextPageExists: false } }),
    { status: 200 },
  );
};

const sql = postgres(TEST_URL, { max: 1, prepare: false, onnotice: () => {} });
const stamp = Date.now();
let tenantId;
let otherTenantId;

try {
  // ============================================================
  // scaffold: ONE tenant, TWO rooms — only the first is mapped. Plus a SECOND
  // tenant with its own connection and its own quarantined revision, used to
  // prove the sweep never crosses a connection boundary.
  // ============================================================
  const mkTenant = async (name, slug) => {
    const [t] = await sql`
      INSERT INTO guesthub.tenants (name, slug, timezone, currency)
      VALUES (${name}, ${slug}, 'Asia/Jerusalem', 'ILS') RETURNING id`;
    const [rt] = await sql`
      INSERT INTO guesthub.room_types (tenant_id, name, base_price)
      VALUES (${t.id}, 'Quarantine Type', 400) RETURNING id`;
    const [conn] = await sql`
      INSERT INTO guesthub.channel_connections
        (tenant_id, provider, environment, state, is_active_provider,
         inbound_sync_enabled, outbound_sync_enabled, full_sync_required,
         api_key_ciphertext, access_token_ciphertext, access_token_expires_at,
         last_inbound_import_at)
      VALUES
        (${t.id}, 'beds24', 'production', 'active', true,
         true, false, true,
         ${encryptSecret("check-refresh-token")}, ${encryptSecret(ACCESS_TOKEN)},
         now() + interval '12 hours', now())
      RETURNING id, tenant_id, api_key_ciphertext, access_token_ciphertext,
                access_token_expires_at, last_inbound_import_at`;
    return { tenantId: t.id, roomTypeId: rt.id, conn };
  };
  const mkRoom = async (tid, rtId, num) => {
    const [r] = await sql`
      INSERT INTO guesthub.rooms (tenant_id, room_number, room_type_id, status, is_active)
      VALUES (${tid}, ${num}, ${rtId}, 'available', true) RETURNING id`;
    return r.id;
  };

  const A = await mkTenant("Beds24 Quarantine Check", `b24-quar-${stamp}`);
  tenantId = A.tenantId;
  const roomMapped = await mkRoom(tenantId, A.roomTypeId, "Q24-1");
  const roomLate = await mkRoom(tenantId, A.roomTypeId, "Q24-2");
  await sql`
    INSERT INTO guesthub.channel_beds24_room_mappings
      (tenant_id, connection_id, beds24_property_id, beds24_room_id, room_id, status)
    VALUES (${tenantId}, ${A.conn.id}, ${PROPERTY}, ${B24_ROOM_MAPPED}, ${roomMapped}, 'mapped')`;
  const inbound = A.conn;

  const B = await mkTenant("Beds24 Quarantine Neighbour", `b24-quar-nb-${stamp}`);
  otherTenantId = B.tenantId;
  const otherRoom = await mkRoom(otherTenantId, B.roomTypeId, "Q24-N1");
  await sql`
    INSERT INTO guesthub.channel_beds24_room_mappings
      (tenant_id, connection_id, beds24_property_id, beds24_room_id, room_id, status)
    VALUES (${otherTenantId}, ${B.conn.id}, '999004', '707301', ${otherRoom}, 'mapped')`;
  // the neighbour's own parked revision. Its payload deliberately names a room
  // that IS mapped in tenant A — so a sweep that forgot its connection scope
  // would succeed in importing a FOREIGN tenant's booking into tenant A.
  const NEIGHBOUR_BOOKING = "888003";
  await sql`
    INSERT INTO guesthub.channel_booking_revisions
      (tenant_id, connection_id, provider_booking_id, provider_revision_id,
       revision_kind, raw_status, payload, import_status, ack_status, acknowledged_at,
       attempts, mapping_error)
    VALUES
      (${otherTenantId}, ${B.conn.id}, ${NEIGHBOUR_BOOKING}, ${`${NEIGHBOUR_BOOKING}:2026-07-24T09:00:00Z`},
       'new', 'new',
       ${sql.json(b24(NEIGHBOUR_BOOKING, B24_ROOM_MAPPED, { arrival: day(30), departure: day(32) }))},
       'quarantined', 'acknowledged', now(), 1, 'חדר Beds24 ללא מיפוי לחדר מקומי (707999)')`;

  // ---- helpers ----
  const revisionOf = async (bookingId) => (await sql`
    SELECT id, import_status, mapping_error, attempts, local_reservation_id, payload
    FROM guesthub.channel_booking_revisions
    WHERE connection_id = ${A.conn.id} AND provider_booking_id = ${bookingId}`)[0];
  const reservationsOf = async (bookingId, tid = tenantId) => sql`
    SELECT r.id, r.status, r.check_in::text AS check_in, r.check_out::text AS check_out,
           rr.room_id
    FROM guesthub.reservations r
    LEFT JOIN guesthub.reservation_rooms rr ON rr.reservation_id = r.id
    WHERE r.tenant_id = ${tid} AND r.external_booking_id = ${bookingId}`;
  const pull = async () => {
    served = [];
    const s = await imp.runBeds24InboundPull(sql, inbound);
    noViolations(); // the mock's breaches would otherwise be swallowed as network_error
    return s;
  };

  const MAPPED_BOOKING = "888001";
  const PARKED_BOOKING = "888002";

  // ============================================================
  // 1. cycle 1 — the mapped booking imports; the unmapped one is PARKED
  // ============================================================
  source.set(MAPPED_BOOKING, { booking: b24(MAPPED_BOOKING, B24_ROOM_MAPPED) });
  source.set(PARKED_BOOKING, {
    booking: b24(PARKED_BOOKING, B24_ROOM_UNMAPPED, { arrival: day(9), departure: day(11) }),
  });
  let summary = await pull();
  assert.equal(summary.inserted, 2, `both bookings persist as revisions (got ${JSON.stringify(summary)})`);
  assert.equal(summary.imported, 1, "only the mapped booking imports");
  assert.equal(summary.quarantined, 1, "the unmapped booking is quarantined, never guessed into a room");
  assert.equal((await reservationsOf(MAPPED_BOOKING)).length, 1, "the mapped booking became a reservation");
  const parked1 = await revisionOf(PARKED_BOOKING);
  assert.equal(parked1.import_status, "quarantined", "the unmapped booking is visibly parked");
  assert.equal(parked1.local_reservation_id, null, "a parked revision holds no local reservation");
  assert.match(parked1.mapping_error, new RegExp(B24_ROOM_UNMAPPED),
    "the parked revision names the Beds24 room id that has no mapping");
  assert.equal(parked1.attempts, 1, "the failed import is counted");
  assert.equal((await reservationsOf(PARKED_BOOKING)).length, 0,
    "NO reservation is created for an unmapped room — never a guessed room");
  const [alert] = await sql`
    SELECT error_code, context FROM guesthub.channel_sync_errors
    WHERE tenant_id = ${tenantId} AND error_code = 'unmapped_room'
    ORDER BY created_at DESC LIMIT 1`;
  assert.ok(alert, "the unmapped room raises a loud, durable alert (unmapped_room)");
  assert.equal(alert.context.beds24_room_id, B24_ROOM_UNMAPPED,
    "the alert carries the raw Beds24 room id the operator has to map");
  ok("cycle 1: an unmapped room parks the booking visibly (quarantined + unmapped_room alert), never a guessed room");

  // ============================================================
  // 2. cycle 2 — mapping still missing: the row is RE-TRIED every pull, the
  //    booking upstream is unchanged so nothing new is inserted
  // ============================================================
  summary = await pull();
  assert.equal(summary.inserted, 0,
    "an UNCHANGED booking re-polls to a hard no-op (the synthetic revision id already exists)");
  assert.equal(summary.quarantined, 1, "the parked row is re-attempted through the sweep");
  const parked2 = await revisionOf(PARKED_BOOKING);
  assert.equal(parked2.import_status, "quarantined", "still parked while the mapping is missing");
  assert.equal(parked2.attempts, 2,
    "the sweep — not the window pull — re-attempted the parked row (attempts climbed with zero inserts)");
  assert.equal((await reservationsOf(PARKED_BOOKING)).length, 0, "still no reservation");
  ok("cycle 2: an unchanged booking inserts nothing; the parked row is re-attempted by the sweep alone");

  // ============================================================
  // 3. THE SELF-HEAL — the operator maps the room; the booking is hidden from
  //    every window pull, so ONLY the stored (redacted) payload can heal it
  // ============================================================
  source.get(PARKED_BOOKING).hiddenFromWindows = true;
  await sql`
    INSERT INTO guesthub.channel_beds24_room_mappings
      (tenant_id, connection_id, beds24_property_id, beds24_room_id, room_id, status)
    VALUES (${tenantId}, ${A.conn.id}, ${PROPERTY}, ${B24_ROOM_UNMAPPED}, ${roomLate}, 'mapped')`;
  summary = await pull();
  assert.deepEqual(summary.errors, [],
    `the healing cycle must be error-free (got: ${summary.errors.join(" | ")})`);
  assert.ok(!served.includes(PARKED_BOOKING),
    "the parked booking was NOT re-served by any pull this cycle — the heal can only come from the stored payload");
  assert.equal(summary.inserted, 0, "nothing new was persisted this cycle");
  assert.ok(summary.imported >= 1, `the sweep imported the parked row (got ${JSON.stringify(summary)})`);
  const healed = await revisionOf(PARKED_BOOKING);
  assert.equal(healed.import_status, "imported", "the parked revision self-healed once the mapping existed");
  assert.equal(healed.mapping_error, null, "the mapping error is cleared on a successful import");
  assert.ok(healed.local_reservation_id, "the healed revision points at the reservation it created");
  const madeRows = await reservationsOf(PARKED_BOOKING);
  assert.equal(madeRows.length, 1, "exactly one reservation was created");
  assert.equal(madeRows[0].status, "confirmed", "the healed booking occupies the calendar as confirmed");
  assert.equal(madeRows[0].room_id, roomLate, "it landed in the room the operator finally mapped");
  assert.equal(madeRows[0].check_in, day(9), "the dates survived the redacted round-trip");
  assert.equal(madeRows[0].check_out, day(11));
  assert.equal(madeRows[0].id, healed.local_reservation_id);
  ok("SELF-HEAL: a mapped-since revision imports from its STORED redacted payload, with no upstream re-serve");

  // ============================================================
  // 4. settled — an imported revision is never swept again (no duplicates)
  // ============================================================
  summary = await pull();
  assert.equal(summary.imported, 0,
    "an already-imported revision must never be re-imported by the sweep (that would re-run the import transaction every 5 minutes)");
  assert.equal(summary.quarantined, 0, "nothing is parked any more");
  assert.equal((await reservationsOf(PARKED_BOOKING)).length, 1, "no duplicate reservation appeared");
  assert.equal((await revisionOf(PARKED_BOOKING)).attempts, healed.attempts,
    "the settled row is not touched at all");
  ok("settled: an imported revision leaves the sweep set — no duplicate import, no duplicate reservation");

  // ============================================================
  // 5. the sweep never crosses a connection boundary
  // ============================================================
  const [neighbour] = await sql`
    SELECT import_status, attempts, local_reservation_id
    FROM guesthub.channel_booking_revisions
    WHERE connection_id = ${B.conn.id} AND provider_booking_id = ${NEIGHBOUR_BOOKING}`;
  assert.equal(neighbour.import_status, "quarantined",
    "another connection's parked revision is NEVER swept by this connection's pull");
  assert.equal(neighbour.attempts, 1, "…and its attempt counter is untouched");
  assert.equal(neighbour.local_reservation_id, null, "…and it produced no reservation");
  assert.equal((await reservationsOf(NEIGHBOUR_BOOKING)).length, 0,
    "a foreign tenant's booking never landed in this tenant");
  assert.equal((await reservationsOf(NEIGHBOUR_BOOKING, otherTenantId)).length, 0,
    "…and it was not imported into its own tenant by someone else's pull either");
  ok("tenant isolation: the sweep is scoped to its own connection — a neighbour's parked revision is untouched");

  console.log(`\ncheck-beds24-quarantine-selfheal: all ${n} assertions passed`);
} finally {
  // scratch-tenant cleanup (dependency order) — testdb only
  for (const id of [tenantId, otherTenantId]) {
    if (!id) continue;
    for (const t of [
      "channel_sync_errors", "channel_dirty_ranges", "channel_booking_revisions",
      "channel_sync_jobs", "channel_evidence_ledger",
      "channel_beds24_room_mappings", "channel_connections",
      "audit_logs", "reservation_rooms", "reservations", "guests", "rooms",
      "room_types", "tenants",
    ]) {
      await sql.unsafe(
        t === "tenants"
          ? `DELETE FROM guesthub.tenants WHERE id = '${id}'`
          : `DELETE FROM guesthub.${t} WHERE tenant_id = '${id}'`,
      );
    }
  }
  await sql.end();
}
