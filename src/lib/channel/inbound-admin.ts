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
import { ensureChannexWebhook } from "./channex-bookings";

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
  pendingPull: boolean;
  workerOnline: boolean;
  importedTotal: number;
  unacked: number;
  quarantined: number;
  failedRevisions: number;
  lastError: string | null;
  display: { lastImportAt: string; lastPullAt: string };
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
          pendingPull: false,
          workerOnline: false,
          importedTotal: 0,
          unacked: 0,
          quarantined: 0,
          failedRevisions: 0,
          lastError: null,
          display: { lastImportAt: "—", lastPullAt: "—" },
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

    const [worker] = await sql<{ online: boolean }[]>`
      SELECT beat_at > now() - make_interval(secs => ${WORKER_STALE_SECONDS}) AS online
      FROM guesthub.channel_worker_state WHERE id = 'singleton'`;

    return {
      success: true,
      data: {
        connectionId: conn.id,
        enabled: conn.inbound_sync_enabled,
        connectionActive: conn.state === "active",
        webhookRegistered: !!conn.webhook_token_hash,
        pendingPull: !!pending,
        workerOnline: worker?.online ?? false,
        importedTotal: counts?.imported ?? 0,
        unacked: counts?.unacked ?? 0,
        quarantined: counts?.quarantined ?? 0,
        failedRevisions: counts?.failed ?? 0,
        lastError:
          lastQuarantine?.mapping_error ??
          (lastPull?.status !== "succeeded" ? (lastPull?.last_error_message ?? null) : null),
        display: {
          lastImportAt: fmt(conn.last_inbound_import_at),
          lastPullAt: fmt(lastPull?.finished_at ?? null),
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
export async function requestInboundPullAction(): Promise<Result<{ alreadyPending: boolean }>> {
  try {
    const actor = await requireChannelAdmin();
    const conn = await loadConnection(actor.tenantId);
    if (!conn) return { success: false, error: "אין חיבור Channex מוגדר" };
    if (conn.state !== "active" || !conn.inbound_sync_enabled)
      return { success: false, error: "ייבוא הזמנות אינו פעיל בחיבור זה" };

    const res = await enqueueChannelJob(sql, {
      tenantId: actor.tenantId,
      connectionId: conn.id,
      jobType: "pull_booking_revisions",
      priority: 40,
      idempotencyKey: `inbound_pull:${conn.id}`,
    });
    const alreadyPending = !("id" in res);
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: conn.id,
      action: "inbound_pull_request",
      after: { already_pending: alreadyPending },
    });
    return { success: true, data: { alreadyPending } };
  } catch (e) {
    return failFrom(e);
  }
}
