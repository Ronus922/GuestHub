// Extra-guest / occupancy pricing DEFAULTS (Commercial Settings §A). A per-tenant
// singleton stored in tenants.settings->'extra_guest' (same jsonb store as
// vat_rate) — NOT a table. Currency stays tenants.currency; tax follows
// tenants.settings->vat_rate. Pure so the Server Action, the settings UI, the
// resolver and the DB checks all share one definition. Money is 2-decimal; no
// floats persisted.
//
// FAKE-ZERO FIX: prices are NULLABLE and gated by an explicit `configured` flag,
// so "not configured" (null / configured=false) is distinct from a deliberate 0.
// A tenant is never silently given zero prices; the UI shows "טרם הוגדר" until an
// authorized user explicitly saves (0 is a valid explicit value).
//
// Concepts are kept deliberately separate (§A terminology): these are the DEFAULT
// extra-adult/child/infant amounts only. included_occupancy / min_booking /
// default / max occupancy are ROOM-level fields — see src/lib/commercial/room-pricing.ts.

export type ChargeFrequency = "per_night" | "per_stay";
export type TaxMode = "inclusive" | "canonical";
export type RoundingMode = "none" | "unit" | "increment";

export type ExtraGuestDefaults = {
  configured: boolean; // false until an authorized user explicitly saves the section
  extra_adult: number | null;
  extra_child: number | null;
  extra_infant: number | null;
  charge_frequency: ChargeFrequency;
  infant_max_age: number;
  child_max_age: number;
  infants_count_occupancy: boolean;
  infants_use_included: boolean;
  tax_mode: TaxMode;
  rounding_mode: RoundingMode;
  rounding_increment: number;
};

// The shape a tenant with no saved extra-guest settings reads as: UNCONFIGURED.
// Structural fields (ages / flags / rounding) carry sensible non-price defaults —
// they are policy choices, not invented prices; the PRICES stay null.
export const EXTRA_GUEST_UNCONFIGURED: ExtraGuestDefaults = {
  configured: false,
  extra_adult: null,
  extra_child: null,
  extra_infant: null,
  charge_frequency: "per_night",
  infant_max_age: 2,
  child_max_age: 12,
  infants_count_occupancy: false,
  infants_use_included: false,
  tax_mode: "inclusive",
  rounding_mode: "none",
  rounding_increment: 1,
};

const round2 = (n: number) => Math.round(n * 100) / 100;

// Adult minimum age is DERIVED from the child upper limit — never stored, so the
// two can never drift. A guest older than child_max_age is an adult.
export function adultMinAge(childMaxAge: number): number {
  return childMaxAge + 1;
}

// Rounds a computed money amount per the property rule (§A.12). Pure; used by the
// future server-side quote, not by settings storage.
export function roundMoney(value: number, mode: RoundingMode, increment: number): number {
  if (!Number.isFinite(value)) return 0;
  if (mode === "unit") return Math.round(value);
  if (mode === "increment") {
    const inc = increment > 0 ? increment : 1;
    return round2(Math.round(value / inc) * inc);
  }
  return round2(value);
}

// A valid explicit money amount: a non-negative number with ≤2 decimals. 0 is valid.
const isMoney = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && round2(v) === v;
const isAge = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 120;

// Validates a candidate defaults object. Returns Hebrew error messages (empty =
// valid). When `configured` is true every amount must be a valid explicit money
// value (0 allowed); when false the amounts are ignored (still "not configured").
export function validateExtraGuestDefaults(v: ExtraGuestDefaults): string[] {
  const errors: string[] = [];
  if (v.configured) {
    if (!isMoney(v.extra_adult)) errors.push("סכום אורח בוגר נוסף חייב להיות מספר אי-שלילי (עד שתי ספרות)");
    if (!isMoney(v.extra_child)) errors.push("סכום ילד נוסף חייב להיות מספר אי-שלילי (עד שתי ספרות)");
    if (!isMoney(v.extra_infant)) errors.push("סכום תינוק נוסף חייב להיות מספר אי-שלילי (עד שתי ספרות)");
  }
  if (v.charge_frequency !== "per_night" && v.charge_frequency !== "per_stay")
    errors.push("תדירות החיוב חייבת להיות ללילה או לשהות");
  if (!isAge(v.infant_max_age)) errors.push("גיל תינוק מרבי חייב להיות מספר שלם תקין");
  if (!isAge(v.child_max_age)) errors.push("גיל ילד מרבי חייב להיות מספר שלם תקין");
  if (isAge(v.infant_max_age) && isAge(v.child_max_age) && v.child_max_age <= v.infant_max_age)
    errors.push("גיל ילד מרבי חייב להיות גדול מגיל תינוק מרבי");
  if (v.tax_mode !== "inclusive" && v.tax_mode !== "canonical")
    errors.push("מצב המס אינו תקין");
  if (!["none", "unit", "increment"].includes(v.rounding_mode))
    errors.push("כלל העיגול אינו תקין");
  if (v.rounding_mode === "increment" && !(v.rounding_increment > 0))
    errors.push("מרווח עיגול חייב להיות גדול מאפס");
  return errors;
}

// Coerces stored jsonb (unknown shape) into a valid defaults object. Missing or
// invalid PRICES become null (unconfigured), never 0. `configured` is honoured
// only when explicitly true. Never throws — a reader helper.
export function normalizeExtraGuestDefaults(input: unknown): ExtraGuestDefaults {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const money = (k: keyof ExtraGuestDefaults): number | null =>
    typeof o[k] === "number" && Number.isFinite(o[k] as number) ? round2(o[k] as number) : null;
  const num = (k: keyof ExtraGuestDefaults, d: number) =>
    typeof o[k] === "number" && Number.isFinite(o[k] as number) ? (o[k] as number) : d;
  const bool = (k: keyof ExtraGuestDefaults, d: boolean) =>
    typeof o[k] === "boolean" ? (o[k] as boolean) : d;
  const one = <T extends string>(k: keyof ExtraGuestDefaults, allowed: readonly T[], d: T): T =>
    allowed.includes(o[k] as T) ? (o[k] as T) : d;
  return {
    configured: o.configured === true,
    extra_adult: money("extra_adult"),
    extra_child: money("extra_child"),
    extra_infant: money("extra_infant"),
    charge_frequency: one("charge_frequency", ["per_night", "per_stay"] as const, "per_night"),
    infant_max_age: num("infant_max_age", 2),
    child_max_age: num("child_max_age", 12),
    infants_count_occupancy: bool("infants_count_occupancy", false),
    infants_use_included: bool("infants_use_included", false),
    tax_mode: one("tax_mode", ["inclusive", "canonical"] as const, "inclusive"),
    rounding_mode: one("rounding_mode", ["none", "unit", "increment"] as const, "none"),
    rounding_increment: num("rounding_increment", 1),
  };
}

// True only when the property has explicit prices for all three categories.
export function isExtraGuestConfigured(d: ExtraGuestDefaults): boolean {
  return d.configured && d.extra_adult !== null && d.extra_child !== null && d.extra_infant !== null;
}
