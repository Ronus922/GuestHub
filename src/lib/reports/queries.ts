import "server-only";
import { sql } from "@/lib/db";
import { INVENTORY_BLOCKING_STATUSES } from "@/lib/inventory-rules";

// ============================================================
// PMS reports (Stage 5 §11) — safe, server-side, read-only, tenant-scoped
// aggregations over reliable canonical data (reservations, payments, the
// inventory functions). Every function is a pure SELECT: no mutation, no side
// effect. Only reports whose underlying data is trustworthy are implemented;
// see PMS_CAPABILITY_MATRIX.md for what is deferred and why.
// ============================================================

const BLOCKING = INVENTORY_BLOCKING_STATUSES;

export type ArrivalRow = {
  reservationId: string; reservationNumber: string; guestName: string | null;
  rooms: string | null; checkIn: string; checkOut: string; status: string;
  balance: number; otaName: string | null;
};

// Arrivals on a given property-local date (stays that check in that day).
export async function arrivalsReport(tenantId: string, date: string): Promise<ArrivalRow[]> {
  return stayList(tenantId, sql`r.check_in = ${date}`);
}
// Departures on a given date (stays that check out that day).
export async function departuresReport(tenantId: string, date: string): Promise<ArrivalRow[]> {
  return stayList(tenantId, sql`r.check_out = ${date}`);
}
// In-house on a given date (checked-in stays spanning the night).
export async function inHouseReport(tenantId: string, date: string): Promise<ArrivalRow[]> {
  return stayList(tenantId, sql`r.check_in <= ${date} AND r.check_out > ${date}`);
}

async function stayList(tenantId: string, dateWhere: ReturnType<typeof sql>): Promise<ArrivalRow[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT r.id, r.reservation_number, g.full_name AS guest_name,
           r.check_in::text AS check_in, r.check_out::text AS check_out, r.status,
           r.balance::float8 AS balance, r.ota_name,
           (SELECT string_agg(DISTINCT rm.room_number, ', ')
              FROM guesthub.reservation_rooms rr
              LEFT JOIN guesthub.rooms rm ON rm.id = rr.room_id AND rm.tenant_id = rr.tenant_id
              WHERE rr.reservation_id = r.id AND rr.tenant_id = r.tenant_id) AS rooms
    FROM guesthub.reservations r
    LEFT JOIN guesthub.guests g ON g.id = r.primary_guest_id AND g.tenant_id = r.tenant_id
    WHERE r.tenant_id = ${tenantId} AND r.status = ANY(${BLOCKING}) AND ${dateWhere}
    ORDER BY r.check_in, r.reservation_number`;
  return rows.map((r) => ({
    reservationId: r.id as string, reservationNumber: r.reservation_number as string,
    guestName: (r.guest_name as string) ?? null, rooms: (r.rooms as string) ?? null,
    checkIn: r.check_in as string, checkOut: r.check_out as string, status: r.status as string,
    balance: Number(r.balance ?? 0), otaName: (r.ota_name as string) ?? null,
  }));
}

export type OccupancyReport = {
  from: string; to: string;
  roomNights: number; occupiedNights: number; occupancyPct: number;
};

// Occupancy over [from, to) using the canonical room_type_inventory projection
// (the same physical truth the calendar and ARI use). occupancyPct = occupied /
// sellable room-nights.
export async function occupancyReport(tenantId: string, from: string, to: string): Promise<OccupancyReport> {
  const [row] = await sql<{ sellable: number; occupied: number }[]>`
    SELECT COALESCE(SUM(sellable_rooms),0)::float8 AS sellable,
           COALESCE(SUM(occupied_rooms),0)::float8 AS occupied
    FROM guesthub.room_type_inventory(${tenantId}, ${from}, ${to})`;
  const sellable = Number(row?.sellable ?? 0);
  const occupied = Number(row?.occupied ?? 0);
  return {
    from, to, roomNights: sellable, occupiedNights: occupied,
    occupancyPct: sellable > 0 ? Math.round((occupied / sellable) * 1000) / 10 : 0,
  };
}

export type RevenueReport = {
  from: string; to: string;
  reservations: number; roomNights: number; roomRevenue: number; adr: number;
};

// Revenue + ADR for stays overlapping [from, to). Room revenue is the reservation
// room total; ADR = room revenue / room-nights. Uses confirmed+ stays only.
export async function revenueReport(tenantId: string, from: string, to: string): Promise<RevenueReport> {
  const [row] = await sql<{ res: number; nights: number; revenue: number }[]>`
    SELECT count(DISTINCT r.id)::float8 AS res,
           COALESCE(SUM((LEAST(rr.check_out, ${to}::date) - GREATEST(rr.check_in, ${from}::date))),0)::float8 AS nights,
           COALESCE(SUM(rr.price_total),0)::float8 AS revenue
    FROM guesthub.reservations r
    JOIN guesthub.reservation_rooms rr ON rr.reservation_id = r.id AND rr.tenant_id = r.tenant_id
    WHERE r.tenant_id = ${tenantId} AND r.status = ANY(${BLOCKING})
      AND rr.check_in < ${to} AND rr.check_out > ${from}`;
  const nights = Number(row?.nights ?? 0);
  const revenue = Number(row?.revenue ?? 0);
  return {
    from, to, reservations: Number(row?.res ?? 0), roomNights: nights, roomRevenue: revenue,
    adr: nights > 0 ? Math.round((revenue / nights) * 100) / 100 : 0,
  };
}

export type BalanceDueRow = {
  reservationId: string; reservationNumber: string; guestName: string | null;
  checkIn: string; checkOut: string; total: number; paid: number; balance: number;
};

// Outstanding balances (debtors) — reservations with a positive balance.
export async function balancesDueReport(tenantId: string): Promise<BalanceDueRow[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT r.id, r.reservation_number, g.full_name AS guest_name,
           r.check_in::text AS check_in, r.check_out::text AS check_out,
           r.total_price::float8 AS total, r.paid_amount::float8 AS paid, r.balance::float8 AS balance
    FROM guesthub.reservations r
    LEFT JOIN guesthub.guests g ON g.id = r.primary_guest_id AND g.tenant_id = r.tenant_id
    WHERE r.tenant_id = ${tenantId} AND r.status = ANY(${BLOCKING}) AND r.balance > 0
    ORDER BY r.balance DESC, r.check_in`;
  return rows.map((r) => ({
    reservationId: r.id as string, reservationNumber: r.reservation_number as string,
    guestName: (r.guest_name as string) ?? null,
    checkIn: r.check_in as string, checkOut: r.check_out as string,
    total: Number(r.total ?? 0), paid: Number(r.paid ?? 0), balance: Number(r.balance ?? 0),
  }));
}

export type CashUpRow = { method: string; count: number; total: number };

// Payments cash-up for [from, to] by method — only 'paid' rows count (the ledger
// model: refunds are negative contra rows, voids are excluded).
export async function cashUpReport(tenantId: string, from: string, to: string): Promise<CashUpRow[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT COALESCE(NULLIF(btrim(method), ''), 'לא צוין') AS method,
           count(*)::float8 AS count, COALESCE(SUM(amount),0)::float8 AS total
    FROM guesthub.payments
    WHERE tenant_id = ${tenantId} AND status = 'paid'
      AND COALESCE(paid_at, created_at)::date >= ${from}
      AND COALESCE(paid_at, created_at)::date <= ${to}
    GROUP BY 1 ORDER BY total DESC`;
  return rows.map((r) => ({ method: r.method as string, count: Number(r.count ?? 0), total: Number(r.total ?? 0) }));
}

export type ChannelProductionRow = { channel: string; reservations: number; roomRevenue: number };

// Channel production — volume + value per OTA/source for stays overlapping the range.
export async function channelProductionReport(tenantId: string, from: string, to: string): Promise<ChannelProductionRow[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT COALESCE(NULLIF(btrim(r.ota_name), ''), r.booking_origin, 'direct') AS channel,
           count(DISTINCT r.id)::float8 AS reservations,
           COALESCE(SUM(rr.price_total),0)::float8 AS revenue
    FROM guesthub.reservations r
    JOIN guesthub.reservation_rooms rr ON rr.reservation_id = r.id AND rr.tenant_id = r.tenant_id
    WHERE r.tenant_id = ${tenantId} AND r.status = ANY(${BLOCKING})
      AND rr.check_in < ${to} AND rr.check_out > ${from}
    GROUP BY 1 ORDER BY revenue DESC`;
  return rows.map((r) => ({
    channel: r.channel as string, reservations: Number(r.reservations ?? 0), roomRevenue: Number(r.revenue ?? 0),
  }));
}
