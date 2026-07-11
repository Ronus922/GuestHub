"use server";

import { sql } from "@/lib/db";
import { getActor, AuthorizationError, type Actor } from "@/lib/auth/actor";
import { canManageChannels } from "@/lib/auth/guards";
import { writeAudit } from "@/lib/audit";
import { retryExternalChangeEmail } from "./external-changes";
import { approveExternalChange, rejectExternalChange } from "./booking-import";

// ============================================================
// External change notifications — server actions for /channels (D82).
// super_admin ONLY. Reconciling is an OPERATIONAL acknowledgement: it never
// claims to reverse anything in the OTA (no such outbound API is wired).
//
// HYDRATION CONTRACT (D71): timestamps are PRE-FORMATTED here in the property
// timezone; the client renders strings verbatim.
// ============================================================

type Result<T = undefined> = { success: true; data?: T } | { success: false; error: string };

async function requireChannelAdmin(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new AuthorizationError("לא מחובר למערכת");
  const guard = canManageChannels({ userId: actor.userId, roleKey: actor.roleKey });
  if (!guard.ok) throw new AuthorizationError(guard.error);
  return actor;
}

function failFrom(e: unknown): { success: false; error: string } {
  if (e instanceof AuthorizationError) return { success: false, error: e.message };
  console.error("[channel-external-changes]", e);
  return { success: false, error: "אירעה שגיאה בלתי צפויה" };
}

const HE_DATE_TIME = new Intl.DateTimeFormat("he-IL", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Jerusalem",
});

export type ExternalChangeView = {
  id: string;
  otaReservationCode: string | null;
  otaName: string | null;
  reservationNumber: string | null;
  roomLabels: string[];
  oldCheckIn: string;
  oldCheckOut: string;
  newCheckIn: string;
  newCheckOut: string;
  nightsDiff: number;
  applyStatus: "applied" | "conflict" | "pending_approval" | "rejected" | "superseded";
  conflictDetail: string | null;
  status: "pending" | "reconciled";
  emailStatus: "pending" | "sending" | "sent" | "failed" | "skipped";
  emailDetail: string | null;
  emailSentAtDisplay: string | null;
  emailRetryable: boolean;
  receivedAtDisplay: string;
};

export type ExternalChangesData = {
  pending: ExternalChangeView[];
  recentReconciled: ExternalChangeView[];
  opsRecipient: string | null;
};

type ChangeRow = {
  id: string;
  ota_reservation_code: string | null;
  ota_name: string | null;
  reservation_number: string | null;
  room_labels: string[];
  old_check_in: string;
  old_check_out: string;
  new_check_in: string;
  new_check_out: string;
  apply_status: "applied" | "conflict" | "pending_approval" | "rejected" | "superseded";
  conflict_detail: string | null;
  status: "pending" | "reconciled";
  email_status: "pending" | "sending" | "sent" | "failed" | "skipped";
  email_detail: string | null;
  email_sent_at: Date | null;
  created_at: Date;
};

const MS_PER_NIGHT = 24 * 60 * 60 * 1000;
const nightsOf = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / MS_PER_NIGHT);

function toView(r: ChangeRow): ExternalChangeView {
  return {
    id: r.id,
    otaReservationCode: r.ota_reservation_code,
    otaName: r.ota_name,
    reservationNumber: r.reservation_number,
    roomLabels: r.room_labels ?? [],
    oldCheckIn: r.old_check_in,
    oldCheckOut: r.old_check_out,
    newCheckIn: r.new_check_in,
    newCheckOut: r.new_check_out,
    nightsDiff: nightsOf(r.new_check_in, r.new_check_out) - nightsOf(r.old_check_in, r.old_check_out),
    applyStatus: r.apply_status,
    conflictDetail: r.conflict_detail,
    status: r.status,
    emailStatus: r.email_status,
    emailDetail: r.email_detail,
    emailSentAtDisplay: r.email_sent_at ? HE_DATE_TIME.format(r.email_sent_at) : null,
    emailRetryable: r.email_status === "failed" || r.email_status === "skipped",
    receivedAtDisplay: HE_DATE_TIME.format(r.created_at),
  };
}

const CHANGE_COLUMNS = sql`
  c.id, c.ota_reservation_code, c.ota_name, c.reservation_number, c.room_labels,
  c.old_check_in::text AS old_check_in, c.old_check_out::text AS old_check_out,
  c.new_check_in::text AS new_check_in, c.new_check_out::text AS new_check_out,
  c.apply_status, c.conflict_detail, c.status, c.email_status, c.email_detail,
  om.submitted_at AS email_sent_at, c.created_at`;

const CHANGE_FROM = sql`
  guesthub.channel_external_changes c
  LEFT JOIN guesthub.outbound_messages om ON om.id = c.outbound_message_id`;

export async function getExternalChangesAction(): Promise<Result<ExternalChangesData>> {
  try {
    const actor = await requireChannelAdmin();
    const pending = await sql<ChangeRow[]>`
      SELECT ${CHANGE_COLUMNS} FROM ${CHANGE_FROM}
      WHERE c.tenant_id = ${actor.tenantId} AND c.status = 'pending'
      ORDER BY c.created_at DESC LIMIT 50`;
    const reconciled = await sql<ChangeRow[]>`
      SELECT ${CHANGE_COLUMNS} FROM ${CHANGE_FROM}
      WHERE c.tenant_id = ${actor.tenantId} AND c.status = 'reconciled'
      ORDER BY c.reconciled_at DESC LIMIT 5`;
    const [tenant] = await sql<{ recipient: string | null }[]>`
      SELECT settings->>'ops_notification_email' AS recipient
      FROM guesthub.tenants WHERE id = ${actor.tenantId}`;
    return {
      success: true,
      data: {
        pending: pending.map(toView),
        recentReconciled: reconciled.map(toView),
        opsRecipient: tenant?.recipient ?? null,
      },
    };
  } catch (e) {
    return failFrom(e);
  }
}

// APPROVE a held external date change (037): applies the revision atomically
// server-side (availability re-validated, own rows excluded); on conflict the
// transaction aborts and the request stays pending. Calendar refreshes via the
// committed NOTIFY. Never messages the OTA.
export async function approveExternalChangeAction(input: { id: string }): Promise<Result> {
  try {
    const actor = await requireChannelAdmin();
    const result = await approveExternalChange(sql, actor.tenantId, input.id, actor.userId);
    if (!result.ok) return { success: false, error: result.error };
    await writeAudit(actor, {
      entityType: "channel_external_change",
      entityId: input.id,
      action: "external_change_approve",
      after: { apply_status: "applied", reservation_id: result.reservationId },
    });
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}

// REJECT a held external date change: the local dates stay; the exact revision
// is marked rejected (terminal — duplicate delivery can never recreate it).
// This is a LOCAL decision only: nothing is sent to the OTA, and the channel
// still regards its own modification as effective.
export async function rejectExternalChangeAction(input: { id: string }): Promise<Result> {
  try {
    const actor = await requireChannelAdmin();
    const result = await rejectExternalChange(sql, actor.tenantId, input.id, actor.userId);
    if (!result.ok) return { success: false, error: result.error };
    await writeAudit(actor, {
      entityType: "channel_external_change",
      entityId: input.id,
      action: "external_change_reject",
      after: { apply_status: "rejected", reservation_id: result.reservationId },
    });
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}

// Operational acknowledgement of ONE external change. Does not touch the
// reservation and does not message the OTA — those are separate, explicit
// operator actions.
export async function reconcileExternalChangeAction(input: {
  id: string;
}): Promise<Result> {
  try {
    const actor = await requireChannelAdmin();
    const [row] = await sql<{ id: string }[]>`
      UPDATE guesthub.channel_external_changes
      SET status = 'reconciled', reconciled_at = now(), reconciled_by = ${actor.userId},
          updated_at = now()
      WHERE id = ${input.id} AND tenant_id = ${actor.tenantId} AND status = 'pending'
      RETURNING id`;
    if (!row) return { success: false, error: "השינוי כבר טופל או שאינו קיים" };
    await writeAudit(actor, {
      entityType: "channel_external_change",
      entityId: row.id,
      action: "external_change_reconcile",
      after: { status: "reconciled" },
    });
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}

// Explicit email retry (D83): allowed only for a failed / skipped email; the
// claim inside retryExternalChangeEmail guarantees one revision can never end
// up with two successful logical emails, even against the worker dispatcher.
// Every retry attempt is audited with its prior and resulting state.
export async function retryExternalChangeEmailAction(input: {
  id: string;
}): Promise<Result<{ emailStatus: "sent" | "failed" | "skipped"; detail: string | null }>> {
  try {
    const actor = await requireChannelAdmin();
    const [before] = await sql<{ email_status: string; email_detail: string | null }[]>`
      SELECT email_status, email_detail FROM guesthub.channel_external_changes
      WHERE id = ${input.id} AND tenant_id = ${actor.tenantId}`;
    if (!before) return { success: false, error: "ההתראה אינה קיימת" };
    const result = await retryExternalChangeEmail(sql, actor.tenantId, input.id);
    if (!result.ok) return { success: false, error: result.error };
    await writeAudit(actor, {
      entityType: "channel_external_change",
      entityId: input.id,
      action: "external_change_email_retry",
      before: { email_status: before.email_status, email_detail: before.email_detail },
      after: { email_status: result.emailStatus, email_detail: result.detail },
    });
    return { success: true, data: { emailStatus: result.emailStatus, detail: result.detail } };
  } catch (e) {
    return failFrom(e);
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The operational/admin email recipient for external-change notifications.
// Empty value clears it (emails are then honestly 'skipped').
export async function setOpsRecipientAction(input: { email: string }): Promise<Result> {
  try {
    const actor = await requireChannelAdmin();
    const email = input.email.trim();
    if (email !== "" && !EMAIL_RE.test(email))
      return { success: false, error: "כתובת אימייל אינה תקינה" };
    await sql`
      UPDATE guesthub.tenants
      SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb),
                               '{ops_notification_email}', ${JSON.stringify(email)}::jsonb),
          updated_at = now()
      WHERE id = ${actor.tenantId}`;
    await writeAudit(actor, {
      entityType: "tenant",
      entityId: actor.tenantId,
      action: "ops_notification_email_set",
      after: { ops_notification_email: email || null },
    });
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}
