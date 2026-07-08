import "server-only";
import type {
  WhatsAppProvider,
  WhatsAppMessage,
  WhatsAppTemplateMessage,
  TwilioConfig,
  TwilioSecrets,
  SendResult,
  TestResult,
  MessageStatus,
} from "../types";
import { normalizePhone } from "@/lib/phone";

const TWILIO_API = "https://api.twilio.com/2010-04-01";

// Map Twilio's message status → our canonical honest lifecycle.
export function mapTwilioStatus(s: string | undefined | null): MessageStatus {
  switch ((s ?? "").toLowerCase()) {
    case "queued":
    case "scheduled":
      return "queued";
    case "accepted":
      return "submitted";
    case "sending":
      return "submitting";
    case "sent":
      return "sent";
    case "delivered":
      return "delivered";
    case "read":
      return "read";
    case "undelivered":
      return "undelivered";
    case "failed":
      return "failed";
    default:
      return "submitted";
  }
}

function withWhatsApp(v: string): string {
  return v.startsWith("whatsapp:") ? v : `whatsapp:${v}`;
}

// Twilio WhatsApp adapter (D53). Basic-auth REST, no SDK. Account SID + Auth
// Token are the secret bag; the token is never logged or returned. sendMessage
// returns the Twilio SID (the external message id). Status callbacks flow to the
// webhook route and map through mapTwilioStatus().
export class TwilioWhatsAppProvider implements WhatsAppProvider {
  readonly id = "twilio" as const;
  constructor(private config: TwilioConfig, private secrets: TwilioSecrets) {}

  private authHeader(): string {
    return "Basic " + Buffer.from(`${this.secrets.accountSid}:${this.secrets.authToken}`).toString("base64");
  }

  private async post(form: Record<string, string>): Promise<SendResult> {
    try {
      const res = await fetch(`${TWILIO_API}/Accounts/${this.secrets.accountSid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: this.authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
      });
      const j = (await res.json().catch(() => ({}))) as {
        sid?: string; status?: string; error_code?: number | string; error_message?: string;
      };
      if (!res.ok) {
        return { status: "failed", providerMessageId: j.sid ?? null, errorCode: `twilio_${j.error_code ?? res.status}`, errorDetail: "שליחת ההודעה דרך Twilio נכשלה" };
      }
      return { status: mapTwilioStatus(j.status), providerMessageId: j.sid ?? null };
    } catch {
      return { status: "failed", providerMessageId: null, errorCode: "twilio_network", errorDetail: "שגיאת רשת מול Twilio" };
    }
  }

  private baseForm(to: string): Record<string, string> {
    const form: Record<string, string> = { To: withWhatsApp(to) };
    if (this.config.messagingServiceSid) form.MessagingServiceSid = this.config.messagingServiceSid;
    else form.From = withWhatsApp(this.config.fromNumber);
    if (this.config.statusCallbackUrl) form.StatusCallback = this.config.statusCallbackUrl;
    return form;
  }

  async sendMessage(msg: WhatsAppMessage): Promise<SendResult> {
    const n = normalizePhone(msg.to);
    if (!n.valid) return { status: "validation_failed", providerMessageId: null, errorDetail: "מספר טלפון לא תקין" };
    return this.post({ ...this.baseForm(n.e164), Body: msg.body });
  }

  // Approved WhatsApp content template (outside the 24h session window).
  async sendTemplateMessage(msg: WhatsAppTemplateMessage): Promise<SendResult> {
    const n = normalizePhone(msg.to);
    if (!n.valid) return { status: "validation_failed", providerMessageId: null, errorDetail: "מספר טלפון לא תקין" };
    return this.post({
      ...this.baseForm(n.e164),
      ContentSid: msg.templateId,
      ContentVariables: JSON.stringify(msg.variables ?? {}),
    });
  }

  async getMessageStatus(providerMessageId: string): Promise<MessageStatus> {
    try {
      const res = await fetch(`${TWILIO_API}/Accounts/${this.secrets.accountSid}/Messages/${providerMessageId}.json`, {
        headers: { Authorization: this.authHeader() },
      });
      if (!res.ok) return "submitted";
      const j = (await res.json()) as { status?: string };
      return mapTwilioStatus(j.status);
    } catch {
      return "submitted";
    }
  }

  async testConnection(): Promise<TestResult> {
    try {
      const res = await fetch(`${TWILIO_API}/Accounts/${this.secrets.accountSid}.json`, {
        headers: { Authorization: this.authHeader() },
      });
      if (!res.ok) return { ok: false, detail: "אימות מול Twilio נכשל — בדוק Account SID ו-Auth Token" };
      const j = (await res.json()) as { friendly_name?: string; status?: string };
      return { ok: true, detail: "החיבור ל-Twilio תקין", account: j.friendly_name ?? this.secrets.accountSid.slice(0, 6) + "…" };
    } catch {
      return { ok: false, detail: "שגיאת רשת מול Twilio" };
    }
  }
}
