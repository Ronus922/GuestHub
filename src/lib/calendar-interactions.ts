// ============================================================
// Pure calendar interaction math (Phase 3 visual pass).
// THE single geometry + drag state source for /calendar: the grid, the
// drag ghost and the resize preview all call these functions, so committed
// pills and previews can never disagree. Pure module (imports ./dates
// only) — checkable by scripts/check-calendar-ui.mjs, no React, no DOM.
// ============================================================

import { addDays, nightsBetween, type DateOnly } from "./dates";

// Movement (px) below which a pointer-down+up is a CLICK, at/above it a DRAG.
export const DRAG_THRESHOLD_PX = 6;

export type DragMode = "move" | "resize";

// Has the pointer moved far enough to switch from click to drag?
export function dragActivated(dx: number, dy: number, threshold = DRAG_THRESHOLD_PX): boolean {
  return Math.abs(dx) > threshold || Math.abs(dy) > threshold;
}

// What a pointer-up means. A plain click (never activated) on the card body
// opens the reservation; the resize handle NEVER opens it; an activated drag
// commits. This is the click-vs-drag separation rule (§F).
export function dragEndAction(mode: DragMode, activated: boolean): "open" | "commit" | "none" {
  if (!activated) return mode === "move" ? "open" : "none";
  return "commit";
}

// RTL day snapping: dragging LEFT means LATER dates, so the day delta is
// (startX - currentX) / column width, rounded to the nearest column.
export function snapDayDelta(startX: number, currentX: number, colW: number): number {
  if (colW <= 0) return 0;
  return Math.round((startX - currentX) / colW);
}

export function snapRowDelta(startY: number, currentY: number, rowH: number): number {
  if (rowH <= 0) return 0;
  return Math.round((currentY - startY) / rowH);
}

// Target of a MOVE drag: whole stay shifts by dayDelta, room by roomDelta
// (clamped to the room list).
export function moveTarget(
  stay: { check_in: DateOnly; check_out: DateOnly },
  roomIndex: number,
  dayDelta: number,
  roomDelta: number,
  roomCount: number,
): { roomIndex: number; ci: DateOnly; co: DateOnly; changed: boolean } {
  const targetIndex = Math.min(Math.max(roomIndex + roomDelta, 0), roomCount - 1);
  const ci = addDays(stay.check_in, dayDelta);
  const co = addDays(stay.check_out, dayDelta);
  return { roomIndex: targetIndex, ci, co, changed: dayDelta !== 0 || targetIndex !== roomIndex };
}

// Target of a RESIZE drag: check-in fixed, checkout moves but never below
// one night (checkout-exclusive model, §E).
export function resizeTarget(
  stay: { check_in: DateOnly; check_out: DateOnly },
  dayDelta: number,
): { ci: DateOnly; co: DateOnly; changed: boolean; extending: boolean } {
  const minCo = addDays(stay.check_in, 1);
  const raw = addDays(stay.check_out, dayDelta);
  const co = raw > minCo ? raw : minCo;
  return {
    ci: stay.check_in,
    co,
    changed: co !== stay.check_out,
    extending: co > stay.check_out,
  };
}

// Bar geometry as FRACTIONS of the day strip (0..1) — mid-cell to mid-cell
// so a checkout and a same-day check-in coexist (§E). Fraction-based layout
// (like the reference) means header cells, committed pills, drag ghosts and
// resize previews all derive from the same math and cannot drift, at any
// zoom level.
export function barGeometry(
  from: DateOnly,
  days: number,
  ci: DateOnly,
  co: DateOnly,
): { start: number; width: number; clippedStart: boolean; clippedEnd: boolean } {
  const lastVisible = addDays(from, days - 1);
  const clippedStart = ci < from;
  const clippedEnd = co > lastVisible;
  const start = clippedStart ? 0 : (nightsBetween(from, ci) + 0.5) / days;
  const end = clippedEnd ? 1 : (nightsBetween(from, co) + 0.5) / days;
  return { start, width: Math.max(end - start, 0.5 / days), clippedStart, clippedEnd };
}

// The delta-only resize preview band (§J): committed pill untouched, only
// the added (green) or removed (red) nights are shown.
export function resizeDeltaRange(
  stay: { check_in: DateOnly; check_out: DateOnly },
  co: DateOnly,
): { from: DateOnly; to: DateOnly; extending: boolean } | null {
  if (co === stay.check_out) return null;
  const extending = co > stay.check_out;
  return {
    from: extending ? stay.check_out : co,
    to: extending ? co : stay.check_out,
    extending,
  };
}

// Read-only rule (§11): no edit permission or an in-flight server commit
// means no drag, no resize handle, no grab cursor.
export function canDragCard(canEdit: boolean, pending: boolean): boolean {
  return canEdit && !pending;
}
