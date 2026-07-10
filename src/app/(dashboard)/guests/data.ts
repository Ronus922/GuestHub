import "server-only";
import { sql } from "@/lib/db";
import type { Actor } from "@/lib/auth/actor";
import { todayInTz, type DateOnly } from "@/lib/dates";

// ============================================================
// /guests read model (D77 §19) — over the CANONICAL guesthub.guests table
// (000_init_schema): identity = the guest row (primary_guest_id links every
// reservation). NO automatic deduplication: rows are never merged by name,
// phone or email — an operator-visible list of the rows as they exist.
// Aggregates are honest per-guest-row facts, not per-person guesses.
// ============================================================

export const GUESTS_LIMIT = 300;

export type GuestRow = {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  is_vip: boolean;
  is_blocked: boolean;
  total_reservations: number;
  active_reservations: number;
  completed_stays: number;
  cancelled_stays: number;
  no_shows: number;
  last_stay: string | null;
  next_stay: string | null;
  total_paid: number;
  outstanding: number;
};

export type GuestsListData = {
  rows: GuestRow[];
  truncatedBy: number;
  today: DateOnly;
  currency: string;
  totalGuests: number;
};

export async function getGuestsList(actor: Actor, q: string): Promise<GuestsListData> {
  const tenantId = actor.tenantId;
  const [tenant] = await sql<{ timezone: string; currency: string }[]>`
    SELECT timezone, currency FROM guesthub.tenants WHERE id = ${tenantId}`;
  const today = todayInTz(tenant?.timezone || "Asia/Jerusalem");
  const like = q.trim() ? `%${q.trim()}%` : null;

  const rows = await sql<(GuestRow & { total_count: number })[]>`
    SELECT g.id, g.full_name, g.phone, g.email, g.is_vip, g.is_blocked,
           COUNT(res.id)::int AS total_reservations,
           COUNT(*) FILTER (WHERE res.status IN ('confirmed', 'checked_in'))::int
             AS active_reservations,
           COUNT(*) FILTER (WHERE res.status = 'checked_out')::int AS completed_stays,
           COUNT(*) FILTER (WHERE res.status = 'cancelled')::int AS cancelled_stays,
           COUNT(*) FILTER (WHERE res.status = 'no_show')::int AS no_shows,
           MAX(res.check_out) FILTER
             (WHERE res.check_in <= ${today} AND res.status <> 'cancelled')::text AS last_stay,
           MIN(res.check_in) FILTER
             (WHERE res.check_in > ${today} AND res.status IN ('confirmed', 'checked_in'))::text
             AS next_stay,
           COALESCE(SUM(res.paid_amount) FILTER (WHERE res.status <> 'cancelled'), 0)::float8
             AS total_paid,
           COALESCE(SUM(GREATEST(res.total_price - res.paid_amount, 0))
             FILTER (WHERE res.status NOT IN ('cancelled', 'no_show')), 0)::float8 AS outstanding,
           COUNT(*) OVER ()::int AS total_count
    FROM guesthub.guests g
    LEFT JOIN guesthub.reservations res
      ON res.primary_guest_id = g.id AND res.tenant_id = g.tenant_id
    WHERE g.tenant_id = ${tenantId}
      ${
        like
          ? sql`AND (g.full_name ILIKE ${like} OR g.phone ILIKE ${like} OR g.email ILIKE ${like})`
          : sql``
      }
    GROUP BY g.id
    ORDER BY g.full_name
    LIMIT ${GUESTS_LIMIT}`;

  const totalMatching = rows[0]?.total_count ?? 0;
  return {
    rows,
    truncatedBy: Math.max(0, totalMatching - rows.length),
    today,
    currency: tenant?.currency || "ILS",
    totalGuests: totalMatching,
  };
}
