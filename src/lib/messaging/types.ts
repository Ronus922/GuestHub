// Canonical messaging contracts (D53). The rest of the app depends on THESE
// interfaces — never directly on the Gmail API, GREEN-API or the Twilio SDK.
// The booking editor calls the messaging service; the service resolves the
// per-tenant provider adapter behind these interfaces.

// Honest outbound status lifecycle. "sent" is NEVER used merely because the
// provider accepted the request — that is "submitted". Delivery/read come only
// from real provider callbacks.
export type MessageStatus =
  | "draft"
  | "validation_failed"
  | "provider_not_configured"
  | "queued"
  | "submitting"
  | "submitted" // provider accepted for sending
  | "sent" // provider confirms it left the provider
  | "delivered"
  | "read"
  | "failed"
  | "undelivered";

export type MessageChannel = "email" | "whatsapp";

// The provider's own identifiers + resulting status for one submission.
export type SendResult = {
  status: MessageStatus; // typically "submitted" / "sent" on success, "failed" otherwise
  providerMessageId: string | null;
  providerThreadId?: string | null;
  errorCode?: string | null;
  errorDetail?: string | null; // Hebrew-safe, never contains a secret
};

// Result of a credential validation (does NOT send anything).
export type TestResult = {
  ok: boolean;
  // Hebrew-safe detail. Never a raw provider body / secret.
  detail: string;
  // provider-reported account identity when available (e.g. gmail address)
  account?: string | null;
};

// ---- Email (Gmail: OAuth API preferred, SMTP App Password fallback) ----
export type EmailMessage = {
  to: string;
  toName?: string | null;
  subject: string;
  body: string; // plain text (rendered to text/plain + minimal html)
  replyTo?: string | null;
};

export interface EmailProvider {
  readonly id: "gmail" | "gmail_smtp";
  sendEmail(msg: EmailMessage): Promise<SendResult>;
  testConnection(): Promise<TestResult>;
}

// ---- WhatsApp (GREEN-API | Twilio behind one interface) ----
export type WhatsAppMessage = {
  to: string; // E.164, no "+" stripping done here — adapters normalize as needed
  body: string;
};

// Approved-template send (Twilio content templates / provider template ids).
// Kept separate from the internal canonical booking template on purpose.
export type WhatsAppTemplateMessage = {
  to: string;
  templateId: string;
  variables: Record<string, string>;
};

export interface WhatsAppProvider {
  readonly id: "green_api" | "twilio";
  sendMessage(msg: WhatsAppMessage): Promise<SendResult>;
  sendTemplateMessage?(msg: WhatsAppTemplateMessage): Promise<SendResult>;
  getMessageStatus?(providerMessageId: string): Promise<MessageStatus>;
  testConnection(): Promise<TestResult>;
}

// Non-secret + secret config shapes per provider (secret bag is encrypted).
export type GmailConfig = {
  mode: "oauth" | "smtp";
  senderEmail: string;
  senderName?: string;
  replyTo?: string;
  // smtp mode only
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean; // TLS/SSL
};
export type GmailSecrets = {
  // oauth mode
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  // smtp mode
  appPassword?: string;
};

export type GreenApiConfig = {
  apiHost?: string; // default https://api.green-api.com
  instanceId: string;
  senderNumber?: string;
  // Opaque, server-generated webhook routing token (replaces the predictable
  // instanceId in the callback URL). Non-secret: it is shown in the copyable URL.
  webhookToken?: string;
};
export type GreenApiSecrets = {
  apiToken: string;
};

export type TwilioConfig = {
  fromNumber: string; // whatsapp:+... or bare E.164
  messagingServiceSid?: string;
  statusCallbackUrl?: string;
  // Opaque, server-generated routing token for the status-callback URL. NOT the
  // account SID and not a replacement for X-Twilio-Signature — a routing/obscurity
  // layer only. Non-secret: shown in the copyable URL.
  webhookToken?: string;
};
export type TwilioSecrets = {
  accountSid: string;
  authToken: string;
};

export const PROVIDER_IDS = ["gmail", "gmail_smtp", "green_api", "twilio"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type WhatsAppProviderId = "green_api" | "twilio" | "disabled";
