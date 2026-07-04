// Runnable checks for the pure calendar interaction/geometry module (same
// pattern as check-calendar.mjs): compiles the pure module with tsc,
// imports it and asserts the click-vs-drag, snapping, geometry and
// read-only rules the grid relies on. Usage: node scripts/check-calendar-ui.mjs
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const out = mkdtempSync(join(tmpdir(), "calendar-ui-"));
execSync(
  `pnpm exec tsc src/lib/dates.ts src/lib/calendar-interactions.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const ix = require(join(out, "calendar-interactions.js"));

// ---- movement threshold (§6): below 6px = click, above = drag ----
assert.equal(ix.DRAG_THRESHOLD_PX, 6);
assert.equal(ix.dragActivated(0, 0), false, "no movement is a click");
assert.equal(ix.dragActivated(6, 0), false, "at the threshold still a click");
assert.equal(ix.dragActivated(7, 0), true, "past the threshold horizontally = drag");
assert.equal(ix.dragActivated(0, -7), true, "past the threshold vertically = drag");
assert.equal(ix.dragActivated(-4, 5), false, "diagonal jitter under threshold = click");

// ---- click vs drag outcomes (§6/§7) ----
assert.equal(ix.dragEndAction("move", false), "open", "plain click on the card opens the FULL editor");
assert.equal(ix.dragEndAction("move", true), "commit", "an activated drag commits, never opens");
assert.equal(ix.dragEndAction("resize", false), "none", "clicking the resize handle NEVER opens");
assert.equal(ix.dragEndAction("resize", true), "commit");
assert.equal(ix.dragEndAction("create", false), "none", "a plain click on an empty cell never opens anything");
assert.equal(ix.dragEndAction("create", true), "commit", "an activated cell drag hands off to the booking window");

// ---- hover tooltip timing (§2): deliberate open, shorter close grace ----
assert.ok(ix.TOOLTIP_OPEN_MS >= 200 && ix.TOOLTIP_OPEN_MS <= 800, "tooltip opens after a short, deliberate delay");
assert.ok(ix.TOOLTIP_CLOSE_MS > 0 && ix.TOOLTIP_CLOSE_MS < ix.TOOLTIP_OPEN_MS, "close grace is shorter than the open delay");

// ---- empty-cell selection activation (§4): horizontal-dominant only ----
assert.equal(ix.createActivated(7, 3), true, "horizontal drag past threshold starts a selection");
assert.equal(ix.createActivated(-7, 3), true, "both horizontal directions work");
assert.equal(ix.createActivated(7, 8), false, "vertical-dominant movement is a scroll, not a selection");
assert.equal(ix.createActivated(5, 0), false, "below the threshold nothing activates");

// ---- empty-cell range target (§4): whole nights, exclusive checkout ----
let cr = ix.createRangeTarget("2026-07-10", 0);
assert.deepEqual([cr.ci, cr.co, cr.nights], ["2026-07-10", "2026-07-11", 1], "single cell = one night");
cr = ix.createRangeTarget("2026-07-10", 2);
assert.deepEqual([cr.ci, cr.co, cr.nights], ["2026-07-10", "2026-07-13", 3], "dragging left (RTL) selects later nights");
cr = ix.createRangeTarget("2026-07-10", -2);
assert.deepEqual([cr.ci, cr.co, cr.nights], ["2026-07-08", "2026-07-11", 3], "dragging right selects earlier nights, anchor stays a night");
cr = ix.createRangeTarget("2026-07-10", 0, 2);
assert.deepEqual([cr.ci, cr.co, cr.nights], ["2026-07-10", "2026-07-12", 2], "cell min-stay stretches a single-cell selection");

// ---- selection band geometry: full cells, not mid-cell ----
let cg = ix.cellRangeGeometry("2026-07-04", 21, "2026-07-08", "2026-07-11");
assert.ok(Math.abs(cg.start - 4 / 21) < 1e-9, "selection starts at the cell edge");
assert.ok(Math.abs(cg.width - 3 / 21) < 1e-9, "3 selected nights = exactly 3 whole cells");
cg = ix.cellRangeGeometry("2026-07-04", 21, "2026-07-01", "2026-07-06");
assert.equal(cg.start, 0, "selection clips at the visible range start");
cg = ix.cellRangeGeometry("2026-07-04", 21, "2026-07-20", "2026-08-02");
assert.ok(Math.abs(cg.start + cg.width - 1) < 1e-9, "selection clips at the visible range end");

// ---- RTL day snapping: dragging left = later dates ----
assert.equal(ix.snapDayDelta(500, 500, 65), 0);
assert.equal(ix.snapDayDelta(500, 435, 65), 1, "one column left = +1 day");
assert.equal(ix.snapDayDelta(500, 565, 65), -1, "one column right = -1 day");
assert.equal(ix.snapDayDelta(500, 470, 65), 0, "less than half a column snaps back");
assert.equal(ix.snapDayDelta(500, 466, 65), 1, "more than half a column snaps forward");
assert.equal(ix.snapDayDelta(500, 400, 0), 0, "zero column width never divides by zero");
assert.equal(ix.snapRowDelta(300, 356, 56), 1);
assert.equal(ix.snapRowDelta(300, 245, 56), -1);

// ---- move target: clamped to the room list, dates shift together ----
const stay = { check_in: "2026-07-10", check_out: "2026-07-13" };
let t = ix.moveTarget(stay, 2, 1, 1, 12);
assert.deepEqual([t.roomIndex, t.ci, t.co, t.changed], [3, "2026-07-11", "2026-07-14", true]);
t = ix.moveTarget(stay, 0, 0, -5, 12);
assert.equal(t.roomIndex, 0, "room delta clamps at the first room");
t = ix.moveTarget(stay, 11, 0, 9, 12);
assert.equal(t.roomIndex, 11, "room delta clamps at the last room");
t = ix.moveTarget(stay, 4, 0, 0, 12);
assert.equal(t.changed, false, "no delta = nothing to commit");

// ---- resize target: checkout-exclusive, minimum one night ----
let r = ix.resizeTarget(stay, 2);
assert.deepEqual([r.co, r.extending, r.changed], ["2026-07-15", true, true]);
r = ix.resizeTarget(stay, -2);
assert.deepEqual([r.co, r.extending, r.changed], ["2026-07-11", false, true]);
r = ix.resizeTarget(stay, -10);
assert.equal(r.co, "2026-07-11", "checkout never drops below check-in + 1");
r = ix.resizeTarget(stay, 0);
assert.equal(r.changed, false);

// ---- delta-only resize preview (§J): committed pill untouched ----
assert.equal(ix.resizeDeltaRange(stay, "2026-07-13"), null, "no delta, no preview");
let d = ix.resizeDeltaRange(stay, "2026-07-15");
assert.deepEqual([d.from, d.to, d.extending], ["2026-07-13", "2026-07-15", true], "extension previews only the added nights");
d = ix.resizeDeltaRange(stay, "2026-07-11");
assert.deepEqual([d.from, d.to, d.extending], ["2026-07-11", "2026-07-13", false], "shortening previews only the removed nights");

// ---- bar geometry: mid-cell to mid-cell fractions, clip at range edges ----
const days = 21;
let g = ix.barGeometry("2026-07-04", days, "2026-07-08", "2026-07-11");
assert.ok(Math.abs(g.start - 4.5 / 21) < 1e-9, "starts at check-in midpoint");
assert.ok(Math.abs(g.width - 3 / 21) < 1e-9, "3 nights = exactly 3 columns");
assert.equal(g.clippedStart, false);
assert.equal(g.clippedEnd, false);
g = ix.barGeometry("2026-07-04", days, "2026-07-10", "2026-07-11");
assert.ok(Math.abs(g.width - 1 / 21) < 1e-9, "one-night stay = exactly one column");
g = ix.barGeometry("2026-07-04", days, "2026-07-01", "2026-07-06");
assert.equal(g.clippedStart, true, "check-in before the window clips flat");
assert.equal(g.start, 0);
assert.ok(Math.abs(g.width - 2.5 / 21) < 1e-9, "clipped start still ends mid-checkout-cell");
g = ix.barGeometry("2026-07-04", days, "2026-07-20", "2026-08-02");
assert.equal(g.clippedEnd, true, "checkout after the window clips flat");
assert.ok(Math.abs(g.start + g.width - 1) < 1e-9, "clipped end reaches the range edge");
g = ix.barGeometry("2026-07-04", days, "2026-07-01", "2026-07-04");
assert.ok(Math.abs(g.width - 0.5 / 21) < 1e-9, "checkout on the first visible morning = half-column stub, like the reference");
// same math a drag ghost uses — previews and committed pills cannot drift
const ghost = ix.barGeometry("2026-07-04", days, "2026-07-08", "2026-07-11");
assert.deepEqual(ghost, ix.barGeometry("2026-07-04", days, "2026-07-08", "2026-07-11"));

// ---- read-only rule (§11): no edit permission / pending commit = no drag ----
assert.equal(ix.canDragCard(true, false), true);
assert.equal(ix.canDragCard(false, false), false, "read-only users get no drag affordance");
assert.equal(ix.canDragCard(true, true), false, "a card mid-commit cannot be dragged again");

// ============================================================
// D41 interaction-model rules, asserted against the real sources:
// informational tooltip + side-panel booking/editing (no full-screen path)
// ============================================================
const { readFileSync, existsSync } = await import("node:fs");
// comments stripped — rules are about code, not the explanatory notes
const src = (p) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// tooltip is informational only — zero write paths
const tooltip = src("src/app/(dashboard)/calendar/ReservationTooltip.tsx");
assert.ok(!tooltip.includes("אישור הזמנה"), "tooltip has NO confirmation button");
assert.ok(!/updateReservationAction|createReservationAction|cancelReservationAction|Action\(/.test(tooltip),
  "tooltip calls no server action at all");
assert.ok(!/useTransition|toast\./.test(tooltip), "tooltip has no mutation/loading state");
assert.ok(/role="tooltip"/.test(tooltip), "accessibility role preserved");
assert.ok(/draft/.test(tooltip), "pending/draft badge stays as informational content");
assert.ok(/room_count > 1/.test(tooltip), "multi-room information preserved");
assert.ok(/onEdit\(stay\.reservation_id\)/.test(tooltip), "עריכה only hands off to the editor");

// booking + edit flows live in the shared SidePanel shell — no full screen
assert.ok(!existsSync("src/components/ui/FullWindow.tsx"), "FullWindow was removed");
const booking = src("src/components/reservations/BookingPanel.tsx");
const editor = src("src/components/reservations/EditReservationPanel.tsx");
for (const [name, s] of [["BookingPanel", booking], ["EditReservationPanel", editor]]) {
  assert.ok(/from "@\/components\/ui\/SidePanel"/.test(s), `${name} renders inside the SidePanel shell`);
  assert.ok(!/FullWindow/.test(s), `${name} has no full-screen window`);
  assert.ok(/requestClose/.test(s) && /confirmDiscard/.test(s), `${name} has dirty-state close protection`);
}

// one open panel at a time — a single source of truth on the screen
const screen = src("src/app/(dashboard)/calendar/CalendarScreen.tsx");
assert.ok(/PanelState/.test(screen) && /setPanel\(\{ kind: "edit"/.test(screen) &&
  /setPanel\(\{ kind: "booking"/.test(screen), "booking/edit/closure share ONE panel state");
assert.ok(!/FullWindow/.test(screen), "the calendar screen never opens a full-screen window");

// the panel stacks above every calendar layer (tooltip 60, date picker 80)
const sidePanel = src("src/components/ui/SidePanel.tsx");
assert.ok(/z-\[90\]/.test(sidePanel), "side panel renders above tooltip/context-menu/date-picker");

console.log("check-calendar-ui: all interaction/geometry rules hold ✔");
