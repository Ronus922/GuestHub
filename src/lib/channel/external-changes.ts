import type { Sql, TransactionSql } from "postgres";
import { resolveEmailProvider } from "@/lib/messaging/providers";

// ============================================================
// External change notifications (D82) — one visible, reconcilable record per
// inbound OTA revision that MOVES the stay dates of a reservation that already
// exists locally, plus ONE ops email per revision.
//
// INVARIANTS
//  • Idempotent by construction: UNIQUE (connection_id, provider_revision_id)
//    — repeated webhook delivery / repeated pulls never create a second row.
//  • The email leaves 'pending' exactly once (single channel worker); once
//    sent/failed/skipped it is never resent.
//  • "Reconciled" is an operational acknowledgement ONLY — nothing here claims
//    to reverse the change in the OTA, because no such outbound API is wired.
//  • Recording rides the import transaction for applied changes (a notification
//    exists iff the change is durable); conflict records are written after the
//    quarantine, outside any reservation write.
// ============================================================

export type ExternalDateChange = {
  tenantId: string;
  connectionId: string;
  providerRevisionId: string;
  providerBookingId: string;
  otaReservationCode: string | null;
  otaName: string | null;
  reservationId: string | null;
  reservationNumber: string | null;
  oldCheckIn: string;
  oldCheckOut: string;
  newCheckIn: string;
  newCheckOut: string;
  roomLabels: string[];
  applyStatus: "applied" | "conflict";
  conflictDetail?: string | null;
};

export async function recordExternalDateChange(
  db: Sql | TransactionSql,
  c: ExternalDateChange,
): Promise<void> {
  await db`
    INSERT INTO guesthub.channel_external_changes
      (tenant_id, connection_id, provider_revision_id, provider_booking_id,
       ota_reservation_code, ota_name, reservation_id, reservation_number,
       old_check_in, old_check_out, new_check_in, new_check_out,
       room_labels, apply_status, conflict_detail)
    VALUES
      (${c.tenantId}, ${c.connectionId}, ${c.providerRevisionId}, ${c.providerBookingId},
       ${c.otaReservationCode}, ${c.otaName}, ${c.reservationId}, ${c.reservationNumber},
       ${c.oldCheckIn}, ${c.oldCheckOut}, ${c.newCheckIn}, ${c.newCheckOut},
       ${c.roomLabels as never}, ${c.applyStatus}, ${c.conflictDetail ?? null})
    ON CONFLICT (connection_id, provider_revision_id) DO NOTHING`;
}

export async function roomLabelsFor(
  db: Sql | TransactionSql,
  tenantId: string,
  roomIds: string[],
): Promise<string[]> {
  if (roomIds.length === 0) return [];
  const rows = await db<{ room_number: string }[]>`
    SELECT room_number FROM guesthub.rooms
    WHERE tenant_id = ${tenantId} AND id = ANY(${roomIds as never})
    ORDER BY room_number`;
  return rows.map((r) => r.room_number);
}

// ---------------------------------------------------------------
// email dispatch — runs AFTER the pull (never inside a transaction)
// ---------------------------------------------------------------

type PendingEmailRow = {
  id: string;
  tenant_id: string;
  reservation_id: string | null;
  reservation_number: string | null;
  ota_reservation_code: string | null;
  ota_name: string | null;
  old_check_in: string;
  old_check_out: string;
  new_check_in: string;
  new_check_out: string;
  room_labels: string[];
  apply_status: "applied" | "conflict";
  conflict_detail: string | null;
};

function emailSubject(row: PendingEmailRow): string {
  const src = row.ota_name ?? "הערוץ";
  return `שינוי תאריכים התקבל מ-${src} — הזמנה ${row.ota_reservation_code ?? row.reservation_number ?? ""}`.trim();
}

function emailBody(row: PendingEmailRow): string {
  const rooms = row.room_labels.length > 0 ? row.room_labels.join(", ") : "—";
  const applied =
    row.apply_status === "applied"
      ? "השינוי הוחל בלוח השנה — התאריכים החדשים כבר תופסים את החדר."
      : `השינוי לא הוחל — התנגשות זמינות: ${row.conflict_detail ?? "התנגשות"}. הלוח עדיין מציג את התאריכים הקודמים.`;
  return [
    `התקבל שינוי תאריכים מ-${row.ota_name ?? "הערוץ"}.`,
    "",
    `הזמנת ערוץ: ${row.ota_reservation_code ?? "—"}`,
    `הזמנת GuestHub: ${row.reservation_number ?? "—"}`,
    `חדר: ${rooms}`,
    `תאריכים קודמים: ${row.old_check_in} ← ${row.old_check_out}`,
    `תאריכים חדשים: ${row.new_check_in} ← ${row.new_check_out}`,
    "",
    applied,
    "",
    "שימו לב: הערוץ מחשיב את השינוי כמאושר. הטיפול במסך הערוצים הוא תיאום תפעולי בלבד ואינו מבטל את השינוי מול הערוץ.",
  ].join("\n");
}

// One email per notification row. Statuses are terminal: sent / failed /
// skipped — a redelivered webhook finds no 'pending' row and sends nothing.
// ponytail: single-worker claim (the singleton PM2 channel worker is the only
// dispatcher); move to UPDATE-claim rows if a second dispatcher ever appears.
export async function dispatchExternalChangeEmails(db: Sql, tenantId: string): Promise<void> {
  const rows = await db<PendingEmailRow[]>`
    SELECT id, tenant_id, reservation_id, reservation_number, ota_reservation_code,
           ota_name, old_check_in::text AS old_check_in, old_check_out::text AS old_check_out,
           new_check_in::text AS new_check_in, new_check_out::text AS new_check_out,
           room_labels, apply_status, conflict_detail
    FROM guesthub.channel_external_changes
    WHERE tenant_id = ${tenantId} AND email_status = 'pending'
    ORDER BY created_at
    LIMIT 20`;
  if (rows.length === 0) return;

  const [tenant] = await db<{ recipient: string | null }[]>`
    SELECT settings->>'ops_notification_email' AS recipient
    FROM guesthub.tenants WHERE id = ${tenantId}`;
  const recipient = tenant?.recipient?.trim() || null;

  for (const row of rows) {
    if (!recipient) {
      await db`
        UPDATE guesthub.channel_external_changes
        SET email_status = 'skipped',
            email_detail = 'לא הוגדר נמען להתראות תפעוליות',
            updated_at = now()
        WHERE id = ${row.id} AND email_status = 'pending'`;
      continue;
    }
    const provider = await resolveEmailProvider(tenantId);
    if (!provider) {
      await db`
        UPDATE guesthub.channel_external_changes
        SET email_status = 'failed',
            email_detail = 'שירות המייל (Gmail) אינו מוגדר',
            updated_at = now()
        WHERE id = ${row.id} AND email_status = 'pending'`;
      continue;
    }
    const subject = emailSubject(row);
    const body = emailBody(row);
    // honest outbound trail — same table the rest of the messaging platform uses
    const [msg] = await db<{ id: string }[]>`
      INSERT INTO guesthub.outbound_messages
        (tenant_id, reservation_id, guest_id, channel, provider, template_id,
         to_address, subject, body, status, created_by)
      VALUES (${tenantId}, ${row.reservation_id}, NULL, 'email', ${provider.id}, NULL,
              ${recipient}, ${subject}, ${body}, 'submitting', NULL)
      RETURNING id`;
    let sent = false;
    let detail: string | null = null;
    try {
      const result = await provider.sendEmail({ to: recipient, toName: null, subject, body });
      sent = result.status !== "failed";
      detail = result.errorDetail ?? null;
      await db`
        UPDATE guesthub.outbound_messages
        SET status = ${result.status},
            provider_message_id = ${result.providerMessageId ?? null},
            error_detail = ${result.errorDetail ?? null},
            submitted_at = ${sent ? db`now()` : db`submitted_at`},
            updated_at = now()
        WHERE id = ${msg.id}`;
    } catch (e) {
      detail = e instanceof Error ? e.message : "שליחת המייל נכשלה";
      await db`
        UPDATE guesthub.outbound_messages
        SET status = 'failed', error_detail = ${detail}, updated_at = now()
        WHERE id = ${msg.id}`;
    }
    await db`
      UPDATE guesthub.channel_external_changes
      SET email_status = ${sent ? "sent" : "failed"},
          email_detail = ${sent ? null : detail},
          outbound_message_id = ${msg.id},
          updated_at = now()
      WHERE id = ${row.id} AND email_status = 'pending'`;
  }
}
