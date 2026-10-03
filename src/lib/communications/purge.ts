import "server-only";
import type postgres from "postgres";
import { sql } from "@/lib/db";
import { TERMINAL_STATUSES, israelToday } from "./history";

// ============================================================
// D204 — "מחק היסטוריה": delete the tenant's outbound communication log.
//
// What goes: every TERMINAL outbound_messages row (any delivery type, regardless
// of the screen's filters), with its outbound-only children —
// communication_delivery_attempts and message_events (both ON DELETE CASCADE) —
// and every communication_events row that is finished (processed / failed),
// has no anchor date in the future, and has no outbound row left after the
// purge.
//
// What stays, by construction:
//   - active rows: queued (a retry waiting, a future scheduled_at), submitting,
//     draft — and every event that still has one, or whose anchor is ahead;
//   - a row a guest message or a channel change points at: guest_messages /
//     channel_external_changes reference outbound rows ON DELETE SET NULL, and
//     deleting would WRITE to them — guest_conversations / guest_messages are
//     never touched;
//   - a row a kept row was resent from (resend_of_delivery_id is RESTRICT),
//     up the whole resend chain.
// Templates, automations, settings and the audit log are not read for writing.
//
// Idempotency survives: before anything is deleted, the key of every deleted
// row goes to communication_purge_ledger (tenant_id, key, created_at — no
// content), and the 094 BEFORE INSERT triggers refuse to re-create a purged
// occurrence or delivery. One transaction: any error and nothing is deleted.
// ============================================================

type Db = postgres.Sql | postgres.TransactionSql;

export type PurgeCounts = {
  outboundMessages: number;
  deliveryAttempts: number;
  messageEvents: number;
  communicationEvents: number;
  /** active rows (queued / submitting / draft) — never deleted */
  activeKept: number;
  /** terminal rows kept because a guest message, a channel change or a kept resend points at them */
  referencedKept: number;
};

const TERMINAL = [...TERMINAL_STATUSES];

/** The terminal rows that can go (see the header for every exclusion). */
function purgeRowIds(db: Db, tenantId: string) {
  return db`
    WITH RECURSIVE base AS (
      SELECT o.id FROM guesthub.outbound_messages o
      WHERE o.tenant_id = ${tenantId} AND o.status = ANY(${TERMINAL})
        AND NOT EXISTS (SELECT 1 FROM guesthub.guest_messages gm WHERE gm.outbound_message_id = o.id)
        AND NOT EXISTS (SELECT 1 FROM guesthub.channel_external_changes c WHERE c.outbound_message_id = o.id)
    ), blocked AS (
      SELECT o.resend_of_delivery_id AS id FROM guesthub.outbound_messages o
      WHERE o.tenant_id = ${tenantId} AND o.resend_of_delivery_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM base b WHERE b.id = o.id)
      UNION
      SELECT o.resend_of_delivery_id FROM guesthub.outbound_messages o
      JOIN blocked k ON k.id = o.id WHERE o.resend_of_delivery_id IS NOT NULL
    )
    SELECT b.id FROM base b WHERE NOT EXISTS (SELECT 1 FROM blocked k WHERE k.id = b.id)`;
}

/** Finished events with no anchor ahead and no outbound row left once `rowIds` are gone. */
function purgeEventIds(db: Db, tenantId: string, rowIds: string[]) {
  return db`
    SELECT e.id FROM guesthub.communication_events e
    WHERE e.tenant_id = ${tenantId} AND e.status IN ('processed', 'failed')
      AND CASE WHEN e.payload->>'anchorDate' ~ '^\\d{4}-\\d{2}-\\d{2}$'
               THEN (e.payload->>'anchorDate')::date <= ${israelToday()}::date
               ELSE NOT (e.payload ? 'anchorDate') END
      AND NOT EXISTS (
        SELECT 1 FROM guesthub.outbound_messages o
        WHERE o.tenant_id = e.tenant_id AND o.event_id = e.id AND NOT (o.id = ANY(${rowIds}::uuid[])))`;
}

async function select(db: Db, tenantId: string): Promise<{ rowIds: string[]; eventIds: string[]; counts: PurgeCounts }> {
  const rowIds = (await purgeRowIds(db, tenantId)).map((r) => r.id as string);
  const eventIds = (await purgeEventIds(db, tenantId, rowIds)).map((r) => r.id as string);
  const [c] = await db<{ attempts: number; message_events: number; active: number; terminal: number }[]>`
    SELECT
      (SELECT COUNT(*)::int FROM guesthub.communication_delivery_attempts a
        WHERE a.tenant_id = ${tenantId} AND a.delivery_id = ANY(${rowIds}::uuid[])) AS attempts,
      (SELECT COUNT(*)::int FROM guesthub.message_events m WHERE m.message_id = ANY(${rowIds}::uuid[])) AS message_events,
      (SELECT COUNT(*)::int FROM guesthub.outbound_messages o
        WHERE o.tenant_id = ${tenantId} AND NOT (o.status = ANY(${TERMINAL}))) AS active,
      (SELECT COUNT(*)::int FROM guesthub.outbound_messages o
        WHERE o.tenant_id = ${tenantId} AND o.status = ANY(${TERMINAL})) AS terminal`;
  return {
    rowIds, eventIds,
    counts: {
      outboundMessages: rowIds.length, deliveryAttempts: c.attempts, messageEvents: c.message_events,
      communicationEvents: eventIds.length, activeKept: c.active, referencedKept: c.terminal - rowIds.length,
    },
  };
}

/** What a purge would delete and keep right now — read-only, for the confirmation dialog. */
export async function purgePreview(tenantId: string): Promise<PurgeCounts> {
  return (await select(sql, tenantId)).counts;
}

/**
 * Run the purge inside the caller's transaction (it writes the ledger, deletes,
 * and verifies; the caller writes the audit entry in the same transaction).
 */
export async function purgeCommunicationHistory(tx: postgres.TransactionSql, tenantId: string): Promise<PurgeCounts> {
  const { rowIds, eventIds, counts } = await select(tx, tenantId);
  // 1. idempotency first — a purged message can never be re-created
  await tx`
    INSERT INTO guesthub.communication_purge_ledger (tenant_id, key)
    SELECT o.tenant_id, 'delivery:' || o.idempotency_key FROM guesthub.outbound_messages o
    WHERE o.tenant_id = ${tenantId} AND o.id = ANY(${rowIds}::uuid[]) AND o.idempotency_key IS NOT NULL
    ON CONFLICT DO NOTHING`;
  await tx`
    INSERT INTO guesthub.communication_purge_ledger (tenant_id, key)
    SELECT e.tenant_id, 'occurrence:' || e.event_type || ':' || e.aggregate_type || ':' || e.occurrence_key
    FROM guesthub.communication_events e
    WHERE e.tenant_id = ${tenantId} AND e.id = ANY(${eventIds}::uuid[])
    ON CONFLICT DO NOTHING`;
  // 2. resend children before their parents (resend_of_delivery_id is RESTRICT)
  for (let pass = 0; pass < 50; pass += 1) {
    const gone = await tx`
      DELETE FROM guesthub.outbound_messages o
      WHERE o.tenant_id = ${tenantId} AND o.id = ANY(${rowIds}::uuid[])
        AND NOT EXISTS (SELECT 1 FROM guesthub.outbound_messages c WHERE c.resend_of_delivery_id = o.id)
      RETURNING o.id`;
    if (gone.length === 0) break;
  }
  const [{ left }] = await tx<{ left: number }[]>`
    SELECT COUNT(*)::int AS left FROM guesthub.outbound_messages WHERE id = ANY(${rowIds}::uuid[])`;
  if (left > 0) throw new Error(`purge: ${left} outbound rows could not be deleted`);
  await tx`DELETE FROM guesthub.communication_events WHERE tenant_id = ${tenantId} AND id = ANY(${eventIds}::uuid[])`;
  return counts;
}
