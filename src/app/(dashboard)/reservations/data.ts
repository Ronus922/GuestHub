import "server-only";
import { sql } from "@/lib/db";
import type { Actor } from "@/lib/auth/actor";
import { addDays, todayInTz, type DateOnly } from "@/lib/dates";
import { paymentState, type PaymentState } from "@/lib/inventory-rules";

// ============================================================
// /reservations read model (D77 §17/§18) — bounded, tenant-scoped, one
// filtered page query + one tab-count aggregate. Lifecycle / workflow /
// payment stay three separate domains (§12): lifecycle = reservations.status,
// workflow = lookup_items JOIN (dynamic color, no hardcoded switch),
// payment = derived from the ledger aggregates via the canonical
// paymentState() — never inferred from workflow.
// ============================================================

export const LIST_LIMIT = 300;

/** lifecycle tabs (reference: הכל/מאושר/In House/יצא/בוטל + brief: No Show) */
export type ListTab = "all" | "confirmed" | "inhouse" | "out" | "cancelled" | "noshow";
const TAB_STATUS: Record<Exclude<ListTab, "all">, string> = {
  confirmed: "confirmed",
  inhouse: "checked_in",
  out: "checked_out",
  cancelled: "cancelled",
  noshow: "no_show",
};

export type QuickFilter =
  | "created24"
  | "cancelled24"
  | "pending"
  | "unpaid"
  | "partial"
  | "inhouse"
  | "arrivals"
  | "arrivals24"
  | "departures"
  | "missing_docs"
  | "invalid_card"
  | "cancelled_today"
  | "noshow_candidates";

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
  quick: QuickFilter | null;
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
export type QuickCounts = Record<QuickFilter, number>;

export type ReservationsListData = {
  rows: ListRow[];
  /** matching rows beyond LIST_LIMIT — 0 means the list is complete */
  truncatedBy: number;
  counts: TabCounts;
  /** chip badges — same predicates as the quick filters, counted tenant-wide */
  quickCounts: QuickCounts;
  today: DateOnly;
  currency: string;
};

export async function getReservationsList(
  actor: Actor,
  f: ListFilters,
): Promise<ReservationsListData> {
  const tenantId = actor.tenantId;
  const [tenant] = await sql<{ timezone: string; currency: string }[]>`
    SELECT timezone, currency FROM guesthub.tenants WHERE id = ${tenantId}`;
  const tz = tenant?.timezone || "Asia/Jerusalem";
  const today = todayInTz(tz);
  const dayAfter = addDays(today, 2);

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

  // quick filters — each one is a single honest predicate over canonical state
  const quick =
    f.quick === "created24"
      ? sql`AND res.created_at > now() - interval '24 hours'`
      : f.quick === "cancelled24"
        ? sql`AND res.status = 'cancelled' AND res.cancelled_at > now() - interval '24 hours'`
        : f.quick === "pending"
          ? sql`AND res.status = 'draft'`
          : f.quick === "unpaid"
            ? sql`AND res.paid_amount <= 0 AND res.total_price > 0 AND res.status <> 'cancelled'`
            : f.quick === "partial"
              ? sql`AND res.paid_amount > 0 AND res.paid_amount < res.total_price`
              : f.quick === "inhouse"
                ? sql`AND res.status = 'checked_in'`
                : f.quick === "arrivals"
                  ? sql`AND res.check_in = ${today} AND res.status <> 'cancelled'`
                  : f.quick === "arrivals24"
                    ? sql`AND res.check_in >= ${today} AND res.check_in < ${dayAfter} AND res.status <> 'cancelled'`
                    : f.quick === "departures"
                      ? sql`AND res.check_out = ${today} AND res.status <> 'cancelled'`
                      : f.quick === "missing_docs"
                        ? sql`AND wf.key = 'missing_docs'`
                        : f.quick === "invalid_card"
                          ? sql`AND (res.invalid_card_reported_at IS NOT NULL OR wf.key = 'card_declined')`
                          : f.quick === "cancelled_today"
                            ? sql`AND res.status = 'cancelled'
                                  AND (res.cancelled_at AT TIME ZONE ${tz})::date = ${today}`
                            : f.quick === "noshow_candidates"
                              ? sql`AND res.status = 'confirmed' AND res.check_in <= ${today}`
                              : sql``;

  const where = sql`
    res.tenant_id = ${tenantId}
    ${f.tab !== "all" ? sql`AND res.status = ${TAB_STATUS[f.tab]}` : sql``}
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
    ${
      f.payment === "unpaid"
        ? sql`AND res.paid_amount <= 0 AND res.total_price > 0`
        : f.payment === "partial"
          ? sql`AND res.paid_amount > 0 AND res.paid_amount < res.total_price`
          : f.payment === "paid"
            ? sql`AND res.total_price > 0 AND res.paid_amount >= res.total_price`
            : sql``
    }
    ${
      f.roomId
        ? sql`AND EXISTS (SELECT 1 FROM guesthub.reservation_rooms rr3
                           WHERE rr3.reservation_id = res.id AND rr3.room_id = ${f.roomId})`
        : sql``
    }
    ${f.cancellationOrigin ? sql`AND res.cancellation_origin = ${f.cancellationOrigin}` : sql``}
    ${quick}`;

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
           wf.label AS workflow_label, wf.color AS workflow_color,
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

  // tab counts — always over the FULL tenant dataset (reference behavior)
  const countRows = await sql<{ status: string; n: number }[]>`
    SELECT status, COUNT(*)::int AS n FROM guesthub.reservations
    WHERE tenant_id = ${tenantId}
    GROUP BY status`;

  // quick-chip badges — the SAME predicates as the quick filters above,
  // aggregated tenant-wide in one scan (reference shows a count on every chip)
  const [qc] = await sql<Record<QuickFilter, number>[]>`
    SELECT
      COUNT(*) FILTER (WHERE res.created_at > now() - interval '24 hours')::int AS created24,
      COUNT(*) FILTER (WHERE res.status = 'cancelled'
                         AND res.cancelled_at > now() - interval '24 hours')::int AS cancelled24,
      COUNT(*) FILTER (WHERE res.status = 'draft')::int AS pending,
      COUNT(*) FILTER (WHERE res.paid_amount <= 0 AND res.total_price > 0
                         AND res.status <> 'cancelled')::int AS unpaid,
      COUNT(*) FILTER (WHERE res.paid_amount > 0
                         AND res.paid_amount < res.total_price)::int AS partial,
      COUNT(*) FILTER (WHERE res.status = 'checked_in')::int AS inhouse,
      COUNT(*) FILTER (WHERE res.check_in = ${today}
                         AND res.status <> 'cancelled')::int AS arrivals,
      COUNT(*) FILTER (WHERE res.check_in >= ${today} AND res.check_in < ${dayAfter}
                         AND res.status <> 'cancelled')::int AS arrivals24,
      COUNT(*) FILTER (WHERE res.check_out = ${today}
                         AND res.status <> 'cancelled')::int AS departures,
      COUNT(*) FILTER (WHERE wf.key = 'missing_docs')::int AS missing_docs,
      COUNT(*) FILTER (WHERE res.invalid_card_reported_at IS NOT NULL
                         OR wf.key = 'card_declined')::int AS invalid_card,
      COUNT(*) FILTER (WHERE res.status = 'cancelled'
                         AND (res.cancelled_at AT TIME ZONE ${tz})::date = ${today})::int AS cancelled_today,
      COUNT(*) FILTER (WHERE res.status = 'confirmed'
                         AND res.check_in <= ${today})::int AS noshow_candidates
    FROM guesthub.reservations res
    LEFT JOIN guesthub.lookup_items wf ON wf.id = res.workflow_status_id
    WHERE res.tenant_id = ${tenantId}`;
  const byStatus = new Map(countRows.map((r) => [r.status, r.n]));
  const counts: TabCounts = {
    all: countRows.reduce((s, r) => s + r.n, 0),
    confirmed: byStatus.get("confirmed") ?? 0,
    inhouse: byStatus.get("checked_in") ?? 0,
    out: byStatus.get("checked_out") ?? 0,
    cancelled: byStatus.get("cancelled") ?? 0,
    noshow: byStatus.get("no_show") ?? 0,
  };

  return {
    rows: rows.map((r) => ({
      ...r,
      payment: paymentState(r.total_price, r.paid_amount),
      balance: Math.round((r.total_price - r.paid_amount) * 100) / 100,
    })),
    truncatedBy: Math.max(0, totalMatching - rows.length),
    counts,
    quickCounts: qc,
    today,
    currency: tenant?.currency || "ILS",
  };
}
