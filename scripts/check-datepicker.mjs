// Runnable check for the date-range picker (same pattern as check-calendar.mjs):
// compiles the pure modules AND the bulk-update schema, asserts the click
// semantics and the month grid, and asserts the reservation editors no longer
// carry a raw <input type="date"> for the stay dates.
// Usage: node scripts/check-datepicker.mjs
//
// D182 — the Group Update window is NIGHTS, exactly like a stay: mode="nights",
// "עד תאריך" is the check-OUT (EXCLUSIVE), and a zero-night range (to === from)
// is rejected by the schema itself. The reservations LIST FILTER is the one
// remaining mode="days" consumer, and it stays inclusive — locked below.
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure

const ROOT = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), "datepicker-"));
const out = join(tmp, "out");
// tsconfig (not a bare CLI call) because the schema reaches @/lib/dates through
// the path alias and pulls zod out of the repo's node_modules.
writeFileSync(
  join(tmp, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      module: "commonjs", moduleResolution: "node10", target: "es2022",
      esModuleInterop: true, skipLibCheck: true, strict: true,
      baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
      rootDir: join(ROOT, "src"), outDir: out,
      typeRoots: [join(ROOT, "node_modules/@types")], types: ["node"],
    },
    include: [
      join(ROOT, "src/lib/dates.ts"),
      join(ROOT, "src/lib/date-range.ts"),
      join(ROOT, "src/lib/date-range-picker.ts"),
      join(ROOT, "src/lib/reservations/stay-occupancy.ts"),
      join(ROOT, "src/lib/validation/rates.ts"),
    ],
  }),
);
execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });

const require = createRequire(join(ROOT, "package.json"));
// resolved BEFORE the hook is installed: require.resolve goes through
// _resolveFilename itself, so resolving inside the hook would recurse forever.
const BARE = { zod: require.resolve("zod") };
const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) {
    return origResolve.call(this, join(out, request.slice(2)), ...rest);
  }
  // the compiled output sits in a temp dir with no node_modules beside it
  if (BARE[request]) return BARE[request];
  return origResolve.call(this, request, ...rest);
};

const { pickRange, monthCells, shiftMonth, monthOf, firstOfMonth } = require(
  join(out, "lib/date-range.js"),
);
const { nightsBetween, addDays, eachDay, ratesWritableWindow } = require(
  join(out, "lib/dates.js"),
);
const { bulkUpdateRatesSchema } = require(join(out, "lib/validation/rates.js"));

// ---- click semantics ----
const empty = { start: null, end: null };
assert.deepEqual(pickRange(empty, "2026-07-10"), { start: "2026-07-10", end: null },
  "first click sets the check-in");
assert.deepEqual(
  pickRange({ start: "2026-07-10", end: null }, "2026-07-16"),
  { start: "2026-07-10", end: "2026-07-16" },
  "a later click sets the check-out",
);
assert.deepEqual(
  pickRange({ start: "2026-07-10", end: null }, "2026-07-04"),
  { start: "2026-07-04", end: null },
  "an earlier click re-anchors the check-in",
);
assert.deepEqual(
  pickRange({ start: "2026-07-10", end: null }, "2026-07-10"),
  { start: "2026-07-10", end: null },
  "same-day click cannot produce a zero-night stay (check-out is exclusive)",
);
assert.deepEqual(
  pickRange({ start: "2026-07-10", end: "2026-07-16" }, "2026-08-02"),
  { start: "2026-08-02", end: null },
  "a click on a complete range starts over",
);
// the picked range feeds the ONE hotel-night model
assert.equal(nightsBetween("2026-07-10", "2026-07-16"), 6, "10→16 July = 6 nights");

// ---- "days" semantics: the INCLUSIVE filter window (reservations list) ----
// D182 moved Group Update OFF this mode. The reservations list filter is the one
// consumer left, and there both ends are inclusive (data.ts: `>= from AND <= to`),
// so a single day is still a legal selection.
assert.deepEqual(
  pickRange({ start: "2026-07-13", end: null }, "2026-07-13", { allowSameDay: true }),
  { start: "2026-07-13", end: "2026-07-13" },
  "a filter window may be a single day",
);
assert.deepEqual(
  pickRange({ start: "2026-07-13", end: null }, "2026-07-12", { allowSameDay: true }),
  { start: "2026-07-12", end: null },
  "an earlier click still re-anchors the start in days mode",
);
assert.equal(
  nightsBetween("2026-07-13", "2026-08-11") + 1,
  30,
  "days mode counts the end date itself — 13/07–11/08 inclusive is 30 days",
);

// ---- month grid ----
const july = monthCells(2026, 6); // July 2026 starts on a Wednesday (offset 3)
assert.equal(july.length, 3 + 31, "3 leading blanks + 31 days");
assert.deepEqual(july.slice(0, 3), [null, null, null]);
assert.equal(july[3], "2026-07-01");
assert.equal(july.at(-1), "2026-07-31");
assert.equal(monthCells(2024, 1).filter(Boolean).length, 29, "leap February has 29 days");
assert.equal(monthCells(2026, 1).filter(Boolean).length, 28);
assert.deepEqual(shiftMonth({ year: 2026, month: 11 }, 1), { year: 2027, month: 0 },
  "December + 1 rolls the year");
assert.deepEqual(shiftMonth({ year: 2026, month: 0 }, -1), { year: 2025, month: 11 },
  "January − 1 rolls the year back");
assert.deepEqual(monthOf("2026-07-16"), { year: 2026, month: 6 });
assert.equal(firstOfMonth({ year: 2026, month: 6 }), "2026-07-01");

// ---- the editors actually use the picker ----
// The booking windows (create + edit) render StayEditor, and StayEditor renders
// the skill's <DateRangePicker> — not <DateRangeField>, which stays for the
// reservations filter and Group Update only.
const stay = readFileSync("src/components/reservations/StayEditor.tsx", "utf8");
const stayPicker = stay.match(/<DateRangePicker[\s\S]*?\n\s*\/>/);
assert.ok(stayPicker, "StayEditor renders the <DateRangePicker …/>");
assert.ok(!/<DateRangeField/.test(stay), "StayEditor no longer renders <DateRangeField>");
assert.ok(
  !/type="date"/.test(stay),
  "the raw <input type=\"date\"> stay dates are gone — the picker is the ONE date UI",
);
// Moving the dates must NOT unassign the room: an empty roomId fails staysValid,
// which locked "שמור שינויים" while the panel read "יש שינויים שלא נשמרו" — the
// operator could neither save nor understand why.
const onPicked = stayPicker?.[0].match(/onChange=\{([\s\S]*?)\}\n/);
assert.ok(onPicked, "StayEditor must wire the picker's onChange");
assert.match(
  onPicked?.[1] ?? "",
  /\(checkIn, checkOut\) => onChange\(\{ \.\.\.value, checkIn, checkOut \}\)/,
  "the picked range must be written into the stay draft as-is",
);
assert.ok(
  !/roomId/.test(onPicked?.[1] ?? "roomId"),
  "a date change must keep the assigned room — onChange may not touch roomId",
);
// owner decision 3: the typo guard rides on the picker's stepper, explicitly
assert.match(stayPicker?.[0] ?? "", /maxNights=\{NIGHTS_TYPO_GUARD\}/,
  "StayEditor passes the nights typo guard to the picker");
// owner decision 4: the picker's stepper is the ONE nights control — the
// separate "לילות" counter next to the trigger is gone
assert.ok(!/label="לילות"/.test(stay), "the separate nights counter is gone from StayEditor");
// …and an occupied room in the new window is SAID, not silently dropped
assert.match(stay, /roomTaken/, "an unavailable assigned room must raise a visible conflict");
assert.match(stay, /תפוס בתאריכים שנבחרו/, "the conflict must name the room and the dates");

// ============================================================
// <DateRangePicker> (the datePicker skill, ported) — BEHAVIOURAL, on the
// compiled pure module the component runs. These are the skill's own test
// cases, moved into this guard (D194: no vitest).
// ============================================================
const P = require(join(out, "lib/date-range-picker.js"));
const none = {};

// ---- range picking: the app's stay rule (check-out EXCLUSIVE, D32) ----
let r = P.pickDay(empty, "2026-10-04", none);
r = P.pickDay(r, "2026-10-06", none);
assert.deepEqual(r, { start: "2026-10-04", end: "2026-10-06" }, "4 → 6 Oct picks check-out = 06");
assert.equal(P.nightsOf(r), 2, "4 → 6 Oct = 2 nights (the 6th is the departure, not a night)");
assert.deepEqual(P.pickDay({ start: "2026-10-04", end: null }, "2026-10-04", none),
  { start: "2026-10-04", end: null }, "same-day click re-anchors — a zero-night stay is impossible");
assert.deepEqual(P.pickDay(r, "2026-10-20", none), { start: "2026-10-20", end: null },
  "a click on a complete range starts over");
assert.deepEqual(P.pickDay({ start: "2026-10-04", end: null }, "2026-10-08", { max: "2026-10-07" }),
  { start: "2026-10-04", end: null }, "a day past max cannot be picked");

// ---- nights stepper: check-in fixed, check-out moves ----
const two = { start: "2026-10-04", end: "2026-10-06" };
assert.deepEqual(P.setNightsRange(two, 3, none), { start: "2026-10-04", end: "2026-10-07" },
  "stepper 2 → 3 moves check-out to 07 and keeps check-in");
assert.deepEqual(P.setNightsRange(two, 0, none), { start: "2026-10-04", end: "2026-10-05" },
  "minimum is one night");
assert.deepEqual(P.setNightsRange(two, 30, none).end, "2026-11-03", "typed 30 → check-out 03/11");
assert.equal(P.setNightsRange(two, 99999, { maxNights: 3650 }).end, "2036-10-01",
  "maxNights clamps a typo (3650 nights from 04/10/2026)");
assert.equal(P.canIncNights(two, none), true, "no maxNights → [+] never locks");
assert.equal(P.canIncNights({ start: "2026-10-04", end: "2026-10-07" }, { maxNights: 3 }), false,
  "[+] locks at maxNights");
assert.equal(P.canDecNights({ start: "2026-10-04", end: "2026-10-05" }), false, "[−] locks at one night");
assert.deepEqual(P.setNightsRange({ start: null, end: null }, 3, none), { start: null, end: null },
  "no check-in → the stepper does nothing");
assert.equal(P.parseNights("30"), 30);
assert.equal(P.parseNights("0"), null, "0 keeps the previous value");
assert.equal(P.parseNights(""), null, "empty keeps the previous value");

// ---- dismiss semantics (owner decisions 1 + C: revert ONLY on Esc / ביטול / X) ----
const complete = { start: "2026-10-04", end: "2026-10-06" };
const half = { start: "2026-10-04", end: null };
assert.equal(P.dismissRestores("outside", complete), false,
  "outside click with a COMPLETE range does NOT restore the open value — the picked dates stay in the form");
assert.equal(P.dismissRestores("outside", half), true,
  "outside click with only a check-in drops back to the open value");
assert.equal(P.dismissRestores("cancel", complete), true, "Esc / ביטול / X restore the open value");
assert.equal(P.dismissRestores("close", complete), false, '"סגור" keeps the picked range');
assert.equal(P.dismissRestores("close", half), true, '"סגור" with only a check-in drops back too — one rule (owner decision C)');

// ---- the month model: the band ----
const ctx = { range: { start: "2026-10-04", end: "2026-10-10" }, effEnd: "2026-10-10", today: "2026-10-01", rules: none };
const [oct, nov] = P.buildMonths([{ year: 2026, month: 9 }, { year: 2026, month: 10 }], true, ctx);
const cell = (d) => oct.cells.find((c) => c.date === d);
assert.equal(cell("2026-10-04").band, "bs", "check-in cell starts the band");
assert.equal(cell("2026-10-07").band, "in");
assert.equal(cell("2026-10-10").band, "be", "check-out cell ends the band");
assert.equal(cell("2026-10-04").state, "sel");
assert.equal(cell("2026-10-10").state, "sel");
assert.equal(cell("2026-10-11").band, "");
assert.equal(cell("2026-10-01").state, "today");
assert.equal(cell("2026-10-04").label, "4 באוקטובר 2026", "aria-label is the full Hebrew date");
assert.equal(oct.cells.length, nov.cells.length, "desktop: both months get the same row count");
assert.equal(P.formatRangeText(ctx.range, "x"), "4 באוקטובר – 10 באוקטובר 2026");
assert.equal(P.nightsTitle(ctx.range), "6 לילות");

// ---- keyboard: RTL arrows and the month clamp ----
assert.equal(P.keyboardStep("ArrowLeft", "2026-10-31"), "2026-11-01", "← is the next day in RTL");
assert.equal(P.keyboardStep("PageDown", "2026-01-31"), "2026-02-28", "PageDown clamps 31/01 → 28/02");
assert.equal(P.keyboardStep("PageUp", "2026-03-31"), "2026-02-28");

// ---- placement: floats below, flips above, pins inside a short window ----
const a = { top: 100, bottom: 152, right: 1200, width: 600 };
assert.deepEqual(P.computePopoverPosition(a, 500, 1440, 900), { top: 168, left: 500, width: 700 });
assert.equal(P.computePopoverPosition({ ...a, top: 700, bottom: 752 }, 500, 1440, 900).top, 184,
  "no room below → opens above the field");
assert.equal(P.computePopoverPosition({ ...a, top: 300, bottom: 352 }, 800, 1440, 600).top, 16,
  "no room either way → pinned 16px inside the window");

// ---- the component RUNS this module — the wiring the rules above depend on ----
const picker = readFileSync("src/components/shared/DateRangePicker.tsx", "utf8");
const popover = readFileSync("src/components/shared/date-range-picker/DesktopPopover.tsx", "utf8");
// every close goes through dismissRestores; only a restoring dismissal writes the base
const dismissFn = picker.match(/const dismiss = \(kind: DismissKind, restoreFocus: boolean\) => \{([\s\S]*?)\n  \};/);
assert.ok(dismissFn, "DateRangePicker must own one dismiss(kind) handler");
assert.match(dismissFn?.[1] ?? "", /if \(dismissRestores\(kind, draft\)\) \{[\s\S]*?write\(base\)/,
  "the open value is written back ONLY when dismissRestores says so");
assert.match(picker, /onOutside=\{\(\) => dismiss\("outside", false\)\}/,
  'an outside press is dismissed as "outside" — never as a cancel');
assert.match(picker, /onCommit=\{\(\) => dismiss\("close", true\)\}/, '"סגור" is dismissed as "close"');
const pointer = popover.match(/const onPointerDown = \(e: PointerEvent\) => \{([\s\S]*?)\n    \};/);
assert.ok(pointer, "the popover must own a pointerdown handler");
assert.match(pointer?.[1] ?? "", /outsideRef\.current\(\)/, "pointerdown outside calls onOutside");
assert.ok(!/onCancel/.test(pointer?.[1] ?? "onCancel"), "pointerdown outside never calls onCancel (the restore)");
// owner decision C: the mobile sheet's backdrop (and drag-down) is an OUTSIDE close —
// a complete range stays in the form; only Esc / ביטול / X restore.
const sheet = readFileSync("src/components/shared/date-range-picker/MobileSheet.tsx", "utf8");
assert.match(sheet, /className="drp-backdrop" onClick=\{onOutside\}/,
  "the sheet backdrop is an outside close — it must NOT restore a complete range");
const drag = sheet.match(/const onTouchMove = [\s\S]*?\n  \};/)?.[0] ?? "";
assert.match(drag, /onOutside\(\)/, "dragging the sheet down is an outside close");
assert.ok(!/onCancel/.test(drag), "dragging the sheet down never calls onCancel (the restore)");
const sheetJsx = picker.match(/<MobileSheet[\s\S]*?\/>/)?.[0] ?? "";
assert.match(sheetJsx, /onOutside=\{\(\) => dismiss\("outside", true\)\}/,
  'the sheet\'s outside close is dismissed as "outside" — never as a cancel');
assert.ok(!/dismiss\("cancel"[^)]*\)\s*:\s*openPicker/.test(picker),
  "a second press on the trigger is not a cancel — only Esc / ביטול / X restore");
// write-through: a complete range reaches the form; a half range never does
const writeFn = picker.match(/const write = \(next: DraftRange\) => \{([\s\S]*?)\n  \};/);
assert.match(writeFn?.[1] ?? "", /if \(next\.start && next\.end\) onChange\(next\.start, next\.end\)/,
  "write-through: only a COMPLETE range is passed to onChange");
assert.match(picker, /pick: \(d: DateOnly\) => write\(pickDay\(/, "a day click goes through write()");
assert.match(picker, /write\(setNightsRange\(draft, n, rules\)\)/, "the stepper goes through write()");

// ---- one date semantics: no Date-object math in the picker (D32) ----
for (const f of [
  "src/lib/date-range-picker.ts",
  "src/components/shared/DateRangePicker.tsx",
  "src/components/shared/date-range-picker/DesktopPopover.tsx",
  "src/components/shared/date-range-picker/MobileSheet.tsx",
  "src/components/shared/date-range-picker/MonthGrid.tsx",
  "src/components/shared/date-range-picker/NightsStepper.tsx",
]) {
  const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/\bnew Date\b|\bDate\.(UTC|now|parse)\b|toISOString|getFullYear|getMonth\(|getDate\(/.test(code),
    `${f}: no Date-object math — dates go through src/lib/dates.ts / date-range.ts`);
}
// D71: today / the month in view are computed on open, never during render
assert.match(picker, /const openPicker = \(\) => \{[\s\S]*?todayInTz\([\s\S]*?setToday\(now\)[\s\S]*?setView\(/,
  "today and the first month are computed when the picker opens (D71)");
assert.match(picker, /useState<DateOnly \| null>\(null\)/, "today starts null — nothing clock-derived renders on the server");

// ---- WRITE-THROUGH: a picked range reaches the form without a second commit ----
// The picker used to hold the range as a local draft until "החל" was clicked, so
// an operator who picked dates and pressed "שמור שינויים" saved the OLD dates and
// saw nothing change (audit_logs: before === after). The pick handler itself must
// call onApply, and no button may be the sole path to the form.
const field = readFileSync("src/components/shared/DateRangeField.tsx", "utf8");
const pickFn = field.match(/const pick = \(d: DateOnly\) => \{([\s\S]*?)\n  \};/);
assert.ok(pickFn, "DateRangeField must own a pick handler");
assert.match(
  pickFn[1],
  /if \(next\.start && next\.end\) onApply\(next\.start, next\.end\)/,
  "a completed range must be written to the form the moment it is picked",
);
assert.ok(
  !/>\s*החל\s*</.test(field),
  'no "החל" button: a picker inside a form may not carry a second commit step',
);
// the day cells go through pick() — never straight into local state
assert.ok(
  !/onPick=\{\(d\) => setRange/.test(field),
  "the month grid must pick through the write-through handler, not setRange",
);

// ---- Group Update (rates) uses the SAME picker, in NIGHTS mode (D182) ----
const gu = readFileSync("src/app/(dashboard)/rates/GroupUpdatePanel.tsx", "utf8");
assert.ok(/<DateRangeField/.test(gu), "Group Update must render the canonical picker");
assert.ok(
  !/type="date"/.test(gu),
  'the raw <input type="date"> dates are gone from Group Update too',
);
// (a) a hotel sells NIGHTS: the window is stay-shaped, its end is the check-out.
// Asserted on the ELEMENT, not the file — a comment saying "nights" must not be
// able to satisfy this while the attribute says otherwise.
const guPicker = gu.match(/<DateRangeField[\s\S]*?\/>/);
assert.ok(guPicker, "Group Update must render a self-closing <DateRangeField …/>");
assert.match(
  guPicker[0],
  /mode="nights"/,
  'a Group Update window is NIGHTS — "עד תאריך" is the check-out, exclusive (D182)',
);
assert.ok(
  !/mode="days"/.test(guPicker[0]),
  "Group Update may not fall back to the inclusive days mode (D182)",
);
assert.match(gu, /min=\{minDate\}/, "the picker must be clamped to the writable horizon");
// D182: the ceiling is the check-OUT ceiling, one day past the horizon — see the
// reachability assertion at the end of this file.
assert.match(gu, /max=\{maxCheckOut\}/, "the picker must be clamped to the writable horizon");
// the picked window must feed the SAME state the bulk action sends
const guApply = gu.match(/onApply=\{\(f, t\) => \{([\s\S]*?)\n\s*\}\}/);
assert.ok(guApply, "Group Update must wire onApply");
assert.match(guApply[1], /setDateFrom\(/, "the picked start must become dateFrom");
assert.match(guApply[1], /setDateTo\(/, "the picked end must become dateTo");
// the preview must not under-report a window the grid never loaded: with the
// picker it is easy to select dates outside the visible table, and those cells
// used to be silently counted as "nothing will change" ("0 תאים ייסגרו" while
// three really closed).
assert.match(gu, /unknown\+\+/, "cells outside the loaded grid window must be counted, not skipped");
assert.match(
  gu,
  /מחוץ לחלון המוצג בטבלה/,
  "the preview must SAY that out-of-window cells will be updated without a preview",
);

// ---- (b) D182: the SERVER expands the window as nights, half-open [from, to) ----
const rateActions = readFileSync("src/app/(dashboard)/rates/actions.ts", "utf8");
assert.match(
  rateActions,
  /const allDays = eachDay\(input\.dateFrom, input\.dateTo\);/,
  "bulkUpdateRatesAction expands [dateFrom, dateTo) — dateTo is a check-out, not a night",
);
assert.ok(
  !/addDays\(\s*input\.dateTo/.test(rateActions),
  "the +1 that turned the end date into a night is gone — dateTo is never shifted (D182)",
);

// ---- (c) D182: the schema itself rejects a zero-night window (BEHAVIOURAL) ----
// Evaluated, not regexed: the rule has to hold in the compiled schema, whatever
// shape the source takes.
const bulkBase = {
  sellableUnitIds: ["8f1f0b6a-0000-4000-8000-000000000001"],
  stopSell: true,
};
const zeroNights = bulkUpdateRatesSchema.safeParse({
  ...bulkBase, dateFrom: "2026-09-20", dateTo: "2026-09-20",
});
assert.equal(
  zeroNights.success,
  false,
  "dateTo === dateFrom is ZERO nights and the schema must reject it (D182)",
);
assert.ok(
  !zeroNights.success &&
    zeroNights.error.issues.some((i) =>
      /תאריך הסיום חייב להיות אחרי תאריך ההתחלה/.test(i.message),
    ),
  "the rejection must SAY the end date has to come after the start",
);
const oneNight = bulkUpdateRatesSchema.safeParse({
  ...bulkBase, dateFrom: "2026-09-20", dateTo: "2026-09-21",
});
assert.equal(oneNight.success, true, "20/09 → 21/09 is ONE night and must parse");
const inverted = bulkUpdateRatesSchema.safeParse({
  ...bulkBase, dateFrom: "2026-09-21", dateTo: "2026-09-20",
});
assert.equal(inverted.success, false, "an inverted window must still be rejected");

// ---- (d) D182 regression lock: the reservations LIST FILTER stays days-mode ----
// It is a date filter, not a stay: both ends inclusive, a single day legal.
const resScreen = readFileSync(
  "src/app/(dashboard)/reservations/ReservationsScreen.tsx",
  "utf8",
);
const resPicker = resScreen.match(/<DateRangeField[\s\S]*?\/>/);
assert.ok(resPicker, "the reservations list must render a self-closing <DateRangeField …/>");
assert.match(
  resPicker[0],
  /mode="days"/,
  'the reservations filter is an inclusive window and must keep mode="days" (D182)',
);

// ---- D182: the LAST writable night stays reachable — the check-out may be horizon+1 ----
// Capping dateTo at `latest` (correct while it WAS a night) would silently drop the
// night of `latest`, because reaching it now needs a check-out of latest + 1.
// The horizon window itself is evaluated; the two ceilings that must honour it are
// read from source — the server cap needs a tenant clock and a DB, and the panel is
// a React component, so neither is runnable here.
const { latest } = ratesWritableWindow("2026-09-10");
const lastNight = eachDay(latest, addDays(latest, 1));
assert.ok(
  lastNight.length === 1 &&
    lastNight[0] === latest &&
    /input\.dateTo > addDays\(latest, 1\)/.test(rateActions) &&
    /const maxCheckOut = addDays\(maxDate, 1\)/.test(gu) &&
    /max=\{maxCheckOut\}/.test(gu),
  "the last writable night stays reachable: server cap AND picker ceiling allow a check-out of horizon + 1 (D182)",
);

// the dead CSS of the inputs it replaced must be gone (iron rule #11)
const guCss = readFileSync("src/app/styles/group-update.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
assert.ok(
  !/\.gu-range-field|\.gu-range-separator/.test(guCss),
  "the replaced date inputs' CSS must be deleted, not left orphaned",
);

// ============================================================
// TAKEN NIGHTS in the booking windows' picker (owner decisions 1–7) —
// BEHAVIOURAL, on the compiled modules StayEditor and the server action run.
// ============================================================
const O = require(join(out, "lib/reservations/stay-occupancy.js"));
const ROOM = "room-a";
const win = { from: "2026-10-01", to: "2026-12-01" };
const stayRow = (id, ci, co, status = "confirmed", room = ROOM) =>
  ({ room_id: room, reservation_id: id, check_in: ci, check_out: co, status });
const takenOf = (stays, closures = [], excludeReservationId) =>
  O.roomTakenNights({ roomId: ROOM, stays, closures, window: win, excludeReservationId });

// decision 2: a NIGHT is painted; the booking's check-out day is free (D32)
assert.deepEqual(takenOf([stayRow("r1", "2026-10-10", "2026-10-13")]),
  ["2026-10-10", "2026-10-11", "2026-10-12"],
  "a booking 10→13 paints the nights 10, 11, 12 — and NOT its check-out day 13");
// decision 3: every status but cancelled (D126); OOO closures, never OOS (040 §8)
assert.deepEqual(takenOf([stayRow("r2", "2026-10-20", "2026-10-22", "cancelled")]), [],
  "a cancelled reservation paints nothing");
for (const st of ["draft", "confirmed", "checked_in", "checked_out", "no_show", "blocked"]) {
  assert.equal(takenOf([stayRow("r3", "2026-10-20", "2026-10-21", st)]).length, 1,
    `a '${st}' reservation holds its night (every status but cancelled, D126)`);
}
const clo = (kind) => ({ id: `c-${kind}`, room_id: ROOM, start_date: "2026-11-02", end_date: "2026-11-04", kind });
assert.deepEqual(takenOf([], [clo("ooo")]), ["2026-11-02", "2026-11-03"],
  "an OOO closure paints its nights, end date exclusive");
assert.deepEqual(takenOf([], [clo("oos")]), [], "an OOS closure is sellable and paints nothing");
assert.deepEqual(takenOf([stayRow("r4", "2026-10-10", "2026-10-11", "confirmed", "room-b")]), [],
  "another room's booking paints nothing");
// decision 4: the edited reservation never paints itself — its neighbour still does
assert.deepEqual(
  takenOf([stayRow("edited", "2026-10-05", "2026-10-08"), stayRow("other", "2026-10-08", "2026-10-09")], [], "edited"),
  ["2026-10-08"],
  "the reservation being edited is excluded; the next guest's night (its old check-out day) stays painted",
);
assert.deepEqual(takenOf([stayRow("r5", "2026-09-28", "2026-10-02")]), ["2026-10-01"],
  "nights outside the requested window are clipped off");
// decision 6: another card of the SAME unsaved form on the same room paints too
const sib = O.withSiblingNights(["2026-10-01"], ROOM, [
  { roomId: ROOM, checkIn: "2026-10-15", checkOut: "2026-10-17" },
  { roomId: "room-b", checkIn: "2026-10-20", checkOut: "2026-10-22" },
  { roomId: ROOM, checkIn: "2026-10-25", checkOut: "" },
]);
assert.deepEqual([...sib].sort(), ["2026-10-01", "2026-10-15", "2026-10-16"],
  "a sibling card on the same room paints its nights; another room's card or a half range does not");
assert.equal(O.withSiblingNights([], "", [{ roomId: "", checkIn: "2026-10-15", checkOut: "2026-10-17" }]).size, 0,
  "no room chosen → nothing painted (decision 5: StayEditor has no room-type field)");
// decision 1: the warning reads the same set — and a stay ENDING on a taken
// night does not sleep through it
const busy = new Set(["2026-10-10", "2026-10-11"]);
assert.equal(O.rangeHasTakenNight(busy, "2026-10-08", "2026-10-12"), true,
  "a range across a taken night raises the warning");
assert.equal(O.rangeHasTakenNight(busy, "2026-10-06", "2026-10-10"), false,
  "checking OUT on a taken night is no collision — no warning");
assert.equal(O.rangeHasTakenNight(busy, "2026-10-12", "2026-10-14"), false, "a free range: no warning");
// decision 1: VISUAL ONLY — a taken day is painted, not disabled, and a click
// on it still picks
const occCtx = { range: empty, effEnd: null, today: "2026-10-01", rules: none, occupied: busy };
const occCell = P.buildCell("2026-10-10", occCtx);
assert.ok(occCell.occupied && !occCell.disabled, "a taken night is painted but stays selectable");
assert.equal(P.buildCell("2026-10-12", occCtx).occupied, false, "a free night is not painted");
assert.deepEqual(P.pickDay(P.pickDay(empty, "2026-10-09", none), "2026-10-12", none),
  { start: "2026-10-09", end: "2026-10-12" }, "a range ACROSS taken nights can be picked");
// …and the warning never gates the save: it is rendered, and read nowhere else
assert.equal((stay.match(/\bcrossesTaken\b/g) ?? []).length, 2,
  "crossesTaken is computed once and only rendered — never part of validity or save");
for (const f of ["src/components/reservations/BookingPanel.tsx", "src/components/reservations/EditReservationPanel.tsx"]) {
  const src = readFileSync(f, "utf8");
  assert.ok(!/takenNights|crossesTaken|rangeHasTakenNight|getRoomTakenNights/.test(src),
    `${f}: taken nights never reach the save gate`);
  assert.match(src, /siblings=\{stays\.filter\(\(x\) => x\.key !== s\.key\)\}/,
    `${f}: the other cards are passed in (decision 6)`);
}
// wiring: StayEditor paints from the fetched set, loads on the shown months, and
// the edit window's id travels to the action
assert.match(stayPicker?.[0] ?? "", /occupiedNights=\{takenNights\}/, "the picker paints the taken set");
assert.match(stayPicker?.[0] ?? "", /onMonthsShown=\{loadTaken\}/, "the picker loads on the months it shows");
assert.match(stay, /getRoomTakenNightsAction\(\{ roomId, from, to, excludeReservationId \}\)/,
  "the edit window's reservation id reaches the server action");
// tenant isolation: the action reads the tenant from the session, never from args
const ra = readFileSync("src/app/(dashboard)/reservations/actions.ts", "utf8");
const takenAction = ra.match(/export async function getRoomTakenNightsAction[\s\S]*?\n}\n/)?.[0] ?? "";
assert.ok(/const actor = await getActor\(\)/.test(takenAction) &&
  (takenAction.match(/tenant_id = \$\{actor\.tenantId\}/g) ?? []).length === 2 &&
  !/args\.tenantId|tenantId:/.test(takenAction),
  "getRoomTakenNightsAction scopes BOTH queries by the session tenant only");
// decision 7: the closure calendar's look, its own dot, no new colour
const drpCss = readFileSync("src/app/styles/date-range-picker.css", "utf8");
assert.match(drpCss, /--drp-occ-bg: color-mix\(in srgb, var\(--danger\) 10%, var\(--surface\)\)/,
  "taken-night background = the closure calendar's mix");
assert.match(drpCss, /--drp-occ-ink: color-mix\(in srgb, var\(--danger\) 78%, var\(--ink\)\)/,
  "taken-night number = the closure calendar's mix");
const mg = readFileSync("src/components/shared/date-range-picker/MonthGrid.tsx", "utf8");
assert.match(mg, /c\.occupied && <span className="cp-dot" \/>/, "the dot is the closure calendar's .cp-dot");
const cssNoComments = drpCss.replace(/\/\*[\s\S]*?\*\//g, "");
assert.ok(cssNoComments.indexOf(".drp-cell.drp-occ") < cssNoComments.indexOf(".drp-cell.drp-in") &&
  cssNoComments.indexOf(".drp-d.drp-occ") < cssNoComments.indexOf(".drp-d.drp-sel"),
  "selection wins over a taken night (declared after it)");

console.log(
  "✓ datepicker: click semantics (nights + days), month grid, DateRangePicker (stepper, dismiss, band, placement, wiring), StayEditor and Group Update wiring, taken nights (paint, exclude, siblings, warning)",
);
