// Room deletion-integrity matrix (D49 closure audit).
// Rule: HARD delete only for a never-used room (zero dependency rows anywhere);
// any history — reservations (past/active/future), housekeeping, closures,
// rates, sellable-unit links, bulk-update history — blocks; archive instead.
// reservation_rooms.room_id is ON DELETE RESTRICT (migration 015) so history
// keeps its room even below the app guard.
//
// Run: node --env-file=.env.local scripts/check-room-deletion.mjs
// Throwaway ZZDEL-* rooms only; every write is removed on exit.
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2 });
const TENANT = "68139d06-58c4-4043-b256-4691f83e1556";
let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
};

// same census the server action runs — a room is hard-deletable only at zero
async function blockers(roomId) {
  const [d] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM guesthub.reservation_rooms WHERE room_id = ${roomId}) AS reservations,
      (SELECT COUNT(*)::int FROM guesthub.housekeeping_tasks WHERE room_id = ${roomId}) AS housekeeping,
      (SELECT COUNT(*)::int FROM guesthub.room_closures WHERE room_id = ${roomId}) AS closures,
      (SELECT COUNT(*)::int FROM guesthub.rates WHERE room_id = ${roomId}) AS rates,
      (SELECT COUNT(*)::int FROM guesthub.sellable_unit_rooms WHERE room_id = ${roomId}) AS sellable,
      (SELECT COUNT(*)::int FROM guesthub.bulk_rate_update_items WHERE room_id = ${roomId}) AS bulk`;
  return Object.values(d).reduce((a, b) => a + Number(b), 0);
}

const mkRoom = async (number) => {
  const [r] = await sql`
    INSERT INTO guesthub.rooms (tenant_id, room_number, name, max_occupancy, max_adults)
    VALUES (${TENANT}, ${number}, 'בדיקת מחיקה', 2, 2) RETURNING id`;
  return r.id;
};
const mkReservation = async (roomId, checkIn, checkOut, status = "confirmed") => {
  const [res] = await sql`
    INSERT INTO guesthub.reservations (tenant_id, reservation_number, status, check_in, check_out)
    VALUES (${TENANT}, ${"ZZDEL-" + crypto.randomUUID().slice(0, 8)}, ${status}, ${checkIn}, ${checkOut})
    RETURNING id`;
  await sql`
    INSERT INTO guesthub.reservation_rooms (tenant_id, reservation_id, room_id, check_in, check_out)
    VALUES (${TENANT}, ${res.id}, ${roomId}, ${checkIn}, ${checkOut})`;
  return res.id;
};

const cleanup = [];
try {
  // 1-3. past / active / future reservations each block + RESTRICT holds
  const cases = [
    ["past", "2025-01-10", "2025-01-12"],
    ["active", "2026-07-04", "2026-07-08"],
    ["future", "2026-09-01", "2026-09-05"],
  ];
  for (const [label, ci, co] of cases) {
    const roomId = await mkRoom(`ZZDEL-${label.toUpperCase()}`);
    const resId = await mkReservation(roomId, ci, co);
    cleanup.push({ roomId, resId });
    ok((await blockers(roomId)) > 0, `${label} reservation blocks hard delete (census)`);
    let restricted = false;
    try {
      await sql`DELETE FROM guesthub.rooms WHERE id = ${roomId}`;
    } catch (e) {
      restricted = e.code === "23503";
    }
    ok(restricted, `${label} reservation: DB RESTRICT refuses the delete outright`);
  }

  // 4. housekeeping history blocks (census level — hk cascades below it)
  const hkRoom = await mkRoom("ZZDEL-HK");
  cleanup.push({ roomId: hkRoom });
  await sql`
    INSERT INTO guesthub.housekeeping_tasks (tenant_id, room_id, status, notes)
    VALUES (${TENANT}, ${hkRoom}, 'completed', 'בדיקת מחיקה')`;
  ok((await blockers(hkRoom)) > 0, "housekeeping history blocks hard delete (census)");

  // 5. maintenance: no rooms-linked maintenance table exists in the schema —
  // "תחזוקה" is rooms.status='inactive' (a state, not history). Documented N/A.
  const maintTables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'guesthub' AND table_name LIKE '%maintenance%'`;
  ok(maintTables.length === 0, "maintenance: no rooms-linked history table exists (rule N/A, documented)");

  // 6. never-used room hard-deletes cleanly
  const freshRoom = await mkRoom("ZZDEL-FRESH");
  ok((await blockers(freshRoom)) === 0, "never-used room has zero blockers");
  await sql`DELETE FROM guesthub.rooms WHERE id = ${freshRoom}`;
  const gone = await sql`SELECT 1 FROM guesthub.rooms WHERE id = ${freshRoom}`;
  ok(gone.length === 0, "never-used room hard-deleted");

  // 7. archiving preserves every relationship
  const archRoom = await mkRoom("ZZDEL-ARCH");
  const archRes = await mkReservation(archRoom, "2025-03-01", "2025-03-03");
  cleanup.push({ roomId: archRoom, resId: archRes });
  await sql`UPDATE guesthub.rooms SET is_active = false, status = 'inactive' WHERE id = ${archRoom}`;
  const [arch] = await sql`
    SELECT r.is_active, r.status,
      (SELECT COUNT(*)::int FROM guesthub.reservation_rooms rr WHERE rr.room_id = r.id) AS links
    FROM guesthub.rooms r WHERE r.id = ${archRoom}`;
  ok(!arch.is_active && arch.status === "inactive" && arch.links === 1,
    "archived room keeps its reservation link + identity");
  const [histRoom] = await sql`
    SELECT rr.room_id FROM guesthub.reservation_rooms rr WHERE rr.reservation_id = ${archRes}`;
  ok(histRoom.room_id === archRoom, "historical reservation still points at the original room_id");
} finally {
  // teardown by pattern — resilient even if a case failed midway.
  // reservations first (their reservation_rooms cascade), then rooms (RESTRICT
  // is satisfied once the reservation links are gone).
  await sql`
    DELETE FROM guesthub.reservations
    WHERE tenant_id = ${TENANT} AND reservation_number LIKE 'ZZDEL-%'`;
  await sql`
    DELETE FROM guesthub.rooms
    WHERE tenant_id = ${TENANT} AND room_number LIKE 'ZZDEL-%'`;
  const [{ n }] = await sql`
    SELECT COUNT(*)::int AS n FROM guesthub.rooms WHERE tenant_id = ${TENANT} AND room_number LIKE 'ZZDEL-%'`;
  ok(Number(n) === 0, "teardown: zero ZZDEL residue");
}

console.log(failures === 0 ? "\nALL DELETION-INTEGRITY CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
await sql.end();
process.exit(failures === 0 ? 0 : 1);
