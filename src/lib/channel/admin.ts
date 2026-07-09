"use server";

import { sql } from "@/lib/db";
import { getActor, AuthorizationError, type Actor } from "@/lib/auth/actor";
import { canManageChannels } from "@/lib/auth/guards";
import { writeAudit, auditRequestContext } from "@/lib/audit";
import { enqueueChannelJob } from "./queue";
import { CHANNEX_BASE_URLS } from "./config";
import { encryptSecret, decryptSecret, secretHint, channelSecretsConfigured } from "./crypto";
import { runChannexConnectionTest, type ChannexErrorCategory } from "./connection-test";
import {
  listChannexProperties,
  getChannexProperty,
  createChannexProperty as apiCreateChannexProperty,
  type ChannexApiFailure,
  type ChannexPropertyDetail,
  type ChannexPropertySummary,
} from "./channex-properties";
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
    timezone: p.timezone,
    property_type: p.propertyType,
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
    return {
      success: true,
      data: {
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
