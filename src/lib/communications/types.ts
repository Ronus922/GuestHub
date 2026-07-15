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
    /** action_button: quick-pick URL variable (e.g. reservation.manage_url). */
    urlVariable?: string;
    /** action_button: free destination — a fixed https URL or a {{variable}}. Wins over urlVariable. */
    url?: string;
    /** heading / text / button alignment. undefined = start (RTL: right). */
    align?: "start" | "center" | "end";
    // ---- text / heading typography (keys resolved in lib/communications/styles.ts) ----
    fontSize?: "sm" | "base" | "md" | "lg" | "xl" | "xxl";
    fontWeight?: "normal" | "medium" | "semibold" | "bold" | "black";
    lineHeight?: "tight" | "snug" | "normal" | "loose";
    textColor?: "ink" | "muted" | "brand" | "brandDark" | "ok" | "danger";
    background?: "none" | "subtle" | "brandSoft" | "brand";
    padding?: "none" | "sm" | "md" | "lg";
    // ---- action_button appearance ----
    buttonWidth?: "auto" | "full";
    buttonRadius?: "md" | "lg" | "pill";
    buttonBg?: "brand" | "ink" | "ok";
    buttonText?: "white" | "ink";
    /** reservation_details: show the check-in/check-out hours row. Default true. */
    showTimes?: boolean;
    /** reservation_details: show the nights row. Default true. */
    showNights?: boolean;
    /** reservation_details: show the guests-composition row. Default false. */
    showGuests?: boolean;
    /** reservation_details: show the booking source row. Default false. */
    showSource?: boolean;
    /** reservation_details: show the created-at row. Default false. */
    showCreatedAt?: boolean;
    /** payment_summary: per-row visibility. Default true for total/paid/balance. */
    showTotal?: boolean;
    showPaid?: boolean;
    showBalance?: boolean;
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
