import "server-only";
import { sql } from "@/lib/db";
import type { Actor } from "@/lib/auth/actor";
import { todayInTz, type DateOnly } from "@/lib/dates";
import { displayPaymentState, type PaymentState } from "@/lib/inventory-rules";

// ============================================================
// /reservations read model (D77 §17/§18) — bounded, tenant-scoped, one
// filtered page query + one tab-count aggregate. Lifecycle / workflow /
// payment stay three separate domains (§12): lifecycle = reservations.status,
// workflow = lookup_items JOIN (dynamic color, no hardcoded switch),
// payment = derived from the ledger aggregates via the canonical
// paymentState() — never inferred from workflow.
// ============================================================

export const LIST_LIMIT = 300;

// ---- the ONE tab axis ----
// Lifecycle tabs and the old "quick filters" are the SAME control now: one
// unified bar, one selection, one URL param (?tab=). There is no second
// filter state — selecting a tab replaces the previous one, and `all` clears.
// Every tab below is exactly one predicate over canonical state (TAB_WHERE),
// and its badge is counted from that same predicate (no parallel count path).
export const TABS = [
  "all",
  "inhouse",
  "cancelled",
  "noshow",
  "created24",
  "arrivals",
  "departures",
  "cancelled24",
  "unpaid",
  "partial",
  "pending",
  "missing_docs",
  "invalid_card",
] as const;

export type ListTab = (typeof TABS)[number];

export const isListTab = (v: string | undefined): v is ListTab =>
  !!v && (TABS as readonly string[]).includes(v);

export type ListFilters = {
  tab: ListTab;
  q: string;
  dateType: "checkin" | "checkout" | "created";
  from: DateOnly | null;
  to: DateOnly | null;
  sourceId: string | null;
  workflowId: string | null;
  payment: "unpaid" | "partial" | "paid" | null;
  roomId: string | null;
  cancellationOrigin: string | null;
};

export type ListRow = {
  id: string;
  reservation_number: string;
  status: string;
  check_in: string;
  check_out: string;
  nights: number;
  total_price: number;
  paid_amount: number;
  currency: string;
  created_at: string;
  is_vip: boolean;
  ota_reservation_code: string | null;
  ota_name: string | null;
  is_ota: boolean;
  guest_name: string;
  guest_phone: string | null;
  source_label: string | null;
  workflow_key: string | null;
  workflow_label: string | null;
  workflow_color: string | null;
  rooms_label: string | null;
  cancelled_at: string | null;
  cancelled_by_type: string | null;
  cancelled_by_name: string | null;
  cancellation_origin: string | null;
  cancellation_reason: string | null;
  payment: PaymentState;
  balance: number;
};

export type TabCounts = Record<ListTab, number>;

export type ReservationsListData = {
  rows: ListRow[];
  /** matching rows beyond LIST_LIMIT — 0 means the list is complete */
  truncatedBy: number;
  /** one badge per tab — counted from the SAME predicate that filters the list */
  counts: TabCounts;
  today: DateOnly;
  currency: string;
};

// ---- the ONE predicate per tab ----
// Used TWICE and defined ONCE: it filters the list (WHERE) and it counts the
// badge (COUNT(*) FILTER). A tab therefore cannot show a badge that disagrees
// with the rows it opens. `all` has no predicate — it IS the unfiltered query.
// `wf` is the workflow-status join present in both queries below.
function tabPredicates(today: DateOnly) {
  return {
    all: null,
    inhouse: sql`res.status = 'checked_in'`,
    cancelled: sql`res.status = 'cancelled'`,
    noshow: sql`res.status = 'no_show'`,
    created24: sql`res.created_at > now() - interval '24 hours'`,
    arrivals: sql`res.check_in = ${today} AND res.status <> 'cancelled'`,
    departures: sql`res.check_out = ${today} AND res.status <> 'cancelled'`,
    // rolling 24-hour window — NOT "since midnight"
    cancelled24: sql`res.status = 'cancelled'
                     AND res.cancelled_at > now() - interval '24 hours'`,
    // D89: רק סטטוס עבודה "הזמנה אושרה" נחשב משולם — לא מופיע בטאבי החוב
    unpaid: sql`res.paid_amount <= 0 AND res.total_price > 0
                AND res.status <> 'cancelled'
                AND COALESCE(wf.key, '') <> 'approved'`,
    partial: sql`res.paid_amount > 0 AND res.paid_amount < res.total_price
                 AND COALESCE(wf.key, '') <> 'approved'`,
    pending: sql`res.status = 'draft'`,
    missing_docs: sql`wf.key = 'missing_docs'`,
    invalid_card: sql`(res.invalid_card_reported_at IS NOT NULL
                       OR wf.key = 'card_declined')`,
  } satisfies Record<ListTab, ReturnType<typeof sql> | null>;
}

export async function getReservationsList(
  actor: Actor,
  f: ListFilters,
): Promise<ReservationsListData> {
  const tenantId = actor.tenantId;
  const [tenant] = await sql<{ timezone: string; currency: string }[]>`
    SELECT timezone, currency FROM guesthub.tenants WHERE id = ${tenantId}`;
  const tz = tenant?.timezone || "Asia/Jerusalem";
  const today = todayInTz(tz);
  const P = tabPredicates(today);

  const like = f.q.trim() ? `%${f.q.trim()}%` : null;
  // timestamptz → date must happen in the PROPERTY timezone (the session is
  // UTC): otherwise anything between local midnight and ~03:00 lands on the
  // wrong day relative to todayInTz
  const dateCol =
    f.dateType === "checkout"
      ? sql`res.check_out`
      : f.dateType === "created"
        ? sql`(res.created_at AT TIME ZONE ${tz})::date`
        : sql`res.check_in`;

  const tab = P[f.tab];

  const where = sql`
    res.tenant_id = ${tenantId}
    ${tab ? sql`AND (${tab})` : sql``}
    ${
      like
        ? sql`AND (res.reservation_number ILIKE ${like}
                OR res.ota_reservation_code ILIKE ${like}
                OR res.external_unique_id ILIKE ${like}
                OR g.full_name ILIKE ${like}
                OR g.phone ILIKE ${like}
                OR g.email ILIKE ${like}
                OR EXISTS (SELECT 1 FROM guesthub.reservation_rooms rr2
                             JOIN guesthub.rooms r2 ON r2.id = rr2.room_id
                            WHERE rr2.reservation_id = res.id
                              AND r2.room_number ILIKE ${like}))`
        : sql``
    }
    ${f.from ? sql`AND ${dateCol} >= ${f.from}` : sql``}
    ${f.to ? sql`AND ${dateCol} <= ${f.to}` : sql``}
    ${f.sourceId ? sql`AND res.source_id = ${f.sourceId}` : sql``}
    ${f.workflowId ? sql`AND res.workflow_status_id = ${f.workflowId}` : sql``}
    ${/* D89: פילטר התשלום מיושר לאותו כלל — רק "הזמנה אושרה" = שולם */ sql``}
    ${
      f.payment === "unpaid"
        ? sql`AND res.paid_amount <= 0 AND res.total_price > 0
              AND COALESCE(wf.key, '') <> 'approved'`
        : f.payment === "partial"
          ? sql`AND res.paid_amount > 0 AND res.paid_amount < res.total_price
                AND COALESCE(wf.key, '') <> 'approved'`
          : f.payment === "paid"
            ? sql`AND (wf.key = 'approved'
                   OR (res.total_price > 0 AND res.paid_amount >= res.total_price))`
            : sql``
    }
    ${
      f.roomId
        ? sql`AND EXISTS (SELECT 1 FROM guesthub.reservation_rooms rr3
                           WHERE rr3.reservation_id = res.id AND rr3.room_id = ${f.roomId})`
        : sql``
    }
    ${f.cancellationOrigin ? sql`AND res.cancellation_origin = ${f.cancellationOrigin}` : sql``}`;

  const rows = await sql<(Omit<ListRow, "payment" | "balance"> & { total_count: number })[]>`
    SELECT res.id, res.reservation_number, res.status,
           res.check_in::text AS check_in, res.check_out::text AS check_out,
           (res.check_out - res.check_in)::int AS nights,
           res.total_price::float8 AS total_price,
           res.paid_amount::float8 AS paid_amount,
           res.currency,
           res.created_at::text AS created_at,
           res.is_vip,
           res.ota_reservation_code, res.ota_name,
           (res.channel_connection_id IS NOT NULL) AS is_ota,
           COALESCE(g.full_name, 'אורח') AS guest_name,
           g.phone AS guest_phone,
           src.label AS source_label,
           wf.key AS workflow_key, wf.label AS workflow_label, wf.color AS workflow_color,
           (SELECT string_agg(COALESCE(r.room_number, '—'), ', ' ORDER BY r.room_number)
              FROM guesthub.reservation_rooms rr
              LEFT JOIN guesthub.rooms r ON r.id = rr.room_id
             WHERE rr.reservation_id = res.id) AS rooms_label,
           res.cancelled_at::text AS cancelled_at,
           res.cancelled_by_type,
           cu.full_name AS cancelled_by_name,
           res.cancellation_origin, res.cancellation_reason,
           COUNT(*) OVER ()::int AS total_count
    FROM guesthub.reservations res
    LEFT JOIN guesthub.guests g ON g.id = res.primary_guest_id
    LEFT JOIN guesthub.lookup_items src ON src.id = res.source_id
    LEFT JOIN guesthub.lookup_items wf ON wf.id = res.workflow_status_id
    LEFT JOIN guesthub.users cu ON cu.id = res.cancelled_by_user_id
    WHERE ${where}
    ORDER BY ${f.tab === "cancelled" ? sql`res.cancelled_at DESC NULLS LAST,` : sql``}
             res.check_in DESC, res.created_at DESC
    LIMIT ${LIST_LIMIT}`;

  const totalMatching = rows[0]?.total_count ?? 0;

  // ONE badge aggregate for the ONE bar — every tab counted from the SAME
  // predicate that filters it (P above), tenant-wide, in a single scan.
  // `all` is COUNT(*) — by construction the total of the unfiltered query.
  const [counts] = await sql<TabCounts[]>`
    SELECT
      COUNT(*)::int                                     AS "all",
      COUNT(*) FILTER (WHERE ${P.inhouse})::int         AS inhouse,
      COUNT(*) FILTER (WHERE ${P.cancelled})::int       AS cancelled,
      COUNT(*) FILTER (WHERE ${P.noshow})::int          AS noshow,
      COUNT(*) FILTER (WHERE ${P.created24})::int       AS created24,
      COUNT(*) FILTER (WHERE ${P.arrivals})::int        AS arrivals,
      COUNT(*) FILTER (WHERE ${P.departures})::int      AS departures,
      COUNT(*) FILTER (WHERE ${P.cancelled24})::int     AS cancelled24,
      COUNT(*) FILTER (WHERE ${P.unpaid})::int          AS unpaid,
      COUNT(*) FILTER (WHERE ${P.partial})::int         AS partial,
      COUNT(*) FILTER (WHERE ${P.pending})::int         AS pending,
      COUNT(*) FILTER (WHERE ${P.missing_docs})::int    AS missing_docs,
      COUNT(*) FILTER (WHERE ${P.invalid_card})::int    AS invalid_card
    FROM guesthub.reservations res
    LEFT JOIN guesthub.lookup_items wf ON wf.id = res.workflow_status_id
    WHERE res.tenant_id = ${tenantId}`;

  return {
    rows: rows.map((r) => {
      // D89: רק "הזמנה אושרה" (workflow) מוצגת כ"שולם" ויתרה 0; ה-ledger לא משתנה
      const payment = displayPaymentState(r.workflow_key, r.total_price, r.paid_amount);
      return {
        ...r,
        payment,
        balance:
          payment === "paid" ? 0 : Math.round((r.total_price - r.paid_amount) * 100) / 100,
      };
    }),
    truncatedBy: Math.max(0, totalMatching - rows.length),
    counts,
    today,
    currency: tenant?.currency || "ILS",
  };
}
