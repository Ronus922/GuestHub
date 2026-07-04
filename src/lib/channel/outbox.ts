import "server-only";
import type { TransactionSql } from "postgres";
import { coalesceRange } from "./ranges";
import type { DateOnly } from "@/lib/dates";

// ============================================================
// Transactional dirty-range outbox (§S, DECISIONS D35).
// Called by every business write that affects ARI (availability / rates /
// restrictions), WITH THE SAME transaction handle as the business write —
// the two commit or roll back together. It never performs any HTTP call.
//
// When no ACTIVE, outbound-enabled connection exists for the tenant (the
// only possible state in Phase 3), this is a cheap no-op: local operations
// work normally and no backlog accumulates. A later first activation runs a
// full sync computed from current state, so nothing is lost.
// ============================================================

export type DirtyKind = "availability" | "rates" | "restrictions";

export async function markAriDirty(
  tx: TransactionSql,
  args: {
    tenantId: string;
    roomTypeIds: (string | null)[];
    dateFrom: DateOnly;
    dateTo: DateOnly; // exclusive
    kinds?: DirtyKind[];
  },
): Promise<void> {
  const roomTypeIds = [...new Set(args.roomTypeIds.filter((x): x is string => !!x))];
  if (roomTypeIds.length === 0 || args.dateFrom >= args.dateTo) return;

  const connections = await tx<{ id: string }[]>`
    SELECT id FROM guesthub.channel_connections
    WHERE tenant_id = ${args.tenantId}
      AND state = 'active' AND outbound_sync_enabled = true`;
  if (connections.length === 0) return; // Phase 3: always the case

  const kinds = args.kinds ?? ["availability"];
  for (const conn of connections) {
    for (const roomTypeId of roomTypeIds) {
      for (const kind of kinds) {
        // lock + coalesce pending ranges of the same key (overlap OR adjacency)
        const existing = await tx<{ id: string; date_from: string; date_to: string }[]>`
          SELECT id, date_from::text AS date_from, date_to::text AS date_to
          FROM guesthub.channel_dirty_ranges
          WHERE connection_id = ${conn.id} AND room_type_id = ${roomTypeId}
            AND kind = ${kind} AND status = 'pending'
            AND date_from <= ${args.dateTo} AND date_to >= ${args.dateFrom}
          FOR UPDATE`;
        const { merged, absorbedIds } = coalesceRange(existing, {
          date_from: args.dateFrom,
          date_to: args.dateTo,
        });
        if (absorbedIds.length > 0) {
          await tx`
            DELETE FROM guesthub.channel_dirty_ranges
            WHERE id = ANY(${absorbedIds}::uuid[])`;
        }
        await tx`
          INSERT INTO guesthub.channel_dirty_ranges
            (tenant_id, connection_id, room_type_id, kind, date_from, date_to)
          VALUES (${args.tenantId}, ${conn.id}, ${roomTypeId}, ${kind},
                  ${merged.date_from}, ${merged.date_to})`;
      }
    }
  }
}
