import type { IconName } from "@/components/shared/Icon";

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
// db/migrations/084_closure_categories_restriction_override.sql.
// ============================================================
export const CLOSURE_CATEGORY_VALUES = [
  "maintenance",
  "cleaning",
  "renovation",
  "private_use",
  "other",
] as const;

export type ClosureCategory = (typeof CLOSURE_CATEGORY_VALUES)[number];

export const CLOSURE_CATEGORIES: {
  value: ClosureCategory;
  label: string;
  icon: IconName;
}[] = [
  { value: "maintenance", label: "תחזוקה", icon: "maintenance" },
  { value: "cleaning", label: "ניקיון", icon: "cleaning" },
  { value: "renovation", label: "שיפוץ", icon: "brush" },
  { value: "private_use", label: "שימוש פרטי", icon: "user" },
  { value: "other", label: "אחר", icon: "category" },
];

const BY_VALUE = new Map(CLOSURE_CATEGORIES.map((c) => [c.value as string, c]));

/** The Hebrew label of a stored category, or null for NULL / an unknown value
 *  (historical rows predate 084 and legitimately carry no category). */
export function closureCategoryLabel(category: string | null | undefined): string | null {
  return category ? (BY_VALUE.get(category)?.label ?? null) : null;
}

/** The icon of a stored category, or null when there is none to draw. */
export function closureCategoryIcon(category: string | null | undefined): IconName | null {
  return category ? (BY_VALUE.get(category)?.icon ?? null) : null;
}
