"use server";

import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { normalizePhone } from "@/lib/phone";
import {
  resolveBookingVariables,
  summarizeRooms,
  CANONICAL_VARIABLES,
  type BookingMessageContext,
} from "@/lib/messaging/templates";
import { renderManualText } from "@/lib/messaging/render-manual";
import { sendEmailMessage, sendWhatsAppMessage } from "@/lib/messaging/service";
import { resolveEmailProvider, resolveWhatsAppProvider } from "@/lib/messaging/providers";
import { getReservationAction } from "./actions";
import { getPublicPropertyName } from "@/lib/business/store";
import {
  composePublishedTemplate, reservationSendContext, type ComposedTemplate,
} from "@/lib/communications/automation";
import type { CommunicationRenderContext } from "@/lib/communications/types";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";

// Booking editor messaging actions (D53). The composer NEVER trusts a second
// copy of the booking: every send re-loads the canonical saved reservation
// server-side (getReservationAction) and resolves template variables from THAT,
// so unsaved edits can't leak into a sent message.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const fail = (error: string): ActionResult<never> => ({ success: false, error });
function errorMessage(e: unknown): string {
  if (e instanceof AuthorizationError) return e.message;
  console.error("[messaging]", e);
  return "אירעה שגיאה בלתי צפויה";
}

/**
 * A template as the composer's template mode shows it (D202): the PUBLISHED
 * version, already rendered for this reservation — read-only, because what is
 * shown is exactly what is sent and recorded. Never the draft.
 */
export type ComposerTemplate = {
  id: string;
  name: string;
  status: ComposedTemplate["status"];
  /** why it cannot be sent (Hebrew), null when ready */
  detail: string | null;
  subject: string | null;
  /** WhatsApp: the message; email: the plain-text part */
  text: string;
  html: string | null;
};

// The render context the communications renderer needs (property profile +
// stay schedule). A failure to assemble it must not break the composer — it
// becomes null, and the send path refuses with a named reason (never a raw token).
const RENDER_CONTEXT_UNAVAILABLE = "לא ניתן להרכיב את נתוני ההודעה (פרופיל העסק או לוח השעות). נסה שוב או פנה למנהל.";
const refuse = (detail: string): ActionResult<SendActionResult> =>
  ({ success: true, data: { ok: false, status: "validation_failed", detail } });

async function safeSendContext(
  tenantId: string,
  reservationId: string,
): Promise<{ context: CommunicationRenderContext; guestLanguage: string | null } | null> {
  try {
    return await reservationSendContext(tenantId, reservationId);
  } catch (e) {
    console.error("[messaging] render context failed", e instanceof Error ? e.message : e);
    return null;
  }
}

export type ComposerContext = {
  reservationId: string;
  guestName: string;
  /** the booking context the composer's header + recipient card show (D178) —
   *  already resolved by buildContext, so exposing it costs no extra query */
  reservationNumber: string;
  roomNumbers: string;
  checkIn: string | null;
  checkOut: string | null;
  sourceLabel: string | null;
  email: string | null;
  emailValid: boolean;
  phone: string | null;
  phoneE164: string | null;
  phoneValid: boolean;
  variables: Record<string, string>;
  variableDefs: { key: string; label: string }[];
  /** The communications render context of this reservation (D172) — null when it
   *  cannot be assembled; the send then refuses instead of shipping a raw token. */
  renderContext: CommunicationRenderContext | null;
  templates: { email: ComposerTemplate[]; whatsapp: ComposerTemplate[] };
  gmailConfigured: boolean;
  whatsappConfigured: boolean;
};

async function buildContext(reservationId: string): Promise<{ ctx: BookingMessageContext; guestName: string; email: string | null; phone: string | null; guestId: string | null } | null> {
  const actor = await getActor();
  requirePermission(actor, "reservations.view");
  const res = await getReservationAction(reservationId);
  if (!res.success || !res.data) return null;
  const d = res.data;
  const rooms = summarizeRooms(d.rooms);
  const [statusRow] = await sql<{ label: string | null }[]>`
    SELECT label FROM guesthub.lookup_items
    WHERE tenant_id = ${actor.tenantId} AND category = 'reservation_statuses' AND key = ${d.status}`;
  const ctx: BookingMessageContext = {
    reservationNumber: d.reservation_number,
    statusLabel: statusRow?.label ?? d.status,
    sourceLabel: d.source_label,
    guestFirstName: d.guest.first_name,
    guestLastName: d.guest.last_name,
    checkIn: rooms.checkIn,
    checkOut: rooms.checkOut,
    nights: rooms.nights,
    roomNumbers: rooms.roomNumbers,
    roomTypes: rooms.roomTypes,
    adults: rooms.adults,
    children: rooms.children,
    infants: rooms.infants,
    totalPrice: d.total_price,
    balanceDue: d.balance,
    propertyName: await getPublicPropertyName(actor.tenantId, actor.tenantName),
  };
  return { ctx, guestName: `${d.guest.first_name} ${d.guest.last_name}`.trim(), email: d.guest.email, phone: d.guest.phone, guestId: d.guest.id };
}

// Loads everything the composer needs in one round-trip: canonical recipient,
// resolved variables (for live preview client-side) and channel-filtered
// templates. No secrets, no second booking source.
export async function getMessagingContextAction(reservationId: string): Promise<ActionResult<ComposerContext>> {
  try {
    const built = await buildContext(reservationId);
    if (!built) return fail("הזמנה לא נמצאה");
    const actor = await getActor();
    requirePermission(actor, "reservations.view");

    const rows = await sql<{ id: string; channel: "email" | "whatsapp"; name: string }[]>`
      SELECT id, channel, name
      FROM guesthub.message_templates
      WHERE tenant_id = ${actor.tenantId} AND is_active = true
        AND archived_at IS NULL AND lifecycle_state <> 'archived'
      ORDER BY channel, name`;
    const sendCtx = await safeSendContext(actor.tenantId, reservationId);
    const composed = await Promise.all(rows.map(async (r): Promise<ComposerTemplate> => {
      const c: ComposedTemplate = sendCtx
        ? await composePublishedTemplate({
            tenantId: actor.tenantId, templateId: r.id, channel: r.channel,
            guestLanguage: sendCtx.guestLanguage, context: sendCtx.context,
          })
        : { status: "render_failed", detail: RENDER_CONTEXT_UNAVAILABLE };
      const base = { id: r.id, name: r.name };
      if (c.status !== "ready") return { ...base, status: c.status, detail: c.detail, subject: null, text: "", html: null };
      return c.channel === "email"
        ? { ...base, status: "ready", detail: null, subject: c.subject, text: c.plainText, html: c.html }
        : { ...base, status: "ready", detail: null, subject: null, text: c.text, html: null };
    }));
    const email = composed.filter((_, i) => rows[i].channel === "email");
    const whatsapp = composed.filter((_, i) => rows[i].channel === "whatsapp");

    const [gmail, wa] = await Promise.all([
      resolveEmailProvider(actor.tenantId),
      resolveWhatsAppProvider(actor.tenantId),
    ]);
    const n = normalizePhone(built.phone);
    return {
      success: true,
      data: {
        reservationId,
        guestName: built.guestName,
        reservationNumber: built.ctx.reservationNumber,
        roomNumbers: built.ctx.roomNumbers,
        checkIn: built.ctx.checkIn,
        checkOut: built.ctx.checkOut,
        sourceLabel: built.ctx.sourceLabel,
        email: built.email,
        emailValid: !!built.email && EMAIL_RE.test(built.email.trim()),
        phone: built.phone,
        phoneE164: n.valid ? n.e164 : null,
        phoneValid: n.valid,
        variables: resolveBookingVariables(built.ctx),
        variableDefs: CANONICAL_VARIABLES,
        renderContext: sendCtx?.context ?? null,
        templates: { email, whatsapp },
        gmailConfigured: gmail !== null,
        whatsappConfigured: wa !== null,
      },
    };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

/**
 * D202 — template mode re-resolves the published version HERE. The client's
 * subject/body are never read for it (the panel is read-only, but a request is
 * not the panel): it sends what composePublishedTemplate renders, and the row
 * records the template AND version that produced it.
 */
async function composeForSend(
  tenantId: string,
  reservationId: string,
  templateId: string,
  channel: "email" | "whatsapp",
): Promise<{ ready: Extract<ComposedTemplate, { status: "ready" }> } | { refused: string }> {
  const sendCtx = await safeSendContext(tenantId, reservationId);
  if (!sendCtx) return { refused: RENDER_CONTEXT_UNAVAILABLE };
  const composed = await composePublishedTemplate({
    tenantId, templateId, channel, guestLanguage: sendCtx.guestLanguage, context: sendCtx.context,
  });
  return composed.status === "ready" ? { ready: composed } : { refused: composed.detail };
}

export type SendActionResult = { ok: boolean; status: string; detail?: string };

export async function sendBookingEmailAction(
  reservationId: string,
  input: { templateId: string | null; subject: string; body: string },
): Promise<ActionResult<SendActionResult>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.edit");
    const built = await buildContext(reservationId);
    if (!built) return fail("הזמנה לא נמצאה");
    if (!built.email || !EMAIL_RE.test(built.email.trim())) {
      return { success: true, data: { ok: false, status: "validation_failed", detail: "לאורח אין כתובת אימייל תקינה. עדכן אותה בפרטי האורח לפני השליחה." } };
    }
    if (input.templateId) {
      const result = await composeForSend(actor.tenantId, reservationId, input.templateId, "email");
      if ("refused" in result) return refuse(result.refused);
      const t = result.ready;
      if (t.channel !== "email") return refuse("התבנית אינה תואמת לערוץ");
      const outcome = await sendEmailMessage(actor, {
        reservationId, guestId: built.guestId, to: built.email.trim(), toName: built.guestName,
        subject: t.subject, body: t.plainText, html: t.html, fromName: t.senderName, replyTo: t.replyTo,
        templateId: t.templateId, templateVersionId: t.versionId,
      });
      return { success: true, data: { ok: outcome.ok, status: outcome.status, detail: outcome.detail } };
    }
    // Free text — subject AND body (D172, addendum 2026-09-05): legacy
    // {{snake_case}} vars, then the communications renderer for {{group.key}}
    // tokens. An unknown token never ships literally: the send is refused and
    // names the variable.
    const vars = resolveBookingVariables(built.ctx);
    const renderContext = (await safeSendContext(actor.tenantId, reservationId))?.context;
    if (!renderContext) return refuse(RENDER_CONTEXT_UNAVAILABLE);
    const renderedSubject = renderManualText(input.subject, vars, renderContext);
    if (!renderedSubject.canSend) {
      return refuse(`הנושא מכיל משתנה שלא ניתן לשלוח — ${renderedSubject.detail ?? "משתנה לא מוכר"}`);
    }
    const renderedBody = renderManualText(input.body, vars, renderContext);
    if (!renderedBody.canSend) {
      return refuse(`תוכן ההודעה מכיל משתנה שלא ניתן לשלוח — ${renderedBody.detail ?? "משתנה לא מוכר"}`);
    }
    const subject = renderedSubject.value;
    const body = renderedBody.value;
    if (!body.trim()) return fail("תוכן ההודעה ריק");
    const outcome = await sendEmailMessage(actor, {
      reservationId, guestId: built.guestId, to: built.email.trim(), toName: built.guestName,
      subject: subject || `הזמנה #${built.ctx.reservationNumber}`, body, templateId: null,
    });
    return { success: true, data: { ok: outcome.ok, status: outcome.status, detail: outcome.detail } };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

export async function sendBookingWhatsAppAction(
  reservationId: string,
  input: { templateId: string | null; body: string },
): Promise<ActionResult<SendActionResult>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.edit");
    const built = await buildContext(reservationId);
    if (!built) return fail("הזמנה לא נמצאה");
    const n = normalizePhone(built.phone);
    if (!n.valid) {
      return { success: true, data: { ok: false, status: "validation_failed", detail: "לאורח אין מספר טלפון תקין. עדכן אותו בפרטי האורח לפני השליחה." } };
    }
    if (input.templateId) {
      const result = await composeForSend(actor.tenantId, reservationId, input.templateId, "whatsapp");
      if ("refused" in result) return refuse(result.refused);
      const t = result.ready;
      if (t.channel !== "whatsapp") return refuse("התבנית אינה תואמת לערוץ");
      const outcome = await sendWhatsAppMessage(actor, {
        reservationId, guestId: built.guestId, to: n.e164, body: t.text,
        templateId: t.templateId, templateVersionId: t.versionId,
      });
      return { success: true, data: { ok: outcome.ok, status: outcome.status, detail: outcome.detail } };
    }
    // Free text (D172 addendum 2026-09-05): the same chain as the email subject
    // and body. Text copied from a template ("העתק לכתיבה חופשית") is free text
    // from here on — it carries no template id and no version (D202).
    const vars = resolveBookingVariables(built.ctx);
    const renderContext = (await safeSendContext(actor.tenantId, reservationId))?.context;
    if (!renderContext) return refuse(RENDER_CONTEXT_UNAVAILABLE);
    const renderedBody = renderManualText(input.body, vars, renderContext);
    if (!renderedBody.canSend) {
      return refuse(`תוכן ההודעה מכיל משתנה שלא ניתן לשלוח — ${renderedBody.detail ?? "משתנה לא מוכר"}`);
    }
    const body = renderedBody.value;
    if (!body.trim()) return fail("תוכן ההודעה ריק");
    const outcome = await sendWhatsAppMessage(actor, {
      reservationId, guestId: built.guestId, to: n.e164, body, templateId: null,
    });
    return { success: true, data: { ok: outcome.ok, status: outcome.status, detail: outcome.detail } };
  } catch (e) {
    return fail(errorMessage(e));
  }
}
