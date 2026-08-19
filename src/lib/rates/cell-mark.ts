// ============================================================
// PURE day-cell mark selection — the DISPLAY half of the restriction story.
// No imports beyond stayLimit, no DB, no React. Checkable by
// scripts/check-cell-mark-ladder.mjs.
//
// WHY A LADDER. A calendar day cell is ~37px wide in the 30-day view. It can
// carry ONE sign, so the question is never "which restrictions are on this
// date" (the hover card answers that in full — RateCellTooltip) but "which ONE
// of them does the operator most need to see without hovering". That is a
// strict ORDER, not a set: the strongest restriction that holds wins and the
// weaker ones are silent on the cell. Two marks in one cell would read as two
// severities and would not fit.
//
// The enforcement layer is deliberately NOT here. This module never decides
// what may be sold — src/lib/rates/rules.ts does, and a manager with the 084
// override may book against any of these. Changing the ladder changes what is
// DRAWN and nothing else.
// ============================================================

import { stayLimit } from "./rules";

/** The rungs, strongest first. The array IS the priority order. */
export const CELL_MARK_LADDER = [
  "stop_sell", // סגור למכירה — the date is not for sale at all
  "closed_to_arrival", // סגור להגעה — may not check IN here
  "closed_to_departure", // סגור לעזיבה — may not check OUT here
  "max_stay", // מקסימום לילות
  "min_nights", // מינימום לילות (only when it actually binds, i.e. >= 2)
] as const;

export type CellMark = (typeof CELL_MARK_LADDER)[number];

/**
 * The fields the ladder reads — a structural subset of RateRow
 * (src/lib/inventory-rules.ts), so a RateRow is assignable as-is.
 */
export type CellMarkRow = {
  closed?: boolean | null; // = stop_sell
  closed_to_arrival?: boolean | null;
  closed_to_departure?: boolean | null;
  max_nights?: number | null; // = max_stay
  min_nights?: number | null; // = min_stay_arrival
  min_stay_through?: number | null;
};

/**
 * The binding minimum for this cell — the stricter of the arrival-min and the
 * through-min — but ONLY when it is a real restriction. A minimum of 1 night
 * restricts nothing (every stay is at least one night), so it does not reach
 * the ladder and leaves the cell clean. Returns the number to render, or null.
 * stayLimit() so a stored 0 ("unlimited" on the wire, D104) is not a limit.
 */
export function cellMinNights(rate: CellMarkRow | null | undefined): number | null {
  const n = Math.max(stayLimit(rate?.min_nights) ?? 0, stayLimit(rate?.min_stay_through) ?? 0);
  return n >= 2 ? n : null;
}

/**
 * Does this single rung hold for this row? One predicate per rung, so the
 * ladder ARRAY above is the only statement of priority — there is no parallel
 * if-chain that could quietly disagree with it.
 */
const HOLDS: Record<CellMark, (rate: CellMarkRow) => boolean> = {
  stop_sell: (r) => r.closed === true,
  closed_to_arrival: (r) => r.closed_to_arrival === true,
  closed_to_departure: (r) => r.closed_to_departure === true,
  max_stay: (r) => stayLimit(r.max_nights) != null,
  min_nights: (r) => cellMinNights(r) != null,
};

/**
 * THE selection. Walks CELL_MARK_LADDER from the strongest rung down and
 * returns the first that holds — or null when the date carries no restriction
 * worth a mark. The renderer draws exactly this and nothing else, so there is
 * one place (here) where "which sign" is decided.
 */
export function cellMark(rate: CellMarkRow | null | undefined): CellMark | null {
  if (!rate) return null;
  for (const mark of CELL_MARK_LADDER) {
    if (HOLDS[mark](rate)) return mark;
  }
  return null;
}
