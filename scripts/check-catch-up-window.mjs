// check:catch-up-window — D201 behavioural guard for the same-day catch-up
// window (owner decision 6): after downtime, a late scheduled send goes out
// only while now <= send time + 3 hours; later the same day it is recorded as
// skipped 'catch_up_window_expired'; a past day is never emitted at all.
//
// Runs the REAL compiled scheduler SQL against a scratch database inside a
// rolled-back transaction, once per simulated "worker comes back at" instant,
// then proves the assertions fail on a mutant without the 3-hour cap.
// DB-backed: connects to TEST_DATABASE_URL (scheduler-harness connect()) — the
// suite reads this file to decide it needs its own cloned database.
import {
  addDays, compile, connect, emitted, inRollback, israel, proveWithRefutation,
  seedAutomation, seedReservation, seedTenant,
} from "./lib/scheduler-harness.mjs";

const D = "2026-07-15";
const sql = connect();
const out = compile("check-catch-up-window");

async function scenario({ scheduler, triggers, db }) {
  const fail = [];
  const eq = (actual, expected, message) => {
    const a = JSON.stringify(actual); const e = JSON.stringify(expected);
    if (a !== e) fail.push(`${message}\n      expected ${e}\n      actual   ${a}`);
  };
  eq(scheduler.CATCH_UP_WINDOW_HOURS, 3, "the catch-up window is 3 hours");
  // One fresh world per instant: the worker "comes back" at `when`.
  const worldAt = (when) => inRollback(sql, { db }, async (tx) => {
    const t = await seedTenant(tx, `catchup-${Date.now()}`);
    await seedAutomation(tx, t, "on-check-in-09", triggers.scheduledTriggerId("check_in", "on"),
      { offsetDays: 0, sendTime: "09:00" });
    await seedReservation(tx, t, "TODAY", D, addDays(D, 2), "confirmed");
    await seedReservation(tx, t, "YESTERDAY", addDays(D, -1), addDays(D, 2), "confirmed");
    await scheduler.runScheduledTriggerScan(() => {}, { at: when });
    return (await emitted(tx, t)).map((e) => e.line);
  });

  eq(await worldAt(israel(D, "08:59")), [], "before the send time nothing is emitted");
  eq(await worldAt(israel(D, "09:00")), ["on-check-in-09/TODAY → send @2026-07-15"], "on time → sends");
  eq(await worldAt(israel(D, "11:00")), ["on-check-in-09/TODAY → send @2026-07-15"], "+2h late → still sends");
  eq(await worldAt(israel(D, "12:00")), ["on-check-in-09/TODAY → send @2026-07-15"], "exactly +3h → still sends (now <= time + 3h)");
  eq(await worldAt(israel(D, "12:01")), ["on-check-in-09/TODAY → catch_up_window_expired @2026-07-15"],
    "+3h01 → skipped, not sent late");
  eq(await worldAt(israel(D, "13:00")), ["on-check-in-09/TODAY → catch_up_window_expired @2026-07-15"],
    "+4h late → skipped as catch_up_window_expired");
  // YESTERDAY's check-in day passed while the worker was down: never emitted,
  // at any hour of today — not even as a skip.
  for (const hm of ["00:30", "09:30", "23:59"]) {
    const lines = await worldAt(israel(D, hm));
    eq(lines.some((l) => l.includes("/YESTERDAY")), false, `a past day never sends (scan at ${hm})`);
  }
  return fail;
}

process.exitCode = await proveWithRefutation(sql, out, scenario, [
  { name: "3-hour cap removed",
    mutations: [["scheduler.js", "WHEN ${catchUpExpired} THEN 'catch_up_window_expired'", "WHEN false THEN 'catch_up_window_expired'"]] },
]);
