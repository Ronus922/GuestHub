"use server";

import { sql } from "@/lib/db";
import { getActor, AuthorizationError, type Actor } from "@/lib/auth/actor";
import { canManageChannels } from "@/lib/auth/guards";
import { writeAudit, auditRequestContext } from "@/lib/audit";
import { enqueueChannelJob } from "./queue";
import { CHANNEX_BASE_URLS } from "./config";
import { encryptSecret, decryptSecret, secretHint, channelSecretsConfigured } from "./crypto";
import { runChannexConnectionTest, type ChannexErrorCategory } from "./connection-test";

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
        (SELECT COUNT(*)::int FROM guesthub.room_types
          WHERE tenant_id = ${actor.tenantId} AND is_active) AS room_types,
        (SELECT COUNT(*)::int FROM guesthub.channel_room_type_mappings
          WHERE tenant_id = ${actor.tenantId} AND status = 'mapped' AND is_active) AS mapped_room_types,
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

// Records a full-sync request (§V). While the connection is not active the
// job is stored 'suppressed' — visible, auditable, and never runnable, so no
// dead backlog forms. Actual execution is a future activation deliverable.
export async function requestFullSyncAction(connectionId: string): Promise<Result> {
  try {
    const actor = await requireChannelAdmin();
    const [conn] = await sql<{ id: string; state: string }[]>`
      SELECT id, state FROM guesthub.channel_connections
      WHERE id = ${connectionId} AND tenant_id = ${actor.tenantId}`;
    if (!conn) return { success: false, error: "חיבור לא נמצא" };
    await enqueueChannelJob(sql, {
      tenantId: actor.tenantId,
      connectionId: conn.id,
      jobType: "full_sync",
      priority: 10,
      idempotencyKey: `full_sync:${conn.id}`,
      suppressed: conn.state !== "active",
    });
    await sql`
      UPDATE guesthub.channel_connections SET full_sync_required = true
      WHERE id = ${conn.id}`;
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: conn.id,
      action: "request_full_sync",
      after: { state: conn.state },
    });
    return { success: true };
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
    SELECT state, api_key_ciphertext, api_key_hint, last_test_ok_at,
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
export async function saveChannexApiKeyAction(input: { apiKey: string }): Promise<Result> {
  try {
    const actor = await requireChannelAdmin();
    if (!channelSecretsConfigured())
      return { success: false, error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת" };
    const apiKey = input.apiKey.trim();
    if (!apiKey) return { success: false, error: "יש להזין מפתח API" };

    const existing = await loadChannexRow(actor.tenantId);
    const replacing = !!existing?.api_key_ciphertext;

    const [row] = await sql<{ id: string }[]>`
      INSERT INTO guesthub.channel_connections
        (tenant_id, provider, environment, state, api_key_ciphertext, api_key_hint,
         created_by, updated_by)
      VALUES (${actor.tenantId}, 'channex', ${CHANNEX_ENV}, 'configured',
              ${encryptSecret(apiKey)}, ${secretHint(apiKey)}, ${actor.userId}, ${actor.userId})
      ON CONFLICT (tenant_id, provider, environment) DO UPDATE SET
        api_key_ciphertext = EXCLUDED.api_key_ciphertext,
        api_key_hint = EXCLUDED.api_key_hint,
        -- a new credential invalidates any prior test verdict
        state = CASE WHEN guesthub.channel_connections.state = 'active'
                     THEN 'active' ELSE 'configured' END,
        last_test_ok_at = NULL, last_test_failed_at = NULL,
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

// 3) Real, server-side connection test against Channex Staging. Decrypts the
// stored key, performs ONE GET /properties/options, records only sanitized
// metadata, and returns a safe result. The credential is preserved on failure.
export async function testChannexConnectionAction(): Promise<
  Result<{ ok: boolean; propertyCount?: number; category?: ChannexErrorCategory; message?: string }>
> {
  try {
    const actor = await requireChannelAdmin();
    if (!channelSecretsConfigured())
      return { success: false, error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת" };

    const row = await loadChannexRow(actor.tenantId);
    if (!row?.api_key_ciphertext) return { success: false, error: "מפתח API לא הוגדר" };

    let apiKey: string;
    try {
      apiKey = decryptSecret(row.api_key_ciphertext);
    } catch {
      // Wrong/rotated CHANNEL_SECRETS_KEY — never leak the ciphertext or error.
      return { success: false, error: "פענוח המפתח נכשל — ייתכן שמפתח ההצפנה בשרת השתנה" };
    }

    const result = await runChannexConnectionTest({
      apiKey,
      baseUrl: CHANNEX_BASE_URLS.staging,
    });

    const ctx = await auditRequestContext();
    if (result.ok) {
      await sql`
        UPDATE guesthub.channel_connections
        SET state = 'ready', last_test_ok_at = now(),
            last_test_error_code = NULL, last_error = NULL, updated_at = now()
        WHERE tenant_id = ${actor.tenantId} AND provider = 'channex' AND environment = ${CHANNEX_ENV}`;
      await writeAudit(actor, {
        entityType: "channel_connection",
        entityId: null,
        action: "channex_connection_test_succeeded",
        after: { environment: CHANNEX_ENV, propertyCount: result.propertyCount },
        ip: ctx.ip,
        session: ctx.session,
      });
      return { success: true, data: { ok: true, propertyCount: result.propertyCount } };
    }

    await sql`
      UPDATE guesthub.channel_connections
      SET state = 'error', last_test_failed_at = now(),
          last_test_error_code = ${result.category}, last_error = ${result.message}, updated_at = now()
      WHERE tenant_id = ${actor.tenantId} AND provider = 'channex' AND environment = ${CHANNEX_ENV}`;
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: null,
      action: "channex_connection_test_failed",
      after: { environment: CHANNEX_ENV, category: result.category },
      ip: ctx.ip,
      session: ctx.session,
    });
    return { success: true, data: { ok: false, category: result.category, message: result.message } };
  } catch (e) {
    return failFrom(e);
  }
}
