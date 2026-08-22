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

// Hover-tooltip timing: a short deliberate delay before opening, and a
// grace period on leave so the pointer can travel pill → tooltip without
// flicker (§2 of the correction pass).
export const TOOLTIP_OPEN_MS = 380;
export const TOOLTIP_CLOSE_MS = 140;

export type DragMode = "move" | "resize" | "create";

// Has the pointer moved far enough to switch from click to drag?
export function dragActivated(dx: number, dy: number, threshold = DRAG_THRESHOLD_PX): boolean {
  return Math.abs(dx) > threshold || Math.abs(dy) > threshold;
}

// Explicit input rule separating empty-cell RANGE SELECTION from scrolling:
// a selection starts only when the pointer travels past the threshold AND
// horizontally more than vertically. Vertical-dominant movement is a scroll
// gesture and must abort the session (§4).
export function createActivated(dx: number, dy: number, threshold = DRAG_THRESHOLD_PX): boolean {
  return Math.abs(dx) > threshold && Math.abs(dx) >= Math.abs(dy);
}

// What a pointer-up means. A plain click (never activated) on the card body
// OPENS the reservation editor; the resize handle and empty cells never
// open on click; an activated drag/resize does NOT persist and does NOT open
// the editor — it asks for confirmation ("confirm"); an empty-cell create drag
// commits straight to the new-booking panel ("commit"). Click-vs-drag (§F/§3/§4).
export function dragEndAction(
  mode: DragMode,
  activated: boolean,
): "open" | "confirm" | "commit" | "none" {
  if (!activated) return mode === "move" ? "open" : "none";
  // move/resize of an EXISTING reservation → floating confirmation, never persist yet
  if (mode === "move" || mode === "resize") return "confirm";
  return "commit"; // empty-cell create → new-reservation panel
}

// The same question for a CLOSURE bar, which is NOT a reservation pill.
//
// dragEndAction's "the resize handle never opens" is the pill's rule, and it is
// right there: the handle is a 12px sliver of a card that is usually many day
// columns wide, so a stray click on it must not throw a window open. A closure
// bar can be ONE day column wide — ~60px on a 1440px board — of which the same
// 12px handle is a fifth. At that size the rule stops protecting anything and
// starts eating clicks: the operator presses the bar, nothing moves, nothing
// happens, and there is no way to tell which fifth of the bar was to blame.
//
// So on a closure the only question is whether the pointer MOVED. A press that
// never crossed the threshold is a click, wherever on the bar it landed; one
// that did is a drag, and the release commits it.
export function closureDragEndAction(activated: boolean): "open" | "confirm" {
  return activated ? "confirm" : "open";
}

// The five operations a move/resize can represent (§2). Pure: derives the
// operation purely from before/after so the pill, the dialog and the server
// agree. "none" means nothing actually changed.
export type RescheduleOp = "room" | "dates" | "extend" | "shorten" | "room_dates" | "none";

export function describeReschedule(
  before: { roomId: string; checkIn: DateOnly; checkOut: DateOnly },
  after: { roomId: string; checkIn: DateOnly; checkOut: DateOnly },
): RescheduleOp {
  const roomChanged = before.roomId !== after.roomId;
  const datesChanged = before.checkIn !== after.checkIn || before.checkOut !== after.checkOut;
  if (!roomChanged && !datesChanged) return "none";
  if (roomChanged && datesChanged) return "room_dates";
  if (roomChanged) return "room";
  // dates only — extend/shorten by night count, else a same-length shift
  const beforeNights = nightsBetween(before.checkIn, before.checkOut);
  const afterNights = nightsBetween(after.checkIn, after.checkOut);
  if (afterNights > beforeNights) return "extend";
  if (afterNights < beforeNights) return "shorten";
  return "dates";
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

// Target of an empty-cell CREATE drag. A cell is a DATE, not a night: the
// nights are the GAPS between the selected dates, so cells 17+18 are the one
// night 17→18, and three cells are two nights. ci/co are therefore simply the
// min and max of the anchor and anchor+dayDelta — no +1 on either edge, and
// the anchor is a stay night only when the drag runs forward (dragging the
// other way makes the anchor the checkout date). The single-cell case is the
// one exception: with no gap to measure it opens the natural one night.
// Invariant: co > ci always (§4).
export function createRangeTarget(
  startDate: DateOnly,
  dayDelta: number,
): { ci: DateOnly; co: DateOnly; nights: number } {
  const end = addDays(startDate, dayDelta);
  const ci = end < startDate ? end : startDate;
  const far = end > startDate ? end : startDate;
  const co = dayDelta === 0 ? addDays(ci, 1) : far;
  return { ci, co, nights: nightsBetween(ci, co) };
}

// Selection-band geometry: FULL day cells (cell edge to cell edge), unlike
// reservation pills which run mid-cell to mid-cell. The band covers every cell
// the pointer touched — the checkout DATE included — because in the cell-is-a-
// date model that cell is half of the selection the user drew: N nights span
// N+1 cells, so the band ends one cell past the checkout's own edge. Same
// fraction space, same clipping rules.
export function cellRangeGeometry(
  from: DateOnly,
  days: number,
  ci: DateOnly,
  co: DateOnly,
): { start: number; width: number } {
  const start = Math.min(Math.max(nightsBetween(from, ci) / days, 0), 1);
  const end = Math.min(Math.max((nightsBetween(from, co) + 1) / days, 0), 1);
  return { start, width: Math.max(end - start, 0) };
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
