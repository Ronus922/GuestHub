import type { LosDiscountKind, LosDiscountQuote, LosDiscountTier } from "./types";

// ============================================================
// Length-of-stay discounts (D104) — the PURE rule: which tier a stay wins, what
// it takes off, and the sentence that explains it. No DB, no React: the engine
// loads the tiers, this decides, and every surface (manual reservation, rate
// plan simulator, website, channels) shows the SAME chosen tier and the SAME
// arithmetic. A discount the operator cannot reproduce on paper is a bug.
// ============================================================

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Which tiers apply to a plan: its own if it has any, otherwise the tenant
 * defaults — EXCEPT a derived_percentage plan (D105): a weekly/monthly rate is
 * itself length-of-stay pricing, and inheriting the default tier on top would
 * double-discount (30 nights: −30% plan and then −30% tier again). Only a tier
 * defined explicitly ON such a plan applies to it. The caller passes the
 * REQUESTED plan's kind; null planKind = base-ARI layer (defaults apply).
 */
export function tiersForPlan(
  all: LosDiscountTier[],
  ratePlanId: string | null,
  planKind: string | null = null,
): LosDiscountTier[] {
  const active = all.filter((t) => t.isActive);
  const own = ratePlanId != null ? active.filter((t) => t.pricingPlanId === ratePlanId) : [];
  if (own.length > 0) return own;
  if (planKind === "derived_percentage") return [];
  return active.filter((t) => t.pricingPlanId == null);
}

/**
 * The most specific tier the stay satisfies. Highest min_nights wins (30+ beats
 * 7+ beats 4+); a tie is broken by the id so two identical thresholds can never
 * make the same stay price differently on two calls.
 */
export function selectTier(tiers: LosDiscountTier[], nights: number): LosDiscountTier | null {
  const eligible = tiers.filter(
    (t) => nights >= t.minNights && (t.maxNights == null || nights <= t.maxNights),
  );
  if (eligible.length === 0) return null;
  return eligible.sort(
    (a, b) => b.minNights - a.minNights || a.id.localeCompare(b.id),
  )[0]!;
}

function rawAmount(kind: LosDiscountKind, value: number, basis: number, nights: number): number {
  switch (kind) {
    case "percent": return basis * (value / 100);
    case "amount_per_night": return value * nights;
    case "amount_per_stay": return value;
  }
}

export function tierBandLabel(t: Pick<LosDiscountTier, "minNights" | "maxNights">): string {
  return t.maxNights == null ? `${t.minNights}+ לילות` : `${t.minNights}–${t.maxNights} לילות`;
}

const money = (n: number) => `₪${round2(n).toLocaleString("he-IL")}`;

/**
 * Apply the tier to the ACCOMMODATION subtotal (resolved nightly prices only —
 * extra-guest charges are their own line and are never discounted). The result
 * carries the full arithmetic, so the panel/PDF/snapshot never re-derive it.
 */
export function applyTier(
  tier: LosDiscountTier,
  opts: { basis: number; nights: number; scope: LosDiscountQuote["scope"] },
): LosDiscountQuote {
  const uncapped = round2(rawAmount(tier.kind, tier.value, opts.basis, opts.nights));
  // a discount can never exceed what is being discounted — a per-night amount
  // above the nightly price would otherwise produce a negative stay
  const amount = Math.max(0, Math.min(round2(opts.basis), uncapped));
  const capped = amount !== uncapped;
  const band = tierBandLabel(tier);
  const how =
    tier.kind === "percent"
      ? `${tier.value}% מתוך ${money(opts.basis)} לינה`
      : tier.kind === "amount_per_night"
        ? `${money(tier.value)} × ${opts.nights} לילות`
        : `${money(tier.value)} לשהות`;
  return {
    id: tier.id,
    name: tier.name,
    kind: tier.kind,
    value: tier.value,
    minNights: tier.minNights,
    maxNights: tier.maxNights,
    scope: opts.scope,
    nights: opts.nights,
    basis: round2(opts.basis),
    amount,
    explanation:
      `הנחת שהייה ארוכה · ${tier.name} (${band}): ${how} = −${money(amount)}` +
      (capped ? " (הוגבל לסכום הלינה)" : ""),
  };
}

/** the whole decision in one call: pick the tier for this plan+length, apply it */
export function resolveLosDiscount(
  all: LosDiscountTier[],
  args: {
    ratePlanId: string | null;
    /** the REQUESTED plan's kind — derived_percentage blocks default tiers (D105) */
    planKind?: string | null;
    nights: number;
    accommodationSubtotal: number;
  },
): LosDiscountQuote | null {
  if (args.nights <= 0 || args.accommodationSubtotal <= 0) return null;
  const tiers = tiersForPlan(all, args.ratePlanId, args.planKind ?? null);
  const tier = selectTier(tiers, args.nights);
  if (!tier) return null;
  return applyTier(tier, {
    basis: args.accommodationSubtotal,
    nights: args.nights,
    scope: tier.pricingPlanId == null ? "tenant_default" : "rate_plan",
  });
}
