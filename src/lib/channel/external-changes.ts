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
  applyStatus: "applied" | "conflict" | "pending_approval";
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
  apply_status: "applied" | "conflict" | "pending_approval";
  conflict_detail: string | null;
  created_at: Date;
};

const HE_DATE_TIME = new Intl.DateTimeFormat("he-IL", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Jerusalem",
});

const MS_PER_NIGHT = 24 * 60 * 60 * 1000;
function nightsOf(checkIn: string, checkOut: string): number {
  return Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / MS_PER_NIGHT);
}

function emailSubject(row: PendingEmailRow): string {
  const src = row.ota_name ?? "הערוץ";
  return `שינוי תאריכים התקבל מ-${src} — הזמנה ${row.ota_reservation_code ?? row.reservation_number ?? ""}`.trim();
}

function emailBody(row: PendingEmailRow, guestName: string | null): string {
  const rooms = row.room_labels.length > 0 ? row.room_labels.join(", ") : "—";
  const applied =
    row.apply_status === "applied"
      ? "השינוי הוחל בלוח השנה — התאריכים החדשים כבר תופסים את החדר."
      : row.apply_status === "pending_approval"
        ? "השינוי ממתין לאישורכם במסך הערוצים — הלוח ממשיך להציג את התאריכים הקודמים עד להחלטה."
        : `השינוי לא הוחל — התנגשות זמינות: ${row.conflict_detail ?? "התנגשות"}. הלוח עדיין מציג את התאריכים הקודמים.`;
  const nightsDiff = nightsOf(row.new_check_in, row.new_check_out) - nightsOf(row.old_check_in, row.old_check_out);
  const nightsLine =
    nightsDiff === 0
      ? "הפרש לילות: ללא שינוי"
      : `הפרש לילות: ${nightsDiff > 0 ? "+" : ""}${nightsDiff}`;
  // safe link — the /channels dashboard (authenticated), never a tokenized URL
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  return [
    `התקבל שינוי תאריכים מ-${row.ota_name ?? "הערוץ"}.`,
    "",
    `הזמנת ערוץ: ${row.ota_reservation_code ?? "—"}`,
    `הזמנת GuestHub: ${row.reservation_number ?? "—"}`,
    `אורח: ${guestName ?? "—"}`,
    `חדר: ${rooms}`,
    `תאריכים קודמים: ${row.old_check_in} ← ${row.old_check_out}`,
    `תאריכים חדשים: ${row.new_check_in} ← ${row.new_check_out}`,
    nightsLine,
    `התקבל: ${HE_DATE_TIME.format(row.created_at)}`,
    "",
    applied,
    ...(appUrl ? ["", `לטיפול: ${appUrl}/channels`] : []),
    "",
    "שימו לב: הערוץ מחשיב את השינוי כמאושר. הטיפול במסך הערוצים הוא תיאום תפעולי בלבד ואינו מבטל את השינוי מול הערוץ.",
  ].join("\n");
}

// One attempt for ONE claimed row (its email_status is already 'sending' —
// the caller won the atomic claim, so no other process is sending this
// revision's email). Terminal result: sent / failed / skipped.
async function attemptClaimedEmail(db: Sql, row: PendingEmailRow): Promise<{
  emailStatus: "sent" | "failed" | "skipped";
  detail: string | null;
}> {
  const [tenant] = await db<{ recipient: string | null }[]>`
    SELECT settings->>'ops_notification_email' AS recipient
    FROM guesthub.tenants WHERE id = ${row.tenant_id}`;
  const recipient = tenant?.recipient?.trim() || null;

  const finish = async (
    emailStatus: "sent" | "failed" | "skipped",
    detail: string | null,
    outboundId: string | null,
  ) => {
    await db`
      UPDATE guesthub.channel_external_changes
      SET email_status = ${emailStatus},
          email_detail = ${detail},
          outbound_message_id = COALESCE(${outboundId}, outbound_message_id),
          updated_at = now()
      WHERE id = ${row.id} AND email_status = 'sending'`;
    return { emailStatus, detail };
  };

  if (!recipient) return finish("skipped", "לא הוגדר נמען להתראות תפעוליות", null);
  const provider = await resolveEmailProvider(row.tenant_id);
  if (!provider) return finish("failed", "שירות המייל (Gmail) אינו מוגדר", null);

  let guestName: string | null = null;
  if (row.reservation_id) {
    const [g] = await db<{ name: string | null }[]>`
      SELECT NULLIF(TRIM(COALESCE(g.first_name, '') || ' ' || COALESCE(g.last_name, '')), '') AS name
      FROM guesthub.reservations r
      JOIN guesthub.guests g ON g.id = r.primary_guest_id
      WHERE r.id = ${row.reservation_id} AND r.tenant_id = ${row.tenant_id}`;
    guestName = g?.name ?? null;
  }

  const subject = emailSubject(row);
  const body = emailBody(row, guestName);
  // honest outbound trail — same table the rest of the messaging platform
  // uses; every attempt (including retries) leaves its own row
  const [msg] = await db<{ id: string }[]>`
    INSERT INTO guesthub.outbound_messages
      (tenant_id, reservation_id, guest_id, channel, provider, template_id,
       to_address, subject, body, status, created_by)
    VALUES (${row.tenant_id}, ${row.reservation_id}, NULL, 'email', ${provider.id}, NULL,
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
  return finish(sent ? "sent" : "failed", sent ? null : detail, msg.id);
}

// Atomic claim: flip exactly one row from an eligible status to 'sending'.
// Exactly one process wins; the loser sees no row. This is what makes ONE
// logical email per revision hold across the worker dispatcher and the UI
// retry action concurrently.
async function claimEmailRow(
  db: Sql,
  changeId: string,
  tenantId: string,
  eligible: readonly string[],
): Promise<PendingEmailRow | null> {
  const [row] = await db<PendingEmailRow[]>`
    UPDATE guesthub.channel_external_changes
    SET email_status = 'sending', updated_at = now()
    WHERE id = ${changeId} AND tenant_id = ${tenantId}
      AND email_status = ANY(${eligible as string[]})
    RETURNING id, tenant_id, reservation_id, reservation_number, ota_reservation_code,
              ota_name, old_check_in::text AS old_check_in, old_check_out::text AS old_check_out,
              new_check_in::text AS new_check_in, new_check_out::text AS new_check_out,
              room_labels, apply_status, conflict_detail, created_at`;
  return row ?? null;
}

// Automatic dispatch (worker, after each pull): one email per notification
// row. Results are terminal — sent / failed / skipped — so a redelivered
// webhook finds no 'pending' row and sends nothing. failed/skipped stay
// retryable through the explicit super_admin action below, never resent
// automatically.
export async function dispatchExternalChangeEmails(db: Sql, tenantId: string): Promise<void> {
  const rows = await db<{ id: string }[]>`
    SELECT id FROM guesthub.channel_external_changes
    WHERE tenant_id = ${tenantId} AND email_status = 'pending'
    ORDER BY created_at
    LIMIT 20`;
  for (const { id } of rows) {
    const claimed = await claimEmailRow(db, id, tenantId, ["pending"]);
    if (claimed) await attemptClaimedEmail(db, claimed);
  }
}

// Explicit retry (super_admin): only a failed / skipped email — or a 'sending'
// claim stuck for 10+ minutes (a crash mid-send; delivery of that attempt is
// unknown, which is exactly why re-arming it is a human decision, never
// automatic). A 'sent' row is final: one revision, one successful email.
export async function retryExternalChangeEmail(
  db: Sql,
  tenantId: string,
  changeId: string,
): Promise<{ ok: true; emailStatus: "sent" | "failed" | "skipped"; detail: string | null } | { ok: false; error: string }> {
  // un-stick a crashed claim first (no-op otherwise)
  await db`
    UPDATE guesthub.channel_external_changes
    SET email_status = 'failed', email_detail = 'שליחה קודמת לא הושלמה', updated_at = now()
    WHERE id = ${changeId} AND tenant_id = ${tenantId}
      AND email_status = 'sending' AND updated_at < now() - interval '10 minutes'`;
  const claimed = await claimEmailRow(db, changeId, tenantId, ["failed", "skipped"]);
  if (!claimed) {
    const [cur] = await db<{ email_status: string }[]>`
      SELECT email_status FROM guesthub.channel_external_changes
      WHERE id = ${changeId} AND tenant_id = ${tenantId}`;
    if (!cur) return { ok: false, error: "ההתראה אינה קיימת" };
    if (cur.email_status === "sent")
      return { ok: false, error: "המייל כבר נשלח בהצלחה — לא ניתן לשלוח שוב" };
    return { ok: false, error: "שליחה כבר מתבצעת כעת" };
  }
  const result = await attemptClaimedEmail(db, claimed);
  return { ok: true, ...result };
}
