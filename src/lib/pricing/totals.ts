import { includedVatForReservation } from "@/lib/vat";

// ============================================================
// THE single source of the reservation total (D106). PURE and ISOMORPHIC on
// purpose: no "server-only", no DB, no React — the same one implementation
// runs in the server actions that persist money, in the panels that preview
// it live, in the SQL call sites that used to re-implement it, and in the
// guards that assert on it. Five parallel formulas (two SQL, two client-side,
// one TS) collapse into this file; docs/PRICING_AUDIT.md §ז' is the record of
// why. Per-stay money (nightly resolution, LOS tiers, manual modes) is decided
// UPSTREAM by the engine + resolveStayPrice — this module only combines
// committed stay grosses with the reservation-level discount, extras and VAT.
//
// All arithmetic is INTEGER AGOROT (the engine's own subtotalCents pattern):
// an operator-entered manual total round-trips to the agora with no float
// dust, and numeric(12,2) columns compare byte-identical before/after.
// ============================================================

/** per-room price mode (reservation_rooms.price_mode, migration 058) */
export type PriceMode = "auto" | "manual_night" | "manual_total";

export type DiscountMode =
  | "none"              // מחיר מלא
  | "amount_per_night"  // ₪ לכל לילה
  | "percent_per_night" // % לכל לילה
  | "amount_total"      // ₪ להזמנה — the pre-058 discount_amount semantics (default)
  | "percent_total";    // % להזמנה

export const DISCOUNT_MODES: readonly DiscountMode[] = [
  "none", "amount_per_night", "percent_per_night", "amount_total", "percent_total",
];

export type StayCharge = {
  /** the stay's committed gross (post-engine, post-LOS, post price-mode) */
  priceTotal: number;
  nights: number;
};

export type ReservationTotalsInput = {
  stays: StayCharge[];
  /**
   * OTA-sent reservation rooms-total (channel imports only) — when present it
   * REPLACES Σ stays.priceTotal: the channel's number is sovereign (H6) and is
   * never re-derived from our own nightly math.
   */
  roomsTotalOverride?: number | null;
  discountMode: DiscountMode;
  /** ₪ or %, per mode; ignored (treated as 0) when mode = "none" */
  discountValue: number;
  extraCharges: number;
  /** the VAT toggle, OFF ⇒ true (reservations.tax_exempt) */
  taxExempt: boolean;
  vatRate: number;
  currency: string;
  exchangeRate?: number | null;
  /** ledger-derived collected amount — display/preview only, never recomputed here */
  paid?: number;
};

export type ReservationTotals = {
  roomsTotal: number;
  nightsTotal: number;
  /** the RESOLVED absolute ₪ discount — persisted to reservations.discount_amount */
  discountAmount: number;
  extraCharges: number;
  /** persisted to reservations.total_price */
  grandTotal: number;
  /** VAT included in grandTotal (0 when taxExempt) — includedVatForReservation */
  vatAmount: number;
  netTotal: number;
  currency: string;
  exchangeRate: number | null;
  paid: number;
  /** grandTotal − paid, NOT floored (ledger convention: negative = credit) */
  balance: number;
};

export type TotalsValidationCode =
  | "DISCOUNT_PERCENT_RANGE"
  | "DISCOUNT_EXCEEDS_TOTAL"
  | "NEGATIVE_VALUE";

const VALIDATION_MESSAGES: Record<TotalsValidationCode, string> = {
  DISCOUNT_PERCENT_RANGE: "אחוז הנחה חייב להיות בין 0 ל-100",
  DISCOUNT_EXCEEDS_TOTAL: "ההנחה גדולה מסכום ההזמנה",
  NEGATIVE_VALUE: "סכום שלילי אינו חוקי",
};

export class TotalsValidationError extends Error {
  code: TotalsValidationCode;
  constructor(code: TotalsValidationCode) {
    super(VALIDATION_MESSAGES[code]);
    this.name = "TotalsValidationError";
    this.code = code;
  }
}

const cents = (n: number) => Math.round(n * 100);
const fromCents = (c: number) => c / 100;

function discountCents(
  mode: DiscountMode, value: number, roomsCents: number, nightsTotal: number,
): number {
  switch (mode) {
    case "none": return 0;
    case "amount_total": return cents(value);
    case "amount_per_night": return cents(value) * nightsTotal;
    // percent-of-rooms is mathematically identical for the per-night and
    // per-reservation phrasings (Σ nightly×p% ≡ (Σ nightly)×p%): the two modes
    // exist for the operator's wording and the nightly-breakdown display only.
    case "percent_total":
    case "percent_per_night":
      return Math.round((roomsCents * value) / 100);
  }
}

export type ComputeTotalsOptions = {
  /**
   * Channel imports skip validation (the OTA amount is sovereign and a weird
   * discount must not block an import) — the zero floor still applies.
   */
  validate?: boolean;
};

export function computeReservationTotals(
  input: ReservationTotalsInput,
  opts: ComputeTotalsOptions = {},
): ReservationTotals {
  const validate = opts.validate ?? true;
  const mode = input.discountMode;
  const value = mode === "none" ? 0 : input.discountValue;

  if (validate) {
    if (value < 0 || input.extraCharges < 0) throw new TotalsValidationError("NEGATIVE_VALUE");
    if ((mode === "percent_total" || mode === "percent_per_night") && (value < 0 || value > 100)) {
      throw new TotalsValidationError("DISCOUNT_PERCENT_RANGE");
    }
  }

  const nightsTotal = input.stays.reduce((s, st) => s + st.nights, 0);
  const roomsCents =
    input.roomsTotalOverride != null
      ? cents(input.roomsTotalOverride)
      : input.stays.reduce((s, st) => s + cents(st.priceTotal), 0);
  const extraCents = cents(input.extraCharges);
  const discCents = discountCents(mode, value, roomsCents, nightsTotal);

  if (validate && discCents > roomsCents + extraCents) {
    throw new TotalsValidationError("DISCOUNT_EXCEEDS_TOTAL");
  }

  const grandCents = Math.max(0, roomsCents + extraCents - discCents);
  const grandTotal = fromCents(grandCents);
  const vatAmount = includedVatForReservation(grandTotal, input.vatRate, input.taxExempt);
  const paid = input.paid ?? 0;

  return {
    roomsTotal: fromCents(roomsCents),
    nightsTotal,
    discountAmount: fromCents(discCents),
    extraCharges: fromCents(extraCents),
    grandTotal,
    vatAmount,
    netTotal: fromCents(grandCents - cents(vatAmount)),
    currency: input.currency,
    exchangeRate: input.exchangeRate ?? null,
    paid,
    balance: fromCents(grandCents - cents(paid)),
  };
}

/**
 * Display-only nightly spread of a manual per-room TOTAL (largest-remainder in
 * agorot): the per-night figures always sum back to the exact entered total.
 * NEVER persisted — reservation_rooms.price_total stays the entered amount.
 */
export function spreadTotalOverNights(total: number, nights: number): number[] {
  if (nights <= 0) return [];
  const totalCents = cents(total);
  const base = Math.floor(totalCents / nights);
  const remainder = totalCents - base * nights;
  return Array.from({ length: nights }, (_, i) => fromCents(base + (i < remainder ? 1 : 0)));
}
