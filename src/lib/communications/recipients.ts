import "server-only";
import type postgres from "postgres";
import { z } from "zod";
import { sql, withReadOnlyScope } from "@/lib/db";
import { addDays, dateInTz, type DateOnly } from "@/lib/dates";
import { inHouseOn } from "@/lib/in-house";
import { isIsraeliMobile, normalizePhone } from "@/lib/phone";

// ============================================================
// D206 — who a broadcast would reach. Read-only: no sends, no writes (the whole
// resolution runs inside withReadOnlyScope, so PostgreSQL refuses a write).
//
//  - Service segments only (D206: marketing / past-guest segments are a later
//    phase). Every criterion present in a segment must hold (AND).
//  - In house = DATE-based (lib/in-house.ts, the dashboard's definition), on the
//    Asia/Jerusalem calendar date of `at` — never a status, never the UTC date.
//  - Always excluded, each with its reason: cancelled, no_show, is_test,
//    opt-out, missing / invalid phone, Israeli landline.
//  - One message per phone: deduped by normalized E.164; the most relevant
//    reservation is kept (in house first, then the nearest arrival) and the
//    others are listed as duplicate_phone.
//
// The phone is the reservation's PRIMARY GUEST phone — the one the automation
// engine sends to — so a multi-room booking is one recipient, never one per room.
// ============================================================

/** D206 — broadcast dates are Israel's calendar, mandatory. */
export const BROADCAST_TIMEZONE = "Asia/Jerusalem";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** A stay criterion, evaluated per ROOM stay (reservation_rooms) against the date of `at`. */
const stayCriterionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("in_house") }),
  z.object({ kind: z.literal("arriving"), day: z.enum(["today", "tomorrow"]) }),
  z.object({ kind: z.literal("departing"), day: z.enum(["today", "tomorrow"]) }),
  /** the stay overlaps [from, to] (inclusive calendar days) */
  z.object({ kind: z.literal("overlapping"), from: isoDate, to: isoDate }).refine((v) => v.from <= v.to, "from אחרי to"),
  /** arrival after today */
  z.object({ kind: z.literal("future") }),
]);

export const broadcastSegmentSchema = z.object({
  stay: z.array(stayCriterionSchema).max(5).optional(),
  roomIds: z.array(uuid).min(1).optional(),
  roomTypeIds: z.array(uuid).min(1).optional(),
  bookingOrigins: z.array(z.enum(["back_office", "direct_website", "ota"])).min(1).optional(),
  otaNames: z.array(z.string().trim().min(1)).min(1).optional(),
  reservationIds: z.array(uuid).min(1).optional(),
  guestIds: z.array(uuid).min(1).optional(),
}).strict().refine((s) => Object.values(s).some((v) => v !== undefined && (!Array.isArray(v) || v.length > 0)),
  "סגמנט ריק — נדרש לפחות תנאי אחד");

export type BroadcastSegment = z.infer<typeof broadcastSegmentSchema>;

export type ExclusionReason =
  | "cancelled" | "no_show" | "is_test" | "opt_out"
  | "missing_phone" | "invalid_phone" | "landline" | "duplicate_phone";

/** D206 — the Hebrew the excluded list shows for each reason code. */
export const EXCLUSION_REASON_LABELS: Record<ExclusionReason, string> = {
  cancelled: "ההזמנה בוטלה",
  no_show: "האורח לא הגיע (no-show)",
  is_test: "הזמנת בדיקה",
  opt_out: "האורח ביקש לא לקבל הודעות",
  missing_phone: "אין מספר טלפון",
  invalid_phone: "מספר הטלפון אינו תקין",
  landline: "מספר קווי — לא ניתן לשלוח WhatsApp",
  duplicate_phone: "אותו מספר כבר מקבל הודעה מהזמנה אחרת",
};

export type Recipient = {
  reservationId: string;
  reservationNumber: string;
  guestId: string | null;
  /** normalized E.164 — the dedupe key and the send address */
  phone: string;
  firstName: string | null;
  language: string | null;
  checkIn: DateOnly;
  checkOut: DateOnly;
  inHouse: boolean;
};

export type RecipientResolution = {
  /** the Israel calendar date the segment was evaluated on */
  date: DateOnly;
  included: Recipient[];
  excluded: { reservationId: string; reason: ExclusionReason }[];
};

type Row = {
  id: string; reservation_number: string; status: string; is_test: boolean; opted_out: boolean;
  guest_id: string | null; first_name: string | null; language: string | null; phone: string | null;
  check_in: DateOnly; check_out: DateOnly; in_house: boolean;
};

/** null = sendable; otherwise why not. Landline: an Israeli number that is not a mobile (02/03/04/08/09, 07X). */
export function phoneExclusion(raw: string | null): "missing_phone" | "invalid_phone" | "landline" | null {
  if (!raw || !raw.trim()) return "missing_phone";
  const phone = normalizePhone(raw);
  if (!phone.valid) return "invalid_phone";
  if (!phone.digits.startsWith("972")) return null;
  if (isIsraeliMobile(raw)) return null;
  return /^972(?:[2-489]\d{7}|7\d{8})$/.test(phone.digits) ? "landline" : "invalid_phone";
}

/** Dedupe order: in house first, then the nearest arrival from today on, then the most recent past one. */
function relevance(a: Row, b: Row, today: DateOnly): number {
  if (a.in_house !== b.in_house) return a.in_house ? -1 : 1;
  const aFuture = a.check_in >= today; const bFuture = b.check_in >= today;
  if (aFuture !== bFuture) return aFuture ? -1 : 1;
  if (a.check_in !== b.check_in) return (aFuture ? a.check_in < b.check_in : a.check_in > b.check_in) ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/**
 * Resolve a broadcast segment. `tenantId` is the ACTOR's tenant (a caller
 * passes actor.tenantId, never a client value). `at` = the moment the segment
 * is evaluated (default now).
 */
export async function resolveRecipients(
  tenantId: string,
  rawSegment: unknown,
  options: { at?: Date } = {},
): Promise<RecipientResolution> {
  const segment = broadcastSegmentSchema.parse(rawSegment);
  const today = dateInTz(options.at ?? new Date(), BROADCAST_TIMEZONE);
  const tomorrow = addDays(today, 1);
  const dayOf = (d: "today" | "tomorrow") => (d === "today" ? today : tomorrow);

  // room-level predicates: ONE room stay must satisfy all of them together
  type Fragment = postgres.Fragment;
  const roomPredicates: Fragment[] = [
    ...(segment.stay ?? []).map((c): Fragment => {
      switch (c.kind) {
        case "in_house": return inHouseOn(today);
        case "arriving": return sql`rr.check_in = ${dayOf(c.day)}`;
        case "departing": return sql`rr.check_out = ${dayOf(c.day)}`;
        case "overlapping": return sql`rr.check_in <= ${c.to} AND rr.check_out > ${c.from}`;
        case "future": return sql`rr.check_in > ${today}`;
      }
    }),
    ...(segment.roomIds ? [sql`rr.room_id = ANY(${segment.roomIds})`] : []),
    ...(segment.roomTypeIds ? [sql`rm.room_type_id = ANY(${segment.roomTypeIds})`] : []),
  ];
  const and = (parts: Fragment[]) =>
    parts.reduce((acc, part) => sql`${acc} AND ${part}`, sql`TRUE`);

  const rows = await withReadOnlyScope(() => sql<Row[]>`
    SELECT r.id, r.reservation_number, r.status, r.is_test,
           -- opt-out: reservation level today; the guest-level flag (later PR) joins here
           COALESCE(r.guest_communication_opt_out, false) AS opted_out,
           g.id AS guest_id, g.first_name, g.language, g.phone,
           r.check_in::text AS check_in, r.check_out::text AS check_out,
           EXISTS (SELECT 1 FROM guesthub.reservation_rooms rr
                    WHERE rr.reservation_id = r.id AND rr.tenant_id = r.tenant_id AND ${inHouseOn(today)}) AS in_house
      FROM guesthub.reservations r
      LEFT JOIN guesthub.guests g ON g.id = r.primary_guest_id AND g.tenant_id = r.tenant_id
     WHERE r.tenant_id = ${tenantId}
       AND EXISTS (SELECT 1 FROM guesthub.reservation_rooms rr
                    LEFT JOIN guesthub.rooms rm ON rm.id = rr.room_id AND rm.tenant_id = rr.tenant_id
                    WHERE rr.reservation_id = r.id AND rr.tenant_id = r.tenant_id AND ${and(roomPredicates)})
       ${segment.bookingOrigins ? sql`AND r.booking_origin = ANY(${segment.bookingOrigins})` : sql``}
       ${segment.otaNames ? sql`AND lower(r.ota_name) = ANY(${segment.otaNames.map((n) => n.toLowerCase())})` : sql``}
       ${segment.reservationIds ? sql`AND r.id = ANY(${segment.reservationIds})` : sql``}
       ${segment.guestIds ? sql`AND r.primary_guest_id = ANY(${segment.guestIds})` : sql``}`);

  const excluded: RecipientResolution["excluded"] = [];
  const candidates: (Row & { e164: string })[] = [];
  for (const row of rows) {
    const reason: ExclusionReason | null =
      row.status === "cancelled" ? "cancelled"
      : row.status === "no_show" ? "no_show"
      : row.is_test ? "is_test"
      : row.opted_out ? "opt_out"
      : phoneExclusion(row.phone);
    if (reason) excluded.push({ reservationId: row.id, reason });
    else candidates.push({ ...row, e164: normalizePhone(row.phone).e164 });
  }

  // one message per phone — the most relevant reservation keeps it
  const byPhone = new Map<string, (Row & { e164: string })[]>();
  for (const c of candidates) byPhone.set(c.e164, [...(byPhone.get(c.e164) ?? []), c]);
  const included: Recipient[] = [];
  for (const group of byPhone.values()) {
    const [keep, ...rest] = group.sort((a, b) => relevance(a, b, today));
    included.push({
      reservationId: keep.id, reservationNumber: keep.reservation_number, guestId: keep.guest_id,
      phone: keep.e164, firstName: keep.first_name, language: keep.language,
      checkIn: keep.check_in, checkOut: keep.check_out, inHouse: keep.in_house,
    });
    for (const dup of rest) excluded.push({ reservationId: dup.id, reason: "duplicate_phone" });
  }
  included.sort((a, b) => (a.checkIn === b.checkIn ? (a.reservationId < b.reservationId ? -1 : 1) : a.checkIn < b.checkIn ? -1 : 1));
  return { date: today, included, excluded };
}
