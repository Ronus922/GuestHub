import "server-only";
import { sql } from "@/lib/db";
import type { DateOnly } from "@/lib/dates";
import { INVENTORY_BLOCKING_STATUSES } from "@/lib/inventory-rules";
import { nightlyRevenue } from "@/lib/reports/nightly-revenue";
import { monthlyRevenue, type MonthlyRevenuePoint } from "@/lib/reports/monthly-revenue";
import { sourcesBreakdown, type SourcesBreakdown } from "@/lib/reports/sources-breakdown";
import { periodSpan } from "./period";

// ============================================================
// Dashboard Phase 2 — the read side of the five live surfaces (KPI, arr, inh,
// hk, alr). One module, one round of queries, all scoped to the property's own
// day. rev / src / rvw / msg / iss / tsk / agd are untouched.
//
// EVERY date here is the caller's `today`, which the page derives from
// todayInTz(tenants.timezone). Never new Date(), never the server's local day:
// the session runs in UTC, so between local midnight and ~03:00 a naive date
// names yesterday and the whole screen is off by one.
// ============================================================

const BLOCKING = INVENTORY_BLOCKING_STATUSES as readonly string[];

// Statuses that RENDER on the dashboard's people lists. Deliberately "not
// cancelled" rather than the blocking set: the departures column must keep
// showing a guest AFTER the check-out button is pressed (it becomes a green
// chip, DeshbordMain.md §4.1) — filtering to blocking statuses is exactly how
// the row would vanish the instant the operator acted on it. Since D126 the two
// sets coincide, which is precisely why this must be written explicitly: if
// checked_out ever leaves the blocking set again, this list must not follow.
const VISIBLE = sql`res.status <> 'cancelled'`;

export type KpiData = {
  /** occupied sellable rooms tonight */
  occupied: number;
  /** the denominator: rooms with status='available' AND is_active (D128) */
  sellable: number;
  occupancyPct: number;
  arrivals: number;
  departures: number;
  /** VAT-INCLUSIVE revenue for tonight */
  revenueTonight: number;
  /** how much of revenueTonight came from the even-split fallback */
  revenueFallback: number;
};

export type StayRow = {
  rrId: string;
  reservationId: string;
  guestName: string;
  isVip: boolean;
  roomNumber: string | null;
  roomTypeName: string | null;
  nights: number;
  status: string;
  /** HH:MM or null */
  expectedArrival: string | null;
  checkOut: DateOnly;
};

export type HousekeepingRow = {
  taskId: string;
  roomNumber: string | null;
  roomTypeName: string | null;
  guestName: string | null;
  /** the BOOKING's check_out_time, HH:MM — not the button-press moment */
  departedAt: string;
  /** HH:MM of the next arrival in this room today, or null */
  nextArrival: string | null;
  status: string;
  cleanedByName: string | null;
};

export type AlertRow = {
  id: string;
  kind: "unpaid" | "partial" | "card" | "approval" | "message" | "token";
  severity: "red" | "amber";
  title: string;
  detail: string;
  href: string | null;
};

/** design §4.2: the chart's range is 6–12; 12 is the default */
export const CHART_MONTHS = 12;

export type DashboardData = {
  kpi: KpiData;
  /** rev — the last CHART_MONTHS calendar months */
  monthly: MonthlyRevenuePoint[];
  /** src — the CURRENT month, the same call the drawer makes */
  sources: SourcesBreakdown;
  arrivals: StayRow[];
  departures: StayRow[];
  inHouse: StayRow[];
  housekeeping: HousekeepingRow[];
  alerts: AlertRow[];
};

const hhmm = (t: string | null): string | null => (t ? t.slice(0, 5) : null);

// One row PER ROOM, not per reservation. The reservations list aggregates rooms
// into a "101, 102, 103" string, which the design's row anatomy
// ("חדר · סוג · N לילות") has no shape for — a three-room booking is three
// rooms to walk to. The room type is joined here; no existing query joins it.
function stayRows(tenantId: string, where: ReturnType<typeof sql>) {
  return sql<Record<string, unknown>[]>`
    SELECT rr.id AS rr_id,
           res.id AS reservation_id,
           COALESCE(NULLIF(TRIM(CONCAT(rr.guest_first_name, ' ', rr.guest_last_name)), ''),
                    g.full_name, 'אורח') AS guest_name,
           res.is_vip,
           rm.room_number,
           rt.name AS room_type_name,
           (rr.check_out - rr.check_in)::int AS nights,
           res.status,
           res.expected_arrival_time::text AS expected_arrival_time,
           rr.check_out::text AS check_out
      FROM guesthub.reservation_rooms rr
      JOIN guesthub.reservations res ON res.id = rr.reservation_id AND res.tenant_id = rr.tenant_id
      LEFT JOIN guesthub.guests g ON g.id = res.primary_guest_id AND g.tenant_id = res.tenant_id
      LEFT JOIN guesthub.rooms rm ON rm.id = rr.room_id AND rm.tenant_id = rr.tenant_id
      LEFT JOIN guesthub.room_types rt ON rt.id = rm.room_type_id AND rt.tenant_id = rm.tenant_id
     WHERE rr.tenant_id = ${tenantId} AND ${VISIBLE} AND ${where}
     ORDER BY rm.room_number NULLS LAST, guest_name`;
}

const toStay = (r: Record<string, unknown>): StayRow => ({
  rrId: r.rr_id as string,
  reservationId: r.reservation_id as string,
  guestName: (r.guest_name as string) ?? "אורח",
  isVip: Boolean(r.is_vip),
  roomNumber: (r.room_number as string) ?? null,
  roomTypeName: (r.room_type_name as string) ?? null,
  nights: Number(r.nights ?? 0),
  status: r.status as string,
  expectedArrival: hhmm((r.expected_arrival_time as string) ?? null),
  checkOut: r.check_out as DateOnly,
});

export async function getDashboardData(tenantId: string, today: DateOnly): Promise<DashboardData> {
  // "tonight" is the single night [today, today+1) — hotel-night semantics, the
  // same half-open window every other date range in this codebase uses
  const tomorrow = addOneDay(today);
  // the src window shows the CURRENT month — the drawer's default period, so
  // opening it does not change the numbers the operator was just looking at
  const monthSpan = periodSpan(today, "month");

  const [
    occupancy,
    arrivalRows,
    departureRows,
    inHouseRows,
    hkRows,
    revenue,
    alerts,
    monthly,
    sources,
  ] = await Promise.all([
    // ---- KPI 1: occupancy tonight -----------------------------------------
    // D128 — the denominator is `status='available' AND is_active`, the SAME
    // predicate room_type_inventory, available-rooms.ts and rates/rules.ts
    // compile. Read from `rooms` DIRECTLY rather than through
    // room_type_inventory, because that function counts only rooms with a
    // room_type_id: a room saved without a type would silently leave the
    // denominator. Zero such rows today — this keeps it that way by not caring.
    sql<{ sellable: number; occupied: number }[]>`
      WITH sellable AS (
        SELECT id FROM guesthub.rooms
         WHERE tenant_id = ${tenantId} AND status = 'available' AND is_active
      )
      SELECT (SELECT count(*)::int FROM sellable) AS sellable,
             (SELECT count(DISTINCT rr.room_id)::int
                FROM guesthub.reservation_rooms rr
                JOIN guesthub.reservations res
                  ON res.id = rr.reservation_id AND res.tenant_id = rr.tenant_id
               WHERE rr.tenant_id = ${tenantId}
                 AND rr.room_id IN (SELECT id FROM sellable)
                 AND res.status = ANY(${BLOCKING})
                 AND rr.check_in <= ${today} AND rr.check_out > ${today}) AS occupied`,

    // ---- arr: arrivals ----------------------------------------------------
    stayRows(tenantId, sql`rr.check_in = ${today}`),
    // ---- arr: departures --------------------------------------------------
    stayRows(tenantId, sql`rr.check_out = ${today}`),
    // ---- inh: in-house tonight -------------------------------------------
    // A DATE predicate, not `status = 'checked_in'`. "Who is physically in the
    // building tonight" is answered by the dates; the lifecycle status answers
    // "who did reception process", and zero rows carried checked_in when this
    // was built — the window would have rendered permanently empty.
    stayRows(tenantId, sql`rr.check_in <= ${today} AND rr.check_out > ${today}`),

    // ---- hk: rooms to clean ----------------------------------------------
    sql<Record<string, unknown>[]>`
      SELECT h.id AS task_id, h.status,
             rm.room_number, rt.name AS room_type_name,
             COALESCE(g.full_name, 'אורח') AS guest_name,
             -- the BOOKING's checkout time (default 11:00), NOT
             -- housekeeping_tasks.checkout_time, which holds now() at the moment
             -- the button was pressed — the operator's click, not the departure
             res.check_out_time::text AS departed_at,
             u.full_name AS cleaned_by_name,
             (SELECT COALESCE(nx.expected_arrival_time, nx.check_in_time)::text
                FROM guesthub.reservation_rooms nrr
                JOIN guesthub.reservations nx
                  ON nx.id = nrr.reservation_id AND nx.tenant_id = nrr.tenant_id
               WHERE nrr.tenant_id = h.tenant_id AND nrr.room_id = h.room_id
                 AND nrr.check_in = ${today} AND nx.status <> 'cancelled'
               ORDER BY COALESCE(nx.expected_arrival_time, nx.check_in_time)
               LIMIT 1) AS next_arrival
        FROM guesthub.housekeeping_tasks h
        LEFT JOIN guesthub.rooms rm ON rm.id = h.room_id AND rm.tenant_id = h.tenant_id
        LEFT JOIN guesthub.room_types rt ON rt.id = rm.room_type_id AND rt.tenant_id = rm.tenant_id
        LEFT JOIN guesthub.reservations res ON res.id = h.reservation_id AND res.tenant_id = h.tenant_id
        LEFT JOIN guesthub.guests g ON g.id = res.primary_guest_id AND g.tenant_id = res.tenant_id
        LEFT JOIN guesthub.users u ON u.id = h.assigned_to
       WHERE h.tenant_id = ${tenantId}
         AND h.task_type = 'housekeeping'
         AND (
           h.status IN ('pending', 'in_progress')
           -- keep TODAY's finished ones visible so the row can become the green
           -- "נקי" chip instead of disappearing under the operator's hand
           OR (h.status IN ('completed', 'inspected') AND h.completed_at::date = ${today})
         )
       ORDER BY (h.status IN ('completed','inspected')), rm.room_number NULLS LAST`,

    // ---- KPI 4: expected revenue tonight ----------------------------------
    nightlyRevenue(tenantId, today, tomorrow),

    // ---- alr: the curated signals ----------------------------------------
    dashboardAlerts(tenantId),

    // ---- rev: one pass over the last 12 calendar months -------------------
    monthlyRevenue(tenantId, today, CHART_MONTHS),

    // ---- src: the current month, shared with the drawer -------------------
    sourcesBreakdown(tenantId, monthSpan.from, monthSpan.to, "guests"),
  ]);

  const tonight = revenue.days[0];

  const sellable = occupancy[0]?.sellable ?? 0;
  const occupied = occupancy[0]?.occupied ?? 0;

  const arrivals = arrivalRows.map(toStay);
  const departures = departureRows.map(toStay);

  return {
    kpi: {
      occupied,
      sellable,
      occupancyPct: sellable > 0 ? Math.round((occupied / sellable) * 1000) / 10 : 0,
      arrivals: arrivals.length,
      departures: departures.length,
      revenueTonight: tonight?.revenue ?? 0,
      revenueFallback: tonight?.fallbackRevenue ?? 0,
    },
    arrivals,
    departures,
    monthly,
    sources,
    inHouse: inHouseRows.map(toStay),
    housekeeping: hkRows.map((r) => ({
      taskId: r.task_id as string,
      roomNumber: (r.room_number as string) ?? null,
      roomTypeName: (r.room_type_name as string) ?? null,
      guestName: (r.guest_name as string) ?? null,
      // DeshbordMain.md §4.3 defaults: missing departure → 11:00
      departedAt: hhmm((r.departed_at as string) ?? null) ?? "11:00",
      // …missing arrival → 14:30, but only when there IS an arrival today
      nextArrival: r.next_arrival ? (hhmm(r.next_arrival as string) ?? "14:30") : null,
      status: r.status as string,
      cleanedByName: (r.cleaned_by_name as string) ?? null,
    })),
    alerts,
  };
}

function addOneDay(d: DateOnly): DateOnly {
  const t = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)) + 1);
  return new Date(t).toISOString().slice(0, 10) as DateOnly;
}

// ============================================================
// alr — CURATED, not exhaustive. Only signals a GUEST feels.
//
// EXCLUDED DELIBERATELY:
//  · channel_dirty_ranges — 1,041 permanent rows (audit §7.1). It is an
//    operational backlog, not a guest-facing alert, and it would be the
//    window's permanent top line, drowning every real signal beneath it.
//  · "חוסר מלאי" — the schema has no stock concept at all (contradiction 15).
//    A row with no source is a lie with a nice icon.
//
// The live counts are low and the window will look sparse. That is the honest
// state of the property, and padding it would make the sparse case unreadable
// when it matters.
// ============================================================
async function dashboardAlerts(tenantId: string): Promise<AlertRow[]> {
  const [money, cards, approvals, messages, tokens] = await Promise.all([
    sql<Record<string, unknown>[]>`
      SELECT res.id, res.reservation_number, COALESCE(g.full_name, 'אורח') AS guest_name,
             res.total_price::float8 AS total_price, res.paid_amount::float8 AS paid_amount
        FROM guesthub.reservations res
        LEFT JOIN guesthub.guests g ON g.id = res.primary_guest_id AND g.tenant_id = res.tenant_id
        LEFT JOIN guesthub.lookup_items wf ON wf.id = res.workflow_status_id
       WHERE res.tenant_id = ${tenantId}
         AND res.status <> 'cancelled'
         AND res.total_price > 0
         AND res.paid_amount < res.total_price
         AND COALESCE(wf.key, '') <> 'approved'
       ORDER BY res.check_in
       LIMIT 20`,
    sql<Record<string, unknown>[]>`
      SELECT res.id, res.reservation_number, COALESCE(g.full_name, 'אורח') AS guest_name
        FROM guesthub.reservations res
        LEFT JOIN guesthub.guests g ON g.id = res.primary_guest_id AND g.tenant_id = res.tenant_id
        LEFT JOIN guesthub.lookup_items wf ON wf.id = res.workflow_status_id
       WHERE res.tenant_id = ${tenantId}
         AND res.status <> 'cancelled'
         AND (res.invalid_card_reported_at IS NOT NULL OR wf.key = 'card_declined')
       ORDER BY res.check_in
       LIMIT 20`,
    sql<Record<string, unknown>[]>`
      SELECT res.id, res.reservation_number, COALESCE(g.full_name, 'אורח') AS guest_name
        FROM guesthub.reservations res
        LEFT JOIN guesthub.guests g ON g.id = res.primary_guest_id AND g.tenant_id = res.tenant_id
        LEFT JOIN guesthub.lookup_items wf ON wf.id = res.workflow_status_id
       WHERE res.tenant_id = ${tenantId}
         AND (res.status = 'draft' OR wf.key = 'pending')
         AND res.status <> 'cancelled'
       ORDER BY res.check_in
       LIMIT 20`,
    sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM guesthub.outbound_messages
       WHERE tenant_id = ${tenantId} AND status IN ('failed', 'undelivered')`,
    sql<{ expires_at: string | null }[]>`
      SELECT access_token_expires_at::text AS expires_at
        FROM guesthub.channel_connections
       WHERE tenant_id = ${tenantId} AND provider = 'beds24'
         AND state = 'active' AND is_active_provider = true
         AND access_token_expires_at IS NOT NULL
         AND access_token_expires_at <= now() + interval '24 hours'`,
  ]);

  const out: AlertRow[] = [];
  for (const r of money) {
    const paid = Number(r.paid_amount ?? 0);
    const unpaid = paid <= 0;
    out.push({
      id: `money-${r.id as string}`,
      kind: unpaid ? "unpaid" : "partial",
      severity: unpaid ? "red" : "amber",
      title: `${r.guest_name as string} · הזמנה ${r.reservation_number as string}`,
      detail: unpaid
        ? `טרם שולם · ₪${Math.round(Number(r.total_price ?? 0)).toLocaleString("he-IL")}`
        : `שולם חלקית · יתרה ₪${Math.round(Number(r.total_price ?? 0) - paid).toLocaleString("he-IL")}`,
      href: `/reservations?open=${r.id as string}`,
    });
  }
  for (const r of cards) {
    out.push({
      id: `card-${r.id as string}`,
      kind: "card",
      severity: "red",
      title: `${r.guest_name as string} · הזמנה ${r.reservation_number as string}`,
      detail: "כרטיס אשראי נדחה או אינו תקין",
      href: `/reservations?open=${r.id as string}`,
    });
  }
  for (const r of approvals) {
    out.push({
      id: `approval-${r.id as string}`,
      kind: "approval",
      severity: "amber",
      title: `${r.guest_name as string} · הזמנה ${r.reservation_number as string}`,
      detail: "ממתינה לאישור",
      href: `/reservations?open=${r.id as string}`,
    });
  }
  const failed = messages[0]?.c ?? 0;
  if (failed > 0) {
    out.push({
      id: "messages-failed",
      kind: "message",
      severity: "red",
      title: "הודעות שלא נשלחו",
      detail: `${failed} הודעות יוצאות נכשלו`,
      href: "/communications",
    });
  }
  if (tokens.length > 0) {
    out.push({
      id: "beds24-token",
      kind: "token",
      severity: "amber",
      title: "חיבור Beds24",
      detail: "תוקף ההרשאה פג או עומד לפוג — הסנכרון ייעצר",
      href: "/channels",
    });
  }
  return out;
}
