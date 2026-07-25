// ============================================================
// Booking.com status reports — the GUARD + LEDGER core (D96).
//
// WHY A SEPARATE MODULE (same reason as beds24-token.ts): the "use server"
// sibling ./booking-com-reports.ts imports the actor/guard/audit stack and can
// therefore never be required outside Next. Everything worth testing — the
// eligibility guards, the time windows, the prior-report rule, the ledger write
// and the success stamps — lives HERE, deliberately free of next/react/
// server-only imports, so scripts/check-booking-com-reports.mjs can compile it
// and drive it against a disposable database with a faked Beds24.
//
// THE GUARD ORDER is fixed and enforced by construction (the session +
// permission gate is the caller's, and runs BEFORE this module is entered):
//   1. reservation fetched WITH tenant_id           → "הזמנה לא נמצאה"
//   2. source is Booking.com                        → not a Booking.com booking
//   3. a Beds24 booking id exists                   → nothing to report on
//   4. the connection is an active Beds24 connection
//   5. the action's time window is open (soft — see below)
//   6. cancel_due_invalid_card: a prior SUCCESSFUL invalid_card report exists
//
// SOFT WINDOWS. Beds24/Booking.com is the source of truth on eligibility; these
// checks exist to stop an obviously-doomed, credit-burning, irreversible call —
// never to claim authority. Property-local dates (tenants.timezone), because a
// window that turns over at midnight must turn over at the PROPERTY's midnight:
//   · invalid_card            — from creation until 00:00 on the check-in date
//                               ⇒ allowed while today < check_in
//   · no_show                 — from 00:00 on check-in for 48h
//                               ⇒ allowed while check_in <= today < check_in + 2
//   · cancel_due_invalid_card — no clock window; gated on rule 6 instead
//
// EVERY ATTEMPT IS LEDGERED. Once the reservation is resolved in-tenant, every
// outcome writes exactly one booking_channel_reports row — including a local
// eligibility rejection, which lands as status='failed' with a Hebrew
// error_message and response=NULL (no request was issued). Guard 1 is the only
// outcome with no row, and it cannot have one: without an in-tenant reservation
// there is no tenant_id and no reservation_id to write.
//
// ZERO CARD DATA. A status report carries a booking id and an action. This
// module never reads, writes or references guesthub.reservation_cards, and no
// PAN/CVV/expiry field exists anywhere on this path. The `response` column
// receives the allow-listed envelope extract from beds24-booking-reports.ts,
// never a raw upstream body.
//
// NEVER FLIPS STATUS. cancel_due_invalid_card ASKS Booking.com to cancel; it
// stamps external_cancellation_requested_at and stops. The reservation becomes
// cancelled only when the cancellation comes back as a real cancelled revision
// through the canonical import path (D93) — this module owns no inventory.
// ============================================================

import type { Sql } from "postgres";
import { beds24BaseUrl } from "./config";
import { getBeds24AccessToken, type Beds24TokenConnection } from "./beds24-token";
import { otaSourceKey } from "./booking-normalize";
import {
  isBookingComOtaName,
  windowRejection,
  type BookingReportAction,
} from "./booking-com-report-rules";
import {
  reportBeds24BookingStatus,
  type BookingReportEnvelope,
} from "./beds24-booking-reports";

export type BookingReportOutcome = { success: true } | { success: false; error: string };

export type BookingReportDeps = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** injectable clock — property-local "today" is derived from it */
  now?: () => Date;
};

export type BookingReportInput = {
  tenantId: string;
  reservationId: string;
  action: BookingReportAction;
  /** operator's LOCAL fee-waiver record; meaningful for no_show only */
  waivedFees: boolean | null;
  /** the acting user, for the ledger's created_by */
  actorUserId: string | null;
};

/** The Booking.com source key produced by otaSourceKey() for any spelling. */
const BOOKING_COM_SOURCE_KEY = "booking_com";

/** "Today" as YYYY-MM-DD in the property's timezone. */
function todayInTimezone(now: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD (same helper contract as lib/dates.ts::todayInTz,
  // reimplemented here to keep this module out of the app's import graph).
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

type ReservationRow = {
  id: string;
  status: string;
  check_in: string;
  ota_name: string | null;
  source_key: string | null;
  external_booking_id: string | null;
  channel_connection_id: string | null;
  timezone: string | null;
};

/** Is this reservation a Booking.com booking? Both recorded spellings count. */
export function isBookingComReservation(row: {
  ota_name: string | null;
  source_key: string | null;
}): boolean {
  // ota_name is Beds24's verbatim channel string (live value: "booking");
  // source_key is the normalized lookup key. Either establishes the channel.
  // isBookingComOtaName is the shared client/server rule; otaSourceKey is the
  // import pipeline's own normalizer — agreeing with both is the safe answer.
  return (
    isBookingComOtaName(row.ota_name) ||
    otaSourceKey(row.ota_name) === BOOKING_COM_SOURCE_KEY ||
    row.source_key === BOOKING_COM_SOURCE_KEY
  );
}

/**
 * Stamp the reservation column this action owns (migration 030's OTA reporting
 * stamps, finally written). One explicit branch per action: the column name is
 * never interpolated, so no dynamic SQL exists on this path.
 * COALESCE keeps the FIRST successful report's timestamp — a re-report never
 * rewrites history, and the eligibility inputs stay stable.
 */
async function stampReservation(
  db: Sql,
  action: BookingReportAction,
  reservationId: string,
  tenantId: string,
): Promise<void> {
  if (action === "invalid_card") {
    await db`
      UPDATE guesthub.reservations
      SET invalid_card_reported_at = COALESCE(invalid_card_reported_at, now()), updated_at = now()
      WHERE id = ${reservationId} AND tenant_id = ${tenantId}`;
    return;
  }
  if (action === "cancel_due_invalid_card") {
    await db`
      UPDATE guesthub.reservations
      SET external_cancellation_requested_at =
            COALESCE(external_cancellation_requested_at, now()), updated_at = now()
      WHERE id = ${reservationId} AND tenant_id = ${tenantId}`;
    return;
  }
  await db`
    UPDATE guesthub.reservations
    SET no_show_reported_at = COALESCE(no_show_reported_at, now()), updated_at = now()
    WHERE id = ${reservationId} AND tenant_id = ${tenantId}`;
}

async function writeLedgerRow(
  db: Sql,
  input: BookingReportInput,
  row: {
    status: "success" | "failed";
    response: BookingReportEnvelope | null;
    errorMessage: string | null;
  },
): Promise<void> {
  await db`
    INSERT INTO guesthub.booking_channel_reports
      (tenant_id, reservation_id, action, waived_fees, status, response, error_message, created_by)
    VALUES (${input.tenantId}, ${input.reservationId}, ${input.action},
            ${input.waivedFees}, ${row.status},
            ${row.response === null ? null : db.json(row.response as never)},
            ${row.errorMessage}, ${input.actorUserId})`;
}

/**
 * Report a reservation's status to Booking.com and ledger the attempt.
 * The caller has ALREADY established a valid session and the
 * reservations.channel_report permission — this module never authenticates.
 */
export async function submitBookingComReport(
  db: Sql,
  input: BookingReportInput,
  deps: BookingReportDeps = {},
): Promise<BookingReportOutcome> {
  // ---- guard 1: the reservation, scoped to the tenant (D: every query) ----
  const [res] = await db<ReservationRow[]>`
    SELECT r.id, r.status, r.check_in::text AS check_in,
           r.ota_name, li.key AS source_key,
           r.external_booking_id, r.channel_connection_id,
           t.timezone
    FROM guesthub.reservations r
    LEFT JOIN guesthub.lookup_items li ON li.id = r.source_id
    LEFT JOIN guesthub.tenants t ON t.id = r.tenant_id
    WHERE r.id = ${input.reservationId} AND r.tenant_id = ${input.tenantId}`;
  // the ONE outcome that cannot be ledgered — there is no in-tenant row to point at
  if (!res) return { success: false, error: "הזמנה לא נמצאה" };

  const reject = async (error: string): Promise<BookingReportOutcome> => {
    await writeLedgerRow(db, input, { status: "failed", response: null, errorMessage: error });
    return { success: false, error };
  };

  // ---- guard 2: the source is Booking.com ----
  if (!isBookingComReservation(res))
    return reject("דיווח לערוץ אפשרי רק בהזמנות שהתקבלו מ-Booking.com");

  // ---- guard 3: a Beds24 booking id exists ----
  if (!res.external_booking_id)
    return reject("להזמנה אין מזהה הזמנה בערוץ — לא ניתן לדווח");
  if (!res.channel_connection_id)
    return reject("להזמנה אין חיבור ערוץ — לא ניתן לדווח");

  // an already-cancelled booking has nothing left to report — refuse before
  // burning a credit on a call Booking.com would reject anyway
  if (res.status === "cancelled")
    return reject("ההזמנה כבר מבוטלת — אין מה לדווח לערוץ");

  // ---- guard 6 (before spending a credit): cancel needs a prior invalid-card
  //      report that actually SUCCEEDED. The ledger is the authority; the
  //      reservations stamp is the fast index and must agree with it. ----
  if (input.action === "cancel_due_invalid_card") {
    const [prior] = await db<{ x: number }[]>`
      SELECT 1 AS x FROM guesthub.booking_channel_reports
      WHERE tenant_id = ${input.tenantId} AND reservation_id = ${input.reservationId}
        AND action = 'invalid_card' AND status = 'success'
      LIMIT 1`;
    if (!prior)
      return reject(
        "ביטול עקב כרטיס לא תקין אפשרי רק לאחר דיווח מוצלח על כרטיס לא תקין",
      );
  }

  // ---- guard 5: the soft, property-local time window ----
  const tz = res.timezone || "Asia/Jerusalem";
  const today = todayInTimezone(deps.now ? deps.now() : new Date(), tz);
  const windowError = windowRejection({ action: input.action, today, checkIn: res.check_in });
  if (windowError) return reject(windowError);

  // ---- guard 4: an ACTIVE Beds24 connection of THIS tenant ----
  const [conn] = await db<Beds24TokenConnection[]>`
    SELECT id, api_key_ciphertext, access_token_ciphertext,
           access_token_expires_at::text AS access_token_expires_at
    FROM guesthub.channel_connections
    WHERE id = ${res.channel_connection_id} AND tenant_id = ${input.tenantId}
      AND provider = 'beds24' AND is_active_provider = true`;
  if (!conn) return reject("חיבור הערוץ של ההזמנה אינו פעיל");

  const access = await getBeds24AccessToken(db, conn, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if (!access.ok) return reject(access.error);

  // ---- the report itself ----
  const r = await reportBeds24BookingStatus(deps, {
    token: access.token,
    baseUrl: beds24BaseUrl(),
    bookingId: res.external_booking_id,
    action: input.action,
  });

  if (!r.ok) {
    await writeLedgerRow(db, input, {
      status: "failed",
      response: r.envelope ?? null,
      errorMessage: r.message,
    });
    return { success: false, error: r.message };
  }

  // success: ledger first, then the idempotency stamp. A crash between them
  // leaves a truthful ledger and an unstamped reservation — the safe direction
  // (the operator sees the report happened; nothing claims a state it lacks).
  await writeLedgerRow(db, input, {
    status: "success",
    response: r.envelope,
    errorMessage: null,
  });
  await stampReservation(db, input.action, input.reservationId, input.tenantId);
  return { success: true };
}
