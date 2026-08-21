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
//      Two different jobs; the shortcut must LEAVE the first one.
//   2. That same route threw the operator's context away. A calendar drag had
//      just named the room and the exact nights; the closure form opened blank
//      and asked for the room again.
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
    include: [join(ROOT, "src/lib/closures/categories.ts")],
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

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const BOOKING = "src/components/reservations/BookingPanel.tsx";
const PANEL = "src/app/(dashboard)/calendar/ClosurePanel.tsx";
const GRID = "src/app/(dashboard)/calendar/CalendarGrid.tsx";

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
// 1. Filing a closure from the wizard LEAVES the wizard — it never stacks
// ============================================================
{
  const shortcut = braceBlock(booking, "const openClosureShortcut = () => {");
  assert.ok(shortcut, "openClosureShortcut exists — the door icon routes through one decision, not through a bare setter");

  // the door is wired to THAT, so no second, stack-happy path can grow beside it
  assert.match(booking, /className="bw-hd-btn bw-close-room"[\s\S]{0,240}?onClick=\{openClosureShortcut\}/,
    "the header's door+lock button calls openClosureShortcut");
  assert.doesNotMatch(booking, /onClick=\{\(\) => setClosurePrefill\(/,
    "…and nothing opens the closure form by setting its state directly, which would skip the wizard's exit entirely");

  // the dirty branch: ask, park, and RETURN — it must not open anything yet
  const dirtyBranch = braceBlock(shortcut, "if (dirty) {");
  assert.ok(dirtyBranch, "the shortcut has an explicit dirty branch — typed-in work is never discarded silently");
  assert.match(dirtyBranch, /closureAfterDiscard\.current = context/,
    "…which PARKS the captured context rather than dropping it");
  assert.match(dirtyBranch, /setConfirmDiscard\(true\)/,
    "…and raises the wizard's OWN unsaved-changes confirmation — no second dialog, no new wording");
  assert.doesNotMatch(dirtyBranch, /setClosurePrefill\(/,
    "…and does NOT open the closure form behind the question it just asked");
  assert.match(dirtyBranch, /return;/, "…and stops there");

  // the clean path: close the wizard FIRST, then open the form.
  // THIS is the assertion the defect breaks: delete the onClose() and the
  // closure form goes up over a wizard that is still open.
  const cleanPath = shortcut.slice(shortcut.indexOf(dirtyBranch) + dirtyBranch.length);
  assert.match(cleanPath, /onClose\(\)/,
    "a clean wizard is CLOSED by the shortcut — this is the bug: the form used to open over a wizard that stayed behind and then demanded its required fields");
  assert.match(cleanPath, /setClosurePrefill\(context\)/,
    "…and only then does the closure form open, carrying the captured context");
  const closeAt = cleanPath.indexOf("onClose()");
  const openAt = cleanPath.indexOf("setClosurePrefill(context)");
  assert.ok(closeAt > -1 && openAt > -1 && closeAt < openAt,
    "…in that order: the wizard is gone before the form arrives");

  // and the discard confirmation RESUMES the shortcut instead of dead-ending
  const confirmAt = booking.indexOf(") : confirmDiscard ? (");
  assert.ok(confirmAt > -1, "the discard-confirmation footer branch was located");
  const confirmBranch = confirmAt > -1 ? booking.slice(confirmAt, booking.indexOf("\n        ) : (", confirmAt)) : "";
  assert.match(confirmBranch, /const next = closureAfterDiscard\.current;[\s\S]{0,120}if \(next\) setClosurePrefill\(next\)/,
    "'סגור בלי לשמור' continues to the closure form when that is what the operator asked for — the shortcut is not lost to the question it raised");
  assert.match(confirmBranch, /closureAfterDiscard\.current = null;[\s\S]{0,80}setConfirmDiscard\(false\)/,
    "…and 'המשך עריכה' drops the parked intent, so staying in the wizard stays in the wizard");

  // STRUCTURAL: the form must not live inside the wizard's own panel, or the
  // very close that opens it would unmount the form mid-save.
  const panelMount = booking.indexOf("<ClosurePanel");
  const wizardEnd = booking.lastIndexOf("</SidePanel>");
  assert.ok(panelMount > -1 && wizardEnd > -1, "both the wizard panel and the closure form were located in the wizard file");
  assert.ok(panelMount > wizardEnd,
    "the closure form is a SIBLING of the wizard's SidePanel, not a child — as a child it would unmount the moment the wizard closes, and the save would never happen");

  ok("the wizard's closure shortcut leaves the wizard: clean → close then open, dirty → the existing confirmation then open, and the form outlives the close");
}

// ============================================================
// 2. Opening from context arrives with the room and the dates already in
// ============================================================
{
  const shortcut = braceBlock(booking, "const openClosureShortcut = () => {");
  assert.match(shortcut, /const first = stays\[0\]/,
    "the shortcut reads the wizard's first stay row — the row a calendar drag fills");
  assert.match(shortcut, /roomId: first\?\.roomId/,
    "…and carries the room");
  assert.match(shortcut, /startDate: first\?\.checkIn/,
    "…the check-in as the closure's start");
  assert.match(shortcut, /endDate: first\?\.checkOut/,
    "…and the check-OUT as the closure's end: both are the same exclusive boundary, so the drag maps 1:1 and is never retyped");
  assert.doesNotMatch(booking, /<ClosurePanel\s+open=\{closurePrefill !== null\}\s+onClose=\{[^}]*\}\s+prefill=\{\{\}\}/,
    "the form is no longer mounted with a hardcoded empty prefill");

  // the calendar's own context route still prefills — it always did, and this
  // guard is what keeps it that way while the panel's props move around
  assert.match(grid, /onNewClosure\(\{ roomId: menu\.roomId, startDate: menu\.date, endDate: addDays\(menu\.date, 1\) \}\)/,
    "the board's right-click 'סגור חדר' sends the room and a one-night range from the cell under the cursor");

  // …and the form actually SEEDS from what it is handed
  assert.match(panel, /setRoomId\(edit\?\.roomId \?\? prefill\.roomId/,
    "the form seeds its room from the prefill");
  assert.match(panel, /setStartDate\(edit\?\.startDate \?\? prefill\.startDate/, "…its start date");
  assert.match(panel, /setEndDate\(edit\?\.endDate \?\? prefill\.endDate/, "…and its end date");

  ok("every context-carrying route hands the form a room and a range, and the form seeds itself from it");
}

// ============================================================
// 3. "עד תאריך" can never be on or before "מתאריך"
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

  // ---- and the form is the caller, in both directions ----
  assert.match(panel, /const minEnd = startDate \? closureMinEnd\(startDate\) : ""/,
    "the end field's floor comes from that one function — the '+1 night' arithmetic is not retyped in the form");
  assert.match(panel, /type="date"[\s\S]{0,160}?value=\{endDate\}\s*min=\{minEnd\}/,
    "…and the end field carries it as `min`, so the picker cannot offer an illegal day at all");
  assert.doesNotMatch(panel, /min=\{startDate\}/,
    "the floor is never the start date itself — that still permits a zero-night closure the server will reject");
  assert.match(panel, /if \(v && endDate && endDate <= v\) setEndDate\(closureMinEnd\(v\)\)/,
    "…and moving the START past the end REPAIRS the end instead of leaving a range the save will bounce");
  assert.match(panel, /value=\{startDate\}[\s\S]{0,120}?onChange=\{\(e\) => pickStart\(e\.target\.value\)\}/,
    "the start field goes through that repair, not straight to the setter");

  // the schema still owns the rule — the UI is the courtesy, not the gate
  const validation = read("src/lib/validation/reservation.ts");
  assert.match(validation, /endDate > s\.startDate/,
    "closureSchema/closureUpdateSchema still enforce at-least-one-night server-side — the form's repair is UX, and UX is never the guard");

  ok("the end date is floored and self-repairing in the UI, proven by running closureMinEnd across month, year and leap boundaries — with the server rule untouched");
}

// ============================================================
// 4. A date field answers its whole surface, not just its indicator glyph
// ============================================================
{
  assert.match(panel, /const openPicker = \(e: React\.MouseEvent<HTMLInputElement>\) => \{\s*e\.currentTarget\.showPicker\?\.\(\);/,
    "the form opens the native picker through showPicker() — the platform's own opener, so nothing about the field's look is reimplemented");
  const dateInputs = panel.match(/type="date"[\s\S]{0,220}?\/>/g) ?? [];
  assert.equal(dateInputs.length, 2, "the form has exactly the two date fields this claim is about");
  for (const [i, field] of dateInputs.entries()) {
    assert.match(field, /onClick=\{openPicker\}/,
      `date field ${i + 1} of 2 opens the picker from anywhere in the box — clicking the field used to answer only on the indicator glyph`);
  }
  ok("both date fields open their picker from the whole field, through the platform's own opener");
}

console.log(`\nAll ${n} closure-panel claim groups hold.`);
