#!/usr/bin/env node
// ============================================================
// check:closure-panel-ux — the room-closure FORM, as an operator meets it.
//
// THE DEFECTS THIS EXISTS FOR, all four measured by the owner on main:
//
//   1. The wizard's closure shortcut opened the form ON TOP of the half-filled
//      booking wizard. The closure saved — and the wizard was still there
//      underneath, red required-field marks and all, so a person who wanted to
//      close a room was left believing they now had to finish a reservation.
//      Two different jobs; the shortcut must LEAVE the first one. The owner's
//      ruling since: the shortcut is GONE, which is the strongest form of that —
//      a route that does not exist cannot stack. §1 now guards the removal, and
//      that both boards keep a real door of their own.
//   2. That same route threw the operator's context away. A calendar drag had
//      just named the room and the exact nights; the closure form opened blank
//      and asked for the room again. The surviving routes still carry context,
//      including the whole row when an EXISTING closure is opened.
//   3. The date fields answered only their own indicator glyph. Clicking the
//      rest of the box — most of its area — did nothing, which reads as a dead
//      control, and it is the same click that works everywhere else.
//   4. Nothing stopped "עד תאריך" from landing on or before "מתאריך". The
//      server rejects it, so the operator learned about a zero-night closure
//      from a red toast after the save.
//
// Runtime where it can be (closureMinEnd is compiled and CALLED over the
// boundaries date arithmetic actually breaks on), static where it cannot (a
// React component's state machine needs a browser to run).
// No DB, no network, no build.
// D127 collect-all: every failure is reported, then the guard fails once.
// Usage: node scripts/check-closure-panel-ux.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

// ---- compile the real pure module, same harness as check:closure-ux ----
const tmp = mkdtempSync(join(tmpdir(), "gh-closurepanel-"));
const out = join(tmp, "out");
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
      join(ROOT, "src/lib/closures/categories.ts"),
      join(ROOT, "src/lib/closures/occupancy.ts"),
    ],
  }),
);
execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });

const req = createRequire(join(ROOT, "package.json"));
const Module = req("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) return origResolve.call(this, join(out, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};
const { closureMinEnd, closureLastNight } = req(join(out, "lib/closures/categories.js"));
const { pickNight } = req(join(out, "lib/closures/occupancy.js"));

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const BOOKING = "src/components/reservations/BookingPanel.tsx";
const PANEL = "src/app/(dashboard)/calendar/ClosurePanel.tsx";
const GRID = "src/app/(dashboard)/calendar/CalendarGrid.tsx";
const SCREEN = "src/app/(dashboard)/calendar/CalendarScreen.tsx";

const booking = stripComments(read(BOOKING));
const panel = stripComments(read(PANEL));
const grid = stripComments(read(GRID));

/** the text from `marker` (which must end in "{") to its matching brace */
function braceBlock(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) return "";
  let depth = 1;
  let i = at + marker.length;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
  }
  return src.slice(at, i);
}

// ============================================================
// 1. The wizard has NO closure door at all — the strongest form of "it never
//    stacks", and the owner's ruling this run
// ============================================================
{
  // The shortcut is gone, with everything it needed: the decision function, the
  // parked-context ref, the mounted form and the permission flag. Defect 1 above
  // was "the form opened on top of a half-filled wizard"; a route that does not
  // exist cannot stack, cannot throw context away, and cannot raise an
  // unsaved-changes question about a form nobody typed in.
  for (const token of [
    "openClosureShortcut",
    "closureAfterDiscard",
    "closurePrefill",
    "ClosurePanel",
    "headerActions=",
    "bw-close-room",
    "canClose",
  ]) {
    assert.doesNotMatch(booking, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `the create wizard carries no ${token} — closing a room is an act of the calendar, and it has its own doors there`);
  }

  // …and those doors are real, on BOTH boards. This is what makes the removal a
  // simplification rather than a deletion of the capability.
  const screen = stripComments(read(SCREEN));
  assert.match(screen, /className="cb-hd-close"/,
    "the desktop tree carries a 'חסימת חדר' header button");
  assert.match(screen, /className="cb-m-close"/,
    "…and so does the mobile tree");
  assert.match(grid, /סגור חדר/,
    "…and the desktop grid's right-click menu still offers סגור חדר on the cell under the cursor");
  // all of them open the ONE form, from the board's own panel state
  assert.match(screen, /<ClosurePanel\s+open=\{panel\?\.kind === "closure"\}/,
    "every door opens the same ClosurePanel, held by the board — one closure form in the app");

  ok("the wizard has no closure shortcut to stack, and both boards carry a real door to the one closure form");
}

// ============================================================
// 2. Opening from context arrives with the room and the dates already in
// ============================================================
{
  // the calendar's own context route prefills — it always did, and this
  // guard is what keeps it that way while the panel's props move around
  assert.match(grid, /onNewClosure\(\{ roomId: menu\.roomId, startDate: menu\.date, endDate: addDays\(menu\.date, 1\) \}\)/,
    "the board's right-click 'סגור חדר' sends the room and a one-night range from the cell under the cursor");

  // …and opening an EXISTING closure hands over the whole row, from either
  // board, through ONE translation — a second copy is how the desktop bar and
  // the mobile card start disagreeing about what they are editing.
  assert.match(panel, /export function closureEditOf\(c: CalendarClosure, room: CalendarRoom\): ClosureEdit/,
    "closureEditOf is the one board-row → edit-payload translation");
  for (const [field, why] of [
    ["id: c.id", "the closure being edited"],
    ["roomId: c.room_id", "its room"],
    ["startDate: c.start_date", "its start"],
    ["endDate: c.end_date", "its exclusive end"],
    ["category: c.category", "its category"],
    ["reason: c.reason", "its free text"],
  ]) {
    assert.ok(panel.includes(field), `…carrying ${why} (${field})`);
  }
  const screen = stripComments(read(SCREEN));
  assert.match(grid, /onEditClosure\(closureEditOf\(c, room\)\)/,
    "the desktop bar opens the panel through it");
  assert.match(screen, /edit: closureEditOf\(closure, room\)/,
    "…and the mobile board through the very same function");

  // …and the form actually SEEDS from what it is handed
  assert.match(panel, /setRoomId\(edit\?\.roomId \?\? prefill\.roomId/,
    "the form seeds its room from the prefill");
  assert.match(panel, /setStartDate\(edit\?\.startDate \?\? prefill\.startDate/, "…its start date");
  assert.match(panel, /setEndDate\(edit\?\.endDate \?\? prefill\.endDate/, "…and its end date");

  ok("every context-carrying route hands the form a room and a range — a new closure from the cell it was drawn on, an existing one whole, through one translation used by both boards");
}

// ============================================================
// 3. A closure can never be zero nights — now proven on the CALENDAR
//
//    The rule did not change; the control did. There is no "עד תאריך (לא
//    כולל)" field left to floor, because the operator no longer types a
//    checkout boundary: they click NIGHTS, and the panel converts the last one
//    into the stored exclusive end through the same one function.
// ============================================================
{
  // ---- the floor is a REAL function and it is run here, not described ----
  assert.equal(closureMinEnd("2026-08-21"), "2026-08-22",
    "the earliest end of a closure starting 21.08 is 22.08 — exactly one night stored");
  assert.equal(closureMinEnd("2026-08-31"), "2026-09-01",
    "…and it crosses a month boundary rather than producing 2026-08-32");
  assert.equal(closureMinEnd("2026-12-31"), "2027-01-01",
    "…and a year boundary");
  assert.equal(closureMinEnd("2028-02-28"), "2028-02-29",
    "…and it knows 2028 is a leap year, so the offered floor is a day that exists");
  assert.equal(closureLastNight(closureMinEnd("2026-08-21")), "2026-08-21",
    "the floor and the display rule are inverses: the shortest legal closure's last night IS its start");

  // ---- and the pick transition can never produce a range shorter than that ----
  const one = pickNight(null, "2026-08-21");
  assert.deepEqual(one, { start: "2026-08-21", lastNight: "2026-08-21", pending: true },
    "the FIRST click opens a one-night range — never an empty one waiting for a second date");
  assert.equal(closureMinEnd(one.lastNight), "2026-08-22",
    "…which stores as exactly one night");
  assert.deepEqual(pickNight(one, "2026-08-25"),
    { start: "2026-08-21", lastNight: "2026-08-25", pending: false },
    "the SECOND click sets the last night, forward of the start");
  assert.deepEqual(pickNight(one, "2026-08-18"),
    { start: "2026-08-18", lastNight: "2026-08-18", pending: true },
    "a click BEHIND the start re-anchors instead of producing an inverted range — the zero/negative range the old two-field form could hold has no representation here");
  assert.deepEqual(pickNight({ start: "2026-08-21", lastNight: "2026-08-25", pending: false }, "2026-08-30"),
    { start: "2026-08-30", lastNight: "2026-08-30", pending: true },
    "a click on a COMPLETE range starts a new one — so a range is only ever built forward");

  // ---- and the form is the caller, in both directions ----
  assert.match(panel, /setEndDate\(closureMinEnd\(next\.lastNight\)\)/,
    "the picked last night becomes the stored EXCLUSIVE end through that one function — the '+1 night' arithmetic is not retyped in the form");
  assert.match(panel, /setEndDate\(closureMinEnd\(p\.lastNight\)\)/,
    "…and so does a preset chip's range");
  assert.match(panel, /const lastNight = endDate && endDate > startDate \? closureLastNight\(endDate\) : ""/,
    "…and it is read back through the INVERSE function, so the calendar paints the last closed night and never the boundary after it");
  assert.doesNotMatch(panel, /addDays\(\s*(endDate|startDate|lastNight)/,
    "no call site does the boundary arithmetic by hand");

  // the schema still owns the rule — the UI is the courtesy, not the gate
  const validation = read("src/lib/validation/reservation.ts");
  assert.match(validation, /endDate > s\.startDate/,
    "closureSchema/closureUpdateSchema still enforce at-least-one-night server-side — the form's shape is UX, and UX is never the guard");

  ok("a zero-night closure has no representation in the picker at all, proven by running the pick transition and closureMinEnd across month, year and leap boundaries — with the server rule untouched");
}

// ============================================================
// 4. There is no native date field left to click in the wrong place
//
//    Defect 3 was "clicking the box does nothing; only the little indicator
//    glyph opens the picker". The owner's ruling replaced the control rather
//    than repairing it: <input type="date"> is BANNED in this panel — its
//    indicator lands on the wrong side in RTL, it shows no conflicts, and
//    "עד תאריך לא כולל" is not a thing an operator thinks in. A control that
//    does not exist cannot answer in one place out of ten.
// ============================================================
{
  assert.doesNotMatch(panel, /type="date"/,
    "the closure panel carries NO native date input — the dates come off the calendar");
  assert.doesNotMatch(panel, /showPicker/,
    "…and therefore no native-picker opener to route a click through");
  assert.match(panel, /<ClosureCalendar/,
    "the calendar IS the date control");
  const cal = stripComments(read("src/app/(dashboard)/calendar/ClosureCalendar.tsx"));
  assert.match(cal, /onClick=\{\(\) => onPick\(d\)\}/,
    "…and every day in it is a real button with the whole cell as its target, not a glyph");
  assert.match(cal, /const cls = \[\s*"cp-day",/,
    "…dressed by the panel's own stylesheet, where the 44px cell height is declared");
  assert.match(cal, /className=\{cls\}/, "…and that is the class the cell actually wears");
  const css = read("src/app/styles/closure-panel.css");
  const dayAt = css.indexOf("  .cp-day {");
  assert.ok(dayAt > -1, "the day cell's rule was located");
  assert.match(css.slice(dayAt, css.indexOf("}", dayAt)), /height:\s*44px/,
    "…and it is 44px tall — iron rule #6, on the control an operator taps most in this panel");
  ok("the panel has no native date field to mis-click: the control is a calendar of 44px day buttons");
}

console.log(`\nAll ${n} closure-panel claim groups hold.`);
