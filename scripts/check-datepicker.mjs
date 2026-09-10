// Runnable check for the date-range picker (same pattern as check-calendar.mjs):
// compiles the pure modules AND the bulk-update schema, asserts the click
// semantics and the month grid, and asserts the reservation editors no longer
// carry a raw <input type="date"> for the stay dates.
// Usage: node scripts/check-datepicker.mjs
//
// D181 — the Group Update window is NIGHTS, exactly like a stay: mode="nights",
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
const { nightsBetween } = require(join(out, "lib/dates.js"));
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
// D181 moved Group Update OFF this mode. The reservations list filter is the one
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
const stay = readFileSync("src/components/reservations/StayEditor.tsx", "utf8");
assert.ok(/<DateRangeField/.test(stay), "StayEditor renders the picker");
assert.ok(
  !/type="date"/.test(stay),
  "the raw <input type=\"date\"> stay dates are gone — the picker is the ONE date UI",
);
// Moving the dates must NOT unassign the room: an empty roomId fails staysValid,
// which locked "שמור שינויים" while the panel read "יש שינויים שלא נשמרו" — the
// operator could neither save nor understand why.
const onApply = stay.match(/onApply=\{([\s\S]*?)\n\s*\/>/);
assert.ok(onApply, "StayEditor must wire the picker's onApply");
assert.ok(
  !/roomId/.test(onApply[1]),
  "a date change must keep the assigned room — onApply may not touch roomId",
);
// …and an occupied room in the new window is SAID, not silently dropped
assert.match(stay, /roomTaken/, "an unavailable assigned room must raise a visible conflict");
assert.match(stay, /תפוס בתאריכים שנבחרו/, "the conflict must name the room and the dates");

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

// ---- Group Update (rates) uses the SAME picker, in NIGHTS mode (D181) ----
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
  'a Group Update window is NIGHTS — "עד תאריך" is the check-out, exclusive (D181)',
);
assert.ok(
  !/mode="days"/.test(guPicker[0]),
  "Group Update may not fall back to the inclusive days mode (D181)",
);
assert.match(gu, /min=\{minDate\}/, "the picker must be clamped to the writable horizon");
assert.match(gu, /max=\{maxDate\}/, "the picker must be clamped to the writable horizon");
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

// ---- (b) D181: the SERVER expands the window as nights, half-open [from, to) ----
const rateActions = readFileSync("src/app/(dashboard)/rates/actions.ts", "utf8");
assert.match(
  rateActions,
  /const allDays = eachDay\(input\.dateFrom, input\.dateTo\);/,
  "bulkUpdateRatesAction expands [dateFrom, dateTo) — dateTo is a check-out, not a night",
);
assert.ok(
  !/addDays\(\s*input\.dateTo/.test(rateActions),
  "the +1 that turned the end date into a night is gone — dateTo is never shifted (D181)",
);

// ---- (c) D181: the schema itself rejects a zero-night window (BEHAVIOURAL) ----
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
  "dateTo === dateFrom is ZERO nights and the schema must reject it (D181)",
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

// ---- (d) D181 regression lock: the reservations LIST FILTER stays days-mode ----
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
  'the reservations filter is an inclusive window and must keep mode="days" (D181)',
);

// the dead CSS of the inputs it replaced must be gone (iron rule #11)
const guCss = readFileSync("src/app/styles/group-update.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
assert.ok(
  !/\.gu-range-field|\.gu-range-separator/.test(guCss),
  "the replaced date inputs' CSS must be deleted, not left orphaned",
);

console.log(
  "✓ datepicker: click semantics (nights + days), month grid, StayEditor and Group Update wiring",
);
