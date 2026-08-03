import "server-only";
import { sql } from "@/lib/db";
import { INVENTORY_BLOCKING_STATUSES } from "@/lib/inventory-rules";
import {
  expandNightlyRevenue,
  type NightlyRevenueRow,
  type RevenueDate,
} from "./nightly-revenue-rules";

// ============================================================
// The `rev` window's series: the last N calendar months, each with its revenue
// (per-night attribution), its occupancy, and how much of the revenue came from
// the even-split fallback.
//
// ONE pass, not twelve calls and not twenty-four. Two queries total: the stays
// touching the whole span, expanded per night in TypeScript; and one call to
// room_type_inventory over the same span, summed per month. The audit's cost
// analysis says the same thing — 74 reservations and ~1,100 projection rows are
// trivial, and 24 sequential round-trips would cost more in latency than one
// grouped read.
//
// Per-night expansion is also what makes the months ADD UP: revenueReport
// clips its night count to the window but adds each stay's whole price_total to
// every month it touches, so its twelve months do not sum to its year.
// ============================================================

const BLOCKING = INVENTORY_BLOCKING_STATUSES as readonly string[];

export type MonthlyRevenuePoint = {
  /** first day of the month, YYYY-MM-01 */
  month: RevenueDate;
  /** VAT-INCLUSIVE */
  revenue: number;
  /** 0–100, one decimal; occupied room-nights ÷ sellable room-nights */
  occupancyPct: number;
  /** 0–100, one decimal — share of this month's revenue that was fallback */
  fallbackSharePct: number;
  /** the current month is still accruing; the chart labels it חלקי */
  partial: boolean;
};

const firstOfMonth = (d: RevenueDate): RevenueDate => `${d.slice(0, 7)}-01`;

function addMonths(month: RevenueDate, n: number): RevenueDate {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${String(yy).padStart(4, "0")}-${String(mm + 1).padStart(2, "0")}-01`;
}

/**
 * @param months how many calendar months to return, ending with the month of
 *               `today` (inclusive). The design's chartMonths range is 6–12.
 */
export async function monthlyRevenue(
  tenantId: string,
  today: RevenueDate,
  months: number,
): Promise<MonthlyRevenuePoint[]> {
  const count = Math.max(1, Math.min(12, Math.round(months)));
  const thisMonth = firstOfMonth(today);
  const from = addMonths(thisMonth, -(count - 1));
  const to = addMonths(thisMonth, 1); // exclusive

  const [stays, inventory] = await Promise.all([
    sql<
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
             CASE WHEN jsonb_typeof(rr.pricing_snapshot->'nightly') = 'array'
                  THEN rr.pricing_snapshot->'nightly' ELSE NULL END AS nightly
        FROM guesthub.reservation_rooms rr
        JOIN guesthub.reservations res
          ON res.id = rr.reservation_id AND res.tenant_id = rr.tenant_id
       WHERE rr.tenant_id = ${tenantId}
         AND res.status = ANY(${BLOCKING})
         AND rr.check_in < ${to} AND rr.check_out > ${from}`,
    // the SAME canonical projection occupancyReport reads — sellable and
    // occupied room-nights per day, summed per month here
    sql<{ month: string; sellable: number; occupied: number }[]>`
      SELECT to_char(day, 'YYYY-MM-01') AS month,
             COALESCE(SUM(sellable_rooms), 0)::float8 AS sellable,
             COALESCE(SUM(occupied_rooms), 0)::float8 AS occupied
        FROM guesthub.room_type_inventory(${tenantId}, ${from}::date, ${to}::date)
       GROUP BY 1`,
  ]);

  const rows: NightlyRevenueRow[] = stays.map((s) => ({
    rrId: s.rr_id,
    checkIn: s.check_in,
    checkOut: s.check_out,
    priceTotal: Number(s.price_total ?? 0),
    nightly: Array.isArray(s.nightly)
      ? s.nightly
          .filter((n) => n && typeof n.date === "string")
          .map((n) => ({ date: n.date, nightTotal: Number(n.nightTotal ?? 0) }))
      : null,
  }));

  // expand ONCE over the whole span, then fold the days into months — the
  // per-date series is exactly what makes a month-crossing stay split correctly
  const days = expandNightlyRevenue(rows, from, to).days;
  const byMonth = new Map<string, { revenue: number; fallback: number }>();
  for (const d of days) {
    const m = firstOfMonth(d.date);
    const cell = byMonth.get(m) ?? { revenue: 0, fallback: 0 };
    cell.revenue += Math.round(d.revenue * 100);
    cell.fallback += Math.round(d.fallbackRevenue * 100);
    byMonth.set(m, cell);
  }

  const occ = new Map(inventory.map((r) => [r.month, r]));

  const out: MonthlyRevenuePoint[] = [];
  for (let i = 0; i < count; i++) {
    const month = addMonths(from, i);
    // a month with no bookings renders at 0 — never skipped, or the x-axis
    // silently compresses and the shape of the year is a lie
    const cell = byMonth.get(month) ?? { revenue: 0, fallback: 0 };
    const inv = occ.get(month);
    const sellable = Number(inv?.sellable ?? 0);
    const occupied = Number(inv?.occupied ?? 0);
    out.push({
      month,
      revenue: cell.revenue / 100,
      occupancyPct: sellable > 0 ? Math.round((occupied / sellable) * 1000) / 10 : 0,
      fallbackSharePct: cell.revenue > 0 ? Math.round((cell.fallback / cell.revenue) * 1000) / 10 : 0,
      // recognition is by STAY-NIGHT, so "partial" means exactly one thing:
      // this month still has nights ahead of it
      partial: month === thisMonth,
    });
  }
  return out;
}

/** exported for the check script — the span the series covers */
export function monthlySpan(today: RevenueDate, months: number): { from: RevenueDate; to: RevenueDate } {
  const count = Math.max(1, Math.min(12, Math.round(months)));
  const thisMonth = firstOfMonth(today);
  return { from: addMonths(thisMonth, -(count - 1)), to: addMonths(thisMonth, 1) };
}
