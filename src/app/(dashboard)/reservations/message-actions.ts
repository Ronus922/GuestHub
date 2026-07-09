"use server";

import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { normalizePhone } from "@/lib/phone";
import {
  resolveBookingVariables,
  renderTemplate,
  summarizeRooms,
  CANONICAL_VARIABLES,
  type BookingMessageContext,
} from "@/lib/messaging/templates";
import { sendEmailMessage, sendWhatsAppMessage } from "@/lib/messaging/service";
import { resolveEmailProvider, resolveWhatsAppProvider } from "@/lib/messaging/providers";
import { getReservationAction } from "./actions";
import { getPublicPropertyName } from "@/lib/business/store";
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

type TemplateLite = { id: string; slug: string; name: string; subject: string | null; body: string };

export type ComposerContext = {
  reservationId: string;
  guestName: string;
  email: string | null;
  emailValid: boolean;
  phone: string | null;
  phoneE164: string | null;
  phoneValid: boolean;
  variables: Record<string, string>;
  variableDefs: { key: string; label: string }[];
  templates: { email: TemplateLite[]; whatsapp: TemplateLite[] };
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

    const rows = await sql<(TemplateLite & { channel: string })[]>`
      SELECT id, channel, slug, name, subject, body
      FROM guesthub.message_templates
      WHERE tenant_id = ${actor.tenantId} AND is_active = true
      ORDER BY channel, name`;
    const toLite = (r: TemplateLite & { channel: string }): TemplateLite => ({
      id: r.id, slug: r.slug, name: r.name, subject: r.subject, body: r.body,
    });
    const email = rows.filter((r) => r.channel === "email").map(toLite);
    const whatsapp = rows.filter((r) => r.channel === "whatsapp").map(toLite);

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
        email: built.email,
        emailValid: !!built.email && EMAIL_RE.test(built.email.trim()),
        phone: built.phone,
        phoneE164: n.valid ? n.e164 : null,
        phoneValid: n.valid,
        variables: resolveBookingVariables(built.ctx),
        variableDefs: CANONICAL_VARIABLES,
        templates: { email, whatsapp },
        gmailConfigured: gmail !== null,
        whatsappConfigured: wa !== null,
      },
    };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

async function loadTemplate(tenantId: string, channel: "email" | "whatsapp", id: string): Promise<TemplateLite | null> {
  const [row] = await sql<TemplateLite[]>`
    SELECT id, slug, name, subject, body FROM guesthub.message_templates
    WHERE tenant_id = ${tenantId} AND channel = ${channel} AND id = ${id} AND is_active = true`;
  return row ?? null;
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
    const vars = resolveBookingVariables(built.ctx);
    let subject = input.subject;
    let body = input.body;
    if (input.templateId) {
      const tpl = await loadTemplate(actor.tenantId, "email", input.templateId);
      if (!tpl) return fail("התבנית לא נמצאה");
      subject = renderTemplate(tpl.subject ?? "", vars);
      body = renderTemplate(tpl.body, vars);
    } else {
      // custom text: resolve any {{vars}} the operator typed
      subject = renderTemplate(subject, vars);
      body = renderTemplate(body, vars);
    }
    if (!body.trim()) return fail("תוכן ההודעה ריק");
    const outcome = await sendEmailMessage(actor, {
      reservationId, guestId: built.guestId, to: built.email.trim(), toName: built.guestName,
      subject: subject || `הזמנה #${built.ctx.reservationNumber}`, body, templateId: input.templateId,
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
    const vars = resolveBookingVariables(built.ctx);
    let body = input.body;
    if (input.templateId) {
      const tpl = await loadTemplate(actor.tenantId, "whatsapp", input.templateId);
      if (!tpl) return fail("התבנית לא נמצאה");
      body = renderTemplate(tpl.body, vars);
    } else {
      body = renderTemplate(body, vars);
    }
    if (!body.trim()) return fail("תוכן ההודעה ריק");
    const outcome = await sendWhatsAppMessage(actor, {
      reservationId, guestId: built.guestId, to: n.e164, body, templateId: input.templateId,
    });
    return { success: true, data: { ok: outcome.ok, status: outcome.status, detail: outcome.detail } };
  } catch (e) {
    return fail(errorMessage(e));
  }
}
