import "server-only";
import type { TransactionSql } from "postgres";
import { coalesceRange } from "./ranges";
import { enqueueChannelJob } from "./queue";
import type { DateOnly } from "@/lib/dates";

// ============================================================
// Transactional dirty-range outbox (§S, D35 · re-keyed to the physical room by
// D68). Called by every canonical write that affects ARI — Bulk Update, the Rate
// Grid, Rate Plans, reservations, closures, room status — WITH THE SAME
// transaction handle as the business write, so the two commit or roll back
// together. It NEVER performs an HTTP call and never blocks the operator: the
// PM2 channel worker picks the ranges up out of band.
//
// DIMENSION (D64/D65): one physical room ⇄ one channel room type; one
// (room × local Rate Plan) ⇄ one channel rate plan. So a dirty range names a
// ROOM, and optionally ONE local Rate Plan:
//   local_rate_plan_id = NULL  → every channel-visible plan of that room. This is
//     what a Bulk Update means: it writes the unit's BASE plan rows, from which
//     every derived plan is computed.
//   local_rate_plan_id = <id>  → only that plan's combination (a plan-scoped edit).
//
// When no ACTIVE, outbound-enabled connection exists this is a cheap no-op:
// local operations work normally and no backlog accumulates. The operator's
// first Full Sync publishes the whole 500-day canonical state, so nothing that
// happened before activation is lost.
// ============================================================

export type DirtyKind = "availability" | "rates" | "restrictions";

export type MarkAriDirtyArgs = {
  tenantId: string;
  roomIds: (string | null)[];
  dateFrom: DateOnly;
  dateTo: DateOnly; // exclusive
  kinds?: DirtyKind[];
  /** plan scope for rates/restrictions; omitted/null = every channel-visible plan */
  ratePlanIds?: (string | null)[];
};

export async function markAriDirty(tx: TransactionSql, args: MarkAriDirtyArgs): Promise<void> {
  const roomIds = [...new Set(args.roomIds.filter((x): x is string => !!x))];
  if (roomIds.length === 0 || args.dateFrom >= args.dateTo) return;

  const connections = await tx<{ id: string }[]>`
    SELECT id FROM guesthub.channel_connections
    WHERE tenant_id = ${args.tenantId}
      AND state = 'active' AND outbound_sync_enabled = true`;
  if (connections.length === 0) return; // before the first Full Sync: always the case

  const kinds = args.kinds ?? ["availability"];
  // availability is plan-independent (a DB CHECK enforces it); commercial kinds
  // carry the plan scope, defaulting to "all plans of the room".
  const planScopes = args.ratePlanIds?.length
    ? [...new Set(args.ratePlanIds.filter((x): x is string => !!x))]
    : [null];

  for (const conn of connections) {
    for (const roomId of roomIds) {
      for (const kind of kinds) {
        const scopes: (string | null)[] = kind === "availability" ? [null] : planScopes;
        for (const planId of scopes) {
          // lock + coalesce pending ranges of the same key (overlap OR adjacency),
          // so duplicate edits never produce duplicate outbound work
          const existing = await tx<{ id: string; date_from: string; date_to: string }[]>`
            SELECT id, date_from::text AS date_from, date_to::text AS date_to
            FROM guesthub.channel_dirty_ranges
            WHERE connection_id = ${conn.id} AND room_id = ${roomId}
              AND kind = ${kind}
              AND local_rate_plan_id IS NOT DISTINCT FROM ${planId}
              AND status = 'pending'
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
              (tenant_id, connection_id, room_id, local_rate_plan_id, kind, date_from, date_to)
            VALUES (${args.tenantId}, ${conn.id}, ${roomId}, ${planId}, ${kind},
                    ${merged.date_from}, ${merged.date_to})`;
        }
      }
    }
  }

  // One durable, deduplicated wake-up per connection. The worker claims it and
  // drains whatever is pending; a burst of saves produces exactly one job.
  for (const conn of connections) {
    await enqueueChannelJob(tx, {
      tenantId: args.tenantId,
      connectionId: conn.id,
      jobType: "sync_ari_range",
      priority: 50,
      idempotencyKey: `ari_drain:${conn.id}`,
    });
  }
}

// Every channel-visible descendant of a changed Rate Plan is affected too: a
// derived plan's nightly price is computed FROM its parent's resolved price, so
// editing the parent silently re-prices the children. Returns the plan itself
// plus its transitive children (cycle-safe).
export async function expandPlanFamily(
  tx: TransactionSql,
  tenantId: string,
  planIds: string[],
): Promise<string[]> {
  const seeds = [...new Set(planIds.filter(Boolean))];
  if (seeds.length === 0) return [];
  const rows = await tx<{ id: string }[]>`
    WITH RECURSIVE family AS (
      SELECT id FROM guesthub.pricing_plans
       WHERE tenant_id = ${tenantId} AND id = ANY(${seeds}::uuid[])
      UNION
      SELECT p.id FROM guesthub.pricing_plans p
        JOIN family f ON p.parent_plan_id = f.id
       WHERE p.tenant_id = ${tenantId}
    )
    SELECT id FROM family`;
  return rows.map((r) => r.id);
}

// The rooms a tenant-level Rate Plan is actively assigned to, via its sellable
// units. A plan-scoped dirty range is written for exactly these rooms.
export async function roomsForPlans(
  tx: TransactionSql,
  tenantId: string,
  planIds: string[],
): Promise<string[]> {
  if (planIds.length === 0) return [];
  const rows = await tx<{ room_id: string }[]>`
    SELECT DISTINCT sur.room_id
    FROM guesthub.pricing_plan_units pu
    JOIN guesthub.sellable_unit_rooms sur ON sur.sellable_unit_id = pu.sellable_unit_id
    WHERE pu.tenant_id = ${tenantId} AND pu.is_active
      AND pu.pricing_plan_id = ANY(${planIds}::uuid[])`;
  return rows.map((r) => r.room_id);
}
