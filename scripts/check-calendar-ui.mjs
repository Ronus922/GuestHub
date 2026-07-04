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
assert.equal(ix.dragEndAction("move", false), "open", "plain click on the card opens the reservation");
assert.equal(ix.dragEndAction("move", true), "commit", "an activated drag commits, never opens");
assert.equal(ix.dragEndAction("resize", false), "none", "clicking the resize handle NEVER opens");
assert.equal(ix.dragEndAction("resize", true), "commit");

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

console.log("check-calendar-ui: all interaction/geometry rules hold ✔");
