// ============================================================
// PURE canonical commercial rules (no imports, no DB) — the business half of
// src/lib/rates. The SINGLE pricing + restriction logic for the Rate Grid, the
// Group Update, the booking engine, quotes, reservation snapshots, and the
// channel payload builder. Checkable by scripts/check-effective-state.mjs.
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

// Structured stay-restriction verdict — the machine-readable twin of the Hebrew
// message. The pricing engine consumes the code; the grid/booking UI consume the
// message via stayRestrictionViolation below. ONE evaluation order, two faces.
export type StayRuleViolation =
  | { code: "CLOSED_ON_ARRIVAL"; date: string }
  | { code: "MIN_STAY_NOT_MET"; date: string; required: number; scope: "arrival" | "through" }
  | { code: "MAX_STAY_EXCEEDED"; date: string; limit: number }
  | { code: "CLOSED_ON_DEPARTURE"; date: string }
  | { code: "STOP_SELL"; date: string };

// THE shared stay-restriction validator (§0.3). Rejects on the FIRST failing
// rule. `nights` = the occupied nights [checkIn, checkOut). Considers:
//   - min_stay_arrival on the arrival date
//   - the MAXIMUM applicable min_stay_through across all stay dates
//   - max_stay, closed_to_arrival (arrival), closed_to_departure (departure)
//   - stop_sell across all required sell dates
export function stayRestrictionViolationStructured(
  byDate: Map<string, PlanRateRow>,
  stay: { checkIn: string; checkOut: string; nights: string[] },
): StayRuleViolation | null {
  const nightsCount = stay.nights.length;

  const arrival = byDate.get(stay.checkIn);
  if (arrival) {
    if (arrival.closed_to_arrival) return { code: "CLOSED_ON_ARRIVAL", date: stay.checkIn };
    const minArrival = stayLimit(arrival.min_stay_arrival);
    const maxStay = stayLimit(arrival.max_stay);
    if (minArrival != null && nightsCount < minArrival)
      return { code: "MIN_STAY_NOT_MET", date: stay.checkIn, required: minArrival, scope: "arrival" };
    if (maxStay != null && nightsCount > maxStay)
      return { code: "MAX_STAY_EXCEEDED", date: stay.checkIn, limit: maxStay };
  }

  const departure = byDate.get(stay.checkOut);
  if (departure?.closed_to_departure) return { code: "CLOSED_ON_DEPARTURE", date: stay.checkOut };

  // stop_sell on any occupied night blocks the sale; min_stay_through is the
  // MAX through-min across the occupied nights (the strictest applicable).
  let maxThrough = 0;
  let maxThroughDate = stay.checkIn;
  for (const d of stay.nights) {
    const row = byDate.get(d);
    if (row?.stop_sell) return { code: "STOP_SELL", date: d };
    const through = stayLimit(row?.min_stay_through);
    if (through != null && through > maxThrough) {
      maxThrough = through;
      maxThroughDate = d;
    }
  }
  if (maxThrough > 0 && nightsCount < maxThrough)
    return { code: "MIN_STAY_NOT_MET", date: maxThroughDate, required: maxThrough, scope: "through" };

  return null;
}

// THE Hebrew wording of the two closed-to-* restrictions. ONE string, ONE
// spelling, read by every surface that names them: this message, the pricing
// error map (lib/pricing/messages.ts) and the calendar hover card. Spelled out
// in words on purpose — no member of staff has to know what CTA or CTD stands
// for; the abbreviations stay in the codes, the code and the comments.
export const CLOSED_TO_ARRIVAL_TEXT = "התאריך סגור לכניסת אורחים";
export const CLOSED_TO_DEPARTURE_TEXT = "התאריך סגור לעזיבת אורחים";
// Stop-sell, same rule — but the bare PHRASE, not a sentence, because two
// surfaces need it at two different grammatical scopes: the violation message
// below names a DATE ("התאריך … סגור למכירה"), while the calendar's room label
// names a ROOM whose every visible night is closed. Composing the sentence from
// this constant is what keeps them one spelling instead of two.
export const STOP_SELL_TEXT = "סגור למכירה";

// The Hebrew face of a DateOnly: "2026-08-25" → "25.8". Day and month only —
// every surface that shows a restriction message is a calendar view whose own
// header already names the month and the year, so repeating them adds nothing,
// and a raw ISO string reads as machine output inside a Hebrew sentence.
//
// The same arithmetic exists in lib/dates.formatDayMonth, and it is deliberately
// NOT imported: this module is compiled STANDALONE by eight guard scripts with a
// bare `tsc src/lib/rates/rules.ts` — no tsconfig, so no "@/" path mapping — and
// a single import would break every one of them. That is what the PURE line in
// the header buys, and four characters of slicing is the cheap half of the deal.
// Passing a formatter in as a parameter would be worse still: it would hand the
// decision back to all five call sites, which is precisely the "every component
// formats its own dates" that having one wording module exists to prevent.
function dayMonth(date: string): string {
  return `${Number(date.slice(8, 10))}.${Number(date.slice(5, 7))}`;
}

// Hebrew message for a structured violation — the exact historical grid wording.
export function stayViolationMessage(v: StayRuleViolation): string {
  switch (v.code) {
    case "CLOSED_ON_ARRIVAL": return CLOSED_TO_ARRIVAL_TEXT;
    case "MIN_STAY_NOT_MET":
      return v.scope === "arrival"
        ? `מינימום ${v.required} לילות בהגעה בתאריך זה`
        : `מינימום ${v.required} לילות בטווח זה`;
    case "MAX_STAY_EXCEEDED": return `מקסימום ${v.limit} לילות בתאריך זה`;
    case "CLOSED_ON_DEPARTURE": return CLOSED_TO_DEPARTURE_TEXT;
    case "STOP_SELL": return `התאריך ${dayMonth(v.date)} ${STOP_SELL_TEXT}`;
  }
}

// ============================================================
// WHICH violations a human may override (084 · reservations.restriction_override).
//
// The line is COMMERCIAL vs PHYSICAL, and it is not negotiable:
//
//   overridable — every code below. They are SALES rules a property sets and a
//     manager may knowingly sell against: closed to arrival, closed to
//     departure, stop-sell, minimum stay, maximum stay. Selling one of these
//     costs money or breaks a policy; it never double-books a bed.
//
//   NEVER overridable — everything else, and in particular every PHYSICAL
//     conflict, which does not appear in this type at all: a room under an OOO
//     closure, a room that is out_of_order or inactive, and an existing blocking
//     stay. Those are facts about the world, not decisions about price, and no
//     permission can wish a second guest into an occupied bed. They are enforced
//     on the server by the AVAILABILITY group (lib/pricing/reservation-pricing.ts),
//     which the override never touches, and in the calendar by rangeInvalid,
//     which does not route through this mechanism at all.
//
// This set is the ONE declaration of that boundary; the client dialog and the
// server gate both read it, so they cannot drift.
// ============================================================
export const OVERRIDABLE_STAY_RULE_CODES = [
  "CLOSED_ON_ARRIVAL",
  "CLOSED_ON_DEPARTURE",
  "STOP_SELL",
  "MIN_STAY_NOT_MET",
  "MAX_STAY_EXCEEDED",
] as const satisfies readonly StayRuleViolation["code"][];

export type OverridableStayRuleCode = (typeof OVERRIDABLE_STAY_RULE_CODES)[number];

const OVERRIDABLE = new Set<string>(OVERRIDABLE_STAY_RULE_CODES);

/** True when a manager holding reservations.restriction_override may proceed
 *  anyway. Anything not explicitly listed is a hard block — the default is NO. */
export function isOverridableStayCode(code: string): code is OverridableStayRuleCode {
  return OVERRIDABLE.has(code);
}

// Message-shaped wrapper — the historical API every existing caller keeps using.
export function stayRestrictionViolation(
  byDate: Map<string, PlanRateRow>,
  stay: { checkIn: string; checkOut: string; nights: string[] },
): string | null {
  const v = stayRestrictionViolationStructured(byDate, stay);
  return v ? stayViolationMessage(v) : null;
}

// The three per-date fields the MIN/MAX-NIGHTS rule needs — a narrow view of a
// PlanRateRow so a caller (e.g. the calendar) can build the map from whatever
// read model it already holds.
export type NightsRuleRow = Pick<PlanRateRow, "min_stay_arrival" | "min_stay_through" | "max_stay">;

// THE stay-length limit reader (D104). NULL and 0 both mean "no limit": the
// Group Update clears a restriction by writing NULL, and channel/import payloads
// conventionally send 0 for "unlimited" — read literally, a 0 would be a rule
// that rejects every possible stay. Only a positive number is a real limit.
export function stayLimit(v: number | null | undefined): number | null {
  return v != null && v > 0 ? v : null;
}

// Focused stay-LENGTH check: a deliberate SUBSET of stayRestrictionViolation-
// Structured that evaluates ONLY min_stay_arrival, min_stay_through and max_stay
// — NOT the commercial CTA / CTD / stop_sell gates. Front-desk staff may still
// place a MANUAL booking on a closed/stop-sold date, so a manual calendar create
// is blocked purely on illegal LENGTH. Same evaluation order and the same Hebrew
// messages (stayViolationMessage) as the full validator, so the calendar block,
// the server create gate and the channel ARI rules can never disagree.
export function nightsRuleViolation(
  byDate: Map<string, NightsRuleRow>,
  stay: { checkIn: string; nights: string[] },
): StayRuleViolation | null {
  const nightsCount = stay.nights.length;

  const arrival = byDate.get(stay.checkIn);
  if (arrival) {
    const minArrival = stayLimit(arrival.min_stay_arrival);
    const maxStay = stayLimit(arrival.max_stay);
    if (minArrival != null && nightsCount < minArrival)
      return { code: "MIN_STAY_NOT_MET", date: stay.checkIn, required: minArrival, scope: "arrival" };
    if (maxStay != null && nightsCount > maxStay)
      return { code: "MAX_STAY_EXCEEDED", date: stay.checkIn, limit: maxStay };
  }

  // min_stay_through is the strictest through-min across the occupied nights.
  let maxThrough = 0;
  let maxThroughDate = stay.checkIn;
  for (const d of stay.nights) {
    const t = stayLimit(byDate.get(d)?.min_stay_through);
    if (t != null && t > maxThrough) {
      maxThrough = t;
      maxThroughDate = d;
    }
  }
  if (maxThrough > 0 && nightsCount < maxThrough)
    return { code: "MIN_STAY_NOT_MET", date: maxThroughDate, required: maxThrough, scope: "through" };

  return null;
}

// ============================================================
// Sale-state reason codes (Step 2). The read model must not collapse unrelated
// causes into one generic "hatched" state. classifySellState returns exactly
// ONE reason per (SU, date) in strict precedence. IMPORTANT: CTA / CTD / min /
// max stay are NOT closure reasons here — they keep their own chips and never
// mark a cell universally unsellable (a restriction only fails a SPECIFIC stay,
// which stayRestrictionViolation handles). This type is import-free on purpose
// so the module stays standalone-compilable by the check scripts.
// ============================================================
export type SellReason =
  | "SELLABLE"
  | "COMMERCIAL_STOP_SELL"
  | "PHYSICAL_INVENTORY_ZERO"
  | "ROOM_INACTIVE"
  | "ROOM_OUT_OF_ORDER"
  | "PHYSICAL_BLOCK"
  | "RESERVED"
  | "NO_ACTIVE_RATE_PLAN"
  | "MISSING_EFFECTIVE_PRICE"
  | "INVALID_EFFECTIVE_PRICE"
  | "MAPPING_ERROR";

export type SellStateInput = {
  hasBasePlan: boolean;
  totalRooms: number; // member rooms mapped to the SU
  sellableRooms: number; // members that are status='available' AND is_active
  occupiedRooms: number; // members consumed by a blocking reservation this day
  closedRooms: number; // members consumed by a room_closure this day
  inactiveRooms: number; // members status='inactive' OR is_active=false
  outOfOrderRooms: number; // members status='out_of_order'
  availability: number; // GREATEST(0, sellable − consumed)
  effectivePrice: number | null;
  stopSell: boolean;
};

// Precedence: mapping → plan → physical (why zero) → explicit commercial close →
// price. Physical wins over commercial because a physically-absent room can't be
// opened by a commercial toggle (the exact conflation that made close feel
// one-way). A cell is genuinely sellable only when it clears every axis.
export function classifySellState(s: SellStateInput): SellReason {
  if (s.totalRooms <= 0) return "MAPPING_ERROR";
  if (!s.hasBasePlan) return "NO_ACTIVE_RATE_PLAN";
  if (s.availability <= 0) {
    if (s.sellableRooms <= 0) {
      // no physically-eligible member at all — surface which switch is off.
      if (s.outOfOrderRooms > 0) return "ROOM_OUT_OF_ORDER";
      if (s.inactiveRooms > 0) return "ROOM_INACTIVE";
      return "PHYSICAL_INVENTORY_ZERO";
    }
    // eligible rooms exist but every one is consumed today.
    // ponytail: a pooled SU with mixed causes reports the dominant one
    // (reserved before blocked); single-room SUs (the common case) are exact.
    if (s.occupiedRooms > 0) return "RESERVED";
    if (s.closedRooms > 0) return "PHYSICAL_BLOCK";
    return "PHYSICAL_INVENTORY_ZERO";
  }
  if (s.stopSell) return "COMMERCIAL_STOP_SELL";
  if (s.effectivePrice == null || Number.isNaN(s.effectivePrice)) return "MISSING_EFFECTIVE_PRICE";
  if (s.effectivePrice < 0) return "INVALID_EFFECTIVE_PRICE";
  if (s.effectivePrice === 0) return "MISSING_EFFECTIVE_PRICE";
  return "SELLABLE";
}

// The PRIMARY reason is classifySellState (one dominant cause). collectSellReasons
// returns EVERY applicable reason (primary first) so the canonical projection can
// expose `reason_codes[]` — a physically-blocked cell that is ALSO missing a price
// lists both. Order matches classifySellState precedence, so out[0] === primary.
export function collectSellReasons(s: SellStateInput): SellReason[] {
  const out: SellReason[] = [];
  if (s.totalRooms <= 0) out.push("MAPPING_ERROR");
  if (s.totalRooms > 0 && !s.hasBasePlan) out.push("NO_ACTIVE_RATE_PLAN");
  if (s.totalRooms > 0 && s.availability <= 0) {
    if (s.sellableRooms <= 0) {
      if (s.outOfOrderRooms > 0) out.push("ROOM_OUT_OF_ORDER");
      if (s.inactiveRooms > 0) out.push("ROOM_INACTIVE");
      if (s.outOfOrderRooms <= 0 && s.inactiveRooms <= 0) out.push("PHYSICAL_INVENTORY_ZERO");
    } else {
      // eligible rooms exist but all consumed — list EVERY applicable cause
      // (a pooled SU can be consumed by both a reservation AND a closure).
      if (s.occupiedRooms > 0) out.push("RESERVED");
      if (s.closedRooms > 0) out.push("PHYSICAL_BLOCK");
      if (s.occupiedRooms <= 0 && s.closedRooms <= 0) out.push("PHYSICAL_INVENTORY_ZERO");
    }
  }
  if (s.totalRooms > 0 && s.hasBasePlan && s.stopSell) out.push("COMMERCIAL_STOP_SELL");
  if (s.totalRooms > 0 && s.hasBasePlan) {
    if (s.effectivePrice == null || Number.isNaN(s.effectivePrice) || s.effectivePrice === 0) out.push("MISSING_EFFECTIVE_PRICE");
    else if (s.effectivePrice < 0) out.push("INVALID_EFFECTIVE_PRICE");
  }
  return out.length ? out : ["SELLABLE"];
}

// The administrative state of a Sellable Unit's member rooms (physical axis A),
// kept SEPARATE from any commercial state. Pooled SUs with a mix report "mixed".
export type RoomAdminState = "available" | "inactive" | "out_of_order" | "mixed" | "no_member";
export function roomAdminStateOf(
  totalRooms: number, inactiveRooms: number, outOfOrderRooms: number,
): RoomAdminState {
  if (totalRooms <= 0) return "no_member";
  const blocked = inactiveRooms + outOfOrderRooms;
  if (blocked === 0) return "available";
  if (outOfOrderRooms > 0 && inactiveRooms === 0) return outOfOrderRooms >= totalRooms ? "out_of_order" : "mixed";
  if (inactiveRooms > 0 && outOfOrderRooms === 0) return inactiveRooms >= totalRooms ? "inactive" : "mixed";
  return "mixed";
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Resolve the committed price for ONE stay (§6). Precedence:
//   1. manual TOTAL — the operator's exact final amount for the whole stay
//      (price_mode='manual_total', D106): priceTotal is the entered number to
//      the agora; ratePerNight is a display-only spread and never re-derives it;
//   2. manual nightly override — an explicit authorized rate, always honored;
//   3. committed snapshot — a confirmed stay whose price basis (room + dates)
//      is unchanged keeps its stored price and is NEVER re-priced from the
//      current rate table, so a guest-agreed total can't drift when rates
//      change later (snapshot.priceTotal preserves exact per-night variation);
//   4. otherwise auto-price from the CURRENT rate table (autoTotal = the sum of
//      the nightly prices the caller already resolved).
export function resolveStayPrice(input: {
  nights: number;
  isManualRate: boolean;
  manualRatePerNight?: number | null;
  manualTotal?: number | null;
  snapshot?: { ratePerNight: number; priceTotal?: number } | null;
  autoTotal: number;
}): { ratePerNight: number; priceTotal: number } {
  const { nights } = input;
  if (input.manualTotal != null) {
    const t = round2(input.manualTotal);
    return { ratePerNight: nights > 0 ? round2(t / nights) : t, priceTotal: t };
  }
  if (input.isManualRate) {
    const r = input.manualRatePerNight ?? 0;
    return { ratePerNight: r, priceTotal: round2(r * nights) };
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
