// ============================================================
// Inbound booking import checks (D76). Exercises the REAL import pipeline
// (feed → persist → import → ack) against the isolated test DB with a fake
// Channex upstream — no network, nothing committed to prod.
//
//  · NEW revision → exactly one reservation + reservation_rooms on the mapped
//    PHYSICAL room (resolved by external UUID, never by title), calendar-visible
//  · honest money: channel total, unpaid, ledger-derived balance
//  · masked guarantee → metadata only (no PAN field, no reservation_cards row),
//    redacted payload (guarantee + raw_message), CVV never stored anywhere
//  · valid-PAN channel card → encrypted at rest, attached to the reservation
//  · duplicate delivery / repeated pull / worker retry → zero duplicates
//  · ACK only after commit; ack failure leaves the revision unacknowledged and
//    the NEXT pull re-acks without re-importing; ACK before import is
//    structurally impossible
//  · wrong property → rejected (quarantined, never imported, never acked)
//  · unmapped room → visible quarantine, imports cleanly once mapped
//  · local conflict → quarantined, local stay untouched, no ack
//  · MODIFIED updates the SAME reservation (dates/rooms/occupancy/amount) and
//    releases/consumes availability atomically; CANCELLED cancels (never
//    deletes) and releases the room
//  · tenant isolation via connection-scoped mappings
//  · fallback poll enqueues the pull job with no webhook; dedup within window
//
// Usage: node scripts/check-inbound-bookings.mjs
// ============================================================
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const ROOT = "/var/www/guesthub";
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
process.env.CHANNEL_SECRETS_KEY = "inbound-check-local-key-not-production";
process.env.CARD_VAULT_KEY = "inbound-check-card-vault-key-not-production";

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };

console.log("applying migration chain to guesthub-testdb (:5433)…");
for (const f of readdirSync(join(ROOT, "db/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
  execSync(
    `docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "db/migrations/${f}"`,
    { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" },
  );
}

console.log("compiling the import graph via tsc…");
const tmp = mkdtempSync(join(tmpdir(), "gh-inbound-"));
const out = join(tmp, "out");
writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    module: "commonjs", moduleResolution: "node10", target: "es2022",
    esModuleInterop: true, skipLibCheck: true, strict: true,
    baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
    rootDir: join(ROOT, "src"), outDir: out,
    typeRoots: [join(ROOT, "node_modules/@types")], types: ["node"],
  },
  include: [join(ROOT, "src/lib/channel/worker.ts")],
}));
execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });

const stub = join(tmp, "server-only-stub.js");
writeFileSync(stub, "module.exports = {};\n");
const req = createRequire(join(ROOT, "package.json"));
const Module = req("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return stub;
  if (request.startsWith("@/")) return origResolve.call(this, join(out, request.slice(2)), ...rest);
  try { return origResolve.call(this, request, ...rest); }
  catch (e) { if (/^[a-z@]/.test(request)) return req.resolve(request); throw e; }
};

const { sql } = req(join(out, "lib/db.js"));
const { encryptSecret } = req(join(out, "lib/channel/crypto.js"));
const {
  runInboundPull, importRevisionRow, loadInboundConnections,
  approveExternalChange, rejectExternalChange,
} = req(join(out, "lib/channel/booking-import.js"));
const { persistBookingRevision, markRevisionAcknowledged } = req(join(out, "lib/channel/revisions.js"));
const { decryptPan } = req(join(out, "lib/card-vault.js"));
const workerMod = req(join(out, "lib/channel/worker.js"));

// ---- fake Channex upstream, installed as global fetch ----
const upstream = {
  revisions: [], // { id, attributes, acked }
  ackCalls: [],
  feedFail: false,
  ackFail: false,
  ratePlans: {}, // id -> { title, propertyId, roomTypeId } (verified-adoption source)
  gmailSends: 0, // every REAL send call to the fake Gmail API
  gmailBodies: [], // decoded raw messages, for content assertions
};
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  const path = u.pathname;
  const json = (status, body) => ({ status, ok: status < 300, json: async () => body });
  if (path.endsWith("/booking_revisions/feed")) {
    if (upstream.feedFail) throw new TypeError("fetch failed");
    const prop = u.searchParams.get("filter[property_id]");
    const rows = upstream.revisions
      .filter((r) => !r.acked && r.attributes.property_id === prop)
      .sort((a, b) => String(a.attributes.inserted_at).localeCompare(String(b.attributes.inserted_at)))
      .slice(0, 100)
      .map((r) => ({ id: r.id, type: "booking_revision", attributes: r.attributes }));
    return json(200, { data: rows, meta: { total: rows.length, page: 1, limit: 100 } });
  }
  const ackMatch = path.match(/\/booking_revisions\/([^/]+)\/ack$/);
  if (ackMatch) {
    upstream.ackCalls.push(ackMatch[1]);
    if (upstream.ackFail) return json(500, { errors: {} });
    const row = upstream.revisions.find((r) => r.id === ackMatch[1]);
    if (!row) return json(404, { errors: {} });
    row.acked = true;
    return json(200, { meta: { message: "Success" } });
  }
  const revMatch = path.match(/\/booking_revisions\/([^/]+)$/);
  if (revMatch) {
    const row = upstream.revisions.find((r) => r.id === revMatch[1]);
    if (!row) return json(404, { errors: {} });
    return json(200, { data: { id: row.id, type: "booking_revision", attributes: row.attributes } });
  }
  // single rate-plan GET — the verified-adoption lookup (JSON:API relationships)
  const rpMatch = path.match(/\/rate_plans\/([^/]+)$/);
  if (rpMatch) {
    const rp = upstream.ratePlans[decodeURIComponent(rpMatch[1])];
    if (!rp) return json(404, { errors: {} });
    return json(200, {
      data: {
        id: decodeURIComponent(rpMatch[1]),
        type: "rate_plan",
        attributes: { title: rp.title, currency: "GBP" },
        relationships: {
          property: { data: { id: rp.propertyId, type: "property" } },
          room_type: { data: { id: rp.roomTypeId, type: "room_type" } },
        },
      },
    });
  }
  // ---- fake Gmail (OAuth token + messages.send) for the email-retry checks ----
  if (u.hostname === "oauth2.googleapis.com" && path === "/token") {
    return json(200, { access_token: "fake-access-token" });
  }
  if (u.hostname === "gmail.googleapis.com" && path.endsWith("/messages/send")) {
    upstream.gmailSends += 1;
    const raw = JSON.parse(init?.body ?? "{}").raw ?? "";
    // raw = url-safe base64 of a MIME message whose body part is base64 again
    const mime = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const bodyPart = mime.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    upstream.gmailBodies.push(Buffer.from(bodyPart, "base64").toString("utf8"));
    return json(200, { id: `gm-msg-${upstream.gmailSends}`, threadId: "gm-thread-1" });
  }
  throw new Error(`fake channex: unexpected path ${path}`);
};

// ---- fixture ----
const TAG = `inbound-check-${process.pid}`;
let revSeq = 0;
const mkRevision = (over = {}) => {
  const room = {
    room_type_id: "crt-1", rate_plan_id: "crp-a",
    checkin_date: "2026-08-10", checkout_date: "2026-08-11",
    amount: "263.72", days: { "2026-08-10": "223.21" },
    occupancy: { adults: 2, children: 0, infants: 0, ages: [] },
    is_cancelled: false,
    ...(over.room ?? {}),
  };
  const rest = { ...over };
  delete rest.room;
  return {
    id: rest.id ?? `rev-${++revSeq}`,
    status: "new",
    booking_id: "book-1",
    property_id: "prop-A",
    unique_id: "BDC-TEST-1",
    system_id: "sysid",
    ota_reservation_code: "999111",
    ota_name: "BookingCom",
    currency: "GBP",
    amount: room.amount,
    arrival_date: room.checkin_date,
    departure_date: room.checkout_date,
    inserted_at: `2026-07-10T18:27:${String(revSeq).padStart(2, "0")}`,
    customer: { name: "Ronen", surname: "Meshulam", mail: "guest@example.com", phone: "+972520000000", country: "IL", language: "en-us" },
    occupancy: { adults: room.occupancy.adults, children: room.occupancy.children, infants: room.occupancy.infants, ages: [] },
    notes: "Payment Collect: Hotel collect",
    payment_collect: "property",
    payment_type: "credit_card",
    guarantee: {
      card_number: "375516*****1144", card_type: "AX", cardholder_name: "Ronen Meshulam",
      expiration_date: "09/2031", is_virtual: false, cvv: "***", token: null,
    },
    raw_message: 'PaymentCard @CardNumber "375516*****1144" @SeriesCode "****"',
    rooms: [room],
    ...rest,
  };
};

async function seedTenant(slug, prop, roomTypeId) {
  const [tenant] = await sql`
    INSERT INTO guesthub.tenants (name, slug, timezone, currency)
    VALUES (${"בדיקת ייבוא " + slug}, ${TAG + "-" + slug}, 'Asia/Jerusalem', 'ILS')
    RETURNING id`;
  const T = tenant.id;
  const [room] = await sql`
    INSERT INTO guesthub.rooms (tenant_id, room_number, name, status, is_active)
    VALUES (${T}, ${"1237-" + slug}, 'חדר בדיקה', 'available', true) RETURNING id`;
  const [conn] = await sql`
    INSERT INTO guesthub.channel_connections
      (tenant_id, provider, environment, state, channex_property_id,
       outbound_sync_enabled, inbound_sync_enabled, full_sync_required, api_key_ciphertext)
    VALUES (${T}, 'channex', 'staging', 'active', ${prop},
            false, true, false, ${encryptSecret("test-api-key")})
    RETURNING id, tenant_id, environment, channex_property_id, api_key_ciphertext`;
  await sql`
    INSERT INTO guesthub.channel_room_mappings
      (tenant_id, connection_id, channex_property_id, room_id, room_number,
       channex_room_type_id, status, method)
    VALUES (${T}, ${conn.id}, ${prop}, ${room.id}, ${"1237-" + slug}, ${roomTypeId}, 'mapped', 'created')`;
  const [plan] = await sql`
    INSERT INTO guesthub.pricing_plans (tenant_id, code, name, is_base, plan_kind)
    VALUES (${T}, ${"chk-" + slug}, 'תוכנית בדיקה', false, 'base') RETURNING id`;
  await sql`
    INSERT INTO guesthub.channel_room_rate_mappings
      (tenant_id, connection_id, channex_property_id, local_rate_plan_id, room_id,
       room_number, channex_room_type_id, channex_rate_plan_id, status, currency)
    VALUES (${T}, ${conn.id}, ${prop}, ${plan.id}, ${room.id},
            ${"1237-" + slug}, ${roomTypeId}, ${"crp-" + slug}, 'mapped', 'GBP')`;
  await sql`
    INSERT INTO guesthub.lookup_items (tenant_id, category, key, label)
    VALUES (${T}, 'booking_sources', 'booking_com', 'Booking.com')`;
  return { tenantId: T, roomId: room.id, conn, planId: plan.id };
}

// postgres.js returns date columns as Date objects; compare as YYYY-MM-DD
const d10 = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

const resCount = (T) =>
  sql`SELECT COUNT(*)::int AS c FROM guesthub.reservations WHERE tenant_id = ${T}`.then((r) => r[0].c);
const bookingRes = (connId, bookingId) =>
  sql`SELECT * FROM guesthub.reservations
      WHERE channel_connection_id = ${connId} AND external_booking_id = ${bookingId}`.then((r) => r[0] ?? null);
const availability = (T, roomId, from, to) =>
  sql`SELECT * FROM guesthub.check_room_availability(${T}, ARRAY[${roomId}]::uuid[], ${from}, ${to})`;
// the pending review row for a held external change (037)
const reviewFor = (connId, revId) =>
  sql`SELECT * FROM guesthub.channel_external_changes
      WHERE connection_id = ${connId} AND provider_revision_id = ${revId}`.then((r) => r[0] ?? null);
const approveRev = async (T, connId, revId) => {
  const review = await reviewFor(connId, revId);
  assert.ok(review, `no review row for ${revId}`);
  return approveExternalChange(sql, T, review.id, null);
};

let A, B;
try {
  A = await seedTenant("a", "prop-A", "crt-1");
  B = await seedTenant("b", "prop-B", "crt-B");
  // second mapped room in tenant A for the room-move test
  const [room2] = await sql`
    INSERT INTO guesthub.rooms (tenant_id, room_number, name, status, is_active)
    VALUES (${A.tenantId}, '1238-a', 'חדר בדיקה 2', 'available', true) RETURNING id`;
  await sql`
    INSERT INTO guesthub.channel_room_mappings
      (tenant_id, connection_id, channex_property_id, room_id, room_number,
       channex_room_type_id, status, method)
    VALUES (${A.tenantId}, ${A.conn.id}, 'prop-A', ${room2.id}, '1238-a', 'crt-2', 'mapped', 'created')`;
  A.room2Id = room2.id;

  // ---- 1. NEW revision imports to the mapped physical room ----
  // the misleading title proves resolution is by external UUID, never by name
  upstream.revisions.push({
    id: "rev-new-1", acked: false,
    attributes: mkRevision({ id: "rev-new-1", rooms: [ { ...mkRevision().rooms[0], meta: { room_title: "9999 wrong title" } } ] }),
  });
  let s = await runInboundPull(sql, A.conn);
  assert.equal(s.imported, 1);
  assert.equal(s.acked, 1);
  const created = await bookingRes(A.conn.id, "book-1");
  assert.ok(created, "reservation exists");
  assert.equal(created.status, "confirmed");
  assert.equal(Number(created.total_price), 263.72);
  assert.equal(created.currency, "GBP");
  assert.equal(Number(created.paid_amount), 0);
  assert.equal(Number(created.balance), 263.72);
  assert.equal(created.external_unique_id, "BDC-TEST-1");
  assert.equal(created.ota_reservation_code, "999111");
  assert.equal(created.ota_name, "BookingCom");
  assert.ok(created.external_booked_at, "external_booked_at recorded");
  const rr = await sql`
    SELECT * FROM guesthub.reservation_rooms WHERE reservation_id = ${created.id}`;
  assert.equal(rr.length, 1);
  assert.equal(rr[0].room_id, A.roomId);
  assert.equal(d10(rr[0].check_in), "2026-08-10");
  assert.equal(d10(rr[0].check_out), "2026-08-11");
  assert.equal(rr[0].adults, 2);
  assert.equal(rr[0].is_manual_rate, true);
  assert.equal(rr[0].rate_plan_id, A.planId);
  const [src] = await sql`
    SELECT li.key FROM guesthub.reservations r
    JOIN guesthub.lookup_items li ON li.id = r.source_id WHERE r.id = ${created.id}`;
  assert.equal(src.key, "booking_com");
  ok("NEW revision → one reservation on the UUID-mapped physical room (title ignored), honest totals, unpaid");

  // calendar visibility: the exact range-intersection shape data.ts uses
  const cal = await sql`
    SELECT rr.room_id FROM guesthub.reservation_rooms rr
    JOIN guesthub.reservations res ON res.id = rr.reservation_id
    WHERE rr.tenant_id = ${A.tenantId} AND rr.room_id IS NOT NULL
      AND rr.check_in < '2026-08-20' AND rr.check_out > '2026-08-01'
      AND res.status <> 'cancelled'`;
  assert.equal(cal.length, 1);
  assert.equal(cal[0].room_id, A.roomId);
  ok("imported booking is visible through the calendar's own query — no second calendar path");

  // ---- 2. masked-card safety ----
  const [rev1] = await sql`
    SELECT * FROM guesthub.channel_booking_revisions WHERE provider_revision_id = 'rev-new-1'`;
  assert.equal(rev1.import_status, "imported");
  assert.equal(rev1.ack_status, "acknowledged");
  assert.ok(rev1.acknowledged_at, "acknowledged_at set");
  assert.equal(rev1.card_pan_encrypted, null, "masked guarantee never becomes a PAN");
  assert.equal(rev1.card_meta.last4, "1144");
  assert.equal(rev1.card_meta.brand, "AX");
  assert.equal(rev1.card_meta.masked_only, true);
  assert.equal(rev1.card_meta.exp_month, 9);
  assert.equal(rev1.card_meta.exp_year, 2031);
  assert.ok(!("cvv" in rev1.card_meta), "no CVV key in card_meta");
  assert.equal(rev1.payload.guarantee, "[redacted]");
  assert.equal(rev1.payload.raw_message, "[redacted]");
  assert.ok(!JSON.stringify(rev1.payload).includes("1144"), "no card digits in stored payload");
  const [cards] = await sql`
    SELECT COUNT(*)::int AS c FROM guesthub.reservation_cards WHERE tenant_id = ${A.tenantId}`;
  assert.equal(cards.c, 0, "no reservation_cards row without a real PAN");
  ok("masked guarantee → metadata only; payload redacted (guarantee + raw_message); no PAN, no CVV, no card row");

  // ---- 3. duplicate delivery imports zero duplicates ----
  upstream.revisions.find((r) => r.id === "rev-new-1").acked = false; // simulate re-delivery
  s = await runInboundPull(sql, A.conn);
  assert.equal(s.imported, 0);
  assert.equal(s.alreadyImported, 1);
  // upstream re-acked; the LOCAL row was already acknowledged, so no transition
  assert.ok(upstream.revisions.find((r) => r.id === "rev-new-1").acked, "re-acked upstream");
  assert.equal(await resCount(A.tenantId), 1);
  s = await runInboundPull(sql, A.conn); // plain second pull, empty feed
  assert.equal(s.pulled + s.imported, 0);
  assert.equal(await resCount(A.tenantId), 1);
  ok("re-delivered revision + repeated pull → zero duplicate reservations");

  // ---- 4. ack failure: imported stays unacked, next pull re-acks without re-import ----
  upstream.ackFail = true;
  upstream.revisions.push({ id: "rev-ackfail", acked: false, attributes: mkRevision({ id: "rev-ackfail", booking_id: "book-2", unique_id: "BDC-TEST-2", room: { checkin_date: "2026-09-01", checkout_date: "2026-09-02", days: { "2026-09-01": "100" }, amount: "100" } }) });
  s = await runInboundPull(sql, A.conn);
  assert.equal(s.imported, 1);
  assert.equal(s.acked, 0);
  const [unacked] = await sql`
    SELECT import_status, ack_status FROM guesthub.channel_booking_revisions
    WHERE provider_revision_id = 'rev-ackfail'`;
  assert.equal(unacked.import_status, "imported");
  assert.equal(unacked.ack_status, "unacknowledged");
  upstream.ackFail = false;
  s = await runInboundPull(sql, A.conn);
  assert.equal(s.imported, 0);
  assert.equal(s.acked, 1);
  assert.equal(await resCount(A.tenantId), 2);
  ok("failed ack → durably imported, unacknowledged; next pull re-acks with zero re-import");

  // ---- 5. ACK before import is structurally impossible ----
  const pending = await persistBookingRevision(sql, {
    tenantId: A.tenantId, connectionId: A.conn.id,
    providerBookingId: "book-pending", providerRevisionId: "rev-pending",
    revisionKind: "new", payload: mkRevision({ id: "rev-pending", booking_id: "book-pending" }),
  });
  assert.equal(await markRevisionAcknowledged(sql, pending.id), false);
  const [still] = await sql`
    SELECT ack_status FROM guesthub.channel_booking_revisions WHERE id = ${pending.id}`;
  assert.equal(still.ack_status, "unacknowledged");
  await sql`DELETE FROM guesthub.channel_booking_revisions WHERE id = ${pending.id}`;
  ok("a revision that is not imported can never be acknowledged (DB-side gate)");

  // ---- 6. local conflict → quarantine; local stay untouched; never acked ----
  const [localRes] = await sql`
    INSERT INTO guesthub.reservations
      (tenant_id, reservation_number, status, check_in, check_out, total_price, balance)
    VALUES (${A.tenantId}, 'L-9001', 'confirmed', '2026-10-01', '2026-10-03', 500, 500)
    RETURNING id`;
  await sql`
    INSERT INTO guesthub.reservation_rooms
      (tenant_id, reservation_id, room_id, check_in, check_out, adults, rate_per_night, price_total)
    VALUES (${A.tenantId}, ${localRes.id}, ${A.roomId}, '2026-10-01', '2026-10-03', 2, 250, 500)`;
  upstream.ackCalls.length = 0;
  upstream.revisions.push({ id: "rev-conflict", acked: false, attributes: mkRevision({ id: "rev-conflict", booking_id: "book-3", room: { checkin_date: "2026-10-02", checkout_date: "2026-10-04", days: {}, amount: "300" } }) });
  s = await runInboundPull(sql, A.conn);
  assert.equal(s.quarantined, 1);
  assert.ok(!upstream.ackCalls.includes("rev-conflict"), "conflicting revision never acked");
  const [q] = await sql`
    SELECT import_status, ack_status, mapping_error FROM guesthub.channel_booking_revisions
    WHERE provider_revision_id = 'rev-conflict'`;
  assert.equal(q.import_status, "quarantined");
  assert.equal(q.ack_status, "unacknowledged");
  assert.ok(q.mapping_error.includes("התנגשות"), "visible conflict reason");
  assert.equal(await bookingRes(A.conn.id, "book-3"), null, "no reservation for the conflicting booking");
  const [untouched] = await sql`SELECT status FROM guesthub.reservations WHERE id = ${localRes.id}`;
  assert.equal(untouched.status, "confirmed");
  ok("local conflict → durable visible quarantine; existing local stay never overwritten; no ack");
  upstream.revisions = upstream.revisions.filter((r) => r.id !== "rev-conflict");
  await sql`DELETE FROM guesthub.channel_booking_revisions WHERE provider_revision_id = 'rev-conflict'`;

  // ---- 7. unmapped room → quarantine, then imports once mapped ----
  upstream.ackCalls.length = 0;
  upstream.revisions.push({ id: "rev-unmapped", acked: false, attributes: mkRevision({ id: "rev-unmapped", booking_id: "book-4", unique_id: "BDC-TEST-4", room: { room_type_id: "crt-new", rate_plan_id: null, checkin_date: "2026-11-01", checkout_date: "2026-11-02", days: {}, amount: "150" } }) });
  s = await runInboundPull(sql, A.conn);
  assert.equal(s.quarantined, 1);
  assert.ok(!upstream.ackCalls.includes("rev-unmapped"), "unmapped revision never acked");
  assert.equal(await bookingRes(A.conn.id, "book-4"), null, "no guessed room, no reservation");
  const [room3] = await sql`
    INSERT INTO guesthub.rooms (tenant_id, room_number, name, status, is_active)
    VALUES (${A.tenantId}, '1239-a', 'חדר בדיקה 3', 'available', true) RETURNING id`;
  await sql`
    INSERT INTO guesthub.channel_room_mappings
      (tenant_id, connection_id, channex_property_id, room_id, room_number,
       channex_room_type_id, status, method)
    VALUES (${A.tenantId}, ${A.conn.id}, 'prop-A', ${room3.id}, '1239-a', 'crt-new', 'mapped', 'created')`;
  s = await runInboundPull(sql, A.conn);
  assert.equal(s.imported, 1);
  const rescued = await bookingRes(A.conn.id, "book-4");
  assert.ok(rescued, "quarantined revision imports after the mapping is fixed");
  ok("unmapped room → visible quarantine (no guessed room); imports cleanly once mapped");

  // ---- 8. wrong property → rejected ----
  const wrong = await persistBookingRevision(sql, {
    tenantId: A.tenantId, connectionId: A.conn.id,
    providerBookingId: "book-5", providerRevisionId: "rev-wrongprop",
    revisionKind: "new",
    payload: mkRevision({ id: "rev-wrongprop", booking_id: "book-5", property_id: "prop-EVIL" }),
  });
  const outcome = await importRevisionRow(sql, A.conn, wrong.id);
  assert.equal(outcome.status, "quarantined");
  assert.equal(await bookingRes(A.conn.id, "book-5"), null);
  const [wr] = await sql`
    SELECT import_status, ack_status FROM guesthub.channel_booking_revisions WHERE id = ${wrong.id}`;
  assert.equal(wr.import_status, "quarantined");
  assert.equal(wr.ack_status, "unacknowledged");
  ok("a revision for another property is rejected — quarantined, never imported, never acked");

  // ---- 9. MODIFIED updates the SAME reservation, atomically moving the stay ----
  upstream.revisions.push({ id: "rev-mod-1", acked: false, attributes: mkRevision({
    id: "rev-mod-1", status: "modified", booking_id: "book-1", unique_id: "BDC-TEST-1",
    amount: "400.00",
    arrival_date: "2026-08-12", departure_date: "2026-08-14",
    occupancy: { adults: 3, children: 1, infants: 0, ages: [] },
    room: { room_type_id: "crt-2", rate_plan_id: null, checkin_date: "2026-08-12", checkout_date: "2026-08-14", days: { "2026-08-12": "200", "2026-08-13": "200" }, amount: "400.00", occupancy: { adults: 3, children: 1, infants: 0 } },
  }) });
  s = await runInboundPull(sql, A.conn);
  assert.equal(s.held, 1, `date/room modification must be HELD for approval: ${JSON.stringify(s)}`);
  // BEFORE approval: nothing applied — reservation, rooms and calendar keep the old stay
  let modified = await bookingRes(A.conn.id, "book-1");
  assert.equal(d10(modified.check_in), "2026-08-10", "calendar keeps the old dates before approval");
  assert.equal(d10(modified.check_out), "2026-08-11");
  assert.equal(Number(modified.total_price), 263.72, "amount untouched before approval");
  const stillOld = await availability(A.tenantId, A.roomId, "2026-08-10", "2026-08-11");
  assert.equal(stillOld.length, 1, "old range still occupied before approval");
  const modReview = await reviewFor(A.conn.id, "rev-mod-1");
  assert.ok(modReview, "one pending review created");
  assert.equal(modReview.apply_status, "pending_approval");
  assert.equal(d10(modReview.old_check_in), "2026-08-10");
  assert.equal(d10(modReview.new_check_in), "2026-08-12");
  assert.equal(d10(modReview.new_check_out), "2026-08-14");
  // the held revision is durably ours (revision + review) — acked upstream
  assert.ok(upstream.ackCalls.includes("rev-mod-1"), "held revision acked after commit");
  const [heldRev] = await sql`
    SELECT import_status FROM guesthub.channel_booking_revisions
    WHERE connection_id = ${A.conn.id} AND provider_revision_id = 'rev-mod-1'`;
  assert.equal(heldRev.import_status, "awaiting_approval");
  // APPROVE → the whole revision applies atomically
  const modDecision = await approveRev(A.tenantId, A.conn.id, "rev-mod-1");
  assert.equal(modDecision.ok, true, `approve failed: ${JSON.stringify(modDecision)}`);
  modified = await bookingRes(A.conn.id, "book-1");
  assert.equal(modified.id, created.id, "same reservation updated — never a second one");
  assert.equal(d10(modified.check_in), "2026-08-12");
  assert.equal(d10(modified.check_out), "2026-08-14");
  assert.equal(Number(modified.total_price), 400);
  assert.equal(modified.adults, 3);
  assert.equal(modified.external_revision_id, "rev-mod-1");
  const rrMod = await sql`
    SELECT * FROM guesthub.reservation_rooms WHERE reservation_id = ${created.id}`;
  assert.equal(rrMod.length, 1);
  assert.equal(rrMod[0].room_id, A.room2Id, "moved to the newly mapped physical room");
  const freed = await availability(A.tenantId, A.roomId, "2026-08-10", "2026-08-11");
  assert.equal(freed.length, 0, "old room/dates released after approval");
  const consumed = await availability(A.tenantId, A.room2Id, "2026-08-12", "2026-08-14");
  assert.equal(consumed.length, 1, "new room/dates consumed after approval");
  const [modReviewAfter] = await sql`
    SELECT apply_status, decided_at FROM guesthub.channel_external_changes WHERE id = ${modReview.id}`;
  assert.equal(modReviewAfter.apply_status, "applied");
  assert.ok(modReviewAfter.decided_at, "decision timestamp recorded");
  // book-1 + book-2 + local L-9001 + rescued book-4 — and NOT a second book-1
  assert.equal(await resCount(A.tenantId), 4);
  ok("MODIFIED (dates+room) → HELD pending review, old stay untouched; APPROVAL applies atomically, old released, new consumed");

  // ---- 10. CANCELLED cancels the SAME reservation and releases the room ----
  upstream.revisions.push({ id: "rev-cancel-1", acked: false, attributes: mkRevision({
    id: "rev-cancel-1", status: "cancelled", booking_id: "book-1", unique_id: "BDC-TEST-1",
    arrival_date: "2026-08-12", departure_date: "2026-08-14",
    room: { checkin_date: "2026-08-12", checkout_date: "2026-08-14", days: {}, amount: "400.00" },
  }) });
  s = await runInboundPull(sql, A.conn);
  assert.equal(s.imported, 1);
  const cancelled = await bookingRes(A.conn.id, "book-1");
  assert.equal(cancelled.id, created.id, "cancellation hits the same reservation");
  assert.equal(cancelled.status, "cancelled");
  const released = await availability(A.tenantId, A.room2Id, "2026-08-12", "2026-08-14");
  assert.equal(released.length, 0, "cancellation released the room");
  const rrKept = await sql`
    SELECT COUNT(*)::int AS c FROM guesthub.reservation_rooms WHERE reservation_id = ${created.id}`;
  assert.equal(rrKept[0].c, 1, "reservation_rooms history preserved — never deleted");
  assert.equal(await resCount(A.tenantId), 4, "no new reservation at any lifecycle stage");
  ok("CANCELLED → same reservation cancelled (never deleted); room released; identifiers preserved");

  // ---- 11. valid-PAN channel card → encrypted, attached, CVV gone ----
  upstream.revisions.push({ id: "rev-realcard", acked: false, attributes: mkRevision({
    id: "rev-realcard", booking_id: "book-6", unique_id: "BDC-TEST-6",
    guarantee: { card_number: "4111111111111111", card_type: "visa", cardholder_name: "Ronen Meshulam", expiration_date: "09/2031", is_virtual: false, cvv: "123" },
    room: { checkin_date: "2026-12-01", checkout_date: "2026-12-02", days: {}, amount: "180" },
  }) });
  s = await runInboundPull(sql, A.conn);
  assert.equal(s.imported, 1);
  const cardRes = await bookingRes(A.conn.id, "book-6");
  const [card] = await sql`
    SELECT * FROM guesthub.reservation_cards WHERE reservation_id = ${cardRes.id}`;
  assert.ok(card, "real channel PAN attached to the reservation");
  assert.equal(card.last4, "1111");
  assert.equal(decryptPan(card.pan_encrypted), "4111111111111111");
  const [rcRev] = await sql`
    SELECT payload, card_meta FROM guesthub.channel_booking_revisions
    WHERE provider_revision_id = 'rev-realcard'`;
  assert.ok(!JSON.stringify(rcRev.payload).includes("4111111111111111"), "PAN never in stored payload");
  assert.ok(!JSON.stringify(rcRev.card_meta ?? {}).includes("123"), "CVV never staged");
  assert.ok(!JSON.stringify(rcRev.payload).includes('"123"'), "CVV never in stored payload");
  ok("valid channel PAN → encrypted at rest + attached; CVV discarded everywhere");

  // ---- 12. tenant isolation ----
  upstream.revisions.push({ id: "rev-b1", acked: false, attributes: mkRevision({
    id: "rev-b1", booking_id: "book-b1", property_id: "prop-B", unique_id: "BDC-B-1",
    room: { room_type_id: "crt-B", rate_plan_id: null, checkin_date: "2026-08-10", checkout_date: "2026-08-11", days: {}, amount: "90" },
  }) });
  const beforeA = await resCount(A.tenantId);
  s = await runInboundPull(sql, B.conn);
  assert.equal(s.imported, 1);
  const bRes = await bookingRes(B.conn.id, "book-b1");
  assert.equal(bRes.tenant_id, B.tenantId);
  assert.equal(await resCount(A.tenantId), beforeA, "tenant A untouched by tenant B's pull");
  ok("tenant isolation — a pull imports only into its own connection's tenant");

  // ---- 13. missed-webhook fallback: the worker loop enqueues the pull itself ----
  await sql`DELETE FROM guesthub.channel_sync_jobs WHERE job_type = 'pull_booking_revisions'`;
  const conns = await loadInboundConnections(sql);
  assert.ok(conns.some((c) => c.id === A.conn.id), "connection is inbound-eligible");
  await workerMod.runTick("check-worker-1", () => {});
  const jobs = await sql`
    SELECT status FROM guesthub.channel_sync_jobs
    WHERE connection_id = ${A.conn.id} AND job_type = 'pull_booking_revisions'`;
  assert.ok(jobs.length >= 1, "fallback poll enqueued a pull job with no webhook at all");
  // drain until the job completes (the tick that enqueued it may also claim it)
  for (let i = 0; i < 3 && !(await sql`
    SELECT 1 FROM guesthub.channel_sync_jobs
    WHERE connection_id = ${A.conn.id} AND job_type = 'pull_booking_revisions' AND status = 'succeeded'`).length; i++) {
    await workerMod.runTick("check-worker-1", () => {});
  }
  const [done] = await sql`
    SELECT status FROM guesthub.channel_sync_jobs
    WHERE connection_id = ${A.conn.id} AND job_type = 'pull_booking_revisions'
    ORDER BY created_at DESC LIMIT 1`;
  assert.equal(done.status, "succeeded");
  const jobCountAfter = (await sql`
    SELECT COUNT(*)::int AS c FROM guesthub.channel_sync_jobs
    WHERE connection_id = ${A.conn.id} AND job_type = 'pull_booking_revisions'`)[0].c;
  await workerMod.runTick("check-worker-1", () => {});
  const jobCountAgain = (await sql`
    SELECT COUNT(*)::int AS c FROM guesthub.channel_sync_jobs
    WHERE connection_id = ${A.conn.id} AND job_type = 'pull_booking_revisions'`)[0].c;
  assert.equal(jobCountAgain, jobCountAfter, "no second pull job inside the poll window");
  ok("missed webhook cannot lose a booking — worker fallback poll enqueues the same idempotent job, deduped");

  // ---- 14. worker retry on transient feed failure ----
  upstream.feedFail = true;
  await sql`
    UPDATE guesthub.channel_sync_jobs SET status = 'cancelled'
    WHERE job_type = 'pull_booking_revisions' AND status IN ('queued','retry_wait')`;
  const enq = await sql`
    INSERT INTO guesthub.channel_sync_jobs
      (tenant_id, connection_id, job_type, status, priority, idempotency_key)
    VALUES (${A.tenantId}, ${A.conn.id}, 'pull_booking_revisions', 'queued', 40, 'retry-check')
    RETURNING id`;
  await workerMod.runTick("check-worker-2", () => {});
  let [job] = await sql`SELECT status, attempts FROM guesthub.channel_sync_jobs WHERE id = ${enq[0].id}`;
  assert.equal(job.status, "retry_wait", "transient feed failure → bounded retry, not a loss");
  upstream.feedFail = false;
  await sql`UPDATE guesthub.channel_sync_jobs SET next_attempt_at = now() WHERE id = ${enq[0].id}`;
  await workerMod.runTick("check-worker-2", () => {});
  [job] = await sql`SELECT status FROM guesthub.channel_sync_jobs WHERE id = ${enq[0].id}`;
  assert.equal(job.status, "succeeded");
  ok("worker retry — a failed pull retries with backoff and succeeds without duplicates");

  // ---- 15. repeated execution end-to-end is duplicate-free ----
  const finalA = await resCount(A.tenantId);
  await runInboundPull(sql, A.conn);
  await runInboundPull(sql, A.conn);
  assert.equal(await resCount(A.tenantId), finalA);
  const [dupCheck] = await sql`
    SELECT COUNT(*)::int AS c FROM (
      SELECT external_booking_id FROM guesthub.reservations
      WHERE tenant_id = ${A.tenantId} AND external_booking_id IS NOT NULL
      GROUP BY channel_connection_id, external_booking_id HAVING COUNT(*) > 1) d`;
  assert.equal(dupCheck.c, 0, "no external booking maps to two reservations");
  ok("repeated worker execution creates no duplicate reservation (DB-unique external identity)");

  // ---- 16. unknown external Rate Plan: quarantine → verified adoption → import ----
  // (regression for BDC-6784772338: the owner's channel mapping in the Channex
  //  UI referenced a rate-plan UUID GuestHub never created)
  const ackCallsBefore = () => upstream.ackCalls.filter((x) => x === "rev-ghost-1").length;
  upstream.revisions.push({
    id: "rev-ghost-1", acked: false,
    attributes: mkRevision({
      id: "rev-ghost-1", booking_id: "book-ghost", unique_id: "BDC-GHOST-1",
      ota_reservation_code: "999777",
      arrival_date: "2026-11-10", departure_date: "2026-11-12",
      room: { room_type_id: "crt-2", rate_plan_id: "crp-ghost",
              checkin_date: "2026-11-10", checkout_date: "2026-11-12",
              days: { "2026-11-10": "130", "2026-11-11": "133.72" } },
    }),
  });
  // (a) plan unknown locally AND upstream GET 404s → quarantined, never acked
  let s16 = await runInboundPull(sql, A.conn);
  assert.equal(s16.quarantined, 1);
  let [ghostRev] = await sql`
    SELECT import_status, ack_status, mapping_error FROM guesthub.channel_booking_revisions
    WHERE connection_id = ${A.conn.id} AND provider_revision_id = 'rev-ghost-1'`;
  assert.equal(ghostRev.import_status, "quarantined");
  assert.equal(ghostRev.ack_status, "unacknowledged");
  assert.ok(ghostRev.mapping_error.includes("ללא מיפוי מקומי"), "exact quarantine reason recorded");
  assert.equal(await bookingRes(A.conn.id, "book-ghost"), null, "nothing imported");
  assert.equal(ackCallsBefore(), 0, "no ack while quarantined");
  ok("unknown external rate plan quarantines first (no upstream evidence yet), never acked");

  // (b) upstream serves the plan but under a FOREIGN property → still refused
  upstream.ratePlans["crp-ghost"] = { title: "תוכנית זרה", propertyId: "prop-B", roomTypeId: "crt-2" };
  s16 = await runInboundPull(sql, A.conn);
  assert.equal(s16.quarantined, 1);
  const aliasForeign = await sql`
    SELECT * FROM guesthub.channel_inbound_rate_plan_aliases WHERE connection_id = ${A.conn.id}`;
  assert.equal(aliasForeign.length, 0, "foreign-property plan is never adopted");
  assert.equal(ackCallsBefore(), 0);
  ok("ownership check — a rate plan of another property is never adopted");

  // (c) upstream now proves the UUID chain (our property + the booking's room
  //     type) → adopted as alias, imported to the mapped physical room, acked
  //     ONLY after the committed import
  upstream.ratePlans["crp-ghost"] = { title: "עותק ממופה בערוץ", propertyId: "prop-A", roomTypeId: "crt-2" };
  s16 = await runInboundPull(sql, A.conn);
  assert.equal(s16.imported, 1);
  const ghost = await bookingRes(A.conn.id, "book-ghost");
  assert.ok(ghost, "reservation imported after reconciliation");
  const ghostRooms = await sql`
    SELECT room_id, check_in, check_out, rate_plan_id FROM guesthub.reservation_rooms
    WHERE reservation_id = ${ghost.id}`;
  assert.equal(ghostRooms.length, 1);
  assert.equal(ghostRooms[0].room_id, A.room2Id, "allocated to the UUID-proven physical room");
  assert.equal(d10(ghostRooms[0].check_in), "2026-11-10");
  assert.equal(d10(ghostRooms[0].check_out), "2026-11-12");
  assert.equal(ghostRooms[0].rate_plan_id, null, "no local plan claimed without evidence");
  const [alias] = await sql`
    SELECT * FROM guesthub.channel_inbound_rate_plan_aliases
    WHERE connection_id = ${A.conn.id} AND channex_rate_plan_id = 'crp-ghost'`;
  assert.ok(alias, "alias adopted");
  assert.equal(alias.room_id, A.room2Id);
  assert.equal(alias.local_rate_plan_id, null);
  assert.equal(alias.channex_property_id, "prop-A");
  assert.equal(alias.channex_room_type_id, "crt-2");
  [ghostRev] = await sql`
    SELECT import_status, ack_status FROM guesthub.channel_booking_revisions
    WHERE connection_id = ${A.conn.id} AND provider_revision_id = 'rev-ghost-1'`;
  assert.equal(ghostRev.import_status, "imported");
  assert.equal(ghostRev.ack_status, "acknowledged");
  assert.equal(ackCallsBefore(), 1, "acked exactly once, only after commit");
  ok("verified adoption — exact UUID alias imports the booking to the right room and acks after commit");

  // (d) idempotent retry: repeated pulls re-import nothing, adopt nothing new
  const aliasCount = () =>
    sql`SELECT COUNT(*)::int AS c FROM guesthub.channel_inbound_rate_plan_aliases
        WHERE connection_id = ${A.conn.id}`.then((r) => r[0].c);
  const cBefore = await aliasCount();
  const resBefore16 = await resCount(A.tenantId);
  await runInboundPull(sql, A.conn);
  await runInboundPull(sql, A.conn);
  assert.equal(await resCount(A.tenantId), resBefore16);
  assert.equal(await aliasCount(), cBefore);
  assert.equal(ackCallsBefore(), 1, "no further acks");
  ok("idempotent retry — repeated pulls create zero duplicate reservations/aliases/acks");

  // (e) title-disambiguated local plan INSIDE a UUID-proven room: when the
  //     verified plan's title equals exactly one canonical mapping of that
  //     room, the alias carries its local plan; the reservation records it
  await sql`
    UPDATE guesthub.channel_room_rate_mappings
    SET channex_title = 'תוכנית בדיקה A' WHERE connection_id = ${A.conn.id} AND room_id = ${A.roomId}`;
  upstream.ratePlans["crp-ghost-2"] = { title: "תוכנית בדיקה A", propertyId: "prop-A", roomTypeId: "crt-1" };
  upstream.revisions.push({
    id: "rev-ghost-2", acked: false,
    attributes: mkRevision({
      id: "rev-ghost-2", booking_id: "book-ghost-2", unique_id: "BDC-GHOST-2",
      ota_reservation_code: "999778",
      arrival_date: "2026-11-20", departure_date: "2026-11-21",
      room: { room_type_id: "crt-1", rate_plan_id: "crp-ghost-2",
              checkin_date: "2026-11-20", checkout_date: "2026-11-21",
              days: { "2026-11-20": "263.72" } },
    }),
  });
  s16 = await runInboundPull(sql, A.conn);
  assert.equal(s16.imported, 1);
  const ghost2 = await bookingRes(A.conn.id, "book-ghost-2");
  const g2rooms = await sql`
    SELECT room_id, rate_plan_id FROM guesthub.reservation_rooms WHERE reservation_id = ${ghost2.id}`;
  assert.equal(g2rooms[0].room_id, A.roomId);
  assert.equal(g2rooms[0].rate_plan_id, A.planId, "local plan attached via in-room title disambiguation");
  ok("in-room title disambiguation attaches the canonical local plan (never across rooms)");

  // ---- 17. OTA number + expected arrival time + notes independence (D80) ----
  // arrival_hour lands in the DEDICATED expected_arrival_time column; notes
  // stay verbatim (digits inside notes are NEVER mined as a PIN/arrival time);
  // GuestHub's own reservation_number stays separate from the OTA code.
  upstream.revisions.push({
    id: "rev-arr-1", acked: false,
    attributes: mkRevision({
      id: "rev-arr-1", booking_id: "book-arr", unique_id: "BDC-ARR-1",
      ota_reservation_code: "6784999111",
      arrival_hour: "14:30",
      notes: "אורח מגיע ברכב, קוד דלת 1234 נשאר בהערות",
      customer: {
        name: "דוד", surname: "גואטה", mail: "d@example.com", phone: "+972520000001",
        country: "IL", language: "he", address: "David Elazar 10", city: "Haifa", zip: "3508107",
      },
      arrival_date: "2027-01-05", departure_date: "2027-01-06",
      room: { checkin_date: "2027-01-05", checkout_date: "2027-01-06",
              days: { "2027-01-05": "263.72" } },
    }),
  });
  let s17 = await runInboundPull(sql, A.conn);
  assert.equal(s17.imported, 1, `first arr import failed: ${JSON.stringify(s17)}`);
  let arrRes = await bookingRes(A.conn.id, "book-arr");
  assert.equal(String(arrRes.expected_arrival_time), "14:30:00", "arrival_hour → dedicated expected_arrival_time");
  assert.equal(arrRes.notes, "אורח מגיע ברכב, קוד דלת 1234 נשאר בהערות", "guest notes verbatim — nothing appended/extracted");
  assert.equal(arrRes.ota_reservation_code, "6784999111", "OTA reservation number stored");
  assert.notEqual(arrRes.reservation_number, arrRes.ota_reservation_code, "GuestHub number stays separate from the OTA code");
  assert.match(arrRes.reservation_number, /^\d+$/, "internal GuestHub number still allocated locally");
  const [arrGuest] = await sql`
    SELECT city, address FROM guesthub.guests WHERE id = ${arrRes.primary_guest_id}`;
  assert.equal(arrGuest.city, "Haifa", "guest city imported");
  assert.ok(arrGuest.address.includes("David Elazar 10"), "guest address imported");
  ok("NEW → OTA code stored separately; arrival time in its own field; notes untouched; guest address/city kept");

  // modified revision with a NEW arrival hour updates the same reservation
  upstream.revisions.push({
    id: "rev-arr-2", acked: false,
    attributes: mkRevision({
      id: "rev-arr-2", status: "modified", booking_id: "book-arr", unique_id: "BDC-ARR-1",
      ota_reservation_code: "6784999111", arrival_hour: "16:00",
      notes: "אורח מגיע ברכב, קוד דלת 1234 נשאר בהערות",
      arrival_date: "2027-01-05", departure_date: "2027-01-06",
      room: { checkin_date: "2027-01-05", checkout_date: "2027-01-06",
              days: { "2027-01-05": "263.72" } },
    }),
  });
  const resBefore17 = await resCount(A.tenantId);
  s17 = await runInboundPull(sql, A.conn);
  assert.equal(s17.imported, 1);
  assert.equal(await resCount(A.tenantId), resBefore17, "modification never duplicates the reservation");
  arrRes = await bookingRes(A.conn.id, "book-arr");
  assert.equal(String(arrRes.expected_arrival_time), "16:00:00", "modified arrival_hour updates the field");
  ok("MODIFIED with new arrival_hour → same reservation, arrival time updated");

  // a later revision OMITTING arrival_hour must NOT erase the stored value
  const noHour = mkRevision({
    id: "rev-arr-3", status: "modified", booking_id: "book-arr", unique_id: "BDC-ARR-1",
    ota_reservation_code: "6784999111",
    notes: "הערה עודכנה — עדיין בלי שעת הגעה",
    arrival_date: "2027-01-05", departure_date: "2027-01-06",
    room: { checkin_date: "2027-01-05", checkout_date: "2027-01-06",
            days: { "2027-01-05": "263.72" } },
  });
  delete noHour.arrival_hour;
  upstream.revisions.push({ id: "rev-arr-3", acked: false, attributes: noHour });
  s17 = await runInboundPull(sql, A.conn);
  assert.equal(s17.imported, 1);
  arrRes = await bookingRes(A.conn.id, "book-arr");
  assert.equal(String(arrRes.expected_arrival_time), "16:00:00", "omitted arrival_hour never erases the stored value");
  assert.equal(arrRes.notes, "הערה עודכנה — עדיין בלי שעת הגעה", "notes update independently of arrival time");
  ok("omitted arrival_hour preserves the stored value; notes stay independent");

  // pure normalization honesty: malformed hour dropped; no PIN is fabricated
  const { normalizeBookingRevision } = req(join(out, "lib/channel/booking-normalize.js"));
  const badHour = normalizeBookingRevision(mkRevision({ id: "x", arrival_hour: "25:99" }));
  assert.equal(badHour.ok, true);
  assert.equal(badHour.value.arrivalHour, null, "malformed arrival_hour dropped, never guessed");
  const normed = normalizeBookingRevision(mkRevision({ id: "y", notes: "PIN 9876 in notes" }));
  assert.ok(!("pin" in normed.value) && !("secret" in normed.value),
    "no PIN/secret field is fabricated — Channex supplies no dedicated field");
  assert.equal(normed.value.notes, "PIN 9876 in notes", "digits in notes stay in notes");
  ok("no dedicated channel PIN field → none invented; malformed hours dropped");

  // ---- 18. OTA cancellation terms → the at-booking snapshot (034) ----
  // rooms[].meta.cancel_penalties / .policies are preserved VERBATIM as the
  // reservation's cancellation_policy_snapshot (source 'ota'); arrival_hour
  // provenance is recorded as 'ota'; a later revision without terms/hour never
  // erases either (snapshot = the booking's own contract, not live state).
  upstream.revisions.push({
    id: "rev-pol-1", acked: false,
    attributes: mkRevision({
      id: "rev-pol-1", booking_id: "book-pol", unique_id: "BDC-POL-1",
      arrival_hour: "21:00",
      arrival_date: "2027-02-01", departure_date: "2027-02-02",
      room: {
        checkin_date: "2027-02-01", checkout_date: "2027-02-02",
        days: { "2027-02-01": "263.72" },
        meta: {
          cancel_penalties: [{ from: "2027-01-27T00:00:00", amount: "263.72", currency: "GBP" }],
          policies: "Cancellation Policy: The guest can cancel free of charge until 5 days before arrival.",
        },
      },
    }),
  });
  let s18 = await runInboundPull(sql, A.conn);
  assert.equal(s18.imported, 1, `policy import failed: ${JSON.stringify(s18)}`);
  let polRes = await bookingRes(A.conn.id, "book-pol");
  assert.equal(polRes.expected_arrival_time_source, "ota", "imported arrival_hour marks provenance 'ota'");
  const snap = polRes.cancellation_policy_snapshot;
  assert.ok(snap, "OTA terms captured as the at-booking cancellation snapshot");
  assert.equal(snap.source, "ota", "snapshot source is the OTA contract");
  assert.equal(snap.ota.cancel_penalties[0].amount, "263.72", "penalty schedule preserved verbatim");
  assert.match(snap.ota.policies_text, /free of charge until 5 days/, "policy text preserved verbatim");
  const noTerms = mkRevision({
    id: "rev-pol-2", status: "modified", booking_id: "book-pol", unique_id: "BDC-POL-1",
    arrival_date: "2027-02-01", departure_date: "2027-02-02",
    room: { checkin_date: "2027-02-01", checkout_date: "2027-02-02", days: { "2027-02-01": "263.72" } },
  });
  delete noTerms.arrival_hour;
  upstream.revisions.push({ id: "rev-pol-2", acked: false, attributes: noTerms });
  s18 = await runInboundPull(sql, A.conn);
  assert.equal(s18.imported, 1);
  polRes = await bookingRes(A.conn.id, "book-pol");
  assert.equal(polRes.cancellation_policy_snapshot?.source, "ota", "snapshot survives a terms-less modification");
  assert.equal(polRes.expected_arrival_time_source, "ota", "arrival provenance survives an hour-less modification");
  assert.equal(String(polRes.expected_arrival_time), "21:00:00", "arrival time itself also preserved");
  ok("OTA cancellation terms → at-booking snapshot (source 'ota'); never erased by later revisions");

  // ---- 19. external date-change notifications (D82) ----
  // a MODIFIED revision with changed dates → the reservation AND its
  // reservation_rooms move atomically, and exactly ONE reconcilable
  // notification exists per external revision — redelivery adds nothing.
  upstream.revisions.push({ id: "rev-ec-1", acked: false, attributes: mkRevision({
    id: "rev-ec-1", booking_id: "book-ec", unique_id: "BDC-EC-1", ota_reservation_code: "777000111",
    arrival_date: "2027-03-10", departure_date: "2027-03-12",
    room: { checkin_date: "2027-03-10", checkout_date: "2027-03-12", days: {}, amount: "300" },
  }) });
  let sEC = await runInboundPull(sql, A.conn);
  assert.equal(sEC.imported, 1);
  const ecCountFor = async (revId) => (await sql`
    SELECT COUNT(*)::int AS c FROM guesthub.channel_external_changes
    WHERE connection_id = ${A.conn.id} AND provider_revision_id = ${revId}`)[0].c;
  assert.equal(await ecCountFor("rev-ec-1"), 0, "a NEW booking creates no external-change notification");

  upstream.revisions.push({ id: "rev-ec-2", acked: false, attributes: mkRevision({
    id: "rev-ec-2", status: "modified", booking_id: "book-ec", unique_id: "BDC-EC-1",
    ota_reservation_code: "777000111", inserted_at: "2027-01-01T10:00:00",
    arrival_date: "2027-03-15", departure_date: "2027-03-18", amount: "450",
    room: { checkin_date: "2027-03-15", checkout_date: "2027-03-18", days: {}, amount: "450" },
  }) });
  sEC = await runInboundPull(sql, A.conn);
  assert.equal(sEC.held, 1, `both-dates modification must be HELD: ${JSON.stringify(sEC)}`);
  // BEFORE approval: reservation, rooms and calendar all keep the old stay
  let ecRes = await bookingRes(A.conn.id, "book-ec");
  assert.equal(d10(ecRes.check_in), "2027-03-10", "reservation keeps old dates before approval");
  assert.equal(d10(ecRes.check_out), "2027-03-12");
  let ecRR = await sql`
    SELECT check_in, check_out FROM guesthub.reservation_rooms WHERE reservation_id = ${ecRes.id}`;
  assert.equal(d10(ecRR[0].check_in), "2027-03-10", "reservation_rooms keep old dates before approval");
  assert.equal((await availability(A.tenantId, A.roomId, "2027-03-10", "2027-03-12")).length, 1,
    "calendar still occupies the OLD range before approval");
  assert.equal((await availability(A.tenantId, A.roomId, "2027-03-15", "2027-03-18")).length, 0,
    "proposed range NOT occupied before approval");
  const ecRow = await reviewFor(A.conn.id, "rev-ec-2");
  assert.ok(ecRow, "ONE pending review created");
  assert.equal(ecRow.apply_status, "pending_approval");
  assert.equal(ecRow.status, "pending", "visible after refresh — persisted, not client state");
  assert.equal(d10(ecRow.old_check_in), "2027-03-10");
  assert.equal(d10(ecRow.old_check_out), "2027-03-12");
  assert.equal(d10(ecRow.new_check_in), "2027-03-15");
  assert.equal(d10(ecRow.new_check_out), "2027-03-18");
  assert.equal(ecRow.ota_reservation_code, "777000111");
  assert.ok(ecRow.reservation_number, "GuestHub reservation number on the review");
  assert.ok(ecRow.room_labels.length > 0, "affected room recorded");
  assert.equal(ecRow.email_status, "skipped", "no recipient configured → email honestly skipped, not faked");
  ok("MODIFIED (both dates) → ONE persisted pending review (old/new dates, numbers, room); nothing applied");

  // duplicate webhook delivery while the review is pending: no second review,
  // no mutation, no email re-arm
  upstream.revisions.find((r) => r.id === "rev-ec-2").acked = false;
  sEC = await runInboundPull(sql, A.conn);
  assert.equal(sEC.held, 1, "redelivered held revision recognized as held, nothing recreated");
  assert.equal(await ecCountFor("rev-ec-2"), 1, "redelivery never duplicates the review");
  ecRes = await bookingRes(A.conn.id, "book-ec");
  assert.equal(d10(ecRes.check_in), "2027-03-10", "still untouched");
  assert.equal((await reviewFor(A.conn.id, "rev-ec-2")).email_status, "skipped", "redelivery never re-arms the email");
  ok("duplicate delivery while pending → one review, zero mutations");

  // APPROVE: server-side transaction applies reservation + rooms + calendar
  const ecDecision = await approveExternalChange(sql, A.tenantId, ecRow.id, null);
  assert.equal(ecDecision.ok, true, `approve failed: ${JSON.stringify(ecDecision)}`);
  ecRes = await bookingRes(A.conn.id, "book-ec");
  assert.equal(d10(ecRes.check_in), "2027-03-15", "approval applies the new dates");
  assert.equal(d10(ecRes.check_out), "2027-03-18");
  ecRR = await sql`
    SELECT check_in, check_out FROM guesthub.reservation_rooms WHERE reservation_id = ${ecRes.id}`;
  assert.equal(ecRR.length, 1);
  assert.equal(d10(ecRR[0].check_in), "2027-03-15", "reservation_rooms updated atomically on approval");
  assert.equal((await availability(A.tenantId, A.roomId, "2027-03-10", "2027-03-12")).length, 0,
    "old calendar range released immediately after approval");
  assert.equal((await availability(A.tenantId, A.roomId, "2027-03-15", "2027-03-18")).length, 1,
    "new calendar range occupied immediately after approval");
  const ecApplied = await reviewFor(A.conn.id, "rev-ec-2");
  assert.equal(ecApplied.apply_status, "applied");
  assert.ok(ecApplied.decided_at, "approval user/timestamp recorded");
  const [ecAudit] = await sql`
    SELECT after_data FROM guesthub.audit_logs
    WHERE tenant_id = ${A.tenantId} AND action = 'external_change_approved'
    ORDER BY created_at DESC LIMIT 1`;
  assert.equal(ecAudit.after_data.old_check_in, "2027-03-10", "audit holds the old dates");
  assert.equal(ecAudit.after_data.new_check_in, "2027-03-15", "audit holds the new dates");
  ok("APPROVAL → transactional: dates + reservation_rooms + calendar + audit(old/new), decision recorded");

  // reprocessing the SAME revision after approval is idempotent
  upstream.revisions.find((r) => r.id === "rev-ec-2").acked = false;
  sEC = await runInboundPull(sql, A.conn);
  assert.equal(sEC.alreadyImported, 1, "approved revision reprocessed → already, no second mutation");
  assert.equal(await ecCountFor("rev-ec-2"), 1);
  assert.equal((await bookingRes(A.conn.id, "book-ec")).external_revision_id, "rev-ec-2");
  // approving an already-decided review is refused
  const ecAgain = await approveExternalChange(sql, A.tenantId, ecRow.id, null);
  assert.equal(ecAgain.ok, false, "double-approve refused");
  ok("reprocessing after approval → idempotent; double-approve refused");

  // changed CHECK-IN only → one review; REJECTION preserves the dates and the
  // exact revision is terminally rejected
  upstream.revisions.push({ id: "rev-ec-ci", acked: false, attributes: mkRevision({
    id: "rev-ec-ci", status: "modified", booking_id: "book-ec", unique_id: "BDC-EC-1",
    ota_reservation_code: "777000111", inserted_at: "2027-01-01T11:00:00",
    arrival_date: "2027-03-16", departure_date: "2027-03-18", amount: "450",
    room: { checkin_date: "2027-03-16", checkout_date: "2027-03-18", days: {}, amount: "450" },
  }) });
  sEC = await runInboundPull(sql, A.conn);
  assert.equal(sEC.held, 1, "check-in-only change creates a review");
  const ciReview = await reviewFor(A.conn.id, "rev-ec-ci");
  assert.equal(d10(ciReview.new_check_in), "2027-03-16");
  assert.equal(d10(ciReview.new_check_out), "2027-03-18", "check-out unchanged in the proposal");
  const ciDecision = await rejectExternalChange(sql, A.tenantId, ciReview.id, null);
  assert.equal(ciDecision.ok, true);
  ecRes = await bookingRes(A.conn.id, "book-ec");
  assert.equal(d10(ecRes.check_in), "2027-03-15", "rejection preserves the current dates");
  const [ciRev] = await sql`
    SELECT import_status FROM guesthub.channel_booking_revisions
    WHERE connection_id = ${A.conn.id} AND provider_revision_id = 'rev-ec-ci'`;
  assert.equal(ciRev.import_status, "rejected", "the exact revision is marked rejected");
  const ciAfter = await reviewFor(A.conn.id, "rev-ec-ci");
  assert.equal(ciAfter.apply_status, "rejected");
  assert.ok(ciAfter.decided_at, "rejection timestamp recorded");
  // duplicate delivery of the REJECTED revision recreates nothing
  upstream.revisions.find((r) => r.id === "rev-ec-ci").acked = false;
  sEC = await runInboundPull(sql, A.conn);
  assert.equal(await ecCountFor("rev-ec-ci"), 1, "rejected revision redelivered → no new review");
  assert.equal(d10((await bookingRes(A.conn.id, "book-ec")).check_in), "2027-03-15", "still rejected, still unchanged");
  // approving a rejected review is refused
  assert.equal((await approveExternalChange(sql, A.tenantId, ciReview.id, null)).ok, false);
  ok("check-in-only → review; REJECTION keeps dates, marks the revision rejected, survives redelivery");

  // changed CHECK-OUT only → one review (then rejected to keep state stable)
  upstream.revisions.push({ id: "rev-ec-co", acked: false, attributes: mkRevision({
    id: "rev-ec-co", status: "modified", booking_id: "book-ec", unique_id: "BDC-EC-1",
    ota_reservation_code: "777000111", inserted_at: "2027-01-01T12:00:00",
    arrival_date: "2027-03-15", departure_date: "2027-03-19", amount: "600",
    room: { checkin_date: "2027-03-15", checkout_date: "2027-03-19", days: {}, amount: "600" },
  }) });
  sEC = await runInboundPull(sql, A.conn);
  assert.equal(sEC.held, 1, "check-out-only change creates a review");
  const coReview = await reviewFor(A.conn.id, "rev-ec-co");
  assert.equal(d10(coReview.new_check_in), "2027-03-15", "check-in unchanged in the proposal");
  assert.equal(d10(coReview.new_check_out), "2027-03-19");
  assert.equal((await rejectExternalChange(sql, A.tenantId, coReview.id, null)).ok, true);
  ok("check-out-only → review created and shown correctly");

  // an OLDER revision (by channel timestamp) can never overwrite the newer
  // approved state — processed as stale, no review, no mutation
  upstream.revisions.push({ id: "rev-ec-old", acked: false, attributes: mkRevision({
    id: "rev-ec-old", status: "modified", booking_id: "book-ec", unique_id: "BDC-EC-1",
    ota_reservation_code: "777000111", inserted_at: "2026-12-31T09:00:00",
    arrival_date: "2027-03-11", departure_date: "2027-03-13", amount: "300",
    room: { checkin_date: "2027-03-11", checkout_date: "2027-03-13", days: {}, amount: "300" },
  }) });
  sEC = await runInboundPull(sql, A.conn);
  assert.equal(sEC.imported, 1, "stale revision processed (recorded), never held");
  assert.equal(await ecCountFor("rev-ec-old"), 0, "no review for an out-of-order older revision");
  ecRes = await bookingRes(A.conn.id, "book-ec");
  assert.equal(d10(ecRes.check_in), "2027-03-15", "older revision cannot overwrite the approved dates");
  assert.equal(ecRes.external_revision_id, "rev-ec-2", "applied revision pointer untouched");
  ok("older revision after a newer approved one → stale no-op: no review, no overwrite");

  // arrival-hour-only modification (same dates) → NO review, applied directly
  upstream.revisions.push({ id: "rev-ec-hour", acked: false, attributes: mkRevision({
    id: "rev-ec-hour", status: "modified", booking_id: "book-ec", unique_id: "BDC-EC-1",
    ota_reservation_code: "777000111", inserted_at: "2027-01-01T13:00:00", arrival_hour: "17:45",
    arrival_date: "2027-03-15", departure_date: "2027-03-18", amount: "450",
    room: { checkin_date: "2027-03-15", checkout_date: "2027-03-18", days: {}, amount: "450" },
  }) });
  sEC = await runInboundPull(sql, A.conn);
  assert.equal(sEC.imported, 1, "hour-only change imports directly");
  assert.equal(await ecCountFor("rev-ec-hour"), 0, "no date review for an arrival-hour-only change");
  ecRes = await bookingRes(A.conn.id, "book-ec");
  assert.equal(String(ecRes.expected_arrival_time), "17:45:00", "metadata-only change applied");
  assert.equal(d10(ecRes.check_in), "2027-03-15", "dates untouched");
  ok("arrival-hour-only modification → no review, metadata applied normally");

  // recipient configured but no mail provider → terminal 'failed' with an
  // honest reason; the review itself still exists and is pending
  await sql`
    UPDATE guesthub.tenants
    SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{ops_notification_email}', '"ops@example.com"'::jsonb)
    WHERE id = ${A.tenantId}`;
  upstream.revisions.push({ id: "rev-ec-3", acked: false, attributes: mkRevision({
    id: "rev-ec-3", status: "modified", booking_id: "book-ec", unique_id: "BDC-EC-1",
    ota_reservation_code: "777000111", inserted_at: "2027-01-01T14:00:00",
    arrival_date: "2027-03-25", departure_date: "2027-03-27", amount: "450",
    room: { checkin_date: "2027-03-25", checkout_date: "2027-03-27", days: {}, amount: "450" },
  }) });
  sEC = await runInboundPull(sql, A.conn);
  assert.equal(sEC.held, 1);
  const [ecRow3] = await sql`
    SELECT email_status, email_detail FROM guesthub.channel_external_changes
    WHERE connection_id = ${A.conn.id} AND provider_revision_id = 'rev-ec-3'`;
  assert.equal(ecRow3.email_status, "failed");
  assert.ok(ecRow3.email_detail.includes("Gmail"), "honest provider-not-configured reason");
  ok("recipient set but Gmail unconfigured → review email honestly 'failed', never silently dropped");

  // a NEWER pending proposal supersedes the earlier undecided one — at most
  // ONE pending review per reservation, history retained
  const [blocker] = await sql`
    INSERT INTO guesthub.reservations
      (tenant_id, reservation_number, status, check_in, check_out, total_price, balance)
    VALUES (${A.tenantId}, 'L-9002', 'confirmed', '2027-04-01', '2027-04-03', 500, 500)
    RETURNING id`;
  await sql`
    INSERT INTO guesthub.reservation_rooms
      (tenant_id, reservation_id, room_id, check_in, check_out, adults, rate_per_night, price_total)
    VALUES (${A.tenantId}, ${blocker.id}, ${A.roomId}, '2027-04-01', '2027-04-03', 2, 250, 500)`;
  upstream.revisions.push({ id: "rev-ec-4", acked: false, attributes: mkRevision({
    id: "rev-ec-4", status: "modified", booking_id: "book-ec", unique_id: "BDC-EC-1",
    ota_reservation_code: "777000111", inserted_at: "2027-01-01T15:00:00",
    arrival_date: "2027-04-02", departure_date: "2027-04-04", amount: "450",
    room: { checkin_date: "2027-04-02", checkout_date: "2027-04-04", days: {}, amount: "450" },
  }) });
  sEC = await runInboundPull(sql, A.conn);
  assert.equal(sEC.held, 1, "a CONFLICTING proposal is still a reviewable request");
  const ec3Superseded = await reviewFor(A.conn.id, "rev-ec-3");
  assert.equal(ec3Superseded.apply_status, "superseded", "earlier undecided proposal superseded by the newer one");
  assert.equal((await approveExternalChange(sql, A.tenantId, ec3Superseded.id, null)).ok, false,
    "a superseded review can no longer be approved");
  const conflictRow = await reviewFor(A.conn.id, "rev-ec-4");
  assert.equal(conflictRow.apply_status, "pending_approval");
  assert.equal(d10(conflictRow.old_check_in), "2027-03-15", "current dates shown");
  assert.equal(d10(conflictRow.new_check_in), "2027-04-02", "the OTA's proposed dates never silently ignored");
  // APPROVAL of the conflicting range is BLOCKED — clear reason, zero partial
  // changes, review stays pending for manual handling
  const conflictDecision = await approveExternalChange(sql, A.tenantId, conflictRow.id, null);
  assert.equal(conflictDecision.ok, false, "conflicting approval blocked");
  assert.ok(conflictDecision.error.includes("התנגשות"), "clear Hebrew conflict reason");
  const ecAfterConflict = await bookingRes(A.conn.id, "book-ec");
  assert.equal(d10(ecAfterConflict.check_in), "2027-03-15", "no partial change — dates untouched");
  const rrAfterConflict = await sql`
    SELECT check_in FROM guesthub.reservation_rooms WHERE reservation_id = ${ecAfterConflict.id}`;
  assert.equal(d10(rrAfterConflict[0].check_in), "2027-03-15", "reservation_rooms untouched");
  assert.equal((await reviewFor(A.conn.id, "rev-ec-4")).apply_status, "pending_approval",
    "review remains pending for manual handling");
  ok("conflicting proposal → held review; approval BLOCKED with a clear reason, zero partial changes");

  // ---- 20. normalize-failure is PERSISTED quarantine, never silent loss ----
  // (the staging feed stops serving a revision after ~30 minutes — an
  // unpersisted one would be gone for good; D82 root-cause fix)
  upstream.ackCalls.length = 0;
  const broken = mkRevision({
    id: "rev-ec-broken", booking_id: "book-broken", unique_id: "BDC-BROKEN-1",
    ota_reservation_code: "777000999",
    room: { room_type_id: null, rate_plan_id: null, checkin_date: "2027-05-01", checkout_date: "2027-05-02", days: {}, amount: "100" },
  });
  upstream.revisions.push({ id: "rev-ec-broken", acked: false, attributes: broken });
  sEC = await runInboundPull(sql, A.conn);
  // rev-ec-4 legitimately remains in the feed (quarantined = never acked), so
  // the summary counts it again — assert the broken revision itself instead
  assert.ok(sEC.quarantined >= 1, "normalize failure counts as quarantine, not a dropped log line");
  const [brokenRow] = await sql`
    SELECT import_status, ack_status, mapping_error, ota_reservation_code
    FROM guesthub.channel_booking_revisions
    WHERE connection_id = ${A.conn.id} AND provider_revision_id = 'rev-ec-broken'`;
  assert.ok(brokenRow, "normalize-failed revision is PERSISTED — survives feed expiry");
  assert.equal(brokenRow.import_status, "quarantined");
  assert.equal(brokenRow.ack_status, "unacknowledged");
  assert.ok(!upstream.ackCalls.includes("rev-ec-broken"), "never acknowledged upstream");
  assert.ok(brokenRow.mapping_error.includes("Room Type"), "visible normalize reason");
  assert.equal(brokenRow.ota_reservation_code, "777000999", "identity retained for recovery");
  assert.equal(await bookingRes(A.conn.id, "book-broken"), null, "no half-imported reservation");
  ok("normalize-failed revision → persisted visible quarantine (identity kept), never acked, never lost");
  // ---- 19. OTA cancellation terms → the at-booking snapshot (034) ----
  // rooms[].meta.cancel_penalties / .policies are preserved VERBATIM as the
  // reservation's cancellation_policy_snapshot (source 'ota'); arrival_hour
  // provenance is recorded as 'ota'; a later revision without terms/hour never
  // erases either (snapshot = the booking's own contract, not live state).
  upstream.revisions.push({
    id: "rev-pol-1", acked: false,
    attributes: mkRevision({
      id: "rev-pol-1", booking_id: "book-pol", unique_id: "BDC-POL-1",
      arrival_hour: "21:00",
      arrival_date: "2027-02-01", departure_date: "2027-02-02",
      room: {
        checkin_date: "2027-02-01", checkout_date: "2027-02-02",
        days: { "2027-02-01": "263.72" },
        meta: {
          cancel_penalties: [{ from: "2027-01-27T00:00:00", amount: "263.72", currency: "GBP" }],
          policies: "Cancellation Policy: The guest can cancel free of charge until 5 days before arrival.",
        },
      },
    }),
  });
  let s18 = await runInboundPull(sql, A.conn);
  assert.equal(s18.imported, 1, `policy import failed: ${JSON.stringify(s18)}`);
  let polRes = await bookingRes(A.conn.id, "book-pol");
  assert.equal(polRes.expected_arrival_time_source, "ota", "imported arrival_hour marks provenance 'ota'");
  const snap = polRes.cancellation_policy_snapshot;
  assert.ok(snap, "OTA terms captured as the at-booking cancellation snapshot");
  assert.equal(snap.source, "ota", "snapshot source is the OTA contract");
  assert.equal(snap.ota.cancel_penalties[0].amount, "263.72", "penalty schedule preserved verbatim");
  assert.match(snap.ota.policies_text, /free of charge until 5 days/, "policy text preserved verbatim");
  const noTerms = mkRevision({
    id: "rev-pol-2", status: "modified", booking_id: "book-pol", unique_id: "BDC-POL-1",
    arrival_date: "2027-02-01", departure_date: "2027-02-02",
    room: { checkin_date: "2027-02-01", checkout_date: "2027-02-02", days: { "2027-02-01": "263.72" } },
  });
  delete noTerms.arrival_hour;
  upstream.revisions.push({ id: "rev-pol-2", acked: false, attributes: noTerms });
  s18 = await runInboundPull(sql, A.conn);
  assert.equal(s18.imported, 1);
  polRes = await bookingRes(A.conn.id, "book-pol");
  assert.equal(polRes.cancellation_policy_snapshot?.source, "ota", "snapshot survives a terms-less modification");
  assert.equal(polRes.expected_arrival_time_source, "ota", "arrival provenance survives an hour-less modification");
  assert.equal(String(polRes.expected_arrival_time), "21:00:00", "arrival time itself also preserved");
  ok("OTA cancellation terms → at-booking snapshot (source 'ota'); never erased by later revisions");

  // ---- 21. MIXED modified revision: dates + arrival_hour + cancellation
  // terms + masked card + guest metadata, all in ONE revision ----
  upstream.revisions.push({ id: "rev-mix-1", acked: false, attributes: mkRevision({
    id: "rev-mix-1", booking_id: "book-mix", unique_id: "BDC-MIX-1", ota_reservation_code: "888000111",
    arrival_hour: "15:00",
    arrival_date: "2027-06-01", departure_date: "2027-06-03",
    room: { checkin_date: "2027-06-01", checkout_date: "2027-06-03", days: {}, amount: "600",
      meta: { cancel_penalties: [{ from: "2027-05-25T00:00:00", amount: "600", currency: "GBP" }],
              policies: "Free cancellation until 7 days before arrival." } },
  }) });
  let sMix = await runInboundPull(sql, A.conn);
  assert.equal(sMix.imported, 1, `mix seed import failed: ${JSON.stringify(sMix)}`);
  let mixRes = await bookingRes(A.conn.id, "book-mix");
  const atBookingSnap = JSON.stringify(mixRes.cancellation_policy_snapshot);
  assert.equal(mixRes.cancellation_policy_snapshot?.source, "ota");
  const cardsOf = async (resId) => (await sql`
    SELECT COUNT(*)::int AS c FROM guesthub.reservation_cards WHERE reservation_id = ${resId}`)[0].c;
  const paymentsOf = async (resId) => (await sql`
    SELECT COUNT(*)::int AS c FROM guesthub.payments WHERE reservation_id = ${resId}`)[0].c;

  // the mixed modification: new dates AND new hour AND (different) terms AND a
  // new masked card AND a changed guest phone — one revision
  upstream.revisions.push({ id: "rev-mix-2", acked: false, attributes: mkRevision({
    id: "rev-mix-2", status: "modified", booking_id: "book-mix", unique_id: "BDC-MIX-1",
    ota_reservation_code: "888000111", arrival_hour: "18:00",
    arrival_date: "2027-06-05", departure_date: "2027-06-08", amount: "900",
    customer: { name: "Ronen", surname: "Meshulam", mail: "guest@example.com",
                phone: "+972521111111", country: "IL", language: "en-us" },
    guarantee: { card_number: "411111******1111", card_type: "VI", cardholder_name: "Ronen Meshulam",
                 expiration_date: "01/2030", is_virtual: false, cvv: "***", token: null },
    room: { checkin_date: "2027-06-05", checkout_date: "2027-06-08", days: {}, amount: "900",
      meta: { cancel_penalties: [{ from: "2027-06-01T00:00:00", amount: "900", currency: "GBP" }],
              policies: "LATER, DIFFERENT terms — must NOT replace the at-booking snapshot." } },
  }) });
  sMix = await runInboundPull(sql, A.conn);
  assert.equal(sMix.held, 1, "mixed date+metadata revision is HELD");
  // ATOMIC CHOICE (documented): while the review is pending, NOTHING from the
  // revision applies — not the dates, not the metadata, not the card
  mixRes = await bookingRes(A.conn.id, "book-mix");
  assert.equal(d10(mixRes.check_in), "2027-06-01", "dates untouched while pending");
  assert.equal(String(mixRes.expected_arrival_time), "15:00:00", "metadata untouched while pending");
  const [mixGuestPending] = await sql`SELECT phone FROM guesthub.guests WHERE id = ${mixRes.primary_guest_id}`;
  assert.equal(mixGuestPending.phone, "+972520000000", "guest metadata untouched while pending");
  const mixChanges = await sql`
    SELECT * FROM guesthub.channel_external_changes
    WHERE connection_id = ${A.conn.id} AND provider_revision_id = 'rev-mix-2'`;
  assert.equal(mixChanges.length, 1, "exactly ONE review for the mixed revision");
  assert.equal(mixChanges[0].apply_status, "pending_approval");
  assert.notEqual(mixChanges[0].email_status, "pending", "one email decision was made");
  // APPROVE → the whole revision applies atomically
  assert.equal((await approveExternalChange(sql, A.tenantId, mixChanges[0].id, null)).ok, true);
  mixRes = await bookingRes(A.conn.id, "book-mix");
  assert.equal(d10(mixRes.check_in), "2027-06-05", "mixed revision: dates applied on approval");
  assert.equal(d10(mixRes.check_out), "2027-06-08");
  const mixRR = await sql`
    SELECT check_in, check_out FROM guesthub.reservation_rooms WHERE reservation_id = ${mixRes.id}`;
  assert.equal(mixRR.length, 1);
  assert.equal(d10(mixRR[0].check_in), "2027-06-05", "reservation_rooms moved atomically");
  assert.equal(String(mixRes.expected_arrival_time), "18:00:00", "mixed revision: arrival hour applied");
  assert.equal(mixRes.expected_arrival_time_source, "ota", "arrival provenance stays 'ota'");
  assert.equal(JSON.stringify(mixRes.cancellation_policy_snapshot), atBookingSnap,
    "cancellation snapshot = the AT-BOOKING contract; a later revision's terms never replace it");
  assert.equal(await cardsOf(mixRes.id), 0, "masked card stays metadata-only — never a chargeable card row");
  assert.equal(Number(mixRes.paid_amount), 0, "payment ledger untouched by the modification");
  assert.equal(await paymentsOf(mixRes.id), 0, "no payment row fabricated");
  const [mixGuest] = await sql`SELECT phone FROM guesthub.guests WHERE id = ${mixRes.primary_guest_id}`;
  assert.equal(mixGuest.phone, "+972521111111", "guest metadata applied by the same approval");
  ok("MIXED revision → held all-or-nothing; APPROVAL applies dates+metadata atomically, snapshot immutable, ledger untouched");

  // a later terms-less, hour-less revision erases nothing
  const mixBare = mkRevision({
    id: "rev-mix-3", status: "modified", booking_id: "book-mix", unique_id: "BDC-MIX-1",
    ota_reservation_code: "888000111",
    arrival_date: "2027-06-05", departure_date: "2027-06-08", amount: "900",
    room: { checkin_date: "2027-06-05", checkout_date: "2027-06-08", days: {}, amount: "900" },
  });
  delete mixBare.arrival_hour;
  upstream.revisions.push({ id: "rev-mix-3", acked: false, attributes: mixBare });
  sMix = await runInboundPull(sql, A.conn);
  assert.equal(sMix.imported, 1);
  mixRes = await bookingRes(A.conn.id, "book-mix");
  assert.equal(String(mixRes.expected_arrival_time), "18:00:00", "omitted hour never erases");
  assert.equal(JSON.stringify(mixRes.cancellation_policy_snapshot), atBookingSnap, "omitted terms never erase");
  assert.equal(await ecCountFor("rev-mix-3"), 0, "unchanged dates → no date-change notification");
  ok("terms-less/hour-less follow-up erases nothing; unchanged dates create no notification");

  // conflicting MIXED modification: NOTHING is applied — not the dates and not
  // the metadata (all-or-nothing: applyLiveRevision never ran). The revision
  // stays persisted + quarantined; the conflict is a visible unresolved change.
  const [mixBlocker] = await sql`
    INSERT INTO guesthub.reservations
      (tenant_id, reservation_number, status, check_in, check_out, total_price, balance)
    VALUES (${A.tenantId}, 'L-9003', 'confirmed', '2027-06-10', '2027-06-12', 500, 500)
    RETURNING id`;
  await sql`
    INSERT INTO guesthub.reservation_rooms
      (tenant_id, reservation_id, room_id, check_in, check_out, adults, rate_per_night, price_total)
    VALUES (${A.tenantId}, ${mixBlocker.id}, ${A.roomId}, '2027-06-10', '2027-06-12', 2, 250, 500)`;
  upstream.revisions.push({ id: "rev-mix-4", acked: false, attributes: mkRevision({
    id: "rev-mix-4", status: "modified", booking_id: "book-mix", unique_id: "BDC-MIX-1",
    ota_reservation_code: "888000111", arrival_hour: "20:00",
    arrival_date: "2027-06-10", departure_date: "2027-06-12", amount: "900",
    customer: { name: "Ronen", surname: "Meshulam", mail: "guest@example.com",
                phone: "+972529999999", country: "IL", language: "en-us" },
    room: { checkin_date: "2027-06-10", checkout_date: "2027-06-12", days: {}, amount: "900" },
  }) });
  sMix = await runInboundPull(sql, A.conn);
  assert.equal(sMix.held, 1, "conflicting mixed proposal is still a reviewable request");
  mixRes = await bookingRes(A.conn.id, "book-mix");
  assert.equal(d10(mixRes.check_in), "2027-06-05", "held → dates untouched");
  assert.equal(String(mixRes.expected_arrival_time), "18:00:00", "held → arrival hour untouched (no partial metadata)");
  const [mixGuest2] = await sql`SELECT phone FROM guesthub.guests WHERE id = ${mixRes.primary_guest_id}`;
  // rev-mix-3 (default customer) last set the phone; the point is the
  // CONFLICTING revision's phone was never applied — all-or-nothing
  assert.notEqual(mixGuest2.phone, "+972529999999", "held → guest metadata untouched (all-or-nothing)");
  assert.equal(mixGuest2.phone, "+972520000000", "pre-conflict value preserved");
  const mixConflictRow = await reviewFor(A.conn.id, "rev-mix-4");
  assert.equal(mixConflictRow?.apply_status, "pending_approval", "visible review with the OTA's proposed dates");
  assert.equal(d10(mixConflictRow?.new_check_in), "2027-06-10");
  // approval of the conflicting mixed proposal is BLOCKED — nothing partial
  const mixDecision = await approveExternalChange(sql, A.tenantId, mixConflictRow.id, null);
  assert.equal(mixDecision.ok, false, "conflicting mixed approval blocked");
  assert.ok(mixDecision.error.includes("התנגשות"), "clear Hebrew conflict reason");
  mixRes = await bookingRes(A.conn.id, "book-mix");
  assert.equal(d10(mixRes.check_in), "2027-06-05", "blocked approval → dates still untouched");
  assert.equal(String(mixRes.expected_arrival_time), "18:00:00", "blocked approval → metadata still untouched");
  const [mixQRow] = await sql`
    SELECT import_status FROM guesthub.channel_booking_revisions
    WHERE connection_id = ${A.conn.id} AND provider_revision_id = 'rev-mix-4'`;
  assert.equal(mixQRow.import_status, "awaiting_approval", "full inbound revision persisted, still pending");
  ok("conflicting MIXED proposal → held all-or-nothing; approval blocked, zero partial changes, review stays pending");

  // ---- 22. email retry (D83): failed/skipped are retryable; sent is final ----
  // configure a REAL (fake-upstream) Gmail provider through the platform's own
  // encrypted-secrets path — exactly what the operator does in the UI
  process.env.MESSAGING_SECRETS_ENCRYPTION_KEY = "inbound-check-messaging-key-not-production";
  const { encryptSecretBag } = req(join(out, "lib/messaging/secrets.js"));
  const { retryExternalChangeEmail } = req(join(out, "lib/channel/external-changes.js"));
  await sql`
    INSERT INTO guesthub.messaging_provider_connections
      (tenant_id, provider, config, secret_ciphertext, status)
    VALUES (${A.tenantId}, 'gmail',
            ${sql.json({ mode: "oauth", senderEmail: "hotel@example.com", senderName: "GuestHub" })},
            ${encryptSecretBag({ clientId: "cid", clientSecret: "cs", refreshToken: "rt" })},
            'connected')`;

  // rev-ec-3's email honestly FAILED (provider was missing) — retry now sends
  const changeIdOf = async (revId) => (await sql`
    SELECT id FROM guesthub.channel_external_changes
    WHERE connection_id = ${A.conn.id} AND provider_revision_id = ${revId}`)[0].id;
  const ec3Id = await changeIdOf("rev-ec-3");
  let retry = await retryExternalChangeEmail(sql, A.tenantId, ec3Id);
  assert.equal(retry.ok, true, `retry failed: ${JSON.stringify(retry)}`);
  assert.equal(retry.emailStatus, "sent");
  assert.equal(upstream.gmailSends, 1, "exactly one real send");
  const [ec3Row] = await sql`
    SELECT email_status, outbound_message_id FROM guesthub.channel_external_changes WHERE id = ${ec3Id}`;
  assert.equal(ec3Row.email_status, "sent");
  const [om3] = await sql`
    SELECT status, to_address, subject, provider_message_id, submitted_at
    FROM guesthub.outbound_messages WHERE id = ${ec3Row.outbound_message_id}`;
  assert.equal(om3.status, "sent");
  assert.equal(om3.to_address, "ops@example.com", "recipient from the canonical tenant setting");
  assert.match(om3.subject, /שינוי תאריכים התקבל מ-/, "required subject");
  assert.ok(om3.provider_message_id, "provider message id recorded");
  assert.ok(om3.submitted_at, "sent timestamp recorded");
  const sentBody = upstream.gmailBodies[0];
  assert.match(sentBody, /Ronen Meshulam/, "guest name in the email");
  assert.ok(sentBody.includes("777000111"), "OTA number in the email");
  ok("failed email → explicit retry sends ONE real email (recipient/subject/guest/ids verified)");

  // 'sent' is final: a second retry is refused, nothing is sent again
  retry = await retryExternalChangeEmail(sql, A.tenantId, ec3Id);
  assert.equal(retry.ok, false, "retry of a sent email refused");
  assert.match(retry.error, /כבר נשלח/);
  assert.equal(upstream.gmailSends, 1, "no second logical email for the same revision");
  // redelivery of the underlying revision cannot re-arm the email either
  upstream.revisions.find((r) => r.id === "rev-ec-3").acked = false;
  sEC = await runInboundPull(sql, A.conn);
  assert.equal(upstream.gmailSends, 1, "webhook redelivery never resends");
  const [ec3After] = await sql`SELECT email_status FROM guesthub.channel_external_changes WHERE id = ${ec3Id}`;
  assert.equal(ec3After.email_status, "sent");
  ok("'sent' is terminal — retry refused, redelivery resends nothing");

  // 'skipped' (missing configuration at the time) is retryable the same way
  const ec2Id = await changeIdOf("rev-ec-2");
  const [ec2Before] = await sql`SELECT email_status FROM guesthub.channel_external_changes WHERE id = ${ec2Id}`;
  assert.equal(ec2Before.email_status, "skipped");
  retry = await retryExternalChangeEmail(sql, A.tenantId, ec2Id);
  assert.equal(retry.ok, true);
  assert.equal(retry.emailStatus, "sent");
  assert.equal(upstream.gmailSends, 2);
  ok("'skipped because configuration was missing' → retryable; sends once after configuration");

  // with the provider configured, a NEW external change emails automatically
  upstream.revisions.push({ id: "rev-ec-5", acked: false, attributes: mkRevision({
    id: "rev-ec-5", status: "modified", booking_id: "book-ec", unique_id: "BDC-EC-1",
    ota_reservation_code: "777000111", inserted_at: "2027-01-01T16:00:00",
    arrival_date: "2027-04-20", departure_date: "2027-04-22", amount: "450",
    room: { checkin_date: "2027-04-20", checkout_date: "2027-04-22", days: {}, amount: "450" },
  }) });
  sEC = await runInboundPull(sql, A.conn);
  assert.equal(sEC.held, 1, "new proposal held for approval");
  const [ec5Row] = await sql`
    SELECT email_status FROM guesthub.channel_external_changes
    WHERE connection_id = ${A.conn.id} AND provider_revision_id = 'rev-ec-5'`;
  assert.equal(ec5Row.email_status, "sent", "configured provider → automatic dispatch sends");
  assert.equal(upstream.gmailSends, 3);
  const autoBody = upstream.gmailBodies[2];
  assert.match(autoBody, /הפרש לילות/, "nights difference in the email");
  ok("configured provider → the pipeline itself sends exactly one email per new change");

  console.log(`\nall ${n} inbound-booking checks passed`);
} finally {
  try {
    if (A) await sql`DELETE FROM guesthub.tenants WHERE id = ${A.tenantId}`;
    if (B) await sql`DELETE FROM guesthub.tenants WHERE id = ${B.tenantId}`;
  } catch (e) {
    console.error("cleanup failed:", e?.message);
  }
  await sql.end({ timeout: 5 });
}
