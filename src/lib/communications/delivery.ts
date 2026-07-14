import "server-only";
import { sql } from "@/lib/db";
import { resolveEmailProvider } from "@/lib/messaging/providers";
import type { SendResult } from "@/lib/messaging/types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ClaimedDelivery = {
  id: string;
  tenant_id: string;
  to_address: string;
  subject: string | null;
  rendered_html: string | null;
  rendered_plain_text: string | null;
  rendered_sender_name: string | null;
  rendered_reply_to: string | null;
  attempt_count: number;
  max_attempts: number;
};

export type DeliveryTickResult = {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  ambiguous: number;
  cancelled: number;
};

type ErrorClass = { category: string; permanent: boolean };

export function classifyEmailFailure(result: SendResult): ErrorClass {
  const code = (result.errorCode ?? "unknown").toLowerCase();
  if (/invalid_email_header/.test(code)) return { category: "invalid_render_header", permanent: true };
  if (/gmail_(400|401|403)|invalid_grant|eauth|auth|credential|recipient|address/.test(code)) {
    return { category: /recipient|address/.test(code) ? "invalid_recipient" : "provider_authentication", permanent: true };
  }
  if (/gmail_429|rate|quota/.test(code)) return { category: "provider_rate_limit", permanent: false };
  if (/gmail_5\d\d|timeout|network|connection|socket|econn/.test(code)) {
    return { category: "provider_transient", permanent: false };
  }
  return { category: "provider_unknown", permanent: false };
}

/**
 * A lease that expires while status=submitting is ambiguous: the provider may
 * have accepted the email before the process died. Automatic retry could send a
 * duplicate, so recovery fails closed and leaves an explicit operator-visible
 * category instead of silently resubmitting.
 */
export async function recoverAmbiguousDeliveries(): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    UPDATE guesthub.outbound_messages
    SET status = 'failed', final_error_category = 'ambiguous_provider_outcome',
        error_code = 'ambiguous_provider_outcome',
        error_detail = 'תוצאת השליחה אינה ודאית לאחר הפעלה מחדש של תהליך השליחה',
        lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE status = 'submitting' AND lease_expires_at <= now()
    RETURNING id`;
  if (rows.length > 0) {
    await sql`
      UPDATE guesthub.communication_delivery_attempts a
      SET result = 'failed_final', completed_at = now(),
          error_category = 'ambiguous_provider_outcome'
      WHERE a.delivery_id = ANY(${rows.map((r) => r.id)}::uuid[])
        AND a.result = 'processing'`;
  }
  return rows.length;
}

/**
 * A queued email is not yet a sent email. Between queueing and the send — and
 * across every retry, which can span an hour of backoff — the reservation can be
 * cancelled, marked as a test, or opted out of guest communication. The eligibility
 * that was true when the row was created is therefore RE-ASSERTED at claim time
 * against the live reservation; a booking that is no longer eligible has its
 * delivery cancelled instead of sent.
 *
 * Without this, a guest who phones to cancel still receives "ההזמנה שלכם אושרה".
 */
export async function cancelIneligibleDeliveries(): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    UPDATE guesthub.outbound_messages o
    SET status = 'cancelled', final_error_category = 'reservation_no_longer_eligible',
        error_code = 'reservation_no_longer_eligible',
        error_detail = 'ההזמנה שונתה לאחר הכניסה לתור — ההודעה לא נשלחה',
        lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
    FROM guesthub.reservations r
    WHERE o.status = 'queued' AND o.delivery_type = 'normal'
      AND o.reservation_id IS NOT NULL
      AND r.tenant_id = o.tenant_id AND r.id = o.reservation_id
      AND (r.status <> 'confirmed' OR r.is_test OR r.guest_communication_opt_out)
    RETURNING o.id`;
  return rows.length;
}

/** Claim queued deliveries and create the immutable attempt row atomically. */
export async function claimDeliveries(workerId: string, limit = 10): Promise<ClaimedDelivery[]> {
  return sql.begin(async (tx) => {
    const rows = await tx<ClaimedDelivery[]>`
      WITH candidates AS (
        SELECT id
        FROM guesthub.outbound_messages
        WHERE channel = 'email' AND status = 'queued'
          -- a test send is owned by the action that made it: it reports the real
          -- outcome to the operator inline, and must not be stolen mid-flight
          AND delivery_type <> 'test'
          AND scheduled_at <= now() AND attempt_count < max_attempts
          AND lease_owner IS NULL
        ORDER BY scheduled_at, created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE guesthub.outbound_messages d
      SET status = 'submitting', attempt_count = d.attempt_count + 1,
          lease_owner = ${workerId}, lease_expires_at = now() + interval '5 minutes',
          updated_at = now()
      FROM candidates c
      WHERE d.id = c.id
      RETURNING d.id, d.tenant_id, d.to_address, d.subject,
                d.rendered_html, d.rendered_plain_text, d.rendered_sender_name,
                d.rendered_reply_to, d.attempt_count, d.max_attempts`;
    for (const row of rows) {
      await tx`
        INSERT INTO guesthub.communication_delivery_attempts
          (tenant_id, delivery_id, attempt_number, result)
        VALUES (${row.tenant_id}, ${row.id}, ${row.attempt_count}, 'processing')
        ON CONFLICT (delivery_id, attempt_number) DO NOTHING`;
    }
    return rows;
  });
}

/**
 * Claim ONE known delivery. The test send needs the operator to learn the real
 * outcome inline ("did my template actually go out?"), so it drives the SAME
 * lease → attempt-row → provider → classify path as the worker rather than
 * opening a second, differently-behaved sender.
 */
export async function claimDeliveryById(
  deliveryId: string,
  tenantId: string,
  workerId: string,
): Promise<ClaimedDelivery | null> {
  return sql.begin(async (tx) => {
    const [row] = await tx<ClaimedDelivery[]>`
      UPDATE guesthub.outbound_messages d
      SET status = 'submitting', attempt_count = d.attempt_count + 1,
          lease_owner = ${workerId}, lease_expires_at = now() + interval '5 minutes',
          updated_at = now()
      WHERE d.id = ${deliveryId} AND d.tenant_id = ${tenantId}
        AND d.channel = 'email' AND d.status = 'queued'
        AND d.lease_owner IS NULL AND d.attempt_count < d.max_attempts
      RETURNING d.id, d.tenant_id, d.to_address, d.subject,
                d.rendered_html, d.rendered_plain_text, d.rendered_sender_name,
                d.rendered_reply_to, d.attempt_count, d.max_attempts`;
    if (!row) return null;
    await tx`
      INSERT INTO guesthub.communication_delivery_attempts
        (tenant_id, delivery_id, attempt_number, result)
      VALUES (${row.tenant_id}, ${row.id}, ${row.attempt_count}, 'processing')
      ON CONFLICT (delivery_id, attempt_number) DO NOTHING`;
    return row;
  });
}

async function markSent(
  delivery: ClaimedDelivery,
  workerId: string,
  result: SendResult,
  providerId: "gmail" | "gmail_smtp",
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE guesthub.outbound_messages
      SET status = ${result.status}, provider = ${providerId},
          provider_message_id = ${result.providerMessageId},
          provider_thread_id = ${result.providerThreadId ?? null},
          submitted_at = now(), sent_at = ${result.status === "sent" ? sql`now()` : null},
          error_code = NULL, error_detail = NULL, final_error_category = NULL,
          lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = ${delivery.id} AND status = 'submitting' AND lease_owner = ${workerId}`;
    await tx`
      UPDATE guesthub.communication_delivery_attempts
      SET result = 'submitted', completed_at = now(),
          provider_response_meta = ${tx.json({
            status: result.status,
            providerMessageId: result.providerMessageId,
            providerThreadId: result.providerThreadId ?? null,
          } as never)}
      WHERE delivery_id = ${delivery.id} AND attempt_number = ${delivery.attempt_count}`;
  });
}

async function markFailed(
  delivery: ClaimedDelivery,
  workerId: string,
  error: ErrorClass,
  detail: string,
  code: string | null,
): Promise<"retried" | "failed"> {
  const [settings] = await sql<{ base: number; cap: number }[]>`
    SELECT COALESCE((retry_policy->>'baseDelaySeconds')::int, 60) AS base,
           COALESCE((retry_policy->>'maxDelaySeconds')::int, 3600) AS cap
    FROM guesthub.communication_settings WHERE tenant_id = ${delivery.tenant_id}`;
  const exhausted = delivery.attempt_count >= delivery.max_attempts;
  const final = error.permanent || exhausted;
  const delay = Math.min(settings?.cap ?? 3600, (settings?.base ?? 60) * 2 ** Math.max(0, delivery.attempt_count - 1));
  await sql.begin(async (tx) => {
    await tx`
      UPDATE guesthub.outbound_messages
      SET status = ${final ? "failed" : "queued"},
          scheduled_at = ${final ? sql`scheduled_at` : sql`now() + make_interval(secs => ${delay})`},
          error_code = ${code}, error_detail = ${detail.slice(0, 240)},
          final_error_category = ${final ? error.category : null},
          lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = ${delivery.id} AND status = 'submitting' AND lease_owner = ${workerId}`;
    await tx`
      UPDATE guesthub.communication_delivery_attempts
      SET result = ${final ? (error.permanent ? "failed_permanent" : "failed_final") : "retry_scheduled"},
          completed_at = now(), error_category = ${error.category},
          provider_response_meta = ${tx.json({ errorCode: code } as never)}
      WHERE delivery_id = ${delivery.id} AND attempt_number = ${delivery.attempt_count}`;
  });
  return final ? "failed" : "retried";
}

export async function deliverClaimedEmail(
  delivery: ClaimedDelivery,
  workerId: string,
): Promise<"sent" | "retried" | "failed"> {
  if (!EMAIL_RE.test(delivery.to_address.trim())) {
    return markFailed(delivery, workerId, { category: "invalid_recipient", permanent: true }, "כתובת האימייל אינה תקינה", "invalid_recipient");
  }
  if (!delivery.subject || !delivery.rendered_plain_text || !delivery.rendered_html) {
    return markFailed(delivery, workerId, { category: "invalid_render_snapshot", permanent: true }, "תמונת התוכן למשלוח אינה שלמה", "invalid_render_snapshot");
  }
  let provider;
  try {
    provider = await resolveEmailProvider(delivery.tenant_id);
  } catch {
    return markFailed(
      delivery,
      workerId,
      { category: "provider_configuration_invalid", permanent: true },
      "לא ניתן לקרוא את הגדרת ערוץ האימייל",
      "provider_configuration_invalid",
    );
  }
  if (!provider) {
    return markFailed(delivery, workerId, { category: "provider_not_configured", permanent: true }, "ערוץ האימייל אינו מחובר", "provider_not_configured");
  }
  let result: SendResult;
  try {
    result = await provider.sendEmail({
      to: delivery.to_address.trim(),
      subject: delivery.subject,
      fromName: delivery.rendered_sender_name,
      body: delivery.rendered_plain_text,
      html: delivery.rendered_html,
      replyTo: delivery.rendered_reply_to,
    });
  } catch {
    return markFailed(
      delivery,
      workerId,
      { category: "provider_transient", permanent: false },
      "שירות האימייל לא הגיב",
      "provider_exception",
    );
  }
  if (result.status !== "failed") {
    await markSent(delivery, workerId, result, provider.id);
    return "sent";
  }
  const classification = classifyEmailFailure(result);
  return markFailed(
    delivery,
    workerId,
    classification,
    result.errorDetail ?? "שליחת האימייל נכשלה",
    result.errorCode ?? null,
  );
}

export async function drainDeliveries(workerId: string, limit = 10): Promise<DeliveryTickResult> {
  const summary: DeliveryTickResult = { claimed: 0, sent: 0, retried: 0, failed: 0, ambiguous: 0, cancelled: 0 };
  summary.ambiguous = await recoverAmbiguousDeliveries();
  // eligibility is re-checked BEFORE the claim, so a cancelled booking can never
  // be picked up for sending
  summary.cancelled = await cancelIneligibleDeliveries();
  const deliveries = await claimDeliveries(workerId, limit);
  summary.claimed = deliveries.length;
  for (const delivery of deliveries) {
    const result = await deliverClaimedEmail(delivery, workerId);
    summary[result] += 1;
  }
  return summary;
}
