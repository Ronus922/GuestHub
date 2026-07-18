"use server";

import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError, type Actor } from "@/lib/auth/actor";
import { writeAudit } from "@/lib/audit";
import { markAriDirty } from "./outbox";
import { enqueueChannelJob } from "./queue";
import { publishDomainEvent } from "@/lib/realtime/publish";
import { decryptSecret } from "./crypto";
import { channexBaseUrl } from "./config";
import { otaSourceKey } from "./booking-normalize";
import {
  cancelDueInvalidCard,
  reportInvalidCard,
  reportNoShow,
} from "./channex-bookings";
import type { ChannexReqOpts } from "./channex-http";
import {
  cancelDueInvalidCardEligibility,
  invalidCardEligibility,
  noShowEligibility,
  zonedMidnightMs,
  type OtaReportContext,
  type ReportEligibility,
} from "./reporting-rules";

// ============================================================
// Booking.com Reporting server actions (D77 §H/§I). All provider calls happen
// HERE — never from React. Eligibility is SERVER-calculated (reporting-rules,
// property-local timezone); the provider remains the final authority and its
// refusal surfaces as a sanitized Hebrew message. Idempotency is durable: the
// reservation row is stamped inside the same transaction that audits the
// action, and a stamped action is never re-sent.
// ============================================================

type Result<T = undefined> = { success: true; data?: T } | { success: false; error: string };

function failFrom(e: unknown): { success: false; error: string } {
  if (e instanceof AuthorizationError) return { success: false, error: e.message };
  console.error("[ota-reporting]", e);
  return { success: false, error: "אירעה שגיאה בלתי צפויה" };
}

type OtaReservationRow = {
  id: string;
  status: string;
  check_in: string;
  check_out: string;
  reservation_number: string;
  channel_connection_id: string | null;
  external_booking_id: string | null;
  ota_name: string | null;
  ota_reservation_code: string | null;
  invalid_card_reported_at: string | null;
  external_cancellation_requested_at: string | null;
  no_show_reported_at: string | null;
};

async function loadOtaReservation(
  db: typeof sql,
  tenantId: string,
  reservationId: string,
): Promise<OtaReservationRow | null> {
  const [row] = await db<OtaReservationRow[]>`
    SELECT id, status, check_in::text AS check_in, check_out::text AS check_out,
           reservation_number, channel_connection_id, external_booking_id,
           ota_name, ota_reservation_code,
           invalid_card_reported_at::text AS invalid_card_reported_at,
           external_cancellation_requested_at::text AS external_cancellation_requested_at,
           no_show_reported_at::text AS no_show_reported_at
    FROM guesthub.reservations
    WHERE id = ${reservationId} AND tenant_id = ${tenantId}`;
  return row ?? null;
}

async function reportContext(
  tenantId: string,
  res: OtaReservationRow,
): Promise<OtaReportContext> {
  const [tenant] = await sql<{ timezone: string | null }[]>`
    SELECT timezone FROM guesthub.tenants WHERE id = ${tenantId}`;
  const tz = tenant?.timezone || "Asia/Jerusalem";
  const ms = (v: string | null) => (v ? Date.parse(v) : null);
  return {
    nowMs: Date.now(),
    checkInMidnightMs: zonedMidnightMs(res.check_in, tz),
    lifecycleStatus: res.status,
    invalidCardReportedAtMs: ms(res.invalid_card_reported_at),
    externalCancellationRequestedAtMs: ms(res.external_cancellation_requested_at),
    noShowReportedAtMs: ms(res.no_show_reported_at),
  };
}

async function bookingCreds(connectionId: string): Promise<{
  creds: ChannexReqOpts;
  tenantId: string;
} | null> {
  const [conn] = await sql<
    { tenant_id: string; environment: "staging" | "production"; api_key_ciphertext: string | null }[]
  >`
    SELECT tenant_id, environment, api_key_ciphertext
    FROM guesthub.channel_connections WHERE id = ${connectionId} AND state = 'active'`;
  if (!conn?.api_key_ciphertext) return null;
  return {
    tenantId: conn.tenant_id,
    creds: {
      apiKey: decryptSecret(conn.api_key_ciphertext),
      baseUrl: channexBaseUrl(conn.environment),
    },
  };
}

export type OtaActionsContext = {
  /** null = not an OTA reservation, or a channel we have no reporting for */
  provider: "booking_com" | null;
  otaReservationCode: string | null;
  externalUniqueId: string | null;
  invalidCard: ReportEligibility;
  cancelDueInvalidCard: ReportEligibility;
  noShow: ReportEligibility;
  invalidCardReportedAt: string | null;
  externalCancellationRequestedAt: string | null;
};

const NOT_OTA: ReportEligibility = { eligible: false, reason: "אינה הזמנת ערוץ" };

// Server-computed dialog context for "בטל הזמנה" on an OTA reservation.
export async function getOtaActionsContextAction(
  reservationId: string,
): Promise<Result<OtaActionsContext>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.view");
    const res = await loadOtaReservation(sql, actor.tenantId, reservationId);
    if (!res) return { success: false, error: "הזמנה לא נמצאה" };
    const isBookingCom =
      res.channel_connection_id !== null &&
      res.external_booking_id !== null &&
      otaSourceKey(res.ota_name) === "booking_com";
    if (!isBookingCom) {
      return {
        success: true,
        data: {
          provider: null,
          otaReservationCode: res.ota_reservation_code,
          externalUniqueId: null,
          invalidCard: NOT_OTA,
          cancelDueInvalidCard: NOT_OTA,
          noShow: NOT_OTA,
          invalidCardReportedAt: null,
          externalCancellationRequestedAt: null,
        },
      };
    }
    const ctx = await reportContext(actor.tenantId, res);
    return {
      success: true,
      data: {
        provider: "booking_com",
        otaReservationCode: res.ota_reservation_code,
        externalUniqueId: res.external_booking_id,
        invalidCard: invalidCardEligibility(ctx),
        cancelDueInvalidCard: cancelDueInvalidCardEligibility(ctx),
        noShow: noShowEligibility(ctx),
        invalidCardReportedAt: res.invalid_card_reported_at,
        externalCancellationRequestedAt: res.external_cancellation_requested_at,
      },
    };
  } catch (e) {
    return failFrom(e);
  }
}

async function requireBookingComReservation(
  actor: Actor,
  reservationId: string,
): Promise<OtaReservationRow> {
  const res = await loadOtaReservation(sql, actor.tenantId, reservationId);
  if (!res) throw new AuthorizationError("הזמנה לא נמצאה");
  if (
    !res.channel_connection_id ||
    !res.external_booking_id ||
    otaSourceKey(res.ota_name) !== "booking_com"
  ) {
    throw new AuthorizationError("הפעולה זמינה רק להזמנות Booking.com");
  }
  return res;
}

// 1) דיווח על כרטיס לא תקין — Booking.com asks the guest to update the card.
// Does NOT cancel anything, locally or upstream.
export async function reportInvalidCardAction(input: {
  reservationId: string;
}): Promise<Result<{ workflowChanged: boolean }>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.edit");
    const res = await requireBookingComReservation(actor, input.reservationId);
    const ctx = await reportContext(actor.tenantId, res);
    const elig = invalidCardEligibility(ctx);
    if (!elig.eligible) return { success: false, error: elig.reason ?? "הפעולה אינה זמינה" };

    const cx = await bookingCreds(res.channel_connection_id!);
    if (!cx) return { success: false, error: "חיבור הערוץ אינו פעיל" };
    const call = await reportInvalidCard(cx.creds, res.external_booking_id!);
    if (!call.ok) return { success: false, error: call.message };

    let workflowChanged = false;
    await sql.begin(async (tx) => {
      await tx`
        UPDATE guesthub.reservations SET invalid_card_reported_at = now()
        WHERE id = ${res.id} AND tenant_id = ${actor.tenantId}
          AND invalid_card_reported_at IS NULL`;
      // workflow tag "כרטיס לא עבר" when the tenant still has it (seeded key)
      const [wf] = await tx<{ id: string }[]>`
        SELECT id FROM guesthub.lookup_items
        WHERE tenant_id = ${actor.tenantId} AND category = 'workflow_statuses'
          AND key = 'card_declined' AND is_active`;
      if (wf) {
        await tx`
          UPDATE guesthub.reservations SET workflow_status_id = ${wf.id}
          WHERE id = ${res.id} AND tenant_id = ${actor.tenantId}`;
        workflowChanged = true;
      }
      await writeAudit(actor, {
        entityType: "reservation",
        entityId: res.id,
        action: "ota_invalid_card_report",
        after: { ota_reservation_code: res.ota_reservation_code, workflow_changed: workflowChanged },
      }, tx);
      await publishDomainEvent(tx, actor.tenantId, {
        type: "reservation.workflow_status_changed",
        reservationId: res.id,
      });
    });
    revalidatePath("/calendar");
    revalidatePath("/reservations");
    return { success: true, data: { workflowChanged } };
  } catch (e) {
    return failFrom(e);
  }
}

// 2) ביטול עקב כרטיס לא תקין — asks Booking.com to cancel. The LOCAL
// reservation is NOT cancelled here: the real cancelled revision arrives via
// the D76 inbound pipeline and cancels it canonically. We only stamp
// "waiting for external confirmation" and wake the pull job.
export async function cancelDueInvalidCardAction(input: {
  reservationId: string;
}): Promise<Result> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.cancel");
    const res = await requireBookingComReservation(actor, input.reservationId);
    const ctx = await reportContext(actor.tenantId, res);
    const elig = cancelDueInvalidCardEligibility(ctx);
    if (!elig.eligible) return { success: false, error: elig.reason ?? "הפעולה אינה זמינה" };

    const cx = await bookingCreds(res.channel_connection_id!);
    if (!cx) return { success: false, error: "חיבור הערוץ אינו פעיל" };
    const call = await cancelDueInvalidCard(cx.creds, res.external_booking_id!);
    if (!call.ok) return { success: false, error: call.message };

    await sql.begin(async (tx) => {
      await tx`
        UPDATE guesthub.reservations SET external_cancellation_requested_at = now()
        WHERE id = ${res.id} AND tenant_id = ${actor.tenantId}
          AND external_cancellation_requested_at IS NULL`;
      await writeAudit(actor, {
        entityType: "reservation",
        entityId: res.id,
        action: "ota_cancel_due_invalid_card",
        after: { ota_reservation_code: res.ota_reservation_code, awaiting_external: true },
      }, tx);
      // wake the existing idempotent inbound pull so the cancelled revision
      // lands as soon as the channel emits it
      await enqueueChannelJob(tx, {
        tenantId: actor.tenantId,
        connectionId: res.channel_connection_id!,
        jobType: "pull_booking_revisions",
        priority: 40,
        idempotencyKey: `inbound_pull:${res.channel_connection_id}`,
      });
      // the honest pending-external state is derived from the stamp — panels
      // refresh on this signal, nothing is cancelled locally yet
      await publishDomainEvent(tx, actor.tenantId, {
        type: "reservation.modified",
        reservationId: res.id,
        lifecycle: res.status,
      });
    });
    revalidatePath("/calendar");
    revalidatePath("/reservations");
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}

// 3) סימון No-show — provider first; ONLY on provider success the canonical
// no_show lifecycle applies locally (non-blocking → the nights release, ARI
// republished in the same transaction).
export async function reportNoShowAction(input: {
  reservationId: string;
  waivedFees: boolean;
}): Promise<Result> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.edit");
    const res = await requireBookingComReservation(actor, input.reservationId);
    const ctx = await reportContext(actor.tenantId, res);
    const elig = noShowEligibility(ctx);
    if (!elig.eligible) return { success: false, error: elig.reason ?? "הפעולה אינה זמינה" };

    const cx = await bookingCreds(res.channel_connection_id!);
    if (!cx) return { success: false, error: "חיבור הערוץ אינו פעיל" };
    const call = await reportNoShow(cx.creds, res.external_booking_id!, input.waivedFees);
    if (!call.ok) return { success: false, error: call.message };

    await sql.begin(async (tx) => {
      await tx`
        UPDATE guesthub.reservations SET status = 'no_show', no_show_reported_at = now()
        WHERE id = ${res.id} AND tenant_id = ${actor.tenantId}`;
      const rooms = await tx<{ room_id: string | null }[]>`
        SELECT room_id FROM guesthub.reservation_rooms
        WHERE reservation_id = ${res.id} AND tenant_id = ${actor.tenantId}`;
      await markAriDirty(tx, {
        tenantId: actor.tenantId,
        roomIds: rooms.map((r) => r.room_id),
        dateFrom: res.check_in,
        dateTo: res.check_out,
      });
      await writeAudit(actor, {
        entityType: "reservation",
        entityId: res.id,
        action: "ota_no_show_report",
        before: { status: res.status },
        after: { status: "no_show", waived_fees: input.waivedFees },
      }, tx);
      const roomIds = rooms.map((r) => r.room_id).filter((x): x is string => !!x);
      await publishDomainEvent(tx, actor.tenantId, {
        type: "reservation.no_show",
        reservationId: res.id,
        roomIds,
        dateFrom: res.check_in,
        dateTo: res.check_out,
        lifecycle: "no_show",
      });
      await publishDomainEvent(tx, actor.tenantId, {
        type: "inventory.changed",
        roomIds,
        dateFrom: res.check_in,
        dateTo: res.check_out,
      });
    });
    revalidatePath("/calendar");
    revalidatePath("/reservations");
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}
