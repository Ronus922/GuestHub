import "server-only";
import type { TransactionSql } from "postgres";
import { sql } from "@/lib/db";
import { JOBS_WAKE_CHANNEL } from "@/lib/realtime/events";
import type { BookingOrigin } from "./types";

type BookingOriginInput = BookingOrigin | "backoffice" | "direct";

export type CommunicationEvent = {
  id: string;
  tenant_id: string;
  event_type: string;
  reservation_id: string | null;
  source: string;
  payload: unknown;
  attempt_count: number;
  max_attempts: number;
};

function canonicalOrigin(value: BookingOriginInput): BookingOrigin {
  if (value === "direct") return "direct_website";
  if (value === "backoffice") return "back_office";
  return value;
}

/**
 * Transactional reservation-confirmed outbox seam. The reservation write and
 * event either commit together or neither does. The stable occurrence key means
 * a replayed action/transition cannot produce a second automatic confirmation.
 */
export async function enqueueReservationConfirmed(
  tx: TransactionSql,
  args: {
    tenantId: string;
    reservationId: string;
    bookingOrigin: BookingOriginInput;
    initiatedBy?: string | null;
    occurredAt?: Date | string;
  },
): Promise<{ id: string } | { duplicate: true }> {
  const source = canonicalOrigin(args.bookingOrigin);
  const occurrenceKey = `reservation:${args.reservationId}:confirmed:v1`;
  const rows = await tx<{ id: string }[]>`
    INSERT INTO guesthub.communication_events
      (tenant_id, event_type, aggregate_type, reservation_id, source,
       occurrence_key, payload, occurred_at)
    VALUES (
      ${args.tenantId}, 'reservation.confirmed', 'reservation',
      ${args.reservationId}, ${source}, ${occurrenceKey},
      ${tx.json({ initiatedBy: args.initiatedBy ?? null } as never)},
      ${args.occurredAt ?? new Date()})
    ON CONFLICT (tenant_id, event_type, aggregate_type, occurrence_key) DO NOTHING
    RETURNING id`;
  if (!rows[0]) return { duplicate: true };
  await tx`SELECT pg_notify(${JOBS_WAKE_CHANNEL}, 'communication_event')`;
  return rows[0];
}

/** Atomic lease claim. Expired processing rows are reclaimed after a crash. */
export async function claimCommunicationEvents(workerId: string, limit = 10): Promise<CommunicationEvent[]> {
  return sql.begin(async (tx) => tx<CommunicationEvent[]>`
    WITH candidates AS (
      SELECT id
      FROM guesthub.communication_events
      WHERE available_at <= now()
        AND attempt_count < max_attempts
        AND (
          status = 'pending'
          OR (status = 'processing' AND lease_expires_at <= now())
        )
      ORDER BY occurred_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE guesthub.communication_events e
    SET status = 'processing',
        attempt_count = e.attempt_count + 1,
        lease_owner = ${workerId},
        lease_expires_at = now() + interval '5 minutes',
        updated_at = now()
    FROM candidates c
    WHERE e.id = c.id
    RETURNING e.id, e.tenant_id, e.event_type, e.reservation_id,
              e.source, e.payload, e.attempt_count, e.max_attempts`);
}

export async function completeCommunicationEvent(eventId: string, workerId: string): Promise<void> {
  await sql`
    UPDATE guesthub.communication_events
    SET status = 'processed', processed_at = now(), lease_owner = NULL,
        lease_expires_at = NULL, last_error_category = NULL, updated_at = now()
    WHERE id = ${eventId} AND status = 'processing' AND lease_owner = ${workerId}`;
}

export async function failCommunicationEvent(
  event: CommunicationEvent,
  workerId: string,
  category: string,
  permanent = false,
): Promise<void> {
  const exhausted = event.attempt_count >= event.max_attempts;
  const delaySeconds = Math.min(3600, 15 * 2 ** Math.max(0, event.attempt_count - 1));
  await sql`
    UPDATE guesthub.communication_events
    SET status = ${permanent || exhausted ? "failed" : "pending"},
        available_at = ${permanent || exhausted ? sql`available_at` : sql`now() + make_interval(secs => ${delaySeconds})`},
        lease_owner = NULL, lease_expires_at = NULL,
        last_error_category = ${category.slice(0, 80)}, updated_at = now()
    WHERE id = ${event.id} AND status = 'processing' AND lease_owner = ${workerId}`;
}
