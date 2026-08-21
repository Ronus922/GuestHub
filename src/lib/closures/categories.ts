// ============================================================
// THE closure-category taxonomy (migration 084) — the ONE place a closure
// category's Hebrew label and icon are declared.
//
// A closure carries TWO reason fields and they are not interchangeable:
//   · category — this CLOSED list. Machine-readable, groupable, filterable,
//     and the only thing a surface is allowed to render as the closure's kind.
//   · reason    — optional operator free text, a COMPLEMENT to the category
//     ("צביעה בחדר האמבטיה"), never its replacement.
//
// Every consumer (the calendar closure bar, the closure panel's selector, any
// future report) reads CLOSURE_CATEGORIES or closureCategoryLabel(). No Hebrew
// category string may be typed anywhere else — that is exactly how a taxonomy
// silently forks into five spellings of "תחזוקה".
//
// The values MUST stay in lockstep with the CHECK constraint in
// db/migrations/084_closure_categories_restriction_override.sql, as widened by
// 085_closure_category_long_term.sql.
//
// NO .tsx IMPORT, EVER. This module is pulled in by the calendar read model
// (calendar/data.ts → calendar/types.ts), which check:calendar-departure-edge
// compiles in ISOLATION with a tsconfig that has no `jsx` — so a single
// `import type { IconName } from "@/components/shared/Icon"` (a .tsx file)
// would break that guard. The icon names are therefore plain string literals,
// still checked against IconName at every `<Icon name={...} />` call site.
// The two imports below are PURE .ts modules with no imports of their own, so
// that tsconfig (which does carry the "@/*" path mapping) resolves them fine.
// ============================================================
import { addDays, type DateOnly } from "@/lib/dates";
import { dayMonth } from "@/lib/rates/rules";

export const CLOSURE_CATEGORY_VALUES = [
  "maintenance",
  "cleaning",
  "renovation",
  "private_use",
  "long_term",
  "other",
] as const;

export type ClosureCategory = (typeof CLOSURE_CATEGORY_VALUES)[number];

export const CLOSURE_CATEGORIES = [
  { value: "maintenance", label: "תחזוקה", icon: "maintenance" },
  { value: "cleaning", label: "ניקיון", icon: "cleaning" },
  { value: "renovation", label: "שיפוץ", icon: "brush" },
  { value: "private_use", label: "שימוש פרטי", icon: "user" },
  // 085. A yearly lease is not "שימוש פרטי" (an owner taking a weekend) and not
  // "אחר": it is a PHYSICAL, months-long occupancy of the flat, and the whole
  // point of naming it is that the board can say so. date_range — a long stretch
  // of dates held — rather than `key`, which this app already spends on TTLock
  // passcodes.
  { value: "long_term", label: "שכירות ארוכה", icon: "date-range" },
  { value: "other", label: "אחר", icon: "category" },
] as const satisfies readonly { value: ClosureCategory; label: string; icon: string }[];

/** the icon-name literals above — assignable to IconName at the call sites */
export type ClosureCategoryIcon = (typeof CLOSURE_CATEGORIES)[number]["icon"];

const BY_VALUE = new Map(CLOSURE_CATEGORIES.map((c) => [c.value as string, c]));

/** The Hebrew label of a stored category, or null for NULL / an unknown value
 *  (historical rows predate 084 and legitimately carry no category). */
export function closureCategoryLabel(category: string | null | undefined): string | null {
  return category ? (BY_VALUE.get(category)?.label ?? null) : null;
}

/** The icon of a stored category, or null when there is none to draw. */
export function closureCategoryIcon(
  category: string | null | undefined,
): ClosureCategoryIcon | null {
  return category ? (BY_VALUE.get(category)?.icon ?? null) : null;
}

// ============================================================
// THE last night a closure actually holds.
//
// room_closures is half-open [start_date, end_date), exactly like a stay: a
// lease whose last night is 31.12 is stored with end_date = 2027-01-01. That
// boundary is a correct DATABASE value and a WRONG thing to show an operator —
// 1.1 is a night the room is free and can be sold. Every surface that renders a
// closure's end (the sentence below, the popover on the closure bar) subtracts
// through this one function, so none of them has to remember to.
// ============================================================
export function closureLastNight(endDateExclusive: DateOnly): DateOnly {
  return addDays(endDateExclusive, -1);
}

// ============================================================
// THE sentence a blocked surface says when the blocker is a ROOM CLOSURE.
//
// ONE function, because there are three callers and they must not drift: the
// desktop create gate (a drag/double-click/context create onto closed dates),
// the mobile cell's tap, and the room row label. It is the closure twin of
// stayViolationMessage() in lib/rates/rules.ts — that module owns the wording
// of COMMERCIAL restrictions, this one owns the wording of a PHYSICAL closure,
// and neither surface types either sentence as a literal.
//
// It is INFORMATIVE, never a question. A commercial restriction ends in an
// override dialog for a manager who holds the 084 key; a closure ends here.
// Nobody sells a bed somebody else is sleeping in, so this sentence has no
// button and the callers give it none.
//
// THE DATE IS THE LAST CLOSED NIGHT, NOT THE STORED BOUNDARY. room_closures is
// half-open [start_date, end_date): a lease whose last night is 31.12 is stored
// with end_date = 2027-01-01. Saying "עד 1.1" would name a night the guest CAN
// have. The subtraction lives here, once, so no call site has to remember it.
// ============================================================
export function closureBlockMessage(
  category: string | null | undefined,
  endDateExclusive: DateOnly,
): string {
  const lastNight = dayMonth(closureLastNight(endDateExclusive));
  // A closure filed before 084 carries no category, and an unknown value is
  // treated the same way: the generic noun, never a raw stored string.
  return `${closureCategoryLabel(category) ?? "סגירת חדר"} עד ${lastNight}`;
}
