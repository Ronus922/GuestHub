import "server-only";
import { sql } from "@/lib/db";
import type { Actor } from "@/lib/auth/actor";
import { addDays, todayInTz, type DateOnly } from "@/lib/dates";
import { paymentState, type RateRow } from "@/lib/inventory-rules";
import { sortRoomsByNumber } from "@/lib/rooms/sort";
import type {
  CalendarClosure,
  CalendarData,
  CalendarHold,
  CalendarKpis,
  CalendarRoom,
  CalendarStay,
} from "./types";

// Bounded, tenant-scoped calendar read model (§D/§AE): a handful of
// range-intersection queries for the visible window only — never one query
// per room/day, never the full reservation history.
const MAX_DAYS = 62;

export async function getCalendarData(
  actor: Actor,
  from: DateOnly,
  days: number,
): Promise<CalendarData> {
  const boundedDays = Math.min(Math.max(days, 1), MAX_DAYS);
  const to = addDays(from, boundedDays); // exclusive
  const tenantId = actor.tenantId;

  const [tenant] = await sql<{ timezone: string; currency: string }[]>`
    SELECT timezone, currency FROM guesthub.tenants WHERE id = ${tenantId}`;
  const today = todayInTz(tenant?.timezone || "Asia/Jerusalem");

  // Rooms are ordered ONCE, here, by the canonical numeric comparator (D86) —
  // every calendar surface (sticky room column, grid body, closures, prices,
  // drag targets) iterates this one array. The SQL ORDER BY only guarantees a
  // deterministic input for the stable sort below; it is NOT the visual order.
  // The old `a.sort_order NULLS LAST, r.room_number` grouped by area and then
  // string-sorted a text column, which is what produced the scrambled order.
  const roomRows = await sql<CalendarRoom[]>`
    SELECT r.id, r.room_number, r.name, r.floor, r.status, r.is_active,
           r.room_type_id, rt.name AS room_type_name, a.name AS area_name,
           COALESCE(rt.base_price, 0)::float8 AS base_price,
           r.max_occupancy
    FROM guesthub.rooms r
    LEFT JOIN guesthub.room_types rt ON rt.id = r.room_type_id
    LEFT JOIN guesthub.areas a ON a.id = r.area_id
    WHERE r.tenant_id = ${tenantId}
    ORDER BY r.room_number, r.id`;
  const rooms = sortRoomsByNumber(roomRows);

  // Every visible (non-cancelled) reservation-room intersecting the window.
  const stays = await sql<(Omit<CalendarStay, "payment"> & { total_price: number; paid_amount: number })[]>`
    SELECT rr.id AS rr_id, rr.reservation_id, rr.room_id,
           rr.check_in::text AS check_in, rr.check_out::text AS check_out,
           rr.adults, rr.children, rr.infants,
           res.status, res.reservation_number, res.is_vip,
           COALESCE(
             NULLIF(TRIM(CONCAT(rr.guest_first_name, ' ', rr.guest_last_name)), ''),
             g.full_name, 'אורח') AS guest_name,
           src.key AS source_key,
           wf.label AS workflow_label, wf.color AS workflow_color,
           res.total_price::float8 AS total_price,
           res.paid_amount::float8 AS paid_amount,
           (SELECT COUNT(*)::int FROM guesthub.reservation_rooms x
             WHERE x.reservation_id = rr.reservation_id) AS room_count
    FROM guesthub.reservation_rooms rr
    JOIN guesthub.reservations res ON res.id = rr.reservation_id
    LEFT JOIN guesthub.guests g ON g.id = res.primary_guest_id
    LEFT JOIN guesthub.lookup_items src ON src.id = res.source_id
    LEFT JOIN guesthub.lookup_items wf ON wf.id = res.workflow_status_id
    WHERE rr.tenant_id = ${tenantId}
      AND rr.room_id IS NOT NULL
      AND rr.check_in < ${to} AND rr.check_out > ${from}
      AND res.status <> 'cancelled'
    ORDER BY rr.check_in`;

  const closures = await sql<CalendarClosure[]>`
    SELECT id, room_id, start_date::text AS start_date, end_date::text AS end_date, reason
    FROM guesthub.room_closures
    WHERE tenant_id = ${tenantId}
      AND start_date < ${to} AND end_date > ${from}`;

  // Unassigned external-booking holds (§R) — lane renders only when non-empty.
  const holds = await sql<CalendarHold[]>`
    SELECT h.id, h.room_type_id, rt.name AS room_type_name,
           h.check_in::text AS check_in, h.check_out::text AS check_out,
           h.rooms_count, h.guest_name
    FROM guesthub.channel_inventory_holds h
    LEFT JOIN guesthub.room_types rt ON rt.id = h.room_type_id
    WHERE h.tenant_id = ${tenantId} AND h.status = 'active'
      AND h.check_in < ${to} AND h.check_out > ${from}`;

  // Rates for the empty-cell price/min-nights strip, from the canonical
  // commercial model (§0.4): each Sellable Unit's base-plan row is projected
  // onto its member room(s) (room_id set, room_type_id null) so the grid's
  // room-priority lookup is unchanged. min_nights carries min_stay_arrival.
  const rates = await sql<RateRow[]>`
    SELECT ppr.date::text AS date, sur.room_id, NULL::uuid AS room_type_id,
           ppr.price::float8 AS price, ppr.min_stay_arrival AS min_nights,
           ppr.max_stay AS max_nights, ppr.stop_sell AS closed,
           ppr.closed_to_arrival, ppr.closed_to_departure
    FROM guesthub.pricing_plan_rates ppr
    JOIN guesthub.pricing_plans bp ON bp.id = ppr.pricing_plan_id AND bp.is_base
    JOIN guesthub.sellable_unit_rooms sur ON sur.sellable_unit_id = ppr.sellable_unit_id
    WHERE ppr.tenant_id = ${tenantId}
      AND ppr.date >= ${from} AND ppr.date < ${to}`;

  const kpis = await getKpis(tenantId, today);

  return {
    today,
    from,
    days: boundedDays,
    rooms,
    stays: stays.map((s) => ({ ...s, payment: paymentState(s.total_price, s.paid_amount) })),
    closures,
    holds,
    rates,
    kpis,
    currency: tenant?.currency || "ILS",
  };
}

// KPI row (overview §10.2) — all from the DB, no mock.
async function getKpis(tenantId: string, today: DateOnly): Promise<CalendarKpis> {
  const yesterday = addDays(today, -1);
  const [row] = await sql<
    {
      arrivals: number;
      departures: number;
      guests_in_house: number;
      occupied_today: number;
      occupied_yesterday: number;
      sellable: number;
      closed_today: number;
      closed_yesterday: number;
    }[]
  >`
    SELECT
      (SELECT COUNT(DISTINCT rr.reservation_id)::int
         FROM guesthub.reservation_rooms rr
         JOIN guesthub.reservations r ON r.id = rr.reservation_id
        WHERE rr.tenant_id = ${tenantId} AND rr.check_in = ${today}
          AND r.status <> 'cancelled') AS arrivals,
      (SELECT COUNT(DISTINCT rr.reservation_id)::int
         FROM guesthub.reservation_rooms rr
         JOIN guesthub.reservations r ON r.id = rr.reservation_id
        WHERE rr.tenant_id = ${tenantId} AND rr.check_out = ${today}
          AND r.status <> 'cancelled') AS departures,
      (SELECT COALESCE(SUM(rr.adults + rr.children + rr.infants), 0)::int
         FROM guesthub.reservation_rooms rr
         JOIN guesthub.reservations r ON r.id = rr.reservation_id
        WHERE rr.tenant_id = ${tenantId}
          AND rr.check_in <= ${today} AND rr.check_out > ${today}
          AND r.status IN ('confirmed', 'checked_in')) AS guests_in_house,
      (SELECT COUNT(DISTINCT rr.room_id)::int
         FROM guesthub.reservation_rooms rr
         JOIN guesthub.reservations r ON r.id = rr.reservation_id
         JOIN guesthub.rooms rm ON rm.id = rr.room_id AND rm.status = 'available' AND rm.is_active
        WHERE rr.tenant_id = ${tenantId}
          AND rr.check_in <= ${today} AND rr.check_out > ${today}
          AND r.status = ANY (guesthub.inventory_blocking_statuses())) AS occupied_today,
      (SELECT COUNT(DISTINCT rr.room_id)::int
         FROM guesthub.reservation_rooms rr
         JOIN guesthub.reservations r ON r.id = rr.reservation_id
         JOIN guesthub.rooms rm ON rm.id = rr.room_id AND rm.status = 'available' AND rm.is_active
        WHERE rr.tenant_id = ${tenantId}
          AND rr.check_in <= ${yesterday} AND rr.check_out > ${yesterday}
          AND r.status = ANY (guesthub.inventory_blocking_statuses())) AS occupied_yesterday,
      (SELECT COUNT(*)::int FROM guesthub.rooms rm
        WHERE rm.tenant_id = ${tenantId} AND rm.status = 'available' AND rm.is_active) AS sellable,
      (SELECT COUNT(DISTINCT c.room_id)::int FROM guesthub.room_closures c
         JOIN guesthub.rooms rm ON rm.id = c.room_id AND rm.status = 'available' AND rm.is_active
        WHERE c.tenant_id = ${tenantId}
          AND c.start_date <= ${today} AND c.end_date > ${today}) AS closed_today,
      (SELECT COUNT(DISTINCT c.room_id)::int FROM guesthub.room_closures c
         JOIN guesthub.rooms rm ON rm.id = c.room_id AND rm.status = 'available' AND rm.is_active
        WHERE c.tenant_id = ${tenantId}
          AND c.start_date <= ${yesterday} AND c.end_date > ${yesterday}) AS closed_yesterday`;

  const sellableToday = Math.max(0, (row?.sellable ?? 0) - (row?.closed_today ?? 0));
  const sellableYesterday = Math.max(0, (row?.sellable ?? 0) - (row?.closed_yesterday ?? 0));
  const pct = sellableToday > 0 ? Math.round(((row?.occupied_today ?? 0) / sellableToday) * 100) : 0;
  const pctYesterday =
    sellableYesterday > 0 ? Math.round(((row?.occupied_yesterday ?? 0) / sellableYesterday) * 100) : 0;

  return {
    arrivalsToday: row?.arrivals ?? 0,
    departuresToday: row?.departures ?? 0,
    guestsInHouse: row?.guests_in_house ?? 0,
    occupiedToday: row?.occupied_today ?? 0,
    sellableToday,
    occupancyPct: pct,
    occupancyDeltaPct: pct - pctYesterday,
  };
}
