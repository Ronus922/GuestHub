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
//
// D201 — every scheduled trigger is one cell of anchor (check_in | check_out) ×
// when (before | on | after). The operator picks the two axes; the registry
// maps them to the trigger id (scheduledTriggerId), so each cell keeps its own
// eligibility and its own occurrence-key slug, and the three pre-D201 ids keep
// their rows, keys and behaviour byte-for-byte.
// ============================================================

export const TRIGGER_IDS = [
  "reservation.confirmed",
  "reservation.cancelled",
  "reservation.pre_arrival",
  "reservation.check_in_day",
  "reservation.post_checkout",
  // D201 — the three windows that complete anchor × when (relative schedule).
  "reservation.post_check_in",
  "reservation.pre_departure",
  "reservation.check_out_day",
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
    description: "נשלח X ימים לפני ההגעה, בשעה שתבחרו. הזמנה שבוטלה בינתיים לא תקבל את ההודעה.",
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
    label: "יום ההגעה",
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
    description: "נשלח X ימים אחרי העזיבה — תודה, בקשת חוות דעת או הזמנה לחזור.",
    shortName: "post_checkout",
    anchor: "check_out",
    direction: "after",
    // D201 — 1–30 like every before/after window; day 0 is "ביום העזיבה"
    // (reservation.check_out_day), which deliberately excludes checked_out.
    offsetDays: { min: 1, max: 30, default: 1 },
    defaultSendTime: "11:00",
    // Lenient by design: operators often never press "checkout", so a stay
    // that ended while still marked confirmed/checked_in must still qualify.
    eligibleStatuses: ["checked_out", "confirmed", "checked_in"],
    otaHardSkip: false,
    defaultConditions: { logic: "all", items: [...BASE_ITEMS] },
    defaultExclusions: { guestCommunicationOptOut: true, ota: true },
  },
  // D201 — the in-stay windows. "In the stay" is DATE-based (check_in <= day <
  // check_out): statuses in production are stale (guests never pressed
  // check-in/out), so a computed day outside the stay is skipped as
  // outside_stay by the scheduler instead of trusting the status.
  "reservation.post_check_in": {
    id: "reservation.post_check_in",
    kind: "scheduled",
    label: "במהלך השהייה — אחרי ההגעה",
    description: "נשלח X ימים אחרי יום ההגעה, כל עוד האורח עדיין שוהה. יום שנופל ביום העזיבה או אחריו — לא נשלח.",
    shortName: "post_check_in",
    anchor: "check_in",
    direction: "after",
    offsetDays: { min: 1, max: 30, default: 1 },
    defaultSendTime: "10:00",
    eligibleStatuses: ["confirmed", "checked_in"],
    otaHardSkip: false,
    defaultConditions: { logic: "all", items: [...BASE_ITEMS] },
    defaultExclusions: { guestCommunicationOptOut: true, ota: true },
  },
  "reservation.pre_departure": {
    id: "reservation.pre_departure",
    kind: "scheduled",
    label: "במהלך השהייה — לפני העזיבה",
    description: "נשלח X ימים לפני יום העזיבה, כל עוד האורח כבר הגיע. יום שנופל לפני ההגעה — לא נשלח.",
    shortName: "pre_departure",
    anchor: "check_out",
    direction: "before",
    offsetDays: { min: 1, max: 30, default: 1 },
    defaultSendTime: "10:00",
    eligibleStatuses: ["confirmed", "checked_in"],
    otaHardSkip: false,
    defaultConditions: { logic: "all", items: [...BASE_ITEMS] },
    defaultExclusions: { guestCommunicationOptOut: true, ota: true },
  },
  "reservation.check_out_day": {
    id: "reservation.check_out_day",
    kind: "scheduled",
    label: "יום העזיבה",
    description: "נשלח ביום העזיבה עצמו, בשעה שתבחרו — למי שעדיין לא סומן כעזב.",
    shortName: "check_out_day",
    anchor: "check_out",
    direction: "on",
    defaultSendTime: "09:00",
    eligibleStatuses: ["confirmed", "checked_in"],
    otaHardSkip: false,
    defaultConditions: { logic: "all", items: [...BASE_ITEMS] },
    defaultExclusions: { guestCommunicationOptOut: true, ota: true },
  },
};

// ============================================================
// D201 — relative schedule: anchor × when → trigger id.
// ============================================================

export type ScheduleAnchor = "check_in" | "check_out";
export type ScheduleWhen = "before" | "on" | "after";

export const SCHEDULE_ANCHORS: { id: ScheduleAnchor; label: string }[] = [
  { id: "check_in", label: "הגעה" },
  { id: "check_out", label: "עזיבה" },
];
const anchorNoun = (anchor: ScheduleAnchor) => (anchor === "check_out" ? "העזיבה" : "ההגעה");

/** The "מתי" options. "on" names its anchor — "ביום העזיבה" / "ביום ההגעה"; label only. */
export function scheduleWhens(anchor: ScheduleAnchor): { id: ScheduleWhen; label: string }[] {
  return [
    { id: "before", label: "לפני" },
    { id: "on", label: `ביום ${anchorNoun(anchor)}` },
    { id: "after", label: "אחרי" },
  ];
}

/** The scheduled trigger that owns one anchor × when cell. Total: 6 cells, 6 ids. */
export function scheduledTriggerId(anchor: ScheduleAnchor, when: ScheduleWhen): TriggerId {
  const hit = TRIGGER_IDS.find((id) => TRIGGERS[id].kind === "scheduled"
    && TRIGGERS[id].anchor === anchor && TRIGGERS[id].direction === when);
  if (!hit) throw new Error(`no scheduled trigger for ${anchor}/${when}`);
  return hit;
}

/**
 * True when the window lives INSIDE the stay (after check-in, before
 * check-out): the scheduler then requires check_in <= day < check_out and
 * records outside_stay otherwise. Derived from the axes, never listed by id.
 */
export function isInStayWindow(trigger: Pick<TriggerDef, "anchor" | "direction">): boolean {
  return (trigger.anchor === "check_in" && trigger.direction === "after")
    || (trigger.anchor === "check_out" && trigger.direction === "before");
}

export type TimingState = { triggerType: TriggerId; offsetDays: number; sendTime: string };

/**
 * The editor's state transition when the operator picks another trigger or
 * schedule window (D201 follow-up). Moving to a scheduled window ALWAYS lands
 * on that window's own defaults — days and time — never on the day count of
 * the window it came from (that leaked pre-arrival's 3 days into "לפני
 * עזיבה"). An event trigger has no timing and leaves the values alone.
 * Opening an existing automation never goes through here: the panel seeds its
 * state from the saved timing_config.
 */
export function nextTimingState(prev: TimingState, next: TriggerId): TimingState {
  const def = TRIGGERS[next];
  if (def.kind !== "scheduled") return { ...prev, triggerType: next };
  return {
    triggerType: next,
    offsetDays: def.direction === "on" ? 0 : def.offsetDays?.default ?? 0,
    sendTime: def.defaultSendTime ?? "10:00",
  };
}

function hebrewDays(n: number): string {
  if (n === 1) return "יום אחד";
  if (n === 2) return "יומיים";
  return `${n} ימים`;
}

/** "תישלח יום אחד לפני העזיבה בשעה 09:00" — the editor's live sentence. */
export function describeSchedule(anchor: ScheduleAnchor, when: ScheduleWhen, offsetDays: number, sendTime: string): string {
  const noun = anchorNoun(anchor);
  const day = when === "on"
    ? `ביום ${noun}`
    : `${hebrewDays(offsetDays)} ${when === "before" ? "לפני" : "אחרי"} ${noun}`;
  return `תישלח ${day} בשעה ${sendTime}`;
}

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

/** Hebrew one-liner for the automation list row: "תישלח 3 ימים לפני ההגעה בשעה 10:00". */
export function describeTiming(triggerType: string, timing: Record<string, unknown> | null | undefined): string {
  const trigger = triggerFor(triggerType);
  if (!trigger) return triggerType;
  if (trigger.kind === "event") return `${trigger.label} · שליחה מיידית`;
  const offset = Number((timing as { offsetDays?: number } | null)?.offsetDays ?? trigger.offsetDays?.default ?? 0);
  const sendTime = String((timing as { sendTime?: string } | null)?.sendTime ?? trigger.defaultSendTime ?? "09:00");
  return describeSchedule(trigger.anchor ?? "check_in", trigger.direction ?? "on", offset, sendTime);
}

export const CHANNEL_LABELS: Record<CommunicationChannel, string> = {
  email: "אימייל",
  whatsapp: "WhatsApp",
};

type QuietHoursConfig = { enabled?: boolean; start?: string; end?: string };

const QUIET_HOURS_ZONE = "Asia/Jerusalem";

/** Wall-clock parts of `date` in Asia/Jerusalem — independent of process TZ. */
export function israelParts(date: Date): { y: number; mo: number; d: number; h: number; mi: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: QUIET_HOURS_ZONE, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute") };
}

/** The instant at which Israel's wall clock reads y-mo-d h:mi (DST-correct). */
export function israelWallTimeToInstant(y: number, mo: number, d: number, h: number, mi: number): Date {
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let guess = target;
  // Two passes settle the offset even across a DST boundary.
  for (let i = 0; i < 2; i += 1) {
    const p = israelParts(new Date(guess));
    guess += target - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  }
  return new Date(guess);
}

/**
 * Clamp a send time into the allowed window. Pure — unit-tested by the guard
 * scripts. A window that crosses midnight (22:00 → 07:00) suppresses sends
 * after `start` OR before `end`; a same-day window (13:00 → 15:00) suppresses
 * inside it. The clamped time is the window's END on the correct day.
 *
 * D201 — the window is Israel wall-clock time, computed EXPLICITLY in
 * Asia/Jerusalem. It used to read the process-local clock on the claim that
 * "servers run Israel time"; the server and the PM2 worker run Etc/UTC, so a
 * 22:00–07:00 window would have fired as 01:00–10:00 Israel summer time.
 */
export function applyQuietHours(date: Date, quietHours: QuietHoursConfig | null | undefined): Date {
  if (!quietHours?.enabled || !quietHours.start || !quietHours.end) return date;
  const [startH, startM] = quietHours.start.split(":").map(Number);
  const [endH, endM] = quietHours.end.split(":").map(Number);
  if ([startH, startM, endH, endM].some((n) => !Number.isFinite(n))) return date;

  const local = israelParts(date);
  const minutes = local.h * 60 + local.mi;
  const start = startH * 60 + startM;
  const end = endH * 60 + endM;
  const crossesMidnight = start > end;
  const inQuiet = crossesMidnight ? minutes >= start || minutes < end : minutes >= start && minutes < end;
  if (!inQuiet) return date;

  // Over-midnight window, caught in the evening segment → the window ends
  // tomorrow morning (Israel calendar day; Date.UTC normalises day overflow).
  const dayShift = crossesMidnight && minutes >= start ? 1 : 0;
  const day = new Date(Date.UTC(local.y, local.mo - 1, local.d + dayShift));
  return israelWallTimeToInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), endH, endM);
}
