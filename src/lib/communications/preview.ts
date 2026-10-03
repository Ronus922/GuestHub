import "server-only";
import { sql } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import {
  SKIP_REASON_LABELS, evaluateEventAutomations, loadReservationSnapshot,
  type AutomationRow, type DeliveryEffects, type ReservationSnapshot,
} from "./automation";
import type { CommunicationEvent } from "./outbox";
import { scheduledCandidates } from "./scheduler";
import { TRIGGERS, israelParts, israelWallTimeToInstant, type TriggerId } from "./triggers";

// ============================================================
// D203 — "מי יקבל ב-7 הימים הקרובים": the automation preview.
//
// It does not restate any rule. For each day it asks the scheduler's own
// predicate (scheduledCandidates) which reservations match, at the instant the
// worker would scan that day; then every candidate the worker would emit goes
// through the engine's own evaluateEventAutomations with effects that RECORD
// instead of writing. Two things the engine cannot know are answered from the
// outbox: an occurrence already emitted (its idempotency key exists) is shown
// as handled, never as a fresh send.
//
// The caller runs this inside withReadOnlyScope — a write anywhere in this call
// tree is refused by PostgreSQL itself.
// ============================================================

export type PreviewRow = {
  reservationNumber: string;
  guestName: string;
  /** masked: 050-***-4567 / d***@example.com — never the full address */
  contact: string;
  /** HH:MM, Asia/Jerusalem — the planned send (quiet hours applied) */
  time: string | null;
  included: boolean;
  reason: string | null;
  message: { subject: string | null; text: string; html: string | null } | null;
};
export type PreviewDay = { date: string; rows: PreviewRow[] };
export type AutomationPreview =
  | { kind: "event_based" }
  | { kind: "scheduled"; days: PreviewDay[]; included: number; excluded: number };

export const PREVIEW_CATCH_UP_EXPIRED = "ידולג — עבר חלון השליחה";
export const PREVIEW_ALREADY_SENT = "כבר נשלח";
export const PREVIEW_ALREADY_PURGED = "כבר טופל — נמחק מההיסטוריה";

const pad = (n: number) => String(n).padStart(2, "0");
const israelDate = (date: Date) => { const p = israelParts(date); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; };
const israelTime = (date: Date) => { const p = israelParts(date); return `${pad(p.h)}:${pad(p.mi)}`; };

export function maskContact(channel: "email" | "whatsapp", address: string | null | undefined): string {
  if (!address?.trim()) return channel === "whatsapp" ? "אין טלפון" : "אין אימייל";
  if (channel === "whatsapp") {
    const n = normalizePhone(address);
    if (!n.valid) return "מספר לא תקין";
    const national = n.e164.startsWith("+972") ? `0${n.e164.slice(4)}` : n.e164;
    return `${national.slice(0, 3)}-***-${national.slice(-4)}`;
  }
  const [local, domain] = address.trim().split("@");
  return domain ? `${local.slice(0, 1)}***@${domain}` : "***";
}

export async function previewScheduledAutomation(args: {
  automation: AutomationRow & { trigger_type: TriggerId };
  days: number;
  now: Date;
  /** without reservations.view the operator sees counts and reasons, not people */
  showGuestData: boolean;
}): Promise<AutomationPreview> {
  const { automation } = args;
  const trigger = TRIGGERS[automation.trigger_type];
  if (trigger.kind !== "scheduled") return { kind: "event_based" };
  const timing = (automation.timing_config ?? {}) as { sendTime?: string };
  const [sendH, sendM] = (timing.sendTime ?? trigger.defaultSendTime ?? "09:00").split(":").map(Number);
  // the scan reads this one draft row instead of the automations table
  const source = sql`(SELECT ${automation.tenant_id}::uuid AS tenant_id, ${automation.id}::uuid AS id,
    ${automation.trigger_type}::text AS trigger_type, 'active'::text AS status,
    NULL::timestamptz AS archived_at, ${sql.json(automation.timing_config as never)}::jsonb AS timing_config)`;
  const today = israelParts(args.now);
  const days: PreviewDay[] = [];
  let included = 0;
  let excluded = 0;

  for (let d = 0; d < args.days; d += 1) {
    const day = new Date(Date.UTC(today.y, today.mo - 1, today.d + d));
    const sendAt = israelWallTimeToInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), sendH, sendM);
    // The worker scans continuously: a day is decided at its send time, and
    // today's already-passed send time is decided NOW (the catch-up rule).
    const at = d === 0 && args.now > sendAt ? args.now : sendAt;
    const candidates = await sql<{
      tenant_id: string; event_type: string; aggregate_type: string; reservation_id: string; source: string;
      occurrence_key: string; payload: Record<string, unknown>; status_ok: boolean; is_test: boolean;
    }[]>`SELECT c.* FROM (${scheduledCandidates(automation.trigger_type, at, source)}) c
         JOIN guesthub.reservations r ON r.id = c.reservation_id
         ORDER BY r.reservation_number, r.id`;
    const rows: PreviewRow[] = [];
    for (const c of candidates) {
      const reservation = await loadReservationSnapshot(automation.tenant_id, c.reservation_id);
      if (!reservation) continue;
      const person = (address?: string | null) => ({
        reservationNumber: reservation.reservation_number,
        guestName: args.showGuestData ? guestName(reservation) : "—",
        contact: args.showGuestData
          ? maskContact(automation.channel, address
            ?? (automation.channel === "whatsapp" ? reservation.guest_phone : reservation.guest_email))
          : "—",
      });
      const planned = israelTime(sendAt);
      const skipRow = (reason: string): PreviewRow =>
        ({ ...person(), time: planned, included: false, reason, message: null });
      // the emission gates the worker applies before an event exists at all
      if (!c.status_ok) { rows.push(skipRow(SKIP_REASON_LABELS.reservation_not_eligible)); continue; }
      if (c.is_test) { rows.push(skipRow(SKIP_REASON_LABELS.test_reservation)); continue; }
      const handled = await alreadyHandled(c, automation.id);
      if (handled) { rows.push(skipRow(handled)); continue; }
      const event = {
        id: `preview:${c.occurrence_key}`, tenant_id: c.tenant_id, event_type: c.event_type,
        aggregate_type: c.aggregate_type, reservation_id: c.reservation_id, source: c.source,
        occurrence_key: c.occurrence_key, payload: c.payload, occurred_at: at.toISOString(),
      } as unknown as CommunicationEvent;
      const fx: DeliveryEffects = {
        async skip(_automation, reason, _version, _provider, recipient, detail) {
          const label = reason === "catch_up_window_expired"
            ? PREVIEW_CATCH_UP_EXPIRED
            : detail ?? SKIP_REASON_LABELS[reason] ?? reason;
          rows.push({ ...person(recipient?.address || null), time: planned, included: false, reason: label, message: null });
        },
        async markNeedsAttention() { /* the preview never flags an automation */ },
        async deliver(delivery) {
          rows.push({
            ...person(delivery.recipient.address),
            time: israelTime(delivery.scheduledAt), included: true, reason: null,
            message: !args.showGuestData ? null : delivery.channel === "whatsapp"
              ? { subject: null, text: delivery.text, html: null }
              : { subject: delivery.subject, text: delivery.plainText, html: delivery.html },
          });
        },
      };
      await evaluateEventAutomations({ event, trigger, reservation, automations: [automation], now: at }, fx);
    }
    for (const row of rows) { if (row.included) included += 1; else excluded += 1; }
    days.push({ date: israelDate(sendAt), rows });
  }
  return { kind: "scheduled", days, included, excluded };
}

function guestName(r: ReservationSnapshot): string {
  return r.guest_full_name?.trim() || [r.guest_first_name, r.guest_last_name].filter(Boolean).join(" ") || "אורח";
}

/**
 * The occurrence was already emitted (its idempotency key exists in the
 * outbox), so the worker will not emit it again. Sent/queued → "כבר נשלח";
 * only skipped rows → handled without a send, with the recorded reason.
 */
async function alreadyHandled(
  c: { tenant_id: string; event_type: string; aggregate_type: string; occurrence_key: string },
  automationId: string,
): Promise<string | null> {
  const [event] = await sql<{ id: string }[]>`
    SELECT id FROM guesthub.communication_events
    WHERE tenant_id = ${c.tenant_id} AND event_type = ${c.event_type}
      AND aggregate_type = ${c.aggregate_type} AND occurrence_key = ${c.occurrence_key}`;
  if (!event) {
    // D204 — a purged occurrence is gone from the outbox but kept in the
    // ledger, and the 094 trigger will refuse to emit it again
    const [purged] = await sql<{ key: string }[]>`
      SELECT key FROM guesthub.communication_purge_ledger
      WHERE tenant_id = ${c.tenant_id}
        AND key = ${`occurrence:${c.event_type}:${c.aggregate_type}:${c.occurrence_key}`}`;
    return purged ? PREVIEW_ALREADY_PURGED : null;
  }
  const outcomes = await sql<{ status: string; error_code: string | null }[]>`
    SELECT status, error_code FROM guesthub.outbound_messages
    WHERE tenant_id = ${c.tenant_id} AND event_id = ${event.id} AND automation_id = ${automationId}`;
  const skipped = outcomes.filter((o) => o.status === "skipped");
  if (outcomes.length > 0 && skipped.length === outcomes.length) {
    const code = skipped[0].error_code ?? "";
    return `כבר טופל — לא נשלח: ${SKIP_REASON_LABELS[code] ?? code}`;
  }
  return PREVIEW_ALREADY_SENT;
}
