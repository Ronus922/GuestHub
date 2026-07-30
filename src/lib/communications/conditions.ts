import { normalizePhone } from "@/lib/phone";
import { automationConditionsSchema } from "./schemas";
import type { CommunicationChannel } from "./types";

// ============================================================
// Condition evaluation (D114) — recipient- and channel-scoped.
//
// A guest-contact condition ("does the guest have an email/phone?") describes
// ONE party. It may gate only that party's leg: an automation whose guest is
// not a deliverable recipient must never be blocked by it. The registry keeps
// storing `guest.email` as the canonical guest-contact marker (stored rows
// never change shape); the CHANNEL decides which field is actually checked.
//
// Pure and free of "server-only" on purpose — the guard script
// (check-guest-communications-automation.mjs) compiles and runs this exact
// module; a copy would rot.
// ============================================================

/** The reservation fields conditions can see. ReservationSnapshot satisfies this. */
export type ConditionSubject = {
  status: string;
  is_test: boolean;
  guest_email: string | null;
  guest_phone: string | null;
  balance: number;
  room_numbers: string | null;
};

export type ConditionScope = {
  channel: CommunicationChannel;
  /**
   * true only when the automation has a DELIVERABLE guest leg — the guest is
   * selected AND their address passed the per-leg gate. A guest whose leg was
   * already skipped (missing_guest_phone/email) receives nothing, so their
   * contact condition must not block the remaining recipients either.
   */
  guestIsRecipient: boolean;
};

type ConditionItem = { field: string; operator: string; value?: string | number | boolean };
export type ConditionFailure = ConditionItem & { actual: unknown };
export type ConditionVerdict = { pass: boolean; failed: ConditionFailure[] };

const GUEST_CONTACT_FIELDS = new Set(["guest.email", "guest.phone"]);

export function isGuestContactField(field: string): boolean {
  return GUEST_CONTACT_FIELDS.has(field);
}

/**
 * Scope stored condition items to the automation they run for: guest-contact
 * items are dropped when the guest receives nothing, and follow the channel
 * (email → guest.email, whatsapp → guest.phone) when the guest is a recipient.
 */
export function resolveConditionItems(items: ConditionItem[], scope: ConditionScope): ConditionItem[] {
  const resolved: ConditionItem[] = [];
  for (const item of items) {
    if (!isGuestContactField(item.field)) {
      resolved.push(item);
      continue;
    }
    if (!scope.guestIsRecipient) continue;
    resolved.push({ ...item, field: scope.channel === "whatsapp" ? "guest.phone" : "guest.email" });
  }
  return resolved;
}

function conditionValue(field: string, row: ConditionSubject): unknown {
  switch (field) {
    case "reservation.status": return row.status;
    case "reservation.is_test": return row.is_test;
    case "reservation.is_cancelled": return row.status === "cancelled";
    case "guest.email": return row.guest_email;
    // A phone that normalizePhone rejects does not "exist" for sending purposes.
    case "guest.phone": {
      const phone = normalizePhone(row.guest_phone);
      return phone.valid ? phone.e164 : null;
    }
    case "payment.balance": return row.balance;
    case "room.number": return row.room_numbers;
    default: return undefined;
  }
}

export function evaluateConditions(raw: unknown, row: ConditionSubject, scope: ConditionScope): ConditionVerdict {
  const config = automationConditionsSchema.parse(raw);
  const items = resolveConditionItems(config.items, scope);
  const failed: ConditionFailure[] = [];
  let anyPassed = items.length === 0;
  for (const item of items) {
    const actual = conditionValue(item.field, row);
    const passed = (() => {
      switch (item.operator) {
        case "equals": return actual === item.value;
        case "not_equals": return actual !== item.value;
        case "exists": return actual !== null && actual !== undefined && String(actual).trim() !== "";
        case "greater_than": return typeof actual === "number" && typeof item.value === "number" && actual > item.value;
        default: return false;
      }
    })();
    if (passed) anyPassed = true;
    else failed.push({ ...item, actual });
  }
  return config.logic === "all"
    ? { pass: failed.length === 0, failed }
    : { pass: anyPassed, failed: anyPassed ? [] : failed };
}

const FIELD_LABELS: Record<string, string> = {
  "reservation.status": "סטטוס ההזמנה",
  "guest.email": "כתובת האימייל של האורח",
  "guest.phone": "מספר הטלפון של האורח",
  "payment.balance": "היתרה לתשלום",
  "room.number": "מספר החדר",
};

function describeFailure(f: ConditionFailure): string {
  if (f.field === "reservation.is_test") return "זו הזמנת בדיקה";
  if (f.field === "reservation.is_cancelled") return f.actual === true ? "ההזמנה בוטלה" : "ההזמנה אינה מבוטלת";
  if (f.field === "reservation.status") return `סטטוס ההזמנה "${String(f.actual)}" במקום "${String(f.value)}"`;
  const label = FIELD_LABELS[f.field] ?? f.field;
  if (f.operator === "exists") return `${label} חסר או אינו תקין`;
  return `${label}: "${String(f.actual)}" במקום "${String(f.value)}"`;
}

/**
 * The Hebrew evidence line a conditions_not_met skip row carries — names WHICH
 * predicate failed (D112: a failure carries its own evidence), with the
 * machine-readable predicates in brackets.
 */
export function describeConditionFailures(failed: ConditionFailure[]): string | null {
  if (!failed.length) return null;
  const human = failed.map(describeFailure).join("; ");
  const technical = failed
    .map((f) => `${f.field} ${f.operator}${f.value !== undefined ? ` ${String(f.value)}` : ""}`)
    .join(", ");
  return `תנאי האוטומציה לא התקיימו — ${human} [${technical}]`.slice(0, 400);
}
