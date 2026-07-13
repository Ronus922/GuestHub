// ============================================================
// The pure logic behind the date-range picker (DatePicker reference): which
// range a click produces, and the cells of one month. Date-only strings all the
// way through (src/lib/dates.ts is the single hotel-night model, D32), so the
// picker cannot invent a second date semantics.
// Checked by scripts/check-datepicker.mjs.
// ============================================================
import { type DateOnly, dayOfWeek } from "./dates";

export type DraftRange = { start: DateOnly | null; end: DateOnly | null };

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * One click on a day cell. First click = start; a later click = end; a click
 * before the start re-anchors it; a click on a complete range starts over.
 *
 * Two range semantics, because the app has exactly two:
 *  - stays ("nights", the default): check_out is EXCLUSIVE, so a same-day click
 *    can never produce a zero-night stay — it re-anchors instead.
 *  - rates ("days", allowSameDay): every picked date IS a night, so the end is
 *    INCLUSIVE and a single day is a legal one-night range.
 */
export function pickRange(
  range: DraftRange,
  clicked: DateOnly,
  opts?: { allowSameDay?: boolean },
): DraftRange {
  if (!range.start || range.end) return { start: clicked, end: null };
  if (clicked < range.start) return { start: clicked, end: null };
  if (clicked === range.start)
    return opts?.allowSameDay ? { start: clicked, end: clicked } : { start: clicked, end: null };
  return { start: range.start, end: clicked };
}

/** Cells of a month: leading nulls so the 1st lands on its weekday, then days. */
export function monthCells(year: number, month: number): (DateOnly | null)[] {
  const first: DateOnly = `${year}-${pad(month + 1)}-01`;
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: (DateOnly | null)[] = Array.from({ length: dayOfWeek(first) }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${year}-${pad(month + 1)}-${pad(d)}`);
  return cells;
}

export function shiftMonth(
  view: { year: number; month: number },
  by: number,
): { year: number; month: number } {
  const m = view.month + by;
  return { year: view.year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 };
}

export function firstOfMonth(view: { year: number; month: number }): DateOnly {
  return `${view.year}-${pad(view.month + 1)}-01`;
}

export function monthOf(date: DateOnly): { year: number; month: number } {
  return { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) - 1 };
}
