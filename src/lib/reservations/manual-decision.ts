import type { Sql, TransactionSql } from "postgres";

// ============================================================
// "נדרשת החלטת מפעיל" — the DERIVED blocked-cancellation state (D93).
//
// WHY THIS FILE EXISTS. `applyCancellation` (src/lib/channel/booking-import.ts)
// and the reconciliation gate both keep an inbound OTA cancellation that lands
// on a guest who is physically in the room: the cancellation is real, it is
// recorded on the row, but the nights are NOT freed. Until now the ONLY place
// that said so was a `channel_sync_errors` row with code
// `cancelled_at_source_checked_in` — an alert on the channels screen. The
// reservation panel showed nothing at all, because the panel's cancellation
// card is built only when `status === 'cancelled'`, and a blocked reservation
// is by definition NOT cancelled. Human-in-the-loop without the loop.
//
// THE STATE IS DERIVED, NEVER STORED. Same one-domain rule migration 031 set
// for `cancellation_pending_external` (requested_at + status), applied to the
// confirmation side:
//
//     external_cancellation_confirmed_at IS NOT NULL AND status <> 'cancelled'
//
// Exactly the derivation written into the D93 gate's own comment. NO MIGRATION
// and no new column: a stored `needs_manual_decision` boolean would be a second
// source of truth that drifts the moment an operator resolves the stay through
// any route that forgets to clear it.
//
// PURE + INJECTED DB, deliberately. `isCancellationBlocked` has no imports and
// no I/O, and `loadManualDecisionView` takes its db handle as a parameter (the
// same shape as `loadCollectionView` in lib/payments/collection.ts). That is
// what lets scripts/check-manual-decision-surface.mjs drive the REAL predicate
// and the REAL query against a database, instead of grepping for a string.
// There is no `import "server-only"` here for the same reason there is none in
// lib/inventory-rules.ts: the module holds no secret, opens no connection, and
// its only runtime surface is a function that cannot work without a db handle
// somebody else already owns. The client panel imports the TYPES only.
// ============================================================

/** The one alert code both D93 gates raise — ONE vocabulary for the operator. */
export const MANUAL_DECISION_ALERT_CODE = "cancelled_at_source_checked_in";

/** The two reservation facts the derivation is made of. Nothing else. */
export type CancellationBlockFacts = {
  status: string;
  externalCancellationConfirmedAt: string | null;
};

/**
 * THE CENTRAL PREDICATE. The channel confirmed a cancellation for a stay that
 * is not cancelled here → the room is still held and a human must decide.
 *
 * A type guard so the confirmation timestamp narrows to `string` for callers:
 * the blocked state cannot exist without one.
 */
export function isCancellationBlocked(
  facts: CancellationBlockFacts,
): facts is CancellationBlockFacts & { externalCancellationConfirmedAt: string } {
  return facts.externalCancellationConfirmedAt !== null && facts.status !== "cancelled";
}

/** One stay-row that is STILL occupying the calendar despite the cancellation. */
export type HeldRoom = {
  roomLabel: string;
  checkIn: string;
  checkOut: string;
  nights: number;
};

export type ManualDecisionView = {
  /** when the channel's cancelled revision landed (031: confirmed ≠ requested) */
  confirmedAt: string;
  /** the lifecycle status that blocked the automatic release */
  status: string;
  otaName: string | null;
  otaReservationCode: string | null;
  /** the nights that were NOT released — the whole point of the surface */
  roomsHeld: HeldRoom[];
  nightsHeld: number;
  /**
   * Always false while the state exists: a released reservation is `cancelled`
   * and the predicate no longer fires. Carried explicitly so the panel states
   * the fact instead of implying it.
   */
  inventoryReleased: boolean;
  alertCode: string;
  /** open `channel_sync_errors` rows of that code pointing at this reservation */
  openAlerts: number;
};

/**
 * Server half: reads the facts and, when the derivation fires, the nights that
 * are still held plus the open alert count. Read-only, tenant-scoped, cheap —
 * safe on every detail load. Returns null for every reservation that is NOT in
 * the blocked state (including one that never had a channel cancellation).
 */
export async function loadManualDecisionView(
  db: Sql | TransactionSql,
  tenantId: string,
  reservationId: string,
): Promise<ManualDecisionView | null> {
  const [res] = await db<
    {
      status: string;
      ota_name: string | null;
      ota_reservation_code: string | null;
      external_cancellation_confirmed_at: string | null;
    }[]
  >`
    SELECT status, ota_name, ota_reservation_code,
           external_cancellation_confirmed_at::text AS external_cancellation_confirmed_at
    FROM guesthub.reservations
    WHERE id = ${reservationId} AND tenant_id = ${tenantId}`;
  if (!res) return null;

  const facts: CancellationBlockFacts = {
    status: res.status,
    externalCancellationConfirmedAt: res.external_cancellation_confirmed_at,
  };
  if (!isCancellationBlocked(facts)) return null;

  // the nights are read back from the stay rows, not assumed: this is the
  // evidence that the release did not happen, so it must come from the data.
  const rooms = await db<
    { room_label: string; check_in: string; check_out: string; nights: number }[]
  >`
    SELECT COALESCE(r.name, r.room_number, '—') AS room_label,
           rr.check_in::text AS check_in, rr.check_out::text AS check_out,
           (rr.check_out - rr.check_in)::int AS nights
    FROM guesthub.reservation_rooms rr
    LEFT JOIN guesthub.rooms r ON r.id = rr.room_id
    WHERE rr.reservation_id = ${reservationId} AND rr.tenant_id = ${tenantId}
    ORDER BY rr.check_in, r.room_number`;

  const [alerts] = await db<{ open_alerts: number }[]>`
    SELECT count(*)::int AS open_alerts
    FROM guesthub.channel_sync_errors
    WHERE tenant_id = ${tenantId}
      AND error_code = ${MANUAL_DECISION_ALERT_CODE}
      AND resolved_at IS NULL
      AND context->>'reservation_id' = ${reservationId}`;

  const roomsHeld: HeldRoom[] = rooms.map((r) => ({
    roomLabel: r.room_label,
    checkIn: r.check_in,
    checkOut: r.check_out,
    nights: r.nights,
  }));

  return {
    confirmedAt: facts.externalCancellationConfirmedAt,
    status: res.status,
    otaName: res.ota_name,
    otaReservationCode: res.ota_reservation_code,
    roomsHeld,
    nightsHeld: roomsHeld.reduce((sum, r) => sum + r.nights, 0),
    inventoryReleased: false,
    alertCode: MANUAL_DECISION_ALERT_CODE,
    openAlerts: alerts?.open_alerts ?? 0,
  };
}
