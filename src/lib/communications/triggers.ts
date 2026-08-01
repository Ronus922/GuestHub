import type { CommunicationChannel } from "./types";

// ============================================================
// The trigger registry — ONE source of truth for what can start an automation.
// No "server-only" import: the AutomationPanel renders labels and timing
// controls from this catalog on the client.
//
// kind:"event"     — a producer inserts a communication_events row at the seam
//                    where the fact happens (same transaction).
// kind:"scheduled" — the worker's scheduler scan emits synthetic events when a
//                    reservation's anchor date minus/plus the offset is today
//                    (Israel time) and the send time has arrived.
// ============================================================

export const TRIGGER_IDS = [
  "reservation.confirmed",
  "reservation.cancelled",
  "reservation.pre_arrival",
  "reservation.check_in_day",
  "reservation.post_checkout",
] as const;
export type TriggerId = (typeof TRIGGER_IDS)[number];

export type TriggerConditionItem = {
  field: "reservation.status" | "reservation.is_test" | "reservation.is_cancelled" | "guest.email" | "payment.balance" | "room.number";
  operator: "equals" | "not_equals" | "exists" | "greater_than";
  value?: string | number | boolean;
};

export type TriggerDef = {
  id: TriggerId;
  kind: "event" | "scheduled";
  label: string;
  description: string;
  /** Short slug used inside scheduled occurrence keys. */
  shortName: string;
  /** scheduled only — which reservation date anchors the send. */
  anchor?: "check_in" | "check_out";
  direction?: "before" | "on" | "after";
  offsetDays?: { min: number; max: number; default: number };
  defaultSendTime?: string;
  /**
   * Reservation statuses a QUEUED delivery stays valid for — re-checked against
   * the live reservation right before sending (cancelIneligibleDeliveries) and
   * at preparation. A cancellation message must accept 'cancelled'; a
   * post-checkout message tolerates operators who never press checkout.
   */
  eligibleStatuses: string[];
  /**
   * true → OTA-linked reservations are skipped unconditionally, whatever the
   * automation says. Reserved for a trigger whose event is never emitted for a
   * channel booking: offering the source would control nothing. Since D119 the
   * import DOES emit reservation.confirmed, so no trigger carries this today —
   * every one of them leaves the decision to the automation's exclusions.ota.
   */
  otaHardSkip: boolean;
  defaultConditions: { logic: "all"; items: TriggerConditionItem[] };
  defaultExclusions: { guestCommunicationOptOut: boolean; ota: boolean };
};

const BASE_ITEMS: TriggerConditionItem[] = [
  { field: "reservation.is_test", operator: "equals", value: false },
];

export const TRIGGERS: Record<TriggerId, TriggerDef> = {
  "reservation.confirmed": {
    id: "reservation.confirmed",
    kind: "event",
    label: "הזמנה אושרה",
    description: "נשלח מיד כאשר הזמנה מאושרת — ידנית, מהאתר או בייבוא.",
    shortName: "confirmed",
    eligibleStatuses: ["confirmed"],
    // D119 — the Beds24 import now emits this event when it CREATES a
    // reservation, so the OTA source is a real operator switch: it stays OFF by
    // default (defaultExclusions.ota below), and turning it on sends OUR
    // confirmation in addition to the channel's own.
    otaHardSkip: false,
    defaultConditions: {
      logic: "all",
      items: [
        { field: "reservation.status", operator: "equals", value: "confirmed" },
        { field: "guest.email", operator: "exists" },
        ...BASE_ITEMS,
        { field: "reservation.is_cancelled", operator: "equals", value: false },
      ],
    },
    defaultExclusions: { guestCommunicationOptOut: true, ota: true },
  },
  "reservation.cancelled": {
    id: "reservation.cancelled",
    kind: "event",
    label: "הזמנה בוטלה",
    description: "נשלח מיד כאשר הזמנה מבוטלת — פעם אחת לכל הזמנה.",
    shortName: "cancelled",
    eligibleStatuses: ["cancelled"],
    otaHardSkip: false,
    defaultConditions: {
      logic: "all",
      items: [
        { field: "reservation.status", operator: "equals", value: "cancelled" },
        ...BASE_ITEMS,
      ],
    },
    defaultExclusions: { guestCommunicationOptOut: true, ota: true },
  },
  "reservation.pre_arrival": {
    id: "reservation.pre_arrival",
    kind: "scheduled",
    label: "תזכורת לפני הגעה",
    description: "נשלח X ימים לפני הצ׳ק-אין, בשעה שתבחרו. הזמנה שבוטלה בינתיים לא תקבל את ההודעה.",
    shortName: "pre_arrival",
    anchor: "check_in",
    direction: "before",
    offsetDays: { min: 1, max: 30, default: 3 },
    defaultSendTime: "10:00",
    eligibleStatuses: ["confirmed"],
    otaHardSkip: false,
    defaultConditions: {
      logic: "all",
      items: [
        { field: "reservation.status", operator: "equals", value: "confirmed" },
        ...BASE_ITEMS,
      ],
    },
    defaultExclusions: { guestCommunicationOptOut: true, ota: true },
  },
  "reservation.check_in_day": {
    id: "reservation.check_in_day",
    kind: "scheduled",
    label: "יום הצ׳ק-אין",
    description: "נשלח ביום ההגעה עצמו, בשעה שתבחרו.",
    shortName: "check_in_day",
    anchor: "check_in",
    direction: "on",
    defaultSendTime: "09:00",
    eligibleStatuses: ["confirmed"],
    otaHardSkip: false,
    defaultConditions: {
      logic: "all",
      items: [
        { field: "reservation.status", operator: "equals", value: "confirmed" },
        ...BASE_ITEMS,
      ],
    },
    defaultExclusions: { guestCommunicationOptOut: true, ota: true },
  },
  "reservation.post_checkout": {
    id: "reservation.post_checkout",
    kind: "scheduled",
    label: "לאחר העזיבה",
    description: "נשלח X ימים אחרי הצ׳ק-אאוט — תודה, בקשת חוות דעת או הזמנה לחזור.",
    shortName: "post_checkout",
    anchor: "check_out",
    direction: "after",
    offsetDays: { min: 0, max: 14, default: 1 },
    defaultSendTime: "11:00",
    // Lenient by design: operators often never press "checkout", so a stay
    // that ended while still marked confirmed/checked_in must still qualify.
    eligibleStatuses: ["checked_out", "confirmed", "checked_in"],
    otaHardSkip: false,
    defaultConditions: { logic: "all", items: [...BASE_ITEMS] },
    defaultExclusions: { guestCommunicationOptOut: true, ota: true },
  },
};

export const TRIGGER_LIST: TriggerDef[] = TRIGGER_IDS.map((id) => TRIGGERS[id]);

// ============================================================
// Booking-source groups (D118). Three groups, matching how the business
// actually sells: OTA · direct (back-office + app) · website. The ids ARE the
// booking_origin values the engine filters on (source_filters.include), so a
// chip can never offer a source the send path cannot evaluate.
//
// ONE catalog for the chips AND for the server's Zod enum — a control that
// offers a source the save path would reject is the defect class D118 forbids.
// ============================================================

export const SOURCE_GROUPS = [
  {
    id: "back_office",
    label: "ישיר — בק-אופיס",
    hint: "הזמנות שהצוות יצר במערכת, כולל הזמנות טלפוניות",
  },
  {
    id: "direct_website",
    label: "אתר ההזמנות",
    hint: "הזמנות שהאורח ביצע באתר שלכם",
  },
  {
    id: "ota",
    label: "ערוצי OTA",
    hint: "הזמנות שיובאו מערוץ מכירה (Booking.com וכיוצא בו)",
  },
] as const;
export type SourceGroupId = (typeof SOURCE_GROUPS)[number]["id"];
export const SOURCE_GROUP_IDS = SOURCE_GROUPS.map((g) => g.id) as readonly SourceGroupId[];

/**
 * D118 — why the OTA group cannot be switched on for this trigger, or null when
 * it CAN. Derived from `otaHardSkip`, the very flag the engine's global skip
 * reads (automation.ts), so the control and the send path can never drift: if
 * the panel offers OTA, the engine will evaluate it.
 *
 * D119 — this now returns null for EVERY trigger, because the last capability
 * gap closed: the Beds24 import emits `reservation.confirmed` when it creates a
 * reservation (booking-import.ts), so an enabled OTA chip controls something
 * real on all five triggers. The function stays, and stays derived, because the
 * rule it encodes has not changed: a source is offered only where the send path
 * can honour it. A future trigger whose event no channel booking ever produces
 * sets otaHardSkip and is blocked here automatically.
 */
export function otaSourceBlockReason(triggerId: TriggerId): string | null {
  return TRIGGERS[triggerId].otaHardSkip
    ? "לא נפלט אירוע עבור הזמנות OTA בטריגר הזה — הפעלה כאן לא הייתה שולחת דבר."
    : null;
}

export function triggerFor(triggerType: string): TriggerDef | null {
  return (TRIGGERS as Record<string, TriggerDef>)[triggerType] ?? null;
}

/** Hebrew one-liner for the automation list row: "תזכורת לפני הגעה · 3 ימים לפני צ׳ק-אין · 10:00". */
export function describeTiming(triggerType: string, timing: Record<string, unknown> | null | undefined): string {
  const trigger = triggerFor(triggerType);
  if (!trigger) return triggerType;
  if (trigger.kind === "event") return `${trigger.label} · שליחה מיידית`;
  const offset = Number((timing as { offsetDays?: number } | null)?.offsetDays ?? trigger.offsetDays?.default ?? 0);
  const sendTime = String((timing as { sendTime?: string } | null)?.sendTime ?? trigger.defaultSendTime ?? "");
  const anchorLabel = trigger.anchor === "check_out" ? "צ׳ק-אאוט" : "צ׳ק-אין";
  const when = trigger.direction === "on" || offset === 0
    ? `ביום ה${anchorLabel}`
    : trigger.direction === "before"
      ? `${offset} ימים לפני ה${anchorLabel}`
      : `${offset} ימים אחרי ה${anchorLabel}`;
  return `${trigger.label} · ${when}${sendTime ? ` · ${sendTime}` : ""}`;
}

export const CHANNEL_LABELS: Record<CommunicationChannel, string> = {
  email: "אימייל",
  whatsapp: "WhatsApp",
};

type QuietHoursConfig = { enabled?: boolean; start?: string; end?: string };

/**
 * Clamp a send time into the allowed window. Pure — unit-tested by the guard
 * script. A window that crosses midnight (22:00 → 07:00) suppresses sends
 * after `start` OR before `end`; a same-day window (13:00 → 15:00) suppresses
 * inside it. The clamped time is the window's END on the correct day.
 * Times are interpreted in the runtime's local clock (servers run Israel time,
 * like the rest of the scheduling stack).
 */
export function applyQuietHours(date: Date, quietHours: QuietHoursConfig | null | undefined): Date {
  if (!quietHours?.enabled || !quietHours.start || !quietHours.end) return date;
  const [startH, startM] = quietHours.start.split(":").map(Number);
  const [endH, endM] = quietHours.end.split(":").map(Number);
  if ([startH, startM, endH, endM].some((n) => !Number.isFinite(n))) return date;

  const minutes = date.getHours() * 60 + date.getMinutes();
  const start = startH * 60 + startM;
  const end = endH * 60 + endM;
  const crossesMidnight = start > end;
  const inQuiet = crossesMidnight ? minutes >= start || minutes < end : minutes >= start && minutes < end;
  if (!inQuiet) return date;

  const clamped = new Date(date);
  clamped.setHours(endH, endM, 0, 0);
  // Over-midnight window, caught in the evening segment → the window ends
  // tomorrow morning.
  if (crossesMidnight && minutes >= start) clamped.setDate(clamped.getDate() + 1);
  return clamped;
}
