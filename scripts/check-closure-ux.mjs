#!/usr/bin/env node
// ============================================================
// check:closure-ux — a room closure is a thing an operator OPENS, EDITS and
// LIFTS, and every one of those acts has to tell the channels the truth.
//
// THE DEFECTS THIS EXISTS FOR, all four measured on main:
//
//   1. Extending a lease meant DELETE + CREATE. Two writes, two audit rows, and
//      a window in between where the room was back on sale. There was no update
//      action at all.
//   2. An edit that only marks the NEW range dirty leaves the released tail
//      published as unavailable; one that only marks the OLD range leaves the
//      new head published as free. The second one is an overbooking into a flat
//      somebody lives in. The mark must be the UNION.
//   3. The closure popover printed end_date — the EXCLUSIVE boundary. A lease
//      whose last night is 31.12 stores 2027-01-01, so the board named 01/01/2027
//      as closed. That is a night the room is free and sellable.
//   4. The "הקמת הזמנה חדשה" wizard drew תצוגה/הדפסה/PDF/וואטסאפ/מייל as
//      buttons with no onClick. Before the reservation exists there is nothing
//      to preview, print or send; they were noise that looked like function.
//      The room+lock door beside them was wired, and it went too (owner ruling):
//      closing a room is an act of the calendar, and it has its own doors there.
//
// Runtime where it can be (the pure range and date helpers are compiled and
// CALLED), static where it cannot (a server action needs a DB to run).
// No DB, no network, no build.
// D127 collect-all: every failure is reported, then the guard fails once.
// Usage: node scripts/check-closure-ux.mjs
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

// ---- compile the real pure modules, same harness as check:long-term-closure ----
const tmp = mkdtempSync(join(tmpdir(), "gh-closureux-"));
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
      join(ROOT, "src/lib/channel/ranges.ts"),
      join(ROOT, "src/lib/closures/categories.ts"),
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
const { unionRange } = req(join(out, "lib/channel/ranges.js"));
const { closureLastNight, closureBlockMessage } = req(join(out, "lib/closures/categories.js"));

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const CAL = "src/app/(dashboard)/calendar";
const ACTIONS = `${CAL}/actions.ts`;

/** the body of an exported server action, comments stripped */
function actionBody(name) {
  const src = stripComments(read(ACTIONS));
  const at = src.indexOf(`export async function ${name}(`);
  if (at < 0) return "";
  const next = src.slice(at + 1).search(/\nexport (async )?function /);
  return next < 0 ? src.slice(at) : src.slice(at, at + 1 + next);
}

// ============================================================
// 1. Editing a closure marks ARI dirty on the UNION of the old and new ranges
// ============================================================
{
  // ---- the union is a REAL function and it is run here, not described ----
  assert.deepEqual(
    unionRange({ date_from: "2026-01-01", date_to: "2026-02-01" },
               { date_from: "2026-01-01", date_to: "2026-03-01" }),
    { date_from: "2026-01-01", date_to: "2026-03-01" },
    "EXTENDING: the union reaches the new, later end — the added nights are published as blocked");
  assert.deepEqual(
    unionRange({ date_from: "2026-01-01", date_to: "2026-03-01" },
               { date_from: "2026-01-01", date_to: "2026-02-01" }),
    { date_from: "2026-01-01", date_to: "2026-03-01" },
    "SHORTENING: the union KEEPS the old, later end — the released nights are re-published as free, which marking only the new range would skip");
  assert.deepEqual(
    unionRange({ date_from: "2026-02-01", date_to: "2026-03-01" },
               { date_from: "2026-01-01", date_to: "2026-03-01" }),
    { date_from: "2026-01-01", date_to: "2026-03-01" },
    "…and it reaches backwards the same way when the START moves earlier");
  assert.deepEqual(
    unionRange({ date_from: "2026-01-01", date_to: "2026-02-01" },
               { date_from: "2026-06-01", date_to: "2026-07-01" }),
    { date_from: "2026-01-01", date_to: "2026-07-01" },
    "a closure MOVED to a disjoint window still marks one span covering both — the vacated window and the newly blocked one");
  assert.deepEqual(
    unionRange({ date_from: "2026-01-01", date_to: "2026-02-01" },
               { date_from: "2026-01-01", date_to: "2026-02-01" }),
    { date_from: "2026-01-01", date_to: "2026-02-01" },
    "an unchanged range is its own union — no spurious widening");

  // ---- and the update action is the caller ----
  const update = actionBody("updateClosureAction");
  assert.ok(update, "updateClosureAction exists — extending a lease is one write, not a delete plus a create");
  assert.match(update, /unionRange\(/,
    "updateClosureAction computes its dirty window with unionRange() — the union is not re-derived inline where it can drift");
  assert.match(update, /markAriDirty\(/,
    "…and hands that window to markAriDirty");
  assert.match(update, /publishDomainEvent\(/,
    "…and publishes inventory.changed on the same window, so open boards refresh");
  // the arguments to unionRange must be the BEFORE row and the INPUT, in that
  // order-independent pairing — a union of the input with itself is a no-op
  // dressed as a union.
  assert.match(update, /unionRange\(\s*\{\s*date_from:\s*before\.start_date,\s*date_to:\s*before\.end_date\s*\},\s*\{\s*date_from:\s*input\.startDate,\s*date_to:\s*input\.endDate\s*\},?\s*\)/,
    "…and the two operands are the STORED range and the SUBMITTED range — not the submitted one twice");
  assert.doesNotMatch(update, /dateFrom:\s*input\.startDate/,
    "the mark never passes the submitted start directly — that is exactly the bug the union exists to prevent");
  assert.doesNotMatch(update, /dateTo:\s*input\.endDate/,
    "…nor the submitted end");
  ok("editing a closure marks ARI dirty on the union of the stored and the submitted range — proven by running unionRange, in both directions");
}

// ============================================================
// 2. Lifting a closure marks ARI dirty — releasing inventory is a change too
// ============================================================
{
  const del = actionBody("deleteClosureAction");
  assert.ok(del, "deleteClosureAction exists");
  assert.match(del, /markAriDirty\(/,
    "deleting a closure marks ARI dirty — the nights return to sale and the channels are still publishing them as blocked");
  assert.match(del, /dateFrom:\s*closure\.start_date/,
    "…over the range of the closure as it was STORED, read before the DELETE");
  assert.match(del, /dateTo:\s*closure\.end_date/,
    "…through its stored end");
  // the row must be read BEFORE it is deleted, or the range is gone
  assert.ok(del.indexOf("FROM guesthub.room_closures") < del.indexOf("DELETE FROM guesthub.room_closures"),
    "the stored range is SELECTed before the DELETE — after it there is nothing left to mark");
  assert.match(del, /publishDomainEvent\(/,
    "…and the released window is published as inventory.changed");

  // all three verbs gate on the SAME kind test: an OOS note never moved
  // availability, so it never syncs — and an OOO one always does.
  for (const [name, body] of [
    ["createClosureAction", actionBody("createClosureAction")],
    ["updateClosureAction", actionBody("updateClosureAction")],
    ["deleteClosureAction", del],
  ]) {
    assert.match(body, /isOoo|kind === "ooo"/,
      `${name} decides whether to sync by the closure's KIND — an OOS note takes no inventory, so it publishes nothing`);
  }
  // …and all three demand the same permission
  for (const [name, body] of [
    ["createClosureAction", actionBody("createClosureAction")],
    ["updateClosureAction", actionBody("updateClosureAction")],
    ["deleteClosureAction", del],
  ]) {
    assert.match(body, /requirePermission\(actor, "rooms\.edit"\)/,
      `${name} requires rooms.edit — an edit is not a lesser act than filing the closure it rewrites`);
  }
  ok("lifting a closure marks the released range dirty, and create/update/delete share one permission and one kind gate");
}

// ============================================================
// 3. What the operator READS is the last CLOSED night, never the exclusive end
// ============================================================
{
  assert.equal(closureLastNight("2027-01-01"), "2026-12-31",
    "closureLastNight turns the stored exclusive boundary into the last night actually held");
  assert.equal(closureLastNight("2026-03-01"), "2026-02-28",
    "…across a month boundary");
  assert.equal(closureLastNight("2028-03-01"), "2028-02-29",
    "…including a leap year, because it is date arithmetic and not string surgery");

  // the two surfaces that render a closure's end are the SAME subtraction
  assert.ok(closureBlockMessage("long_term", "2027-01-01").includes("31.12"),
    "the blocked-surface sentence names the last closed night");
  const grid = stripComments(read(`${CAL}/CalendarGrid.tsx`));
  const at = grid.indexOf("const ClosureBar = memo(");
  assert.ok(at > -1, "the closure bar component was located");
  const bar = at > -1 ? grid.slice(at) : "";
  assert.match(bar, /closureLastNight\(closure\.end_date\)/,
    "the bar's own range ends on closureLastNight(end_date) — the ONE subtraction, not a second one typed here");
  assert.doesNotMatch(bar, /formatFullDate\(closure\.end_date\)/,
    "…and the raw exclusive boundary is not printed: 01/01/2027 is a night the room is FREE");

  // nobody re-derives it with an inline addDays(-1)
  for (const rel of [`${CAL}/CalendarGrid.tsx`, `${CAL}/ClosurePanel.tsx`, `${CAL}/MobileCalendar.tsx`]) {
    assert.doesNotMatch(stripComments(read(rel)), /addDays\((?:c|closure)\.end_date,\s*-1\)/,
      `${rel} does not hand-roll the subtraction — it calls closureLastNight`);
  }
  ok("every closure end shown to an operator is the last CLOSED night, computed once in closureLastNight");
}

// ============================================================
// 4. The create wizard's header carries NOTHING — the share shells went first,
//    and the room+lock door followed them (owner ruling)
// ============================================================
{
  const wiz = stripComments(read("src/components/reservations/BookingPanel.tsx"));
  // the wizard's own chrome: everything the SidePanel is configured WITH, up to
  // the stepper band. The body below it is a different thing — it legitimately
  // draws a mail glyph inside the guest's email field, which is not a share
  // button, so the header claim is asked of the header.
  const chrome = wiz.slice(wiz.indexOf("return ("), wiz.indexOf("band={"));
  assert.ok(chrome.length > 0, "the wizard's SidePanel configuration was located");

  // the five that were noise on CREATE — there is nothing to preview, print or
  // send before the reservation exists
  for (const [icon, label] of [["eye", "תצוגה מקדימה"], ["printer", "הדפסה"], ["pdf", "PDF"], ["whatsapp", "וואטסאפ"], ["mail", "מייל"]]) {
    assert.doesNotMatch(chrome, new RegExp(`name="${icon}"`),
      `the create wizard's chrome does not render the ${label} icon — it belongs to editing an EXISTING reservation`);
  }
  assert.doesNotMatch(wiz, /TODO\(wire-up\)/,
    "…and no wire-up TODO is left standing: a button that does nothing is removed, not documented");

  // …and the door is gone with them. A wizard for CREATING a reservation is not
  // where a room gets closed: that act has its own doors on the board (the
  // "חסימת חדר" header button, a right-click on the desktop grid), and a
  // shortcut that had to close the wizard, ask about unsaved work and reopen
  // elsewhere was a second route to a place that already had one.
  assert.doesNotMatch(wiz, /headerActions=/,
    "the wizard's SidePanel passes no headerActions at all — the cluster is empty, not hidden");
  for (const token of ["bw-hd-btn", "bw-close-room", "bw-cr-badge", 'name="door-front"']) {
    assert.doesNotMatch(wiz, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `the room+lock door's ${token} is gone from the wizard`);
  }
  assert.doesNotMatch(wiz, /ClosurePanel/,
    "…and the wizard no longer mounts the closure form: one form, reached from the board that owns the act");
  assert.doesNotMatch(wiz, /canClose/,
    "…so the rooms.edit flag is not threaded into the wizard either");
  for (const rel of ["src/components/reservations/NewReservationProvider.tsx", "src/components/layout/Shell.tsx", "src/app/(dashboard)/layout.tsx"]) {
    assert.doesNotMatch(read(rel), /canClose/,
      `${rel} carries no leftover canClose — the prop existed for the door alone`);
  }
  // and the CSS that dressed it left with it (no orphan rules, §9)
  const css = read("src/app/styles/booking-window.css");
  for (const cls of [".bw-hd-btn", ".bw-close-room", ".bw-cr-badge"]) {
    assert.doesNotMatch(css, new RegExp(`\\${cls}\\s*[{,:]`),
      `${cls} is gone from booking-window.css — deleting the element and leaving its CSS is how dead rules accumulate`);
  }

  // the EDIT panel keeps all five — this change is scoped to create
  const edit = stripComments(read("src/components/reservations/EditReservationPanel.tsx"));
  assert.match(edit, /<BookingToolbar/,
    "editing an existing reservation still draws BookingToolbar");
  const toolbar = stripComments(read("src/components/reservations/BookingActions.tsx"));
  for (const icon of ["mail", "whatsapp", "download", "printer"]) {
    assert.match(toolbar, new RegExp(`icon: "${icon}"`),
      `BookingToolbar still carries the ${icon} action — the removal is CREATE-only`);
  }
  for (const handler of ["onEmail", "onWhatsApp", "onPdf", "onPrint"]) {
    assert.match(edit, new RegExp(`${handler}=\\{`),
      `…and the edit panel passes a real ${handler} handler, unlike the shells that were removed from create`);
  }
  ok("the create wizard's header is empty — no share shells, no room+lock door, no orphan CSS; the edit panel's five actions are untouched");
}

// ============================================================
// 5. One closure panel, two verbs — and the room is never moved by an edit
// ============================================================
{
  const panel = stripComments(read(`${CAL}/ClosurePanel.tsx`));
  assert.match(panel, /updateClosureAction\(/,
    "the panel sends the update action when it was opened on an existing closure");
  assert.match(panel, /createClosureAction\(/,
    "…and the create action otherwise — one form, two verbs, so a field added reaches both");
  assert.match(panel, /disabled=\{Boolean\(edit\)\}/,
    "the room selector is read-only while editing — a closure changes rooms by being DRAGGED to another row, which is one act with one availability check, not a form field");

  // …and the server DOES accept that move, as one write. It used to refuse,
  // which made "move" mean delete-then-create: two audit rows and a window in
  // between where the room was back on sale.
  const validation = read("src/lib/validation/reservation.ts");
  const upd = validation.slice(validation.indexOf("export const closureUpdateSchema"));
  assert.match(upd.slice(0, upd.indexOf(";")), /roomId: z\.uuid\(\)\.optional\(\)/,
    "closureUpdateSchema carries an OPTIONAL roomId — absent means 'leave it where it is', present means a move");

  // clicking the bar opens the panel directly; the two-item popover is gone
  const grid = stripComments(read(`${CAL}/CalendarGrid.tsx`));
  assert.doesNotMatch(grid, /closurePop/,
    "the closure popover is gone — its עריכה opened this same panel, one click later, and its delete has moved into the panel behind a confirmation");
  const openAt = grid.indexOf("const openClosurePanel = useCallback(");
  assert.ok(openAt > -1, "the closure bar's opener was located");
  const opener = openAt > -1 ? grid.slice(openAt, grid.indexOf("\n  );", openAt)) : "";
  assert.match(opener, /onEditClosure\(closureEditOf\(c, room\)\)/,
    "a click on a closure opens the panel on THAT closure — wired to the panel, not to a placeholder");
  assert.match(opener, /can\.close/,
    "…and an actor without rooms.edit is told so instead of meeting a dead bar");
  assert.match(panel, /deleteClosureAction\(/,
    "הסר חסימה lives in the panel now");
  assert.match(panel, /<ConfirmDialog/,
    "…behind the canonical §8 confirmation — lifting a closure puts a room back on sale");
  ok("one panel serves both verbs, a click on the bar opens it, deletion asks first, and a room move is one server-validated write");
}

console.log(`\nAll ${n} closure-UX claim groups hold.`);
