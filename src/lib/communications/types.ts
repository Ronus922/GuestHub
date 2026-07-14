export const COMMUNICATION_CHANNELS = ["email", "whatsapp"] as const;
export type CommunicationChannel = (typeof COMMUNICATION_CHANNELS)[number];

export const BOOKING_ORIGINS = [
  "back_office",
  "direct_website",
  "ota",
] as const;
export type BookingOrigin = (typeof BOOKING_ORIGINS)[number];

export const BLOCK_CONDITIONS = [
  "always",
  "balance_positive",
  "direct_reservation",
  "room_assigned",
  "guest_email_exists",
  "cancellation_policy_exists",
  "manage_url_exists",
] as const;
export type BlockCondition = (typeof BLOCK_CONDITIONS)[number];

export const TEMPLATE_BLOCK_TYPES = [
  "logo_header",
  "divider",
  "heading",
  "text",
  "cancellation_policy",
  "signature",
  "reservation_details",
  "room_details",
  "payment_summary",
  "balance",
  "property_address",
  "contact",
  "action_button",
] as const;
export type TemplateBlockType = (typeof TEMPLATE_BLOCK_TYPES)[number];

export type TemplateBlock = {
  id: string;
  type: TemplateBlockType;
  enabled: boolean;
  condition: BlockCondition;
  data: {
    text?: string;
    level?: 1 | 2 | 3;
    label?: string;
    urlVariable?: string;
    /** heading / text alignment. undefined = start (RTL: right). */
    align?: "start" | "center";
    /** reservation_details: show the check-in/check-out hours row. Default true. */
    showTimes?: boolean;
    /** reservation_details: show the nights row. Default true. */
    showNights?: boolean;
  };
};

export type StructuredTemplateContent = {
  schemaVersion: 1;
  blocks: TemplateBlock[];
};

export type TemplateVersionPolicy = "latest_published" | "locked";
export type AutomationStatus = "draft" | "active" | "disabled" | "needs_attention" | "archived";

export type CommunicationRenderContext = {
  bookingOrigin: BookingOrigin;
  values: Record<string, string | number | null | undefined>;
};

export type RenderIssue = {
  key: string;
  kind: "missing_required" | "missing_optional" | "unknown_variable" | "invalid_url";
};

export type RenderedCommunication = {
  html: string;
  plainText: string;
  issues: RenderIssue[];
  canSend: boolean;
};

export type PublishedTemplateVersion = {
  id: string;
  tenantId: string;
  templateId: string;
  versionNumber: number;
  senderDisplayName: string | null;
  replyToBehavior: "channel_default" | "custom" | "none";
  replyToAddress: string | null;
  subject: string;
  preheader: string | null;
  content: StructuredTemplateContent;
};
