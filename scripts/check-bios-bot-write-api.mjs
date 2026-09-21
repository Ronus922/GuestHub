// ============================================================
// check:bios-bot-write-api — Phase 5 §26 (create/modify/cancel + security +
// concurrency), against the REAL service functions (src/lib/bios-bot/
// service/{create-reservation,change-stay,cancel-reservation,add-note,
// update-guest-details}.ts) through withBiosBotIdempotency, the same path
// the routes use.
//
// Like check-bios-bot-idempotency.mjs, these functions manage their OWN
// top-level transaction, so this script uses a dedicated test tenant with
// explicit DELETE cleanup at the end rather than an outer rollback.
//
// Usage: node scripts/check-bios-bot-write-api.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);
const TEST_URL = process.env.TEST_DATABASE_URL || "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (TEST_URL.includes(marker)) { console.error(`REFUSED: production marker "${marker}"`); process.exit(1); }
}

console.log("applying migration chain to the test DB…");
const migrations = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
for (const f of migrations) {
  execSync(`psql "${TEST_URL}" -v ON_ERROR_STOP=1 -q < "db/migrations/${f}"`,
    { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" });
}

// ---- per-file transpile (NOT a full-program tsc build) ----
// A full `tsc --project` build over this entry-point set (create-reservation
// → channel/outbox → channel/queue → db → ...) crashes V8's regex compiler
// inside tsc itself on this host (reproducible, unrelated to our code —
// `pnpm typecheck` over the REAL project tsconfig, which already covers
// every file here, passes clean; see the closeout report). Since full
// project type-checking already happened there, this harness only needs
// runnable JS: ts.transpileModule per file (pure syntax strip, no
// cross-file type graph) sidesteps the crash entirely and is much faster.
console.log("transpiling src/ via ts.transpileModule (no type-checking — see comment above)…");
const req = createRequire(join(ROOT, "package.json"));
const ts = req("typescript");
const tmp = mkdtempSync(join(tmpdir(), "gh-biosbot-write-"));
const out = join(tmp, "out");
const SRC = join(ROOT, "src");
function transpileDir(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) { transpileDir(full); continue; }
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
    if (entry.endsWith(".test.ts")) continue;
    const source = readFileSync(full, "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
        esModuleInterop: true, jsx: entry.endsWith(".tsx") ? ts.JsxEmit.ReactJSX : undefined,
      },
      fileName: full,
    });
    const rel = relative(SRC, full).replace(/\.tsx?$/, ".js");
    const dest = join(out, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, outputText);
  }
}
transpileDir(SRC);

const stub = join(tmp, "server-only-stub.js");
writeFileSync(stub, "module.exports = {};\n");
const nextServerStub = join(tmp, "next-server-stub.js");
writeFileSync(nextServerStub, `
  class FakeResponse { constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; } }
  module.exports = { NextResponse: { json: (body, init) => new FakeResponse(body, init) } };
`);
const Module = req("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return stub;
  if (request === "next/server") return nextServerStub;
  if (request.startsWith("@/")) return origResolve.call(this, join(out, request.slice(2)), ...rest);
  // a bare package (e.g. "postgres", pulled in transitively via @/lib/db)
  // resolves from the tmp compile dir by default, which has no node_modules
  // — resolve it from ROOT instead, the same way engine.ts's own deps do.
  if (!request.startsWith(".") && !request.startsWith("/")) {
    try { return req.resolve(request); } catch { /* fall through */ }
  }
  return origResolve.call(this, request, ...rest);
};

const { withBiosBotIdempotency } = req(join(out, "lib/bios-bot/idempotency.js"));
const { createBiosBotReservation } = req(join(out, "lib/bios-bot/service/create-reservation.js"));
const { changeBiosBotReservationStay } = req(join(out, "lib/bios-bot/service/change-stay.js"));
const { cancelBiosBotReservation } = req(join(out, "lib/bios-bot/service/cancel-reservation.js"));
const { addBiosBotNote } = req(join(out, "lib/bios-bot/service/add-note.js"));
const { updateBiosBotGuestDetails } = req(join(out, "lib/bios-bot/service/update-guest-details.js"));
const { getBiosBotQuote } = req(join(out, "lib/bios-bot/service/quote.js"));
const { checkRoomAvailability } = req(join(out, "lib/inventory.js"));

const postgres = req("postgres");
const sql = postgres(TEST_URL, { prepare: false, max: 5, onnotice: () => {} });

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };
let keySeq = 0;
const nextKey = (label) => `wtest-${label}-${Date.now()}-${keySeq++}`;

const IN = "2027-10-10", OUT = "2027-10-12";

// ---- fixture ----
const [tenant] = await sql`INSERT INTO guesthub.tenants (name, slug, currency, settings)
  VALUES ('BIOS Bot Write', ${"bb-write-" + Date.now()}, 'ILS', ${sql.json({ vat_rate: 18 })}) RETURNING id`;
const T = tenant.id;
const [tenant2] = await sql`INSERT INTO guesthub.tenants (name, slug) VALUES ('BIOS Bot Write B', ${"bb-write-b-" + Date.now()}) RETURNING id`;
const T2 = tenant2.id;

const [rt] = await sql`INSERT INTO guesthub.room_types (tenant_id, name, base_price, max_occupancy, max_adults, max_children, max_infants)
  VALUES (${T}, 'Type', 400, 4, 3, 2, 1) RETURNING id`;

async function mkRoom(num) {
  const [r] = await sql`INSERT INTO guesthub.rooms ${sql({
    tenant_id: T, room_type_id: rt.id, room_number: num, status: "available", is_active: true,
    max_occupancy: 4, max_adults: 3, max_children: 2, max_infants: 1,
    included_occupancy: 2, extra_guest_pricing_mode: "inherit",
  })} RETURNING id`;
  const [su] = await sql`INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id) VALUES (${T}, ${num}, ${"Unit " + num}, ${rt.id}) RETURNING id`;
  await sql`INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id) VALUES (${T}, ${su.id}, ${r.id})`;
  const [bp] = await sql`INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base, plan_kind, is_active) VALUES (${T}, ${su.id}, ${"base-" + num}, 'Base', true, 'base', true) RETURNING id`;
  for (const d of ["2027-10-10", "2027-10-11", "2027-11-10", "2027-11-11"]) {
    await sql`INSERT INTO guesthub.pricing_plan_rates (tenant_id, sellable_unit_id, pricing_plan_id, date, price) VALUES (${T}, ${su.id}, ${bp.id}, ${d}, 500)`;
  }
  return r.id;
}
const roomA = await mkRoom("wa-1");
const roomB = await mkRoom("wa-2");

async function quoteFor(roomId, checkIn = IN, checkOut = OUT) {
  return sql.begin((tx) => getBiosBotQuote(tx, T, { checkIn, checkOut, rooms: [{ roomId, adults: 2, children: 0, infants: 0 }] }));
}

// ============================================================
// CREATE
// ============================================================
let created;
{
  const quote = await quoteFor(roomA);
  const reqBody = {
    checkIn: IN, checkOut: OUT, rooms: [{ roomId: roomA, adults: 2, children: 0, infants: 0 }],
    quoteFingerprint: quote.quoteFingerprint,
    guest: { firstName: "דנה", lastName: "כהן", phone: "0501111111", email: "dana-write@example.com" },
  };
  created = await withBiosBotIdempotency(sql, { tenantId: T, operation: "create_reservation", idempotencyKey: nextKey("create"), request: reqBody },
    (tx) => createBiosBotReservation(tx, T, "k", reqBody));
  assert.equal(created.status, "draft", "initial status is draft (owner decision)");
  assert.ok(created.reservationId);
  assert.equal(created.totalPrice, quote.totalGross, "created total matches the quote total exactly");

  const [row] = await sql`SELECT status, total_price::float8 AS total_price FROM guesthub.reservations WHERE id = ${created.reservationId}`;
  assert.equal(row.status, "draft");
  const rr = await sql`SELECT room_id, adults, price_total::float8 AS price_total FROM guesthub.reservation_rooms WHERE reservation_id = ${created.reservationId}`;
  assert.equal(rr.length, 1, "exactly one reservation_rooms row for a single-room create");
  assert.equal(rr[0].room_id, roomA);
  ok("create_reservation: draft status, correct total, one reservation_rooms row matching the quote");
}

// ---- PRICE_CHANGED ----
{
  const reqBody = {
    checkIn: IN, checkOut: OUT, rooms: [{ roomId: roomB, adults: 2, children: 0, infants: 0 }],
    quoteFingerprint: "stale-fingerprint-does-not-match-anything",
    guest: { firstName: "X", lastName: "Y" },
  };
  let threw = null;
  try {
    await withBiosBotIdempotency(sql, { tenantId: T, operation: "create_reservation", idempotencyKey: nextKey("stale"), request: reqBody },
      (tx) => createBiosBotReservation(tx, T, "k", reqBody));
  } catch (e) { threw = e; }
  assert.ok(threw, "a stale/mismatched fingerprint is refused");
  assert.equal(threw.code, "PRICE_CHANGED");
  const rows = await sql`SELECT count(*)::int AS n FROM guesthub.reservation_rooms WHERE room_id = ${roomB}`;
  assert.equal(rows[0].n, 0, "no reservation was created for the rejected request");
  ok("create_reservation: a fingerprint mismatch is PRICE_CHANGED, nothing is created");
}

// ---- multi-room create ----
{
  const q1 = await quoteFor(roomB, "2027-11-10", "2027-11-12");
  const reqBody = {
    checkIn: "2027-11-10", checkOut: "2027-11-12",
    rooms: [{ roomId: roomA, adults: 2, children: 0, infants: 0 }, { roomId: roomB, adults: 2, children: 0, infants: 0 }],
    quoteFingerprint: null, // placeholder, replaced below
    guest: { firstName: "Multi", lastName: "Room" },
  };
  // a real multi-room fingerprint must come from a matching multi-room quote
  const multiQuote = await sql.begin((tx) => getBiosBotQuote(tx, T, {
    checkIn: "2027-11-10", checkOut: "2027-11-12",
    rooms: [{ roomId: roomA, adults: 2, children: 0, infants: 0 }, { roomId: roomB, adults: 2, children: 0, infants: 0 }],
  }));
  reqBody.quoteFingerprint = multiQuote.quoteFingerprint;
  const multiCreated = await withBiosBotIdempotency(sql, { tenantId: T, operation: "create_reservation", idempotencyKey: nextKey("multi"), request: reqBody },
    (tx) => createBiosBotReservation(tx, T, "k", reqBody));
  const rr = await sql`SELECT room_id FROM guesthub.reservation_rooms WHERE reservation_id = ${multiCreated.reservationId}`;
  assert.equal(rr.length, 2, "a multi-room create produces one reservation_rooms row per room — the architecture is not narrowed to single-room-only");
  void q1;
  ok("create_reservation: multi-room create works even though BIOS Bot v1 typically books one room at a time");
}

// ============================================================
// CONCURRENCY — two concurrent creates for the SAME room+dates
// ============================================================
{
  const concIn = "2028-01-05", concOut = "2028-01-07";
  for (const d of [concIn, "2028-01-06"]) {
    const [su] = await sql`SELECT sur.sellable_unit_id AS id FROM guesthub.sellable_unit_rooms sur WHERE sur.room_id = ${roomA}`;
    await sql`INSERT INTO guesthub.pricing_plan_rates (tenant_id, sellable_unit_id, pricing_plan_id, date, price)
      SELECT ${T}, ${su.id}, pp.id, ${d}, 500 FROM guesthub.pricing_plans pp WHERE pp.sellable_unit_id = ${su.id} AND pp.is_base
      ON CONFLICT DO NOTHING`;
  }
  const quote = await quoteFor(roomA, concIn, concOut);
  const mkReq = () => ({
    checkIn: concIn, checkOut: concOut, rooms: [{ roomId: roomA, adults: 2, children: 0, infants: 0 }],
    quoteFingerprint: quote.quoteFingerprint, guest: { firstName: "Race", lastName: "Condition" },
  });
  const attempt = () => withBiosBotIdempotency(
    sql, { tenantId: T, operation: "create_reservation", idempotencyKey: nextKey("race"), request: mkReq() },
    (tx) => createBiosBotReservation(tx, T, "k", mkReq()),
  );
  const results = await Promise.allSettled([attempt(), attempt()]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one of the two concurrent same-room/same-dates creates succeeds");
  assert.equal(rejected.length, 1, "exactly one is refused");
  assert.equal(rejected[0].reason.code, "ROOM_NOT_AVAILABLE", "the loser is refused as ROOM_NOT_AVAILABLE, not a raw DB error or a crash");
  const rows = await sql`SELECT count(*)::int AS n FROM guesthub.reservation_rooms WHERE room_id = ${roomA} AND check_in = ${concIn}`;
  assert.equal(rows[0].n, 1, "exactly one reservation_rooms row exists for the contested room/dates — no double booking");
  ok("concurrency: two concurrent create attempts for the same room/dates — one succeeds, one ROOM_NOT_AVAILABLE, no double booking");
}

// ============================================================
// CHANGE_STAY
// ============================================================
{
  const [stayRow] = await sql`SELECT id FROM guesthub.reservation_rooms WHERE reservation_id = ${created.reservationId}`;
  const newIn = "2027-10-10", newOut = "2027-10-11"; // shorter stay, same room — proves self-exclusion (was already occupying these nights itself)
  const changeReq = { stayId: stayRow.id, checkIn: newIn, checkOut: newOut };
  const changed = await withBiosBotIdempotency(sql, { tenantId: T, operation: "change_stay", idempotencyKey: nextKey("change"), request: { reservationId: created.reservationId, ...changeReq } },
    (tx) => changeBiosBotReservationStay(tx, T, created.reservationId, stayRow.id, changeReq));
  assert.equal(changed.checkIn, newIn);
  assert.equal(changed.checkOut, newOut);

  const [rrRow] = await sql`SELECT check_in::text AS check_in, check_out::text AS check_out FROM guesthub.reservation_rooms WHERE id = ${stayRow.id}`;
  assert.equal(rrRow.check_in, newIn, "the stay's own dates changed to the new window without tripping over its OWN prior occupancy (excludeReservationRoomIds works)");

  const [resRow] = await sql`SELECT check_in::text AS check_in, check_out::text AS check_out, total_price::float8 AS total_price FROM guesthub.reservations WHERE id = ${created.reservationId}`;
  assert.equal(resRow.check_in, newIn, "the reservation's aggregate check_in was recomputed from its stays");
  assert.ok(resRow.total_price > 0, "totals were recalculated, not left stale");
  ok("change_stay: dates changed correctly, own row excluded from its own availability check, reservation totals recalculated");
}
{
  // target-room availability IS still checked: try to move onto a room/dates that's genuinely occupied
  const [stayRow] = await sql`SELECT id FROM guesthub.reservation_rooms WHERE reservation_id = ${created.reservationId}`;
  // roomB is occupied 2027-11-10..12 by the multi-room reservation created above
  let threw = null;
  try {
    await withBiosBotIdempotency(sql, { tenantId: T, operation: "change_stay", idempotencyKey: nextKey("change-conflict"), request: { x: 1 } },
      (tx) => changeBiosBotReservationStay(tx, T, created.reservationId, stayRow.id, { roomId: roomB, checkIn: "2027-11-10", checkOut: "2027-11-12" }));
  } catch (e) { threw = e; }
  assert.ok(threw, "moving onto a genuinely occupied room+dates is refused");
  assert.equal(threw.code, "ROOM_NOT_AVAILABLE");
  ok("change_stay: the TARGET room/dates availability is still enforced (not just self-exclusion)");
}

// ============================================================
// ADD_NOTE
// ============================================================
{
  await withBiosBotIdempotency(sql, { tenantId: T, operation: "add_note", idempotencyKey: nextKey("note1"), request: { r: created.reservationId, note: "first" } },
    (tx) => addBiosBotNote(tx, T, created.reservationId, { note: "guest asked about early check-in" }));
  await withBiosBotIdempotency(sql, { tenantId: T, operation: "add_note", idempotencyKey: nextKey("note2"), request: { r: created.reservationId, note: "second" } },
    (tx) => addBiosBotNote(tx, T, created.reservationId, { note: "guest confirmed 3pm arrival" }));
  const [row] = await sql`SELECT internal_notes, notes FROM guesthub.reservations WHERE id = ${created.reservationId}`;
  assert.ok(row.internal_notes.includes("early check-in"), "first note present");
  assert.ok(row.internal_notes.includes("3pm arrival"), "second note appended, not overwritten");
  assert.ok(row.internal_notes.includes("[BIOS Bot"), "the note is attributed");
  assert.equal(row.notes, null, "the customer-facing notes column is never touched by add_note");
  ok("add_note: appends to internal_notes with attribution, never touches the customer-facing notes column");
}

// ============================================================
// UPDATE_GUEST_DETAILS
// ============================================================
{
  const [before] = await sql`SELECT g.first_name, g.last_name FROM guesthub.reservations r JOIN guesthub.guests g ON g.id = r.primary_guest_id WHERE r.id = ${created.reservationId}`;
  await withBiosBotIdempotency(sql, { tenantId: T, operation: "update_guest_details", idempotencyKey: nextKey("guest"), request: { r: created.reservationId, phone: "0509998888" } },
    (tx) => updateBiosBotGuestDetails(tx, T, created.reservationId, { phone: "0509998888" }));
  const [after] = await sql`SELECT g.first_name, g.last_name, g.phone FROM guesthub.reservations r JOIN guesthub.guests g ON g.id = r.primary_guest_id WHERE r.id = ${created.reservationId}`;
  assert.equal(after.phone, "0509998888", "phone updated");
  assert.equal(after.first_name, before.first_name, "first_name untouched when omitted (COALESCE, not overwrite-with-null)");
  assert.equal(after.last_name, before.last_name, "last_name untouched when omitted");
  ok("update_guest_details: only the supplied field changes, everything else is preserved");
}

// ============================================================
// CANCEL — normal reservation
// ============================================================
{
  const cancelReq = { reason: "guest changed plans" };
  const cancelled = await withBiosBotIdempotency(sql, { tenantId: T, operation: "cancel_reservation", idempotencyKey: nextKey("cancel"), request: { r: created.reservationId, ...cancelReq } },
    (tx) => cancelBiosBotReservation(tx, T, created.reservationId, cancelReq));
  assert.equal(cancelled.status, "cancelled");
  const [row] = await sql`SELECT status, cancellation_reason, cancelled_by_type FROM guesthub.reservations WHERE id = ${created.reservationId}`;
  assert.equal(row.status, "cancelled");
  assert.equal(row.cancellation_reason, "guest changed plans");
  assert.equal(row.cancelled_by_type, "guest");

  // inventory released: the SAME room/dates must now show as available again
  const conflicts = await sql.begin((tx) => checkRoomAvailability(tx, { tenantId: T, roomIds: [roomA], checkIn: "2027-10-10", checkOut: "2027-10-11" }));
  assert.equal(conflicts.length, 0, "the room is available again after cancellation");
  ok("cancel_reservation: status=cancelled, reason recorded, inventory released immediately");
}

// ============================================================
// CANCEL — OTA-managed reservation is refused
// ============================================================
{
  const [conn] = await sql`INSERT INTO guesthub.channel_connections (tenant_id, provider, state)
    VALUES (${T}, 'beds24', 'active') RETURNING id`;
  const [otaRes] = await sql`INSERT INTO guesthub.reservations
    (tenant_id, reservation_number, status, check_in, check_out, total_price, channel_connection_id)
    VALUES (${T}, ${"OTA-" + Date.now()}, 'confirmed', '2027-12-01', '2027-12-02', 500, ${conn.id}) RETURNING id`;
  let threw = null;
  try {
    await withBiosBotIdempotency(sql, { tenantId: T, operation: "cancel_reservation", idempotencyKey: nextKey("ota-cancel"), request: { r: otaRes.id } },
      (tx) => cancelBiosBotReservation(tx, T, otaRes.id, { reason: "guest asked" }));
  } catch (e) { threw = e; }
  assert.ok(threw, "cancelling a channel-managed reservation is refused");
  assert.equal(threw.code, "CANCELLATION_NOT_ALLOWED");
  const [row] = await sql`SELECT status FROM guesthub.reservations WHERE id = ${otaRes.id}`;
  assert.equal(row.status, "confirmed", "the OTA reservation status is unchanged — no bypass");
  ok("cancel_reservation: a channel-managed (OTA) reservation is refused, never cancelled locally");
}

// ============================================================
// tenant isolation on writes
// ============================================================
{
  let threw = null;
  try {
    await withBiosBotIdempotency(sql, { tenantId: T2, operation: "add_note", idempotencyKey: nextKey("cross-tenant"), request: { r: created.reservationId } },
      (tx) => addBiosBotNote(tx, T2, created.reservationId, { note: "should never land" }));
  } catch (e) { threw = e; }
  assert.ok(threw, "tenant B writing a note to tenant A's reservation id is refused");
  assert.equal(threw.code, "RESERVATION_NOT_FOUND");
  ok("writes: tenant isolation — a reservation id from another tenant is indistinguishable from not-found");
}

// ============================================================
// idempotency, exercised through the REAL create_reservation shape
// ============================================================
{
  const quote = await quoteFor(roomB, "2028-02-10", "2028-02-12");
  const reqBody = {
    checkIn: "2028-02-10", checkOut: "2028-02-12", rooms: [{ roomId: roomB, adults: 2, children: 0, infants: 0 }],
    quoteFingerprint: quote.quoteFingerprint, guest: { firstName: "Idem", lastName: "Potent" },
  };
  const key = nextKey("real-idem");
  const first = await withBiosBotIdempotency(sql, { tenantId: T, operation: "create_reservation", idempotencyKey: key, request: reqBody }, (tx) => createBiosBotReservation(tx, T, key, reqBody));
  const second = await withBiosBotIdempotency(sql, { tenantId: T, operation: "create_reservation", idempotencyKey: key, request: reqBody }, (tx) => createBiosBotReservation(tx, T, key, reqBody));
  assert.deepEqual(first, second, "replaying the SAME create request with the SAME key returns the SAME reservation, not a new one");
  const rows = await sql`SELECT count(*)::int AS n FROM guesthub.reservations WHERE tenant_id = ${T} AND reservation_number = ${first.reservationNumber}`;
  assert.equal(rows[0].n, 1, "exactly one reservation row exists — a retried create never duplicates");
  ok("create_reservation through withBiosBotIdempotency: a retried request with the same key never creates a second reservation");
}

await sql`DELETE FROM guesthub.tenants WHERE id IN (${T}, ${T2})`;
await sql.end();
console.log(`\nALL ${n} BIOS-BOT WRITE-API CHECKS PASSED`);
