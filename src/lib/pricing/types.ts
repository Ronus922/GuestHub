// ============================================================
// Central pricing engine — typed contracts (Rate Plans phase).
// PURE types: no imports beyond the date alias, no DB, no React. The engine
// (engine.ts) and every consumer — simulator, manual reservations, the future
// website booking engine and channel processing — share exactly these shapes.
// ============================================================

import type { DateOnly } from "@/lib/dates";

export const PRICING_ENGINE_VERSION = "1.0.0";

// The quote window (spec §28): a quote may cover at most this many nights.
//
// This is a COMPUTATION BOUND, not a policy about how long a guest may stay.
// It was a hardcoded 90, which quietly made a normal product case impossible:
// a monthly or yearly let is an ordinary booking here, and a 91-night stay was
// refused outright with QUOTE_WINDOW_EXCEEDED and no way for an operator to
// raise it. The default now covers a full year with margin, and a tenant that
// needs a different bound sets `settings.pricing.max_quote_nights`.
// Callers stay within the rates horizon (5y) separately.
export const DEFAULT_MAX_QUOTE_NIGHTS = 400;

/** A tenant setting may not exceed this — it still has to be a bound. */
export const MAX_QUOTE_NIGHTS_CEILING = 1830; // the 5-year rates horizon

/**
 * The effective window for one tenant. Anything absent, malformed, non-integer
 * or out of range falls back to the default: a bad setting must never widen the
 * bound, and must never narrow it to something that refuses ordinary stays.
 */
export function resolveMaxQuoteNights(pricingSettings: unknown): number {
  const raw =
    pricingSettings && typeof pricingSettings === "object"
      ? (pricingSettings as Record<string, unknown>).max_quote_nights
      : undefined;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_QUOTE_NIGHTS_CEILING) return DEFAULT_MAX_QUOTE_NIGHTS;
  return n;
}

export type QuoteSource =
  | "pricing_simulator"
  | "manual_reservation"
  | "website"
  | "channel_manager"
  | "internal";

export type PricingQuoteRequest = {
  // tenantId comes from the trusted server context (actor.tenantId) — the
  // engine never receives a browser-supplied tenant.
  tenantId: string;
  checkIn: DateOnly;
  checkOut: DateOnly;
  rooms: Array<{
    roomId: string;
    // null = the base-ARI layer (the unit's base plan / room-type base price)
    // with no tenant-level Rate Plan applied — the pre-Rate-Plans pricing every
    // reservation used, kept as an explicit engine mode so tenants without
    // tenant-level plans still price through THE one engine.
    ratePlanId: string | null;
    adults: number;
    children: number;
    infants: number;
    // authorized manual override (§13): the FINAL nightly room price agreed
    // with the guest. Bypasses price resolution AND extra-guest charging
    // (legacy manual-rate semantics: priceTotal = rate × nights); every
    // physical/restriction/occupancy rule still runs. The CALLER enforces the
    // permission — the engine only prices what it is told is authorized.
    manualRatePerNight?: number | null;
  }>;
  source: QuoteSource;
  requestedCurrency?: string;
  // reservation edit/move: the stay's own reservation_rooms ids, excluded from
  // the availability conflict check exactly like the legacy path.
  excludeReservationRoomIds?: string[];
  // Internal: the auto-selection pre-pass sets this on its recursive calls so
  // a candidate evaluation prices exactly what it was told. Callers keep the
  // default (selection ON for entries with no explicit ratePlanId).
  disablePlanAutoSelect?: boolean;
};

// ---- stable machine-readable error codes (§15) ----
export type PricingErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_INACTIVE"
  | "ROOM_OUT_OF_ORDER"
  | "ROOM_UNAVAILABLE"
  | "ROOM_CLOSED"
  | "ROOM_DUPLICATED"
  | "RATE_PLAN_NOT_FOUND"
  | "RATE_PLAN_INACTIVE"
  | "RATE_PLAN_PARENT_INACTIVE"
  | "RATE_PLAN_NOT_ASSIGNED"
  | "RATE_PLAN_OUTSIDE_VALIDITY"
  | "ARRIVAL_DAY_NOT_ALLOWED"
  | "NO_PRICE_FOR_DATE"
  | "MIN_STAY_NOT_MET"
  | "MAX_STAY_EXCEEDED"
  | "CLOSED_ON_ARRIVAL"
  | "CLOSED_ON_DEPARTURE"
  | "ADVANCE_BOOKING_RULE_FAILED"
  | "OCCUPANCY_BELOW_MINIMUM"
  | "OCCUPANCY_EXCEEDED"
  | "ADULT_LIMIT_EXCEEDED"
  | "CHILD_LIMIT_EXCEEDED"
  | "INFANT_LIMIT_EXCEEDED"
  | "EXTRA_GUEST_PRICING_INCOMPLETE"
  | "CURRENCY_MISMATCH"
  | "INVALID_DATE_RANGE"
  | "QUOTE_WINDOW_EXCEEDED"
  | "RATE_PLAN_CYCLE"
  | "MIXED_TENANT_DATA";

export type PricingError = {
  code: PricingErrorCode;
  message: string; // Hebrew, filled from the translation layer at the boundary
  roomId?: string;
  ratePlanId?: string;
  date?: DateOnly;
};

export type PricingWarning = {
  code: string;
  message: string;
  roomId?: string;
  date?: DateOnly;
};

// ---- price provenance (§8.3): every resolved amount names its source ----
export type PriceSource =
  | "plan_unit_date_override" // exact (plan, unit, date) row on a non-independent plan
  | "independent_plan_price"  // exact (plan, unit, date) row — THE price of an independent plan
  | "derived_from_parent_plan"
  | "base_plan_rate"          // pricing_plan_rates row on the unit's base plan
  | "room_type_base_price"    // room_types.base_price terminal fallback
  | "manual_override";        // authorized manual rate (§13) — final nightly price

export type AdjustmentSource = "assignment_adjustment" | "plan_adjustment";

// ---- automatic plan selection by stay length ----
// When a room entry names NO ratePlanId, the engine tries every active
// tenant-level plan for the stay and keeps the eligible one with the lowest
// total for the guest (base pricing competes too). An explicitly supplied
// ratePlanId always wins — an operator's choice is never overridden. This is
// SELECTION ONLY: no new discount arithmetic, no new tables.
export type PlanAutoSelection = {
  mode: "stay_length_auto";
  /** the winning plan; null = base pricing stayed the best (or only) choice */
  selectedPlanId: string | null;
  candidatesConsidered: number;
  /** totals compared, VAT-inclusive; null when that side had no valid price */
  baseSubtotal: number | null;
  selectedSubtotal: number | null;
  /** the exact sentence operator surfaces show */
  reason: string;
};

export type NightQuote = {
  date: DateOnly;
  basePrice: number | null; // resolved base room-night price (base layer)
  basePriceSource: "base_plan_rate" | "room_type_base_price" | null;
  parentPlanId: string | null;
  parentResolvedPrice: number | null;
  adjustmentValue: number | null; // ±% (derived_percentage) or ±amount (derived_fixed)
  adjustmentSource: AdjustmentSource | null;
  overridePrice: number | null; // exact-date row price when one was used
  resolvedPlanPrice: number | null; // final nightly plan price, currency-rounded
  priceSource: PriceSource | null;
  extraGuestAmount: number; // per-night extra-guest charge (0 when charged per stay)
  nightTotal: number | null;
};

export type RoomQuote = {
  roomId: string;
  roomNumber: string;
  roomName: string | null;
  ratePlanId: string | null; // null = base-ARI layer (no tenant-level plan)
  ratePlanName: string;
  ratePlanCode: string;
  adults: number;
  children: number;
  infants: number;
  includedOccupancy: number | null;
  extraAdults: number;
  extraChildren: number;
  extraInfants: number;
  extraGuestSource: "room_override" | "property_default" | "unconfigured";
  extraGuestFrequency: "per_night" | "per_stay";
  extraGuestPerNight: number; // rounded per-night extra charge (0 when per_stay)
  extraGuestPerStay: number; // one-time extra charge (0 when per_night)
  extraGuestTotal: number;
  nights: NightQuote[];
  accommodationSubtotal: number; // resolved nightly prices only
  roomSubtotal: number; // gross (VAT-inclusive): night totals + per-stay extras
  available: boolean; // physical availability verdict for this room
  valid: boolean;
  errors: PricingError[];
  warnings: PricingWarning[];
  priceSourcesUsed: PriceSource[];
  restrictionsEvaluated: string[]; // rule groups that actually ran
  /** set when the engine picked the plan for this room (no explicit ratePlanId) */
  planSelection: PlanAutoSelection | null;
};

export type PricingQuoteResult = {
  engineVersion: string;
  quoteFingerprint: string;
  tenantId: string;
  currency: string;
  checkIn: DateOnly;
  checkOut: DateOnly;
  numberOfNights: number;
  valid: boolean;
  rooms: RoomQuote[];
  subtotalNet: number;
  vatRate: number;
  vatAmount: number;
  totalGross: number;
  priceIncludesVat: true; // project canonical: totals are VAT-inclusive (D41)
  roundingPolicy: string;
  warnings: PricingWarning[];
  errors: PricingError[];
};
