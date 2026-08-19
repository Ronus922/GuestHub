// ============================================================
// PURE day-cell mark selection — the DISPLAY half of the restriction story.
// No imports beyond stayLimit, no DB, no React. Checkable by
// scripts/check-cell-mark-ladder.mjs.
//
// WHY A LADDER. A calendar day cell is a ~52px column (21 days across a
// 1280px-floor board, minus the 176px room column). It can carry ONE sign, so
// the question is never "which restrictions are on this date" (the rates board
// answers that in full) but "which ONE of them does the operator most need to
// see on the calendar itself". That is a strict ORDER, not a set: the strongest
// restriction that holds wins and the weaker ones are silent on the cell. Two
// marks in one cell would read as two severities.
//
// WHY MIN AND MAX ARE ONE RUNG. They were two competing rungs, and a cell with
// both showed only the maximum — the minimum, which is the one that actually
// turns bookings away, vanished. They are not two restrictions racing each
// other; they are the two ends of ONE rule ("how long may a stay here be"), so
// they occupy one rung and the mark carries whichever ends exist.
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
  "stay_range", // אורך השהייה המותר — the minimum, the maximum, or both
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
 * What the cell draws. The three closure rungs are a bare name — the sign is
 * the same whatever the row says. The stay-range rung is NOT: its sign is the
 * numbers, so the result carries both ends, either of which may be absent (the
 * rung holds when at least one is present).
 */
export type CellMarkResult =
  | { mark: Exclude<CellMark, "stay_range"> }
  | { mark: "stay_range"; min: number | null; max: number | null };

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
 * The binding maximum for this cell. Unlike the minimum there is no
 * "non-binding" value to filter out: any positive maximum forbids some stay.
 * stayLimit() already reads NULL and 0 as "no limit" (D104).
 */
export function cellMaxNights(rate: CellMarkRow | null | undefined): number | null {
  return stayLimit(rate?.max_nights);
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
  stay_range: (r) => cellMinNights(r) != null || cellMaxNights(r) != null,
};

/**
 * THE selection. Walks CELL_MARK_LADDER from the strongest rung down and
 * returns the first that holds — or null when the date carries no restriction
 * worth a mark. The renderer draws exactly this and nothing else, so there is
 * one place (here) where "which sign" is decided.
 */
export function cellMark(rate: CellMarkRow | null | undefined): CellMarkResult | null {
  if (!rate) return null;
  for (const mark of CELL_MARK_LADDER) {
    if (!HOLDS[mark](rate)) continue;
    return mark === "stay_range"
      ? { mark, min: cellMinNights(rate), max: cellMaxNights(rate) }
      : { mark };
  }
  return null;
}

/**
 * The stay-range rung's text, next to the moon. Three readings, because the two
 * ends are independent: "3" is a floor, "3–7" is a window, and a ceiling alone
 * reads "1–7" — a bare "7" would read as a minimum of seven, the opposite rule.
 * The ceiling used to wear a U+2264, which is absent from the font the build
 * serves and rendered as tofu; a maximum with no minimum IS the range 1 to that
 * maximum (cellMinNights() already drops a non-binding minimum of 1), so the
 * full range says the same thing with glyphs the font has. The en dash is
 * U+2013, measured present. Returns null when neither end exists, which is
 * exactly when the rung does not hold.
 */
export function stayRangeLabel(min: number | null, max: number | null): string | null {
  if (min != null && max != null) return `${min}–${max}`;
  if (min != null) return `${min}`;
  if (max != null) return `1–${max}`;
  return null;
}
