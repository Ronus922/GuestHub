"use server";

import { sql } from "@/lib/db";
import { getActor, AuthorizationError, type Actor } from "@/lib/auth/actor";
import { canManageChannels } from "@/lib/auth/guards";
import { writeAudit, auditRequestContext } from "@/lib/audit";
import { hospitableBaseUrl } from "./config";
import { enqueueChannelJob } from "./queue";
import {
  encryptSecret,
  decryptSecret,
  secretHint,
  channelSecretsConfigured,
  generateWebhookToken,
  sha256Hex,
} from "./crypto";
import { hospitableRequest, hospitableFail, mapErrorStatus } from "./hospitable-http";
import type { HospitableApiErrorCategory, HospitableApiFailure } from "./hospitable-http";
import {
  listHospitableProperties,
  getHospitableProperty,
  extractHospitablePropertyList,
  type HospitablePropertySummary,
} from "./hospitable-properties";

// ============================================================
// Hospitable server actions (D77) — super_admin ONLY, enforced server-side on
// every action (UI hiding is not security). Mirror of the Channex flows in
// admin.ts, with the Hospitable specifics:
//  • Hospitable exposes ONE production API — every row here is
//    provider='hospitable', environment='production'. No staging exists.
//  • The credential is a PAT (a JWT). Its `exp` claim is decoded AT SAVE TIME
//    (base64url payload only — no signature verification, exp extraction only)
//    into api_key_expires_at so the UI can warn ≥30 days before expiry.
//  • The mapping unit is the PHYSICAL ROOM: one room ↔ one Hospitable property
//    UUID + ONE designated local pricing plan (channel_hospitable_property_mappings).
//  • Probes are read-only GETs (/user, /properties). A write is NEVER issued.
// The PAT is stored AES-256-GCM encrypted (crypto.ts), never returned to the
// browser, never placed in an audit payload, a log or an error.
// ============================================================

type Result<T = undefined> = { success: true; data?: T } | { success: false; error: string };

const HOSPITABLE_ENV = "production";

async function requireChannelAdmin(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new AuthorizationError("לא מחובר למערכת");
  const guard = canManageChannels({ userId: actor.userId, roleKey: actor.roleKey });
  if (!guard.ok) throw new AuthorizationError(guard.error);
  return actor;
}

function failFrom(e: unknown): { success: false; error: string } {
  if (e instanceof AuthorizationError) return { success: false, error: e.message };
  console.error("[hospitable-admin]", e);
  return { success: false, error: "אירעה שגיאה בלתי צפויה" };
}

const apiFail = (f: HospitableApiFailure): { success: false; error: string } => ({
  success: false,
  error: f.message,
});

const iso = (v: Date | null): string | null => (v ? v.toISOString() : null);

// ---- PAT expiry (JWT `exp` claim) ----
// Decode ONLY the middle (payload) segment as base64url JSON and read `exp`.
// Deliberately no signature verification — this is a display/warning aid, not
// authentication; the API itself is the authenticator. Anything undecodable
// (not a JWT, malformed payload, non-numeric exp) → null, and the column
// stays NULL rather than guessing.
function decodeHospitablePatExpiry(token: string): Date | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const exp = (payload as { exp?: unknown } | null)?.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return null;
    const d = new Date(exp * 1000);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

// ---- connection row ----

type HospitableRow = {
  id: string;
  state: string;
  is_active_provider: boolean;
  api_key_ciphertext: string | null;
  api_key_hint: string | null;
  api_key_expires_at: Date | null;
  inbound_sync_enabled: boolean;
  outbound_sync_enabled: boolean;
  full_sync_required: boolean;
  webhook_token_hash: string | null;
  last_outbound_sync_at: Date | null;
  last_test_ok_at: Date | null;
  last_test_failed_at: Date | null;
  last_test_error_code: string | null;
  last_error: string | null;
};

async function loadHospitableRow(tenantId: string): Promise<HospitableRow | null> {
  const [row] = await sql<HospitableRow[]>`
    SELECT id, state, is_active_provider, api_key_ciphertext, api_key_hint, api_key_expires_at,
           inbound_sync_enabled, outbound_sync_enabled, full_sync_required,
           webhook_token_hash, last_outbound_sync_at,
           last_test_ok_at, last_test_failed_at, last_test_error_code, last_error
    FROM guesthub.channel_connections
    WHERE tenant_id = ${tenantId} AND provider = 'hospitable' AND environment = ${HOSPITABLE_ENV}`;
  return row ?? null;
}

// Decrypt the stored PAT for a server-side Hospitable call. Never returned to
// the browser, never logged. Missing/undecryptable → safe error, credential kept.
async function withHospitableToken(
  tenantId: string,
): Promise<{ ok: true; token: string; connectionId: string } | { ok: false; error: string }> {
  const row = await loadHospitableRow(tenantId);
  if (!row?.api_key_ciphertext)
    return { ok: false, error: "טוקן PAT לא הוגדר — שמור טוקן Hospitable תחילה" };
  try {
    return { ok: true, token: decryptSecret(row.api_key_ciphertext), connectionId: row.id };
  } catch {
    return { ok: false, error: "פענוח הטוקן נכשל — ייתכן שמפתח ההצפנה בשרת השתנה" };
  }
}

// ---- 1) masked connection view (pure DB read — NO Hospitable network call) ----

export type HospitableMappingRow = {
  roomId: string;
  hospitablePropertyId: string;
  /** display-only snapshot from map time — refreshed on every re-map */
  hospitablePropertyName: string | null;
  localRatePlanId: string | null;
  currency: string | null;
  calendarRestricted: boolean;
  status: "mapped" | "unmapped" | "quarantined";
  updatedAt: string | null;
};

export type HospitableRoomOption = {
  roomId: string;
  roomNumber: string;
  categoryName: string | null;
  floor: number | null;
  isActive: boolean;
};

export type HospitableRatePlanOption = {
  id: string;
  name: string;
};

export type HospitableConnectionView = {
  environment: typeof HOSPITABLE_ENV;
  baseUrl: string;
  secretsKeyConfigured: boolean;
  configured: boolean; // a PAT is stored
  apiKeyHint: string | null; // "••••1a2b" — never the token
  apiKeyExpiresAt: string | null; // ISO, from the decoded JWT exp; null = unknown
  /** whole days until expiry, SERVER-computed (the browser never reads a clock
   *  for this — hydration contract, D71). Negative = already expired. */
  apiKeyExpiresInDays: number | null;
  state: string;
  lastTestOkAt: string | null;
  lastTestFailedAt: string | null;
  lastTestErrorCode: string | null;
  lastError: string | null;
  mappedCount: number;
  // ---- activation surface (F4) ----
  inboundEnabled: boolean;
  /** a webhook token hash is stored — the callback URL exists (shown masked) */
  webhookRegistered: boolean;
  /** masked callback shape — the token itself is stored hashed, never shown */
  callbackDisplay: string | null;
  outboundEnabled: boolean;
  fullSyncRequired: boolean;
  /** a full_sync job is live — the button stays disabled */
  fullSyncRunning: boolean;
  lastOutboundSyncAt: string | null;
  /** the tenant currency — pricing plans have no own currency column; the
   *  tenant currency IS the plan currency (see rate-plan-admin loadCurrency) */
  tenantCurrency: string;
  rooms: HospitableRoomOption[];
  ratePlans: HospitableRatePlanOption[];
  mappings: HospitableMappingRow[];
};

const DAY_MS = 86_400_000;

export async function getHospitableConnectionAction(): Promise<Result<HospitableConnectionView>> {
  try {
    const actor = await requireChannelAdmin();
    const row = await loadHospitableRow(actor.tenantId);

    const [mappings, rooms, plans, [tenant], [liveFullSync]] = await Promise.all([
      row
        ? sql<HospitableMappingRow[]>`
            SELECT room_id AS "roomId", hospitable_property_id AS "hospitablePropertyId",
                   hospitable_property_name AS "hospitablePropertyName",
                   local_rate_plan_id AS "localRatePlanId", currency,
                   calendar_restricted AS "calendarRestricted", status,
                   updated_at::text AS "updatedAt"
            FROM guesthub.channel_hospitable_property_mappings
            WHERE tenant_id = ${actor.tenantId} AND connection_id = ${row.id}`
        : Promise.resolve([] as HospitableMappingRow[]),
      sql<HospitableRoomOption[]>`
        SELECT r.id AS "roomId", r.room_number AS "roomNumber",
               rt.name AS "categoryName", r.floor, r.is_active AS "isActive"
        FROM guesthub.rooms r
        LEFT JOIN guesthub.room_types rt ON rt.id = r.room_type_id
        WHERE r.tenant_id = ${actor.tenantId}
        ORDER BY r.room_number`,
      // Same eligibility as the Channex rate-plan flow: TENANT-scoped plans
      // (sellable_unit_id IS NULL), active, not archived, channel-visible.
      sql<HospitableRatePlanOption[]>`
        SELECT id, name FROM guesthub.pricing_plans
        WHERE tenant_id = ${actor.tenantId} AND sellable_unit_id IS NULL
          AND is_active AND NOT is_archived AND is_visible_channels
        ORDER BY name`,
      sql<{ currency: string | null }[]>`
        SELECT currency FROM guesthub.tenants WHERE id = ${actor.tenantId}`,
      row
        ? sql<{ id: string }[]>`
            SELECT id FROM guesthub.channel_sync_jobs
            WHERE connection_id = ${row.id} AND job_type = 'full_sync'
              AND status IN ('queued','processing','retry_wait')
            LIMIT 1`
        : Promise.resolve([] as { id: string }[]),
    ]);

    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
    const expiresAt = row?.api_key_expires_at ?? null;
    return {
      success: true,
      data: {
        environment: HOSPITABLE_ENV,
        baseUrl: hospitableBaseUrl(),
        secretsKeyConfigured: channelSecretsConfigured(),
        configured: !!row?.api_key_hint,
        apiKeyHint: row?.api_key_hint ?? null,
        apiKeyExpiresAt: iso(expiresAt),
        apiKeyExpiresInDays: expiresAt
          ? Math.floor((expiresAt.getTime() - Date.now()) / DAY_MS)
          : null,
        state: row?.state ?? "disconnected",
        lastTestOkAt: iso(row?.last_test_ok_at ?? null),
        lastTestFailedAt: iso(row?.last_test_failed_at ?? null),
        lastTestErrorCode: row?.last_test_error_code ?? null,
        lastError: row?.last_error ?? null,
        mappedCount: mappings.filter((m) => m.status === "mapped").length,
        inboundEnabled: row?.inbound_sync_enabled ?? false,
        webhookRegistered: !!row?.webhook_token_hash,
        callbackDisplay:
          row?.webhook_token_hash && appUrl ? `${appUrl}/api/channel/webhook/••••` : null,
        outboundEnabled: row?.outbound_sync_enabled ?? false,
        fullSyncRequired: row?.full_sync_required ?? false,
        fullSyncRunning: !!liveFullSync,
        lastOutboundSyncAt: iso(row?.last_outbound_sync_at ?? null),
        tenantCurrency: tenant?.currency || "ILS",
        rooms,
        ratePlans: plans,
        mappings,
      },
    };
  } catch (e) {
    return failFrom(e);
  }
}

// ---- 2) save/replace the PAT (encrypted at rest) ----
// Mirrors saveChannexApiKeyAction's shape with the D77 differences: the
// connection is ALWAYS environment='production' (Hospitable has no staging),
// and the JWT exp claim is decoded into api_key_expires_at at save time. The
// state machine step is disconnected → 'configured' (an already-active link
// stays active); "בדיקת חיבור" advances it to 'ready'.
export async function saveHospitableApiKeyAction(input: { apiKey: string }): Promise<Result> {
  try {
    const actor = await requireChannelAdmin();
    if (!channelSecretsConfigured())
      return { success: false, error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת" };
    const apiKey = input.apiKey.trim();
    if (!apiKey) return { success: false, error: "יש להזין טוקן PAT" };

    const existing = await loadHospitableRow(actor.tenantId);
    const replacing = !!existing?.api_key_ciphertext;
    const expiresAt = decodeHospitablePatExpiry(apiKey);

    const [row] = await sql<{ id: string }[]>`
      INSERT INTO guesthub.channel_connections
        (tenant_id, provider, environment, state, api_key_ciphertext, api_key_hint,
         api_key_expires_at, created_by, updated_by)
      VALUES (${actor.tenantId}, 'hospitable', ${HOSPITABLE_ENV}, 'configured',
              ${encryptSecret(apiKey)}, ${secretHint(apiKey)}, ${expiresAt},
              ${actor.userId}, ${actor.userId})
      ON CONFLICT (tenant_id, provider, environment) DO UPDATE SET
        api_key_ciphertext = EXCLUDED.api_key_ciphertext,
        api_key_hint = EXCLUDED.api_key_hint,
        api_key_expires_at = EXCLUDED.api_key_expires_at,
        -- a fresh, untested credential resets the verdict; an active link stays active
        state = CASE WHEN guesthub.channel_connections.state = 'active'
                     THEN 'active' ELSE 'configured' END,
        last_test_ok_at = NULL, last_test_failed_at = NULL,
        last_test_error_code = NULL, last_error = NULL,
        updated_by = ${actor.userId}, updated_at = now()
      RETURNING id`;

    // Audit carries ONLY environment + expiry metadata — never the token or hint.
    const ctx = await auditRequestContext();
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: row.id,
      action: replacing ? "hospitable_credential_replaced" : "hospitable_credential_configured",
      after: { environment: HOSPITABLE_ENV, expiresAt: expiresAt?.toISOString() ?? null },
      ip: ctx.ip,
      session: ctx.session,
    });
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}

// ---- 3) THE stored-PAT probe + test action ----
// One GET /user (identity) then one GET /properties?per_page=1 (scope) with the
// credential ALREADY in the database — decrypted server-side, never taken from
// the browser. Read-only by construction: a write is NEVER probed. Records the
// verdict on the connection row per the existing state machine (→ ready on
// success, → error on failure; 'active' is never demoted by a probe).

type ProbeResult =
  | { ok: true; propertyCount: number }
  | { ok: false; error: string; category: HospitableApiErrorCategory | "not_configured" | "undecryptable" };

async function recordProbeVerdict(tenantId: string, r: ProbeResult): Promise<void> {
  if (r.ok) {
    await sql`
      UPDATE guesthub.channel_connections
      SET state = CASE WHEN state = 'active' THEN 'active' ELSE 'ready' END,
          last_test_ok_at = now(), last_test_failed_at = NULL,
          last_test_error_code = NULL, last_error = NULL, updated_at = now()
      WHERE tenant_id = ${tenantId} AND provider = 'hospitable' AND environment = ${HOSPITABLE_ENV}`;
    return;
  }
  if (r.category === "not_configured" || r.category === "undecryptable") return;
  await sql`
    UPDATE guesthub.channel_connections
    SET state = CASE WHEN state = 'active' THEN 'active' ELSE 'error' END,
        last_test_failed_at = now(), last_test_error_code = ${r.category},
        last_error = ${r.error}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND provider = 'hospitable' AND environment = ${HOSPITABLE_ENV}`;
}

async function probeStoredHospitablePat(tenantId: string): Promise<ProbeResult> {
  if (!channelSecretsConfigured())
    return { ok: false, error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת", category: "not_configured" };
  const row = await loadHospitableRow(tenantId);
  if (!row?.api_key_ciphertext)
    return { ok: false, error: "טוקן PAT לא הוגדר", category: "not_configured" };

  let token: string;
  try {
    token = decryptSecret(row.api_key_ciphertext);
  } catch {
    return { ok: false, error: "פענוח הטוקן נכשל — ייתכן שמפתח ההצפנה בשרת השתנה", category: "undecryptable" };
  }

  const baseUrl = hospitableBaseUrl();
  const fromFailure = (f: HospitableApiFailure): ProbeResult => ({
    ok: false,
    error: f.message,
    category: f.category,
  });

  // 1) identity — proves the PAT authenticates at all
  const user = await hospitableRequest({ token, baseUrl, method: "GET", path: "/user" });
  if ("ok" in user) {
    const r = fromFailure(user);
    await recordProbeVerdict(tenantId, r);
    return r;
  }
  if (user.status !== 200) {
    const r = fromFailure(hospitableFail(mapErrorStatus(user.status), user.status));
    await recordProbeVerdict(tenantId, r);
    return r;
  }

  // 2) property:read scope — the smallest possible page, still read-only
  const props = await hospitableRequest({
    token,
    baseUrl,
    method: "GET",
    path: "/properties?page=1&per_page=1",
  });
  if ("ok" in props) {
    const r = fromFailure(props);
    await recordProbeVerdict(tenantId, r);
    return r;
  }
  if (props.status !== 200) {
    const r = fromFailure(hospitableFail(mapErrorStatus(props.status), props.status));
    await recordProbeVerdict(tenantId, r);
    return r;
  }

  const { properties, total } = extractHospitablePropertyList(props.body);
  const verdict: ProbeResult = { ok: true, propertyCount: total ?? properties.length };
  await recordProbeVerdict(tenantId, verdict);
  return verdict;
}

export async function testHospitableConnectionAction(): Promise<
  Result<{ ok: boolean; propertyCount?: number; category?: string; message?: string }>
> {
  try {
    const actor = await requireChannelAdmin();
    const probe = await probeStoredHospitablePat(actor.tenantId);
    const ctx = await auditRequestContext();

    if (probe.ok) {
      await writeAudit(actor, {
        entityType: "channel_connection",
        entityId: null,
        action: "hospitable_connection_test_succeeded",
        after: { environment: HOSPITABLE_ENV, propertyCount: probe.propertyCount },
        ip: ctx.ip,
        session: ctx.session,
      });
      return { success: true, data: { ok: true, propertyCount: probe.propertyCount } };
    }

    // A missing/undecryptable token is a configuration problem, not a verdict.
    if (probe.category === "not_configured" || probe.category === "undecryptable")
      return { success: false, error: probe.error };

    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: null,
      action: "hospitable_connection_test_failed",
      after: { environment: HOSPITABLE_ENV, category: probe.category },
      ip: ctx.ip,
      session: ctx.session,
    });
    return { success: true, data: { ok: false, category: probe.category, message: probe.error } };
  } catch (e) {
    return failFrom(e);
  }
}

// ---- 4) list accessible Hospitable properties (operator-triggered) ----
// Never runs on page load. Returns safe, whitelisted fields only.
export async function listHospitablePropertiesAction(): Promise<
  Result<{ properties: HospitablePropertySummary[] }>
> {
  try {
    const actor = await requireChannelAdmin();
    if (!channelSecretsConfigured())
      return { success: false, error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת" };
    const key = await withHospitableToken(actor.tenantId);
    if (!key.ok) return { success: false, error: key.error };

    const res = await listHospitableProperties({ token: key.token, baseUrl: hospitableBaseUrl() });
    if (!res.ok) return apiFail(res);
    return { success: true, data: { properties: res.properties } };
  } catch (e) {
    return failFrom(e);
  }
}

// ---- 5) map a physical room ↔ a Hospitable property ----
// Verifies the property FRESH against Hospitable before writing (accessibility,
// calendar_restricted, currency) — the mapping can never be created from a stale
// browser list. Rejections:
//  • calendar_restricted=true — pushes would be rejected upstream anyway;
//  • currency mismatch vs the designated plan's currency. pricing_plans has no
//    currency column: the TENANT currency is the plan currency (exactly how
//    rate-plan-admin.ts resolves it), so that is what is compared.
export async function mapHospitablePropertyAction(input: {
  roomId: string;
  hospitablePropertyId: string;
  localRatePlanId: string;
}): Promise<Result<{ mappingId: string }>> {
  try {
    const actor = await requireChannelAdmin();
    if (!channelSecretsConfigured())
      return { success: false, error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת" };
    const propertyId = (input.hospitablePropertyId ?? "").trim();
    if (!propertyId) return { success: false, error: "יש לבחור נכס Hospitable" };
    if (!input.localRatePlanId) return { success: false, error: "יש לבחור תוכנית תעריף מקומית" };

    const key = await withHospitableToken(actor.tenantId);
    if (!key.ok) return { success: false, error: key.error };

    // Local prerequisites — tenant-scoped room + eligible tenant-scoped plan.
    const [[room], [plan], [tenant]] = await Promise.all([
      sql<{ id: string; room_number: string }[]>`
        SELECT id, room_number FROM guesthub.rooms
        WHERE id = ${input.roomId} AND tenant_id = ${actor.tenantId}`,
      sql<{ id: string; name: string }[]>`
        SELECT id, name FROM guesthub.pricing_plans
        WHERE id = ${input.localRatePlanId} AND tenant_id = ${actor.tenantId}
          AND sellable_unit_id IS NULL AND is_active AND NOT is_archived`,
      sql<{ currency: string | null }[]>`
        SELECT currency FROM guesthub.tenants WHERE id = ${actor.tenantId}`,
    ]);
    if (!room) return { success: false, error: "חדר לא נמצא" };
    if (!plan) return { success: false, error: "תוכנית תעריף לא נמצאה או אינה זמינה לערוצים" };
    const planCurrency = (tenant?.currency || "ILS").toUpperCase();

    // Verify the property FRESH before writing anything.
    const got = await getHospitableProperty({ token: key.token, baseUrl: hospitableBaseUrl(), id: propertyId });
    if (!got.ok) return apiFail(got);
    if (got.property.calendarRestricted)
      return {
        success: false,
        error: "הנכס מסומן ב-Hospitable כ-calendar_restricted — עדכוני יומן יידחו, לא ניתן למפות אותו",
      };
    const propertyCurrency = got.property.currency?.toUpperCase() ?? null;
    if (!propertyCurrency)
      return { success: false, error: "לא ניתן לאמת את מטבע הנכס ב-Hospitable — המיפוי נחסם" };
    if (propertyCurrency !== planCurrency)
      return {
        success: false,
        error: `מטבע הנכס (${propertyCurrency}) אינו תואם את מטבע תוכנית התעריף (${planCurrency}) — לא ניתן למפות`,
      };

    // UNIQUE (connection_id, hospitable_property_id): one external property maps
    // to ONE room. A conflict on a different room is answered explicitly instead
    // of surfacing a constraint error.
    const [taken] = await sql<{ room_id: string }[]>`
      SELECT room_id FROM guesthub.channel_hospitable_property_mappings
      WHERE connection_id = ${key.connectionId}
        AND hospitable_property_id = ${propertyId} AND room_id <> ${input.roomId}`;
    if (taken) return { success: false, error: "נכס Hospitable זה כבר ממופה לחדר אחר" };

    const [before] = await sql<{ hospitable_property_id: string; local_rate_plan_id: string | null }[]>`
      SELECT hospitable_property_id, local_rate_plan_id
      FROM guesthub.channel_hospitable_property_mappings
      WHERE connection_id = ${key.connectionId} AND room_id = ${input.roomId}`;

    const [row] = await sql<{ id: string }[]>`
      INSERT INTO guesthub.channel_hospitable_property_mappings
        (tenant_id, connection_id, room_id, hospitable_property_id, hospitable_property_name,
         local_rate_plan_id, currency, calendar_restricted, status)
      VALUES (${actor.tenantId}, ${key.connectionId}, ${input.roomId}, ${propertyId},
              ${got.property.name ?? got.property.publicName},
              ${input.localRatePlanId}, ${got.property.currency}, false, 'mapped')
      ON CONFLICT (connection_id, room_id) DO UPDATE SET
        hospitable_property_id = EXCLUDED.hospitable_property_id,
        hospitable_property_name = EXCLUDED.hospitable_property_name,
        local_rate_plan_id = EXCLUDED.local_rate_plan_id,
        currency = EXCLUDED.currency,
        calendar_restricted = EXCLUDED.calendar_restricted,
        status = 'mapped', updated_at = now()
      RETURNING id`;

    const ctx = await auditRequestContext();
    await writeAudit(actor, {
      entityType: "channel_hospitable_property_mapping",
      entityId: row.id,
      action: "upsert",
      before: before ?? undefined,
      after: {
        room_id: input.roomId,
        hospitable_property_id: propertyId,
        local_rate_plan_id: input.localRatePlanId,
        currency: got.property.currency,
      },
      ip: ctx.ip,
      session: ctx.session,
    });
    return { success: true, data: { mappingId: row.id } };
  } catch (e) {
    return failFrom(e);
  }
}

// ---- 6) unmap a room ----
// The row is DELETED, not flipped to status='unmapped': hospitable_property_id
// is NOT NULL + UNIQUE per connection, so a retained "unmapped" row would keep
// blocking that property from being mapped to any other room. "Unmapped" for
// this table means "no row". Nothing external is touched.
export async function unmapHospitablePropertyAction(input: { roomId: string }): Promise<Result> {
  try {
    const actor = await requireChannelAdmin();
    const [removed] = await sql<
      { id: string; hospitable_property_id: string; local_rate_plan_id: string | null }[]
    >`
      DELETE FROM guesthub.channel_hospitable_property_mappings
      WHERE tenant_id = ${actor.tenantId} AND room_id = ${input.roomId}
      RETURNING id, hospitable_property_id, local_rate_plan_id`;
    if (!removed) return { success: false, error: "לא קיים מיפוי Hospitable לחדר זה" };

    const ctx = await auditRequestContext();
    await writeAudit(actor, {
      entityType: "channel_hospitable_property_mapping",
      entityId: removed.id,
      action: "delete",
      before: {
        room_id: input.roomId,
        hospitable_property_id: removed.hospitable_property_id,
        local_rate_plan_id: removed.local_rate_plan_id,
      },
      ip: ctx.ip,
      session: ctx.session,
    });
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}

// ============================================================
// Activation (F4) — inbound enable/disable + THE Full Sync trigger.
// ============================================================

// ---- 7) enable inbound booking import ----
// Mirrors inbound-admin.ts setInboundEnabledAction with the ONE Hospitable
// difference: there is NO webhook auto-registration API in scope — the operator
// registers the callback MANUALLY in the Hospitable UI. The per-connection
// token is therefore generated here, stored HASHED (the existing webhook route
// resolves it by sha256, provider-agnostically), and the full plaintext URL is
// returned ONCE for the operator to paste into Hospitable. It is never
// persisted in plaintext and never displayable again — rotation is
// disable→enable (disable clears the hash precisely so a re-enable can mint a
// fresh, displayable URL; see disableHospitableInboundAction).
export async function enableHospitableInboundAction(): Promise<
  Result<{ webhookUrl: string | null; webhookWarning: string | null }>
> {
  try {
    const actor = await requireChannelAdmin();
    const conn = await loadHospitableRow(actor.tenantId);
    if (!conn) return { success: false, error: "אין חיבור Hospitable מוגדר" };
    // D79 — a dormant backup provider must not be armed by mistake
    if (!conn.is_active_provider)
      return { success: false, error: "Hospitable במצב גיבוי — בחר אותו כספק פעיל בראש המסך תחילה" };
    // D77 read-first rollout: inbound (import-only, no OTA writes) is allowed
    // from state='ready' — a validated connection — NOT only 'active'. 'active'
    // is reached via a successful Full Sync, which needs a WRITE-scope PAT;
    // requiring it here would make the read-scope-first phase impossible. The
    // webhook route + inbound loader accept ready|active accordingly.
    if (conn.state !== "ready" && conn.state !== "active")
      return { success: false, error: "החיבור לא אומת — שמור טוקן והרץ בדיקת חיבור תחילה" };
    if (!conn.api_key_ciphertext)
      return { success: false, error: "טוקן PAT לא הוגדר — שמור טוקן Hospitable תחילה" };
    if (!channelSecretsConfigured())
      return { success: false, error: "מפתח ההצפנה של הערוצים אינו מוגדר בשרת" };
    const [mapped] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM guesthub.channel_hospitable_property_mappings
      WHERE connection_id = ${conn.id} AND status = 'mapped'`;
    if ((mapped?.n ?? 0) === 0)
      return { success: false, error: "אין חדרים ממופים לנכסי Hospitable — מפה חדר אחד לפחות תחילה" };

    let webhookUrl: string | null = null;
    let webhookWarning: string | null = null;
    if (!conn.webhook_token_hash) {
      const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
      if (!appUrl) {
        // Same fallback posture as Channex: without a public URL the callback
        // cannot exist; the worker's periodic poll alone imports every booking.
        webhookWarning = "כתובת האפליקציה אינה מוגדרת — הייבוא יתבסס על משיכה תקופתית בלבד";
      } else {
        const token = generateWebhookToken();
        await sql`
          UPDATE guesthub.channel_connections
          SET webhook_token_hash = ${sha256Hex(token)}
          WHERE id = ${conn.id}`;
        // The ONLY place the plaintext URL ever exists — returned once, shown once.
        webhookUrl = `${appUrl}/api/channel/webhook/${token}`;
      }
    }

    await sql`
      UPDATE guesthub.channel_connections
      SET inbound_sync_enabled = true
      WHERE id = ${conn.id}`;
    const ctx = await auditRequestContext();
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: conn.id,
      action: "inbound_enable",
      // never the token/URL — only whether one was minted this call
      after: { inbound_sync_enabled: true, webhook_minted: !!webhookUrl, webhook_warning: webhookWarning },
      ip: ctx.ip,
      session: ctx.session,
    });
    return { success: true, data: { webhookUrl, webhookWarning } };
  } catch (e) {
    return failFrom(e);
  }
}

// ---- 8) disable inbound booking import ----
// Also CLEARS webhook_token_hash (deliberate deviation from the Channex
// disable, which keeps it): Channex can re-register its callback automatically
// on re-enable, but the Hospitable URL is registered manually and its plaintext
// is displayable only at mint time — clearing the hash makes disable→enable the
// rotation path, and instantly 404s the old callback (defence in depth; the
// route already rejects disabled connections). The operator must delete the old
// webhook in the Hospitable UI as well.
export async function disableHospitableInboundAction(): Promise<Result> {
  try {
    const actor = await requireChannelAdmin();
    const conn = await loadHospitableRow(actor.tenantId);
    if (!conn) return { success: false, error: "אין חיבור Hospitable מוגדר" };

    await sql`
      UPDATE guesthub.channel_connections
      SET inbound_sync_enabled = false, webhook_token_hash = NULL
      WHERE id = ${conn.id}`;
    const ctx = await auditRequestContext();
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: conn.id,
      action: "inbound_disable",
      after: { inbound_sync_enabled: false, webhook_token_cleared: !!conn.webhook_token_hash },
      ip: ctx.ip,
      session: ctx.session,
    });
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}

// ---- 9) THE Hospitable Full Sync trigger ----
// Mirrors admin.ts requestFullSyncAction: enqueues a durable `full_sync` job
// and returns immediately — the PM2 channel worker (already provider-branched)
// runs runHospitableFullSync out of band, and a clean run is what flips the
// connection to state='active' + outbound_sync_enabled=true (the sync layer
// owns activation; this action only enqueues). Duplicate prevention is the
// DATABASE's (uq_jobs_idempotency on `full_sync:${connectionId}`); D70 §7 —
// the STORED PAT is probed (read-only) before a runnable job is created.
const FULL_SYNC_RUNNABLE_STATES = new Set(["ready", "active"]);
const ACTIVE_JOB_STATES = ["queued", "processing", "retry_wait"];

export type HospitableFullSyncRequestResult = {
  /** the channel_sync_jobs row id of the live run */
  runId: string | null;
  status: string;
  /** true ⇒ a Full Sync was ALREADY running; no second one was created */
  alreadyRunning: boolean;
};

export async function runHospitableFullSyncAction(): Promise<Result<HospitableFullSyncRequestResult>> {
  try {
    const actor = await requireChannelAdmin();
    const conn = await loadHospitableRow(actor.tenantId);
    if (!conn) return { success: false, error: "אין חיבור Hospitable מוגדר" };

    if (!conn.is_active_provider)
      return { success: false, error: "Hospitable במצב גיבוי — בחר אותו כספק פעיל בראש המסך תחילה" };
    const runnable = FULL_SYNC_RUNNABLE_STATES.has(conn.state);
    if (runnable) {
      // the Hospitable analogue of "a mapped property": at least one room mapped
      // WITH a designated pricing plan — otherwise the projection is empty.
      const [mapped] = await sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM guesthub.channel_hospitable_property_mappings
        WHERE connection_id = ${conn.id} AND status = 'mapped' AND local_rate_plan_id IS NOT NULL`;
      if ((mapped?.n ?? 0) === 0)
        return { success: false, error: "אין חדרים ממופים לנכסי Hospitable — מפה חדר ותוכנית תעריף תחילה" };

      // D70 §7 — never START a Full Sync on a credential that cannot
      // authenticate. Read-only probe of the stored PAT; on failure no job row.
      const auth = await probeStoredHospitablePat(actor.tenantId);
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
      after: { provider: "hospitable", state: conn.state, runnable, duplicate: alreadyRunning },
    });

    if (!runnable)
      return { success: false, error: "החיבור אינו מוכן לסנכרון — אמת את הטוקן (בדיקת חיבור) תחילה" };

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
