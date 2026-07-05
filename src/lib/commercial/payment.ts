// Payment policy templates (Commercial Settings §C). A policy is an ORDERED set of
// collection stages (deposit, prepay, balance-at-check-in, …). Distinct from
// payment METHODS (lookup_items 'payment_methods') and payment STATUSES. Pure
// validation shared by the Server Action, the stage-builder UI and the DB check.
// Ready to attach to rate plans later; NO gateway here (§C).

export type PaymentTriggerType = "booking" | "before_checkin" | "checkin" | "checkout";
export type OffsetUnit = "hours" | "days";
export type PaymentAmountType = "fixed" | "percentage" | "remaining_balance" | "full_balance";
export type RetryBehavior = "manual" | "retry_then_cancel" | "retry_then_notify";

export type PaymentStage = {
  trigger_type: PaymentTriggerType;
  trigger_offset_unit: OffsetUnit | null;
  trigger_offset_value: number | null; // for before_checkin
  amount_type: PaymentAmountType;
  amount_value: number; // fixed
  amount_percent: number; // percentage
  methods: string[]; // lookup_items 'payment_methods' keys
  require_card_guarantee: boolean;
  retry_behavior: RetryBehavior;
  staff_instructions?: string | null;
  guest_text?: string | null;
};

export type ValidationResult = { errors: string[]; warnings: string[] };

const TRIGGERS: PaymentTriggerType[] = ["booking", "before_checkin", "checkin", "checkout"];
const AMOUNT_TYPES: PaymentAmountType[] = ["fixed", "percentage", "remaining_balance", "full_balance"];

// Chronological rank of a stage on the reservation timeline (smaller = earlier),
// so we can flag stages ordered out of time sequence and unreachable stages after
// a full/remaining collection. before_checkin sorts by its offset (larger offset
// = earlier). Uses hours so mixed units compare.
function timeKey(s: PaymentStage): number {
  switch (s.trigger_type) {
    case "booking": return -1e9;
    case "before_checkin": {
      const unit = s.trigger_offset_unit ?? "days";
      const h = (s.trigger_offset_value ?? 0) * (unit === "days" ? 24 : 1);
      return -h; // 30 days before (-720) is earlier than 1 day before (-24)
    }
    case "checkin": return 0;
    case "checkout": return 1e9;
  }
}

// `allowedMethods` (optional) is the canonical set of payment-method keys
// (lookup_items). When provided, any stage method outside it is an error — this is
// how the canonical reference is enforced without duplicating the method list.
export function validatePaymentStages(
  stages: PaymentStage[],
  allowedMethods?: readonly string[],
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (stages.length === 0) {
    errors.push("מדיניות תשלום חייבת לכלול לפחות שלב אחד");
    return { errors, warnings };
  }

  let percentSum = 0;
  const allow = allowedMethods ? new Set(allowedMethods) : null;

  stages.forEach((s, i) => {
    const n = i + 1;
    if (!TRIGGERS.includes(s.trigger_type)) errors.push(`שלב ${n}: סוג טריגר לא תקין`);
    if (!AMOUNT_TYPES.includes(s.amount_type)) errors.push(`שלב ${n}: סוג סכום לא תקין`);

    if (s.amount_value < 0) errors.push(`שלב ${n}: סכום לא יכול להיות שלילי`);
    if (s.amount_percent < 0 || s.amount_percent > 100)
      errors.push(`שלב ${n}: אחוז חייב להיות בין 0 ל־100`);
    if (s.amount_type === "fixed" && s.amount_value <= 0)
      errors.push(`שלב ${n}: סכום קבוע מחייב ערך חיובי`);
    if (s.amount_type === "percentage") {
      if (s.amount_percent <= 0) errors.push(`שלב ${n}: תשלום אחוזי מחייב ערך אחוז`);
      percentSum += s.amount_percent;
    }

    if (s.trigger_type === "before_checkin") {
      if (!s.trigger_offset_unit) errors.push(`שלב ${n}: חסרה יחידת זמן לפני הגעה`);
      if (s.trigger_offset_value == null || s.trigger_offset_value < 0)
        errors.push(`שלב ${n}: חסר מספר ימים/שעות לפני הגעה`);
    }

    if (allow) {
      const bad = s.methods.filter((m) => !allow.has(m));
      if (bad.length) errors.push(`שלב ${n}: אמצעי תשלום לא מוכר — ${bad.join(", ")}`);
    }
  });

  if (percentSum > 100)
    errors.push("סכום שלבי האחוז עולה על 100% מערך ההזמנה");

  const fullCount = stages.filter((s) => s.amount_type === "full_balance").length;
  if (fullCount > 1) errors.push('לא ניתן לחייב "יתרה מלאה" ביותר משלב אחד');

  // A stage after a full/remaining collection has nothing left to collect.
  const closeIdx = stages.findIndex((s) => s.amount_type === "full_balance" || s.amount_type === "remaining_balance");
  if (closeIdx !== -1 && closeIdx < stages.length - 1)
    warnings.push("קיים שלב אחרי גביית היתרה — לא יישאר סכום לגבייה");

  // Stages listed out of chronological order — advisory (the schedule still runs
  // by trigger, not by list position), warn so the builder can reorder.
  for (let i = 1; i < stages.length; i++) {
    if (timeKey(stages[i]) < timeKey(stages[i - 1])) {
      warnings.push("שלבי התשלום אינם מסודרים לפי סדר הזמן — מומלץ לסדר מחדש");
      break;
    }
  }

  return { errors, warnings };
}
