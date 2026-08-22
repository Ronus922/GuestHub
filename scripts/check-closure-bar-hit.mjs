#!/usr/bin/env node
// ============================================================
// check:closure-bar-hit — every pixel a closure bar is DRAWN on belongs to that
// closure, at every bar length, on both boards.
//
// THE DEFECT THIS EXISTS FOR, reported by the owner on a phone: two taps on two
// closure bars on the same board, minutes apart. One opened the closure panel.
// The other — a short test closure — opened the NEW-BOOKING WIZARD, as if the
// empty cell underneath had been tapped.
//
// THE CAUSE IS A GEOMETRY MISMATCH, and it is measured below rather than
// described. A bar is drawn MID-CELL TO MID-CELL (barGeometry — so a checkout
// and a same-day check-in can share a column) while a CELL is a whole DATE. So
// both ends of every bar hang half a day column past the dates the closure
// actually covers. The mobile bar was pointer-events:none, on the earlier and
// correct observation that a 34px box floating in a 50px row swallows the middle
// of the tap and lets the strips above and below fall through — so the CELL
// beneath answered everything. That handed the bar's trailing half, which
// overhangs the CHECKOUT date's cell, to the empty-cell branch. The room is free
// on that date, so the branch did what it is supposed to do: it opened a booking.
//
// WHY LENGTH MATTERED, exactly:
//   · a ONE-NIGHT bar is 50% trailing overhang — half the bar was a wizard
//   · a 2-night bar is 25%, a 3-night 17% — the tail shrinks but never leaves
//   · a lease clipped at BOTH window edges has start 0% and end 100% and covers
//     every visible cell — zero overhang, which is why "שכירות ארוכה" always
//     behaved and nothing in the suite ever caught this.
//
// THE DESKTOP TWIN, same principle, different surface: the bar there is a real
// control, so nothing falls through — but its 12px .cb-rh resize handle answered
// a click-without-movement with NOTHING (dragEndAction's pill rule). On a
// one-day bar, ~60px wide on a 1440px board, that is a fifth of the target dead
// to a click. closureDragEndAction is the closure's own rule.
//
// Runtime where it can be — barGeometry and closureDragEndAction are compiled
// and RUN, and the overhang is computed, not asserted from memory. Static where
// it cannot (React hit-testing needs a browser).
// D127 collect-all: every failure is reported, then the guard fails once.
// Usage: node scripts/check-closure-bar-hit.mjs
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

const out = mkdtempSync(join(tmpdir(), "gh-barhit-"));
execSync(
  `npx tsc src/lib/dates.ts src/lib/calendar-interactions.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { cwd: ROOT, stdio: "inherit" },
);
const req = createRequire(join(ROOT, "package.json"));
const ix = req(join(out, "calendar-interactions.js"));
const { addDays } = req(join(out, "dates.js"));

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const CAL = "src/app/(dashboard)/calendar";
const mobile = stripComments(read(`${CAL}/MobileCalendar.tsx`));
const grid = stripComments(read(`${CAL}/CalendarGrid.tsx`));
const mobileCss = read("src/app/styles/calendar-mobile.css");

// The two readings of one closure, side by side.
//   coverOn()  — what the CELL under the finger believes: half-open [start, end)
//                over whole dates. This is the app's own predicate, re-stated
//                here in one line because it is one line.
//   barGeometry — what the operator SEES, in fractions of the day strip.
// The overhang is the difference, and it is what the finger falls into.
function overhang(from, days, start, end) {
  const geo = ix.barGeometry(from, days, start, end);
  const barA = geo.start;
  const barB = geo.start + geo.width;
  const stray = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    const covered = start <= date && end > date; // coverOn()
    const cellA = i / days;
    const cellB = (i + 1) / days;
    const share = Math.max(0, Math.min(barB, cellB) - Math.max(barA, cellA)) / (cellB - cellA);
    if (share > 1e-9 && !covered) stray.push({ i, date, share });
  }
  return { geo, barA, barB, stray, strayShareOfBar: stray.reduce((t, s) => t + s.share, 0) / (days * (barB - barA)) };
}

// ============================================================
// 1. THE OVERHANG IS REAL, AND IT IS BIGGEST ON THE SHORTEST BAR — measured
// ============================================================
{
  const from = "2026-08-20";
  const days = 5;

  const oneNight = overhang(from, days, "2026-08-21", "2026-08-22");
  assert.equal(oneNight.stray.length, 1,
    "a ONE-NIGHT bar is drawn over a date its closure does not cover — the checkout date's cell");
  assert.equal(oneNight.stray[0].date, "2026-08-22",
    "…and that date is the exclusive end: the first night the room is free again");
  assert.equal(Math.round(oneNight.strayShareOfBar * 100), 50,
    "…and it is HALF the bar. Half of every one-night closure was drawn on a cell that answers with a booking");

  const twoNights = overhang(from, days, "2026-08-20", "2026-08-22");
  assert.equal(twoNights.stray.length, 1, "a two-night bar overhangs the same one cell");
  assert.equal(Math.round(twoNights.strayShareOfBar * 100), 25,
    "…but it is a quarter of the bar, not half — the tail is a fixed half-column, so it shrinks as the bar grows and never disappears");

  const threeNights = overhang(from, days, "2026-08-20", "2026-08-23");
  assert.equal(Math.round(threeNights.strayShareOfBar * 100), 17,
    "…a sixth on three nights. There is no length at which this stops being a live target");

  // …and the one shape that never misbehaved, which is the owner's own evidence
  const lease = overhang(from, days, "2026-01-01", "2027-01-01");
  assert.equal(lease.stray.length, 0,
    "a lease clipped at BOTH window edges overhangs nothing — every visible cell is covered");
  assert.deepEqual([lease.barA, lease.barB], [0, 1],
    "…because clipping pins it to 0%–100%, which is exactly why 'שכירות ארוכה' always opened the panel and the short test closure did not");

  ok("the overhang is measured, not asserted: half a one-night bar, a quarter of a two-night bar, and nothing at all on a clipped lease");
}

// ============================================================
// 2. So the mobile bar CATCHES ITS OWN PIXELS
// ============================================================
{
  assert.match(mobile, /<button\s+type="button"\s+className="cb-m-block"/,
    "the mobile closure block is a control, not a sign — a sign hands its pixels to whatever is underneath");
  assert.match(mobile, /onClick=\{onTap\}/,
    "…and it answers its own tap");
  assert.doesNotMatch(mobileCss, /\.cb-m-block \{[^}]*pointer-events: none/,
    ".cb-m-block is not pointer-events:none — that is the line that gave the bar's trailing half to the empty-cell branch");
  // full row height, or the 8px strips above and below the 34px visual fall
  // through and we are back to one finger with two answers
  assert.match(mobileCss, /\.cb-m-block \{[^}]*top: 0;\s*\n\s*bottom: 0;/,
    "its hit area is the FULL row height — nothing above or below the drawn bar can fall through");
  assert.doesNotMatch(mobileCss, /\.cb-m-block \{[^}]*height: 34px/,
    "…and the 34px is the VISUAL, not the target: a 34px target is also under the 44px touch minimum");
  assert.match(mobileCss, /\.cb-m-block-bar \{[^}]*height: 34px/,
    "…which is why the 34px dashed bar is a child, centred inside the full-height button");
  ok("the mobile bar is a full-row-height control wearing a 34px visual — no strip of it belongs to anything else");
}

// ============================================================
// 3. ONE answer, wherever the finger lands
// ============================================================
{
  assert.match(mobile, /const tapClosure = useCallback\(/,
    "there is ONE function for 'a closure was touched'");
  const tap = mobile.slice(mobile.indexOf("const tapClosure = useCallback("));
  assert.match(tap, /if \(canClose\) onClosureTap\(c, room\);/,
    "…which opens the panel for an actor who may close a room");
  assert.match(tap, /else toast\.\w+\(closureBlockMessage\(c\.category, c\.end_date\)\);/,
    "…and carries the canonical sentence for one who may not");
  // both surfaces call it — the bar over its own pixels, the cell over the rest
  assert.match(mobile, /onTap=\{roomSellable \? \(\) => tapClosure\(c, room\) : undefined\}/,
    "the BAR answers through it");
  assert.match(mobile, /:\s*cover\s*\?\s*\(\)\s*=>\s*tapClosure\(cover, room\)/,
    "…and so does a covered CELL — one decision, written once, so the two can never diverge again");
  // …and no SURFACE re-decides the permission for itself. It is a prop, a type,
  // one branch inside tapClosure and that branch's dependency — four mentions,
  // one decision. A fifth would be a second surface answering on its own.
  assert.equal((mobile.match(/canClose/g) ?? []).length, 4,
    "the permission is decided in exactly one place — a surface that tests it again is the next divergence");

  // and no covered surface can reach a booking
  const cellAt = mobile.indexOf("const closed =");
  const cell = cellAt > -1 ? mobile.slice(cellAt, mobile.indexOf("</div>", cellAt)) : "";
  assert.ok(cell, "the mobile cell body was located");
  const coverAt = cell.indexOf("? () => tapClosure(cover, room)");
  const bookAt = cell.indexOf("onEmptyTap(room.id, d)");
  assert.ok(coverAt > -1 && bookAt > -1 && coverAt < bookAt,
    "the closure branch is asked BEFORE the booking branch — a covered date can never fall through to onEmptyTap");
  assert.equal((cell.match(/onEmptyTap\(/g) ?? []).length, 1,
    "…and there is exactly one way to reach a booking from a cell, which the closure branch stands in front of");
  ok("bar and cell answer a closure through one function, and no covered surface has a route to the booking wizard");
}

// ============================================================
// 4. The desktop twin: a press that never moved is a CLICK, handle included
// ============================================================
{
  assert.equal(ix.closureDragEndAction(false), "open",
    "a press on a closure bar that never crossed the threshold OPENS the panel — wherever on the bar it landed");
  assert.equal(ix.closureDragEndAction(true), "confirm",
    "…and one that did cross it is a drag, whose release commits");

  // the pill's rule is UNCHANGED — this run does not touch reservations (§2.4)
  assert.equal(ix.dragEndAction("resize", false), "none",
    "a reservation pill's handle still opens nothing on a click: there the handle is a sliver of a wide card");
  assert.equal(ix.dragEndAction("move", false), "open", "…and its body still opens on a click");
  assert.equal(ix.dragEndAction("move", true), "confirm", "…and a drag still confirms");
  assert.equal(ix.dragEndAction("create", true), "commit", "…and an empty-cell drag still commits to the booking panel");

  assert.match(grid, /const action = closureDragEndAction\(s\.activated\);/,
    "the closure release path uses the closure's own rule");
  assert.doesNotMatch(
    grid.slice(grid.indexOf("const onClosurePointerUp")),
    /dragEndAction\(s\.mode/,
    "…and not the pill's, which would spend a fifth of a one-day bar on a handle that answers nothing");
  // the handle is still a handle: a real drag from it still resizes
  assert.match(grid, /onPointerDown\(e, closure, roomIndex, "resize"\)/,
    "the resize handle still starts a resize session — this fixes the click, not the drag");
  ok("on the desktop bar a press without movement opens the panel from the handle too, while a drag from it still resizes — and the reservation pill's rules are untouched");
}

console.log(`\nAll ${n} closure-bar-hit claim groups hold.`);
