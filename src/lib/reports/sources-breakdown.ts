import "server-only";
import { sql } from "@/lib/db";
import { sourceColor } from "@/lib/colors";
import { INVENTORY_BLOCKING_STATUSES } from "@/lib/inventory-rules";
import { expandNightlyRevenue, type NightlyRevenueRow } from "./nightly-revenue-rules";
import type { RevenueDate } from "./nightly-revenue-rules";

// ============================================================
// THE booking-sources breakdown. ONE function, consumed by BOTH the `src`
// window and the full drawer it opens.
//
// Two queries would guarantee two different totals on one screen — the window
// saying 43 and the drawer saying 41 for the same month is not a rounding
// disagreement, it is two definitions of "a booking", and the operator has no
// way to tell which one is the business. So there is one.
//
// REVENUE uses the SAME per-night attribution the chart uses — the rules module
// is imported, not re-derived. SUM(price_total) over stays that OVERLAP a window
// is the double-count defect already recorded against revenueReport: a stay
// spanning two months adds its whole total to both. Revenue here clips to the
// window's nights by construction.
//
// TAXONOMY is `reservations.source_id → lookup_items`. Reservations with a NULL
// source_id form a "לא צוין" bucket — a real slice with real money in it, not an
// error to be filtered away. (Zero such rows on the production tenant today;
// the bucket exists so that stops being load-bearing.)
// ============================================================

const BLOCKING = INVENTORY_BLOCKING_STATUSES as readonly string[];

/** the id used for the NULL-source bucket — never a real lookup_items id */
export const UNSPECIFIED_SOURCE_ID = "unspecified";

export type SourceMetric = "guests" | "reservations";

export type SourceBreakdownRow = {
  sourceId: string;
  key: string;
  label: string;
  color: string;
  reservations: number;
  guests: number;
  /** VAT-inclusive, clipped to the window's nights */
  revenue: number;
  /** share of the SELECTED metric, 0–100 with one decimal */
  sharePct: number;
  /** direct vs OTA, for the drawer's two summary cards */
  channel: "direct" | "ota";
};

export type SourcesBreakdown = {
  from: RevenueDate;
  to: RevenueDate;
  metric: SourceMetric;
  rows: SourceBreakdownRow[];
  totals: { reservations: number; guests: number; revenue: number };
};

// ---- direct vs OTA, in ONE place ------------------------------------------
// The drawer shows two summary cards. The reference shows three — its third is
// "סוכנים וחברות", and the schema has no agent or company concept at all
// (audit contradiction 30), so a card for it could only ever read zero. Removed
// rather than shipped empty.
//
// Anything not listed here is DIRECT: the property's own channels are the ones
// it controls and knows about, while OTAs are a finite, named set. A new OTA
// added to the lookup without being added here is therefore mislabelled as
// direct — visible and fixable — rather than silently dropped from both cards.
const OTA_KEYS = new Set(["booking_com", "airbnb", "expedia", "agoda", "hotels_com", "trip_com"]);
const channelOf = (key: string): "direct" | "ota" => (OTA_KEYS.has(key) ? "ota" : "direct");

export async function sourcesBreakdown(
  tenantId: string,
  from: RevenueDate,
  to: RevenueDate,
  metric: SourceMetric = "guests",
): Promise<SourcesBreakdown> {
  // Every source in the taxonomy, ranked by sort_order. The rank — not the
  // position in a filtered result — is what the fallback colour keys on, so a
  // source keeps its colour when another has no bookings this month.
  const sources = await sql<
    { id: string; key: string; label: string; color: string | null; rank: number }[]
  >`
    SELECT id, key, label, color,
           (row_number() OVER (ORDER BY sort_order, key) - 1)::int AS rank
      FROM guesthub.lookup_items
     WHERE tenant_id = ${tenantId} AND category = 'booking_sources'
     ORDER BY sort_order, key`;

  // One pass over the stays touching the window. Rows carry their source and
  // the raw material the nightly attribution needs; the money is computed in
  // TypeScript by the SAME expansion the chart uses.
  const stays = await sql<
    {
      rr_id: string;
      reservation_id: string;
      source_id: string | null;
      check_in: string;
      check_out: string;
      price_total: string | number | null;
      adults: number;
      children: number;
      nightly: { date: string; nightTotal: number }[] | null;
    }[]
  >`
    SELECT rr.id AS rr_id,
           res.id AS reservation_id,
           res.source_id,
           rr.check_in::text  AS check_in,
           rr.check_out::text AS check_out,
           rr.price_total,
           rr.adults, rr.children,
           CASE WHEN jsonb_typeof(rr.pricing_snapshot->'nightly') = 'array'
                THEN rr.pricing_snapshot->'nightly' ELSE NULL END AS nightly
      FROM guesthub.reservation_rooms rr
      JOIN guesthub.reservations res
        ON res.id = rr.reservation_id AND res.tenant_id = rr.tenant_id
     WHERE rr.tenant_id = ${tenantId}
       AND res.status = ANY(${BLOCKING})
       AND rr.check_in < ${to} AND rr.check_out > ${from}`;

  type Bucket = {
    reservations: Set<string>;
    guests: number;
    revenueAgorot: number;
  };
  const buckets = new Map<string, Bucket>();
  const bucket = (id: string): Bucket => {
    let b = buckets.get(id);
    if (!b) {
      b = { reservations: new Set(), guests: 0, revenueAgorot: 0 };
      buckets.set(id, b);
    }
    return b;
  };

  for (const s of stays) {
    const id = s.source_id ?? UNSPECIFIED_SOURCE_ID;
    const b = bucket(id);
    b.reservations.add(s.reservation_id);
    b.guests += Number(s.adults ?? 0) + Number(s.children ?? 0);

    // per-stay expansion, so each stay's money is clipped to the window's
    // nights exactly as the chart clips it
    const row: NightlyRevenueRow = {
      rrId: s.rr_id,
      checkIn: s.check_in,
      checkOut: s.check_out,
      priceTotal: Number(s.price_total ?? 0),
      nightly: Array.isArray(s.nightly)
        ? s.nightly
            .filter((n) => n && typeof n.date === "string")
            .map((n) => ({ date: n.date, nightTotal: Number(n.nightTotal ?? 0) }))
        : null,
    };
    b.revenueAgorot += Math.round(expandNightlyRevenue([row], from, to).total * 100);
  }

  const known = new Map(sources.map((s) => [s.id, s]));
  const rows: SourceBreakdownRow[] = [];
  for (const [id, b] of buckets) {
    const meta = known.get(id);
    rows.push({
      sourceId: id,
      key: meta?.key ?? UNSPECIFIED_SOURCE_ID,
      label: meta?.label ?? "לא צוין",
      // the NULL bucket takes the palette's neutral last entry, never a colour
      // that would read as a named channel
      color: meta
        ? sourceColor(meta.color, meta.rank)
        : sourceColor(null, sources.length),
      reservations: b.reservations.size,
      guests: b.guests,
      revenue: Math.round(b.revenueAgorot) / 100,
      sharePct: 0,
      channel: meta ? channelOf(meta.key) : "direct",
    });
  }

  const totals = {
    reservations: rows.reduce((a, r) => a + r.reservations, 0),
    guests: rows.reduce((a, r) => a + r.guests, 0),
    revenue: Math.round(rows.reduce((a, r) => a + Math.round(r.revenue * 100), 0)) / 100,
  };

  const denom = metric === "guests" ? totals.guests : totals.reservations;
  for (const r of rows) {
    const v = metric === "guests" ? r.guests : r.reservations;
    r.sharePct = denom > 0 ? Math.round((v / denom) * 1000) / 10 : 0;
  }

  // biggest first by the selected metric — the donut and the legend read in the
  // same order, always
  rows.sort((a, b) =>
    metric === "guests" ? b.guests - a.guests || b.revenue - a.revenue : b.reservations - a.reservations || b.revenue - a.revenue,
  );

  return { from, to, metric, rows, totals };
}
