import type postgres from "postgres";
import { sql } from "@/lib/db";
import type { DateOnly } from "@/lib/dates";

/**
 * THE in-house definition — the dashboard's "inh" window and the broadcast
 * recipients (D206) both read it from here. DATE-based, never status-based: a
 * room stay is in house on `day` when check_in <= day < check_out. "Who is in
 * the building tonight" is answered by the dates; the lifecycle status answers
 * "who did reception process" (stale in production — zero rows carried
 * checked_in when the dashboard was built).
 *
 * A fragment over `guesthub.reservation_rooms` aliased `rr`; `day` is the
 * property's calendar date (dateInTz / todayInTz), never the UTC date.
 */
export function inHouseOn(day: DateOnly): postgres.Fragment {
  return sql`rr.check_in <= ${day} AND rr.check_out > ${day}`;
}
