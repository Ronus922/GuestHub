"use server";

import { sql } from "@/lib/db";
import { getActor, AuthorizationError, type Actor } from "@/lib/auth/actor";
import { canManageChannels } from "@/lib/auth/guards";
import { writeAudit, auditRequestContext } from "@/lib/audit";
import { beds24BaseUrl } from "./config";
import { encryptSecret, decryptSecret, secretHint, channelSecretsConfigured } from "./crypto";
import { beds24Request, beds24AuthRequest, beds24Fail, mapErrorStatus } from "./beds24-http";
import type { Beds24ApiErrorCategory, Beds24ApiFailure } from "./beds24-http";
import { asObj, asStr, asInt } from "./channex-http";
import {
  listBeds24Properties,
  getBeds24Property,
  extractBeds24PropertyList,
  type Beds24PropertySummary,
} from "./beds24-properties";

// ============================================================
// Beds24 server actions (D78) — super_admin ONLY, enforced server-side on
// every action (UI hiding is not security). Mirror of hospitable-admin.ts,
// with the Beds24 specifics:
//  • Beds24 exposes ONE production API — every row here is provider='beds24',
//    environment='production'. No staging exists.
//  • Auth is invite-code based: the operator generates an INVITE CODE in the
//    Beds24 UI (SETTINGS > MARKETPLACE > API) and this module exchanges it ONCE
//    (GET /authentication/setup, header `code`) for a long-life REFRESH TOKEN —
//    stored AES-256-GCM encrypted in api_key_ciphertext. The invite code itself
//    is single-use and is NEVER stored, audited or echoed.
//  • Access tokens live ~24h and COST CREDITS to mint: the current one is
//    cached encrypted in access_token_ciphertext + access_token_expires_at and
//    reused until <5 minutes from expiry (GET /authentication/token, header
//    `refreshToken`, re-mints and re-persists the cache).
//  • The mapping unit is the PHYSICAL ROOM: one room ↔ one Beds24 room
//    (propertyId+roomId) + ONE designated local pricing plan
//    (channel_beds24_room_mappings).
//  • READ-ONLY PHASE: probes and listings are GETs (/authentication/details,
//    /properties). A write to Beds24 is NEVER issued from this module.
// No token/code is ever returned to the browser, placed in an audit payload,
// a log or an error.
// ============================================================

type Result<T = undefined> = { success: true; data?: T } | { success: false; error: string };

const BEDS24_ENV = "production";
// Reuse the cached access token until this close to expiry (minting costs credits).
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;
// Store the expiry a little EARLY so a clock skew never presents a dead token.
const TOKEN_EXPIRY_SAFETY_MS = 60_000;
// Beds24 documents expiresIn as 24h; used only when the field is absent/malformed.
const TOKEN_DEFAULT_TTL_S = 86_400;

async function requireChannelAdmin(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new AuthorizationError("לא מחובר למערכת");
  const guard = canManageChannels({ userId: actor.userId, roleKey: actor.roleKey });
  if (!guard.ok) throw new AuthorizationError(guard.error);
  return actor;
}

function failFrom(e: unknown): { success: false; error: string } {
  if (e instanceof AuthorizationError) return { success: false, error: e.message };
  console.error("[beds24-admin]", e);
  return { success: false, error: "אירעה שגיאה בלתי צפויה" };
}

const apiFail = (f: Beds24ApiFailure): { success: false; error: string } => ({
  success: false,
  error: f.message,
});

const iso = (v: Date | null): string | null => (v ? v.toISOString() : null);

// ---- connection row ----

type Beds24Row = {
  id: string;
  state: string;
  api_key_ciphertext: string | null; // the encrypted REFRESH token
  api_key_hint: string | null;
  access_token_ciphertext: string | null; // 24h access-token cache (encrypted)
  access_token_expires_at: Date | null;
  last_test_ok_at: Date | null;
  last_test_failed_at: Date | null;
  last_test_error_code: string | null;
  last_error: string | null;
};

async function loadBeds24Row(tenantId: string): Promise<Beds24Row | null> {
  const [row] = await sql<Beds24Row[]>`
    SELECT id, state, api_key_ciphertext, api_key_hint,
           access_token_ciphertext, access_token_expires_at,
           last_test_ok_at, last_test_failed_at, last_test_error_code, last_error
    FROM guesthub.channel_connections
    WHERE tenant_id = ${tenantId} AND provider = 'beds24' AND environment = ${BEDS24_ENV}`;
  return row ?? null;
}

// ---- the shared access-token resolver ----
// Decrypts the CACHED access token when it is still comfortably valid;
// otherwise mints a fresh one via GET /authentication/token (header
// `refreshToken`) and re-persists the encrypted cache. The plaintext token
// exists only for the duration of the calling request — never returned to the
// browser, never logged.
//
// NOTE (worker phase): there is deliberately NO single-flight here — this is
// the admin-only phase and at most one operator call refreshes at a time. When
// the PM2 worker starts calling Beds24 concurrently, add single-flight (e.g.
// SELECT … FOR UPDATE on the connection row) so parallel jobs don't each burn
// a token-mint credit.
type AccessTokenResult =
  | { ok: true; token: string }
  | {
      ok: false;
      error: string;
      category: Beds24ApiErrorCategory | "not_configured" | "undecryptable";
    };

async function getBeds24AccessToken(row: Beds24Row): Promise<AccessTokenResult> {
  if (!row.api_key_ciphertext)
    return {
      ok: false,
      error: "חיבור Beds24 לא הוגדר — הזן קוד הזמנה (invite code) תחילה",
      category: "not_configured",
    };

  // 1) cached token, still valid for >5 minutes → reuse (minting costs credits).
  if (
    row.access_token_ciphertext &&
    row.access_token_expires_at &&
    row.access_token_expires_at.getTime() - Date.now() > TOKEN_REUSE_MARGIN_MS
  ) {
    try {
      return { ok: true, token: decryptSecret(row.access_token_ciphertext) };
    } catch {
      // an undecryptable CACHE is recoverable — fall through and re-mint
    }
  }

  // 2) mint a fresh access token from the stored refresh token.
  let refreshToken: string;
  try {
    refreshToken = decryptSecret(row.api_key_ciphertext);
  } catch {
    return {
      ok: false,
      error: "פענוח טוקן הרענון נכשל — ייתכן שמפתח ההצפנה בשרת השתנה",
      category: "undecryptable",
    };
  }

  const r = await beds24AuthRequest({
    baseUrl: beds24BaseUrl(),
    path: "/authentication/token",
    authHeader: { name: "refreshToken", value: refreshToken },
  });
  if ("ok" in r) return { ok: false, error: r.message, category: r.category };
  if (r.status !== 200) {
    const f = beds24Fail(mapErrorStatus(r.status), r.status);
    return { ok: false, error: f.message, category: f.category };
  }
  const body = asObj(r.body);
  const token = asStr(body?.token);
  if (!token) {
    const f = beds24Fail("bad_response", r.status);
    return { ok: false, error: f.message, category: f.category };
  }
  const expiresInS = asInt(body?.expiresIn) ?? TOKEN_DEFAULT_TTL_S;
  const expiresAt = new Date(Date.now() + expiresInS * 1000 - TOKEN_EXPIRY_SAFETY_MS);

  await sql`
    UPDATE guesthub.channel_connections
    SET access_token_ciphertext = ${encryptSecret(token)},
        access_token_expires_at = ${expiresAt},
        updated_at = now()
    WHERE id = ${row.id}`;
  return { ok: true, token };
}

// ---- 1) masked connection view (pure DB read — NO Beds24 network call) ----

export type Beds24MappingRow = {
  roomId: string;
  beds24PropertyId: string;
  beds24RoomId: string;
  /** display-only snapshots from map time — refreshed on every re-map */
  beds24PropertyName: string | null;
  beds24RoomName: string | null;
  localRatePlanId: string | null;
  currency: string | null;
  status: "mapped" | "unmapped" | "quarantined";
  updatedAt: string | null;
};

export type Beds24RoomOption = {
  roomId: string;
  roomNumber: string;
  categoryName: string | null;
  floor: number | null;
  isActive: boolean;
};

export type Beds24RatePlanOption = {
  id: string;
  name: string;
};

export type Beds24ConnectionView = {
  environment: typeof BEDS24_ENV;
  baseUrl: string;
  secretsKeyConfigured: boolean;
  configured: boolean; // a refresh token is stored
  refreshTokenHint: string | null; // "••••1a2b" — never the token
  /** ISO expiry of the CACHED 24h access token; null = no cache yet */
  accessTokenExpiresAt: string | null;
  state: string;
  lastTestOkAt: string | null;
  lastTestFailedAt: string | null;
  lastTestErrorCode: string | null;
  lastError: string | null;
  mappedCount: number;
  /** the tenant currency — pricing plans have no own currency column; the
   *  tenant currency IS the plan currency (see rate-plan-admin loadCurrency) */
  tenantCurrency: string;
  rooms: Beds24RoomOption[];
  ratePlans: Beds24RatePlanOption[];
  mappings: Beds24MappingRow[];
};

export async function getBeds24ConnectionAction(): Promise<Result<Beds24ConnectionView>> {
  try {
    const actor = await requireChannelAdmin();
    const row = await loadBeds24Row(actor.tenantId);

    const [mappings, rooms, plans, [tenant]] = await Promise.all([
      row
        ? sql<Beds24MappingRow[]>`
            SELECT room_id AS "roomId", beds24_property_id AS "beds24PropertyId",
                   beds24_room_id AS "beds24RoomId",
                   beds24_property_name AS "beds24PropertyName",
                   beds24_room_name AS "beds24RoomName",
                   local_rate_plan_id AS "localRatePlanId", currency, status,
                   updated_at::text AS "updatedAt"
            FROM guesthub.channel_beds24_room_mappings
            WHERE tenant_id = ${actor.tenantId} AND connection_id = ${row.id}`
        : Promise.resolve([] as Beds24MappingRow[]),
      sql<Beds24RoomOption[]>`
        SELECT r.id AS "roomId", r.room_number AS "roomNumber",
               rt.name AS "categoryName", r.floor, r.is_active AS "isActive"
        FROM guesthub.rooms r
        LEFT JOIN guesthub.room_types rt ON rt.id = r.room_type_id
        WHERE r.tenant_id = ${actor.tenantId}
        ORDER BY r.room_number`,
      // Same eligibility as the Channex/Hospitable rate-plan flow: TENANT-scoped
      // plans (sellable_unit_id IS NULL), active, not archived, channel-visible.
      sql<Beds24RatePlanOption[]>`
        SELECT id, name FROM guesthub.pricing_plans
        WHERE tenant_id = ${actor.tenantId} AND sellable_unit_id IS NULL
          AND is_active AND NOT is_archived AND is_visible_channels
        ORDER BY name`,
      sql<{ currency: string | null }[]>`
        SELECT currency FROM guesthub.tenants WHERE id = ${actor.tenantId}`,
    ]);

    return {
      success: true,
      data: {
        environment: BEDS24_ENV,
        baseUrl: beds24BaseUrl(),
        secretsKeyConfigured: channelSecretsConfigured(),
        configured: !!row?.api_key_ciphertext,
        refreshTokenHint: row?.api_key_hint ?? null,
        accessTokenExpiresAt: iso(row?.access_token_expires_at ?? null),
        state: row?.state ?? "disconnected",
        lastTestOkAt: iso(row?.last_test_ok_at ?? null),
        lastTestFailedAt: iso(row?.last_test_failed_at ?? null),
        lastTestErrorCode: row?.last_test_error_code ?? null,
        lastError: row?.last_error ?? null,
        mappedCount: mappings.filter((m) => m.status === "mapped").length,
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

// ---- 2) exchange the invite code → store refresh token + token cache ----
// GET /authentication/setup with header `code` → { token, expiresIn,
// refreshToken }. The refresh token is what we keep (encrypted, hinted); the
// access token is cached encrypted with its expiry so the very next call needs
// no credit-costing mint. The INVITE CODE is single-use and transient — it is
// never stored, never audited (not even a hint of it), never echoed.
export async function setupBeds24Action(input: { inviteCode: string }): Promise<Result> {
  try {
    const actor = await requireChannelAdmin();
    if (!channelSecretsConfigured())
      return { success: false, error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת" };
    const inviteCode = input.inviteCode.trim();
    if (!inviteCode) return { success: false, error: "יש להזין קוד הזמנה (invite code) מ-Beds24" };

    const existing = await loadBeds24Row(actor.tenantId);
    const replacing = !!existing?.api_key_ciphertext;

    const r = await beds24AuthRequest({
      baseUrl: beds24BaseUrl(),
      path: "/authentication/setup",
      authHeader: { name: "code", value: inviteCode },
    });
    if ("ok" in r) return apiFail(r);
    if (r.status !== 200) return apiFail(beds24Fail(mapErrorStatus(r.status), r.status));
    const body = asObj(r.body);
    const token = asStr(body?.token);
    const refreshToken = asStr(body?.refreshToken);
    if (!token || !refreshToken) return apiFail(beds24Fail("bad_response", r.status));
    const expiresInS = asInt(body?.expiresIn) ?? TOKEN_DEFAULT_TTL_S;
    const accessExpiresAt = new Date(Date.now() + expiresInS * 1000 - TOKEN_EXPIRY_SAFETY_MS);

    const [row] = await sql<{ id: string }[]>`
      INSERT INTO guesthub.channel_connections
        (tenant_id, provider, environment, state, api_key_ciphertext, api_key_hint,
         access_token_ciphertext, access_token_expires_at, created_by, updated_by)
      VALUES (${actor.tenantId}, 'beds24', ${BEDS24_ENV}, 'configured',
              ${encryptSecret(refreshToken)}, ${secretHint(refreshToken)},
              ${encryptSecret(token)}, ${accessExpiresAt},
              ${actor.userId}, ${actor.userId})
      ON CONFLICT (tenant_id, provider, environment) DO UPDATE SET
        api_key_ciphertext = EXCLUDED.api_key_ciphertext,
        api_key_hint = EXCLUDED.api_key_hint,
        access_token_ciphertext = EXCLUDED.access_token_ciphertext,
        access_token_expires_at = EXCLUDED.access_token_expires_at,
        -- a fresh, untested credential resets the verdict; an active link stays active
        state = CASE WHEN guesthub.channel_connections.state = 'active'
                     THEN 'active' ELSE 'configured' END,
        last_test_ok_at = NULL, last_test_failed_at = NULL,
        last_test_error_code = NULL, last_error = NULL,
        updated_by = ${actor.userId}, updated_at = now()
      RETURNING id`;

    // Audit carries ONLY environment + access-token expiry metadata — never the
    // invite code, refresh token, access token or even a hint of the code.
    const ctx = await auditRequestContext();
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: row.id,
      action: replacing ? "beds24_credential_replaced" : "beds24_credential_configured",
      after: { environment: BEDS24_ENV, accessTokenExpiresAt: accessExpiresAt.toISOString() },
      ip: ctx.ip,
      session: ctx.session,
    });
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}

// ---- 3) THE stored-credential probe + test action ----
// One GET /authentication/details (token validity + scopes) then one
// GET /properties (accessibility + count) with the credential ALREADY in the
// database — decrypted server-side, never taken from the browser. Read-only by
// construction: a write is NEVER probed. Records the verdict on the connection
// row per the existing state machine (→ ready on success, → error on failure;
// 'active' is never demoted by a probe).

type ProbeResult =
  | { ok: true; propertyCount: number; creditsRemaining: number | null }
  | {
      ok: false;
      error: string;
      category: Beds24ApiErrorCategory | "not_configured" | "undecryptable";
    };

async function recordProbeVerdict(tenantId: string, r: ProbeResult): Promise<void> {
  if (r.ok) {
    await sql`
      UPDATE guesthub.channel_connections
      SET state = CASE WHEN state = 'active' THEN 'active' ELSE 'ready' END,
          last_test_ok_at = now(), last_test_failed_at = NULL,
          last_test_error_code = NULL, last_error = NULL, updated_at = now()
      WHERE tenant_id = ${tenantId} AND provider = 'beds24' AND environment = ${BEDS24_ENV}`;
    return;
  }
  if (r.category === "not_configured" || r.category === "undecryptable") return;
  await sql`
    UPDATE guesthub.channel_connections
    SET state = CASE WHEN state = 'active' THEN 'active' ELSE 'error' END,
        last_test_failed_at = now(), last_test_error_code = ${r.category},
        last_error = ${r.error}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND provider = 'beds24' AND environment = ${BEDS24_ENV}`;
}

async function probeStoredBeds24Credential(tenantId: string): Promise<ProbeResult> {
  if (!channelSecretsConfigured())
    return {
      ok: false,
      error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת",
      category: "not_configured",
    };
  const row = await loadBeds24Row(tenantId);
  if (!row?.api_key_ciphertext)
    return { ok: false, error: "חיבור Beds24 לא הוגדר", category: "not_configured" };

  const access = await getBeds24AccessToken(row);
  if (!access.ok) {
    const r: ProbeResult = { ok: false, error: access.error, category: access.category };
    await recordProbeVerdict(tenantId, r);
    return r;
  }

  const baseUrl = beds24BaseUrl();
  const fromFailure = (f: Beds24ApiFailure): ProbeResult => ({
    ok: false,
    error: f.message,
    category: f.category,
  });

  // 1) token validity/scopes — proves the credential authenticates at all
  const details = await beds24Request({
    token: access.token,
    baseUrl,
    method: "GET",
    path: "/authentication/details",
  });
  if ("ok" in details) {
    const r = fromFailure(details);
    await recordProbeVerdict(tenantId, r);
    return r;
  }
  if (details.status !== 200) {
    const r = fromFailure(beds24Fail(mapErrorStatus(details.status), details.status));
    await recordProbeVerdict(tenantId, r);
    return r;
  }

  // 2) properties scope — first page only (a probe, not a full listing)
  const props = await beds24Request({
    token: access.token,
    baseUrl,
    method: "GET",
    path: "/properties",
  });
  if ("ok" in props) {
    const r = fromFailure(props);
    await recordProbeVerdict(tenantId, r);
    return r;
  }
  if (props.status !== 200) {
    const r = fromFailure(beds24Fail(mapErrorStatus(props.status), props.status));
    await recordProbeVerdict(tenantId, r);
    return r;
  }

  const { ok, properties } = extractBeds24PropertyList(props.body);
  if (!ok) {
    const r = fromFailure(beds24Fail("bad_response", props.status));
    await recordProbeVerdict(tenantId, r);
    return r;
  }
  // remaining 5-min-window credits — a bare header number, never a body echo
  const creditsRemaining = props.creditsRemaining ?? details.creditsRemaining ?? null;
  const verdict: ProbeResult = { ok: true, propertyCount: properties.length, creditsRemaining };
  await recordProbeVerdict(tenantId, verdict);
  return verdict;
}

export async function testBeds24ConnectionAction(): Promise<
  Result<{
    ok: boolean;
    propertyCount?: number;
    creditsRemaining?: number | null;
    category?: string;
    message?: string;
  }>
> {
  try {
    const actor = await requireChannelAdmin();
    const probe = await probeStoredBeds24Credential(actor.tenantId);
    const ctx = await auditRequestContext();

    if (probe.ok) {
      await writeAudit(actor, {
        entityType: "channel_connection",
        entityId: null,
        action: "beds24_connection_test_succeeded",
        after: {
          environment: BEDS24_ENV,
          propertyCount: probe.propertyCount,
          creditsRemaining: probe.creditsRemaining,
        },
        ip: ctx.ip,
        session: ctx.session,
      });
      return {
        success: true,
        data: {
          ok: true,
          propertyCount: probe.propertyCount,
          creditsRemaining: probe.creditsRemaining,
        },
      };
    }

    // A missing/undecryptable credential is a configuration problem, not a verdict.
    if (probe.category === "not_configured" || probe.category === "undecryptable")
      return { success: false, error: probe.error };

    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: null,
      action: "beds24_connection_test_failed",
      after: { environment: BEDS24_ENV, category: probe.category },
      ip: ctx.ip,
      session: ctx.session,
    });
    return { success: true, data: { ok: false, category: probe.category, message: probe.error } };
  } catch (e) {
    return failFrom(e);
  }
}

// ---- 4) list accessible Beds24 properties WITH rooms (operator-triggered) ----
// Never runs on page load. Returns safe, whitelisted fields only — the mapping
// UI groups the room options per property (optgroup).
export async function listBeds24PropertiesAction(): Promise<
  Result<{ properties: Beds24PropertySummary[] }>
> {
  try {
    const actor = await requireChannelAdmin();
    if (!channelSecretsConfigured())
      return { success: false, error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת" };
    const row = await loadBeds24Row(actor.tenantId);
    if (!row)
      return { success: false, error: "חיבור Beds24 לא הוגדר — הזן קוד הזמנה תחילה" };
    const access = await getBeds24AccessToken(row);
    if (!access.ok) return { success: false, error: access.error };

    const res = await listBeds24Properties({ token: access.token, baseUrl: beds24BaseUrl() });
    if (!res.ok) return apiFail(res);
    return { success: true, data: { properties: res.properties } };
  } catch (e) {
    return failFrom(e);
  }
}

// ---- 5) map a physical room ↔ a Beds24 room ----
// Verifies the property AND the room FRESH against Beds24 before writing
// (accessibility, room existence, currency) — the mapping can never be created
// from a stale browser list. Rejections:
//  • the room id is absent from the property's fresh room list;
//  • currency mismatch vs the designated plan's currency. pricing_plans has no
//    currency column: the TENANT currency is the plan currency (exactly how
//    rate-plan-admin.ts resolves it), so that is what is compared.
export async function mapBeds24RoomAction(input: {
  roomId: string;
  beds24PropertyId: string;
  beds24RoomId: string;
  localRatePlanId: string;
}): Promise<Result<{ mappingId: string }>> {
  try {
    const actor = await requireChannelAdmin();
    if (!channelSecretsConfigured())
      return { success: false, error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת" };
    const propertyId = (input.beds24PropertyId ?? "").trim();
    const beds24RoomId = (input.beds24RoomId ?? "").trim();
    if (!propertyId || !beds24RoomId)
      return { success: false, error: "יש לבחור נכס וחדר Beds24" };
    if (!input.localRatePlanId)
      return { success: false, error: "יש לבחור תוכנית תעריף מקומית" };

    const conn = await loadBeds24Row(actor.tenantId);
    if (!conn)
      return { success: false, error: "חיבור Beds24 לא הוגדר — הזן קוד הזמנה תחילה" };
    const access = await getBeds24AccessToken(conn);
    if (!access.ok) return { success: false, error: access.error };

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

    // Verify the property + room FRESH before writing anything.
    const got = await getBeds24Property({
      token: access.token,
      baseUrl: beds24BaseUrl(),
      id: propertyId,
    });
    if (!got.ok) return apiFail(got);
    const beds24Room = got.property.rooms.find((r) => r.id === beds24RoomId);
    if (!beds24Room)
      return { success: false, error: "חדר Beds24 זה לא נמצא בנכס — רענן את רשימת הנכסים" };
    const propertyCurrency = got.property.currency?.toUpperCase() ?? null;
    if (!propertyCurrency)
      return { success: false, error: "לא ניתן לאמת את מטבע הנכס ב-Beds24 — המיפוי נחסם" };
    if (propertyCurrency !== planCurrency)
      return {
        success: false,
        error: `מטבע הנכס (${propertyCurrency}) אינו תואם את מטבע תוכנית התעריף (${planCurrency}) — לא ניתן למפות`,
      };

    // UNIQUE (connection_id, beds24_property_id, beds24_room_id): one external
    // room maps to ONE local room. A conflict on a different room is answered
    // explicitly instead of surfacing a constraint error.
    const [taken] = await sql<{ room_id: string }[]>`
      SELECT room_id FROM guesthub.channel_beds24_room_mappings
      WHERE connection_id = ${conn.id}
        AND beds24_property_id = ${propertyId} AND beds24_room_id = ${beds24RoomId}
        AND room_id <> ${input.roomId}`;
    if (taken) return { success: false, error: "חדר Beds24 זה כבר ממופה לחדר אחר" };

    const [before] = await sql<
      { beds24_property_id: string; beds24_room_id: string; local_rate_plan_id: string | null }[]
    >`
      SELECT beds24_property_id, beds24_room_id, local_rate_plan_id
      FROM guesthub.channel_beds24_room_mappings
      WHERE connection_id = ${conn.id} AND room_id = ${input.roomId}`;

    const [row] = await sql<{ id: string }[]>`
      INSERT INTO guesthub.channel_beds24_room_mappings
        (tenant_id, connection_id, room_id, beds24_property_id, beds24_room_id,
         beds24_property_name, beds24_room_name, local_rate_plan_id, currency, status)
      VALUES (${actor.tenantId}, ${conn.id}, ${input.roomId}, ${propertyId}, ${beds24RoomId},
              ${got.property.name}, ${beds24Room.name},
              ${input.localRatePlanId}, ${got.property.currency}, 'mapped')
      ON CONFLICT (connection_id, room_id) DO UPDATE SET
        beds24_property_id = EXCLUDED.beds24_property_id,
        beds24_room_id = EXCLUDED.beds24_room_id,
        beds24_property_name = EXCLUDED.beds24_property_name,
        beds24_room_name = EXCLUDED.beds24_room_name,
        local_rate_plan_id = EXCLUDED.local_rate_plan_id,
        currency = EXCLUDED.currency,
        status = 'mapped', updated_at = now()
      RETURNING id`;

    const ctx = await auditRequestContext();
    await writeAudit(actor, {
      entityType: "channel_beds24_room_mapping",
      entityId: row.id,
      action: "upsert",
      before: before ?? undefined,
      after: {
        room_id: input.roomId,
        beds24_property_id: propertyId,
        beds24_room_id: beds24RoomId,
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
// The row is DELETED, not flipped to status='unmapped': beds24_room_id is
// NOT NULL + UNIQUE per (connection, property, room), so a retained "unmapped"
// row would keep blocking that Beds24 room from being mapped to any other
// local room. "Unmapped" for this table means "no row". Nothing external is
// touched.
export async function unmapBeds24RoomAction(input: { roomId: string }): Promise<Result> {
  try {
    const actor = await requireChannelAdmin();
    const [removed] = await sql<
      { id: string; beds24_property_id: string; beds24_room_id: string; local_rate_plan_id: string | null }[]
    >`
      DELETE FROM guesthub.channel_beds24_room_mappings
      WHERE tenant_id = ${actor.tenantId} AND room_id = ${input.roomId}
      RETURNING id, beds24_property_id, beds24_room_id, local_rate_plan_id`;
    if (!removed) return { success: false, error: "לא קיים מיפוי Beds24 לחדר זה" };

    const ctx = await auditRequestContext();
    await writeAudit(actor, {
      entityType: "channel_beds24_room_mapping",
      entityId: removed.id,
      action: "delete",
      before: {
        room_id: input.roomId,
        beds24_property_id: removed.beds24_property_id,
        beds24_room_id: removed.beds24_room_id,
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
