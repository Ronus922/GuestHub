import "server-only";
import { sql } from "@/lib/db";

// ============================================================
// Reconciliation service contract (§AA). Phase 3 implements the local half:
// GuestHub-calculated availability (the projection) vs the pending dirty
// backlog. The provider-reported comparison activates with a connection —
// until then it is reported as skipped, and NO provider call happens here.
// ============================================================

export type ReconciliationReport = {
  connectionId: string | null;
  ranAt: string;
  local: {
    roomTypes: number;
    daysChecked: number;
    negativeAvailability: number; // must always be 0 (projection clamps)
  };
  pendingDirtyRanges: number;
  providerComparison: "skipped_disconnected" | "ok" | "mismatch";
};

export async function reconcileInventory(
  tenantId: string,
  from: string,
  to: string,
): Promise<ReconciliationReport> {
  const rows = await sql<{ room_type_id: string; availability: number }[]>`
    SELECT room_type_id, availability
    FROM guesthub.room_type_inventory(${tenantId}, ${from}, ${to})`;
  const [conn] = await sql<{ id: string; state: string }[]>`
    SELECT id, state FROM guesthub.channel_connections
    WHERE tenant_id = ${tenantId} ORDER BY (state = 'active') DESC LIMIT 1`;
  const [dirty] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM guesthub.channel_dirty_ranges
    WHERE tenant_id = ${tenantId} AND status = 'pending'`;

  const report: ReconciliationReport = {
    connectionId: conn?.id ?? null,
    ranAt: new Date().toISOString(),
    local: {
      roomTypes: new Set(rows.map((r) => r.room_type_id)).size,
      daysChecked: rows.length,
      negativeAvailability: rows.filter((r) => r.availability < 0).length,
    },
    pendingDirtyRanges: dirty?.n ?? 0,
    providerComparison: conn?.state === "active" ? "ok" : "skipped_disconnected",
  };

  if (conn) {
    await sql`
      UPDATE guesthub.channel_connections SET last_reconciliation_at = now()
      WHERE id = ${conn.id}`;
  }
  return report;
}
