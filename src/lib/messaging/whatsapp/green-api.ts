import "server-only";
import type { WhatsAppProvider, WhatsAppMessage, GreenApiConfig, GreenApiSecrets, SendResult, TestResult } from "../types";
import { normalizePhone } from "@/lib/phone";

// GREEN-API WhatsApp adapter (D53). REST, no SDK. The apiToken lives ONLY in the
// URL path and is never logged or returned. sendMessage → idMessage (the
// provider message id). Delivery/read status arrives via the webhook route, not
// polled here (green-api has no simple per-id status GET in the base API).
export class GreenApiWhatsAppProvider implements WhatsAppProvider {
  readonly id = "green_api" as const;
  private host: string;
  constructor(private config: GreenApiConfig, private secrets: GreenApiSecrets) {
    this.host = (config.apiHost || "https://api.green-api.com").replace(/\/+$/, "");
  }

  private base(method: string): string {
    return `${this.host}/waInstance${this.config.instanceId}/${method}/${this.secrets.apiToken}`;
  }

  async sendMessage(msg: WhatsAppMessage): Promise<SendResult> {
    const n = normalizePhone(msg.to);
    if (!n.valid) return { status: "validation_failed", providerMessageId: null, errorDetail: "מספר טלפון לא תקין" };
    try {
      const res = await fetch(this.base("sendMessage"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: `${n.digits}@c.us`, message: msg.body }),
      });
      if (!res.ok) {
        return { status: "failed", providerMessageId: null, errorCode: `green_${res.status}`, errorDetail: "שליחת ההודעה דרך GREEN-API נכשלה" };
      }
      const j = (await res.json()) as { idMessage?: string };
      // green-api accepted it; delivery confirmed later via webhook.
      return { status: "submitted", providerMessageId: j.idMessage ?? null };
    } catch {
      return { status: "failed", providerMessageId: null, errorCode: "green_network", errorDetail: "שגיאת רשת מול GREEN-API" };
    }
  }

  async testConnection(): Promise<TestResult> {
    try {
      const res = await fetch(this.base("getStateInstance"));
      if (!res.ok) return { ok: false, detail: "אימות מול GREEN-API נכשל — בדוק Instance ID ו-Token" };
      const j = (await res.json()) as { stateInstance?: string };
      if (j.stateInstance === "authorized") return { ok: true, detail: "המכשיר מחובר ומאומת", account: this.config.senderNumber ?? null };
      return { ok: false, detail: `המכשיר אינו מאומת (מצב: ${j.stateInstance ?? "לא ידוע"})` };
    } catch {
      return { ok: false, detail: "שגיאת רשת מול GREEN-API" };
    }
  }
}
