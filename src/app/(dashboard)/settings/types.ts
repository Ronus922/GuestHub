// Client-safe view types for the settings sections. The server service
// (src/lib/commercial/service.ts) returns objects structurally matching these;
// keeping the shapes here avoids importing the "server-only" module into client
// components.
import type { ExtraGuestDefaults } from "@/lib/commercial/extra-guest";
import type { CancellationTier } from "@/lib/commercial/cancellation";
import type { PaymentStage } from "@/lib/commercial/payment";

export type ExtraGuestView = ExtraGuestDefaults & { adult_min_age: number };

export type PaymentMethodRef = { key: string; label: string };

export type PolicyTranslations = Record<string, { public_title?: string; guest_description?: string }>;

export type CancellationPolicyView = {
  id: string;
  name: string;
  public_title: string;
  code: string;
  is_active: boolean;
  is_default: boolean;
  internal_notes: string | null;
  guest_description: string | null;
  translations: PolicyTranslations;
  distribution_scope: "direct_only" | "direct_and_channels" | "internal_only";
  timezone: string | null;
  checkin_time_basis: string | null;
  tiers: CancellationTier[];
};

export type PaymentPolicyView = {
  id: string;
  name: string;
  public_title: string;
  code: string;
  is_active: boolean;
  is_default: boolean;
  internal_notes: string | null;
  guest_description: string | null;
  translations: PolicyTranslations;
  stages: PaymentStage[];
};
