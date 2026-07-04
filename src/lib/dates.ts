// ============================================================
// The SINGLE hotel-night date model (Phase 3, DECISIONS D32).
// Every stay boundary in GuestHub is a date-only string "YYYY-MM-DD".
// check_in is INCLUSIVE, check_out is EXCLUSIVE: July 4 → July 5 is
// exactly one night, and a checkout may coexist with a same-day check-in.
// All overlap/nights math in the app flows through this module — the SQL
// twin is guesthub.check_room_availability / room_type_inventory, which
// use the identical formula (a.start < b.end AND a.end > b.start).
// Pure module: no server imports, checkable by scripts/check-calendar.mjs.
// ============================================================

export type DateOnly = string; // "YYYY-MM-DD"

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateOnly(v: unknown): v is DateOnly {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && toDateOnly(d) === v;
}

// Internal: UTC-noon anchor kills DST/UTC drift for date-only arithmetic.
function toUtcNoon(d: DateOnly): Date {
  return new Date(`${d}T12:00:00Z`);
}

function toDateOnly(d: Date): DateOnly {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: DateOnly, days: number): DateOnly {
  const t = toUtcNoon(d);
  t.setUTCDate(t.getUTCDate() + days);
  return toDateOnly(t);
}

// Nights between check-in and check-out (checkout-exclusive).
export function nightsBetween(checkIn: DateOnly, checkOut: DateOnly): number {
  return Math.round(
    (toUtcNoon(checkOut).getTime() - toUtcNoon(checkIn).getTime()) / 86_400_000,
  );
}

// THE hotel-night overlap rule. Half-open ranges [start, end):
// back-to-back stays (a.end === b.start) do NOT overlap.
export function rangesOverlap(
  aStart: DateOnly,
  aEnd: DateOnly,
  bStart: DateOnly,
  bEnd: DateOnly,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

// Every date in [from, to) — the days a stay/closure occupies.
export function eachDay(from: DateOnly, to: DateOnly): DateOnly[] {
  const out: DateOnly[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) out.push(d);
  return out;
}

// "Today" in the property's timezone (tenants.timezone, e.g. Asia/Jerusalem).
export function todayInTz(timeZone: string): DateOnly {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
}

export function maxDate(a: DateOnly, b: DateOnly): DateOnly {
  return a > b ? a : b;
}

export function minDate(a: DateOnly, b: DateOnly): DateOnly {
  return a < b ? a : b;
}

// 0=Sunday … 6=Saturday (timezone-independent for date-only values).
export function dayOfWeek(d: DateOnly): number {
  return toUtcNoon(d).getUTCDay();
}

export function formatDayMonth(d: DateOnly): string {
  return `${Number(d.slice(8, 10))}/${Number(d.slice(5, 7))}`;
}

export function formatFullDate(d: DateOnly): string {
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
}

export const HEBREW_DAY_LETTERS = ["א'", "ב'", "ג'", "ד'", "ה'", "ו'", "ש'"] as const;

export const HEBREW_MONTHS = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
] as const;

export function hebrewMonthYear(d: DateOnly): string {
  return `${HEBREW_MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
}
