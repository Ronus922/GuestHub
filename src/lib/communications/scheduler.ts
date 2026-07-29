import "server-only";
import { sql } from "@/lib/db";
import { TRIGGERS, type TriggerId } from "./triggers";

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
// Catch-up: the date-EQUALITY predicate is the horizon. An automation
// activated later the same Israel day still catches that day's reservations
// (time-of-day is >=); a day that has passed is silently never emitted —
// consistent with the UI promise "אין שליחה רטרואקטיבית".
//
// All date math is Asia/Jerusalem, matching check-in-check-out-policy.ts.
// ============================================================

export type SchedulerScanResult = { emitted: number };

const SCHEDULED_TRIGGERS = (Object.keys(TRIGGERS) as TriggerId[])
  .filter((id) => TRIGGERS[id].kind === "scheduled");

async function emitForTrigger(triggerId: TriggerId): Promise<number> {
  const trigger = TRIGGERS[triggerId];
  const anchorColumn = trigger.anchor === "check_out" ? sql`r.check_out` : sql`r.check_in`;
  // pre_arrival: check_in = today + offset;  post_checkout: check_out = today − offset;
  // check_in_day: check_in = today (offset 0).
  const anchorMatch = trigger.direction === "after"
    ? sql`${anchorColumn} = ((now() AT TIME ZONE 'Asia/Jerusalem')::date - COALESCE((a.timing_config->>'offsetDays')::int, 0))`
    : sql`${anchorColumn} = ((now() AT TIME ZONE 'Asia/Jerusalem')::date + COALESCE((a.timing_config->>'offsetDays')::int, 0))`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO guesthub.communication_events
      (tenant_id, event_type, aggregate_type, reservation_id, source,
       occurrence_key, payload, occurred_at)
    SELECT a.tenant_id, a.trigger_type, 'reservation', r.id, r.booking_origin,
           'reservation:' || r.id || ':' || ${trigger.shortName} || ':' || a.id || ':' || ${anchorColumn}::text,
           jsonb_build_object(
             'automationId', a.id,
             'anchorDate', ${anchorColumn}::text,
             'offsetDays', COALESCE((a.timing_config->>'offsetDays')::int, 0)),
           now()
    FROM guesthub.communication_automations a
    JOIN guesthub.reservations r ON r.tenant_id = a.tenant_id
    WHERE a.trigger_type = ${triggerId}
      AND a.status = 'active' AND a.archived_at IS NULL
      AND (a.timing_config->>'mode') = 'scheduled'
      AND r.status = ANY(${trigger.eligibleStatuses})
      AND NOT r.is_test
      AND ${anchorMatch}
      AND to_char(now() AT TIME ZONE 'Asia/Jerusalem', 'HH24:MI')
            >= COALESCE(a.timing_config->>'sendTime', ${trigger.defaultSendTime ?? "09:00"})
    ON CONFLICT (tenant_id, event_type, aggregate_type, occurrence_key) DO NOTHING
    RETURNING id`;
  return rows.length;
}

/** Emit due synthetic events for every scheduled-kind trigger. */
export async function runScheduledTriggerScan(
  log: (message: string) => void = () => {},
): Promise<SchedulerScanResult> {
  let emitted = 0;
  for (const triggerId of SCHEDULED_TRIGGERS) {
    emitted += await emitForTrigger(triggerId);
  }
  if (emitted) log(`communications scheduler: ${emitted} scheduled event(s) emitted`);
  return { emitted };
}

