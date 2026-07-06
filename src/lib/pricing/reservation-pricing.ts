import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { nightsBetween, type DateOnly } from "@/lib/dates";
import { resolveStayPrice } from "@/lib/rates/rules";
import { calculateReservationPrice } from "./engine";
import type {
  PricingError, PricingErrorCode, PricingQuoteResult, QuoteSource, RoomQuote,
} from "./types";

// ============================================================
// Reservation pricing seam (D51) — the ONE bridge between reservation
// server actions (create / edit / move / preview / live quote) and THE
// central pricing engine. It keeps the reservation-domain semantics the
// legacy path guaranteed:
//   - committed-price snapshot (§6): an unchanged confirmed stay keeps its
//     stored price and is never re-priced from current rates;
//   - authorized manual override (§13): an explicit final nightly price wins
//     over everything (permission is enforced by the ACTION, not here);
//   - enforcement flags: drafts skip availability/restrictions exactly like
//     the legacy validateAndPriceStays;
//   - per-stay date ranges: the engine is called once per stay.
//     ponytail: per-stay engine calls (≤10 stays/reservation, ~6 queries each
//     inside one tx); batch per date-range group if this ever measures hot.
// No @/lib/db import on purpose — callers pass their Sql/tx, so the equality
// check suite compiles and drives this module against the isolated test DB.
// ============================================================

export class StayPricingError extends Error {
  code: PricingErrorCode;
  roomId: string;
  constructor(message: string, code: PricingErrorCode, roomId: string) {
    super(message);
    this.code = code;
    this.roomId = roomId;
  }
}

export type ReservationStayInput = {
  rrId?: string;
  roomId: string;
  ratePlanId?: string | null;
  checkIn: DateOnly;
  checkOut: DateOnly;
  adults: number;
  children: number;
  infants: number;
  ratePerNight?: number | null;
  isManualRate?: boolean;
};

// The immutable commercial snapshot stored per stay (reservation_rooms
// .pricing_snapshot, migration 017): everything needed to explain the price
// later, straight from the engine result — never recomputed at read time.
export type StayPricingSnapshot = {
  engineVersion: string;
  quoteFingerprint: string;
  source: QuoteSource;
  calculatedAt: string; // ISO timestamp
  currency: string;
  vatRate: number;
  priceIncludesVat: true;
  checkIn: DateOnly;
  checkOut: DateOnly;
  nights: number;
  roomId: string;
  ratePlanId: string | null;
  ratePlanName: string;
  ratePlanCode: string;
  parentPlanId: string | null;
  occupancy: {
    adults: number; children: number; infants: number;
    includedOccupancy: number | null;
    extraAdults: number; extraChildren: number; extraInfants: number;
  };
  extraGuest: {
    frequency: "per_night" | "per_stay";
    perNight: number;
    perStay: number;
    total: number;
    source: RoomQuote["extraGuestSource"];
  };
  nightly: Array<{
    date: DateOnly;
    basePrice: number | null;
    resolvedPlanPrice: number | null;
    adjustmentValue: number | null;
    adjustmentSource: string | null;
    overridePrice: number | null;
    priceSource: string | null;
    extraGuestAmount: number;
    nightTotal: number | null;
  }>;
  roomSubtotal: number;
  priceSourcesUsed: string[];
  manualOverride: { ratePerNight: number; appliedBy: string | null } | null;
};

export type PricedReservationStay<T extends ReservationStayInput> = T & {
  nights: number;
  ratePerNight: number;
  priceTotal: number;
  isManualRate: boolean;
  ratePlanId: string | null;
  // null = the stay kept its committed snapshot — the caller preserves the
  // STORED pricing_snapshot untouched (immutability rule §8).
  pricingSnapshot: StayPricingSnapshot | null;
};

// Engine error → enforcement group. ROOM_CLOSED carries a date when it came
// from a commercial stop-sell (restriction) and no date when it came from a
// physical closure (availability) — the same split the legacy path enforced.
const AVAILABILITY_CODES: ReadonlySet<PricingErrorCode> = new Set([
  "ROOM_NOT_FOUND", "ROOM_INACTIVE", "ROOM_OUT_OF_ORDER", "ROOM_UNAVAILABLE",
]);
const RESTRICTION_CODES: ReadonlySet<PricingErrorCode> = new Set([
  "MIN_STAY_NOT_MET", "MAX_STAY_EXCEEDED", "CLOSED_ON_ARRIVAL", "CLOSED_ON_DEPARTURE",
  "ARRIVAL_DAY_NOT_ALLOWED", "ADVANCE_BOOKING_RULE_FAILED", "RATE_PLAN_OUTSIDE_VALIDITY",
]);
const OCCUPANCY_CODES: ReadonlySet<PricingErrorCode> = new Set([
  "OCCUPANCY_BELOW_MINIMUM", "OCCUPANCY_EXCEEDED",
  "ADULT_LIMIT_EXCEEDED", "CHILD_LIMIT_EXCEEDED", "INFANT_LIMIT_EXCEEDED",
]);
const PLAN_CODES: ReadonlySet<PricingErrorCode> = new Set([
  "RATE_PLAN_NOT_FOUND", "RATE_PLAN_INACTIVE", "RATE_PLAN_PARENT_INACTIVE",
  "RATE_PLAN_NOT_ASSIGNED", "RATE_PLAN_CYCLE",
]);
const PRICING_CODES: ReadonlySet<PricingErrorCode> = new Set([
  "NO_PRICE_FOR_DATE", "EXTRA_GUEST_PRICING_INCOMPLETE",
]);

// The first engine error the caller's enforcement flags actually block on.
export function firstEnforcedError(
  errors: PricingError[],
  flags: { availability: boolean; restrictions: boolean; pricing: boolean },
): PricingError | null {
  for (const e of errors) {
    if (e.code === "ROOM_DUPLICATED") continue; // cross-stay overlap is the seam's own check
    if (AVAILABILITY_CODES.has(e.code)) { if (flags.availability) return e; continue; }
    if (e.code === "ROOM_CLOSED") {
      if (e.date != null ? flags.restrictions : flags.availability) return e;
      continue;
    }
    if (RESTRICTION_CODES.has(e.code)) { if (flags.restrictions) return e; continue; }
    if (OCCUPANCY_CODES.has(e.code)) return e; // always enforced (capacity rule)
    if (PLAN_CODES.has(e.code)) return e; // a requested plan must be usable
    if (PRICING_CODES.has(e.code)) { if (flags.pricing) return e; continue; }
    return e; // request-level codes (dates, window, currency, tenant) always block
  }
  return null;
}

export function buildStaySnapshot(
  quote: PricingQuoteResult,
  rq: RoomQuote,
  meta: { source: QuoteSource; manualRatePerNight: number | null; actorUserId: string | null },
): StayPricingSnapshot {
  return {
    engineVersion: quote.engineVersion,
    quoteFingerprint: quote.quoteFingerprint,
    source: meta.source,
    calculatedAt: new Date().toISOString(),
    currency: quote.currency,
    vatRate: quote.vatRate,
    priceIncludesVat: true,
    checkIn: quote.checkIn,
    checkOut: quote.checkOut,
    nights: quote.numberOfNights,
    roomId: rq.roomId,
    ratePlanId: rq.ratePlanId,
    ratePlanName: rq.ratePlanName,
    ratePlanCode: rq.ratePlanCode,
    parentPlanId: rq.nights[0]?.parentPlanId ?? null,
    occupancy: {
      adults: rq.adults, children: rq.children, infants: rq.infants,
      includedOccupancy: rq.includedOccupancy,
      extraAdults: rq.extraAdults, extraChildren: rq.extraChildren, extraInfants: rq.extraInfants,
    },
    extraGuest: {
      frequency: rq.extraGuestFrequency,
      perNight: rq.extraGuestPerNight,
      perStay: rq.extraGuestPerStay,
      total: rq.extraGuestTotal,
      source: rq.extraGuestSource,
    },
    nightly: rq.nights.map((n) => ({
      date: n.date,
      basePrice: n.basePrice,
      resolvedPlanPrice: n.resolvedPlanPrice,
      adjustmentValue: n.adjustmentValue,
      adjustmentSource: n.adjustmentSource,
      overridePrice: n.overridePrice,
      priceSource: n.priceSource,
      extraGuestAmount: n.extraGuestAmount,
      nightTotal: n.nightTotal,
    })),
    roomSubtotal: rq.roomSubtotal,
    priceSourcesUsed: rq.priceSourcesUsed,
    manualOverride:
      meta.manualRatePerNight != null
        ? { ratePerNight: meta.manualRatePerNight, appliedBy: meta.actorUserId }
        : null,
  };
}

export type PriceStaysOptions = {
  source: QuoteSource;
  excludeRrIds?: string[];
  enforceAvailability: boolean;
  enforceRestrictions: boolean;
  skipChecksForRr?: Set<string>;
  // §6 committed-price snapshot: rrId → stored rate. A non-manual stay listed
  // here keeps this committed price instead of being re-priced from CURRENT
  // rates; its stored pricing_snapshot is preserved (pricingSnapshot: null).
  snapshotByRr?: Map<string, { ratePerNight: number; priceTotal?: number }>;
  actorUserId?: string | null;
};

// Price a set of reservation stays through THE central engine. Throws
// StayPricingError (Hebrew message from the engine's translation layer) on the
// first enforced violation — the exact failure contract of the legacy path.
export async function priceReservationStays<T extends ReservationStayInput>(
  db: Sql | TransactionSql,
  tenantId: string,
  stays: T[],
  opts: PriceStaysOptions,
): Promise<PricedReservationStay<T>[]> {
  const out: PricedReservationStay<T>[] = [];

  for (const stay of stays) {
    const skip = stay.rrId != null && (opts.skipChecksForRr?.has(stay.rrId) ?? false);
    const isManualRate = stay.isManualRate ?? false;
    const snapshot = !isManualRate && stay.rrId != null ? opts.snapshotByRr?.get(stay.rrId) : undefined;
    const nights = nightsBetween(stay.checkIn, stay.checkOut);

    // A stay that skips validation AND keeps its committed/manual price needs
    // nothing from the engine — exactly the legacy fast path.
    if (skip && (snapshot || isManualRate)) {
      const { ratePerNight, priceTotal } = resolveStayPrice({
        nights, isManualRate,
        manualRatePerNight: stay.ratePerNight,
        snapshot: snapshot ?? null,
        autoTotal: 0, // unreachable: manual or snapshot always wins here
      });
      out.push({
        ...stay, nights, ratePerNight, priceTotal, isManualRate,
        ratePlanId: stay.ratePlanId ?? null,
        pricingSnapshot: null, // preserve the stored snapshot untouched
      });
      continue;
    }

    const manualRatePerNight = isManualRate ? (stay.ratePerNight ?? 0) : null;
    const quote = await calculateReservationPrice(db, {
      tenantId,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      rooms: [{
        roomId: stay.roomId,
        ratePlanId: stay.ratePlanId ?? null,
        adults: stay.adults, children: stay.children, infants: stay.infants,
        manualRatePerNight,
      }],
      source: opts.source,
      excludeReservationRoomIds: opts.excludeRrIds,
    });

    // request-level rejection (invalid range, quote window, tenant/currency)
    if (quote.rooms.length === 0) {
      const e = quote.errors[0];
      throw new StayPricingError(e?.message ?? "בקשת תמחור לא תקינה", e?.code ?? "INVALID_DATE_RANGE", stay.roomId);
    }
    const rq = quote.rooms[0];

    const enforced = skip
      ? null
      : firstEnforcedError(rq.errors, {
          availability: opts.enforceAvailability,
          restrictions: opts.enforceRestrictions,
          // fresh pricing is only authoritative when neither a manual override
          // nor a committed snapshot supplies the price
          pricing: manualRatePerNight == null && !snapshot,
        });
    if (enforced) throw new StayPricingError(enforced.message, enforced.code, stay.roomId);

    // precedence: manual override → committed snapshot → engine auto price
    const { ratePerNight, priceTotal } = resolveStayPrice({
      nights, isManualRate,
      manualRatePerNight: stay.ratePerNight,
      snapshot: snapshot ?? null,
      autoTotal: rq.roomSubtotal,
    });

    out.push({
      ...stay, nights, ratePerNight, priceTotal, isManualRate,
      ratePlanId: rq.ratePlanId,
      pricingSnapshot: snapshot
        ? null // committed price kept → stored snapshot stays authoritative
        : buildStaySnapshot(quote, rq, {
            source: opts.source,
            manualRatePerNight,
            actorUserId: opts.actorUserId ?? null,
          }),
    });
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// THE canonical reservation-total formula (D51). Replaces the three divergent
// server formulas (create ignored extra_charges; edit floored twice; the
// reschedule SQL floored once): discount applies to the whole commercial bill,
// floored once at zero.
export function reservationTotal(
  roomsTotal: number,
  discountAmount: number,
  extraCharges: number,
): number {
  return Math.max(0, round2(roomsTotal + extraCharges - discountAmount));
}
