import "server-only";
import type { TransactionSql } from "postgres";
import { INVENTORY_BLOCKING_STATUSES } from "@/lib/inventory";
import { markAriDirty } from "@/lib/channel/outbox";
import { publishDomainEvent } from "@/lib/realtime/publish";
import { enqueueReservationCancelled } from "@/lib/communications/outbox";
import { writeSystemAudit } from "@/lib/audit";
import { BiosBotError } from "../errors";

// ============================================================
// guesthub.cancel_reservation (Phase 5 §15). Modeled on
// cancelReservationAction (src/app/(dashboard)/reservations/actions.ts):
// lock, refuse a channel-managed (OTA) reservation exactly the same way
// (the channel owns that cancellation, never this connector), soft-delete
// (status='cancelled' — cancel-never-delete, rooms/price/payments survive),
// audit, release inventory (ARI-dirty + inventory.changed) only when the
// reservation was actually blocking. cancellation_origin reuses the
// existing 'guest_booking_page' value (guest self-service cancellation
// channel — the closest existing fit for "the guest asked, via BIOS Bot,
// to cancel"), never a new enum value.
//
// Unlike create_reservation, the cancellation confirmation IS enqueued
// (enqueueReservationCancelled) — this is the property's formal
// cancellation record (refund/policy terms), a different concern from the
// booking-confirmation duplication risk Phase 5 flags specifically for
// create; see the closeout report for the full reasoning.
// ============================================================

const isBlocking = (status: string) => (INVENTORY_BLOCKING_STATUSES as readonly string[]).includes(status);

export type BiosBotCancelReservationRequest = { reason: string };
export type BiosBotCancelledReservation = { reservationId: string; status: "cancelled" };

export async function cancelBiosBotReservation(
  tx: TransactionSql,
  tenantId: string,
  reservationId: string,
  req: BiosBotCancelReservationRequest,
): Promise<{ resourceId: string; response: BiosBotCancelledReservation }> {
  const [res] = await tx<{ status: string; channel_connection_id: string | null }[]>`
    SELECT status, channel_connection_id FROM guesthub.reservations
    WHERE tenant_id = ${tenantId} AND id = ${reservationId}
    FOR UPDATE`;
  if (!res) throw new BiosBotError("RESERVATION_NOT_FOUND", "reservation not found");
  if (res.status === "cancelled") {
    return { resourceId: reservationId, response: { reservationId, status: "cancelled" } }; // idempotent no-op, mirrors cancelReservationAction
  }
  if (res.channel_connection_id && isBlocking(res.status)) {
    throw new BiosBotError(
      "CANCELLATION_NOT_ALLOWED",
      "this reservation is managed by a channel (OTA) — it must be cancelled there, not locally",
    );
  }
  if (!req.reason || req.reason.trim().length === 0) {
    throw new BiosBotError("VALIDATION_ERROR", "a cancellation reason is required");
  }

  const wasBlocking = isBlocking(res.status);

  await tx`
    UPDATE guesthub.reservations SET
      status = 'cancelled',
      cancelled_at = now(),
      cancelled_by_type = 'guest',
      cancellation_origin = 'guest_booking_page',
      cancellation_reason = ${req.reason}
    WHERE id = ${reservationId} AND tenant_id = ${tenantId}`;

  await writeSystemAudit(tenantId, {
    entityType: "reservation",
    entityId: reservationId,
    action: "cancel",
    after: { reason: req.reason },
    session: "bios-bot",
  }, tx);

  await enqueueReservationCancelled(tx, {
    tenantId,
    reservationId,
    bookingOrigin: "back_office",
    cancellationOrigin: "guest_booking_page",
    initiatedBy: null,
  });

  if (wasBlocking) {
    const rooms = await tx<{ room_id: string | null; check_in: string; check_out: string }[]>`
      SELECT room_id, check_in::text AS check_in, check_out::text AS check_out
      FROM guesthub.reservation_rooms WHERE reservation_id = ${reservationId} AND tenant_id = ${tenantId}`;
    const roomIds = rooms.map((r) => r.room_id).filter((x): x is string => !!x);
    if (roomIds.length > 0) {
      const dateFrom = rooms.reduce((m, r) => (r.check_in < m ? r.check_in : m), rooms[0].check_in);
      const dateTo = rooms.reduce((m, r) => (r.check_out > m ? r.check_out : m), rooms[0].check_out);
      await markAriDirty(tx, { tenantId, roomIds, dateFrom: dateFrom as never, dateTo: dateTo as never });
      await publishDomainEvent(tx, tenantId, {
        type: "reservation.cancelled",
        reservationId,
        roomIds,
        dateFrom: dateFrom as never,
        dateTo: dateTo as never,
      });
      await publishDomainEvent(tx, tenantId, {
        type: "inventory.changed",
        roomIds,
        dateFrom: dateFrom as never,
        dateTo: dateTo as never,
      });
    }
  }

  return { resourceId: reservationId, response: { reservationId, status: "cancelled" } };
}
