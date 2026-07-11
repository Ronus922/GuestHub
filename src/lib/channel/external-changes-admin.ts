"use server";

import { sql } from "@/lib/db";
import { getActor, AuthorizationError, type Actor } from "@/lib/auth/actor";
import { canManageChannels } from "@/lib/auth/guards";
import { writeAudit } from "@/lib/audit";

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
  applyStatus: "applied" | "conflict";
  conflictDetail: string | null;
  status: "pending" | "reconciled";
  emailStatus: "pending" | "sent" | "failed" | "skipped";
  emailDetail: string | null;
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
  apply_status: "applied" | "conflict";
  conflict_detail: string | null;
  status: "pending" | "reconciled";
  email_status: "pending" | "sent" | "failed" | "skipped";
  email_detail: string | null;
  created_at: Date;
};

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
    applyStatus: r.apply_status,
    conflictDetail: r.conflict_detail,
    status: r.status,
    emailStatus: r.email_status,
    emailDetail: r.email_detail,
    receivedAtDisplay: HE_DATE_TIME.format(r.created_at),
  };
}

const CHANGE_COLUMNS = sql`
  id, ota_reservation_code, ota_name, reservation_number, room_labels,
  old_check_in::text AS old_check_in, old_check_out::text AS old_check_out,
  new_check_in::text AS new_check_in, new_check_out::text AS new_check_out,
  apply_status, conflict_detail, status, email_status, email_detail, created_at`;

export async function getExternalChangesAction(): Promise<Result<ExternalChangesData>> {
  try {
    const actor = await requireChannelAdmin();
    const pending = await sql<ChangeRow[]>`
      SELECT ${CHANGE_COLUMNS} FROM guesthub.channel_external_changes
      WHERE tenant_id = ${actor.tenantId} AND status = 'pending'
      ORDER BY created_at DESC LIMIT 50`;
    const reconciled = await sql<ChangeRow[]>`
      SELECT ${CHANGE_COLUMNS} FROM guesthub.channel_external_changes
      WHERE tenant_id = ${actor.tenantId} AND status = 'reconciled'
      ORDER BY reconciled_at DESC LIMIT 5`;
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
