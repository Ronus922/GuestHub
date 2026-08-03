import "server-only";
import { sql } from "@/lib/db";
import { INVENTORY_BLOCKING_STATUSES } from "@/lib/inventory-rules";
import {
  expandNightlyRevenue,
  type NightlyRevenueBreakdown,
  type NightlyRevenueRow,
  type RevenueDate,
} from "./nightly-revenue-rules";

// ============================================================
// THE canonical revenue function for the dashboard. Every money figure the
// dashboard shows resolves through here — the KPI tonight today, and whatever
// the 12-month chart becomes later. One definition, one place to be wrong.
//
// The expansion rules, the two paths and the provenance contract live in the
// import-free sibling nightly-revenue-rules.ts (so they are unit-testable
// without a database); this module is only the query that feeds them.
//
// STATUS SET: reuses INVENTORY_BLOCKING_STATUSES — the SAME list
// reports/queries.ts already compiles, which since D126 is every status except
// cancelled. A second status list here would be a second definition of "does
// this booking count", and the whole point of this module is that there is one.
//
// VAT: figures are VAT-INCLUSIVE (D-audit §4.4 — priceIncludesVat: true, 18%).
// Any UI showing them must say כולל מע״מ or the number is wrong by 18%.
// ============================================================

export type { NightlyRevenueBreakdown, RevenueDate };

/**
 * Per-DATE revenue over [from, to) — `from` inclusive, `to` EXCLUSIVE.
 *
 * Returns the per-day series, the total, and how much of it came from the
 * even-split fallback rather than a stay's own per-night snapshot. The caller
 * is expected to be able to report that ratio; a figure that silently blends
 * the two definitions is the defect this function exists to remove.
 */
export async function nightlyRevenue(
  tenantId: string,
  from: RevenueDate,
  to: RevenueDate,
): Promise<NightlyRevenueBreakdown> {
  const rows = await sql<
    {
      rr_id: string;
      check_in: string;
      check_out: string;
      price_total: string | number | null;
      nightly: { date: string; nightTotal: number }[] | null;
    }[]
  >`
    SELECT rr.id AS rr_id,
           rr.check_in::text  AS check_in,
           rr.check_out::text AS check_out,
           rr.price_total,
           CASE
             WHEN jsonb_typeof(rr.pricing_snapshot->'nightly') = 'array'
             THEN rr.pricing_snapshot->'nightly'
             ELSE NULL
           END AS nightly
      FROM guesthub.reservation_rooms rr
      JOIN guesthub.reservations res
        ON res.id = rr.reservation_id AND res.tenant_id = rr.tenant_id
     WHERE rr.tenant_id = ${tenantId}
       AND res.status = ANY(${INVENTORY_BLOCKING_STATUSES as readonly string[]})
       -- half-open overlap with the window; a stay touching it contributes
       -- only the nights that fall inside, which the expansion enforces
       AND rr.check_in < ${to}
       AND rr.check_out > ${from}`;

  const input: NightlyRevenueRow[] = rows.map((r) => ({
    rrId: r.rr_id,
    checkIn: r.check_in,
    checkOut: r.check_out,
    priceTotal: Number(r.price_total ?? 0),
    nightly: Array.isArray(r.nightly)
      ? r.nightly
          .filter((n) => n && typeof n.date === "string")
          .map((n) => ({ date: n.date, nightTotal: Number(n.nightTotal ?? 0) }))
      : null,
  }));

  return expandNightlyRevenue(input, from, to);
}
