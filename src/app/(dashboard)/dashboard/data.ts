import "server-only";
import { sql } from "@/lib/db";
import type { DateOnly } from "@/lib/dates";
import { connectionHealth } from "@/lib/channel/connection-health";
import { INVENTORY_BLOCKING_STATUSES } from "@/lib/inventory-rules";
import { nightlyRevenue } from "@/lib/reports/nightly-revenue";
import { monthlyRevenue, type MonthlyRevenuePoint } from "@/lib/reports/monthly-revenue";
import { sourcesBreakdown, type SourcesBreakdown } from "@/lib/reports/sources-breakdown";
import { periodSpan } from "./period";

// ============================================================
// Dashboard Phase 2 — the read side of the live surfaces (KPI, arr, inh, hk,
// alr, rev, src, msg, rvw). One module, one round of queries, all scoped to
// the property's own day. iss / tsk / agd are untouched.
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
  kind: "unpaid" | "partial" | "card" | "approval" | "message" | "connection";
  severity: "red" | "amber";
  title: string;
  detail: string;
  href: string | null;
};

export type ConversationRow = {
  conversationId: string;
  guestName: string;
  channel: "beds24" | "whatsapp";
  /** "YYYY-MM-DD HH:MM" in the property's timezone; null on a thread with no messages */
  lastMessageAt: string | null;
  /** first 90 chars, truncated in SQL */
  lastMessageBody: string | null;
  lastMessageDirection: "inbound" | "outbound" | null;
  /** the thread's newest message is inbound — nothing was sent after it */
  hasUnreadInbound: boolean;
};

export type ReviewRow = {
  reviewId: string;
  guestName: string;
  /** the property-timezone day the review was submitted */
  submittedAt: DateOnly;
  /** 1..10, fractional (numeric(4,1) on the wire) */
  overallScore: number;
  /** first 90 chars; null on score-only reviews */
  positiveText: string | null;
  negativeText: string | null;
  /** reply IS NULL — no staff reply has been seen by the extranet poll yet */
  awaitingReply: boolean;
  /** resolved read-time via booking_id → reservations.ota_reservation_code; null when unmatched, which is the common case */
  reservationId: string | null;
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
  /** msg — the latest 6 threads by last activity */
  conversations: ConversationRow[];
  /** msg subtitle: threads across the WHOLE tenant whose newest message is inbound */
  unreadConversations: number;
  /** rvw — the latest 6 Booking.com reviews */
  reviews: ReviewRow[];
  /** rvw subtitle: reviews across the WHOLE tenant with no extranet reply yet */
  reviewsAwaitingReply: number;
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
    conversationRows,
    unreadCount,
    reviewRows,
    awaitingCount,
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

    // ---- msg: the six most recent threads, each with its latest message ----
    // The guest name resolves the way the thread itself does (076): the linked
    // reservation's primary guest first, then the guest_id the conversation
    // carries, then the house fallback. The LATERAL picks the newest message
    // for the preview; a thread with no messages is a renderable state.
    // Timestamps are formatted HERE, in the property's timezone — a client-side
    // new Date() would SSR in UTC and hydrate in browser time, and the two
    // renders would disagree.
    sql<Record<string, unknown>[]>`
      SELECT c.id AS conversation_id,
             COALESCE(NULLIF(TRIM(g.full_name), ''), 'אורח') AS guest_name,
             c.channel,
             to_char(c.last_message_at AT TIME ZONE tz.tzname, 'YYYY-MM-DD HH24:MI') AS last_message_at,
             left(m.body, 90) AS last_message_body,
             m.direction AS last_message_direction,
             (c.last_inbound_at IS NOT NULL
              AND c.last_inbound_at >= c.last_message_at) AS has_unread_inbound
        FROM guesthub.guest_conversations c
        CROSS JOIN (SELECT COALESCE(timezone, 'Asia/Jerusalem') AS tzname
                      FROM guesthub.tenants WHERE id = ${tenantId}) tz
        LEFT JOIN guesthub.reservations res
          ON res.id = c.reservation_id AND res.tenant_id = c.tenant_id
        LEFT JOIN guesthub.guests g
          ON g.tenant_id = c.tenant_id AND g.id = COALESCE(res.primary_guest_id, c.guest_id)
        LEFT JOIN LATERAL (
          SELECT gm.body, gm.direction
            FROM guesthub.guest_messages gm
           WHERE gm.tenant_id = c.tenant_id AND gm.conversation_id = c.id
           ORDER BY gm.sent_at DESC
           LIMIT 1) m ON true
       WHERE c.tenant_id = ${tenantId}
       ORDER BY c.last_message_at DESC NULLS LAST
       LIMIT 6`,

    // msg subtitle — "unread" is the denormalized stamps' cheap expression of
    // "an inbound with nothing sent after it": the single insert path maintains
    // both stamps with GREATEST, so last_inbound_at = last_message_at exactly
    // when the thread's newest message is inbound. A same-second tie counts as
    // unread — the safe direction for an attention counter. Neither wire
    // carries a read receipt, so this is answered-ness, not read-ness.
    sql<{ c: number }[]>`
      SELECT count(*)::int AS c
        FROM guesthub.guest_conversations
       WHERE tenant_id = ${tenantId}
         AND last_inbound_at IS NOT NULL
         AND last_inbound_at >= last_message_at`,

    // ---- rvw: the six most recent Booking.com reviews ---------------------
    // booking_id is BOOKING.COM's reservation number and joins
    // reservations.ota_reservation_code (076 header), NOT external_booking_id.
    // LATERAL + LIMIT 1 so a duplicated code can never fan one review into two
    // rows; an unmatched review is normal (most direct-era rows), not an error.
    sql<Record<string, unknown>[]>`
      SELECT r.id AS review_id,
             COALESCE(NULLIF(TRIM(r.guest_name), ''), 'אורח') AS guest_name,
             to_char(r.submitted_at AT TIME ZONE tz.tzname, 'YYYY-MM-DD') AS submitted_day,
             r.overall_score::float8 AS overall_score,
             left(r.positive_text, 90) AS positive_text,
             left(r.negative_text, 90) AS negative_text,
             (r.reply IS NULL) AS awaiting_reply,
             res.id AS reservation_id
        FROM guesthub.channel_reviews r
        CROSS JOIN (SELECT COALESCE(timezone, 'Asia/Jerusalem') AS tzname
                      FROM guesthub.tenants WHERE id = ${tenantId}) tz
        LEFT JOIN LATERAL (
          SELECT rr.id
            FROM guesthub.reservations rr
           WHERE rr.tenant_id = r.tenant_id AND rr.ota_reservation_code = r.booking_id
           LIMIT 1) res ON true
       WHERE r.tenant_id = ${tenantId}
       ORDER BY r.submitted_at DESC
       LIMIT 6`,

    // rvw subtitle — the same predicate as the 076 partial index (reply IS NULL)
    sql<{ c: number }[]>`
      SELECT count(*)::int AS c
        FROM guesthub.channel_reviews
       WHERE tenant_id = ${tenantId} AND reply IS NULL`,
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
    conversations: conversationRows.map((r) => ({
      conversationId: r.conversation_id as string,
      guestName: (r.guest_name as string) ?? "אורח",
      channel: r.channel as ConversationRow["channel"],
      lastMessageAt: (r.last_message_at as string) ?? null,
      lastMessageBody: (r.last_message_body as string) ?? null,
      lastMessageDirection:
        (r.last_message_direction as ConversationRow["lastMessageDirection"]) ?? null,
      hasUnreadInbound: r.has_unread_inbound === true,
    })),
    unreadConversations: unreadCount[0]?.c ?? 0,
    reviews: reviewRows.map((r) => ({
      reviewId: r.review_id as string,
      guestName: (r.guest_name as string) ?? "אורח",
      submittedAt: r.submitted_day as DateOnly,
      overallScore: Number(r.overall_score ?? 0),
      positiveText: (r.positive_text as string) ?? null,
      negativeText: (r.negative_text as string) ?? null,
      awaitingReply: r.awaiting_reply === true,
      reservationId: (r.reservation_id as string) ?? null,
    })),
    reviewsAwaitingReply: awaitingCount[0]?.c ?? 0,
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
  const [money, cards, approvals, messages, connections] = await Promise.all([
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
    // D133 — the INPUTS to the health verdict, never the verdict itself. The
    // rule lives in connection-health.ts so it can be asserted without a DB.
    //
    // SCOPE: `is_active_provider` alone. The old query also required
    // state='active', which made its own state condition unreachable — a row in
    // state='error' could never be selected to be reported as being in error.
    // `is_active_provider` is the house scope for "which connection IS the
    // one" (channel-release-actions.ts:86, beds24-booking-import.ts:139,
    // booking-com-reports-core.ts:242); state='active' belongs to the OUTBOUND
    // GATE ("may I push right now" — outbox.ts:48, rates-sync.ts:47-48), which
    // is a different question and is not asked here.
    //
    // `now` comes from the DATABASE, so every age below is measured against the
    // same clock that wrote the timestamps.
    sql<Record<string, unknown>[]>`
      SELECT c.state,
             (c.api_key_ciphertext IS NOT NULL) AS has_refresh_token,
             c.consecutive_failures,
             c.inbound_sync_enabled,
             c.circuit_open_until::text AS circuit_open_until,
             (SELECT max(j.finished_at)
                FROM guesthub.channel_sync_jobs j
               WHERE j.connection_id = c.id
                 AND j.job_type = 'pull_booking_revisions'
                 AND j.status = 'succeeded')::text AS last_pull_at,
             (SELECT max(w.beat_at) FROM guesthub.channel_worker_state w)::text AS worker_beat_at,
             now()::text AS db_now
        FROM guesthub.channel_connections c
       WHERE c.tenant_id = ${tenantId} AND c.provider = 'beds24'
         AND c.is_active_provider = true`,
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
  // D133 — six independently-labelled conditions, and ZERO is the normal state.
  // Nothing here reads the access token's expiry: it lives 24h and is re-minted
  // under 5 minutes, so any threshold on it is a constant, not an alert.
  for (const row of connections) {
    const ms = (v: unknown): number | null => {
      if (typeof v !== "string") return null;
      const t = Date.parse(v);
      return Number.isFinite(t) ? t : null;
    };
    const nowMs = ms(row.db_now) ?? Date.now();
    for (const f of connectionHealth(
      {
        state: String(row.state ?? ""),
        hasRefreshToken: row.has_refresh_token === true,
        consecutiveFailures: Number(row.consecutive_failures ?? 0),
        circuitOpenUntilMs: ms(row.circuit_open_until),
        inboundSyncEnabled: row.inbound_sync_enabled === true,
        lastSuccessfulPullMs: ms(row.last_pull_at),
        workerBeatMs: ms(row.worker_beat_at),
      },
      nowMs,
    )) {
      out.push({
        id: `connection-${f.code}`,
        kind: "connection",
        severity: f.severity,
        title: "חיבור Beds24",
        detail: f.detail,
        href: "/channels",
      });
    }
  }
  return out;
}
