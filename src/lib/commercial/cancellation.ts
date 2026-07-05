// Cancellation policy templates (Commercial Settings §B). A policy is an ORDERED
// set of fee tiers — unlimited, reorderable. Pure validation shared by the Server
// Action, the tier-builder UI and the DB check. Returns Hebrew errors/warnings;
// it NEVER silently guesses which overlapping rule wins (§B) — overlap is a hard
// error. A non-refundable OFFER is a rate-plan + payment-policy concern, NOT a
// cancellation tier (§B), so no "non-refundable" flag lives here.

export type CancellationTriggerType =
  | "before_checkin"
  | "no_show"
  | "after_checkin"
  | "early_departure"
  | "partial_cancellation";
export type TimeUnit = "hours" | "days";
export type CancellationFeeType =
  | "free"
  | "fixed"
  | "percentage"
  | "first_night"
  | "nights"
  | "full"
  | "percentage_remaining"
  | "higher_of"
  | "lower_of";
export type CalcBase =
  | "accommodation"
  | "accommodation_plus_mandatory"
  | "total_incl_tax"
  | "unpaid_balance"
  | "remaining_nights";

export type CancellationTier = {
  trigger_type: CancellationTriggerType;
  time_unit: TimeUnit | null;
  time_from: number | null; // nearer-to-arrival bound (hours/days), >= 0
  time_to: number | null; // farther bound; null = open-ended ("more than …")
  fee_type: CancellationFeeType;
  fee_amount: number;
  fee_percent: number;
  fee_nights: number;
  calc_base: CalcBase;
};

export type ValidationResult = { errors: string[]; warnings: string[] };

const TRIGGER_TYPES: CancellationTriggerType[] = [
  "before_checkin", "no_show", "after_checkin", "early_departure", "partial_cancellation",
];
const FEE_TYPES: CancellationFeeType[] = [
  "free", "fixed", "percentage", "first_night", "nights", "full",
  "percentage_remaining", "higher_of", "lower_of",
];

const toHours = (v: number, unit: TimeUnit): number => (unit === "days" ? v * 24 : v);

// [from, to) window of a before_checkin tier in HOURS-before-check-in; to=null → +∞.
// Lets tiers declared in different units be compared on one axis.
function hourWindow(t: CancellationTier): { from: number; to: number } {
  const unit = t.time_unit ?? "hours";
  const from = t.time_from == null ? 0 : toHours(t.time_from, unit);
  const to = t.time_to == null ? Infinity : toHours(t.time_to, unit);
  return { from, to };
}

const overlaps = (a: { from: number; to: number }, b: { from: number; to: number }) =>
  a.from < b.to && b.from < a.to;

// Validates a full tier list. Errors block saving; warnings are advisory (shown,
// but savable) — uncovered gaps and a missing no-show rule are warnings so a
// property can deliberately run a partial policy, per §B ("warning or explicit
// catch-all").
export function validateCancellationTiers(tiers: CancellationTier[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (tiers.length === 0) {
    errors.push("מדיניות ביטול חייבת לכלול לפחות שלב אחד");
    return { errors, warnings };
  }

  tiers.forEach((t, i) => {
    const n = i + 1;
    if (!TRIGGER_TYPES.includes(t.trigger_type)) errors.push(`שלב ${n}: סוג טריגר לא תקין`);
    if (!FEE_TYPES.includes(t.fee_type)) errors.push(`שלב ${n}: סוג עמלה לא תקין`);

    // fee-type specific
    if (t.fee_amount < 0) errors.push(`שלב ${n}: סכום עמלה לא יכול להיות שלילי`);
    if (t.fee_percent < 0 || t.fee_percent > 100)
      errors.push(`שלב ${n}: אחוז עמלה חייב להיות בין 0 ל־100`);
    if (t.fee_nights < 0) errors.push(`שלב ${n}: מספר לילות לא יכול להיות שלילי`);
    if ((t.fee_type === "percentage" || t.fee_type === "percentage_remaining") && t.fee_percent <= 0)
      warnings.push(`שלב ${n}: עמלת אחוז ללא ערך אחוז`);
    if (t.fee_type === "fixed" && t.fee_amount <= 0)
      warnings.push(`שלב ${n}: עמלת סכום קבוע ללא סכום`);
    if (t.fee_type === "nights" && t.fee_nights <= 0)
      errors.push(`שלב ${n}: עמלת "מספר לילות" מחייבת לפחות לילה אחד`);
    if ((t.fee_type === "higher_of" || t.fee_type === "lower_of") && (t.fee_amount <= 0 || t.fee_percent <= 0))
      warnings.push(`שלב ${n}: עמלת "הגבוה/הנמוך מבין" מחייבת גם סכום וגם אחוז`);

    // time range applies to before_checkin only
    if (t.trigger_type === "before_checkin") {
      if (!t.time_unit) errors.push(`שלב ${n}: חסרה יחידת זמן (שעות/ימים)`);
      const w = hourWindow(t);
      if (w.from < 0) errors.push(`שלב ${n}: טווח זמן שלילי`);
      if (Number.isFinite(w.to) && w.from >= w.to)
        errors.push(`שלב ${n}: טווח הפוך — הערך "מ־" חייב להיות קטן מהערך "עד"`);
    }
  });

  // --- overlaps / duplicates across before_checkin tiers ---
  const timed = tiers
    .map((t, i) => ({ i, t, w: hourWindow(t) }))
    .filter((x) => x.t.trigger_type === "before_checkin");

  for (let a = 0; a < timed.length; a++) {
    for (let b = a + 1; b < timed.length; b++) {
      const A = timed[a], B = timed[b];
      const dup = A.w.from === B.w.from && A.w.to === B.w.to;
      if (dup) {
        errors.push(`שלבים ${A.i + 1} ו־${B.i + 1}: כלל כפול (אותו טווח זמן)`);
      } else if (overlaps(A.w, B.w)) {
        errors.push(`שלבים ${A.i + 1} ו־${B.i + 1}: טווחי זמן חופפים — לא ניתן לקבוע איזה כלל גובר`);
      }
    }
  }

  // --- coverage of the before-check-in axis [0, ∞): gap = warning, no catch-all = warning ---
  if (timed.length > 0) {
    const sorted = [...timed].sort((x, y) => x.w.from - y.w.from);
    let cursor = 0;
    let covered = true;
    for (const s of sorted) {
      if (s.w.from > cursor) { covered = false; break; }
      cursor = Math.max(cursor, s.w.to);
    }
    if (!covered) warnings.push("קיים פער בטווחי הזמן שאינו מכוסה על ידי אף כלל");
    if (Number.isFinite(cursor))
      warnings.push("אין כלל פתוח (catch-all) לביטול המוקדם ביותר — הוסף טווח פתוח או כלל ברירת מחדל");
  }

  // --- no-show rule presence (§B validation list) ---
  if (!tiers.some((t) => t.trigger_type === "no_show"))
    warnings.push("חסר כלל אי-הגעה (no-show)");

  return { errors, warnings };
}
