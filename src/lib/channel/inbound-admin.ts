"use server";

import { sql } from "@/lib/db";
import { getActor, AuthorizationError, type Actor } from "@/lib/auth/actor";
import { canManageChannels } from "@/lib/auth/guards";
import { writeAudit } from "@/lib/audit";
import { enqueueChannelJob } from "./queue";
import { CHANNEX_BASE_URLS } from "./config";
import {
  channelSecretsConfigured,
  decryptSecret,
  generateWebhookToken,
  sha256Hex,
} from "./crypto";
import { ensureChannexWebhook, listChannexWebhooks } from "./channex-bookings";

// ============================================================
// Inbound-booking server actions for /channels (D76) — super_admin ONLY,
// enforced server-side. The manual "משיכת הזמנות עכשיו" action ONLY enqueues
// the same durable, idempotent pull job the webhook and the fallback poll
// enqueue — the network/import work never runs in a web request.
//
// HYDRATION CONTRACT (D71): every timestamp in the view is PRE-FORMATTED here,
// in the property timezone; the client renders strings verbatim.
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
  console.error("[channel-inbound]", e);
  return { success: false, error: "אירעה שגיאה בלתי צפויה" };
}

const PROPERTY_TIME_ZONE = "Asia/Jerusalem";
const HE_DATE_TIME = new Intl.DateTimeFormat("he-IL", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: PROPERTY_TIME_ZONE,
});
const fmt = (v: Date | null): string => (v ? HE_DATE_TIME.format(v) : "—");

const WORKER_STALE_SECONDS = 90;

type ConnRow = {
  id: string;
  state: string;
  environment: "staging" | "production";
  inbound_sync_enabled: boolean;
  channex_property_id: string | null;
  api_key_ciphertext: string | null;
  webhook_token_hash: string | null;
  last_inbound_import_at: Date | null;
};

async function loadConnection(tenantId: string): Promise<ConnRow | null> {
  const [row] = await sql<ConnRow[]>`
    SELECT id, state, environment, inbound_sync_enabled, channex_property_id,
           api_key_ciphertext, webhook_token_hash, last_inbound_import_at
    FROM guesthub.channel_connections
    WHERE tenant_id = ${tenantId} AND provider = 'channex'
    ORDER BY environment LIMIT 1`;
  return row ?? null;
}

export type InboundStatusView = {
  connectionId: string | null;
  enabled: boolean;
  connectionActive: boolean;
  webhookRegistered: boolean;
  /** callback shape only — the token itself is stored hashed and never shown */
  callbackDisplay: string | null;
  webhookEventsTotal: number;
  pendingPull: boolean;
  workerOnline: boolean;
  importedTotal: number;
  unacked: number;
  quarantined: number;
  failedRevisions: number;
  /** queue health across ALL job types of this connection (D77 §23) */
  jobs: { pending: number; retryWait: number; deadLetter: number };
  /** seconds the oldest runnable inbound pull has been waiting (0 = none) */
  inboundLagSeconds: number;
  /** seconds the oldest pending ARI dirty range has been waiting (0 = none) */
  outboundLagSeconds: number;
  /** honest operator-facing warnings, server-computed */
  alerts: string[];
  lastError: string | null;
  display: {
    lastImportAt: string;
    lastPullAt: string;
    lastWebhookAt: string;
    lastWebhookType: string;
    lastRevisionAt: string;
    lastAckAt: string;
    lastDrainAt: string;
  };
};

export async function getInboundStatusAction(): Promise<Result<InboundStatusView>> {
  try {
    const actor = await requireChannelAdmin();
    const conn = await loadConnection(actor.tenantId);
    if (!conn) {
      return {
        success: true,
        data: {
          connectionId: null,
          enabled: false,
          connectionActive: false,
          webhookRegistered: false,
          callbackDisplay: null,
          webhookEventsTotal: 0,
          pendingPull: false,
          workerOnline: false,
          importedTotal: 0,
          unacked: 0,
          quarantined: 0,
          failedRevisions: 0,
          jobs: { pending: 0, retryWait: 0, deadLetter: 0 },
          inboundLagSeconds: 0,
          outboundLagSeconds: 0,
          alerts: [],
          lastError: null,
          display: {
            lastImportAt: "—",
            lastPullAt: "—",
            lastWebhookAt: "—",
            lastWebhookType: "—",
            lastRevisionAt: "—",
            lastAckAt: "—",
            lastDrainAt: "—",
          },
        },
      };
    }

    const [counts] = await sql<
      { imported: number; unacked: number; quarantined: number; failed: number }[]
    >`
      SELECT
        COUNT(*) FILTER (WHERE import_status = 'imported')::int AS imported,
        COUNT(*) FILTER (WHERE ack_status = 'unacknowledged')::int AS unacked,
        COUNT(*) FILTER (WHERE import_status = 'quarantined')::int AS quarantined,
        COUNT(*) FILTER (WHERE import_status = 'failed')::int AS failed
      FROM guesthub.channel_booking_revisions
      WHERE connection_id = ${conn.id}`;

    const [pending] = await sql<{ x: number }[]>`
      SELECT 1 AS x FROM guesthub.channel_sync_jobs
      WHERE connection_id = ${conn.id} AND job_type = 'pull_booking_revisions'
        AND status IN ('queued', 'processing', 'retry_wait')
      LIMIT 1`;

    const [lastPull] = await sql<
      { finished_at: Date | null; status: string; last_error_message: string | null }[]
    >`
      SELECT finished_at, status, last_error_message
      FROM guesthub.channel_sync_jobs
      WHERE connection_id = ${conn.id} AND job_type = 'pull_booking_revisions'
        AND status IN ('succeeded', 'failed', 'dead_letter')
      ORDER BY finished_at DESC NULLS LAST LIMIT 1`;

    // latest visible inbound problem: a parked revision beats an older job error
    const [lastQuarantine] = await sql<{ mapping_error: string | null }[]>`
      SELECT mapping_error FROM guesthub.channel_booking_revisions
      WHERE connection_id = ${conn.id}
        AND import_status IN ('quarantined', 'failed') AND mapping_error IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1`;

    const [worker] = await sql<{ online: boolean; last_drain_at: Date | null }[]>`
      SELECT beat_at > now() - make_interval(secs => ${WORKER_STALE_SECONDS}) AS online,
             last_drain_at
      FROM guesthub.channel_worker_state WHERE id = 'singleton'`;

    // §23 observability reads — webhook trail, revision trail, queue health
    const [webhookStats] = await sql<
      { total: number; last_at: Date | null; last_type: string | null }[]
    >`
      SELECT COUNT(*)::int AS total, MAX(received_at) AS last_at,
             (SELECT event_type FROM guesthub.channel_webhook_events
               WHERE connection_id = ${conn.id} ORDER BY received_at DESC LIMIT 1) AS last_type
      FROM guesthub.channel_webhook_events
      WHERE connection_id = ${conn.id}`;

    const [revStats] = await sql<{ last_rev: Date | null; last_ack: Date | null }[]>`
      SELECT MAX(created_at) AS last_rev, MAX(acknowledged_at) AS last_ack
      FROM guesthub.channel_booking_revisions
      WHERE connection_id = ${conn.id}`;

    const [jobStats] = await sql<
      { pending: number; retry_wait: number; dead_letter: number; oldest_pull_secs: number | null }[]
    >`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('queued', 'processing'))::int AS pending,
        COUNT(*) FILTER (WHERE status = 'retry_wait')::int AS retry_wait,
        COUNT(*) FILTER (WHERE status = 'dead_letter')::int AS dead_letter,
        EXTRACT(EPOCH FROM (now() - MIN(created_at)
          FILTER (WHERE job_type = 'pull_booking_revisions'
                  AND status IN ('queued', 'retry_wait'))))::int AS oldest_pull_secs
      FROM guesthub.channel_sync_jobs
      WHERE connection_id = ${conn.id}`;

    const [rangeStats] = await sql<{ oldest_pending_secs: number | null }[]>`
      SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::int AS oldest_pending_secs
      FROM guesthub.channel_dirty_ranges
      WHERE connection_id = ${conn.id} AND status = 'pending'`;

    const [pendingChanges] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM guesthub.channel_external_changes
      WHERE connection_id = ${conn.id} AND status = 'pending'`;

    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
    const workerOnline = worker?.online ?? false;
    const webhookEventsTotal = webhookStats?.total ?? 0;

    const alerts: string[] = [];
    if (conn.inbound_sync_enabled && !!conn.webhook_token_hash && webhookEventsTotal === 0)
      alerts.push(
        "ה-webhook רשום אך מעולם לא התקבל אירוע — בדקו את הרישום מול Channex (רישום ובדיקה מחדש)",
      );
    if ((counts?.unacked ?? 0) > 0 && !pending)
      alerts.push("קיימות רוויזיות מיובאות ללא אישור (ACK) ואין משיכה ממתינה");
    if ((counts?.quarantined ?? 0) > 0)
      alerts.push("רוויזיות בהסגר ממתינות לטיפול (מיפוי חדר / התנגשות)");
    if ((pendingChanges?.n ?? 0) > 0)
      alerts.push("שינויי תאריכים חיצוניים ממתינים לטיפול — ראו \"שינויים חיצוניים מהערוצים\"");
    if ((jobStats?.dead_letter ?? 0) > 0)
      alerts.push("קיימות משימות שנכשלו סופית (dead-letter) — בדקו ונסו שוב");
    if ((rangeStats?.oldest_pending_secs ?? 0) > 300)
      alerts.push("עדכוני זמינות ממתינים מעל 5 דקות — בדקו את עובד הרקע");
    if (!workerOnline) alerts.push("עובד הרקע אינו פועל — שום סנכרון לא מתבצע");

    return {
      success: true,
      data: {
        connectionId: conn.id,
        enabled: conn.inbound_sync_enabled,
        connectionActive: conn.state === "active",
        webhookRegistered: !!conn.webhook_token_hash,
        callbackDisplay:
          conn.webhook_token_hash && appUrl ? `${appUrl}/api/channel/webhook/••••` : null,
        webhookEventsTotal,
        pendingPull: !!pending,
        workerOnline,
        importedTotal: counts?.imported ?? 0,
        unacked: counts?.unacked ?? 0,
        quarantined: counts?.quarantined ?? 0,
        failedRevisions: counts?.failed ?? 0,
        jobs: {
          pending: jobStats?.pending ?? 0,
          retryWait: jobStats?.retry_wait ?? 0,
          deadLetter: jobStats?.dead_letter ?? 0,
        },
        inboundLagSeconds: Math.max(0, jobStats?.oldest_pull_secs ?? 0),
        outboundLagSeconds: Math.max(0, rangeStats?.oldest_pending_secs ?? 0),
        alerts,
        lastError:
          lastQuarantine?.mapping_error ??
          (lastPull?.status !== "succeeded" ? (lastPull?.last_error_message ?? null) : null),
        display: {
          lastImportAt: fmt(conn.last_inbound_import_at),
          lastPullAt: fmt(lastPull?.finished_at ?? null),
          lastWebhookAt: fmt(webhookStats?.last_at ?? null),
          lastWebhookType: webhookStats?.last_type ?? "—",
          lastRevisionAt: fmt(revStats?.last_rev ?? null),
          lastAckAt: fmt(revStats?.last_ack ?? null),
          lastDrainAt: fmt(worker?.last_drain_at ?? null),
        },
      },
    };
  } catch (e) {
    return failFrom(e);
  }
}

// Enable/disable inbound booking import. On enable, a per-connection webhook
// token is generated (stored HASHED only) and registered with Channex as a
// wake-up signal — registration failure is a WARNING, not a blocker: the
// worker's fallback poll alone imports every booking.
export async function setInboundEnabledAction(input: {
  enabled: boolean;
}): Promise<Result<{ webhookWarning: string | null }>> {
  try {
    const actor = await requireChannelAdmin();
    const conn = await loadConnection(actor.tenantId);
    if (!conn) return { success: false, error: "אין חיבור Channex מוגדר" };

    let webhookWarning: string | null = null;
    if (input.enabled) {
      if (conn.state !== "active")
        return { success: false, error: "החיבור אינו פעיל — הפעל את החיבור תחילה" };
      if (!conn.channex_property_id || !conn.api_key_ciphertext)
        return { success: false, error: "חסר מיפוי נכס או מפתח API" };
      if (!channelSecretsConfigured())
        return { success: false, error: "מפתח ההצפנה של הערוצים אינו מוגדר בשרת" };

      if (!conn.webhook_token_hash) {
        const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
        if (!appUrl) {
          webhookWarning = "כתובת האפליקציה אינה מוגדרת — הייבוא יתבסס על משיכה תקופתית בלבד";
        } else {
          const token = generateWebhookToken();
          const result = await ensureChannexWebhook(
            {
              apiKey: decryptSecret(conn.api_key_ciphertext),
              baseUrl: CHANNEX_BASE_URLS[conn.environment] ?? CHANNEX_BASE_URLS.staging,
            },
            conn.channex_property_id,
            `${appUrl}/api/channel/webhook/${token}`,
          );
          if (result.ok) {
            await sql`
              UPDATE guesthub.channel_connections
              SET webhook_token_hash = ${sha256Hex(token)}
              WHERE id = ${conn.id}`;
          } else {
            // no half-state: without a registered callback the token is useless
            webhookWarning = `רישום ה-webhook נכשל (${result.message}) — הייבוא יתבסס על משיכה תקופתית`;
          }
        }
      }
    }

    await sql`
      UPDATE guesthub.channel_connections
      SET inbound_sync_enabled = ${input.enabled}
      WHERE id = ${conn.id}`;
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: conn.id,
      action: input.enabled ? "inbound_enable" : "inbound_disable",
      after: { inbound_sync_enabled: input.enabled, webhook_warning: webhookWarning },
    });
    return { success: true, data: { webhookWarning } };
  } catch (e) {
    return failFrom(e);
  }
}

// "משיכת הזמנות עכשיו" — enqueue the SAME idempotent durable pull job the
// webhook and fallback poll use. Never pulls or imports inside the request.
// Optional revisionId = the §10 controlled recovery: ONE named revision is
// fetched through the same canonical pipeline (the worker's payload consumer).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requestInboundPullAction(input?: {
  revisionId?: string;
}): Promise<Result<{ alreadyPending: boolean }>> {
  try {
    const actor = await requireChannelAdmin();
    const conn = await loadConnection(actor.tenantId);
    if (!conn) return { success: false, error: "אין חיבור Channex מוגדר" };
    if (conn.state !== "active" || !conn.inbound_sync_enabled)
      return { success: false, error: "ייבוא הזמנות אינו פעיל בחיבור זה" };
    const revisionId = input?.revisionId?.trim() || null;
    if (revisionId && !UUID_RE.test(revisionId))
      return { success: false, error: "מזהה רוויזיה אינו UUID תקין" };

    const res = await enqueueChannelJob(sql, {
      tenantId: actor.tenantId,
      connectionId: conn.id,
      jobType: "pull_booking_revisions",
      priority: 40,
      payload: revisionId ? { revision_id: revisionId } : undefined,
      idempotencyKey: revisionId
        ? `inbound_pull_rev:${conn.id}:${revisionId}`
        : `inbound_pull:${conn.id}`,
    });
    const alreadyPending = !("id" in res);
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: conn.id,
      action: "inbound_pull_request",
      after: { already_pending: alreadyPending, revision_id: revisionId },
    });
    return { success: true, data: { alreadyPending } };
  } catch (e) {
    return failFrom(e);
  }
}

// "רישום ובדיקת Webhook" — the D77 forensic fix for "webhook registered but
// zero events ever received": rotate the token, register the fresh callback
// with Channex, then PROVE the whole public chain by self-POSTing a test
// event to the public URL (nginx → route → token auth → dedup row → durable
// pull job → NOTIFY wake). Every step is reported honestly; the plaintext
// token exists only inside this action.
export type WebhookTestReport = {
  registered: boolean;
  created: boolean;
  /** other webhooks upstream still pointing at this app (stale registrations) */
  staleUpstream: number;
  selfTestHttpStatus: number | null;
  eventRecorded: boolean;
  jobEnqueued: boolean;
  warning: string | null;
};

export async function reregisterWebhookAction(): Promise<Result<WebhookTestReport>> {
  try {
    const actor = await requireChannelAdmin();
    const conn = await loadConnection(actor.tenantId);
    if (!conn) return { success: false, error: "אין חיבור Channex מוגדר" };
    if (conn.state !== "active" || !conn.channex_property_id || !conn.api_key_ciphertext)
      return { success: false, error: "החיבור אינו פעיל או שאין נכס ממופה" };
    // the callback authenticates only enabled connections — test after enabling
    if (!conn.inbound_sync_enabled)
      return { success: false, error: "הפעל ייבוא הזמנות תחילה — הבדיקה רצה על חיבור פעיל" };
    if (!channelSecretsConfigured())
      return { success: false, error: "מפתח ההצפנה של הערוצים אינו מוגדר בשרת" };
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
    if (!appUrl) return { success: false, error: "NEXT_PUBLIC_APP_URL אינו מוגדר" };

    const creds = {
      apiKey: decryptSecret(conn.api_key_ciphertext),
      baseUrl: CHANNEX_BASE_URLS[conn.environment] ?? CHANNEX_BASE_URLS.staging,
    };
    const token = generateWebhookToken();
    const callbackUrl = `${appUrl}/api/channel/webhook/${token}`;

    const reg = await ensureChannexWebhook(creds, conn.channex_property_id, callbackUrl);
    if (!reg.ok) return { success: false, error: `רישום ה-webhook נכשל: ${reg.message}` };

    // hash persisted ONLY after upstream registration succeeded (no half-state)
    await sql`
      UPDATE guesthub.channel_connections
      SET webhook_token_hash = ${sha256Hex(token)}
      WHERE id = ${conn.id}`;

    // stale upstream registrations still pointing at this app (old tokens now
    // 404) — reported for manual cleanup in the Channex UI; never DELETEd here
    let staleUpstream = 0;
    const list = await listChannexWebhooks(creds, conn.channex_property_id);
    if (list.ok) {
      staleUpstream = list.webhooks.filter(
        (w) => w.callbackUrl?.startsWith(`${appUrl}/api/channel/webhook/`) && w.callbackUrl !== callbackUrl,
      ).length;
    }

    // self-test through the PUBLIC url — proves nginx routing + auth + dedup +
    // durable enqueue. The test event pulls the (likely empty) feed: harmless.
    const dedupKey = `webhook-self-test-${Date.now()}`;
    let selfTestHttpStatus: number | null = null;
    try {
      const resp = await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "test", event_id: dedupKey }),
        signal: AbortSignal.timeout(8000),
      });
      selfTestHttpStatus = resp.status;
    } catch {
      selfTestHttpStatus = null;
    }

    const [eventRow] = await sql<{ x: number }[]>`
      SELECT 1 AS x FROM guesthub.channel_webhook_events
      WHERE connection_id = ${conn.id} AND dedup_key = ${dedupKey} LIMIT 1`;
    const [jobRow] = await sql<{ x: number }[]>`
      SELECT 1 AS x FROM guesthub.channel_sync_jobs
      WHERE connection_id = ${conn.id}
        AND idempotency_key = ${`pull:${conn.id}:${dedupKey}`} LIMIT 1`;

    const report: WebhookTestReport = {
      registered: true,
      created: reg.created,
      staleUpstream,
      selfTestHttpStatus,
      eventRecorded: !!eventRow,
      jobEnqueued: !!jobRow,
      warning:
        selfTestHttpStatus === 200 && eventRow && jobRow
          ? null
          : selfTestHttpStatus === null
            ? "הבדיקה העצמית לא הגיעה לכתובת הציבורית — בדקו DNS/nginx"
            : `הבדיקה העצמית החזירה ${selfTestHttpStatus} — בדקו את הנתיב הציבורי`,
    };
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: conn.id,
      action: "webhook_reregister",
      after: {
        created: reg.created,
        stale_upstream: staleUpstream,
        self_test_status: selfTestHttpStatus,
        event_recorded: !!eventRow,
        job_enqueued: !!jobRow,
      },
    });
    return { success: true, data: report };
  } catch (e) {
    return failFrom(e);
  }
}
