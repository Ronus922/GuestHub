// ============================================================
// The pure logic behind <DateRangePicker> (ported from the datePicker skill):
// stepper, hover preview, the month model with its range band, the dismiss
// rule, popover placement and keyboard steps. Every date is a DateOnly string
// and every bit of date math goes through dates.ts / date-range.ts (D32) —
// this module has no Date of its own.
// Checked by scripts/check-datepicker.mjs.
// ============================================================
import {
  type DateOnly,
  addDays,
  addMonths,
  formatDayHebMonth,
  hebrewMonthYear,
  nightsBetween,
} from "./dates";
import { type DraftRange, firstOfMonth, monthCells, pickRange } from "./date-range";

export type MonthView = { year: number; month: number };

export type RangeRules = {
  min?: DateOnly;
  max?: DateOnly;
  /** typo guard only — without it the stepper has no ceiling */
  maxNights?: number;
};

export function isDateBlocked(d: DateOnly, rules: RangeRules): boolean {
  return (rules.min != null && d < rules.min) || (rules.max != null && d > rules.max);
}

/** a day click — the app's one stay rule (pickRange, check-out exclusive) */
export function pickDay(range: DraftRange, d: DateOnly, rules: RangeRules): DraftRange {
  return isDateBlocked(d, rules) ? range : pickRange(range, d);
}

export function nightsOf(range: DraftRange): number {
  return range.start && range.end ? nightsBetween(range.start, range.end) : 0;
}

/**
 * The stepper moves ONLY the check-out: end = start + n. Minimum one night,
 * maxNights when given, never past `max`. Check-in never moves.
 */
export function setNightsRange(range: DraftRange, n: number, rules: RangeRules): DraftRange {
  if (!range.start) return range;
  const nights = Math.min(Math.max(n, 1), rules.maxNights ?? Number.POSITIVE_INFINITY);
  let end = addDays(range.start, nights);
  if (rules.max != null && end > rules.max) end = rules.max;
  return end > range.start ? { start: range.start, end } : range;
}

export function canIncNights(range: DraftRange, rules: RangeRules): boolean {
  if (!range.start || !range.end) return false;
  if (rules.maxNights != null && nightsOf(range) >= rules.maxNights) return false;
  return rules.max == null || addDays(range.end, 1) <= rules.max;
}

export function canDecNights(range: DraftRange): boolean {
  return nightsOf(range) > 1;
}

/** the check-out, or the hovered day after the check-in (desktop preview) */
export function effectiveEnd(range: DraftRange, hover: DateOnly | null): DateOnly | null {
  if (range.end) return range.end;
  if (range.start && hover && hover > range.start) return hover;
  return null;
}

/**
 * how the picker was dismissed — "cancel" is Esc / ביטול / X and nothing else.
 * "outside" is every other way out: a click outside the popover, the mobile
 * sheet's backdrop, dragging the sheet down, a second press on the trigger.
 */
export type DismissKind = "close" | "outside" | "cancel";

/**
 * Does this dismissal restore the dates the picker opened on? ONE rule on every
 * width (owner decisions 1 + C, 02/10/2026):
 *  - Esc / ביטול / X: yes.
 *  - everything else ("סגור", outside click, sheet backdrop / drag): no for a
 *    COMPLETE range — it is already in the form (write-through) and stays, so a
 *    press on "שמור שינויים" saves it; yes for a half range (check-in only),
 *    which never reached the form.
 * Known edge, ACCEPTED (owner decision B): a picker opened with NO dates (a new
 * booking) restores to "nothing" — but only a complete range ever reaches the
 * form, so after a complete pick + Esc the form keeps that range (the same as
 * DateRangeField before it). Only the picker's own draft goes back to empty.
 */
export function dismissRestores(kind: DismissKind, range: DraftRange): boolean {
  if (kind === "cancel") return true;
  return range.start == null || range.end == null;
}

// ---------- the month model ----------

/** in = inside the band · bs = band start · be = band end · "bs be" = a one-day band */
export type CellBand = "" | "in" | "bs" | "be" | "bs be";
/** sel = picked edge · prev = hovered check-out · today */
export type CellState = "" | "sel" | "prev" | "today";

export type DayCell = {
  /** null = a blank before the 1st / after the last day */
  date: DateOnly | null;
  day: number;
  band: CellBand;
  state: CellState;
  disabled: boolean;
  /** a night the room already owes — painted only, still selectable */
  occupied: boolean;
  /** "4 באוקטובר 2026" — aria-label */
  label: string;
};

export type MonthModel = MonthView & { title: string; rows: number; cells: DayCell[] };

export type BuildContext = {
  range: DraftRange;
  effEnd: DateOnly | null;
  today: DateOnly;
  rules: RangeRules;
  /** taken nights to paint (visual only — never disables a day) */
  occupied?: ReadonlySet<DateOnly>;
};

const BLANK: DayCell = { date: null, day: 0, band: "", state: "", disabled: true, occupied: false, label: "" };

export function buildCell(d: DateOnly, ctx: BuildContext): DayCell {
  const { range, effEnd, today, rules, occupied } = ctx;
  const occ = occupied?.has(d) ?? false;
  const isS = d === range.start;
  const isE = d === effEnd;
  let band: CellBand = "";
  if (range.start && effEnd && d > range.start && d < effEnd) band = "in";
  else if (effEnd) band = isS && isE ? "bs be" : isS ? "bs" : isE ? "be" : "";
  let state: CellState = "";
  if (isS || (isE && range.end)) state = "sel";
  else if (isE) state = "prev";
  else if (d === today) state = "today";
  return {
    date: d,
    day: Number(d.slice(8, 10)),
    band,
    state,
    disabled: isDateBlocked(d, rules),
    occupied: occ,
    label: `${formatDayHebMonth(d)} ${d.slice(0, 4)}${occ ? " · לילה תפוס" : ""}`,
  };
}

const rowsOf = (v: MonthView) => Math.ceil(monthCells(v.year, v.month).length / 7);

/**
 * uniform = desktop: both months get the taller month's row count so the rows
 * line up. Mobile: each month keeps its own.
 */
export function buildMonths(views: MonthView[], uniform: boolean, ctx: BuildContext): MonthModel[] {
  const rowsMax = Math.max(...views.map(rowsOf));
  return views.map((v) => {
    const rows = uniform ? rowsMax : rowsOf(v);
    const cells = monthCells(v.year, v.month).map((d) => (d ? buildCell(d, ctx) : BLANK));
    while (cells.length < rows * 7) cells.push(BLANK);
    return { ...v, title: hebrewMonthYear(firstOfMonth(v)), rows, cells };
  });
}

/** month order without a Date: "2026-10-01" < "2026-11-01" */
export function monthKey(v: MonthView): DateOnly {
  return firstOfMonth(v);
}

// ---------- texts ----------

/** "4 באוקטובר – 10 באוקטובר 2026" · "4 באוקטובר 2026 – בחרו תאריך יציאה" · placeholder */
export function formatRangeText(range: DraftRange, placeholder: string): string {
  const { start, end } = range;
  if (start && end) {
    const sameYear = start.slice(0, 4) === end.slice(0, 4);
    const from = sameYear ? formatDayHebMonth(start) : `${formatDayHebMonth(start)} ${start.slice(0, 4)}`;
    return `${from} – ${formatDayHebMonth(end)} ${end.slice(0, 4)}`;
  }
  if (start) return `${formatDayHebMonth(start)} ${start.slice(0, 4)} – בחרו תאריך יציאה`;
  return placeholder;
}

export function nightsTitle(range: DraftRange): string {
  if (!range.start || !range.end) return "בחרו תאריך יציאה";
  const n = nightsOf(range);
  return n === 1 ? "לילה אחד" : `${n} לילות`;
}

// ---------- keyboard (RTL) ----------

/** ← = next day, → = previous, ↑/↓ = a week, PageUp/PageDown = a month */
export function keyboardStep(key: string, d: DateOnly): DateOnly | null {
  switch (key) {
    case "ArrowLeft":
      return addDays(d, 1);
    case "ArrowRight":
      return addDays(d, -1);
    case "ArrowUp":
      return addDays(d, -7);
    case "ArrowDown":
      return addDays(d, 7);
    case "PageUp":
      return addMonths(d, -1);
    case "PageDown":
      return addMonths(d, 1);
    default:
      return null;
  }
}

/** digits only, at least 1 — otherwise null (the stepper keeps its value) */
export function parseNights(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const n = Number.parseInt(text, 10);
  return n >= 1 ? n : null;
}

// ---------- popover placement ----------

export type PopoverPosition = { top: number; left: number; width: number };

const GAP = 16;
const MARGIN = 16;
const MIN_WIDTH = 700;
const MAX_WIDTH = 940;

/**
 * Below the trigger row, right-aligned to the field; no room below → above; no
 * room either way → pinned 16px off the bottom (the calendar scrolls inside).
 */
export function computePopoverPosition(
  anchor: { top: number; bottom: number; right: number; width: number },
  popHeight: number,
  vw: number,
  vh: number,
): PopoverPosition {
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, anchor.width), Math.max(vw - 2 * MARGIN, 0));
  let top = anchor.bottom + GAP;
  const fitsBelow = top + popHeight <= vh - MARGIN;
  const above = anchor.top - GAP - popHeight;
  if (!fitsBelow && above >= MARGIN) top = above;
  else if (!fitsBelow) top = Math.max(MARGIN, vh - MARGIN - popHeight);
  let left = anchor.right - width;
  if (left + width > vw - MARGIN) left = vw - MARGIN - width;
  if (left < MARGIN) left = MARGIN;
  return { top, left, width };
}
