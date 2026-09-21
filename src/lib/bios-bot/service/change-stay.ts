import "server-only";
import type { TransactionSql } from "postgres";
import type { DateOnly } from "@/lib/dates";
import { lockRooms } from "@/lib/inventory";
import { calculateReservationPrice } from "@/lib/pricing/engine";
import { buildStaySnapshot } from "@/lib/pricing/reservation-pricing";
import { computeReservationTotals } from "@/lib/pricing/totals";
import { recomputePaymentAggregates } from "@/lib/payments/ledger";
import { markAriDirty } from "@/lib/channel/outbox";
import { publishDomainEvent } from "@/lib/realtime/publish";
import { writeSystemAudit } from "@/lib/audit";
import { parseVatRate, DEFAULT_VAT_RATE } from "@/lib/vat";
import { BiosBotError, mapPricingErrorCode } from "../errors";

// ============================================================
// guesthub.change_stay (Phase 5 §14A) — dates and/or room for ONE existing
// stay (guesthub.reservation_rooms row), never the whole reservation.
//
// Modeled on rescheduleReservationRoomAction (src/app/(dashboard)/
// reservations/actions.ts), narrowed to exactly this: lock (old room AND
// new room, if different), re-check availability with the stay's OWN row
// excluded (excludeReservationRoomIds — the same parameter
// calculateReservationPrice already exposes for edits), reprice via the
// SAME single engine call get_quote/create_reservation use, update the
// stay and the reservation's aggregate totals, preserve the same side
// effects (audit, ARI-dirty for both the vacated and the claimed room,
// domain events).
//
// A channel-managed (OTA) reservation cannot be modified locally — same
// rule cancelReservationAction enforces for cancellation, applied here too:
// the channel owns those dates, not this connector.
// ============================================================

export type BiosBotChangeStayRequest = {
  roomId?: string;
  checkIn: DateOnly;
  checkOut: DateOnly;
};

export type BiosBotChangedStay = {
  reservationId: string;
  stayId: string;
  roomId: string;
  checkIn: DateOnly;
  checkOut: DateOnly;
  subtotal: number;
  totalPrice: number;
};

export async function changeBiosBotReservationStay(
  tx: TransactionSql,
  tenantId: string,
  reservationId: string,
  stayId: string,
  req: BiosBotChangeStayRequest,
): Promise<{ resourceId: string; response: BiosBotChangedStay }> {
  const [current] = await tx<{
    room_id: string | null;
    check_in: string;
    check_out: string;
    adults: number;
    children: number;
    infants: number;
    rate_plan_id: string | null;
    res_status: string;
    channel_connection_id: string | null;
  }[]>`
    SELECT rr.room_id, rr.check_in::text AS check_in, rr.check_out::text AS check_out,
           rr.adults, rr.children, rr.infants, rr.rate_plan_id,
           res.status AS res_status, res.channel_connection_id
    FROM guesthub.reservation_rooms rr
    JOIN guesthub.reservations res ON res.id = rr.reservation_id
    WHERE rr.tenant_id = ${tenantId} AND rr.reservation_id = ${reservationId} AND rr.id = ${stayId}
    FOR UPDATE OF rr, res`;
  if (!current || !current.room_id) throw new BiosBotError("RESERVATION_NOT_FOUND", "reservation or stay not found");
  if (current.res_status === "cancelled") {
    throw new BiosBotError("RESERVATION_NOT_MODIFIABLE", "a cancelled reservation cannot be modified");
  }
  if (current.channel_connection_id) {
    throw new BiosBotError("RESERVATION_NOT_MODIFIABLE", "a channel-managed reservation must be modified at the channel, not locally");
  }

  const targetRoomId = req.roomId ?? current.room_id;
  await lockRooms(tx, tenantId, [...new Set([current.room_id, targetRoomId])]);

  const quote = await calculateReservationPrice(tx, {
    tenantId,
    checkIn: req.checkIn,
    checkOut: req.checkOut,
    rooms: [{
      roomId: targetRoomId,
      ratePlanId: current.rate_plan_id,
      adults: current.adults,
      children: current.children,
      infants: current.infants,
      manualRatePerNight: null,
    }],
    source: "internal",
    excludeReservationRoomIds: [stayId],
  });
  if (!quote.valid) {
    const firstError = quote.errors[0] ?? quote.rooms.flatMap((r) => r.errors)[0];
    if (!firstError) throw new BiosBotError("INTERNAL_ERROR", "quote invalid with no reported error");
    throw new BiosBotError(mapPricingErrorCode(firstError.code), firstError.message);
  }
  const rq = quote.rooms[0];
  const nights = quote.numberOfNights;
  const ratePerNight = nights > 0 ? Math.round((rq.roomSubtotal / nights) * 100) / 100 : rq.roomSubtotal;
  const snapshot = buildStaySnapshot(quote, rq, { source: "internal", manualRatePerNight: null, taxExempt: false, actorUserId: null });

  await tx`
    UPDATE guesthub.reservation_rooms
    SET room_id = ${targetRoomId}, check_in = ${req.checkIn}, check_out = ${req.checkOut},
        rate_per_night = ${ratePerNight}, price_total = ${rq.roomSubtotal},
        pricing_snapshot = ${tx.json(snapshot as never)}
    WHERE id = ${stayId} AND tenant_id = ${tenantId}`;

  // recompute the reservation's aggregate dates + total from ALL its stays
  const allStays = await tx<{ check_in: string; check_out: string; price_total: number }[]>`
    SELECT check_in::text AS check_in, check_out::text AS check_out, price_total::float8 AS price_total
    FROM guesthub.reservation_rooms WHERE reservation_id = ${reservationId} AND tenant_id = ${tenantId}`;
  const aggCheckIn = allStays.reduce((m, s) => (s.check_in < m ? s.check_in : m), allStays[0].check_in);
  const aggCheckOut = allStays.reduce((m, s) => (s.check_out > m ? s.check_out : m), allStays[0].check_out);

  const [tenantRow] = await tx<{ currency: string; vat_rate: string | null }[]>`
    SELECT currency, settings->>'vat_rate' AS vat_rate FROM guesthub.tenants WHERE id = ${tenantId}`;
  const totals = computeReservationTotals({
    stays: allStays.map((s) => ({ priceTotal: s.price_total, nights: 1 })),
    discountMode: "none",
    discountValue: 0,
    extraCharges: 0,
    taxExempt: false,
    vatRate: parseVatRate(tenantRow?.vat_rate) ?? DEFAULT_VAT_RATE,
    currency: tenantRow?.currency ?? quote.currency,
  });

  await tx`
    UPDATE guesthub.reservations
    SET check_in = ${aggCheckIn}, check_out = ${aggCheckOut},
        discount_amount = ${totals.discountAmount}, total_price = ${totals.grandTotal}
    WHERE id = ${reservationId} AND tenant_id = ${tenantId}`;
  await recomputePaymentAggregates(tx, tenantId, reservationId);

  await writeSystemAudit(tenantId, {
    entityType: "reservation",
    entityId: reservationId,
    action: "update",
    before: { roomId: current.room_id, checkIn: current.check_in, checkOut: current.check_out },
    after: { roomId: targetRoomId, checkIn: req.checkIn, checkOut: req.checkOut, total: totals.grandTotal },
    session: "bios-bot",
  }, tx);

  // the vacated (old room, old dates) window and the claimed (new room, new
  // dates) window are both dirty — two calls even when the room is
  // unchanged, since the date range itself still moved
  await markAriDirty(tx, {
    tenantId, roomIds: [current.room_id],
    dateFrom: current.check_in as DateOnly, dateTo: current.check_out as DateOnly,
  });
  await markAriDirty(tx, {
    tenantId, roomIds: [targetRoomId],
    dateFrom: req.checkIn, dateTo: req.checkOut,
  });
  await publishDomainEvent(tx, tenantId, {
    type: "reservation.modified",
    reservationId,
    roomIds: [current.room_id, targetRoomId],
    dateFrom: aggCheckIn as DateOnly,
    dateTo: aggCheckOut as DateOnly,
  });
  await publishDomainEvent(tx, tenantId, {
    type: "inventory.changed",
    roomIds: [current.room_id, targetRoomId],
    dateFrom: aggCheckIn as DateOnly,
    dateTo: aggCheckOut as DateOnly,
  });

  return {
    resourceId: reservationId,
    response: {
      reservationId, stayId, roomId: targetRoomId,
      checkIn: req.checkIn, checkOut: req.checkOut,
      subtotal: rq.roomSubtotal, totalPrice: totals.grandTotal,
    },
  };
}
