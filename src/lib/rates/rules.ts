// ============================================================
// PURE canonical commercial rules (no imports, no DB) — the business half of
// src/lib/rates. The SINGLE pricing + restriction logic for the Rate Grid, the
// Group Update, the booking engine, quotes, reservation snapshots, and the
// Channex payload builder. Checkable by scripts/check-effective-state.mjs.
// Approved decisions §0.3/§0.4.
// ============================================================

// One canonical commercial row (guesthub.pricing_plan_rates), per plan/date.
// The three stay fields are stored SEPARATELY and never collapsed (§0.3).
export type PlanRateRow = {
  date: string; // DateOnly "YYYY-MM-DD"
  price: number | null;
  min_stay_through: number | null;
  min_stay_arrival: number | null;
  max_stay: number | null;
  closed_to_arrival: boolean;
  closed_to_departure: boolean;
  stop_sell: boolean;
};

// Index canonical rows by date for O(1) per-day lookup within one plan.
export function indexByDate(rows: PlanRateRow[]): Map<string, PlanRateRow> {
  const m = new Map<string, PlanRateRow>();
  for (const r of rows) m.set(r.date, r);
  return m;
}

// Effective nightly price for one date: the plan's price, else the base_price
// fallback (the SU's room-type base). One pricing rule everywhere.
export function planNightlyPrice(
  byDate: Map<string, PlanRateRow>,
  date: string,
  basePrice: number,
): number {
  const p = byDate.get(date)?.price;
  return p == null ? basePrice : Number(p);
}

// THE shared stay-restriction validator (§0.3). Rejects on the FIRST failing
// rule. `nights` = the occupied nights [checkIn, checkOut). Considers:
//   - min_stay_arrival on the arrival date
//   - the MAXIMUM applicable min_stay_through across all stay dates
//   - max_stay, closed_to_arrival (arrival), closed_to_departure (departure)
//   - stop_sell across all required sell dates
export function stayRestrictionViolation(
  byDate: Map<string, PlanRateRow>,
  stay: { checkIn: string; checkOut: string; nights: string[] },
): string | null {
  const nightsCount = stay.nights.length;

  const arrival = byDate.get(stay.checkIn);
  if (arrival) {
    if (arrival.closed_to_arrival) return "התאריך סגור לצ׳ק-אין (CTA)";
    if (arrival.min_stay_arrival != null && nightsCount < arrival.min_stay_arrival)
      return `מינימום ${arrival.min_stay_arrival} לילות בהגעה בתאריך זה`;
    if (arrival.max_stay != null && nightsCount > arrival.max_stay)
      return `מקסימום ${arrival.max_stay} לילות בתאריך זה`;
  }

  const departure = byDate.get(stay.checkOut);
  if (departure?.closed_to_departure) return "התאריך סגור לצ׳ק-אאוט (CTD)";

  // stop_sell on any occupied night blocks the sale; min_stay_through is the
  // MAX through-min across the occupied nights (the strictest applicable).
  let maxThrough = 0;
  for (const d of stay.nights) {
    const row = byDate.get(d);
    if (row?.stop_sell) return `התאריך ${d} סגור למכירה`;
    if (row?.min_stay_through != null && row.min_stay_through > maxThrough)
      maxThrough = row.min_stay_through;
  }
  if (maxThrough > 0 && nightsCount < maxThrough)
    return `מינימום ${maxThrough} לילות בטווח זה`;

  return null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Resolve the committed price for ONE stay (§6). Precedence:
//   1. manual override — an explicit authorized rate, always honored;
//   2. committed snapshot — a confirmed stay whose price basis (room + dates)
//      is unchanged keeps its stored price and is NEVER re-priced from the
//      current rate table, so a guest-agreed total can't drift when rates
//      change later (snapshot.priceTotal preserves exact per-night variation);
//   3. otherwise auto-price from the CURRENT rate table (autoTotal = the sum of
//      the nightly prices the caller already resolved).
export function resolveStayPrice(input: {
  nights: number;
  isManualRate: boolean;
  manualRatePerNight?: number | null;
  snapshot?: { ratePerNight: number; priceTotal?: number } | null;
  autoTotal: number;
}): { ratePerNight: number; priceTotal: number } {
  const { nights } = input;
  if (input.isManualRate) {
    const r = input.manualRatePerNight ?? 0;
    return { ratePerNight: r, priceTotal: r * nights };
  }
  if (input.snapshot) {
    const r = input.snapshot.ratePerNight;
    return { ratePerNight: r, priceTotal: input.snapshot.priceTotal ?? round2(r * nights) };
  }
  return {
    ratePerNight: nights > 0 ? round2(input.autoTotal / nights) : 0,
    priceTotal: input.autoTotal,
  };
}

// Group-Update price modes (§7b). An undefined field = "don't touch" and is
// handled by the caller; this only computes a touched price. Clamps at 0 and
// rounds to cents. current=null falls back to the base price.
export type PriceMode =
  | "replace" | "add" | "subtract" | "percent_add" | "percent_subtract";

export function applyPriceMode(
  current: number | null,
  mode: PriceMode,
  amount: number,
  basePrice: number,
): number {
  const cur = current == null ? basePrice : current;
  const raw =
    mode === "replace" ? amount
    : mode === "add" ? cur + amount
    : mode === "subtract" ? cur - amount
    : mode === "percent_add" ? cur * (1 + amount / 100)
    : cur * (1 - amount / 100); // percent_subtract
  return Math.round(Math.max(0, raw) * 100) / 100;
}
