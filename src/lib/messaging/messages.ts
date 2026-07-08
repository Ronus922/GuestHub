import "server-only";
import { sql } from "@/lib/db";
import type { Sql } from "postgres";
import type { MessageChannel, MessageStatus, SendResult } from "./types";

// Outbound message log + provider status events (D53). The single source of
// truth for "what did we send and what happened to it". Webhooks resolve the
// tenant THROUGH the stored message (findByProviderId) — never from the payload.

export type OutboundMessageRow = {
  id: string;
  channel: MessageChannel;
  provider: string;
  to_address: string;
  subject: string | null;
  status: MessageStatus;
  provider_message_id: string | null;
  error_detail: string | null;
  created_at: string;
};

export async function createOutboundMessage(args: {
  tenantId: string;
  reservationId: string | null;
  guestId: string | null;
  channel: MessageChannel;
  provider: string;
  templateId: string | null;
  toAddress: string;
  subject: string | null;
  body: string;
  status: MessageStatus;
  userId: string;
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO guesthub.outbound_messages
      (tenant_id, reservation_id, guest_id, channel, provider, template_id,
       to_address, subject, body, status, created_by)
    VALUES (
      ${args.tenantId}, ${args.reservationId}, ${args.guestId}, ${args.channel},
      ${args.provider}, ${args.templateId}, ${args.toAddress}, ${args.subject},
      ${args.body}, ${args.status}, ${args.userId})
    RETURNING id`;
  return row.id;
}

// Apply the provider's send result. "submitted"/"sent" stamp submitted_at.
export async function applySendResult(messageId: string, result: SendResult): Promise<void> {
  const stampSubmitted = result.status === "submitted" || result.status === "sent";
  await sql`
    UPDATE guesthub.outbound_messages
    SET status = ${result.status},
        provider_message_id = ${result.providerMessageId ?? null},
        provider_thread_id = ${result.providerThreadId ?? null},
        error_code = ${result.errorCode ?? null},
        error_detail = ${result.errorDetail ?? null},
        submitted_at = ${stampSubmitted ? sql`now()` : sql`submitted_at`},
        updated_at = now()
    WHERE id = ${messageId}`;
}

// Advance a message's status from a provider callback. Monotonic-ish: we only
// move forward through the lifecycle, so an out-of-order "sent" after "delivered"
// does not regress the row.
const STATUS_RANK: Record<string, number> = {
  draft: 0, validation_failed: 0, provider_not_configured: 0,
  queued: 1, submitting: 2, submitted: 3, sent: 4, delivered: 5, read: 6,
  failed: 7, undelivered: 7,
};
// Advance a message's status from a provider callback. Monotonic: only move
// forward through the lifecycle (rank), so an out-of-order "sent" arriving after
// "delivered" does not regress the row. failed/undelivered (rank 7) always win.
export async function advanceMessageStatus(
  messageId: string,
  status: MessageStatus,
  ts: string | null,
): Promise<void> {
  const rank = STATUS_RANK[status] ?? 0;
  await sql`
    UPDATE guesthub.outbound_messages m
    SET status = ${status},
        delivered_at = ${status === "delivered" ? sql`COALESCE(${ts}::timestamptz, now())` : sql`m.delivered_at`},
        read_at = ${status === "read" ? sql`COALESCE(${ts}::timestamptz, now())` : sql`m.read_at`},
        updated_at = now()
    WHERE m.id = ${messageId}
      AND ${rank} >= CASE m.status
            WHEN 'queued' THEN 1 WHEN 'submitting' THEN 2 WHEN 'submitted' THEN 3
            WHEN 'sent' THEN 4 WHEN 'delivered' THEN 5 WHEN 'read' THEN 6
            WHEN 'failed' THEN 7 WHEN 'undelivered' THEN 7 ELSE 0 END`;
}

// Tenant + message resolution for webhooks — NEVER trust the payload's tenant.
export async function findMessageByProviderId(
  provider: string,
  providerMessageId: string,
): Promise<{ id: string; tenantId: string } | null> {
  const [row] = await sql<{ id: string; tenant_id: string }[]>`
    SELECT id, tenant_id FROM guesthub.outbound_messages
    WHERE provider = ${provider} AND provider_message_id = ${providerMessageId}
    ORDER BY created_at DESC LIMIT 1`;
  return row ? { id: row.id, tenantId: row.tenant_id } : null;
}

// Idempotent event ingest. Returns true if this event is NEW (first time seen),
// false if it was a duplicate (dedup_key already present) — a no-op replay.
export async function recordMessageEvent(args: {
  tenantId: string;
  messageId: string | null;
  provider: string;
  eventType: string;
  mappedStatus: MessageStatus | null;
  dedupKey: string;
  eventTs: string | null;
  raw: unknown;
}): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO guesthub.message_events
      (tenant_id, message_id, provider, event_type, mapped_status, dedup_key, event_ts, raw)
    VALUES (
      ${args.tenantId}, ${args.messageId}, ${args.provider}, ${args.eventType},
      ${args.mappedStatus}, ${args.dedupKey}, ${args.eventTs}, ${sql.json(args.raw as never)})
    ON CONFLICT (provider, dedup_key) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

// Recent messages for a reservation (booking editor history, if surfaced).
export async function listReservationMessages(
  tenantId: string,
  reservationId: string,
  db: Sql = sql,
): Promise<OutboundMessageRow[]> {
  return db<OutboundMessageRow[]>`
    SELECT id, channel, provider, to_address, subject, status,
           provider_message_id, error_detail, created_at::text AS created_at
    FROM guesthub.outbound_messages
    WHERE tenant_id = ${tenantId} AND reservation_id = ${reservationId}
    ORDER BY created_at DESC LIMIT 20`;
}
