import "server-only";
import type { TransactionSql } from "postgres";
import type { DateOnly } from "@/lib/dates";
import { lockRooms } from "@/lib/inventory";
import { calculateReservationPrice } from "@/lib/pricing/engine";
import { buildStaySnapshot } from "@/lib/pricing/reservation-pricing";
import { computeReservationTotals } from "@/lib/pricing/totals";
import { resolveCancellationSnapshot } from "@/lib/commercial/policy-snapshot";
import { recomputePaymentAggregates } from "@/lib/payments/ledger";
import { markAriDirty } from "@/lib/channel/outbox";
import { publishDomainEvent } from "@/lib/realtime/publish";
import { writeSystemAudit } from "@/lib/audit";
import { parseVatRate, DEFAULT_VAT_RATE } from "@/lib/vat";
import { BiosBotError, mapPricingErrorCode } from "../errors";

// ============================================================
// guesthub.create_reservation (Phase 5 §13).
//
// A NEW, narrow write — NOT createReservationAction (session-bound, far
// broader payload) and NOT createPublicBooking (requires a stored card as a
// guarantee, wrong for this boundary). Reuses the SAME authoritative
// primitives the dashboard action uses: lockRooms, calculateReservationPrice
// (the identical call get_quote makes — so the PRICE_CHANGED fingerprint
// check compares apples to apples), buildStaySnapshot, computeReservationTotals,
// recomputePaymentAggregates, markAriDirty, publishDomainEvent.
//
// INITIAL STATUS (owner decision, documented per Phase 5 §13/§20): 'draft'.
// Investigated before deciding: since D126 (migration 073),
// INVENTORY_BLOCKING_STATUSES includes every status except 'cancelled' — a
// 'draft' reservation blocks inventory IDENTICALLY to 'confirmed' (same
// lockRooms/exclusion-constraint/markAriDirty coverage). The only behavioral
// difference between the two is that createReservationAction fires
// enqueueReservationConfirmed ONLY for status='confirmed'. Since this write
// is gated behind BIOS Bot's own customer_confirmation Pending Action, the
// guest has already been told the outcome IN THE CONVERSATION by the time
// this runs — auto-sending GuestHub's own confirmation email/WhatsApp on
// top of that risks exactly the duplicate-communication Phase 5 warns
// against. 'draft' avoids it for free, without inventing a new status, and
// still fully reserves the room. A human who later reviews the booking in
// the dashboard can promote it to 'confirmed' through the EXISTING flow,
// which sends the normal confirmation through the normal channel.
//
// AUDIT: writeSystemAudit (no human actor — this is a service write), with
// session='bios-bot' as the source marker Phase 5 §29 asks for, and the
// idempotency key carried in the audit payload for cross-referencing with
// BIOS Bot's own Phase 4 action log.
//
// booking_origin is reused as 'back_office' (no new value invented — the
// column is CHECK-constrained to back_office/direct_website/ota, and a
// service-initiated write is closer to a staff-initiated one than to either
// the customer-facing website widget or an OTA import).
// ============================================================

export type BiosBotCreateReservationRoomRequest = {
  roomId: string;
  ratePlanId?: string | null;
  adults: number;
  children: number;
  infants: number;
};

export type BiosBotCreateReservationRequest = {
  checkIn: DateOnly;
  checkOut: DateOnly;
  rooms: BiosBotCreateReservationRoomRequest[];
  /** from a prior guesthub.get_quote call — required; proves the price shown was approved */
  quoteFingerprint: string;
  guest: {
    firstName: string;
    lastName: string;
    phone?: string | null;
    email?: string | null;
  };
  notes?: string | null;
};

export type BiosBotCreatedReservation = {
  reservationId: string;
  reservationNumber: string;
  status: "draft";
  totalPrice: number;
  currency: string;
};

export async function createBiosBotReservation(
  tx: TransactionSql,
  tenantId: string,
  idempotencyKey: string,
  req: BiosBotCreateReservationRequest,
): Promise<{ resourceId: string; response: BiosBotCreatedReservation }> {
  if (req.rooms.length === 0) throw new BiosBotError("VALIDATION_ERROR", "at least one room is required");

  await lockRooms(tx, tenantId, req.rooms.map((r) => r.roomId));

  const quote = await calculateReservationPrice(tx, {
    tenantId,
    checkIn: req.checkIn,
    checkOut: req.checkOut,
    rooms: req.rooms.map((r) => ({
      roomId: r.roomId,
      ratePlanId: r.ratePlanId ?? null,
      adults: r.adults,
      children: r.children,
      infants: r.infants,
      manualRatePerNight: null,
    })),
    source: "internal",
  });

  if (!quote.valid) {
    const firstError = quote.errors[0] ?? quote.rooms.flatMap((r) => r.errors)[0];
    if (!firstError) throw new BiosBotError("INTERNAL_ERROR", "quote invalid with no reported error");
    throw new BiosBotError(mapPricingErrorCode(firstError.code), firstError.message);
  }
  if (quote.quoteFingerprint !== req.quoteFingerprint) {
    throw new BiosBotError("PRICE_CHANGED", "the price has changed since the quote was given — request a fresh quote and confirm again");
  }

  const [tenantRow] = await tx<{ currency: string; vat_rate: string | null }[]>`
    SELECT currency, settings->>'vat_rate' AS vat_rate FROM guesthub.tenants WHERE id = ${tenantId}`;
  const currency = tenantRow?.currency ?? quote.currency;
  const vatRate = parseVatRate(tenantRow?.vat_rate) ?? DEFAULT_VAT_RATE;

  const fullName = `${req.guest.firstName} ${req.guest.lastName}`.trim();
  const [guest] = await tx<{ id: string }[]>`
    INSERT INTO guesthub.guests (tenant_id, first_name, last_name, full_name, phone, email)
    VALUES (${tenantId}, ${req.guest.firstName}, ${req.guest.lastName}, ${fullName},
            ${req.guest.phone ?? null}, ${req.guest.email ?? null})
    RETURNING id`;

  // per-tenant running number, tenant row locked to serialize allocation —
  // the SAME approach createReservationAction uses (allocateReservationNumber)
  await tx`SELECT id FROM guesthub.tenants WHERE id = ${tenantId} FOR UPDATE`;
  const [numberRow] = await tx<{ next: string }[]>`
    SELECT (COALESCE(MAX(NULLIF(regexp_replace(reservation_number, '\\D', '', 'g'), '')::bigint), 1000) + 1)::text AS next
    FROM guesthub.reservations WHERE tenant_id = ${tenantId}`;
  const reservationNumber = numberRow.next;

  const [workflowRow] = await tx<{ id: string }[]>`
    SELECT id FROM guesthub.lookup_items
    WHERE tenant_id = ${tenantId} AND category = 'workflow_statuses'
      AND is_active AND (metadata->>'is_default') = 'true'`;
  const workflowStatusId = workflowRow?.id ?? null;

  const cancellationSnapshot = await resolveCancellationSnapshot(tx, tenantId, quote.rooms[0]?.ratePlanId ?? null);

  const totals = computeReservationTotals({
    stays: quote.rooms.map((r) => ({ priceTotal: r.roomSubtotal, nights: quote.numberOfNights })),
    discountMode: "none",
    discountValue: 0,
    extraCharges: 0,
    taxExempt: false,
    vatRate,
    currency,
  });

  const [res] = await tx<{ id: string }[]>`
    INSERT INTO guesthub.reservations
      (tenant_id, reservation_number, primary_guest_id, status,
       check_in, check_out, adults, children, infants,
       discount_amount, total_price, paid_amount, balance, currency,
       notes, cancellation_policy_snapshot, booking_origin, workflow_status_id)
    VALUES (${tenantId}, ${reservationNumber}, ${guest.id}, 'draft',
            ${req.checkIn}, ${req.checkOut},
            ${req.rooms.reduce((n, r) => n + r.adults, 0)},
            ${req.rooms.reduce((n, r) => n + r.children, 0)},
            ${req.rooms.reduce((n, r) => n + r.infants, 0)},
            ${totals.discountAmount}, ${totals.grandTotal}, 0, ${totals.grandTotal}, ${currency},
            ${req.notes || null},
            ${cancellationSnapshot === null ? null : tx.json(cancellationSnapshot as never)},
            'back_office', ${workflowStatusId})
    RETURNING id`;

  for (const rq of quote.rooms) {
    const nights = quote.numberOfNights;
    const ratePerNight = nights > 0 ? Math.round((rq.roomSubtotal / nights) * 100) / 100 : rq.roomSubtotal;
    const snapshot = buildStaySnapshot(quote, rq, {
      source: "internal",
      manualRatePerNight: null,
      taxExempt: false,
      actorUserId: null,
    });
    await tx`
      INSERT INTO guesthub.reservation_rooms
        (tenant_id, reservation_id, room_id, check_in, check_out,
         adults, children, infants, rate_per_night, price_total,
         is_manual_rate, price_mode, rate_plan_id, pricing_snapshot)
      VALUES (${tenantId}, ${res.id}, ${rq.roomId}, ${req.checkIn}, ${req.checkOut},
              ${rq.adults}, ${rq.children}, ${rq.infants}, ${ratePerNight}, ${rq.roomSubtotal},
              false, 'auto', ${rq.ratePlanId}, ${tx.json(snapshot as never)})`;
  }

  await recomputePaymentAggregates(tx, tenantId, res.id);

  await writeSystemAudit(tenantId, {
    entityType: "reservation",
    entityId: res.id,
    action: "create",
    after: { number: reservationNumber, status: "draft", rooms: quote.rooms.length, total: totals.grandTotal },
    session: `bios-bot idempotency-key=${idempotencyKey}`,
  }, tx);

  // 'draft' is a blocking status (D126) — the room is genuinely reserved
  await markAriDirty(tx, {
    tenantId,
    roomIds: req.rooms.map((r) => r.roomId),
    dateFrom: req.checkIn,
    dateTo: req.checkOut,
  });
  await publishDomainEvent(tx, tenantId, {
    type: "reservation.created",
    reservationId: res.id,
    roomIds: req.rooms.map((r) => r.roomId),
    dateFrom: req.checkIn,
    dateTo: req.checkOut,
    lifecycle: "draft",
  });
  await publishDomainEvent(tx, tenantId, {
    type: "inventory.changed",
    roomIds: req.rooms.map((r) => r.roomId),
    dateFrom: req.checkIn,
    dateTo: req.checkOut,
  });

  return {
    resourceId: res.id,
    response: { reservationId: res.id, reservationNumber, status: "draft", totalPrice: totals.grandTotal, currency },
  };
}
