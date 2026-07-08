import "server-only";
import nodemailer from "nodemailer";
import type { EmailProvider, EmailMessage, GmailConfig, GmailSecrets, SendResult, TestResult } from "../types";

// Gmail email adapters (D53). Two modes behind ONE EmailProvider interface:
//   • GmailOAuthProvider  — Gmail REST API + OAuth 2.0 refresh token (PRODUCTION).
//                           No SDK: plain fetch to oauth2 + gmail.googleapis.com.
//   • GmailSmtpProvider   — SMTP with an App Password (optional fallback, nodemailer).
// Secrets arrive already-decrypted from the resolver; they are NEVER logged and
// NEVER placed in a returned errorDetail.

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

// RFC 2047 encoded-word for non-ASCII headers (Hebrew subject / display name).
function encodeHeader(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function buildRawMessage(from: string, fromName: string | undefined, msg: EmailMessage): string {
  const fromHeader = fromName ? `${encodeHeader(fromName)} <${from}>` : from;
  const toHeader = msg.toName ? `${encodeHeader(msg.toName)} <${msg.to}>` : msg.to;
  const headers = [
    `From: ${fromHeader}`,
    `To: ${toHeader}`,
    msg.replyTo ? `Reply-To: ${msg.replyTo}` : "",
    `Subject: ${encodeHeader(msg.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ].filter(Boolean);
  const body = Buffer.from(msg.body, "utf8").toString("base64");
  return headers.join("\r\n") + "\r\n\r\n" + body;
}

async function accessTokenFromRefresh(s: GmailSecrets): Promise<string> {
  if (!s.clientId || !s.clientSecret || !s.refreshToken) {
    throw new Error("gmail_oauth_incomplete");
  }
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: s.clientId,
      client_secret: s.clientSecret,
      refresh_token: s.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    // Google returns {error, error_description}; error code only, never secrets.
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`gmail_token_${j.error ?? res.status}`);
  }
  const j = (await res.json()) as { access_token?: string };
  if (!j.access_token) throw new Error("gmail_token_no_access");
  return j.access_token;
}

export class GmailOAuthProvider implements EmailProvider {
  readonly id = "gmail" as const;
  constructor(private config: GmailConfig, private secrets: GmailSecrets) {}

  async sendEmail(msg: EmailMessage): Promise<SendResult> {
    try {
      const token = await accessTokenFromRefresh(this.secrets);
      const raw = buildRawMessage(this.config.senderEmail, this.config.senderName, {
        ...msg,
        replyTo: msg.replyTo ?? this.config.replyTo ?? null,
      });
      const rawUrlSafe = Buffer.from(raw, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const res = await fetch(`${GMAIL_API}/messages/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw: rawUrlSafe }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        return { status: "failed", providerMessageId: null, errorCode: `gmail_${res.status}`, errorDetail: safeDetail(j.error?.message) };
      }
      const j = (await res.json()) as { id?: string; threadId?: string };
      // Gmail's messages.send actually SENDS (message appears in Sent). Honest
      // "sent" (left our account) — NOT "delivered" (no inbox-delivery proof).
      return { status: "sent", providerMessageId: j.id ?? null, providerThreadId: j.threadId ?? null };
    } catch (e) {
      return { status: "failed", providerMessageId: null, errorCode: codeOf(e), errorDetail: "שליחת המייל דרך Gmail נכשלה" };
    }
  }

  async testConnection(): Promise<TestResult> {
    try {
      const token = await accessTokenFromRefresh(this.secrets);
      const res = await fetch(`${GMAIL_API}/profile`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return { ok: false, detail: "אימות מול Gmail נכשל — בדוק את פרטי ה-OAuth" };
      const j = (await res.json()) as { emailAddress?: string };
      return { ok: true, detail: "החיבור ל-Gmail תקין", account: j.emailAddress ?? this.config.senderEmail };
    } catch {
      return { ok: false, detail: "אימות מול Gmail נכשל — בדוק את פרטי ה-OAuth" };
    }
  }
}

export class GmailSmtpProvider implements EmailProvider {
  readonly id = "gmail_smtp" as const;
  constructor(private config: GmailConfig, private secrets: GmailSecrets) {}

  private transport() {
    return nodemailer.createTransport({
      host: this.config.smtpHost || "smtp.gmail.com",
      port: this.config.smtpPort || 465,
      secure: this.config.smtpSecure ?? (this.config.smtpPort || 465) === 465,
      auth: { user: this.config.senderEmail, pass: this.secrets.appPassword || "" },
    });
  }

  async sendEmail(msg: EmailMessage): Promise<SendResult> {
    try {
      const info = await this.transport().sendMail({
        from: this.config.senderName ? `${this.config.senderName} <${this.config.senderEmail}>` : this.config.senderEmail,
        to: msg.toName ? `${msg.toName} <${msg.to}>` : msg.to,
        replyTo: msg.replyTo ?? this.config.replyTo ?? undefined,
        subject: msg.subject,
        text: msg.body,
      });
      return { status: "sent", providerMessageId: info.messageId ?? null };
    } catch (e) {
      return { status: "failed", providerMessageId: null, errorCode: codeOf(e), errorDetail: "שליחת המייל דרך SMTP נכשלה" };
    }
  }

  async testConnection(): Promise<TestResult> {
    try {
      await this.transport().verify();
      return { ok: true, detail: "החיבור ל-SMTP תקין", account: this.config.senderEmail };
    } catch {
      return { ok: false, detail: "אימות מול שרת ה-SMTP נכשל — בדוק כתובת, סיסמת אפליקציה ופורט" };
    }
  }
}

// A provider error message may echo an address but never a secret; still keep it
// short and generic to be safe.
function safeDetail(msg: string | undefined): string {
  if (!msg) return "שגיאת ספק";
  return msg.slice(0, 120);
}
function codeOf(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 60) : "unknown";
}
