import "server-only";
import type { TransactionSql } from "postgres";
import { calculateReservationPrice } from "@/lib/pricing/engine";
import { RESTRICTION_CODES } from "@/lib/pricing/reservation-pricing";
import { logChannelError } from "./queue";

// ============================================================
// D153 — an OTA booking NEVER blocks on stay restrictions, but it is checked
// and reported.
//
// The booking already happened at the channel. Rejecting the import does not
// un-sell the room; it only hides a sold room from the PMS, which produces the
// two worst outcomes there are: a guest arriving with no record, and the same
// room sold twice. So the import always writes.
//
// But a min/max-stay violation arriving from an OTA is evidence of a real
// defect — either the ARI projection published the wrong restriction to
// Beds24, or somebody overrode it by hand in the extranet. Both need to be
// known, so every violation lands on the operator's error surface
// (channel_sync_errors, surfaced by the channels screen) and, for permanent
// history, on the reservation's audit trail.
//
// Nothing here may ever fail the import: every call site wraps this, and this
// module additionally swallows its own errors. The channel's price stays
// authoritative — calculateReservationPrice is a pure read (the engine issues
// no writes) and its price is deliberately discarded.
// ============================================================

export type OtaRestrictionViolation = {
  roomId: string;
  code: string;
  message: string;
  date: string | null;
  checkIn: string;
  checkOut: string;
};

type StayToCheck = {
  roomId: string;
  localRatePlanId: string | null;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  infants: number;
};

// Evaluate one stay and return its restriction violations. The engine computes
// them regardless of any enforcement flag — this is exactly the information the
// import used to discard.
async function violationsForStay(
  tx: TransactionSql,
  tenantId: string,
  stay: StayToCheck,
): Promise<OtaRestrictionViolation[]> {
  const quote = await calculateReservationPrice(tx, {
    tenantId,
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    rooms: [{
      roomId: stay.roomId,
      ratePlanId: stay.localRatePlanId,
      adults: stay.adults,
      children: stay.children,
      infants: stay.infants,
      manualRatePerNight: null,
    }],
    source: "channel_manager",
  });

  const room = quote.rooms[0];
  if (!room) return []; // request-level rejection — not a restriction finding
  return room.errors
    .filter((e) => RESTRICTION_CODES.has(e.code))
    .map((e) => ({
      roomId: stay.roomId,
      code: e.code,
      message: e.message,
      date: e.date ?? null,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
    }));
}

// Check every stay of an imported booking and report what it finds. Returns the
// violations for the caller's audit payload. NEVER throws.
export async function reportOtaRestrictionViolations(
  tx: TransactionSql,
  ctx: {
    tenantId: string;
    connectionId: string;
    reservationId: string;
    reservationNumber: string | null;
    bookingId: string;
    otaName: string | null;
  },
  stays: StayToCheck[],
): Promise<OtaRestrictionViolation[]> {
  try {
    const found: OtaRestrictionViolation[] = [];
    for (const stay of stays) {
      found.push(...(await violationsForStay(tx, ctx.tenantId, stay)));
    }
    if (found.length === 0) return [];

    // The operator surface. One row per import, not per stay: the operator acts
    // on the booking, and channel_sync_errors is filtered by resolved_at.
    await logChannelError(tx, {
      tenantId: ctx.tenantId,
      connectionId: ctx.connectionId,
      code: "OTA_STAY_RESTRICTION_VIOLATION",
      message:
        `הזמנת ${ctx.otaName ?? "ערוץ"} ${ctx.reservationNumber ?? ctx.bookingId} ` +
        `מפרה מגבלת שהות: ${found.map((v) => v.message).join(" · ")}. ` +
        `ההזמנה נקלטה — יש לבדוק את ההקרנה ל-Beds24 או שינוי ידני באקסטרא-נט.`,
      dateFrom: found.reduce((m, v) => (v.checkIn < m ? v.checkIn : m), found[0].checkIn),
      dateTo: found.reduce((m, v) => (v.checkOut > m ? v.checkOut : m), found[0].checkOut),
      context: {
        reservation_id: ctx.reservationId,
        reservation_number: ctx.reservationNumber,
        booking_id: ctx.bookingId,
        ota_name: ctx.otaName,
        violations: found,
      },
    });
    return found;
  } catch {
    // A failure to REPORT must never fail the IMPORT. The booking is already
    // written; losing the report is bad, losing the booking is worse.
    return [];
  }
}
