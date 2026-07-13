// Runnable check for the stay date-range picker (same pattern as
// check-calendar.mjs): compiles the pure module, asserts the click semantics and
// the month grid, and asserts the reservation editors no longer carry a raw
// <input type="date"> for the stay dates. Usage: node scripts/check-datepicker.mjs
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const out = mkdtempSync(join(tmpdir(), "datepicker-"));
execSync(
  `pnpm exec tsc src/lib/dates.ts src/lib/date-range.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const { pickRange, monthCells, shiftMonth, monthOf, firstOfMonth } = require(
  join(out, "date-range.js"),
);
const { nightsBetween } = require(join(out, "dates.js"));

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

console.log("✓ datepicker: click semantics, month grid and StayEditor wiring");
