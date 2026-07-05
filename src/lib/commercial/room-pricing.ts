// Room commercial domain (§5/§6/§8). PURE — no DB, no React. The server wrappers
// in service.ts load rows and call these; the Room UI mirrors the validators.
//
//  - resolveEffectivePricing: room override ↓ property default, PER category,
//    with the source of each value. Inheritance never copies property values into
//    room columns (that stays a read-time resolution).
//  - calculateChargeableGuests: deterministic included-place allocation + extra
//    charge, with capacity validation.
//  - validateRoomOccupancy: the capacity/occupancy rules, incl. impossible
//    category-limit combinations.

import type { ChargeFrequency, ExtraGuestDefaults } from "./extra-guest";

export type PricingSource = "room_override" | "property_default" | "unconfigured";
export type PricingMode = "inherit" | "override";

// Per-room override row (nullable fields; explicit 0 is a real override, null = inherit this field)
export type RoomExtraGuestOverride = {
  mode: PricingMode;
  extra_adult: number | null;
  extra_child: number | null;
  extra_infant: number | null;
  charge_frequency: ChargeFrequency | null;
};

export type EffectiveAmount = { value: number | null; source: PricingSource };

export type EffectiveExtraGuestPricing = {
  mode: PricingMode;
  extra_adult: EffectiveAmount;
  extra_child: EffectiveAmount;
  extra_infant: EffectiveAmount;
  charge_frequency: { value: ChargeFrequency; source: PricingSource };
  complete: boolean; // all three amounts resolved to a non-null value
  errors: string[];
  warnings: string[];
};

// Resolve one category with room→property precedence.
function resolveAmount(mode: PricingMode, roomVal: number | null, propVal: number | null): EffectiveAmount {
  if (mode === "override" && roomVal !== null) return { value: roomVal, source: "room_override" };
  if (propVal !== null) return { value: propVal, source: "property_default" };
  return { value: null, source: "unconfigured" };
}

// §5 canonical resolver core. `property` is the tenant extra-guest defaults;
// `override` is the room row. Returns effective values + the source of each.
export function resolveEffectivePricing(
  override: RoomExtraGuestOverride,
  property: ExtraGuestDefaults,
): EffectiveExtraGuestPricing {
  const mode = override.mode;
  const propConfigured = property.configured;
  const pAdult = propConfigured ? property.extra_adult : null;
  const pChild = propConfigured ? property.extra_child : null;
  const pInfant = propConfigured ? property.extra_infant : null;

  const extra_adult = resolveAmount(mode, override.extra_adult, pAdult);
  const extra_child = resolveAmount(mode, override.extra_child, pChild);
  const extra_infant = resolveAmount(mode, override.extra_infant, pInfant);

  const freqSource: PricingSource =
    mode === "override" && override.charge_frequency !== null ? "room_override" : "property_default";
  const charge_frequency = {
    value: (mode === "override" && override.charge_frequency) || property.charge_frequency,
    source: freqSource,
  };

  const complete = extra_adult.value !== null && extra_child.value !== null && extra_infant.value !== null;
  const warnings: string[] = [];
  const errors: string[] = [];
  if (!complete) {
    if (mode === "inherit" && !propConfigured)
      warnings.push("החדר יורש תמחור אורח נוסף מהנכס, אך הנכס טרם הוגדר — יש להגדיר בהגדרות הנכס או להגדיר חריגה לחדר");
    else warnings.push("תמחור אורח נוסף אינו מלא עבור חדר זה");
  }

  return { mode, extra_adult, extra_child, extra_infant, charge_frequency, complete, errors, warnings };
}

// ---- §6 chargeable-guest calculation ----

export type ChargeableInput = {
  adults: number;
  children: number;
  infants: number;
  includedOccupancy: number;
  maxAdults: number;
  maxChildren: number;
  maxInfants: number;
  maxOccupancy: number;
  infantsCountOccupancy: boolean;
  infantsUseIncluded: boolean;
  pricing: { adult: number; child: number; infant: number; frequency: ChargeFrequency };
};

export type ChargeableResult = {
  valid: boolean;
  errors: string[];
  includedAdults: number;
  includedChildren: number;
  includedInfants: number;
  extraAdults: number;
  extraChildren: number;
  extraInfants: number;
  chargeAdults: number;
  chargeChildren: number;
  chargeInfants: number;
  totalExtra: number; // per `frequency`
  frequency: ChargeFrequency;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

// Deterministic included-place allocation: adults, then children, then infants
// (only when infants consume included occupancy). Extra guests beyond the
// included places are charged the effective category amount.
export function calculateChargeableGuests(i: ChargeableInput): ChargeableResult {
  const errors: string[] = [];
  if (i.adults < 1) errors.push("נדרש לפחות מבוגר אחד");
  if (i.adults > i.maxAdults) errors.push(`מספר המבוגרים חורג מהמותר (${i.maxAdults})`);
  if (i.children > i.maxChildren) errors.push(`מספר הילדים חורג מהמותר (${i.maxChildren})`);
  if (i.infants > i.maxInfants) errors.push(`מספר התינוקות חורג מהמותר (${i.maxInfants})`);
  if (i.includedOccupancy < 1) errors.push("מספר האורחים הכלולים במחיר הבסיס חייב להיות לפחות 1");
  if (i.includedOccupancy > i.maxOccupancy) errors.push("האורחים הכלולים במחיר עולים על התפוסה המקסימלית");
  const occupancy = i.adults + i.children + (i.infantsCountOccupancy ? i.infants : 0);
  if (occupancy > i.maxOccupancy) errors.push(`סך האורחים (${occupancy}) חורג מהתפוסה המקסימלית (${i.maxOccupancy})`);

  let remaining = Math.max(0, i.includedOccupancy);
  const includedAdults = Math.min(i.adults, remaining);
  remaining -= includedAdults;
  const includedChildren = Math.min(i.children, remaining);
  remaining -= includedChildren;
  const includedInfants = i.infantsUseIncluded ? Math.min(i.infants, remaining) : 0;

  const extraAdults = i.adults - includedAdults;
  const extraChildren = i.children - includedChildren;
  const extraInfants = i.infantsUseIncluded ? i.infants - includedInfants : i.infants;

  const chargeAdults = round2(extraAdults * i.pricing.adult);
  const chargeChildren = round2(extraChildren * i.pricing.child);
  const chargeInfants = round2(extraInfants * i.pricing.infant);
  const totalExtra = round2(chargeAdults + chargeChildren + chargeInfants);

  return {
    valid: errors.length === 0,
    errors,
    includedAdults, includedChildren, includedInfants,
    extraAdults, extraChildren, extraInfants,
    chargeAdults, chargeChildren, chargeInfants,
    totalExtra,
    frequency: i.pricing.frequency,
  };
}

// ---- §8 room occupancy/capacity validation (server + mirrored in UI) ----

export type RoomOccupancyDraft = {
  maxOccupancy: number;
  maxAdults: number;
  maxChildren: number;
  maxInfants: number;
  defaultOccupancy: number | null;
  includedOccupancy: number | null;
  minOccupancy?: number | null; // rooms.min_occupancy (D49 §5)
  minBookingOccupancy?: number | null;
  mode: PricingMode;
  extra_adult: number | null;
  extra_child: number | null;
  extra_infant: number | null;
  published: boolean; // commercially bookable / website-visible
  propertyConfigured: boolean; // property extra-guest configured
};

export function validateRoomOccupancy(r: RoomOccupancyDraft): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const max = r.maxOccupancy;

  if (r.maxOccupancy < 1) errors.push("תפוסה מקסימלית חייבת להיות לפחות 1");
  if (r.maxAdults > max) errors.push("מקסימום מבוגרים חורג מהתפוסה המקסימלית");
  if (r.maxChildren > max) errors.push("מקסימום ילדים חורג מהתפוסה המקסימלית");

  if (r.includedOccupancy !== null) {
    if (r.includedOccupancy < 1) errors.push("אורחים הכלולים במחיר הבסיס חייבים להיות לפחות 1");
    if (r.includedOccupancy > max) errors.push("אורחים הכלולים במחיר הבסיס חורגים מהתפוסה המקסימלית");
  }
  if (r.defaultOccupancy !== null && r.defaultOccupancy > max) errors.push("תפוסת ברירת מחדל חורגת מהתפוסה המקסימלית");
  if (r.minBookingOccupancy != null && r.minBookingOccupancy > max)
    errors.push("תפוסת הזמנה מינימלית חורגת מהתפוסה המקסימלית");

  // min_occupancy (D49 §5): 1 ≤ min ≤ max, default not below min
  if (r.minOccupancy != null) {
    if (r.minOccupancy < 1) errors.push("תפוסה מינימלית חייבת להיות לפחות 1");
    if (r.minOccupancy > max) errors.push("תפוסה מינימלית חורגת מהתפוסה המקסימלית");
    if (r.defaultOccupancy !== null && r.defaultOccupancy < r.minOccupancy)
      errors.push("תפוסת ברירת מחדל נמוכה מהתפוסה המינימלית");
  }

  // impossible capacity: the sum of category limits cannot reach max_occupancy
  const categorySum = r.maxAdults + r.maxChildren + r.maxInfants;
  if (categorySum < max)
    errors.push(`הצהרת תפוסה בלתי אפשרית: תפוסה מקסימלית ${max} אך מגבלות הקטגוריות מאפשרות רק ${categorySum} אורחים`);

  // monetary overrides non-negative
  for (const [v, label] of [[r.extra_adult, "מבוגר"], [r.extra_child, "ילד"], [r.extra_infant, "תינוק"]] as const)
    if (v !== null && v < 0) errors.push(`חריגת מחיר ${label} לא יכולה להיות שלילית`);

  // published room must have complete capacity + resolvable pricing
  if (r.published) {
    if (r.includedOccupancy === null)
      errors.push("חדר המפורסם למכירה חייב להגדיר אורחים הכלולים במחיר הבסיס");
    const overrideComplete = r.extra_adult !== null && r.extra_child !== null && r.extra_infant !== null;
    if (r.mode === "inherit" && !r.propertyConfigured)
      errors.push("החדר יורש תמחור מהנכס אך תמחור אורח נוסף בנכס טרם הוגדר");
    if (r.mode === "override" && !overrideComplete && !r.propertyConfigured)
      errors.push("חריגת התמחור של החדר אינה מלאה ותמחור הנכס טרם הוגדר");
  } else if (r.includedOccupancy === null) {
    warnings.push("החדר דורש השלמה: אורחים הכלולים במחיר הבסיס טרם הוגדרו");
  }

  return { errors, warnings };
}
