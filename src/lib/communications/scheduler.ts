import "server-only";
import type postgres from "postgres";
import { sql } from "@/lib/db";
import { TRIGGERS, isInStayWindow, type TriggerId } from "./triggers";

// ============================================================
// Time-based trigger scan. Runs inside every communication tick, BEFORE the
// event claim, so freshly emitted events are processed in the same tick.
//
// Idempotency is the outbox's unique key (tenant_id, event_type,
// aggregate_type, occurrence_key) + ON CONFLICT DO NOTHING. The occurrence key
//   reservation:{reservationId}:{shortName}:{automationId}:{anchorDate}
// is per-AUTOMATION and anchored to the reservation's own date:
//   · two pre-arrival automations with different offsets never collide;
//   · editing timing/template or re-activating changes nothing in the key →
//     no double-send for the same stay;
//   · moving the reservation's dates = a new anchor = a fresh (wanted) send.
//
// Catch-up: the date-EQUALITY predicate is the horizon — a day that has passed
// is never emitted (the panel: "ולא לימים שעברו"). Within the day (D201) a late
// emission is honoured only up to CATCH_UP_WINDOW_HOURS after the send time;
// later than that the event is still emitted ONCE (same key) but carries
// skipReason 'catch_up_window_expired', so the history shows why nothing went
// out instead of a 09:00 reminder leaving at 23:00.
//
// In-stay windows (D201 — after check-in, before check-out) additionally
// require the day to be inside the stay by DATE (check_in <= day < check_out);
// otherwise the event carries skipReason 'outside_stay'. Statuses are not
// trusted for "in house" — production statuses are stale.
//
// All date math is Asia/Jerusalem, matching check-in-check-out-policy.ts.
// ============================================================

export type SchedulerScanResult = { emitted: number };

export const CATCH_UP_WINDOW_HOURS = 3;

const SCHEDULED_TRIGGERS = (Object.keys(TRIGGERS) as TriggerId[])
  .filter((id) => TRIGGERS[id].kind === "scheduled");

/** The automation rows a scan runs over: the table (default), or one draft row (D203). */
export type AutomationSource = postgres.Fragment;

/**
 * D203 — the scheduler's predicate, ONE fragment for both callers: the worker
 * emits from it (emitForTrigger) and the automation preview reads it. Every
 * reservation whose anchor matches this trigger's day for the automation is a
 * candidate; the three gates the emission applies are exposed as columns
 * (status_ok, is_test, due) instead of being hidden in a WHERE, so the preview
 * can say WHY a candidate is not emitted without restating the rule.
 */
export function scheduledCandidates(
  triggerId: TriggerId,
  at: Date | null,
  automations?: AutomationSource,
): postgres.Fragment {
  const trigger = TRIGGERS[triggerId];
  // `at` exists for the behavioural guards and the preview; production always
  // scans at the database's now().
  const nowTs = at ? sql`${at.toISOString()}::timestamptz` : sql`now()`;
  const today = sql`((${nowTs}) AT TIME ZONE 'Asia/Jerusalem')::date`;
  const anchorColumn = trigger.anchor === "check_out" ? sql`r.check_out` : sql`r.check_in`;
  const offset = sql`COALESCE((a.timing_config->>'offsetDays')::int, 0)`;
  const sendTime = sql`COALESCE(a.timing_config->>'sendTime', ${trigger.defaultSendTime ?? "09:00"})`;
  // before: anchor = today + offset (the day comes BEFORE the anchor);
  // after:  anchor = today − offset;  on: anchor = today.
  const anchorMatch = trigger.direction === "after"
    ? sql`${anchorColumn} = (${today} - ${offset})`
    : trigger.direction === "before"
      ? sql`${anchorColumn} = (${today} + ${offset})`
      : sql`${anchorColumn} = ${today}`;
  const outsideStay = isInStayWindow(trigger)
    ? sql`NOT (r.check_in <= ${today} AND ${today} < r.check_out)`
    : sql`false`;
  const scheduledFor = sql`((${today} + (${sendTime})::time) AT TIME ZONE 'Asia/Jerusalem')`;
  const catchUpExpired = sql`(${nowTs}) > ${scheduledFor} + make_interval(hours => ${CATCH_UP_WINDOW_HOURS})`;
  return sql`
    SELECT a.tenant_id, a.trigger_type AS event_type, 'reservation' AS aggregate_type,
           r.id AS reservation_id, r.booking_origin AS source,
           'reservation:' || r.id || ':' || ${trigger.shortName} || ':' || a.id || ':' || ${anchorColumn}::text AS occurrence_key,
           jsonb_strip_nulls(jsonb_build_object(
             'automationId', a.id,
             'anchorDate', ${anchorColumn}::text,
             'offsetDays', ${offset},
             'scheduledFor', ${scheduledFor},
             'skipReason', CASE
               WHEN ${outsideStay} THEN 'outside_stay'
               WHEN ${catchUpExpired} THEN 'catch_up_window_expired'
             END)) AS payload,
           ${nowTs} AS occurred_at,
           r.status = ANY(${trigger.eligibleStatuses}) AS status_ok,
           r.is_test,
           to_char((${nowTs}) AT TIME ZONE 'Asia/Jerusalem', 'HH24:MI') >= ${sendTime} AS due
    FROM ${automations ?? sql`guesthub.communication_automations`} a
    JOIN guesthub.reservations r ON r.tenant_id = a.tenant_id
    WHERE a.trigger_type = ${triggerId}
      AND a.status = 'active' AND a.archived_at IS NULL
      AND (a.timing_config->>'mode') = 'scheduled'
      AND ${anchorMatch}`;
}

async function emitForTrigger(triggerId: TriggerId, at: Date | null): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO guesthub.communication_events
      (tenant_id, event_type, aggregate_type, reservation_id, source,
       occurrence_key, payload, occurred_at)
    SELECT c.tenant_id, c.event_type, c.aggregate_type, c.reservation_id, c.source,
           c.occurrence_key, c.payload, c.occurred_at
    FROM (${scheduledCandidates(triggerId, at)}) c
    WHERE c.status_ok AND NOT c.is_test AND c.due
    ON CONFLICT (tenant_id, event_type, aggregate_type, occurrence_key) DO NOTHING
    RETURNING id`;
  return rows.length;
}

/** Emit due synthetic events for every scheduled-kind trigger. */
export async function runScheduledTriggerScan(
  log: (message: string) => void = () => {},
  options: { at?: Date } = {},
): Promise<SchedulerScanResult> {
  let emitted = 0;
  for (const triggerId of SCHEDULED_TRIGGERS) {
    emitted += await emitForTrigger(triggerId, options.at ?? null);
  }
  if (emitted) log(`communications scheduler: ${emitted} scheduled event(s) emitted`);
  return { emitted };
}

