// Live-DB verification for Phase-3 inventory integrity (§Q/§AH):
//  - the TS blocking-status mirror equals guesthub.inventory_blocking_statuses()
//  - check_room_availability and room_type_inventory AGREE for every
//    room-type/day in a sampled window
//  - availability is never negative
//  - closures/holds affect both consistently (inside a ROLLED-BACK tx)
//  - tenant isolation, job idempotency, duplicate-revision rejection
//  - no dirty-range/job backlog exists while no connection is active
// All writes happen inside transactions that ROLL BACK — the live data is
// never modified. Usage: node --env-file=.env.local scripts/check-inventory.mjs
import postgres from "postgres";
import assert from "node:assert/strict";

const sql = postgres(process.env.DATABASE_URL, { prepare: true, max: 1 });
const FROM = "2026-08-01";
const TO = "2026-08-15"; // exclusive

try {
  const [{ id: tenantId }] = await sql`SELECT id FROM guesthub.tenants LIMIT 1`;

  // ---- blocking statuses: TS mirror === SQL source ----
  const [{ statuses }] = await sql`SELECT guesthub.inventory_blocking_statuses() AS statuses`;
  assert.deepEqual(statuses, ["confirmed", "checked_in", "blocked"], "SQL blocking statuses");
  const rulesSrc = (await import("node:fs")).readFileSync("src/lib/inventory-rules.ts", "utf8");
  const m = rulesSrc.match(/INVENTORY_BLOCKING_STATUSES = \[([^\]]+)\]/);
  const tsStatuses = m[1].split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean);
  assert.deepEqual(tsStatuses, statuses, "TS mirror equals guesthub.inventory_blocking_statuses()");

  // ---- agreement: projection availability === per-room availability-fn count ----
  async function assertAgreement(db, label) {
    const proj = await db`
      SELECT room_type_id, day::text AS day, sellable_rooms, hold_rooms, availability
      FROM guesthub.room_type_inventory(${tenantId}, ${FROM}, ${TO})`;
    assert.ok(proj.length > 0, "projection returns rows");
    for (const row of proj) {
      assert.ok(row.availability >= 0, `availability never negative (${label})`);
      const rooms = await db`
        SELECT id FROM guesthub.rooms
        WHERE tenant_id = ${tenantId} AND room_type_id = ${row.room_type_id}
          AND status = 'available' AND is_active`;
      assert.equal(rooms.length, row.sellable_rooms, `sellable count agrees (${label})`);
      if (rooms.length === 0) continue;
      const conflicts = await db`
        SELECT DISTINCT room_id FROM guesthub.check_room_availability(
          ${tenantId}, ${rooms.map((r) => r.id)}::uuid[],
          ${row.day}, (${row.day}::date + 1)::date)`;
      const freePhysical = rooms.length - conflicts.length;
      assert.equal(
        Math.max(0, freePhysical - row.hold_rooms),
        row.availability,
        `projection agrees with check_room_availability for type ${row.room_type_id} on ${row.day} (${label})`,
      );
    }
    return proj;
  }
  await assertAgreement(sql, "live");

  // ---- closure + hold affect both models identically (rolled back) ----
  await sql.begin(async (tx) => {
    const [room] = await tx`
      SELECT id, room_type_id FROM guesthub.rooms
      WHERE tenant_id = ${tenantId} AND status = 'available' AND is_active
        AND room_type_id IS NOT NULL LIMIT 1`;
    await tx`
      INSERT INTO guesthub.room_closures (tenant_id, room_id, start_date, end_date, reason)
      VALUES (${tenantId}, ${room.id}, '2026-08-03', '2026-08-05', 'check-inventory test')`;
    // the closed room must conflict via the availability fn…
    const conflicts = await tx`
      SELECT * FROM guesthub.check_room_availability(
        ${tenantId}, ARRAY[${room.id}]::uuid[], '2026-08-03', '2026-08-04')`;
    assert.ok(conflicts.some((c) => c.conflict_kind === "closure"), "closure blocks the room");
    // …and adjacent dates must NOT conflict with it (end-exclusive)
    const adjacent = await tx`
      SELECT * FROM guesthub.check_room_availability(
        ${tenantId}, ARRAY[${room.id}]::uuid[], '2026-08-05', '2026-08-06')`;
    assert.ok(!adjacent.some((c) => c.conflict_kind === "closure"), "closure end date is exclusive");
    // …and the projection must agree everywhere, including the closed days
    await assertAgreement(tx, "with closure");

    // active inventory hold reduces room-type availability (§R)
    const before = await tx`
      SELECT availability FROM guesthub.room_type_inventory(${tenantId}, '2026-08-10', '2026-08-11')
      WHERE room_type_id = ${room.room_type_id}`;
    await tx`
      INSERT INTO guesthub.channel_inventory_holds
        (tenant_id, room_type_id, check_in, check_out, rooms_count)
      VALUES (${tenantId}, ${room.room_type_id}, '2026-08-10', '2026-08-11', 1)`;
    const after = await tx`
      SELECT availability FROM guesthub.room_type_inventory(${tenantId}, '2026-08-10', '2026-08-11')
      WHERE room_type_id = ${room.room_type_id}`;
    assert.equal(
      after[0].availability,
      Math.max(0, before[0].availability - 1),
      "active hold reduces room-type availability immediately",
    );
    await assertAgreement(tx, "with hold");
    throw new Error("ROLLBACK");
  }).catch((e) => {
    if (e.message !== "ROLLBACK") throw e;
  });

  // ---- tenant isolation: foreign/unknown room ids are conflicts, not free ----
  const foreign = await sql`
    SELECT * FROM guesthub.check_room_availability(
      ${tenantId}, ARRAY['00000000-0000-0000-0000-000000000001']::uuid[],
      '2026-08-01', '2026-08-02')`;
  assert.ok(
    foreign.some((c) => c.conflict_kind === "room_missing"),
    "unknown/foreign room id reports room_missing — never looks available",
  );

  // ---- queue idempotency + duplicate revision rejection (rolled back) ----
  await sql.begin(async (tx) => {
    // throwaway tenant: the REAL tenant now owns a live (channex, staging)
    // connection (D59), and UNIQUE(tenant_id, provider, environment) would
    // reject a second one even inside this rolled-back transaction
    const [tt] = await tx`
      INSERT INTO guesthub.tenants (name, slug)
      VALUES ('inventory-check', ${"inv-" + crypto.randomUUID().slice(0, 8)}) RETURNING id`;
    const [conn] = await tx`
      INSERT INTO guesthub.channel_connections (tenant_id, provider, environment)
      VALUES (${tt.id}, 'channex', 'staging') RETURNING id`;

    const ins = (key) => tx`
      INSERT INTO guesthub.channel_sync_jobs
        (tenant_id, connection_id, job_type, idempotency_key)
      VALUES (${tt.id}, ${conn.id}, 'sync_ari_range', ${key})
      ON CONFLICT (connection_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL AND status IN ('queued','processing','retry_wait')
        DO NOTHING
      RETURNING id`;
    const first = await ins("k1");
    const second = await ins("k1");
    assert.equal(first.length, 1, "first job enqueued");
    assert.equal(second.length, 0, "duplicate idempotency key does not create duplicate work");

    const rev = (revId) => tx`
      INSERT INTO guesthub.channel_booking_revisions
        (tenant_id, connection_id, provider_booking_id, provider_revision_id, revision_kind)
      VALUES (${tt.id}, ${conn.id}, 'BK-1', ${revId}, 'new')
      ON CONFLICT (connection_id, provider_revision_id) DO NOTHING
      RETURNING id`;
    const r1 = await rev("REV-1");
    const r2 = await rev("REV-1");
    assert.equal(r1.length, 1);
    assert.equal(r2.length, 0, "same provider revision can never be stored twice");

    // acknowledgement gate: pending revision cannot be acknowledged
    const acked = await tx`
      UPDATE guesthub.channel_booking_revisions
      SET ack_status = 'acknowledged', acknowledged_at = now()
      WHERE id = ${r1[0].id} AND import_status = 'imported' AND ack_status = 'unacknowledged'
      RETURNING id`;
    assert.equal(acked.length, 0, "a revision not durably imported cannot be acknowledged");
    throw new Error("ROLLBACK");
  }).catch((e) => {
    if (e.message !== "ROLLBACK") throw e;
  });

  // NOTE: the former Phase-3 "no active connection ⇒ zero outbound backlog"
  // assertions were removed here. Channel sync was intentionally activated
  // (D68/D72), so live backlog is legitimate + transient; asserting live-prod
  // operational state in a code-integrity check is inherently flaky. That health
  // signal (stuck ranges / wedged jobs) is now an OBSERVABILITY.md alert and is
  // exercised deterministically by check:background-job-recovery + check:channel-worker
  // on the disposable DB. This check stays focused on inventory-FUNCTION integrity.

  console.log("check-inventory: all assertions passed");
} finally {
  await sql.end();
}
