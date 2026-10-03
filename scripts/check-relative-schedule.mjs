// check:relative-schedule — D201 behavioural guard for the relative schedule
// (anchor × when × offsetDays × sendTime).
//
// Runs the REAL compiled scheduler SQL against a scratch database (inside a
// rolled-back transaction) over a seed covering all six windows, live and
// stale statuses, an in-stay day outside the stay, a date change and a
// cancellation. Then proves the assertions are not vacuous: each mutant below
// is a defect the owner named, and the guard must go red on every one of them.
import { readFileSync } from "node:fs";
// DB-backed: connects to TEST_DATABASE_URL (scheduler-harness connect()) — the
// suite reads this file to decide it needs its own cloned database.
import {
  addDays, compile, connect, emitted, inRollback, israel, proveWithRefutation,
  seedAutomation, seedReservation, seedTenant,
} from "./lib/scheduler-harness.mjs";

const D = "2026-07-15"; // "today" in Israel for the main scan
const AT = israel(D, "09:30"); // 30 minutes after every 09:00 send time

const failures = [];
const check = (cond, message) => { if (!cond) failures.push(message); };

// ---- static wiring the DB run cannot see: the preparation step must honour
// the scheduler's decision, and the history must say it in Hebrew.
const automationSrc = readFileSync("src/lib/communications/automation.ts", "utf8");
check(/scheduledSkipReason === "outside_stay" \|\| scheduledSkipReason === "catch_up_window_expired"/.test(automationSrc),
  "automation.ts must turn the scheduler's skipReason into a skipped row");
check(automationSrc.indexOf("scheduledSkipReason") < automationSrc.indexOf("const globalSkipReason"),
  "the scheduled skip must be honoured before any send path is reached");
check(/outside_stay: "[^"]+"/.test(automationSrc) && /catch_up_window_expired: "[^"]+"/.test(automationSrc),
  "both skip reasons need a Hebrew history label");
const migration = readFileSync("db/migrations/092_relative_schedule_triggers.sql", "utf8");
for (const id of ["post_check_in", "pre_departure", "check_out_day", "pre_arrival", "check_in_day", "post_checkout", "confirmed", "cancelled"]) {
  check(migration.includes(`'reservation.${id}'`), `migration 092 must keep/admit reservation.${id}`);
}
check(readFileSync("db/migrations/manifest.txt", "utf8").includes("092_relative_schedule_triggers.sql"),
  "092 must be in the migration manifest");
// D201 follow-up — the editor must route every trigger/window pick through
// nextTimingState (exercised at runtime below), and an EXISTING automation must
// seed its days/time from the saved timing_config, never from defaults.
const shellSrc = readFileSync("src/components/communications/CommunicationsShell.tsx", "utf8");
const pick = shellSrc.slice(shellSrc.indexOf("const pickTrigger = (next: TriggerId) => {"));
check(/const timing = nextTimingState\(\{ triggerType, offsetDays, sendTime \}, next\);\s*setTriggerType\(timing\.triggerType\);\s*setOffsetDays\(timing\.offsetDays\);\s*setSendTime\(timing\.sendTime\);/.test(pick),
  "pickTrigger must take days AND time from nextTimingState");
check(/const stored = fresh \? undefined : Number\(\(value\.timing as \{ offsetDays\?: number \}\)\.offsetDays\);/.test(shellSrc)
  && /const stored = fresh \? undefined : \(value\.timing as \{ sendTime\?: string \}\)\.sendTime;/.test(shellSrc),
  "an existing automation must open with its SAVED days and time");
check(shellSrc.includes("{scheduleWhens(scheduleAnchor).map((w) =>"),
  "the \"מתי\" select must take its options from scheduleWhens(the current anchor)");
check(/subtitleWrap\b/.test(shellSrc.slice(shellSrc.indexOf("<SidePanel", shellSrc.indexOf("function AutomationPanel(")))),
  "the automation panel subtitle states a rule — it must wrap, not truncate");
if (failures.length) {
  for (const f of failures) console.log(`✗ ${f}`);
  process.exit(1);
}
console.log("✓ static wiring: prep honours skipReason first, Hebrew labels, migration 092 in the manifest, editor timing wiring");

const sql = connect();
const out = compile("check-relative-schedule");

async function scenario({ scheduler, triggers, delivery, db }) {
  const fail = [];
  const eq = (actual, expected, message) => {
    const a = JSON.stringify(actual); const e = JSON.stringify(expected);
    if (a !== e) fail.push(`${message}\n      expected ${e}\n      actual   ${a}`);
  };
  await inRollback(sql, { db }, async (tx) => {
    const t = await seedTenant(tx, `relsched-${Date.now()}`);
    const id = (anchor, when) => triggers.scheduledTriggerId(anchor, when);
    const nine = { sendTime: "09:00" };
    await seedAutomation(tx, t, "A1-before-in-2", id("check_in", "before"), { offsetDays: 2, ...nine });
    await seedAutomation(tx, t, "A2-on-in", id("check_in", "on"), { offsetDays: 0, ...nine });
    await seedAutomation(tx, t, "A3-after-in-1", id("check_in", "after"), { offsetDays: 1, ...nine });
    await seedAutomation(tx, t, "A4-before-out-1", id("check_out", "before"), { offsetDays: 1, ...nine });
    await seedAutomation(tx, t, "A4b-before-out-3", id("check_out", "before"), { offsetDays: 3, ...nine });
    await seedAutomation(tx, t, "A5-on-out", id("check_out", "on"), { offsetDays: 0, ...nine });
    await seedAutomation(tx, t, "A6-after-out-2", id("check_out", "after"), { offsetDays: 2, ...nine });

    const R = (n, ci, co, status) => seedReservation(tx, t, n, addDays(D, ci), addDays(D, co), status);
    const r1 = await R("R01", 2, 4, "confirmed");   // A1 sends
    await R("R02", 0, 3, "confirmed");               // A2 sends; A4b lands ON check-in day → sends
    await R("R03", -1, 1, "checked_in");             // A3 + A4 send (in stay)
    await R("R04", -1, 0, "confirmed");              // A3 day = check-out day → outside_stay; A5 sends
    await R("R05", -3, 0, "checked_out");            // A5 must NOT emit — already left
    await R("R06", -5, -2, "checked_in");            // stale checked_in → A6 sends
    await R("R07", -4, -2, "checked_out");           // A6 sends
    await R("R08", 2, 4, "cancelled");               // nothing
    await R("R09", 1, 3, "confirmed");               // A4b day before check-in → outside_stay
    await R("R10", 2, 5, "confirmed");               // A1 sends; cancelled after emission below
    await R("R11", 2, 4, "no_show");                 // nothing

    await scheduler.runScheduledTriggerScan(() => {}, { at: AT });
    const first = await emitted(tx, t);
    eq(first.map((e) => e.line), [
      `A1-before-in-2/R01 → send @${addDays(D, 2)}`,
      `A1-before-in-2/R10 → send @${addDays(D, 2)}`,
      `A2-on-in/R02 → send @${D}`,
      `A3-after-in-1/R03 → send @${addDays(D, -1)}`,
      `A3-after-in-1/R04 → outside_stay @${addDays(D, -1)}`,
      `A4-before-out-1/R03 → send @${addDays(D, 1)}`,
      `A4b-before-out-3/R02 → send @${addDays(D, 3)}`,
      `A4b-before-out-3/R09 → outside_stay @${addDays(D, 3)}`,
      `A5-on-out/R04 → send @${D}`,
      `A6-after-out-2/R06 → send @${addDays(D, -2)}`,
      `A6-after-out-2/R07 → send @${addDays(D, -2)}`,
    ], "six windows × statuses × in-stay-by-date");
    eq(first.every((e) => e.payload.scheduledFor?.startsWith(`${D}T06:00:00`)), true,
      "scheduledFor = today 09:00 Israel (06:00Z in July)");

    // idempotent: a second scan the same minute emits nothing new
    eq((await scheduler.runScheduledTriggerScan(() => {}, { at: AT })).emitted, 0, "re-scan is idempotent");

    // date change: R01 moves one day later. Tomorrow its NEW check-in is again
    // 2 days out → a fresh occurrence (new anchor in the key), the old one stays.
    await tx`UPDATE guesthub.reservations SET check_in = ${addDays(D, 3)}, check_out = ${addDays(D, 5)}
             WHERE id = ${r1}`;
    await scheduler.runScheduledTriggerScan(() => {}, { at: israel(addDays(D, 1), "09:30") });
    const r01 = (await emitted(tx, t)).filter((e) => e.line.startsWith("A1-before-in-2/R01"));
    eq(r01.map((e) => e.line), [
      `A1-before-in-2/R01 → send @${addDays(D, 2)}`,
      `A1-before-in-2/R01 → send @${addDays(D, 3)}`,
    ], "a date change is a new occurrence with its own key");
    eq(new Set(r01.map((e) => e.key)).size, 2, "the two occurrences carry distinct keys");

    // cancellation after emission: the queued delivery is cancelled by the
    // REAL pre-send eligibility pass, with the statuses the trigger stamps.
    const [ev] = await tx`
      SELECT e.id, e.reservation_id, e.payload->>'automationId' AS automation_id
      FROM guesthub.communication_events e JOIN guesthub.reservations r ON r.id = e.reservation_id
      WHERE r.reservation_number = 'R10' AND r.tenant_id = ${t.tenantId}`;
    const before = triggers.TRIGGERS[id("check_in", "before")].eligibleStatuses;
    const onOut = triggers.TRIGGERS[id("check_out", "on")].eligibleStatuses;
    await tx`
      INSERT INTO guesthub.outbound_messages
        (tenant_id, reservation_id, channel, provider, template_id, automation_id, event_id,
         idempotency_key, to_address, body, status, delivery_type, eligible_statuses)
      VALUES (${t.tenantId}, ${ev.reservation_id}, 'whatsapp', 'green_api', ${t.templateId},
              ${ev.automation_id}, ${ev.id}, ${`guard:${ev.id}`}, '+972500000000', 'x', 'queued', 'normal', ${before})`;
    await tx`UPDATE guesthub.reservations SET status = 'cancelled' WHERE id = ${ev.reservation_id}`;
    await delivery.cancelIneligibleDeliveries();
    const [msg] = await tx`SELECT status FROM guesthub.outbound_messages WHERE event_id = ${ev.id}`;
    eq(msg.status, "cancelled", "a queued reminder for a reservation cancelled after emission is cancelled");

    // the owner's eligibility table (decision 4)
    const st = (a, w) => [...triggers.TRIGGERS[id(a, w)].eligibleStatuses].sort();
    eq({
      beforeIn: st("check_in", "before"), onIn: st("check_in", "on"), afterIn: st("check_in", "after"),
      beforeOut: st("check_out", "before"), onOut: st("check_out", "on"), afterOut: st("check_out", "after"),
    }, {
      beforeIn: ["confirmed"], onIn: ["confirmed"], afterIn: ["checked_in", "confirmed"],
      beforeOut: ["checked_in", "confirmed"], onOut: ["checked_in", "confirmed"],
      afterOut: ["checked_in", "checked_out", "confirmed"],
    }, "eligible statuses per window (owner decision 4)");
    eq(onOut.includes("checked_out"), false, "on check-out never reaches a guest already marked checked_out");
    eq(triggers.TRIGGERS[id("check_out", "on")].defaultSendTime, "09:00", "on check-out defaults to 09:00");
    for (const w of ["before", "after"]) for (const a of ["check_in", "check_out"]) {
      const range = triggers.TRIGGERS[id(a, w)].offsetDays;
      eq([range?.min, range?.max], [1, 30], `${a}/${w} offset range is 1–30`);
    }
    eq(triggers.describeSchedule("check_out", "before", 1, "09:00"), "תישלח יום אחד לפני העזיבה בשעה 09:00",
      "the editor's Hebrew sentence");

    // D201 follow-up — the "on" option names its anchor; the other labels and
    // every id are unchanged (label only).
    eq(triggers.scheduleWhens("check_out").map((w) => [w.id, w.label]),
      [["before", "לפני"], ["on", "ביום העזיבה"], ["after", "אחרי"]], "\"מתי\" options under anchor = עזיבה");
    eq(triggers.scheduleWhens("check_in").map((w) => [w.id, w.label]),
      [["before", "לפני"], ["on", "ביום ההגעה"], ["after", "אחרי"]], "\"מתי\" options under anchor = הגעה");
    eq(triggers.describeSchedule("check_in", "on", 0, "09:00"), "תישלח ביום ההגעה בשעה 09:00",
      "the live sentence matches the \"on\" option");

    // D201 follow-up — switching windows lands on the NEW window's defaults,
    // whatever days/time the previous window held (owner-approved table).
    const expectDefaults = {
      "check_in/before": [3, "10:00"], "check_in/on": [0, "09:00"], "check_in/after": [1, "10:00"],
      "check_out/before": [1, "10:00"], "check_out/on": [0, "09:00"], "check_out/after": [1, "11:00"],
    };
    let state = { triggerType: id("check_in", "before"), offsetDays: 17, sendTime: "13:37" };
    for (const [cell, [days, time]] of Object.entries(expectDefaults)) {
      const [a, w] = cell.split("/");
      const next = triggers.nextTimingState({ ...state, offsetDays: 17, sendTime: "13:37" }, id(a, w));
      eq([next.triggerType, next.offsetDays, next.sendTime], [id(a, w), days, time], `switching to ${cell} resets to its default`);
      state = next;
    }
    // the exact path the operator walks: pre-arrival default (3) → "לפני עזיבה"
    const pre = triggers.nextTimingState({ triggerType: "reservation.confirmed", offsetDays: 0, sendTime: "10:00" }, id("check_in", "before"));
    const out = triggers.nextTimingState(pre, id("check_out", "before"));
    eq([pre.offsetDays, out.offsetDays], [3, 1], "pre-arrival's 3 days never leak into before-check-out");
    // an event trigger has no timing: values pass through untouched
    eq(triggers.nextTimingState({ triggerType: id("check_out", "on"), offsetDays: 0, sendTime: "09:00" }, "reservation.confirmed"),
      { triggerType: "reservation.confirmed", offsetDays: 0, sendTime: "09:00" }, "an event trigger keeps the values");
  });
  return fail;
}

process.exitCode = await proveWithRefutation(sql, out, scenario, [
  { name: "wrong sign on offset (after-windows look forward)",
    mutations: [["scheduler.js", "(${today} - ${offset})", "(${today} + ${offset})"]] },
  { name: "checked_out allowed on check-out day",
    mutations: [["triggers.js", `direction: "on",
        defaultSendTime: "09:00",
        eligibleStatuses: ["confirmed", "checked_in"]`, `direction: "on",
        defaultSendTime: "09:00",
        eligibleStatuses: ["confirmed", "checked_in", "checked_out"]`]] },
  { name: "window switch keeps the previous day count",
    mutations: [["triggers.js", "offsetDays: def.direction === \"on\" ? 0 : def.offsetDays?.default ?? 0,",
      "offsetDays: def.direction === \"on\" ? 0 : def.offsetDays && prev.offsetDays >= def.offsetDays.min && prev.offsetDays <= def.offsetDays.max ? prev.offsetDays : def.offsetDays?.default ?? 0,"]] },
  { name: "static \"ביום\" label (anchor ignored)",
    mutations: [["triggers.js", "label: `ביום ${anchorNoun(anchor)}`", "label: \"ביום\""]] },
  { name: "outside_stay guard removed",
    mutations: [["scheduler.js", "NOT (r.check_in <= ${today} AND ${today} < r.check_out)", "false"]] },
]);
