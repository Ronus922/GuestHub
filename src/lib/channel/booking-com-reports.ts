"use server";

import { sql } from "@/lib/db";
import { getActor, requirePermission } from "@/lib/auth/actor";
import { writeAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { submitBookingComReport } from "./booking-com-reports-core";
import type { BookingReportAction } from "./booking-com-report-rules";

// ============================================================
// Booking.com status reports — the SERVER ACTIONS (D96).
//
// Deliberately thin. This module owns exactly three things a "use server"
// module must own and nothing else:
//   1. a valid session + the reservations.channel_report permission (UI hiding
//      is not security — the gate lives here, on every action),
//   2. the actor audit trail of WHO triggered an irreversible channel request,
//   3. cache revalidation of the screens that display the report stamps.
// Every guard that can be tested without Next — tenant scoping, "is this a
// Booking.com booking", the time windows, the cancel-needs-a-prior-report rule,
// the ledger write — lives in ./booking-com-reports-core.ts, which is why
// scripts/check-booking-com-reports.mjs can prove them.
//
// D41/D87 CARD LINE: these are STATUS reports. No action here reads, writes or
// references guesthub.reservation_cards; no PAN, CVV or expiry exists anywhere
// on this path. "Invalid card" is a claim ABOUT a card, never a card.
//
// The Hebrew messages the operator sees come from the core and from
// beds24-http's fixed category vocabulary — never from an upstream body.
// ============================================================

export type BookingReportResult = { success: true } | { success: false; error: string };

async function run(
  reservationId: string,
  action: BookingReportAction,
  waivedFees: boolean | null,
): Promise<BookingReportResult> {
  const actor = await getActor();
  requirePermission(actor, "reservations.channel_report");

  const outcome = await submitBookingComReport(sql, {
    tenantId: actor.tenantId,
    reservationId,
    action,
    waivedFees,
    actorUserId: actor.userId,
  });

  // audited either way: an ATTEMPTED irreversible channel request is itself the
  // fact worth recording. No card field, no upstream body — action + outcome.
  await writeAudit(actor, {
    entityType: "reservation",
    entityId: reservationId,
    action: `booking_com_report_${action}`,
    after: {
      outcome: outcome.success ? "success" : "failed",
      ...(outcome.success ? {} : { error: outcome.error }),
      ...(waivedFees === null ? {} : { waived_fees_local_record: waivedFees }),
    },
  });

  if (outcome.success) {
    revalidatePath("/reservations");
    revalidatePath("/calendar");
  }
  return outcome;
}

/**
 * Report the reservation's card as invalid to Booking.com.
 * Provider window: before check-in (apiV2.yaml). Reversible in no sense —
 * Booking.com notifies the guest and starts its own card-replacement flow.
 */
export async function reportInvalidCard(reservationId: string): Promise<BookingReportResult> {
  return run(reservationId, "invalid_card", null);
}

/**
 * Ask Booking.com to cancel the booking BECAUSE the card was invalid
 * (wire action reportCancel). Allowed only after a successful invalid-card
 * report. This never flips the local status: the cancellation lands when the
 * cancelled revision comes back through the canonical import (D93).
 */
export async function cancelDueInvalidCard(reservationId: string): Promise<BookingReportResult> {
  return run(reservationId, "cancel_due_invalid_card", null);
}

/**
 * Report a no-show to Booking.com.
 * Provider window: from check-in for 2 days (apiV2.yaml).
 *
 * `waivedFees` is a LOCAL RECORD ONLY. POST /channels/booking accepts exactly
 * bookingId and action — there is no fee-waiver field in the provider contract,
 * so nothing about the waiver is transmitted. It is stored on the ledger row so
 * the collection side knows the fee was forgiven; an actual waiver must be
 * performed in the Booking.com extranet.
 */
export async function reportNoShow(
  reservationId: string,
  waivedFees: boolean,
): Promise<BookingReportResult> {
  return run(reservationId, "no_show", waivedFees);
}
