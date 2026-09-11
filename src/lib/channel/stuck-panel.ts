import type { Sql } from "postgres";
import type { DateOnly } from "@/lib/dates";

// ============================================================
// The dashboard's "הזמנות ערוץ שנתקעו" panel — its TWO sources, as queries.
//
// This module exists so the panel's read model can be exercised by a guard
// (scripts/check-stuck-panel-violations.mjs) against a fixture database: the
// predicates below are the ones production runs, not a description of them.
// `db` is injected (queue.ts's idiom) for exactly that reason.
//
// SOURCE 1 — the COUNTER (unchanged since D169). channel_booking_revisions
// whose import_status is 'quarantined' (no room/rate-plan mapping) or 'failed'
// (transient error). Neither is terminal — the 5-minute pull retries both — so
// the number drains itself once the mapping is fixed. DISTINCT
// provider_booking_id: one booking with two failed revisions is ONE booking to
// fix. It is a counter, not a list, deliberately: most parked revisions never
// became a reservation, so there is nothing reservation-shaped to list.
//
// SOURCE 2 — the VIOLATIONS (D184). channel_sync_errors rows the OTA import
// wrote under OTA_STAY_RESTRICTION_VIOLATION (ota-restriction-report.ts): the
// booking was imported anyway (D153 — refusing it would hide a sold room, not
// un-sell it), so there IS a reservation to list, and the row is evidence of a
// real defect upstream — the ARI projection published the wrong restriction,
// or someone overrode it in the extranet. Each stays listed until an operator
// marks it resolved (resolveSyncErrorAction); nothing closes it automatically,
// because a re-import proves nothing about whether the defect was looked at.
//
// A reservation that is BOTH — imported with a violation, and then a later
// revision of the same booking parked — appears once, as a violation row
// carrying `stuck: true`; the counter still counts its booking, as it always
// did. Read-back drift rows are NOT here: they are cells, not reservations,
// and stay on the sync screen.
// ============================================================

export type StuckCounter = {
  /** distinct provider bookings, not revisions */
  count: number;
  /** whole hours since the OLDEST unresolved revision arrived; null when count=0 */
  oldestHours: number | null;
};

export const VIOLATION_CODE = "OTA_STAY_RESTRICTION_VIOLATION";

export type StuckViolationRow = {
  /** channel_sync_errors.id — what "סמן כטופל" resolves */
  errorId: string;
  reservationId: string;
  /** the internal number; the OTA code is shown alongside when present */
  reservationNumber: string;
  otaReservationCode: string | null;
  guestName: string;
  /** first room of the booking — a doorplate, not an inventory claim */
  roomNumber: string | null;
  checkIn: DateOnly;
  checkOut: DateOnly;
  nights: number;
  /** the source channel as the import recorded it (booking, expedia, airbnb …) */
  otaName: string | null;
  /** the engine's restriction codes, e.g. MIN_STAY_NOT_MET — de-duplicated */
  codes: string[];
  /** the engine's Hebrew sentences ("מינימום 2 לילות בטווח זה"), joined — the
      marker text; falls back to the stored error_message when context lacks them */
  violationText: string;
  /** the stored error_message, verbatim (the full operator sentence) */
  message: string;
  /** ISO timestamp of the row — the list is newest first */
  createdAt: string;
  /** the same booking also has an open quarantined/failed revision */
  stuck: boolean;
  /** lifecycle 'cancelled' — still listed (the defect is upstream, not in the
      booking), tagged so the row is not read as a live guest */
  cancelled: boolean;
};

export async function loadStuckCounter(db: Sql, tenantId: string): Promise<StuckCounter> {
  const rows = await db<{ c: number; oldest_hours: number | null }[]>`
    SELECT count(DISTINCT provider_booking_id)::int AS c,
           floor(EXTRACT(EPOCH FROM (now() - min(created_at))) / 3600)::int AS oldest_hours
      FROM guesthub.channel_booking_revisions
     WHERE tenant_id = ${tenantId}
       AND import_status IN ('quarantined', 'failed')`;
  const count = rows[0]?.c ?? 0;
  return { count, oldestHours: count > 0 ? (rows[0]?.oldest_hours ?? 0) : null };
}

type ViolationRaw = {
  error_id: string;
  reservation_id: string;
  reservation_number: string;
  ota_reservation_code: string | null;
  guest_name: string;
  room_number: string | null;
  check_in: string;
  check_out: string;
  nights: number;
  ota_name: string | null;
  message: string;
  context: unknown;
  created_at: string;
  stuck: boolean;
  cancelled: boolean;
};

const UUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

export async function loadStuckViolations(
  db: Sql,
  tenantId: string,
): Promise<StuckViolationRow[]> {
  // The reservation link is context->>'reservation_id' (the reporter writes
  // it; the table has no reservation_id column). INNER join: a violation whose
  // reservation no longer exists has nowhere to link to, and the 180-day purge
  // of unresolved rows (043) is its exit. The regex guard keeps a malformed
  // context from turning the whole dashboard read into a cast error.
  const rows = await db<ViolationRaw[]>`
    SELECT e.id AS error_id,
           res.id AS reservation_id,
           res.reservation_number,
           res.ota_reservation_code,
           COALESCE(g.full_name, 'אורח') AS guest_name,
           room.room_number,
           res.check_in::text AS check_in,
           res.check_out::text AS check_out,
           GREATEST((res.check_out - res.check_in)::int, 0) AS nights,
           res.ota_name,
           e.error_message AS message,
           e.context,
           e.created_at::text AS created_at,
           EXISTS (
             SELECT 1
               FROM guesthub.channel_booking_revisions cbr
              WHERE cbr.tenant_id = res.tenant_id
                AND cbr.import_status IN ('quarantined', 'failed')
                AND (cbr.local_reservation_id = res.id
                     OR (cbr.connection_id = res.channel_connection_id
                         AND cbr.provider_booking_id = res.external_booking_id))
           ) AS stuck,
           (res.status = 'cancelled') AS cancelled
      FROM guesthub.channel_sync_errors e
      JOIN guesthub.reservations res
        ON res.tenant_id = e.tenant_id
       AND (e.context->>'reservation_id') ~ ${UUID}
       AND res.id = (e.context->>'reservation_id')::uuid
      LEFT JOIN guesthub.guests g ON g.id = res.primary_guest_id AND g.tenant_id = res.tenant_id
      LEFT JOIN LATERAL (
        SELECT rm.room_number
          FROM guesthub.reservation_rooms rr
          JOIN guesthub.rooms rm ON rm.id = rr.room_id AND rm.tenant_id = rr.tenant_id
         WHERE rr.tenant_id = res.tenant_id AND rr.reservation_id = res.id
         ORDER BY rm.room_number
         LIMIT 1) room ON true
     WHERE e.tenant_id = ${tenantId}
       AND e.error_code = ${VIOLATION_CODE}
       AND e.resolved_at IS NULL
     ORDER BY e.created_at DESC, e.id DESC`;
  return rows.map(toRow);
}

function toRow(r: ViolationRaw): StuckViolationRow {
  const { codes, text } = violationsFromContext(r.context);
  return {
    errorId: r.error_id,
    reservationId: r.reservation_id,
    reservationNumber: r.reservation_number,
    otaReservationCode: r.ota_reservation_code,
    guestName: r.guest_name,
    roomNumber: r.room_number,
    checkIn: r.check_in as DateOnly,
    checkOut: r.check_out as DateOnly,
    nights: r.nights,
    otaName: r.ota_name,
    codes,
    violationText: text ?? r.message,
    message: r.message,
    createdAt: r.created_at,
    stuck: r.stuck,
    cancelled: r.cancelled,
  };
}

// context.violations is what the reporter stored: [{code, message, date,
// checkIn, checkOut, roomId}] — one per stay per finding. The marker wants
// the distinct sentences, in first-seen order; a multi-room booking that
// violates the same minimum in every room says it once.
export function violationsFromContext(context: unknown): { codes: string[]; text: string | null } {
  const list =
    context && typeof context === "object" && Array.isArray((context as { violations?: unknown }).violations)
      ? ((context as { violations: unknown[] }).violations)
      : [];
  const codes: string[] = [];
  const messages: string[] = [];
  for (const v of list) {
    if (!v || typeof v !== "object") continue;
    const { code, message } = v as { code?: unknown; message?: unknown };
    if (typeof code === "string" && code && !codes.includes(code)) codes.push(code);
    if (typeof message === "string" && message && !messages.includes(message)) messages.push(message);
  }
  return { codes, text: messages.length > 0 ? messages.join(" · ") : null };
}
