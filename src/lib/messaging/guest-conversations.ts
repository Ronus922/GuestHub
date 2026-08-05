import "server-only";
import type { Sql } from "postgres";
import { sql as defaultSql } from "@/lib/db";

// ============================================================
// Guest conversations + messages store (Phase 4, receive-only) — the ONE
// write path both ingest sources share: the Beds24 message poll
// (src/lib/channel/beds24-messages.ts, both directions) and the GREEN-API
// inbound webhook (channel='whatsapp', inbound only). One implementation so
// the idempotency and the inbox-stamp rules can never drift between them.
//
// Schema: db/migrations/076_guest_conversations_and_reviews.sql. A
// conversation is (tenant, channel, external_thread_key) — Beds24 threads key
// on the bookingId (measured: no thread id exists on that wire), WhatsApp
// threads on the GREEN-API chatId. Messages are APPEND-ONLY, idempotent on
// (tenant, provider, external_message_id): a re-poll or webhook replay is a
// no-op, and nothing ever updates a message body.
//
// This module runs in BOTH graphs (Next request + PM2 worker), so it stays
// free of Next-coupled imports; callers may pass their own Sql handle.
// ============================================================

export type GuestConversationChannel = "beds24" | "whatsapp";
export type GuestMessageProvider = "beds24" | "green_api";
export type GuestMessageDirection = "inbound" | "outbound";

/** Resolve-or-create the conversation row for a thread key. Idempotent: every
 *  ingest path converges on the same row via the UNIQUE key. reservation/guest
 *  links only ever FILL IN (COALESCE keeps an existing resolution) — a later
 *  poll that failed to resolve can never blank an earlier link. */
export async function upsertGuestConversation(
  args: {
    tenantId: string;
    channel: GuestConversationChannel;
    externalThreadKey: string;
    reservationId?: string | null;
    guestId?: string | null;
  },
  db: Sql = defaultSql,
): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    INSERT INTO guesthub.guest_conversations
      (tenant_id, channel, external_thread_key, reservation_id, guest_id)
    VALUES
      (${args.tenantId}, ${args.channel}, ${args.externalThreadKey},
       ${args.reservationId ?? null}, ${args.guestId ?? null})
    ON CONFLICT (tenant_id, channel, external_thread_key) DO UPDATE SET
      reservation_id = COALESCE(guesthub.guest_conversations.reservation_id, EXCLUDED.reservation_id),
      guest_id = COALESCE(guesthub.guest_conversations.guest_id, EXCLUDED.guest_id)
    RETURNING id`;
  return row.id;
}

/** Append one message. Returns true when the row is NEW, false on a replay
 *  (dedup on the provider's own message id — the insert is then a no-op and
 *  the conversation stamps are left untouched). A new row advances the
 *  conversation's inbox stamps with GREATEST, so ingesting an older message
 *  later (a backfill) can never regress them. */
export async function insertGuestMessage(
  args: {
    tenantId: string;
    conversationId: string;
    direction: GuestMessageDirection;
    provider: GuestMessageProvider;
    externalMessageId: string;
    body: string;
    /** ISO timestamp of the message itself (provider clock), not of ingest */
    sentAt: string;
    raw: unknown;
  },
  db: Sql = defaultSql,
): Promise<boolean> {
  const rows = await db<{ id: string }[]>`
    INSERT INTO guesthub.guest_messages
      (tenant_id, conversation_id, direction, provider, external_message_id,
       body, sent_at, raw)
    VALUES
      (${args.tenantId}, ${args.conversationId}, ${args.direction},
       ${args.provider}, ${args.externalMessageId}, ${args.body},
       ${args.sentAt}, ${db.json(args.raw as never)})
    ON CONFLICT (tenant_id, provider, external_message_id) DO NOTHING
    RETURNING id`;
  const isNew = rows.length > 0;
  if (isNew) {
    await db`
      UPDATE guesthub.guest_conversations
      SET last_message_at = GREATEST(COALESCE(last_message_at, ${args.sentAt}::timestamptz), ${args.sentAt}::timestamptz),
          last_inbound_at = ${
            args.direction === "inbound"
              ? db`GREATEST(COALESCE(last_inbound_at, ${args.sentAt}::timestamptz), ${args.sentAt}::timestamptz)`
              : db`last_inbound_at`
          }
      WHERE id = ${args.conversationId}`;
  }
  return isNew;
}
