import "server-only";
import type { Actor } from "@/lib/auth/actor";
import { writeAudit } from "@/lib/audit";
import { normalizePhone } from "@/lib/phone";
import { resolveEmailProvider, resolveWhatsAppProvider } from "./providers";
import { createOutboundMessage, applySendResult } from "./messages";
import type { MessageStatus } from "./types";

export type SendOutcome = {
  ok: boolean;
  status: MessageStatus;
  messageId: string | null;
  provider: string | null;
  detail?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Records an outbound row with a terminal pre-send status (validation_failed /
// provider_not_configured) — an honest audit trail even when nothing is sent.
async function recordTerminal(args: {
  actor: Actor; reservationId: string | null; guestId: string | null;
  channel: "email" | "whatsapp"; provider: string; templateId: string | null;
  to: string; subject: string | null; body: string; status: MessageStatus; detail: string;
}): Promise<SendOutcome> {
  const id = await createOutboundMessage({
    tenantId: args.actor.tenantId, reservationId: args.reservationId, guestId: args.guestId,
    channel: args.channel, provider: args.provider, templateId: args.templateId,
    toAddress: args.to, subject: args.subject, body: args.body, status: args.status,
    userId: args.actor.userId,
  });
  return { ok: false, status: args.status, messageId: id, provider: args.provider, detail: args.detail };
}

// ---- Email (Gmail) ----
export async function sendEmailMessage(
  actor: Actor,
  params: { reservationId: string | null; guestId: string | null; to: string; toName?: string | null; subject: string; body: string; html?: string | null; templateId: string | null },
): Promise<SendOutcome> {
  if (!EMAIL_RE.test(params.to.trim())) {
    return recordTerminal({ actor, ...params, channel: "email", provider: "gmail", subject: params.subject,
      status: "validation_failed", detail: "כתובת אימייל של האורח חסרה או אינה תקינה" });
  }
  const provider = await resolveEmailProvider(actor.tenantId);
  if (!provider) {
    return recordTerminal({ actor, ...params, channel: "email", provider: "gmail", subject: params.subject,
      status: "provider_not_configured", detail: "שירות Gmail טרם הוגדר. ניתן להגדירו במסך ההגדרות." });
  }
  const messageId = await createOutboundMessage({
    tenantId: actor.tenantId, reservationId: params.reservationId, guestId: params.guestId,
    channel: "email", provider: provider.id, templateId: params.templateId,
    toAddress: params.to.trim(), subject: params.subject, body: params.body, status: "submitting",
    userId: actor.userId,
  });
  const result = await provider.sendEmail({
    to: params.to.trim(),
    toName: params.toName ?? null,
    subject: params.subject,
    body: params.body,
    html: params.html ?? null,
  });
  await applySendResult(messageId, result);
  await writeAudit(actor, {
    entityType: "reservation", entityId: params.reservationId,
    action: result.status === "failed" ? "email_failed" : "email_sent",
    after: { channel: "email", provider: provider.id, status: result.status, to: params.to.trim(), providerMessageId: result.providerMessageId },
  });
  const ok = result.status !== "failed";
  return { ok, status: result.status, messageId, provider: provider.id,
    detail: ok ? undefined : result.errorDetail ?? "שליחת המייל נכשלה" };
}

// ---- WhatsApp (GREEN-API | Twilio via the active provider) ----
export async function sendWhatsAppMessage(
  actor: Actor,
  params: { reservationId: string | null; guestId: string | null; to: string; body: string; templateId: string | null },
): Promise<SendOutcome> {
  const n = normalizePhone(params.to);
  if (!n.valid) {
    return recordTerminal({ actor, ...params, channel: "whatsapp", provider: "whatsapp", subject: null,
      status: "validation_failed", detail: "מספר הטלפון של האורח חסר או אינו תקין" });
  }
  const resolved = await resolveWhatsAppProvider(actor.tenantId);
  if (!resolved) {
    return recordTerminal({ actor, ...params, channel: "whatsapp", provider: "whatsapp", subject: null,
      status: "provider_not_configured", detail: "ספק WhatsApp טרם הוגדר. ניתן לבחור GREEN-API או Twilio במסך ההגדרות." });
  }
  const messageId = await createOutboundMessage({
    tenantId: actor.tenantId, reservationId: params.reservationId, guestId: params.guestId,
    channel: "whatsapp", provider: resolved.id, templateId: params.templateId,
    toAddress: n.e164, subject: null, body: params.body, status: "submitting", userId: actor.userId,
  });
  const result = await resolved.provider.sendMessage({ to: n.e164, body: params.body });
  await applySendResult(messageId, result);
  await writeAudit(actor, {
    entityType: "reservation", entityId: params.reservationId,
    action: result.status === "failed" || result.status === "validation_failed" ? "whatsapp_failed" : "whatsapp_sent",
    after: { channel: "whatsapp", provider: resolved.id, status: result.status, to: n.e164, providerMessageId: result.providerMessageId },
  });
  const ok = result.status !== "failed" && result.status !== "validation_failed";
  return { ok, status: result.status, messageId, provider: resolved.id,
    detail: ok ? undefined : result.errorDetail ?? "שליחת הודעת ה-WhatsApp נכשלה" };
}
