// ============================================================
// D77 realtime + cancellation checks. Exercises the REAL modules (event
// codec, pg NOTIFY publisher, web hub, queue wake, worker instant wake,
// inbound cancellation, calendar exclusion, /reservations + /guests read
// models, migration 031 backfill) against the isolated test DB — no network,
// nothing touches prod.
//
//  · codec: whitelist-only wire payloads (no guest/card fields exist), caps,
//    malformed input dropped, unknown types refused
//  · NOTIFY is COMMIT-gated: a rolled-back business tx emits nothing
//  · hub fan-out is tenant-isolated (subscriber A never sees tenant B)
//  · every durable enqueue wakes the worker channel exactly once (duplicates
//    are silent)
//  · the worker claims a NOTIFY-woken job in ≪ the 20s poll interval (§4)
//  · inbound CANCELLED revision records who/when/origin ON the row
//    (ota/ota_revision, or invalid_card when we requested the cancellation),
//    stamps external_cancellation_confirmed_at, keeps rooms for history,
//    frees the nights, and publishes reservation.cancelled + inventory.changed
//  · cancelled reservations vanish from the calendar read model but appear
//    under the /reservations בוטלו tab with live counts/filters/search
//  · /guests aggregates are honest per-guest-row facts
//  · migration 031 backfill fills already-cancelled rows from their audit
//    trail, idempotently
//
// Usage: node scripts/check-realtime-cancellation.mjs
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
process.env.CHANNEL_SECRETS_KEY = "realtime-check-local-key-not-production";
process.env.CARD_VAULT_KEY = "realtime-check-card-vault-key-not-production";

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return Date.now() - start;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(60);
  }
}

console.log("applying migration chain to guesthub-testdb (:5433)…");
for (const f of readdirSync(join(ROOT, "db/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
  execSync(
    `docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "db/migrations/${f}"`,
    { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" },
  );
}

console.log("compiling the graph via tsc…");
const tmp = mkdtempSync(join(tmpdir(), "gh-rt-"));
const out = join(tmp, "out");
writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    module: "commonjs", moduleResolution: "node10", target: "es2022",
    esModuleInterop: true, skipLibCheck: true, strict: true,
    baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
    rootDir: join(ROOT, "src"), outDir: out,
    typeRoots: [join(ROOT, "node_modules/@types")], types: ["node"],
    jsx: "preserve",
  },
  include: [
    join(ROOT, "src/lib/channel/worker.ts"),
    join(ROOT, "src/lib/realtime/hub.ts"),
    join(ROOT, "src/app/(dashboard)/calendar/data.ts"),
    join(ROOT, "src/app/(dashboard)/reservations/data.ts"),
    join(ROOT, "src/app/(dashboard)/guests/data.ts"),
  ],
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
const events = req(join(out, "lib/realtime/events.js"));
const { publishDomainEvent } = req(join(out, "lib/realtime/publish.js"));
const { subscribeTenantEvents } = req(join(out, "lib/realtime/hub.js"));
const { enqueueChannelJob } = req(join(out, "lib/channel/queue.js"));
const { encryptSecret } = req(join(out, "lib/channel/crypto.js"));
const { runInboundPull } = req(join(out, "lib/channel/booking-import.js"));
const { runChannelWorker } = req(join(out, "lib/channel/worker.js"));
const { getCalendarData } = req(join(out, "app/(dashboard)/calendar/data.js"));
const { getReservationsList } = req(join(out, "app/(dashboard)/reservations/data.js"));
const { getGuestsList } = req(join(out, "app/(dashboard)/guests/data.js"));

// ---- fake Channex upstream (feed/rev/ack only — no network) ----
const upstream = { revisions: [] };
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const path = u.pathname;
  const json = (status, body) => ({ status, ok: status < 300, json: async () => body });
  if (path.endsWith("/booking_revisions/feed")) {
    const prop = u.searchParams.get("filter[property_id]");
    const rows = upstream.revisions
      .filter((r) => !r.acked && r.attributes.property_id === prop)
      .map((r) => ({ id: r.id, type: "booking_revision", attributes: r.attributes }));
    return json(200, { data: rows, meta: { total: rows.length, page: 1, limit: 100 } });
  }
  const ackMatch = path.match(/\/booking_revisions\/([^/]+)\/ack$/);
  if (ackMatch) {
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
  throw new Error(`fake channex: unexpected path ${path}`);
};

const TAG = `rt-check-${process.pid}`;
let revSeq = 0;
const mkRevision = (over = {}) => {
  const room = {
    room_type_id: "crt-1", rate_plan_id: "crp-a",
    checkin_date: "2026-09-10", checkout_date: "2026-09-12",
    amount: "300.00", occupancy: { adults: 2, children: 0, infants: 0, ages: [] },
    is_cancelled: false,
    ...(over.room ?? {}),
  };
  const rest = { ...over };
  delete rest.room;
  return {
    id: rest.id ?? `rt-rev-${++revSeq}`,
    status: "new",
    booking_id: "rt-book-1",
    property_id: "rt-prop-A",
    unique_id: "BDC-RT-1",
    ota_reservation_code: "777333",
    ota_name: "BookingCom",
    currency: "EUR",
    amount: room.amount,
    arrival_date: room.checkin_date,
    departure_date: room.checkout_date,
    inserted_at: `2026-07-10T18:30:${String(revSeq).padStart(2, "0")}`,
    customer: { name: "רון", surname: "בדיקה", mail: "rt@example.com", phone: "+972521111111", country: "IL", language: "he" },
    occupancy: { adults: 2, children: 0, infants: 0, ages: [] },
    payment_collect: "property",
    payment_type: "credit_card",
    rooms: [room],
    ...rest,
  };
};

async function seedTenant(slug, prop) {
  const [tenant] = await sql`
    INSERT INTO guesthub.tenants (name, slug, timezone, currency)
    VALUES (${"בדיקת realtime " + slug}, ${TAG + "-" + slug}, 'Asia/Jerusalem', 'ILS')
    RETURNING id`;
  const T = tenant.id;
  const [room] = await sql`
    INSERT INTO guesthub.rooms (tenant_id, room_number, name, status, is_active)
    VALUES (${T}, ${"9001-" + slug}, 'חדר בדיקה', 'available', true) RETURNING id`;
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
    VALUES (${T}, ${conn.id}, ${prop}, ${room.id}, ${"9001-" + slug}, 'crt-1', 'mapped', 'created')`;
  const [plan] = await sql`
    INSERT INTO guesthub.pricing_plans (tenant_id, code, name, is_base, plan_kind)
    VALUES (${T}, ${"rt-" + slug}, 'תוכנית בדיקה', false, 'base') RETURNING id`;
  await sql`
    INSERT INTO guesthub.channel_room_rate_mappings
      (tenant_id, connection_id, channex_property_id, local_rate_plan_id, room_id,
       room_number, channex_room_type_id, channex_rate_plan_id, status, currency)
    VALUES (${T}, ${conn.id}, ${prop}, ${plan.id}, ${room.id},
            ${"9001-" + slug}, 'crt-1', 'crp-a', 'mapped', 'EUR')`;
  return { tenantId: T, roomId: room.id, conn };
}

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let exitCode = 0;
try {
  // ============ 1. codec (pure) ============
  {
    const wire = events.encodeDomainEvent(UUID_A, {
      type: "reservation.created",
      reservationId: UUID_B,
      roomIds: Array.from({ length: 40 }, () => UUID_B).concat(["not-a-uuid"]),
      dateFrom: "2026-09-10",
      dateTo: "2026-09-12",
      lifecycle: "confirmed",
    }, "2026-07-10T20:00:00.000Z");
    const parsed = JSON.parse(wire);
    assert.deepEqual(Object.keys(parsed).sort(), ["at", "df", "dt", "e", "lc", "rid", "rooms", "t"]);
    assert.equal(parsed.rooms.length, 24, "room hint capped");
    assert.ok(!wire.includes("not-a-uuid"), "invalid room ids dropped");
    ok("codec: whitelist-only wire shape, capped/validated room hints");

    assert.throws(() => events.encodeDomainEvent(UUID_A, { type: "guest.email" }), /unknown/);
    assert.equal(events.decodeDomainEvent("{broken"), null);
    assert.equal(events.decodeDomainEvent(JSON.stringify({ t: "x", e: "reservation.created" })), null);
    const round = events.decodeDomainEvent(wire);
    assert.equal(round.tenantId, UUID_A);
    assert.equal(round.event.type, "reservation.created");
    assert.equal(round.event.reservationId, UUID_B);
    ok("codec: unknown types refused; malformed payloads dropped; round-trip exact");
  }

  // ============ 2. commit-gated NOTIFY ============
  const received = [];
  await sql.listen(events.EVENTS_CHANNEL, (raw) => {
    const d = events.decodeDomainEvent(raw);
    if (d) received.push(d);
  });
  const jobsWake = [];
  await sql.listen(events.JOBS_WAKE_CHANNEL, (p) => jobsWake.push(p));

  await sql.begin(async (tx) => {
    await publishDomainEvent(tx, UUID_A, { type: "reservation.modified", reservationId: UUID_B });
  });
  await waitFor(() => received.some((d) => d.tenantId === UUID_A && d.event.type === "reservation.modified"), "committed event");
  ok("publishDomainEvent inside a COMMITTED tx is delivered");

  try {
    await sql.begin(async (tx) => {
      await publishDomainEvent(tx, UUID_A, { type: "reservation.no_show", reservationId: UUID_B });
      throw new Error("rollback");
    });
  } catch { /* expected */ }
  await sleep(700);
  assert.ok(!received.some((d) => d.event.type === "reservation.no_show"),
    "rolled-back event must not be delivered");
  ok("publishDomainEvent inside a ROLLED-BACK tx is never delivered");

  // ============ 3. hub tenant isolation ============
  {
    const gotA = [], gotB = [];
    const unsubA = subscribeTenantEvents(UUID_A, (e) => gotA.push(e));
    const unsubB = subscribeTenantEvents(UUID_B, (e) => gotB.push(e));
    await sleep(300); // hub LISTEN arm
    await publishDomainEvent(sql, UUID_A, { type: "inventory.changed" });
    await waitFor(() => gotA.length > 0, "hub delivery to tenant A");
    await sleep(400);
    assert.equal(gotB.length, 0, "tenant B must see nothing of tenant A");
    unsubA(); unsubB();
    ok("hub fan-out is tenant-isolated (SSE subscribers get only their tenant)");
  }

  // ============ seed tenants ============
  const A = await seedTenant("a", "rt-prop-A");

  // ============ 4. enqueue → wake channel ============
  {
    const before = jobsWake.length;
    await sql.begin(async (tx) => {
      await enqueueChannelJob(tx, {
        tenantId: A.tenantId, connectionId: A.conn.id,
        jobType: "pull_booking_revisions", priority: 20,
        idempotencyKey: `wake-test:${A.conn.id}`,
      });
    });
    await waitFor(() => jobsWake.length > before, "jobs wake NOTIFY");
    ok("durable enqueue NOTIFYs the worker wake channel on commit");

    const midCount = jobsWake.length;
    const dup = await enqueueChannelJob(sql, {
      tenantId: A.tenantId, connectionId: A.conn.id,
      jobType: "pull_booking_revisions", priority: 20,
      idempotencyKey: `wake-test:${A.conn.id}`,
    });
    assert.ok(!("id" in dup), "duplicate collapsed");
    await sleep(500);
    assert.equal(jobsWake.length, midCount, "a duplicate enqueue must not re-wake");
    ok("duplicate enqueue is silent — no duplicate wake");
    // clean the synthetic job so the worker section starts quiet
    await sql`DELETE FROM guesthub.channel_sync_jobs WHERE connection_id = ${A.conn.id}`;
  }

  // ============ 5. worker instant wake (§4: claim ≪ poll interval) ============
  {
    const controller = new AbortController();
    const workerDone = runChannelWorker({
      workerId: "rt-check-worker",
      intervalMs: 20000, // the POLL is 20s — only the NOTIFY wake can beat it
      signal: controller.signal,
      log: () => {},
    });
    // wait for tick 1 (start-up) to finish: heartbeat row appears
    await waitFor(async () => {
      const [w] = await sql`SELECT 1 AS x FROM guesthub.channel_worker_state WHERE id = 'singleton'`;
      return !!w;
    }, "worker first tick");
    // drain whatever tick 1 claimed, then enqueue mid-sleep
    await sleep(800);
    const enqueuedAt = Date.now();
    await sql.begin(async (tx) => {
      await enqueueChannelJob(tx, {
        tenantId: A.tenantId, connectionId: A.conn.id,
        jobType: "pull_booking_revisions", priority: 20,
        idempotencyKey: `wake-claim:${A.conn.id}`,
      });
    });
    const claimMs = await waitFor(async () => {
      const [job] = await sql`
        SELECT status FROM guesthub.channel_sync_jobs
        WHERE connection_id = ${A.conn.id} AND idempotency_key = ${`wake-claim:${A.conn.id}`}`;
      return job && job.status !== "queued";
    }, "woken job claim", 15000);
    controller.abort();
    await workerDone;
    assert.ok(Date.now() - enqueuedAt < 5000, `claimed in ${claimMs}ms — must beat the 20s poll`);
    ok(`worker LISTEN wake: NOTIFY-enqueued job claimed in ${claimMs}ms (poll interval 20000ms)`);
  }

  // ============ 6. inbound import publishes committed events ============
  received.length = 0;
  upstream.revisions.push({ id: "rt-rev-new", acked: false, attributes: mkRevision({ id: "rt-rev-new" }) });
  let s = await runInboundPull(sql, A.conn);
  assert.equal(s.imported, 1);
  await waitFor(() => received.some((d) => d.tenantId === A.tenantId && d.event.type === "reservation.created"), "created event");
  assert.ok(received.some((d) => d.event.type === "inventory.changed"), "inventory event");
  const createdEvt = received.find((d) => d.event.type === "reservation.created");
  assert.equal(createdEvt.event.dateFrom, "2026-09-10");
  assert.deepEqual(createdEvt.event.roomIds, [A.roomId]);
  ok("OTA import publishes reservation.created + inventory.changed (commit-gated, correct hints)");

  const [imported] = await sql`
    SELECT * FROM guesthub.reservations
    WHERE channel_connection_id = ${A.conn.id} AND external_booking_id = 'rt-book-1'`;
  assert.ok(imported);

  // ============ 7. inbound cancellation — canonical history ============
  received.length = 0;
  upstream.revisions.push({
    id: "rt-rev-cancel", acked: false,
    attributes: mkRevision({
      id: "rt-rev-cancel", status: "cancelled",
      room: { is_cancelled: true },
    }),
  });
  s = await runInboundPull(sql, A.conn);
  assert.equal(s.imported, 1);
  const [cancelled] = await sql`
    SELECT * FROM guesthub.reservations WHERE id = ${imported.id}`;
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.cancelled_at, "cancelled_at stamped");
  assert.equal(cancelled.cancelled_by_type, "ota");
  assert.equal(cancelled.cancellation_origin, "ota_revision");
  assert.ok(cancelled.external_cancellation_confirmed_at, "external confirmation stamped");
  const rrKept = await sql`
    SELECT COUNT(*)::int AS c FROM guesthub.reservation_rooms WHERE reservation_id = ${imported.id}`;
  assert.equal(rrKept[0].c, 1, "rooms preserved for history (cancel-never-delete)");
  const conflicts = await sql`
    SELECT * FROM guesthub.check_room_availability(
      ${A.tenantId}, ARRAY[${A.roomId}]::uuid[], '2026-09-10', '2026-09-12')`;
  assert.equal(conflicts.length, 0, "nights released");
  await waitFor(() => received.some((d) => d.event.type === "reservation.cancelled"), "cancelled event");
  ok("inbound cancellation: who/when/origin on the row, rooms kept, nights freed, event published");

  // ============ 8. requested-then-confirmed → origin invalid_card ============
  upstream.revisions.push({ id: "rt-rev-b2", acked: false, attributes: mkRevision({ id: "rt-rev-b2", booking_id: "rt-book-2", unique_id: "BDC-RT-2", room: { checkin_date: "2026-09-20", checkout_date: "2026-09-21" } }) });
  await runInboundPull(sql, A.conn);
  const [book2] = await sql`
    SELECT id FROM guesthub.reservations
    WHERE channel_connection_id = ${A.conn.id} AND external_booking_id = 'rt-book-2'`;
  await sql`
    UPDATE guesthub.reservations SET external_cancellation_requested_at = now()
    WHERE id = ${book2.id}`;
  upstream.revisions.push({
    id: "rt-rev-b2-cancel", acked: false,
    attributes: mkRevision({ id: "rt-rev-b2-cancel", booking_id: "rt-book-2", unique_id: "BDC-RT-2", status: "cancelled", room: { checkin_date: "2026-09-20", checkout_date: "2026-09-21", is_cancelled: true } }),
  });
  await runInboundPull(sql, A.conn);
  const [book2c] = await sql`SELECT * FROM guesthub.reservations WHERE id = ${book2.id}`;
  assert.equal(book2c.cancellation_origin, "invalid_card",
    "a cancellation WE requested (invalid card) is recorded as such");
  ok("cancel-due-invalid-card flow: external confirmation recorded with origin invalid_card");

  // ============ 9. calendar excludes cancelled ============
  const cal = await getCalendarData({ tenantId: A.tenantId }, "2026-09-08", 21);
  assert.ok(!cal.stays.some((st) => st.reservation_id === imported.id),
    "cancelled stay must not block the calendar");
  ok("calendar read model: cancelled reservation disappears from active occupancy");

  // ============ 10. /reservations read model ============
  const baseFilters = {
    tab: "all", q: "", dateType: "checkin", from: null, to: null,
    sourceId: null, workflowId: null, payment: null, roomId: null,
    cancellationOrigin: null, quick: null,
  };
  let list = await getReservationsList({ tenantId: A.tenantId }, baseFilters);
  assert.equal(list.counts.cancelled, 2);
  assert.equal(list.counts.all, 2);
  assert.equal(list.truncatedBy, 0);
  ok("/reservations: live tab counts over the full dataset");

  list = await getReservationsList({ tenantId: A.tenantId }, { ...baseFilters, tab: "cancelled" });
  assert.equal(list.rows.length, 2);
  const listRow = list.rows.find((r) => r.id === imported.id);
  assert.ok(listRow.cancelled_at, "cancelled tab exposes when");
  assert.equal(listRow.cancellation_origin, "ota_revision");
  assert.equal(listRow.nights, 2);
  assert.equal(listRow.payment, "unpaid");
  ok("/reservations בוטלו tab: history retained with origin/time, honest payment state");

  list = await getReservationsList({ tenantId: A.tenantId }, { ...baseFilters, q: "777333" });
  assert.equal(list.rows.length, 2, "search by OTA code finds the bookings");
  list = await getReservationsList({ tenantId: A.tenantId }, { ...baseFilters, q: "9001-a" });
  assert.equal(list.rows.length, 2, "search by room number");
  list = await getReservationsList({ tenantId: A.tenantId }, { ...baseFilters, quick: "cancelled24" });
  assert.equal(list.rows.length, 2, "quick filter: cancelled in last 24h");
  list = await getReservationsList({ tenantId: A.tenantId }, { ...baseFilters, q: "no-such-guest-xyz" });
  assert.equal(list.rows.length, 0);
  ok("/reservations: search (OTA code / room) + quick filters honest");

  // ============ 11. /guests read model ============
  // each OTA booking created its own guest row (upsertChannelGuest never
  // merges across bookings — D77 §19 forbids automatic dedup): the list must
  // show BOTH rows as they exist, each with its own honest aggregates.
  const guests = await getGuestsList({ tenantId: A.tenantId }, "");
  const guestRows = guests.rows.filter((g) => g.full_name === "רון בדיקה");
  assert.equal(guestRows.length, 2, "no automatic merging — both rows listed");
  for (const g of guestRows) {
    assert.equal(g.total_reservations, 1);
    assert.equal(g.cancelled_stays, 1);
    assert.equal(g.active_reservations, 0);
  }
  ok("/guests: aggregates over the canonical guests table (no merging, honest counts)");

  // ============ 12. migration 031 backfill from audit trail ============
  {
    const [g] = await sql`
      INSERT INTO guesthub.guests (tenant_id, full_name) VALUES (${A.tenantId}, 'אורח ישן')
      RETURNING id`;
    const [legacy] = await sql`
      INSERT INTO guesthub.reservations
        (tenant_id, reservation_number, primary_guest_id, status, check_in, check_out,
         total_price, paid_amount, balance)
      VALUES (${A.tenantId}, ${"L-" + TAG}, ${g.id}, 'cancelled', '2026-01-10', '2026-01-12',
              100, 0, 100)
      RETURNING id`;
    await sql`
      INSERT INTO guesthub.audit_logs
        (tenant_id, user_id, entity_type, entity_id, action, after_data, created_at)
      VALUES (${A.tenantId}, NULL, 'reservation', ${legacy.id}, 'channel_import_cancel',
              '{"reason": null}', '2026-02-01T10:00:00Z')`;
    // a legacy cancelled row with NO audit trail — its time is genuinely
    // unknown and must STAY NULL (never a fabricated updated_at)
    const [legacyNoAudit] = await sql`
      INSERT INTO guesthub.reservations
        (tenant_id, reservation_number, primary_guest_id, status, check_in, check_out,
         total_price, paid_amount, balance)
      VALUES (${A.tenantId}, ${"LN-" + TAG}, ${g.id}, 'cancelled', '2026-01-20', '2026-01-22',
              100, 0, 100)
      RETURNING id`;
    execSync(
      `docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "db/migrations/031_cancellation_history_realtime.sql"`,
      { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" },
    );
    const [filled] = await sql`SELECT * FROM guesthub.reservations WHERE id = ${legacy.id}`;
    assert.equal(filled.cancelled_by_type, "ota");
    assert.equal(filled.cancellation_origin, "ota_revision");
    assert.equal(new Date(filled.cancelled_at).toISOString(), "2026-02-01T10:00:00.000Z");
    // idempotency: a second run must not change anything
    execSync(
      `docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "db/migrations/031_cancellation_history_realtime.sql"`,
      { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" },
    );
    const [again] = await sql`SELECT cancelled_at FROM guesthub.reservations WHERE id = ${legacy.id}`;
    assert.equal(new Date(again.cancelled_at).toISOString(), "2026-02-01T10:00:00.000Z");
    const [noAudit] = await sql`SELECT * FROM guesthub.reservations WHERE id = ${legacyNoAudit.id}`;
    assert.equal(noAudit.cancelled_by_type, "unknown");
    assert.equal(noAudit.cancelled_at, null, "no audit trail → time stays honestly unknown");
    ok("migration 031 backfill: audit-derived who/when; unknown stays NULL; idempotent on re-run");
  }

  console.log(`\nALL ${n} CHECKS PASSED`);
} catch (e) {
  exitCode = 1;
  console.error("\nCHECK FAILED:", e);
} finally {
  try { await sql.end({ timeout: 5 }); } catch { /* closing */ }
  process.exit(exitCode);
}
