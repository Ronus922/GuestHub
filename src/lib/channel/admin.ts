"use server";

import { sql } from "@/lib/db";
import { getActor, AuthorizationError, type Actor } from "@/lib/auth/actor";
import { canManageChannels } from "@/lib/auth/guards";
import { writeAudit, auditRequestContext } from "@/lib/audit";
import { enqueueChannelJob } from "./queue";
import { CHANNEX_BASE_URLS } from "./config";
import { encryptSecret, decryptSecret, secretHint, channelSecretsConfigured } from "./crypto";
import { runChannexConnectionTest, type ChannexErrorCategory } from "./connection-test";
import { outcomeOf, sanitizeProgress, type FullSyncOutcome, type FullSyncProgress } from "./ari-progress";
import {
  listChannexProperties,
  getChannexProperty,
  createChannexProperty as apiCreateChannexProperty,
  updateChannexProperty as apiUpdateChannexProperty,
  type ChannexApiFailure,
  type ChannexPropertyDetail,
  type ChannexPropertySummary,
} from "./channex-properties";
import { getBusinessProfile } from "@/lib/business/store";
import { buildChannexUpdatePayload, diffChannexUpdate, type ChannexFieldChange } from "@/lib/business/profile";
import {
  resolveChannexProfile,
  computeReadiness,
  buildCreatePropertyPayload,
  sortRoomsForPreview,
  type ChannexProfile,
  type ChannexProfileOverrides,
  type Readiness,
  type PreviewRoomInput,
  type TenantIdentity,
} from "./property-profile";

// ============================================================
// Channel-management server actions (§O) — super_admin ONLY, enforced
// server-side on every action (UI hiding is not security). No action here
// accepts or stores a credential in Phase 3, none performs a network call.
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
  if (e instanceof AuthorizationError || (e instanceof Error && e.message.startsWith("ניהול")))
    return { success: false, error: (e as Error).message };
  console.error("[channel-admin]", e);
  return { success: false, error: "אירעה שגיאה בלתי צפויה" };
}

// Observability snapshot (§AA): connection state, mapping completeness, queue
// health, dirty backlog, latest errors — masked metadata only, never secrets.
export async function getChannelStatusAction(): Promise<Result<unknown>> {
  try {
    const actor = await requireChannelAdmin();
    const connections = await sql`
      SELECT id, provider, environment, state, channex_property_id,
             outbound_sync_enabled, inbound_sync_enabled, full_sync_required,
             api_key_hint, last_outbound_sync_at, last_inbound_import_at,
             last_reconciliation_at, last_error, created_at, updated_at
      FROM guesthub.channel_connections
      WHERE tenant_id = ${actor.tenantId}
      ORDER BY created_at`;
    const [counts] = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM guesthub.channel_sync_jobs
          WHERE tenant_id = ${actor.tenantId} AND status IN ('queued','retry_wait')) AS pending_jobs,
        (SELECT COUNT(*)::int FROM guesthub.channel_sync_jobs
          WHERE tenant_id = ${actor.tenantId} AND status = 'failed') AS failed_jobs,
        (SELECT COUNT(*)::int FROM guesthub.channel_sync_jobs
          WHERE tenant_id = ${actor.tenantId} AND status = 'dead_letter') AS dead_letter_jobs,
        (SELECT COUNT(*)::int FROM guesthub.channel_dirty_ranges
          WHERE tenant_id = ${actor.tenantId} AND status = 'pending') AS dirty_ranges,
        -- descriptive GuestHub categories. NOT the Channex inventory unit (D64):
        -- the inventory unit is the physical room, so these are never presented
        -- as "room type mapping progress".
        (SELECT COUNT(*)::int FROM guesthub.room_types
          WHERE tenant_id = ${actor.tenantId} AND is_active) AS room_categories,
        (SELECT COUNT(*)::int FROM guesthub.rooms
          WHERE tenant_id = ${actor.tenantId} AND is_active) AS active_rooms,
        (SELECT COUNT(*)::int FROM guesthub.channel_room_mappings
          WHERE tenant_id = ${actor.tenantId} AND status = 'mapped') AS mapped_rooms,
        (SELECT COUNT(*)::int FROM guesthub.channel_room_mappings
          WHERE tenant_id = ${actor.tenantId} AND status = 'mapped'
            AND channex_room_type_id IS NOT NULL) AS channex_room_types,
        (SELECT COUNT(*)::int FROM guesthub.channel_booking_revisions
          WHERE tenant_id = ${actor.tenantId} AND import_status = 'quarantined') AS quarantined_revisions`;
    const errors = await sql`
      SELECT id, connection_id, room_type_id, date_from, date_to,
             error_code, error_message, created_at
      FROM guesthub.channel_sync_errors
      WHERE tenant_id = ${actor.tenantId} AND resolved_at IS NULL
      ORDER BY created_at DESC LIMIT 10`;
    return { success: true, data: { connections, counts, errors } };
  } catch (e) {
    return failFrom(e);
  }
}

// Create/update the (credential-less) connection configuration. State can
// only move between disconnected/configured here — activation is a future,
// separate, explicitly-verified flow.
export async function upsertChannelConnectionAction(input: {
  environment: "staging" | "production";
  channexPropertyId?: string;
}): Promise<Result<{ id: string }>> {
  try {
    const actor = await requireChannelAdmin();
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO guesthub.channel_connections
        (tenant_id, provider, environment, state, channex_property_id, created_by, updated_by)
      VALUES (${actor.tenantId}, 'channex', ${input.environment},
              ${input.channexPropertyId ? "configured" : "disconnected"},
              ${input.channexPropertyId ?? null}, ${actor.userId}, ${actor.userId})
      ON CONFLICT (tenant_id, provider, environment) DO UPDATE SET
        channex_property_id = EXCLUDED.channex_property_id,
        state = CASE WHEN guesthub.channel_connections.state IN ('disconnected','configured')
                     THEN EXCLUDED.state ELSE guesthub.channel_connections.state END,
        updated_by = EXCLUDED.updated_by
      RETURNING id`;
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: row.id,
      action: "upsert",
      after: { environment: input.environment, property: input.channexPropertyId ?? null },
    });
    return { success: true, data: { id: row.id } };
  } catch (e) {
    return failFrom(e);
  }
}

export async function upsertRoomTypeMappingAction(input: {
  connectionId: string;
  roomTypeId: string;
  channexRoomTypeId: string | null;
}): Promise<Result> {
  try {
    const actor = await requireChannelAdmin();
    const [before] = await sql`
      SELECT channex_room_type_id, status FROM guesthub.channel_room_type_mappings
      WHERE tenant_id = ${actor.tenantId} AND connection_id = ${input.connectionId}
        AND room_type_id = ${input.roomTypeId}`;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO guesthub.channel_room_type_mappings
        (tenant_id, connection_id, room_type_id, channex_room_type_id, status)
      SELECT ${actor.tenantId}, c.id, rt.id, ${input.channexRoomTypeId},
             ${input.channexRoomTypeId ? "mapped" : "unmapped"}
      FROM guesthub.channel_connections c, guesthub.room_types rt
      WHERE c.id = ${input.connectionId} AND c.tenant_id = ${actor.tenantId}
        AND rt.id = ${input.roomTypeId} AND rt.tenant_id = ${actor.tenantId}
      ON CONFLICT (connection_id, room_type_id) DO UPDATE SET
        channex_room_type_id = EXCLUDED.channex_room_type_id,
        status = EXCLUDED.status, validation_error = NULL
      RETURNING id`;
    if (!row) return { success: false, error: "חיבור או סוג חדר לא נמצאו" };
    // audit every mapping change (§N)
    await writeAudit(actor, {
      entityType: "channel_room_type_mapping",
      entityId: row.id,
      action: "upsert",
      before: before ?? undefined,
      after: { channex_room_type_id: input.channexRoomTypeId },
    });
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}

export async function upsertRatePlanMappingAction(input: {
  connectionId: string;
  roomTypeId: string;
  channexRatePlanId: string | null;
}): Promise<Result> {
  try {
    const actor = await requireChannelAdmin();
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO guesthub.channel_rate_plan_mappings
        (tenant_id, connection_id, room_type_id, channex_rate_plan_id, status)
      SELECT ${actor.tenantId}, c.id, rt.id, ${input.channexRatePlanId},
             ${input.channexRatePlanId ? "mapped" : "unmapped"}
      FROM guesthub.channel_connections c, guesthub.room_types rt
      WHERE c.id = ${input.connectionId} AND c.tenant_id = ${actor.tenantId}
        AND rt.id = ${input.roomTypeId} AND rt.tenant_id = ${actor.tenantId}
      ON CONFLICT (connection_id, room_type_id, local_plan_code) DO UPDATE SET
        channex_rate_plan_id = EXCLUDED.channex_rate_plan_id,
        status = EXCLUDED.status, validation_error = NULL
      RETURNING id`;
    if (!row) return { success: false, error: "חיבור או סוג חדר לא נמצאו" };
    await writeAudit(actor, {
      entityType: "channel_rate_plan_mapping",
      entityId: row.id,
      action: "upsert",
      after: { channex_rate_plan_id: input.channexRatePlanId },
    });
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}

// THE Full Sync action (§V, wired by D68) — super_admin only, explicitly
// operator-triggered from /channels, and the ONLY way a Channex connection ever
// becomes outbound-enabled.
//
// It enqueues a durable `full_sync` job and returns immediately: the PM2 channel
// worker runs the projection and the two API calls (availability, then
// rates/restrictions) out of band, so the operator's request never waits on
// Channex and a lost browser tab cannot abandon a half-finished sync.
//
// 'ready' — a validated connection with a mapped property — is exactly the state
// Full Sync exists to leave, so the job is runnable there. It is suppressed only
// for a connection that is not yet usable (disconnected/configured/validating/
// paused/error), where it would be a dead backlog.
//
// ============================================================
// THE stored-key probe (D70). One GET /properties/options with the credential
// that is ALREADY in the database — decrypted server-side, never taken from a
// request body, a form field, a query parameter or any browser state. Used by
// "בדיקת חיבור" and by the Full Sync preflight, so the two can never disagree.
//
// It records the verdict on the connection row (state + last_test_*), and
// returns only a fixed, safe Hebrew message keyed by category. The key, the
// ciphertext and the upstream body never leave this function.
// ============================================================
type ProbeResult =
  | { ok: true; propertyCount: number }
  | { ok: false; error: string; category: ChannexErrorCategory | "not_configured" | "undecryptable" };

async function probeStoredChannexKey(tenantId: string): Promise<ProbeResult> {
  if (!channelSecretsConfigured())
    return { ok: false, error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת", category: "not_configured" };

  const row = await loadChannexRow(tenantId);
  if (!row?.api_key_ciphertext)
    return { ok: false, error: "מפתח API לא הוגדר", category: "not_configured" };

  let apiKey: string;
  try {
    apiKey = decryptSecret(row.api_key_ciphertext);
  } catch {
    // Wrong/rotated CHANNEL_SECRETS_KEY — never leak the ciphertext or the error.
    return { ok: false, error: "פענוח המפתח נכשל — ייתכן שמפתח ההצפנה בשרת השתנה", category: "undecryptable" };
  }

  const result = await runChannexConnectionTest({ apiKey, baseUrl: CHANNEX_BASE_URLS.staging });

  if (result.ok) {
    await sql`
      UPDATE guesthub.channel_connections
      SET state = CASE WHEN state = 'active' THEN 'active' ELSE 'ready' END,
          last_test_ok_at = now(), last_test_error_code = NULL, last_error = NULL, updated_at = now()
      WHERE tenant_id = ${tenantId} AND provider = 'channex' AND environment = ${CHANNEX_ENV}`;
    return { ok: true, propertyCount: result.propertyCount };
  }

  await sql`
    UPDATE guesthub.channel_connections
    SET state = CASE WHEN state = 'active' THEN 'active' ELSE 'error' END,
        last_test_failed_at = now(), last_test_error_code = ${result.category},
        last_error = ${result.message}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND provider = 'channex' AND environment = ${CHANNEX_ENV}`;
  return { ok: false, error: result.message, category: result.category };
}

// DUPLICATE PREVENTION (D69 §6) is enforced by the DATABASE, not the button: the
// partial unique index uq_jobs_idempotency (connection_id, idempotency_key) WHERE
// status IN ('queued','processing','retry_wait') makes a second concurrent
// full_sync row impossible. enqueueChannelJob's ON CONFLICT DO NOTHING reports
// that as `duplicate`, and we answer with the ALREADY-ACTIVE run's id and status
// instead of starting a second sync. The disabled button is only cosmetic.
const FULL_SYNC_RUNNABLE_STATES = new Set(["ready", "active"]);
const ACTIVE_JOB_STATES = ["queued", "processing", "retry_wait"];

export type FullSyncRequestResult = {
  /** the channel_sync_jobs row id — the run id the progress record is keyed by */
  runId: string | null;
  status: string;
  /** true ⇒ a Full Sync was ALREADY running; no second one was created */
  alreadyRunning: boolean;
};

export async function requestFullSyncAction(
  connectionId: string,
): Promise<Result<FullSyncRequestResult>> {
  try {
    const actor = await requireChannelAdmin();
    const [conn] = await sql<{ id: string; state: string; channex_property_id: string | null }[]>`
      SELECT id, state, channex_property_id FROM guesthub.channel_connections
      WHERE id = ${connectionId} AND tenant_id = ${actor.tenantId}`;
    if (!conn) return { success: false, error: "חיבור לא נמצא" };

    const runnable = FULL_SYNC_RUNNABLE_STATES.has(conn.state);
    if (runnable && !conn.channex_property_id)
      return { success: false, error: "לא קיים נכס Channex ממופה — יש למפות נכס תחילה" };

    // D70 §7 — a Full Sync must never *start* on a credential that cannot
    // authenticate. Probe the STORED key first (one GET /properties/options,
    // never an ARI request). On failure: no job row, no progress run, no
    // projection, no ARI — and the operator sees the real, safe reason.
    if (runnable) {
      const auth = await probeStoredChannexKey(actor.tenantId);
      if (!auth.ok) return { success: false, error: auth.error };
    }

    const enqueued = await enqueueChannelJob(sql, {
      tenantId: actor.tenantId,
      connectionId: conn.id,
      jobType: "full_sync",
      priority: 10,
      idempotencyKey: `full_sync:${conn.id}`,
      suppressed: !runnable,
    });
    const alreadyRunning = "duplicate" in enqueued;

    // Only a genuinely NEW run re-arms the flag; a duplicate click changes nothing.
    if (!alreadyRunning) {
      await sql`
        UPDATE guesthub.channel_connections SET full_sync_required = true
        WHERE id = ${conn.id}`;
    }
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: conn.id,
      action: "request_full_sync",
      after: { state: conn.state, runnable, duplicate: alreadyRunning },
    });

    if (!runnable)
      return { success: false, error: "החיבור אינו מוכן לסנכרון — יש לאמת מפתח ולמפות נכס" };

    // Report the run that is actually live — the existing one on a duplicate.
    const [active] = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM guesthub.channel_sync_jobs
      WHERE connection_id = ${conn.id} AND job_type = 'full_sync'
        AND status = ANY(${ACTIVE_JOB_STATES})
      ORDER BY created_at DESC LIMIT 1`;

    return {
      success: true,
      data: {
        runId: active?.id ?? ("id" in enqueued ? enqueued.id : null),
        status: active?.status ?? "queued",
        alreadyRunning,
      },
    };
  } catch (e) {
    return failFrom(e);
  }
}

// ============================================================
// ARI synchronisation status (D68) — everything the existing diagnostics area
// needs to answer "is the baseline established, is the worker alive, is anything
// stuck?". READ-ONLY: no Channex call, no secret, no raw upstream body.
// ============================================================

export type AriSyncStatus = {
  /** the connection has an established, warning-free baseline */
  active: boolean;
  fullSyncRequired: boolean;
  fullSyncJob: {
    status: string;
    dateFrom: string | null;
    dateTo: string | null;
    taskIds: string[];
    finishedAt: string | null;
    errorCode: string | null;
  } | null;
  /**
   * Persisted, milestone-based Full Sync progress (D69). Written ONLY by the
   * channel worker into channel_sync_jobs.payload.progress, so it survives a page
   * refresh, navigation, a closed browser and a web-process restart. Sanitized:
   * no api-key, no ciphertext, no ARI payload, no upstream response body.
   */
  progress: FullSyncProgress | null;
  outcome: FullSyncOutcome;
  /** a run is live — the UI polls and the Full Sync button stays disabled */
  running: boolean;
  lastSuccessfulSyncAt: string | null;
  pendingRanges: number;
  failedRanges: number;
  /** safe, fixed-vocabulary message — never an upstream response body */
  lastError: string | null;
  worker: { online: boolean; beatAt: string | null; lastDrainAt: string | null } | null;
};

/** job states in which a Full Sync run is still live */
const LIVE_JOB_STATES = new Set(["queued", "processing", "retry_wait"]);

/** A heartbeat older than this means the PM2 worker is not running. */
const WORKER_STALE_SECONDS = 90;

export async function getAriSyncStatusAction(connectionId: string): Promise<Result<AriSyncStatus>> {
  try {
    const actor = await requireChannelAdmin();
    const [conn] = await sql<
      { state: string; outbound_sync_enabled: boolean; full_sync_required: boolean;
        last_outbound_sync_at: Date | null; last_error: string | null }[]
    >`
      SELECT state, outbound_sync_enabled, full_sync_required, last_outbound_sync_at, last_error
      FROM guesthub.channel_connections
      WHERE id = ${connectionId} AND tenant_id = ${actor.tenantId}`;
    if (!conn) return { success: false, error: "חיבור לא נמצא" };

    const [job] = await sql<
      { status: string; date_from: string | null; date_to: string | null; payload: unknown;
        finished_at: Date | null; last_error_code: string | null }[]
    >`
      SELECT status, date_from::text AS date_from, date_to::text AS date_to, payload,
             finished_at, last_error_code
      FROM guesthub.channel_sync_jobs
      WHERE connection_id = ${connectionId} AND job_type = 'full_sync'
      ORDER BY created_at DESC LIMIT 1`;

    const [ranges] = await sql<{ pending: number; failed: number }[]>`
      SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
             count(*) FILTER (WHERE status = 'failed')::int  AS failed
      FROM guesthub.channel_dirty_ranges WHERE connection_id = ${connectionId}`;

    const [w] = await sql<
      { beat_at: Date | null; last_drain_at: Date | null; fresh: boolean }[]
    >`
      SELECT beat_at, last_drain_at,
             (beat_at > now() - make_interval(secs => ${WORKER_STALE_SECONDS})) AS fresh
      FROM guesthub.channel_worker_state WHERE id = 'singleton'`;

    const payload = (job?.payload ?? {}) as { task_ids?: unknown; progress?: unknown };
    const taskIds = Array.isArray(payload.task_ids)
      ? payload.task_ids.filter((t): t is string => typeof t === "string")
      : [];
    // sanitizeProgress drops anything not on the whitelist — a stale or
    // hand-edited payload can never smuggle a field into the browser.
    const progress = sanitizeProgress(payload.progress);
    const running = job ? LIVE_JOB_STATES.has(job.status) : false;

    return {
      success: true,
      data: {
        active: conn.state === "active" && conn.outbound_sync_enabled && !conn.full_sync_required,
        fullSyncRequired: conn.full_sync_required,
        fullSyncJob: job
          ? {
              status: job.status,
              dateFrom: job.date_from,
              dateTo: job.date_to,
              taskIds,
              finishedAt: job.finished_at?.toISOString() ?? null,
              errorCode: job.last_error_code,
            }
          : null,
        progress,
        outcome: running ? "running" : outcomeOf(progress),
        running,
        lastSuccessfulSyncAt: conn.last_outbound_sync_at?.toISOString() ?? null,
        pendingRanges: ranges?.pending ?? 0,
        failedRanges: ranges?.failed ?? 0,
        lastError: conn.last_error,
        worker: w ? { online: !!w.fresh, beatAt: w.beat_at?.toISOString() ?? null, lastDrainAt: w.last_drain_at?.toISOString() ?? null } : null,
      },
    };
  } catch (e) {
    return failFrom(e);
  }
}

// ============================================================
// Channex STAGING connection (D59) — secure credential handling + a real,
// server-side "Test connection". super_admin ONLY (requireChannelAdmin). The
// api-key is stored AES-256-GCM encrypted (crypto.ts, key from env), never
// returned to the browser, never placed in an audit payload, a log or an
// error. Scope: prove the connection only — no property/room-type/rate-plan/
// webhook/booking is created here.
// ============================================================

const CHANNEX_ENV = "staging" as const;

// Masked, secret-free view of the staging connection for the UI.
export type ChannexConnectionView = {
  environment: "staging";
  baseUrl: string;
  secretsKeyConfigured: boolean;
  configured: boolean; // an api-key is stored
  apiKeyHint: string | null; // "••••/BaJ" — never the key
  state: string;
  lastTestOkAt: string | null;
  lastTestFailedAt: string | null;
  lastTestErrorCode: string | null;
  lastError: string | null;
};

type ChannexRow = {
  id: string;
  state: string;
  api_key_ciphertext: string | null;
  api_key_hint: string | null;
  last_test_ok_at: Date | null;
  last_test_failed_at: Date | null;
  last_test_error_code: string | null;
  last_error: string | null;
};

async function loadChannexRow(tenantId: string): Promise<ChannexRow | null> {
  const [row] = await sql<ChannexRow[]>`
    SELECT id, state, api_key_ciphertext, api_key_hint, last_test_ok_at,
           last_test_failed_at, last_test_error_code, last_error
    FROM guesthub.channel_connections
    WHERE tenant_id = ${tenantId} AND provider = 'channex' AND environment = ${CHANNEX_ENV}`;
  return row ?? null;
}

const iso = (v: Date | null): string | null => (v ? v.toISOString() : null);

// 1) Masked staging-connection view. NEVER selects/returns the ciphertext.
export async function getChannexConnectionAction(): Promise<Result<ChannexConnectionView>> {
  try {
    const actor = await requireChannelAdmin();
    const row = await loadChannexRow(actor.tenantId);
    return {
      success: true,
      data: {
        environment: CHANNEX_ENV,
        baseUrl: CHANNEX_BASE_URLS.staging,
        secretsKeyConfigured: channelSecretsConfigured(),
        configured: !!row?.api_key_hint,
        apiKeyHint: row?.api_key_hint ?? null,
        state: row?.state ?? "disconnected",
        lastTestOkAt: iso(row?.last_test_ok_at ?? null),
        lastTestFailedAt: iso(row?.last_test_failed_at ?? null),
        lastTestErrorCode: row?.last_test_error_code ?? null,
        lastError: row?.last_error ?? null,
      },
    };
  } catch (e) {
    return failFrom(e);
  }
}

// 2) Save or replace the staging api-key (encrypted at rest). A blank input is
// rejected — replacement always supplies the full new key; the existing value
// is never exposed to enable a "keep current" flow.
//
// D70 — VERIFY BEFORE PERSIST. The candidate key is authenticated against Channex
// (one GET /properties/options — never an ARI request) and is written ONLY on a
// 200. A working credential can therefore never be replaced by a rejected one, an
// unverifiable one, or a value a password manager put in the field. On any
// non-200 the stored ciphertext is left exactly as it was.
export async function saveChannexApiKeyAction(input: { apiKey: string }): Promise<Result> {
  try {
    const actor = await requireChannelAdmin();
    if (!channelSecretsConfigured())
      return { success: false, error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת" };
    const apiKey = input.apiKey.trim();
    if (!apiKey) return { success: false, error: "יש להזין מפתח API" };

    const existing = await loadChannexRow(actor.tenantId);
    const replacing = !!existing?.api_key_ciphertext;

    // Authenticate the CANDIDATE before it touches the database.
    const probe = await runChannexConnectionTest({ apiKey, baseUrl: CHANNEX_BASE_URLS.staging });
    if (!probe.ok) {
      await writeAudit(actor, {
        entityType: "channel_connection",
        entityId: existing?.id ?? null,
        action: "channex_credential_rejected",
        // category only — never the candidate value, never the stored key
        after: { environment: CHANNEX_ENV, category: probe.category, replacing },
      });
      const keep = replacing ? " — המפתח הקיים נשמר ללא שינוי" : "";
      return { success: false, error: `${probe.message}${keep}` };
    }

    const [row] = await sql<{ id: string }[]>`
      INSERT INTO guesthub.channel_connections
        (tenant_id, provider, environment, state, api_key_ciphertext, api_key_hint,
         created_by, updated_by)
      VALUES (${actor.tenantId}, 'channex', ${CHANNEX_ENV}, 'ready',
              ${encryptSecret(apiKey)}, ${secretHint(apiKey)}, ${actor.userId}, ${actor.userId})
      ON CONFLICT (tenant_id, provider, environment) DO UPDATE SET
        api_key_ciphertext = EXCLUDED.api_key_ciphertext,
        api_key_hint = EXCLUDED.api_key_hint,
        -- the credential was authenticated moments ago (verify-before-persist),
        -- so the fresh verdict IS this write; an already-active link stays active
        state = CASE WHEN guesthub.channel_connections.state = 'active'
                     THEN 'active' ELSE 'ready' END,
        last_test_ok_at = now(), last_test_failed_at = NULL,
        last_test_error_code = NULL, last_error = NULL,
        updated_by = ${actor.userId}, updated_at = now()
      RETURNING id`;

    // Audit carries ONLY the environment + a boolean — never the key or the hint.
    const ctx = await auditRequestContext();
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: row.id,
      action: replacing ? "channex_credential_replaced" : "channex_credential_configured",
      after: { environment: CHANNEX_ENV },
      ip: ctx.ip,
      session: ctx.session,
    });
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}

// 3) Real, server-side connection test against Channex Staging.
//
// It takes NO ARGUMENT — by construction it can only use the credential stored in
// the database. The replacement input, unsaved React state, query parameters,
// localStorage and cookies have no path into it. scripts/check-channex-credential.mjs
// asserts that at the source level (zero parameters, zero request-body reads).
//
// The credential is preserved on failure; only sanitized metadata is recorded.
export async function testChannexConnectionAction(): Promise<
  Result<{ ok: boolean; propertyCount?: number; category?: string; message?: string }>
> {
  try {
    const actor = await requireChannelAdmin();
    const probe = await probeStoredChannexKey(actor.tenantId);
    const ctx = await auditRequestContext();

    if (probe.ok) {
      await writeAudit(actor, {
        entityType: "channel_connection",
        entityId: null,
        action: "channex_connection_test_succeeded",
        after: { environment: CHANNEX_ENV, propertyCount: probe.propertyCount },
        ip: ctx.ip,
        session: ctx.session,
      });
      return { success: true, data: { ok: true, propertyCount: probe.propertyCount } };
    }

    // A missing/undecryptable key is a configuration problem, not a test verdict.
    if (probe.category === "not_configured" || probe.category === "undecryptable") {
      return { success: false, error: probe.error };
    }

    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: null,
      action: "channex_connection_test_failed",
      after: { environment: CHANNEX_ENV, category: probe.category },
      ip: ctx.ip,
      session: ctx.session,
    });
    return { success: true, data: { ok: false, category: probe.category, message: probe.error } };
  } catch (e) {
    return failFrom(e);
  }
}

// ============================================================
// Channex STAGING property mapping (D60) — map the EXISTING GuestHub tenant to
// exactly ONE Channex Staging property. super_admin ONLY. The local property is
// the tenant (guesthub.tenants); NO new local property/room/room-type is
// created. The mapping lives on the existing channel_connections row (1:1 per
// tenant+provider+environment). The ACTUAL external property is created/adopted
// by the operator from the UI — never automatically. NO Channex room-type/
// rate-plan/channel/webhook/ARI/booking is created here.
// ============================================================

const apiFail = (f: ChannexApiFailure): { success: false; error: string } => ({
  success: false,
  error: f.message,
});

function toPropertySnapshot(p: ChannexPropertyDetail): Record<string, unknown> {
  return {
    title: p.title,
    currency: p.currency,
    country: p.country,
    city: p.city,
    address: p.address,
    zip_code: p.zipCode,
    email: p.email,
    phone: p.phone,
    website: p.website,
    timezone: p.timezone,
    property_type: p.propertyType,
    latitude: p.latitude,
    longitude: p.longitude,
    is_active: p.isActive,
    room_type_count: p.roomTypeCount,
  };
}

// Masked, secret-free property-mapping context for the UI (no api-key, no
// ciphertext, no raw upstream body). Built entirely from the DB — page load
// performs NO Channex network call.
export type ChannexPropertyMappingView = {
  propertyId: string;
  title: string | null;
  method: "created" | "adopted" | null;
  snapshot: Record<string, unknown> | null;
  verifiedAt: string | null;
  reconcileState: "ok" | "inaccessible" | null;
} | null;

export type ChannexPropertyContextView = {
  secretsKeyConfigured: boolean;
  apiKeyConfigured: boolean;
  tenant: { tenantId: string; name: string; currency: string; timezone: string };
  profile: ChannexProfile;
  overrides: ChannexProfileOverrides; // to prefill the profile editor — no secrets
  readiness: Readiness;
  rooms: PreviewRoomInput[]; // read-only, numeric-sorted
  roomCount: number;
  activeRoomCount: number;
  roomTypeCount: number;
  mapping: ChannexPropertyMappingView;
  // canonical Business Profile identity (source of truth — NOT tenants.name).
  // The /channels card shows these; editing happens in /settings, not here.
  business: { businessName: string | null; propertyName: string | null; hasPropertyName: boolean };
};

type TenantContextRow = {
  name: string;
  currency: string;
  timezone: string;
  channex_profile: ChannexProfileOverrides | null;
};

type PropertyMappingRow = {
  channex_property_id: string | null;
  channex_property_title: string | null;
  channex_property_method: "created" | "adopted" | null;
  channex_property_snapshot: Record<string, unknown> | null;
  channex_property_verified_at: Date | null;
  channex_reconcile_state: "ok" | "inaccessible" | null;
};

async function loadTenantContext(tenantId: string): Promise<{
  identity: TenantIdentity;
  overrides: ChannexProfileOverrides;
} | null> {
  const [t] = await sql<TenantContextRow[]>`
    SELECT name, currency, timezone, settings->'channex_profile' AS channex_profile
    FROM guesthub.tenants WHERE id = ${tenantId}`;
  if (!t) return null;
  return {
    identity: { tenantId, name: t.name, currency: t.currency, timezone: t.timezone },
    overrides: t.channex_profile ?? {},
  };
}

async function loadPropertyMappingRow(tenantId: string): Promise<PropertyMappingRow | null> {
  const [row] = await sql<PropertyMappingRow[]>`
    SELECT channex_property_id, channex_property_title, channex_property_method,
           channex_property_snapshot, channex_property_verified_at, channex_reconcile_state
    FROM guesthub.channel_connections
    WHERE tenant_id = ${tenantId} AND provider = 'channex' AND environment = ${CHANNEX_ENV}`;
  return row ?? null;
}

function mappingView(row: PropertyMappingRow | null): ChannexPropertyMappingView {
  if (!row?.channex_property_id) return null;
  return {
    propertyId: row.channex_property_id,
    title: row.channex_property_title,
    method: row.channex_property_method,
    snapshot: row.channex_property_snapshot,
    verifiedAt: iso(row.channex_property_verified_at),
    reconcileState: row.channex_reconcile_state,
  };
}

// Decrypt the stored staging api-key for a server-side Channex call. The key is
// never returned to the browser and never logged. Missing/undecryptable → safe
// error, credential preserved.
async function withChannexKey(
  tenantId: string,
): Promise<{ ok: true; apiKey: string } | { ok: false; error: string }> {
  const row = await loadChannexRow(tenantId);
  if (!row?.api_key_ciphertext)
    return { ok: false, error: "מפתח API לא הוגדר — שמור מפתח Channex תחילה" };
  try {
    return { ok: true, apiKey: decryptSecret(row.api_key_ciphertext) };
  } catch {
    return { ok: false, error: "פענוח המפתח נכשל — ייתכן שמפתח ההצפנה בשרת השתנה" };
  }
}

// 1) Read-only mapping context: tenant identity, resolved profile + readiness,
// existing rooms preview (numeric-sorted), room counts and the current mapping.
// NO Channex network call — safe on every page load.
export async function getChannexPropertyContextAction(): Promise<Result<ChannexPropertyContextView>> {
  try {
    const actor = await requireChannelAdmin();
    const ctx = await loadTenantContext(actor.tenantId);
    if (!ctx) return { success: false, error: "לא נמצא ארגון (tenant) פעיל" };

    const [rooms, [counts], mappingRow, keyRow] = await Promise.all([
      sql<PreviewRoomInput[]>`
        SELECT r.id, r.room_number, a.name AS area_name, r.floor,
               rt.name AS room_type_name, r.is_active, r.status,
               r.min_occupancy, r.max_occupancy, r.max_adults, r.max_children, r.max_infants
        FROM guesthub.rooms r
        LEFT JOIN guesthub.areas a       ON a.id  = r.area_id
        LEFT JOIN guesthub.room_types rt ON rt.id = r.room_type_id
        WHERE r.tenant_id = ${actor.tenantId}`,
      sql<{ room_count: number; active_room_count: number; room_type_count: number }[]>`
        SELECT
          (SELECT COUNT(*)::int FROM guesthub.rooms
             WHERE tenant_id = ${actor.tenantId}) AS room_count,
          (SELECT COUNT(*)::int FROM guesthub.rooms
             WHERE tenant_id = ${actor.tenantId} AND is_active) AS active_room_count,
          (SELECT COUNT(*)::int FROM guesthub.room_types
             WHERE tenant_id = ${actor.tenantId} AND is_active) AS room_type_count`,
      loadPropertyMappingRow(actor.tenantId),
      loadChannexRow(actor.tenantId),
    ]);

    const profile = resolveChannexProfile(ctx.identity, ctx.overrides);
    const business = await getBusinessProfile(actor.tenantId);
    return {
      success: true,
      data: {
        business: {
          businessName: business?.businessName ?? null,
          propertyName: business?.propertyName ?? null,
          hasPropertyName: !!business?.propertyName,
        },
        secretsKeyConfigured: channelSecretsConfigured(),
        apiKeyConfigured: !!keyRow?.api_key_ciphertext,
        tenant: ctx.identity,
        profile,
        overrides: ctx.overrides,
        readiness: computeReadiness(profile),
        rooms: sortRoomsForPreview(rooms),
        roomCount: counts?.room_count ?? 0,
        activeRoomCount: counts?.active_room_count ?? 0,
        roomTypeCount: counts?.room_type_count ?? 0,
        mapping: mappingView(mappingRow),
      },
    };
  } catch (e) {
    return failFrom(e);
  }
}

// 2) Save the integration-only profile overrides into tenants.settings
// ->'channex_profile'. Canonical GuestHub values (name/currency/timezone) are
// NEVER touched. The audit records only the changed FIELD NAMES, never values.
export async function saveChannexPropertyProfileAction(
  input: ChannexProfileOverrides,
): Promise<Result> {
  try {
    const actor = await requireChannelAdmin();

    // Clean + validate. Absent/blank → the key is omitted (not fabricated).
    const patch: Record<string, unknown> = {};
    const s = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 500) : undefined);
    const put = (k: string, v: unknown) => {
      if (v !== undefined) patch[k] = v;
    };
    put("title", s(input.title));
    const country = s(input.country);
    if (country !== undefined) {
      if (!/^[A-Za-z]{2}$/.test(country)) return { success: false, error: "קוד מדינה חייב להיות שתי אותיות (ISO-2)" };
      patch.country = country.toUpperCase();
    }
    put("city", s(input.city));
    put("address", s(input.address));
    put("zipCode", s(input.zipCode));
    const email = s(input.email);
    if (email !== undefined) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { success: false, error: "כתובת אימייל אינה תקינה" };
      patch.email = email;
    }
    put("phone", s(input.phone));
    put("website", s(input.website));
    put("propertyType", s(input.propertyType));
    if (input.latitude !== null && input.latitude !== undefined) {
      const lat = Number(input.latitude);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { success: false, error: "קו רוחב חייב להיות בין -90 ל-90" };
      patch.latitude = lat;
    }
    if (input.longitude !== null && input.longitude !== undefined) {
      const lng = Number(input.longitude);
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) return { success: false, error: "קו אורך חייב להיות בין -180 ל-180" };
      patch.longitude = lng;
    }

    await sql`
      UPDATE guesthub.tenants
      SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{channex_profile}', ${sql.json(patch as never)}, true)
      WHERE id = ${actor.tenantId}`;

    const ctx = await auditRequestContext();
    await writeAudit(actor, {
      entityType: "tenant",
      entityId: actor.tenantId,
      action: "channex_property_profile_updated",
      after: { environment: CHANNEX_ENV, fields: Object.keys(patch) }, // NAMES only
      ip: ctx.ip,
      session: ctx.session,
    });
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}

// 3) List the Channex properties accessible to the stored key — for explicit
// adoption. Operator-triggered (never on page load). Returns id/title/currency
// only. No property is created.
export async function listChannexPropertiesAction(): Promise<
  Result<{ properties: ChannexPropertySummary[] }>
> {
  try {
    const actor = await requireChannelAdmin();
    if (!channelSecretsConfigured())
      return { success: false, error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת" };
    const key = await withChannexKey(actor.tenantId);
    if (!key.ok) return { success: false, error: key.error };

    const res = await listChannexProperties({ apiKey: key.apiKey, baseUrl: CHANNEX_BASE_URLS.staging });
    if (!res.ok) return apiFail(res);

    if (res.properties.length > 0 && !(await loadPropertyMappingRow(actor.tenantId))?.channex_property_id) {
      const ctx = await auditRequestContext();
      await writeAudit(actor, {
        entityType: "channel_connection",
        entityId: null,
        action: "channex_external_properties_detected",
        after: { environment: CHANNEX_ENV, count: res.properties.length },
        ip: ctx.ip,
        session: ctx.session,
      });
    }
    return { success: true, data: { properties: res.properties } };
  } catch (e) {
    return failFrom(e);
  }
}

// 4) Create ONE Channex Staging property representing the existing tenant.
// Guarded by a per-tenant+env advisory lock re-checking the mapping inside the
// lock, so a double-click / concurrent request can never create two external
// properties. On an ambiguous network failure NO local mapping is written and
// the write is never blindly retried — any property Channex did create surfaces
// in the adoption list for explicit reconciliation.
export async function createChannexPropertyAction(): Promise<Result<{ propertyId: string; title: string | null }>> {
  try {
    const actor = await requireChannelAdmin();
    if (!channelSecretsConfigured())
      return { success: false, error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת" };

    const tctx = await loadTenantContext(actor.tenantId);
    if (!tctx) return { success: false, error: "לא נמצא ארגון (tenant) פעיל" };
    if ((await loadPropertyMappingRow(actor.tenantId))?.channex_property_id)
      return { success: false, error: "כבר קיים מיפוי נכס Channex לעסק זה" };

    const profile = resolveChannexProfile(tctx.identity, tctx.overrides);
    if (!computeReadiness(profile).canCreate)
      return { success: false, error: "חסרים שדות חובה ליצירת נכס (שם ומטבע)" };

    const key = await withChannexKey(actor.tenantId);
    if (!key.ok) return { success: false, error: key.error };
    const payload = buildCreatePropertyPayload(profile);
    const auditCtx = await auditRequestContext();

    // ponytail: per-tenant+env advisory xact lock held across ONE create call —
    // a rare operator action, not a hot path; prevents duplicate provisioning.
    const outcome = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`channex:property:${actor.tenantId}:${CHANNEX_ENV}`}))`;
      const [locked] = await tx<{ channex_property_id: string | null }[]>`
        SELECT channex_property_id FROM guesthub.channel_connections
        WHERE tenant_id = ${actor.tenantId} AND provider = 'channex' AND environment = ${CHANNEX_ENV}
        FOR UPDATE`;
      if (locked?.channex_property_id) return { kind: "dup" as const };

      const created = await apiCreateChannexProperty({
        apiKey: key.apiKey,
        baseUrl: CHANNEX_BASE_URLS.staging,
        payload,
      });
      if (!created.ok) return { kind: "fail" as const, fail: created };

      await tx`
        UPDATE guesthub.channel_connections
        SET channex_property_id = ${created.property.id},
            channex_property_title = ${created.property.title},
            channex_property_method = 'created',
            channex_property_snapshot = ${sql.json(toPropertySnapshot(created.property) as never)},
            channex_property_verified_at = now(),
            channex_reconcile_state = 'ok',
            updated_by = ${actor.userId}, updated_at = now()
        WHERE tenant_id = ${actor.tenantId} AND provider = 'channex' AND environment = ${CHANNEX_ENV}`;
      return { kind: "ok" as const, property: created.property };
    });

    if (outcome.kind === "dup") return { success: false, error: "כבר קיים מיפוי נכס Channex לעסק זה" };
    if (outcome.kind === "fail") {
      await writeAudit(actor, {
        entityType: "channel_connection",
        entityId: null,
        action: "channex_property_create_failed",
        after: { environment: CHANNEX_ENV, category: outcome.fail.category },
        ip: auditCtx.ip,
        session: auditCtx.session,
      });
      return apiFail(outcome.fail);
    }
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: null,
      action: "channex_property_created",
      after: { environment: CHANNEX_ENV, propertyId: outcome.property.id, title: outcome.property.title },
      ip: auditCtx.ip,
      session: auditCtx.session,
    });
    return { success: true, data: { propertyId: outcome.property.id, title: outcome.property.title } };
  } catch (e) {
    return failFrom(e);
  }
}

// 5) Adopt an EXISTING accessible Channex property (explicit operator choice —
// never automatic / title-based). Verifies GET /properties/:id first, then
// stores the mapping under the same lock as create.
export async function adoptChannexPropertyAction(input: {
  propertyId: string;
}): Promise<Result<{ propertyId: string; title: string | null }>> {
  try {
    const actor = await requireChannelAdmin();
    if (!channelSecretsConfigured())
      return { success: false, error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת" };
    const propertyId = (input.propertyId ?? "").trim();
    if (!propertyId) return { success: false, error: "יש לבחור נכס לאימוץ" };
    if ((await loadPropertyMappingRow(actor.tenantId))?.channex_property_id)
      return { success: false, error: "כבר קיים מיפוי נכס Channex לעסק זה" };

    const key = await withChannexKey(actor.tenantId);
    if (!key.ok) return { success: false, error: key.error };

    // Verify accessibility BEFORE adopting.
    const got = await getChannexProperty({ apiKey: key.apiKey, baseUrl: CHANNEX_BASE_URLS.staging, id: propertyId });
    if (!got.ok) return apiFail(got);
    const auditCtx = await auditRequestContext();

    const outcome = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`channex:property:${actor.tenantId}:${CHANNEX_ENV}`}))`;
      const [locked] = await tx<{ channex_property_id: string | null }[]>`
        SELECT channex_property_id FROM guesthub.channel_connections
        WHERE tenant_id = ${actor.tenantId} AND provider = 'channex' AND environment = ${CHANNEX_ENV}
        FOR UPDATE`;
      if (locked?.channex_property_id) return { kind: "dup" as const };
      await tx`
        UPDATE guesthub.channel_connections
        SET channex_property_id = ${got.property.id},
            channex_property_title = ${got.property.title},
            channex_property_method = 'adopted',
            channex_property_snapshot = ${sql.json(toPropertySnapshot(got.property) as never)},
            channex_property_verified_at = now(),
            channex_reconcile_state = 'ok',
            updated_by = ${actor.userId}, updated_at = now()
        WHERE tenant_id = ${actor.tenantId} AND provider = 'channex' AND environment = ${CHANNEX_ENV}`;
      return { kind: "ok" as const };
    });
    if (outcome.kind === "dup") return { success: false, error: "כבר קיים מיפוי נכס Channex לעסק זה" };

    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: null,
      action: "channex_property_adopted",
      after: { environment: CHANNEX_ENV, propertyId: got.property.id, title: got.property.title },
      ip: auditCtx.ip,
      session: auditCtx.session,
    });
    return { success: true, data: { propertyId: got.property.id, title: got.property.title } };
  } catch (e) {
    return failFrom(e);
  }
}

// 6) Refresh the mapped property: GET /properties/:id, update the safe snapshot
// and verified-at. If the property is no longer accessible, flag reconciliation
// ('inaccessible') but NEVER delete the mapping automatically.
export async function refreshChannexPropertyAction(): Promise<
  Result<{ verified: boolean; reconcileState: "ok" | "inaccessible" | null }>
> {
  try {
    const actor = await requireChannelAdmin();
    if (!channelSecretsConfigured())
      return { success: false, error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת" };
    const mapping = await loadPropertyMappingRow(actor.tenantId);
    if (!mapping?.channex_property_id) return { success: false, error: "אין מיפוי נכס לרענון" };

    const key = await withChannexKey(actor.tenantId);
    if (!key.ok) return { success: false, error: key.error };

    const got = await getChannexProperty({
      apiKey: key.apiKey,
      baseUrl: CHANNEX_BASE_URLS.staging,
      id: mapping.channex_property_id,
    });
    const auditCtx = await auditRequestContext();

    if (got.ok) {
      await sql`
        UPDATE guesthub.channel_connections
        SET channex_property_title = ${got.property.title},
            channex_property_snapshot = ${sql.json(toPropertySnapshot(got.property) as never)},
            channex_property_verified_at = now(),
            channex_reconcile_state = 'ok', updated_at = now()
        WHERE tenant_id = ${actor.tenantId} AND provider = 'channex' AND environment = ${CHANNEX_ENV}`;
      await writeAudit(actor, {
        entityType: "channel_connection",
        entityId: null,
        action: "channex_property_verification_succeeded",
        after: { environment: CHANNEX_ENV, propertyId: got.property.id },
        ip: auditCtx.ip,
        session: auditCtx.session,
      });
      return { success: true, data: { verified: true, reconcileState: "ok" } };
    }

    // Only a definitive "gone / not yours" flips reconciliation to inaccessible;
    // transient failures (timeout/network/server/rate) leave the state untouched.
    const inaccessible =
      got.category === "not_found" || got.category === "forbidden" || got.category === "unauthorized";
    if (inaccessible) {
      await sql`
        UPDATE guesthub.channel_connections
        SET channex_reconcile_state = 'inaccessible', updated_at = now()
        WHERE tenant_id = ${actor.tenantId} AND provider = 'channex' AND environment = ${CHANNEX_ENV}`;
    }
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: null,
      action: "channex_property_verification_failed",
      after: { environment: CHANNEX_ENV, category: got.category, reconcile: inaccessible ? "inaccessible" : null },
      ip: auditCtx.ip,
      session: auditCtx.session,
    });
    if (inaccessible) return { success: true, data: { verified: false, reconcileState: "inaccessible" } };
    return apiFail(got);
  } catch (e) {
    return failFrom(e);
  }
}

// ============================================================
// Channex property CORRECTION via PUT (D61) — updates the EXISTING mapped
// property from the canonical Business Profile. Never POST /properties, never
// creates a second property, never changes rooms/rates/inventory. The external
// Staging title is "<property_name> (Staging)"; the canonical property name is
// unchanged. super_admin ONLY.
// ============================================================

export type ChannexUpdatePreview = {
  propertyId: string;
  environment: string;
  canUpdate: boolean;
  reason: string | null; // why update is blocked (e.g. no property name), else null
  currentTitle: string | null;
  proposedTitle: string | null;
  currentCountry: string | null;
  proposedCountry: string | null;
  currentCity: string | null;
  proposedCity: string | null;
  currentAddress: string | null;
  proposedAddress: string | null;
  // postal code comes ONLY from the canonical Business Profile (there is no
  // Channex-only postal field) — shown explicitly so the operator sees it change.
  currentZipCode: string | null;
  proposedZipCode: string | null;
  changes: ChannexFieldChange[];
};

// Fresh current-state (GET) + proposed payload derived from the Business Profile,
// for the confirmation modal. No mutation. Reads coordinates/address ONLY from
// the canonical Business Profile — never a Channex-only source.
export async function previewChannexUpdateAction(): Promise<Result<ChannexUpdatePreview>> {
  try {
    const actor = await requireChannelAdmin();
    if (!channelSecretsConfigured())
      return { success: false, error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת" };
    const mapping = await loadPropertyMappingRow(actor.tenantId);
    if (!mapping?.channex_property_id) return { success: false, error: "אין נכס Channex ממופה לעדכון" };

    const profile = await getBusinessProfile(actor.tenantId);
    const built = profile ? buildChannexUpdatePayload(profile) : null;

    const key = await withChannexKey(actor.tenantId);
    if (!key.ok) return { success: false, error: key.error };
    const got = await getChannexProperty({
      apiKey: key.apiKey,
      baseUrl: CHANNEX_BASE_URLS.staging,
      id: mapping.channex_property_id,
    });
    if (!got.ok) return apiFail(got);

    const current = toPropertySnapshot(got.property);
    const attrs = built?.property ?? {};
    const str = (v: unknown) => (typeof v === "string" ? v : v == null ? null : String(v));
    return {
      success: true,
      data: {
        propertyId: mapping.channex_property_id,
        environment: CHANNEX_ENV,
        canUpdate: !!built,
        reason: built ? null : "יש להזין שם נכס בפרופיל העסק לפני עדכון Channex",
        currentTitle: str(current.title),
        proposedTitle: str(attrs.title),
        currentCountry: str(current.country),
        proposedCountry: str(attrs.country),
        currentCity: str(current.city),
        proposedCity: str(attrs.city),
        currentAddress: str(current.address),
        proposedAddress: str(attrs.address),
        currentZipCode: str(current.zip_code),
        proposedZipCode: str(attrs.zip_code),
        changes: diffChannexUpdate(current, attrs),
      },
    };
  } catch (e) {
    return failFrom(e);
  }
}

// Apply the correction: PUT the SAME property id with the Business-Profile-derived
// payload. Preserves id, mapping method, environment, api-key, and all room/rate/
// inventory state. On failure the mapping is untouched.
export async function updateChannexPropertyFromBusinessProfileAction(): Promise<
  Result<{ propertyId: string; title: string | null }>
> {
  try {
    const actor = await requireChannelAdmin();
    if (!channelSecretsConfigured())
      return { success: false, error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת" };
    const mapping = await loadPropertyMappingRow(actor.tenantId);
    if (!mapping?.channex_property_id) return { success: false, error: "אין נכס Channex ממופה לעדכון" };

    const profile = await getBusinessProfile(actor.tenantId);
    const built = profile ? buildChannexUpdatePayload(profile) : null;
    if (!built) return { success: false, error: "יש להזין שם נכס בפרופיל העסק לפני עדכון Channex" };

    const key = await withChannexKey(actor.tenantId);
    if (!key.ok) return { success: false, error: key.error };
    const auditCtx = await auditRequestContext();
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: null,
      action: "channex_property_update_requested",
      after: { environment: CHANNEX_ENV, propertyId: mapping.channex_property_id, fields: Object.keys(built.property) },
      ip: auditCtx.ip,
      session: auditCtx.session,
    });

    const updated = await apiUpdateChannexProperty({
      apiKey: key.apiKey,
      baseUrl: CHANNEX_BASE_URLS.staging,
      id: mapping.channex_property_id, // SAME id — never a new property
      payload: built,
    });
    if (!updated.ok) {
      await writeAudit(actor, {
        entityType: "channel_connection",
        entityId: null,
        action: "channex_property_update_failed",
        after: { environment: CHANNEX_ENV, propertyId: mapping.channex_property_id, category: updated.category },
        ip: auditCtx.ip,
        session: auditCtx.session,
      });
      return apiFail(updated);
    }

    await sql`
      UPDATE guesthub.channel_connections
      SET channex_property_title = ${updated.property.title},
          channex_property_snapshot = ${sql.json(toPropertySnapshot(updated.property) as never)},
          channex_property_verified_at = now(),
          channex_reconcile_state = 'ok', updated_by = ${actor.userId}, updated_at = now()
      WHERE tenant_id = ${actor.tenantId} AND provider = 'channex' AND environment = ${CHANNEX_ENV}`;
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: null,
      action: "channex_property_updated",
      after: { environment: CHANNEX_ENV, propertyId: updated.property.id, title: updated.property.title },
      ip: auditCtx.ip,
      session: auditCtx.session,
    });
    return { success: true, data: { propertyId: updated.property.id, title: updated.property.title } };
  } catch (e) {
    return failFrom(e);
  }
}
