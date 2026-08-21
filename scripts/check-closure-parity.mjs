#!/usr/bin/env node
// ============================================================
// check:closure-parity — a room closure is "a reservation of nobody", and every
// gesture that works on a reservation on the board works on it, the same way.
//
// THE DEFECTS THIS EXISTS FOR, all measured on main before this run:
//
//   1. A closure could not be MOVED or RESIZED at all. Shifting a lease by a day
//      meant opening a form and retyping two dates; moving it to another room
//      meant deleting it and filing it again — which puts the room back on sale
//      for as long as the retyping takes, and files two audit rows for one act.
//   2. updateClosureAction refused a room change outright, so there was nothing
//      for a vertical drag to commit to.
//   3. A room MOVE changes availability in TWO rooms. Marking only the
//      destination leaves the vacated room published as blocked — a room nobody
//      can sell, indefinitely, with nothing on screen to say why.
//   4. Clicking a closure opened a two-item popover whose "עריכה" opened the
//      panel anyway, and whose "הסר חסימה" deleted on one click, no question
//      asked. Deleting a closure puts a room back on sale.
//   5. The booking wizard carried a room+lock door — a second route into the
//      closure form from a window about creating a reservation, which had to
//      close itself and ask about unsaved work to get there.
//
// Runtime where it can be — the pure geometry module is compiled and RUN over a
// CLOSURE's own span, which is the whole claim of §1: the same functions that
// move a stay move a closure, because the two store the same half-open pair.
// Static where it cannot (a server action needs a DB to run).
// No DB, no network, no build.
// D127 collect-all: every failure is reported, then the guard fails once.
// Usage: node scripts/check-closure-parity.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

// ---- compile the real pure geometry module, same harness as check:calendar-ui ----
const out = mkdtempSync(join(tmpdir(), "gh-closureparity-"));
execSync(
  `npx tsc src/lib/dates.ts src/lib/calendar-interactions.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { cwd: ROOT, stdio: "inherit" },
);
const req = createRequire(join(ROOT, "package.json"));
const ix = req(join(out, "calendar-interactions.js"));

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const CAL = "src/app/(dashboard)/calendar";
const ACTIONS = `${CAL}/actions.ts`;
const GRID = `${CAL}/CalendarGrid.tsx`;
const PANEL = `${CAL}/ClosurePanel.tsx`;

const grid = stripComments(read(GRID));
const panel = stripComments(read(PANEL));

/** the body of an exported server action, comments stripped */
function actionBody(name) {
  const src = stripComments(read(ACTIONS));
  const at = src.indexOf(`export async function ${name}(`);
  if (at < 0) return "";
  const next = src.slice(at + 1).search(/\nexport (async )?function /);
  return next < 0 ? src.slice(at) : src.slice(at, at + 1 + next);
}

/** the body of a `const <name> = useCallback(` up to its closing `\n  );` */
function callbackBody(src, name) {
  const at = src.indexOf(`const ${name} = useCallback(`);
  if (at < 0) return "";
  const end = src.indexOf("\n  );", at);
  return end < 0 ? src.slice(at) : src.slice(at, end);
}

// ============================================================
// 1. The geometry layer is SUBJECT-BLIND — RUN over a closure's own span
//
// A closure stores [start_date, end_date); a stay stores [check_in, check_out).
// The same half-open pair, so the same functions answer for both, and that is
// what makes "the same gesture" a fact rather than a resemblance.
// ============================================================
{
  // a 4-night closure: 20/08 → 24/08 exclusive (last closed night 23/08)
  const span = { check_in: "2026-08-20", check_out: "2026-08-24" };

  // HORIZONTAL drag = the dates shift, the length is preserved
  assert.deepEqual(
    ix.moveTarget(span, 3, 2, 0, 10),
    { roomIndex: 3, ci: "2026-08-22", co: "2026-08-26", changed: true },
    "dragging a closure two days later shifts BOTH edges and keeps its four nights");
  // VERTICAL drag = the room changes, the dates do not
  assert.deepEqual(
    ix.moveTarget(span, 3, 0, -2, 10),
    { roomIndex: 1, ci: "2026-08-20", co: "2026-08-24", changed: true },
    "dragging it two rows up moves it to another ROOM and leaves the dates alone");
  // …and the room index is clamped to the room list, so a drag past the top
  // edge lands on the first room instead of an undefined one
  assert.equal(ix.moveTarget(span, 1, 0, -9, 10).roomIndex, 0,
    "a drag past the first row clamps to it — there is no row -8 to commit to");
  assert.equal(ix.moveTarget(span, 8, 0, 9, 10).roomIndex, 9,
    "…and the same at the bottom");

  // the EDGE = extend / shorten, floored at one night
  assert.deepEqual(
    ix.resizeTarget(span, 3),
    { ci: "2026-08-20", co: "2026-08-27", changed: true, extending: true },
    "dragging the end edge outwards extends the closure");
  assert.deepEqual(
    ix.resizeTarget(span, -2),
    { ci: "2026-08-20", co: "2026-08-22", changed: true, extending: false },
    "…and inwards shortens it");
  assert.deepEqual(
    ix.resizeTarget(span, -9),
    { ci: "2026-08-20", co: "2026-08-21", changed: true, extending: false },
    "…never below the one night a closure must be: the floor is start+1, not zero or negative");
  assert.equal(ix.resizeTarget(span, 0).changed, false,
    "a resize that lands where it started is not a change and must not reach the server");

  // and the delta band the ghost paints is the added/removed nights only
  assert.deepEqual(
    ix.resizeDeltaRange(span, "2026-08-27"),
    { from: "2026-08-24", to: "2026-08-27", extending: true },
    "the extend preview covers only the nights being ADDED");
  assert.deepEqual(
    ix.resizeDeltaRange(span, "2026-08-22"),
    { from: "2026-08-22", to: "2026-08-24", extending: false },
    "…and the shorten preview only the nights being REMOVED");
  assert.equal(ix.resizeDeltaRange(span, "2026-08-24"), null,
    "…and there is no band at all when nothing changed");

  // click-vs-drag is the same rule for both subjects
  assert.equal(ix.dragEndAction("move", false), "open",
    "a plain click on a block opens its panel — for a closure that is the closure panel");
  assert.equal(ix.dragEndAction("move", true), "confirm",
    "an activated drag never opens the panel; it commits");
  assert.equal(ix.dragEndAction("resize", false), "none",
    "clicking the resize handle opens nothing, on either subject");

  ok("the geometry layer takes a closure's span unchanged — move, room-change, extend, shorten and the one-night floor, all RUN on a real closure");
}

// ============================================================
// 2. …and the grid FEEDS it a closure through the same session
// ============================================================
{
  assert.match(grid, /closure: CalendarClosure \| null;/,
    "the drag session carries a closure as an alternative subject — one session, not a second pointer pipeline");
  assert.match(grid, /function dragSpan\(s: DragSession\)/,
    "dragSpan translates whichever subject is set into the half-open pair the geometry layer takes");
  assert.match(grid, /return \{ check_in: s\.closure\.start_date, check_out: s\.closure\.end_date \};/,
    "…mapping start_date/end_date onto check_in/check_out: the SAME pair, not a second date model");
  assert.match(grid, /const beginDrag = useCallback\(/,
    "the press→session half is one shared function");
  const closureDown = callbackBody(grid, "onClosurePointerDown");
  assert.ok(closureDown, "the closure bar's pointer-down was located");
  assert.match(closureDown, /canDragCard\(can\.close, pending\.has\(closure\.id\)\)/,
    "a closure is draggable by rooms.edit — not by reservations.edit, which is a different act");
  assert.match(closureDown, /beginDrag\(e, mode, roomIndex, \{ stay: null, closure \}, 1\)/,
    "…and it starts the SAME session the pill starts, with a one-night floor (a closure has no commercial minimum)");
  assert.match(grid, /onPointerDown\(e, closure, roomIndex, "resize"\)/,
    "the bar carries a resize handle that opens a resize session, exactly like the pill's departure handle");
  assert.match(grid, /className="cb-rh"[\s\S]{0,400}?aria-label="שינוי סוף הסגירה"/,
    "…and it is the pill's OWN handle element (.cb-rh), not a second one drawn for closures");
  ok("the grid feeds a closure into the shared session: same threshold, same ghost, same handle, its own permission");
}

// ============================================================
// 3. THE RELEASE IS VALIDATED BY THE SERVER — the client only previews
// ============================================================
{
  const commit = callbackBody(grid, "commitClosureChange");
  assert.ok(commit, "the closure release path was located");
  assert.match(commit, /updateClosureAction\(\{/,
    "a completed drag commits through the server action — there is no local write of any kind");
  assert.match(commit, /roomId: targetRoom\.id/,
    "…sending the room it was dropped on");
  assert.match(commit, /startDate,\s*\n\s*endDate,/,
    "…and the dates it was dragged to");
  assert.match(commit, /category: c\.category \?\? undefined,\s*\n\s*reason: c\.reason \?\? undefined,/,
    "…carrying the category and the free text: the action rewrites the whole row, so omitting them would erase WHY the room is closed as a side effect of dragging it");
  assert.match(commit, /if \(\s*startDate === c\.start_date &&\s*endDate === c\.end_date &&\s*targetRoom\.id === c\.room_id\s*\) \{\s*return;/,
    "a drag that lands where it started sends nothing");
  assert.match(commit, /rangeInvalid\(targetRoom, startDate, endDate, undefined, c\.id\)/,
    "the client-side preview excludes the closure being dragged — without that every drag would collide with the row it is dragging");
  assert.match(commit, /toast\.error\("היעד אינו זמין — הפעולה בוטלה"\)/,
    "…and a preview refusal is the same sentence a reservation drag refuses with");

  // THE server gate. This is the assertion B2(a) neutralises.
  const update = actionBody("updateClosureAction");
  assert.ok(update, "updateClosureAction exists");
  assert.match(update, /const targetRoomId = input\.roomId \?\? before\.room_id;/,
    "the action resolves WHERE the closure ends up — absent roomId means 'leave it where it is'");
  assert.match(update, /const moved = targetRoomId !== before\.room_id;/,
    "…and whether that is a move");
  assert.match(update, /await lockRooms\(tx, actor\.tenantId, moved \? \[before\.room_id, targetRoomId\] : \[before\.room_id\]\);/,
    "BOTH rooms are locked on a move — the room being vacated is as much a participant as the one being filled");
  assert.match(update, /await checkRoomAvailability\(tx, \{[\s\S]{0,200}?roomIds: \[targetRoomId\],[\s\S]{0,200}?checkIn: input\.startDate,[\s\S]{0,200}?checkOut: input\.endDate,/,
    "the overlap check runs against the room the closure is LANDING IN, over the range it is landing on");
  assert.match(update, /\.filter\(\(c\) => c\.conflict_id !== before\.id\)/,
    "…ignoring the closure's own row, or every in-place edit would collide with itself");
  assert.match(update, /if \(blocking\.length > 0\) throw new DomainError\(CONFLICT_LABEL\[blocking\[0\]\.conflict_kind\]\);/,
    "…and a conflict REFUSES the write, with the canonical sentence for what blocked it");
  assert.match(update, /const blocking = isOoo\s*\n?\s*\? conflicts\s*\n?\s*: conflicts\.filter\(\s*\n?\s*\(c\) => c\.conflict_kind === "room_missing" \|\| c\.conflict_kind === "room_status",/,
    "an OOS note takes no inventory so overlaps never block it — but a MOVE still has to land on a room that exists and is sellable");
  assert.match(update, /if \(isOoo \|\| moved\) \{/,
    "…which is why the check runs for a move whatever the kind");
  ok("a dragged closure is validated by the server: the target room, the target range, its own row excluded, and a refusal is a refusal");
}

// ============================================================
// 4. A SUCCESSFUL MOVE MARKS ARI ON BOTH ROOMS, OVER THE UNION
//
// This is the assertion B2(b) neutralises. Marking only the destination leaves
// the vacated room published as blocked: a room nobody can sell, indefinitely.
// ============================================================
{
  const update = actionBody("updateClosureAction");
  assert.match(update, /const \{ date_from: dateFrom, date_to: dateTo \} = unionRange\(/,
    "the dirty window is the UNION of the stored and the submitted range");
  assert.match(update, /const roomIds = moved \? \[before\.room_id, targetRoomId\] : \[before\.room_id\];/,
    "a MOVE marks BOTH rooms — the one the nights were released from and the one they were taken in");
  assert.match(update, /await markAriDirty\(tx, \{\s*\n?\s*tenantId: actor\.tenantId,\s*\n?\s*roomIds,\s*\n?\s*dateFrom,\s*\n?\s*dateTo,\s*\n?\s*\}\);/,
    "…and that list is what markAriDirty is handed, over the union window");
  assert.match(update, /type: "inventory\.changed",\s*\n?\s*roomIds,\s*\n?\s*dateFrom,\s*\n?\s*dateTo,/,
    "…and inventory.changed is published for the same rooms and the same window, so both boards refresh");
  // asked of the ARI block ALONE: the availability gate above it legitimately
  // names the destination room by itself, and that is a different question
  const ari = update.slice(update.indexOf("unionRange("));
  assert.ok(ari, "the ARI block was located");
  assert.doesNotMatch(ari, /roomIds: \[targetRoomId\]/,
    "the destination is never marked ALONE — that is exactly the defect this claim exists for");
  assert.doesNotMatch(ari, /roomIds: \[before\.room_id\]/,
    "…and neither is the origin");
  ok("a room move marks ARI dirty on both rooms over the union window, and neither room can be marked alone");
}

// ============================================================
// 5. Deleting a closure asks first
// ============================================================
{
  assert.equal((panel.match(/deleteClosureAction\(/g) ?? []).length, 1,
    "there is exactly ONE call site for the delete action — a second one is a second answer to the same question");
  assert.match(panel, /const remove = \(\) =>[\s\S]{0,400}?deleteClosureAction\(edit\.id\)/,
    "…and it lives in remove(), which is the only thing that deletes");
  assert.match(panel, /onClick=\{\(\) => setConfirmDelete\(true\)\}/,
    "the footer's הסר חסימה only ARMS the question — it does not delete");
  assert.match(panel, /<ConfirmDialog\s*\n?\s*title="הסרת סגירת חדר"/,
    "…which raises the canonical §8 confirmation");
  assert.match(panel, /<p className="cb-gate-msg">למחוק את הסגירה\?<\/p>/,
    "…asking, in words, about the thing being deleted");
  const dialogAt = panel.indexOf("<ConfirmDialog");
  const dialog = dialogAt > -1 ? panel.slice(dialogAt) : "";
  assert.match(dialog, /onClick=\{remove\}/,
    "…and only the dialog's own button runs the deletion");
  assert.doesNotMatch(grid, /deleteClosureAction/,
    "the board itself can no longer delete a closure — the popover that did it in one click is gone");
  ok("lifting a closure passes through one confirmation and one call site");
}

// ============================================================
// 6. The booking wizard's room+lock door is gone
// ============================================================
{
  const wizard = read("src/components/reservations/BookingPanel.tsx");
  for (const token of ["bw-close-room", "bw-cr-badge", "door-front", "headerActions=", "ClosurePanel", "canClose"]) {
    assert.ok(!wizard.includes(token),
      `the create wizard carries no ${token} — closing a room is an act of the calendar`);
  }
  const css = read("src/app/styles/booking-window.css");
  for (const cls of [".bw-hd-btn", ".bw-close-room", ".bw-cr-badge"]) {
    assert.ok(!new RegExp(`\\${cls}\\s*[{,:]`).test(css),
      `${cls} left booking-window.css with the element it dressed`);
  }
  // the act still HAS doors, one per board, and they open the one form
  const screen = stripComments(read(`${CAL}/CalendarScreen.tsx`));
  assert.match(screen, /className="cb-touch-close"/, "the desktop tree keeps a 'חסימת חדר' header button");
  assert.match(screen, /className="cb-m-close"/, "…and the mobile tree its own");
  assert.match(grid, /onNewClosure\(\{ roomId: menu\.roomId/,
    "…and the desktop grid's right-click menu still files one on the cell under the cursor");
  ok("the wizard's door and its CSS are gone, and every remaining door is on the board the act belongs to");
}

// ============================================================
// 7. Both boards open the SAME panel on the SAME closure
// ============================================================
{
  assert.match(grid, /onEditClosure\(closureEditOf\(c, room\)\)/,
    "a click on the desktop bar opens the panel on that closure");
  const screen = stripComments(read(`${CAL}/CalendarScreen.tsx`));
  assert.match(screen, /onClosureTap=\{\(closure, room\) =>[\s\S]{0,200}?closureEditOf\(closure, room\)/,
    "…and a tap on the mobile board does the same, through the same translation");
  const mobile = stripComments(read(`${CAL}/MobileCalendar.tsx`));
  assert.match(mobile, /onClosureTap\(cover, room\)/,
    "the mobile tap passes the closure covering that night");
  assert.match(read("src/app/styles/calendar-mobile.css"), /\.cb-m-block \{[^}]*pointer-events: none/,
    "the mobile closure bar stays a SIGN: the cell beneath owns the whole 50px row, so one finger gets one answer");
  ok("one panel, one closure, both boards");
}

console.log(`\nAll ${n} closure-parity claim groups hold.`);
