// ============================================================
// PURE pricing-resolution rules — the business half of the central engine.
// No DB, no React, no server imports (dates.ts and rates/rules.ts are pure) —
// standalone-compilable by scripts/check-pricing-engine.mjs, exactly like
// src/lib/rates/rules.ts. The server half (engine.ts) loads rows in batches
// and calls these.
//
// Price precedence (spec §8.3), every resolved amount carries its source:
//   1. exact (plan, unit, date) row price   → plan_unit_date_override /
//                                             independent_plan_price
//   2. per-unit assignment adjustment       → assignment_adjustment
//   3. plan default adjustment              → plan_adjustment
//   4. parent plan resolved value           → derived_from_parent_plan
//   5. base room-night price                → base_plan_rate / room_type_base_price
//   6. no price (structured error, never a silent fallback)
// ============================================================

import type { DateOnly } from "@/lib/dates";
import { dayOfWeek, nightsBetween } from "@/lib/dates";
import type { PlanRateRow } from "@/lib/rates/rules";
import type { AdjustmentSource, PriceSource, PricingErrorCode } from "./types";

export type PlanKind = "base" | "derived_percentage" | "derived_fixed" | "independent";

// A tenant-level Rate Plan as the engine sees it (loaded once per quote).
export type EnginePlan = {
  id: string;
  code: string;
  name: string;
  publicName: string | null;
  planKind: PlanKind;
  parentPlanId: string | null;
  adjustmentValue: number | null;
  isActive: boolean;
  isArchived: boolean;
  validFrom: DateOnly | null;
  validUntil: DateOnly | null;
  minAdvanceDays: number | null;
  maxAdvanceDays: number | null;
  allowedCheckinDays: number[] | null; // 0=Sunday…6, null = all
  defaultMinStay: number | null;
  defaultMaxStay: number | null;
  defaultClosedToArrival: boolean;
  defaultClosedToDeparture: boolean;
  cancellationPolicyId: string | null;
};

export type EngineAssignment = {
  pricingPlanId: string;
  sellableUnitId: string;
  isActive: boolean;
  adjustmentValue: number | null;
  validFrom: DateOnly | null;
  validUntil: DateOnly | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---- parent chain (§5): requested plan first, root last. Cycles/depth are
// DB-enforced (trg_pricing_plans_parent_guard); the engine re-guards so a quote
// can never loop even on inconsistent data.
export const MAX_PARENT_DEPTH = 5;

export function resolveParentChain(
  plansById: Map<string, EnginePlan>,
  planId: string,
): { chain: EnginePlan[]; error: PricingErrorCode | null } {
  const chain: EnginePlan[] = [];
  const seen = new Set<string>();
  let cur: string | null = planId;
  while (cur) {
    if (seen.has(cur)) return { chain, error: "RATE_PLAN_CYCLE" };
    seen.add(cur);
    const plan = plansById.get(cur);
    if (!plan) return { chain, error: chain.length === 0 ? "RATE_PLAN_NOT_FOUND" : "RATE_PLAN_PARENT_INACTIVE" };
    chain.push(plan);
    if (chain.length > MAX_PARENT_DEPTH + 1) return { chain, error: "RATE_PLAN_CYCLE" };
    cur = plan.parentPlanId;
  }
  return { chain, error: null };
}

// ---- derivation math: a fixed ADJUSTMENT, never a fixed final price ----
export function applyPlanAdjustment(
  kind: PlanKind,
  parentPrice: number,
  adjustment: number,
): number {
  return round2(
    kind === "derived_percentage"
      ? parentPrice * (1 + adjustment / 100)
      : parentPrice + adjustment,
  );
}

// ---- nightly price for ONE (plan, unit, date), given the already-resolved
// parent price. Returns null price when the plan has no sellable price — the
// caller emits NO_PRICE_FOR_DATE; there is NO hidden fallback.
export type NightPriceResolution = {
  price: number | null;
  source: PriceSource | null;
  adjustmentValue: number | null;
  adjustmentSource: AdjustmentSource | null;
};

export function resolveNightPrice(input: {
  kind: PlanKind;
  overridePrice: number | null; // exact (plan, unit, date) row price
  parentResolved: number | null;
  planAdjustment: number | null;
  assignmentAdjustment: number | null;
  basePrice: number | null;
  basePriceSource: "base_plan_rate" | "room_type_base_price" | null;
}): NightPriceResolution {
  if (input.overridePrice != null) {
    return {
      price: round2(input.overridePrice),
      source: input.kind === "independent" ? "independent_plan_price" : "plan_unit_date_override",
      adjustmentValue: null,
      adjustmentSource: null,
    };
  }
  if (input.kind === "base") {
    return {
      price: input.basePrice != null ? round2(input.basePrice) : null,
      source: input.basePrice != null ? input.basePriceSource : null,
      adjustmentValue: null,
      adjustmentSource: null,
    };
  }
  if (input.kind === "independent") {
    // an independent plan without a price row for this date is unavailable
    return { price: null, source: null, adjustmentValue: null, adjustmentSource: null };
  }
  // derived_*
  if (input.parentResolved == null) {
    return { price: null, source: null, adjustmentValue: null, adjustmentSource: null };
  }
  const adjustment = input.assignmentAdjustment ?? input.planAdjustment;
  if (adjustment == null) {
    return { price: null, source: null, adjustmentValue: null, adjustmentSource: null };
  }
  return {
    price: applyPlanAdjustment(input.kind, input.parentResolved, adjustment),
    source: "derived_from_parent_plan",
    adjustmentValue: adjustment,
    adjustmentSource: input.assignmentAdjustment != null ? "assignment_adjustment" : "plan_adjustment",
  };
}

// ---- THE nightly price for one (plan chain, unit, date) ----
// Walks the parent chain root-first, feeding each level's resolved price into
// the next, exactly as the price precedence in the header describes. The ONE
// implementation: engine.ts (quotes, reservations, the simulator) and the
// Channex ARI projection both call this — a channel can never resolve a price
// by a different rule than a booking does.
//
// `chain` is requested-plan-first / root-last (as resolveParentChain returns).
// An EMPTY chain is the explicit base-ARI layer: no tenant-level plan applies
// and the unit's base room-night price IS the price.
//
// `directParentPrice` is the resolved value of the requested plan's immediate
// parent (chain[1]) — null when the requested plan is itself the root.
export function resolveChainNightPrice(input: {
  chain: EnginePlan[];
  date: DateOnly;
  basePrice: number | null;
  basePriceSource: "base_plan_rate" | "room_type_base_price" | null;
  overlayFor: (planId: string) => Map<string, PlanRateRow> | undefined;
  assignmentFor: (planId: string) => EngineAssignment | undefined;
}): { resolution: NightPriceResolution; directParentPrice: number | null } {
  if (input.chain.length === 0) {
    return {
      resolution: resolveNightPrice({
        kind: "base", overridePrice: null, parentResolved: null,
        planAdjustment: null, assignmentAdjustment: null,
        basePrice: input.basePrice, basePriceSource: input.basePriceSource,
      }),
      directParentPrice: null,
    };
  }

  let parentResolved: number | null = null;
  let directParentPrice: number | null = null;
  let resolution!: NightPriceResolution;
  for (let i = input.chain.length - 1; i >= 0; i--) {
    const level = input.chain[i];
    if (i === 0) directParentPrice = parentResolved; // chain[1]'s resolved value
    resolution = resolveNightPrice({
      kind: level.planKind,
      overridePrice: input.overlayFor(level.id)?.get(input.date)?.price ?? null,
      parentResolved,
      planAdjustment: level.adjustmentValue,
      assignmentAdjustment: input.assignmentFor(level.id)?.adjustmentValue ?? null,
      basePrice: input.basePrice,
      basePriceSource: input.basePriceSource,
    });
    parentResolved = resolution.price;
  }
  return { resolution, directParentPrice };
}

// ---- restriction overlay merge (§10/§24): the base room-night state applies to
// EVERY plan (a plan can only tighten it, never open what the room closed);
// per-(plan,unit,date) rows layer plan-specific restrictions on top. An overlay
// row's boolean is explicit (false = deliberately open at the plan layer); a
// missing overlay row falls back to the plan's static defaults for CTA/CTD.
const maxNullable = (a: number | null, b: number | null): number | null =>
  a == null ? b : b == null ? a : Math.max(a, b);
const minNullable = (a: number | null, b: number | null): number | null =>
  a == null ? b : b == null ? a : Math.min(a, b);

export function mergeRestrictionRows(
  dates: DateOnly[], // every date needing a row (stay nights + checkout for CTD)
  baseByDate: Map<string, PlanRateRow>,
  overlayByDate: Map<string, PlanRateRow>,
  plan: Pick<EnginePlan, "defaultClosedToArrival" | "defaultClosedToDeparture">,
): Map<string, PlanRateRow> {
  const out = new Map<string, PlanRateRow>();
  for (const date of dates) {
    const base = baseByDate.get(date);
    const ov = overlayByDate.get(date);
    out.set(date, {
      date,
      price: null, // price is resolved separately — this map is restrictions-only
      min_stay_through: maxNullable(base?.min_stay_through ?? null, ov?.min_stay_through ?? null),
      min_stay_arrival: maxNullable(base?.min_stay_arrival ?? null, ov?.min_stay_arrival ?? null),
      max_stay: minNullable(base?.max_stay ?? null, ov?.max_stay ?? null),
      closed_to_arrival:
        (base?.closed_to_arrival ?? false) || (ov ? ov.closed_to_arrival : plan.defaultClosedToArrival),
      closed_to_departure:
        (base?.closed_to_departure ?? false) || (ov ? ov.closed_to_departure : plan.defaultClosedToDeparture),
      stop_sell: (base?.stop_sell ?? false) || (ov?.stop_sell ?? false),
    });
  }
  return out;
}

// ---- plan-level stay rules (validity window, booking window, arrival DOW,
// plan default min/max stay). Evaluated once per stay; `today` is tenant-local.
export type PlanRuleViolation = {
  code: Extract<
    PricingErrorCode,
    | "RATE_PLAN_OUTSIDE_VALIDITY"
    | "ADVANCE_BOOKING_RULE_FAILED"
    | "ARRIVAL_DAY_NOT_ALLOWED"
    | "MIN_STAY_NOT_MET"
    | "MAX_STAY_EXCEEDED"
  >;
  detail: string; // Hebrew detail for the breakdown
};

export function planStayRuleViolation(
  plan: EnginePlan,
  stay: { checkIn: DateOnly; checkOut: DateOnly; nights: DateOnly[] },
  today: DateOnly,
): PlanRuleViolation | null {
  const lastNight = stay.nights[stay.nights.length - 1];
  if (plan.validFrom && stay.checkIn < plan.validFrom)
    return { code: "RATE_PLAN_OUTSIDE_VALIDITY", detail: `התוכנית בתוקף החל מ-${plan.validFrom}` };
  if (plan.validUntil && lastNight > plan.validUntil)
    return { code: "RATE_PLAN_OUTSIDE_VALIDITY", detail: `התוכנית בתוקף עד ${plan.validUntil}` };

  const leadDays = nightsBetween(today, stay.checkIn);
  if (plan.minAdvanceDays != null && leadDays < plan.minAdvanceDays)
    return { code: "ADVANCE_BOOKING_RULE_FAILED", detail: `נדרשת הזמנה של לפחות ${plan.minAdvanceDays} ימים מראש` };
  if (plan.maxAdvanceDays != null && leadDays > plan.maxAdvanceDays)
    return { code: "ADVANCE_BOOKING_RULE_FAILED", detail: `ניתן להזמין עד ${plan.maxAdvanceDays} ימים מראש` };

  if (plan.allowedCheckinDays && !plan.allowedCheckinDays.includes(dayOfWeek(stay.checkIn)))
    return { code: "ARRIVAL_DAY_NOT_ALLOWED", detail: "יום ההגעה אינו מותר בתוכנית זו" };

  const nightsCount = stay.nights.length;
  if (plan.defaultMinStay != null && nightsCount < plan.defaultMinStay)
    return { code: "MIN_STAY_NOT_MET", detail: `מינימום ${plan.defaultMinStay} לילות בתוכנית זו` };
  if (plan.defaultMaxStay != null && nightsCount > plan.defaultMaxStay)
    return { code: "MAX_STAY_EXCEEDED", detail: `מקסימום ${plan.defaultMaxStay} לילות בתוכנית זו` };

  return null;
}

// ---- assignment eligibility for one (plan, unit) over a stay ----
export function assignmentViolation(
  assignment: EngineAssignment | undefined,
  stay: { checkIn: DateOnly; nights: DateOnly[] },
): PricingErrorCode | null {
  if (!assignment || !assignment.isActive) return "RATE_PLAN_NOT_ASSIGNED";
  const lastNight = stay.nights[stay.nights.length - 1];
  if (assignment.validFrom && stay.checkIn < assignment.validFrom) return "RATE_PLAN_NOT_ASSIGNED";
  if (assignment.validUntil && lastNight > assignment.validUntil) return "RATE_PLAN_NOT_ASSIGNED";
  return null;
}

// ---- Hebrew formula label (§18): explain the plan, never show raw enums ----
export function planFormulaLabel(
  plan: Pick<EnginePlan, "planKind" | "adjustmentValue">,
  parentName: string | null,
): string {
  switch (plan.planKind) {
    case "base":
      return "מחיר בסיס";
    case "independent":
      return "מחיר עצמאי";
    case "derived_percentage": {
      const v = plan.adjustmentValue ?? 0;
      const abs = Math.abs(v);
      return `${abs}%${v >= 0 ? "+" : "-"} מ${parentName ?? "תוכנית האב"}`;
    }
    case "derived_fixed": {
      const v = plan.adjustmentValue ?? 0;
      const abs = Math.abs(v);
      return `₪${abs}${v >= 0 ? "+" : "-"} ללילה מ${parentName ?? "תוכנית האב"}`;
    }
  }
}
