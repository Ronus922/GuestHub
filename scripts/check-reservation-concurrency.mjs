#!/usr/bin/env node
// check:reservation-concurrency (Stage 3, H1/ADR-0003) — PROVE that the database
// makes double booking impossible under true concurrency, independent of the
// application's lockRooms()/check_room_availability() guard.
//
// Runs against a DISPOSABLE database only (schema present, e.g. gh_s3replay on
// :5433). Creates its own isolated test tenant/room and cleans up. Fail-closed
// against the shared production :5432.
//
// Scenarios:
//   A. Two concurrent transactions INSERT overlapping BLOCKING stays on the same
//      room (bypassing the app lock) → exactly one commits, the other is rejected
//      by the exclusion constraint.
//   B. Two NON-BLOCKING stays for the same room+dates coexist; flipping BOTH to
//      a blocking status concurrently → exactly one succeeds. This is the
//      UPDATE-side race (res_propagate_blocking racing the constraint), which
//      scenario A's INSERT-side race does not reach.
//
//      D126 moved which statuses are non-blocking. Until then this scenario
//      used two overlapping DRAFTS; since D126 a draft consumes inventory, so
//      the old seed is rejected by rr_no_double_booking before the race can
//      even be set up. `cancelled` is now the ONLY non-blocking status, so the
//      pair starts cancelled and is reinstated — an ordinary operation, and a
//      real race when two operators reinstate overlapping bookings at once.
//      B0 below pins the D126 half so the old seed cannot quietly return.
//   C. Adjacent stays (checkout == next checkin) on one room → BOTH allowed
//      (half-open [check_in,check_out)).
import postgres from "postgres";

const url = process.env.CHECK_CONCURRENCY_DB_URL;
if (!url) { console.error("need CHECK_CONCURRENCY_DB_URL (a disposable DB)"); process.exit(2); }
try { const u = new URL(url); if (["localhost","127.0.0.1","::1"].includes(u.hostname) && (u.port||"5432")==="5432")
  { console.error("ABORT: refusing :5432 (shared production)"); process.exit(2); } } catch {}

const admin = postgres(url, { prepare:false, max:1 });
const c1 = postgres(url, { prepare:false, max:1 });
const c2 = postgres(url, { prepare:false, max:1 });
let fail = 0; const ok=(m)=>console.log(`  ✓ ${m}`); const bad=(m,e)=>{fail++;console.log(`  ✗ ${m}: ${e?.message??e}`);};
const isExcl = (e) => /rr_no_double_booking|exclusion|conflicting key|overlap/i.test(e?.message||"");

let T, ROOM, G1, G2;
try {
  [{ id: T }] = await admin`insert into guesthub.tenants (name, slug) values ('concurrency-test', 'concurrency-test-'||substr(md5(random()::text),1,8)) returning id`;
  [{ id: ROOM }] = await admin`insert into guesthub.rooms (tenant_id, room_number) values (${T}, 'CT-1') returning id`;
  const mkRes = async (status) => (await admin`insert into guesthub.reservations (tenant_id, reservation_number, check_in, check_out, status)
     values (${T}, 'CT-'||substr(md5(random()::text),1,10), '2027-03-01','2027-03-05', ${status}) returning id`)[0].id;

  // ---- Scenario A: concurrent overlapping blocking inserts ----
  G1 = await mkRes('confirmed'); G2 = await mkRes('confirmed');
  const insRR = (c, resId, ci, co) => c`insert into guesthub.reservation_rooms
     (tenant_id, reservation_id, room_id, check_in, check_out) values (${T}, ${resId}, ${ROOM}, ${ci}, ${co})`;
  try {
    await c1.begin(async (t1) => {
      await insRR(t1, G1, '2027-03-01', '2027-03-05');        // holds the room
      // c2 tries an overlapping blocking insert; it will block then fail after c1 commits
      const p2 = c2.begin(async (t2) => { await insRR(t2, G2, '2027-03-03', '2027-03-08'); });
      // give c2 a moment to reach the constraint wait, then commit c1 by returning
      await new Promise((r)=>setTimeout(r, 300));
      // c1 commits here (block returns); then await c2's result
      globalThis.__p2 = p2;
    });
    try { await globalThis.__p2; bad("A: overlapping blocking insert was NOT rejected"); }
    catch (e) { if (isExcl(e)) ok("A: concurrent overlapping blocking insert rejected by exclusion constraint"); else bad("A: rejected but wrong error", e); }
  } catch (e) { bad("A: setup", e); }

  // ---- Scenario B0 (D126): a draft CONSUMES inventory, so two overlapping
  //      drafts can no longer coexist. This is the assumption the old scenario-B
  //      seed rested on; asserting its inverse keeps the seed from regressing.
  try {
    const X1 = await mkRes('draft'), X2 = await mkRes('draft');
    await admin`insert into guesthub.reservation_rooms (tenant_id, reservation_id, room_id, check_in, check_out) values
       (${T}, ${X1}, ${ROOM}, '2027-04-01','2027-04-04')`;
    try {
      await admin`insert into guesthub.reservation_rooms (tenant_id, reservation_id, room_id, check_in, check_out) values
         (${T}, ${X2}, ${ROOM}, '2027-04-02','2027-04-06')`;
      bad("B0: a second overlapping DRAFT was accepted — draft no longer holds inventory (D126 regressed)");
    } catch (e) {
      if (isExcl(e)) ok("B0: overlapping DRAFT stays rejected — a draft holds the room (D126)");
      else bad("B0: rejected but wrong error", e);
    }
    await admin`delete from guesthub.reservations where id in (${X1}, ${X2})`;
  } catch (e) { bad("B0: setup", e); }

  // ---- Scenario B: two non-blocking stays, flip both to blocking concurrently ----
  // `cancelled` is the only non-blocking status since D126 (see header).
  const D1 = await mkRes('cancelled'), D2 = await mkRes('cancelled');
  await admin`insert into guesthub.reservation_rooms (tenant_id, reservation_id, room_id, check_in, check_out) values
     (${T}, ${D1}, ${ROOM}, '2027-05-01','2027-05-04')`;
  await admin`insert into guesthub.reservation_rooms (tenant_id, reservation_id, room_id, check_in, check_out) values
     (${T}, ${D2}, ${ROOM}, '2027-05-02','2027-05-06')`;  // overlaps, both non-blocking = allowed
  ok("B: two overlapping NON-BLOCKING stays coexist (cancelled)");
  try {
    let firstOk=false, secondFailed=false;
    await c1.begin(async (t1) => {
      await t1`update guesthub.reservations set status='confirmed' where id=${D1}`;
      const p2 = c2.begin(async (t2) => { await t2`update guesthub.reservations set status='confirmed' where id=${D2}`; });
      await new Promise((r)=>setTimeout(r,300));
      globalThis.__pB = p2; firstOk=true;
    });
    try { await globalThis.__pB; } catch (e) { if (isExcl(e)) secondFailed=true; else throw e; }
    if (firstOk && secondFailed) ok("B: reinstating the second overlapping stay rejected by exclusion constraint");
    else bad("B: both reinstatements succeeded (double booking!)");
  } catch (e) { bad("B: confirm race", e); }

  // ---- Scenario C: adjacency allowed ----
  try {
    const A1 = await mkRes('confirmed'), A2 = await mkRes('confirmed');
    await admin`insert into guesthub.reservation_rooms (tenant_id, reservation_id, room_id, check_in, check_out) values
       (${T}, ${A1}, ${ROOM}, '2027-07-01','2027-07-04')`;
    await admin`insert into guesthub.reservation_rooms (tenant_id, reservation_id, room_id, check_in, check_out) values
       (${T}, ${A2}, ${ROOM}, '2027-07-04','2027-07-07')`;  // checkout==checkin, half-open => OK
    ok("C: adjacent stays (checkout==next checkin) both allowed");
  } catch (e) { bad("C: adjacency wrongly rejected", e); }

} finally {
  if (T) await admin`delete from guesthub.tenants where id=${T}`.catch(()=>{});
  await Promise.allSettled([admin.end(), c1.end(), c2.end()]);
}
console.log(fail ? `\ncheck:reservation-concurrency FAILED (${fail})` : "\ncheck:reservation-concurrency PASSED — DB prevents double booking");
process.exit(fail ? 1 : 0);
