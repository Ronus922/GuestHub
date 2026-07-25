#!/usr/bin/env node
// check:booking-com-reports — the Booking.com status-report path, end to end.
//
// WHY. POST /channels/booking is a REAL WRITE TO BOOKING.COM: an operator click
// tells the OTA "this card is invalid" / "cancel this booking" / "the guest did
// not show up". None of those can be taken back. So every claim this feature
// makes has to be provable WITHOUT ever issuing a live request:
//   · the wire payload is exactly the documented shape — an ARRAY of
//     {bookingId:<integer>, action:<one of three enum values>} and NOTHING else
//     (no invented waivedFees field: apiV2.yaml has no such field),
//   · every attempt lands in booking_channel_reports — success AND failure,
//   · a foreign tenant cannot report on another tenant's reservation,
//   · "cancel due invalid card" is impossible without a prior SUCCESSFUL
//     invalid-card report, and burns no credit when refused,
//   · the soft time windows refuse before the network, not after,
//   · ZERO card data exists on this path — not in the request, not in the
//     stored response, not in the source.
//
// The guards run for real: the CORE module is compiled by tsconfig.check.json
// (which inherits the worker config's "no next/react" constraint) and driven
// against the disposable test DB (:5433) with a faked Beds24 in front of it.
//
// Usage: node scripts/check-booking-com-reports.mjs
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
process.env.CHANNEL_SECRETS_KEY = "check-booking-com-reports-key";

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };
const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// ============================================================
// PART 1 — static: the wire contract, the permission gate, the card line
// ============================================================
{
  const client = read("src/lib/channel/beds24-booking-reports.ts");

  // the endpoint, and only this endpoint
  assert.match(client, /path: "\/channels\/booking"/, "the client posts to /channels/booking");
  assert.match(client, /method: "POST"/, "…with POST");

  // the body: an ARRAY of exactly {bookingId, action}
  assert.match(
    client,
    /body: \[\{ bookingId: numericId, action: WIRE_ACTION\[args\.action\] \}\]/,
    "the body is an ARRAY of exactly { bookingId, action } — no extra field",
  );
  // bookingId is an INTEGER on the wire even though the local column is text
  assert.match(client, /Number\.isSafeInteger\(numericId\)/, "bookingId is proven integer before the call");

  // the enum, verbatim, all three and only three
  for (const wire of ["reportInvalidCard", "reportNoShow", "reportCancel"]) {
    assert.ok(client.includes(`"${wire}"`), `the wire enum contains ${wire}`);
  }
  const wireMap = client.match(/const WIRE_ACTION[\s\S]*?\};/)[0];
  // the declaration mentions each wire name twice (type annotation + value), so
  // dedupe: what matters is that NO fourth action name has crept in
  assert.equal(
    [...new Set(wireMap.match(/report[A-Z][A-Za-z]*/g) ?? [])].sort().join(","),
    "reportCancel,reportInvalidCard,reportNoShow",
    "the local→wire map contains exactly the three documented actions and no fourth",
  );
  assert.match(wireMap, /cancel_due_invalid_card: "reportCancel"/,
    "the local name cancel_due_invalid_card maps to the wire action reportCancel");
  ok("static: the wire contract is the documented one (array, integer bookingId, three-value enum)");

  // THE CONTRACT GAP: waivedFees does not exist in apiV2.yaml, so it must not
  // exist on the wire. It may exist as a LOCAL ledger column and as a UI label.
  const wireGraph = [
    "src/lib/channel/beds24-booking-reports.ts",
    "src/lib/channel/booking-com-report-rules.ts",
  ];
  for (const f of wireGraph) {
    assert.ok(
      !/waivedFees|waiveFees/.test(read(f)),
      `${f} never mentions an undocumented waivedFees field`,
    );
  }
  ok("static: no invented waivedFees/waiveFees field anywhere on the wire path");
}

{
  const actions = read("src/lib/channel/booking-com-reports.ts");
  assert.match(actions, /^"use server";/m, "the actions module is a server-action module");
  assert.match(
    actions,
    /requirePermission\(actor, "reservations\.channel_report"\)/,
    "one server-side permission gate, shared by all three actions",
  );
  assert.match(actions, /const actor = await getActor\(\);/, "a valid session is required");
  // the gate must come BEFORE any work
  const gateAt = actions.indexOf('requirePermission(actor, "reservations.channel_report")');
  const workAt = actions.indexOf("await submitBookingComReport(");
  assert.ok(workAt > 0, "the actions module actually calls the core");
  assert.ok(gateAt > 0 && gateAt < workAt, "permission is checked BEFORE the report is submitted");
  for (const fn of ["reportInvalidCard", "cancelDueInvalidCard", "reportNoShow"]) {
    assert.match(actions, new RegExp(`export async function ${fn}\\(`), `${fn} is exported`);
  }
  ok("static: session + reservations.channel_report gate all three actions, before any work");

  // ---- the card line (D41/D87): zero card data on this path ----
  const CARDLESS = [
    "src/lib/channel/booking-com-reports.ts",
    "src/lib/channel/booking-com-reports-core.ts",
    "src/lib/channel/beds24-booking-reports.ts",
    "src/lib/channel/booking-com-report-rules.ts",
    "src/components/reservations/BookingComReports.tsx",
  ];
  const CARD_DATA = /reservation_cards|pan_encrypted|\bpan\b|\bcvv\b|\bcvc\b|last4|exp_month|exp_year|revealCard/i;
  // CODE only: the headers explain the card line in prose, and prose is not a
  // code path. Block comments (incl. JSX {/* … */}) and line comments go first.
  const stripComments = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
      .join("\n");
  for (const f of CARDLESS) {
    for (const line of stripComments(read(f)).split("\n")) {
      // "credit-card" is a Material icon name, not card data
      if (/credit-card|credit_card/.test(line)) continue;
      assert.ok(!CARD_DATA.test(line), `${f} touches no card data: ${line.trim().slice(0, 90)}`);
    }
  }
  ok("static: the whole report path references no card column, no PAN/CVV, no reservation_cards (code, comments stripped)");

  // architectural boundary (check:calendar's rule): the provider HTTP layer must
  // not be dragged into the reservations save path by this feature
  const resActions = read("src/app/(dashboard)/reservations/actions.ts");
  assert.ok(
    !/booking-com-reports|beds24-booking-reports/.test(resActions),
    "reservations/actions.ts does not import the report path (its HTTP boundary is already asserted by check:calendar)",
  );
  ok("static: the feature respects the reservations/actions.ts HTTP boundary");
}

// ---- the migration + manifest ----
{
  const mig = read("db/migrations/055_booking_com_channel_reports.sql");
  assert.match(mig, /CREATE TABLE IF NOT EXISTS guesthub\.booking_channel_reports/, "055 creates the ledger");
  assert.match(
    mig,
    /CHECK \(action IN \('invalid_card', 'cancel_due_invalid_card', 'no_show'\)\)/,
    "the ledger constrains action to the three LOCAL names",
  );
  assert.match(mig, /CHECK \(status IN \('success', 'failed'\)\)/, "status is success|failed");
  assert.match(mig, /'reservations\.channel_report'/, "055 seeds the permission key");
  const manifest = read("db/migrations/manifest.txt");
  assert.ok(
    manifest.split("\n").map((l) => l.trim()).includes("055_booking_com_channel_reports.sql"),
    "055 is listed in manifest.txt (scripts/db/migrate.mjs ABORTS on an unlisted migration)",
  );
  ok("static: migration 055 shape + manifest entry");
}

// ============================================================
// PART 2 — compile the real core graph and require it the worker's own way
// ============================================================
execSync("pnpm exec tsc -p tsconfig.check.json", { stdio: "inherit" });
const OUT = join(ROOT, "dist", "check");
const STUB = join(ROOT, "scripts", "server-only-stub.cjs");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return STUB;
  if (request.startsWith("@/")) return origResolve.call(this, join(OUT, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};
const require2 = createRequire(import.meta.url);
const core = require2(join(OUT, "lib/channel/booking-com-reports-core.js"));
const rules = require2(join(OUT, "lib/channel/booking-com-report-rules.js"));
const { encryptSecret } = require2(join(OUT, "lib/channel/crypto.js"));

// the ledger table must exist on the disposable DB — apply 055 twice, so the
// run never depends on whether the local test DB was already current AND the
// migration's idempotency is proven in passing
for (let i = 0; i < 2; i++) {
  execSync(
    "docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q" +
      " < db/migrations/055_booking_com_channel_reports.sql",
    { stdio: "inherit", shell: "/bin/bash" },
  );
}
ok("migration 055 applies (twice, idempotently) to the disposable DB");

// ============================================================
// PART 3 — the faked Beds24. Records every outbound request so the WIRE
// payload can be asserted, and never lets an unexpected host or path through.
// ============================================================
const posts = [];      // every /channels/booking request body seen
let nextEnvelope = () => [{ success: true, new: 0, modified: 1 }];
let nextStatus = () => 201;

globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  assert.equal(u.host, "api.beds24.com", `unexpected outbound host: ${u.host}`);
  if (u.pathname.endsWith("/authentication/token")) {
    return new Response(JSON.stringify({ token: "fake-access-token", expiresIn: 86400 }), { status: 200 });
  }
  assert.ok(
    u.pathname.endsWith("/channels/booking"),
    `unexpected outbound path: ${u.pathname}`,
  );
  assert.equal(init.method, "POST", "the report is a POST");
  // Beds24 auth scheme: a BARE `token` header, never Authorization: Bearer
  const hdr = init.headers ?? {};
  assert.equal(hdr.token, "fake-access-token", "the bare `token` header carries the access token");
  assert.ok(!("Authorization" in hdr), "no Authorization header is ever sent to Beds24");
  posts.push(JSON.parse(init.body));
  return new Response(JSON.stringify(nextEnvelope()), { status: nextStatus() });
};

const sql = postgres(TEST_URL, { max: 1, prepare: false, onnotice: () => {} });
// Fixture dates are PROPERTY-LOCAL (the scratch tenant is Asia/Jerusalem), because
// that is the clock the windows turn over on. A UTC-based helper would silently
// disagree with the core for the ~3 hours a day the two dates differ.
const PROPERTY_TZ = "Asia/Jerusalem";
const TODAY_LOCAL = new Intl.DateTimeFormat("en-CA", { timeZone: PROPERTY_TZ }).format(new Date());
const day = (offset) => rules.addDaysToDateOnly(TODAY_LOCAL, offset);
const slug = `bcom-reports-${Date.now()}`;
let tenantId;
let otherTenantId;

const ledger = (reservationId) => sql`
  SELECT action, status, waived_fees, response, error_message, created_by
  FROM guesthub.booking_channel_reports
  WHERE reservation_id = ${reservationId}
  ORDER BY created_at, action`;

try {
  // ---- scaffold: two tenants (the second exists ONLY to prove scoping) ----
  const [tenant] = await sql`
    INSERT INTO guesthub.tenants (name, slug, timezone)
    VALUES ('Booking.com Reports Check', ${slug}, 'Asia/Jerusalem') RETURNING id`;
  tenantId = tenant.id;
  const [other] = await sql`
    INSERT INTO guesthub.tenants (name, slug, timezone)
    VALUES ('Foreign Tenant', ${`${slug}-other`}, 'Asia/Jerusalem') RETURNING id`;
  otherTenantId = other.id;

  const [rt] = await sql`
    INSERT INTO guesthub.room_types (tenant_id, name, base_price)
    VALUES (${tenantId}, 'Check Type', 400) RETURNING id`;
  const [conn] = await sql`
    INSERT INTO guesthub.channel_connections
      (tenant_id, provider, environment, state, is_active_provider,
       inbound_sync_enabled, outbound_sync_enabled, full_sync_required,
       api_key_ciphertext, access_token_ciphertext, access_token_expires_at)
    VALUES (${tenantId}, 'beds24', 'production', 'active', true, true, true, false,
            ${encryptSecret("check-refresh-token")}, ${encryptSecret("fake-access-token")},
            now() + interval '12 hours')
    RETURNING id`;
  const [src] = await sql`
    INSERT INTO guesthub.lookup_items (tenant_id, category, key, label)
    VALUES (${tenantId}, 'booking_sources', 'booking_com', 'Booking.com') RETURNING id`;
  const [guest] = await sql`
    INSERT INTO guesthub.guests (tenant_id, first_name, last_name, full_name)
    VALUES (${tenantId}, 'בדיקה', 'אורח', 'בדיקה אורח') RETURNING id`;

  let seq = 0;
  /** a Booking.com reservation with a Beds24 booking id, on its own room
   *  (rr_no_double_booking, migration 037, forbids sharing a room+range) */
  const makeReservation = async (opts = {}) => {
    seq += 1;
    const [room] = await sql`
      INSERT INTO guesthub.rooms (tenant_id, room_number, room_type_id, status, is_active)
      VALUES (${tenantId}, ${`BCR-${seq}`}, ${rt.id}, 'available', true) RETURNING id`;
    const checkIn = opts.checkIn ?? day(5);
    const [r] = await sql`
      INSERT INTO guesthub.reservations
        (tenant_id, reservation_number, primary_guest_id, source_id, status,
         check_in, check_out, total_price, booking_origin,
         channel_connection_id, external_booking_id, ota_name, ota_reservation_code)
      VALUES (${tenantId}, ${`BCR-${seq}`}, ${guest.id},
              ${opts.sourceId === undefined ? src.id : opts.sourceId},
              ${opts.status ?? "confirmed"},
              ${checkIn}, ${opts.checkOut ?? day(7)}, 500, 'ota',
              ${opts.connectionId === undefined ? conn.id : opts.connectionId},
              ${opts.bookingId === undefined ? String(90000000 + seq) : opts.bookingId},
              ${opts.otaName === undefined ? "booking" : opts.otaName},
              ${`ref-${seq}`})
      RETURNING id, external_booking_id, check_in::text AS check_in`;
    await sql`
      INSERT INTO guesthub.reservation_rooms
        (tenant_id, reservation_id, room_id, check_in, check_out, adults, price_total)
      VALUES (${tenantId}, ${r.id}, ${room.id}, ${checkIn}, ${opts.checkOut ?? day(7)}, 2, 500)`;
    return r;
  };

  const submit = (input, deps) =>
    core.submitBookingComReport(
      sql,
      { tenantId, waivedFees: null, actorUserId: null, ...input },
      deps ?? {},
    );

  // ---- 1. the happy path: the exact wire payload + a success ledger row ----
  {
    const r = await makeReservation();
    posts.length = 0;
    const out = await submit({ reservationId: r.id, action: "invalid_card" });
    assert.deepEqual(out, { success: true }, `invalid_card succeeded (got ${JSON.stringify(out)})`);

    assert.equal(posts.length, 1, "exactly ONE request was issued");
    const body = posts[0];
    assert.ok(Array.isArray(body), "the wire body is an ARRAY");
    assert.equal(body.length, 1, "one booking per call — never a batch the operator did not intend");
    assert.deepEqual(
      Object.keys(body[0]).sort(),
      ["action", "bookingId"],
      `the wire object has EXACTLY bookingId+action (got ${JSON.stringify(body[0])})`,
    );
    assert.equal(typeof body[0].bookingId, "number", "bookingId is a NUMBER on the wire");
    assert.ok(Number.isInteger(body[0].bookingId), "bookingId is an INTEGER");
    assert.equal(body[0].bookingId, Number(r.external_booking_id), "…and it is THIS booking's id");
    assert.equal(body[0].action, "reportInvalidCard", "the wire action is the documented enum value");
    ok("wire proof: [{bookingId:<int>, action:'reportInvalidCard'}] — exactly two fields");

    const rows = await ledger(r.id);
    assert.equal(rows.length, 1, "one ledger row per attempt");
    assert.equal(rows[0].status, "success");
    assert.equal(rows[0].action, "invalid_card", "the LOCAL action name is what is stored");
    assert.equal(rows[0].error_message, null);
    assert.deepEqual(rows[0].response, { httpStatus: 201, items: [
      { success: true, new: 0, modified: 1, errors: [], warnings: [] },
    ] }, "the stored response is the allow-listed structural extract");
    const [stamped] = await sql`
      SELECT invalid_card_reported_at IS NOT NULL AS s FROM guesthub.reservations WHERE id = ${r.id}`;
    assert.equal(stamped.s, true, "a successful report stamps invalid_card_reported_at");
    ok("success: ledger row (status=success, local action name, extracted response) + reservation stamp");
  }

  // ---- 2. a provider rejection: still ledgered, and NOT stamped ----
  {
    const r = await makeReservation();
    posts.length = 0;
    nextEnvelope = () => [{ success: false, errors: [{ action: "reportInvalidCard", field: "bookingId", message: "not allowed" }] }];
    const out = await submit({ reservationId: r.id, action: "invalid_card" });
    assert.equal(out.success, false, "a success:false envelope is a FAILURE, never a clean success");
    assert.match(out.error, /Booking\.com דחה את הדיווח/, "the operator gets a Hebrew reason");
    const rows = await ledger(r.id);
    assert.equal(rows.length, 1, "the failed attempt is ledgered too");
    assert.equal(rows[0].status, "failed");
    assert.ok(rows[0].error_message.length > 0, "the failure carries error_message");
    assert.equal(rows[0].response.items[0].success, false, "the provider envelope is preserved (extracted)");
    const [stamped] = await sql`
      SELECT invalid_card_reported_at FROM guesthub.reservations WHERE id = ${r.id}`;
    assert.equal(stamped.invalid_card_reported_at, null, "a rejected report NEVER stamps the reservation");
    ok("provider rejection: 2xx-with-errors is a failure — ledgered, Hebrew message, no stamp");
    nextEnvelope = () => [{ success: true, new: 0, modified: 1 }];
  }

  // ---- 2b. an HTTP error: ledgered with the fixed category message ----
  {
    const r = await makeReservation();
    nextStatus = () => 429;
    const out = await submit({ reservationId: r.id, action: "invalid_card" });
    assert.equal(out.success, false);
    assert.match(out.error, /יותר מדי בקשות ל-Beds24/, "the 429 maps to the fixed Hebrew category message");
    const rows = await ledger(r.id);
    assert.equal(rows[0].status, "failed");
    assert.equal(rows[0].response.httpStatus, 429, "the HTTP status is on the ledger row");
    ok("transport failure: HTTP 429 → fixed Hebrew category message + failed ledger row");
    nextStatus = () => 201;
  }

  // ---- 3. tenant scoping: a foreign tenant sees nothing and writes nothing ----
  {
    const r = await makeReservation();
    posts.length = 0;
    const before = (await sql`SELECT count(*)::int AS c FROM guesthub.booking_channel_reports`)[0].c;
    const out = await core.submitBookingComReport(
      sql,
      { tenantId: otherTenantId, reservationId: r.id, action: "invalid_card", waivedFees: null, actorUserId: null },
      {},
    );
    assert.deepEqual(out, { success: false, error: "הזמנה לא נמצאה" },
      "a foreign tenant cannot reach another tenant's reservation");
    assert.equal(posts.length, 0, "no request is issued for a cross-tenant attempt");
    const after = (await sql`SELECT count(*)::int AS c FROM guesthub.booking_channel_reports`)[0].c;
    assert.equal(after, before, "and no ledger row is written under the wrong tenant");
    assert.equal((await ledger(r.id)).length, 0, "the victim reservation's ledger stays empty");
    ok("tenant scoping: cross-tenant attempt refused, no request, no ledger row");
  }

  // ---- 4. cancel REQUIRES a prior SUCCESSFUL invalid_card report ----
  {
    const r = await makeReservation();
    posts.length = 0;
    const denied = await submit({ reservationId: r.id, action: "cancel_due_invalid_card" });
    assert.equal(denied.success, false);
    assert.match(denied.error, /רק לאחר דיווח מוצלח על כרטיס לא תקין/, "the Hebrew reason names the prerequisite");
    assert.equal(posts.length, 0, "the refusal burns NO Beds24 credit — it never reaches the network");
    let rows = await ledger(r.id);
    assert.equal(rows.length, 1, "the refused attempt is still ledgered");
    assert.equal(rows[0].status, "failed");
    assert.equal(rows[0].response, null, "no request was issued, so there is no response to store");

    // a FAILED invalid_card report does not unlock it either
    nextEnvelope = () => [{ success: false, errors: [{ message: "nope" }] }];
    await submit({ reservationId: r.id, action: "invalid_card" });
    nextEnvelope = () => [{ success: true, new: 0, modified: 1 }];
    posts.length = 0;
    const stillDenied = await submit({ reservationId: r.id, action: "cancel_due_invalid_card" });
    assert.equal(stillDenied.success, false, "a FAILED invalid-card report does not unlock the cancel");
    assert.equal(posts.length, 0, "…and still issues no request");

    // now a real, successful invalid_card report
    const okCard = await submit({ reservationId: r.id, action: "invalid_card" });
    assert.equal(okCard.success, true);
    posts.length = 0;
    const allowed = await submit({ reservationId: r.id, action: "cancel_due_invalid_card" });
    assert.deepEqual(allowed, { success: true }, "after a successful invalid-card report the cancel is allowed");
    assert.equal(posts.length, 1, "one request");
    assert.equal(posts[0][0].action, "reportCancel",
      "the LOCAL cancel_due_invalid_card goes out as the WIRE action reportCancel");
    const [res] = await sql`
      SELECT status, external_cancellation_requested_at IS NOT NULL AS asked
      FROM guesthub.reservations WHERE id = ${r.id}`;
    assert.equal(res.asked, true, "the cancellation REQUEST is stamped");
    assert.equal(res.status, "confirmed",
      "the local status is NOT flipped — the cancellation lands through the canonical import (D93)");
    rows = await ledger(r.id);
    const cancelRows = rows.filter((x) => x.action === "cancel_due_invalid_card");
    assert.equal(cancelRows.length, 3,
      "all three cancel attempts (refused, refused-after-failed-report, allowed) are on the ledger");
    assert.equal(cancelRows.filter((x) => x.status === "failed").length, 2);
    assert.equal(cancelRows.filter((x) => x.status === "success").length, 1);
    ok("cancel rule: refused (no credit spent) until a SUCCESSFUL invalid_card exists; then reportCancel, status untouched");
  }

  // ---- 5. the soft time windows refuse BEFORE the network ----
  {
    // invalid_card after check-in has started
    const past = await makeReservation({ checkIn: day(-1), checkOut: day(3) });
    posts.length = 0;
    const late = await submit({ reservationId: past.id, action: "invalid_card" });
    assert.equal(late.success, false);
    assert.match(late.error, /עד תחילת יום הצ'ק-אין/, "the closed invalid-card window is explained in Hebrew");
    assert.equal(posts.length, 0, "a closed window never reaches the network");
    assert.equal((await ledger(past.id))[0].status, "failed", "…and is ledgered as a failed attempt");

    // no_show before check-in
    const future = await makeReservation({ checkIn: day(4), checkOut: day(6) });
    posts.length = 0;
    const early = await submit({ reservationId: future.id, action: "no_show", waivedFees: true });
    assert.equal(early.success, false);
    assert.match(early.error, /רק מיום הצ'ק-אין ואילך/, "no-show before check-in is refused");
    assert.equal(posts.length, 0);
    const earlyRows = await ledger(future.id);
    assert.equal(earlyRows[0].waived_fees, true,
      "the operator's LOCAL waiver record is stored even on a refused attempt");

    // no_show inside the 48h window
    const arrived = await makeReservation({ checkIn: day(-1), checkOut: day(2) });
    posts.length = 0;
    const inside = await submit({ reservationId: arrived.id, action: "no_show", waivedFees: true });
    assert.deepEqual(inside, { success: true }, "day+1 after check-in is inside the 48h window");
    assert.equal(posts[0][0].action, "reportNoShow", "the wire action is reportNoShow");
    assert.deepEqual(Object.keys(posts[0][0]).sort(), ["action", "bookingId"],
      "the waiver is NOT transmitted — the wire object is still exactly bookingId+action");
    const arrivedRows = await ledger(arrived.id);
    assert.equal(arrivedRows[0].waived_fees, true, "waived_fees is recorded locally");
    assert.equal(arrivedRows[0].status, "success");

    // no_show after the 48h window
    const stale = await makeReservation({ checkIn: day(-3), checkOut: day(-1) });
    posts.length = 0;
    const tooLate = await submit({ reservationId: stale.id, action: "no_show", waivedFees: false });
    assert.equal(tooLate.success, false);
    assert.match(tooLate.error, /48 שעות/, "past 48h the no-show window is closed");
    assert.equal(posts.length, 0);
    ok("soft windows: closed windows refuse before the network, are ledgered, and keep the local waiver record");

    // the window rule itself, at its exact boundaries (the shared client/server module)
    // (the shared rules module was required alongside the core, above)
    assert.equal(rules.windowRejection({ action: "invalid_card", today: "2026-07-20", checkIn: "2026-07-21" }), null);
    assert.ok(rules.windowRejection({ action: "invalid_card", today: "2026-07-21", checkIn: "2026-07-21" }));
    assert.ok(rules.windowRejection({ action: "no_show", today: "2026-07-20", checkIn: "2026-07-21" }));
    assert.equal(rules.windowRejection({ action: "no_show", today: "2026-07-21", checkIn: "2026-07-21" }), null);
    assert.equal(rules.windowRejection({ action: "no_show", today: "2026-07-22", checkIn: "2026-07-21" }), null);
    assert.ok(rules.windowRejection({ action: "no_show", today: "2026-07-23", checkIn: "2026-07-21" }));
    assert.equal(rules.windowRejection({ action: "cancel_due_invalid_card", today: "2026-07-30", checkIn: "2026-07-21" }), null);
    ok("window boundaries: invalid_card opens (-∞, check_in), no_show opens [check_in, check_in+2)");
  }

  // ---- 6. eligibility: only a Booking.com booking with a Beds24 id ----
  {
    const airbnb = await makeReservation({ otaName: "Airbnb", sourceId: null });
    posts.length = 0;
    const wrongChannel = await submit({ reservationId: airbnb.id, action: "invalid_card" });
    assert.equal(wrongChannel.success, false);
    assert.match(wrongChannel.error, /רק בהזמנות שהתקבלו מ-Booking\.com/);
    assert.equal(posts.length, 0);
    assert.equal((await ledger(airbnb.id))[0].status, "failed", "the wrong-channel attempt is ledgered");

    const noId = await makeReservation({ bookingId: null });
    const missing = await submit({ reservationId: noId.id, action: "invalid_card" });
    assert.equal(missing.success, false);
    assert.match(missing.error, /אין מזהה הזמנה בערוץ/);

    const cancelled = await makeReservation({ status: "cancelled" });
    const done = await submit({ reservationId: cancelled.id, action: "no_show" });
    assert.equal(done.success, false);
    assert.match(done.error, /כבר מבוטלת/);

    // ota_name alone establishes the channel — Beds24's live value is "booking"
    const byOtaNameOnly = await makeReservation({ sourceId: null, otaName: "booking" });
    posts.length = 0;
    assert.deepEqual(await submit({ reservationId: byOtaNameOnly.id, action: "invalid_card" }), { success: true },
      "ota_name='booking' (Beds24's real value) is recognised as Booking.com");
    ok("eligibility: wrong channel / no booking id / already cancelled are refused and ledgered");
  }

  // ---- 7. ZERO card data on the path, proven at runtime ----
  {
    const r = await makeReservation();
    // a stored card EXISTS on this reservation — the report must not touch it
    await sql`
      INSERT INTO guesthub.reservation_cards
        (tenant_id, reservation_id, holder_name, pan_encrypted, brand, last4, exp_month, exp_year)
      VALUES (${tenantId}, ${r.id}, 'CHECK HOLDER', 'v1.aaa.bbb.ccc', 'visa', '4242', 12, 2030)`;
    posts.length = 0;
    assert.deepEqual(await submit({ reservationId: r.id, action: "invalid_card" }), { success: true });

    const CARDISH = /pan|cvv|cvc|last4|expMonth|expYear|exp_month|exp_year|holder|card_number|number/i;
    const wire = JSON.stringify(posts[0]);
    for (const key of Object.keys(posts[0][0])) {
      assert.ok(!CARDISH.test(key), `the wire payload carries no card-ish key (${key})`);
    }
    assert.ok(!/4242|CHECK HOLDER|v1\.aaa/.test(wire), `no card value reached the wire: ${wire}`);

    const rows = await ledger(r.id);
    const stored = JSON.stringify(rows[0].response);
    assert.ok(!/4242|CHECK HOLDER|v1\.aaa/.test(stored), "no card value reached the stored response");
    const [card] = await sql`
      SELECT pan_encrypted, last4 FROM guesthub.reservation_cards WHERE reservation_id = ${r.id}`;
    assert.equal(card.pan_encrypted, "v1.aaa.bbb.ccc", "the stored card is untouched by the report");
    assert.equal(card.last4, "4242");
    ok("card line at runtime: no card key or value on the wire or in the ledger; the stored card is untouched");
  }

  // ---- 8. the ledger is append-only truth: one row per attempt, no deletes ----
  {
    const total = (await sql`
      SELECT count(*)::int AS c, count(*) FILTER (WHERE status = 'success')::int AS s,
             count(*) FILTER (WHERE status = 'failed')::int AS f
      FROM guesthub.booking_channel_reports WHERE tenant_id = ${tenantId}`)[0];
    assert.ok(total.s > 0 && total.f > 0, "the run produced both successes and failures");
    assert.equal(total.c, total.s + total.f, "every row is exactly one of success|failed");
    const [orphan] = await sql`
      SELECT 1 AS x FROM guesthub.booking_channel_reports b
      LEFT JOIN guesthub.reservations r ON r.id = b.reservation_id AND r.tenant_id = b.tenant_id
      WHERE b.tenant_id = ${tenantId} AND r.id IS NULL LIMIT 1`;
    assert.ok(!orphan, "every ledger row points at an in-tenant reservation");
    ok(`ledger integrity: ${total.c} attempts (${total.s} success / ${total.f} failed), all in-tenant`);
  }

  console.log(`\ncheck-booking-com-reports: all ${n} assertions passed`);
  console.log("NOTE: no live POST /channels/booking was issued — every provider call in this run was faked.");
} finally {
  // scratch-tenant cleanup (dependency order) — testdb only. Pre-existing rows
  // are never touched: only the two tenants this run created are removed.
  for (const t of [
    "booking_channel_reports", "reservation_cards", "reservation_rooms", "reservations",
    "guests", "channel_connections", "rooms", "room_types", "lookup_items", "tenants",
  ]) {
    for (const id of [tenantId, otherTenantId]) {
      if (!id) continue;
      await sql.unsafe(
        t === "tenants"
          ? `DELETE FROM guesthub.tenants WHERE id = '${id}'`
          : `DELETE FROM guesthub.${t} WHERE tenant_id = '${id}'`,
      );
    }
  }
  await sql.end();
}
