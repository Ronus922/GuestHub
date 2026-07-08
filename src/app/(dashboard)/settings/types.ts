// Client-safe view types for the settings sections. The server service
// (src/lib/commercial/service.ts) returns objects structurally matching these;
// keeping the shapes here avoids importing the "server-only" module into client
// components.
import type { ExtraGuestDefaults } from "@/lib/commercial/extra-guest";
import type { CancellationTier } from "@/lib/commercial/cancellation";
import type { PaymentStage } from "@/lib/commercial/payment";
import type { WhatsAppProviderId } from "@/lib/messaging/types";

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

// ---- messaging (D53): client-safe, masked view of provider connections ----
// NEVER carries a raw secret — only a boolean + "••••••••XXXX" hint per field.
type MaskedProviderView = {
  configured: boolean;
  status: string; // connected | not_configured | error
  statusDetail: string | null;
  lastTestedAt: string | null;
  secretHints: Record<string, string>;
};

export type GmailSettingsView = MaskedProviderView & {
  mode: "oauth" | "smtp";
  senderEmail: string;
  senderName: string;
  replyTo: string;
  smtpHost: string;
  smtpPort: number | null;
  smtpSecure: boolean;
};

export type GreenApiSettingsView = MaskedProviderView & {
  apiHost: string;
  instanceId: string;
  senderNumber: string;
  // Opaque server-generated webhook token (non-secret; shown in the copyable URL).
  webhookToken: string;
};

export type TwilioSettingsView = MaskedProviderView & {
  fromNumber: string;
  messagingServiceSid: string;
  statusCallbackUrl: string;
  // Opaque server-generated webhook token (non-secret; shown in the copyable URL).
  webhookToken: string;
};

export type MessagingSettingsView = {
  secretsKeyConfigured: boolean;
  gmail: GmailSettingsView;
  greenApi: GreenApiSettingsView;
  twilio: TwilioSettingsView;
  activeWhatsApp: WhatsAppProviderId;
  webhookBaseUrl: string;
};
