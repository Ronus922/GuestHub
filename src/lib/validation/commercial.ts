import { z } from "zod";

// Zod schemas for the commercial-settings Server Actions (§D/§H). Client forms are
// cosmetic; every mutation parses through these, then the pure validators in
// src/lib/commercial/* enforce cross-row rules (overlap, coverage, schedule).

const money = z.number().min(0).max(1_000_000);
const percent = z.number().min(0).max(100);
const code = z.string().trim().min(1).max(60).regex(/^[a-z0-9_-]+$/i, "קוד חייב להכיל אותיות/ספרות/מקף בלבד");
const shortText = z.string().trim().min(1).max(120);
const longText = z.string().trim().max(2000);
const translations = z
  .record(z.string(), z.object({ public_title: z.string().max(120).optional(), guest_description: z.string().max(2000).optional() }))
  .default({});

// ---- §A extra-guest defaults ----
// Amounts are nullable (null = not configured); `configured` gates whether they
// are required. The pure validateExtraGuestDefaults enforces presence when
// configured (0 allowed). Never coerce a missing price to 0.
export const extraGuestSchema = z.object({
  configured: z.boolean(),
  extra_adult: money.nullable(),
  extra_child: money.nullable(),
  extra_infant: money.nullable(),
  charge_frequency: z.enum(["per_night", "per_stay"]),
  infant_max_age: z.number().int().min(0).max(120),
  child_max_age: z.number().int().min(0).max(120),
  infants_count_occupancy: z.boolean(),
  infants_use_included: z.boolean(),
  tax_mode: z.enum(["inclusive", "canonical"]),
  rounding_mode: z.enum(["none", "unit", "increment"]),
  rounding_increment: z.number().min(0).max(1000),
});
export type ExtraGuestInput = z.infer<typeof extraGuestSchema>;

// ---- §B cancellation policy + tiers ----
export const cancellationTierSchema = z.object({
  trigger_type: z.enum(["before_checkin", "no_show", "after_checkin", "early_departure", "partial_cancellation"]),
  time_unit: z.enum(["hours", "days"]).nullable(),
  time_from: z.number().int().min(0).max(100000).nullable(),
  time_to: z.number().int().min(0).max(100000).nullable(),
  fee_type: z.enum(["free", "fixed", "percentage", "first_night", "nights", "full", "percentage_remaining", "higher_of", "lower_of"]),
  fee_amount: money,
  fee_percent: percent,
  fee_nights: z.number().int().min(0).max(3650),
  calc_base: z.enum(["accommodation", "accommodation_plus_mandatory", "total_incl_tax", "unpaid_balance", "remaining_nights"]),
});

export const cancellationPolicySchema = z.object({
  id: z.uuid().optional(), // absent = create
  name: shortText,
  public_title: shortText,
  code,
  is_active: z.boolean(),
  is_default: z.boolean(),
  internal_notes: longText.optional().nullable(),
  guest_description: longText.optional().nullable(),
  translations,
  distribution_scope: z.enum(["direct_only", "direct_and_channels", "internal_only"]),
  timezone: z.string().max(64).nullable().optional(),
  checkin_time_basis: z.string().regex(/^\d{2}:\d{2}$/, "שעה לא תקינה").nullable().optional(),
  tiers: z.array(cancellationTierSchema).min(1, "נדרש שלב אחד לפחות").max(50),
});
export type CancellationPolicyInput = z.infer<typeof cancellationPolicySchema>;

// ---- §C payment policy + stages ----
export const paymentStageSchema = z.object({
  trigger_type: z.enum(["booking", "before_checkin", "checkin", "checkout"]),
  trigger_offset_unit: z.enum(["hours", "days"]).nullable(),
  trigger_offset_value: z.number().int().min(0).max(100000).nullable(),
  amount_type: z.enum(["fixed", "percentage", "remaining_balance", "full_balance"]),
  amount_value: money,
  amount_percent: percent,
  methods: z.array(z.string().max(60)).max(20),
  require_card_guarantee: z.boolean(),
  retry_behavior: z.enum(["manual", "retry_then_cancel", "retry_then_notify"]),
  staff_instructions: longText.optional().nullable(),
  guest_text: longText.optional().nullable(),
});

// ---- §3/§7 room occupancy + extra-guest override ----
const occ = z.number().int().min(1).max(50);
export const roomOccupancySchema = z.object({
  id: z.uuid(),
  max_occupancy: occ,
  max_adults: z.number().int().min(0).max(50),
  max_children: z.number().int().min(0).max(50),
  max_infants: z.number().int().min(0).max(50),
  default_occupancy: occ.nullable(),
  included_occupancy: occ.nullable(),
  extra_guest_pricing_mode: z.enum(["inherit", "override"]),
  extra_adult_override: money.nullable(),
  extra_child_override: money.nullable(),
  extra_infant_override: money.nullable(),
  charge_frequency_override: z.enum(["per_night", "per_stay"]).nullable(),
});
export type RoomOccupancyInput = z.infer<typeof roomOccupancySchema>;

export const paymentPolicySchema = z.object({
  id: z.uuid().optional(),
  name: shortText,
  public_title: shortText,
  code,
  is_active: z.boolean(),
  is_default: z.boolean(),
  internal_notes: longText.optional().nullable(),
  guest_description: longText.optional().nullable(),
  translations,
  stages: z.array(paymentStageSchema).min(1, "נדרש שלב אחד לפחות").max(50),
});
export type PaymentPolicyInput = z.infer<typeof paymentPolicySchema>;
