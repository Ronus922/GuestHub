import "server-only";
import type { Sql, TransactionSql } from "postgres";
import type { DateOnly } from "@/lib/dates";
import { calculateReservationPrice } from "@/lib/pricing/engine";
import { BiosBotError, mapPricingErrorCode } from "../errors";

// ============================================================
// guesthub.get_quote (Phase 5). A thin, typed wrapper around
// calculateReservationPrice — THE single pricing engine (src/lib/pricing/
// engine.ts) — never a re-implementation. The returned quoteFingerprint is
// the stale-price guard: guesthub.create_reservation must be given it back,
// and PRICE_CHANGED fires if the authoritative price moved underneath it.
// ============================================================

export type BiosBotQuoteRoomRequest = {
  roomId: string;
  ratePlanId?: string | null;
  adults: number;
  children: number;
  infants: number;
};

export type BiosBotQuoteRequest = {
  checkIn: DateOnly;
  checkOut: DateOnly;
  rooms: BiosBotQuoteRoomRequest[];
};

export type BiosBotQuoteRoomResult = {
  roomId: string;
  roomNumber: string;
  ratePlanId: string | null;
  ratePlanName: string;
  adults: number;
  children: number;
  infants: number;
  subtotal: number;
};

export type BiosBotQuote = {
  quoteFingerprint: string;
  checkIn: DateOnly;
  checkOut: DateOnly;
  nights: number;
  currency: string;
  rooms: BiosBotQuoteRoomResult[];
  subtotalNet: number;
  vatRate: number;
  vatAmount: number;
  totalGross: number;
};

export async function getBiosBotQuote(
  db: Sql | TransactionSql,
  tenantId: string,
  req: BiosBotQuoteRequest,
): Promise<BiosBotQuote> {
  if (req.rooms.length === 0) {
    throw new BiosBotError("VALIDATION_ERROR", "at least one room is required");
  }

  const result = await calculateReservationPrice(db, {
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

  if (!result.valid) {
    const firstError = result.errors[0] ?? result.rooms.flatMap((r) => r.errors)[0];
    if (!firstError) throw new BiosBotError("INTERNAL_ERROR", "quote invalid with no reported error");
    throw new BiosBotError(mapPricingErrorCode(firstError.code), firstError.message);
  }

  return {
    quoteFingerprint: result.quoteFingerprint,
    checkIn: result.checkIn,
    checkOut: result.checkOut,
    nights: result.numberOfNights,
    currency: result.currency,
    rooms: result.rooms.map((r) => ({
      roomId: r.roomId,
      roomNumber: r.roomNumber,
      ratePlanId: r.ratePlanId,
      ratePlanName: r.ratePlanName,
      adults: r.adults,
      children: r.children,
      infants: r.infants,
      subtotal: r.roomSubtotal,
    })),
    subtotalNet: result.subtotalNet,
    vatRate: result.vatRate,
    vatAmount: result.vatAmount,
    totalGross: result.totalGross,
  };
}
