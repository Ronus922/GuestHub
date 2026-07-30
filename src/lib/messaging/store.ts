import "server-only";
import { randomBytes } from "node:crypto";
import { sql } from "@/lib/db";
import {
  encryptSecretBag,
  decryptSecretBag,
  maskSecret,
  messagingSecretsConfigured,
} from "./secrets";
import type { ActiveWhatsAppPointer, ProviderId, WhatsAppProviderId } from "./types";

// Opaque webhook routing token: 192 bits of CSPRNG entropy, URL-safe. Generated
// server-side per provider connection, derived from NOTHING predictable (not the
// account SID / instance id / tenant id). It routes an inbound provider callback
// to the right connection and adds obscurity; it is NEVER the sole cryptographic
// auth (Twilio still verifies X-Twilio-Signature). Rotatable independently of the
// provider credentials. Lives in the connection's non-secret config, so it is
// safe to show in a copyable callback URL.
export function generateWebhookToken(): string {
  return randomBytes(24).toString("base64url");
}

// Persistence for messaging provider connections + the non-secret active-provider
// pointer (D53). Secrets are encrypted at rest (secret_ciphertext) and NEVER
// returned to a client — settings actions expose maskConnection() only.

export type StoredConnection = {
  provider: ProviderId;
  config: Record<string, unknown>;
  status: string; // connected | not_configured | error
  statusDetail: string | null;
  lastTestedAt: string | null;
  hasSecret: boolean;
};

// Server-only: config + DECRYPTED secret bag. Used by provider resolvers and
// the connection test — never by a client-facing return value.
export type ResolvedConnection = {
  provider: ProviderId;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
  status: string;
};

export async function getConnection(
  tenantId: string,
  provider: ProviderId,
): Promise<StoredConnection | null> {
  const [row] = await sql<
    { provider: string; config: Record<string, unknown>; status: string; status_detail: string | null; last_tested_at: string | null; has_secret: boolean }[]
  >`
    SELECT provider, config, status, status_detail,
           last_tested_at::text AS last_tested_at,
           (secret_ciphertext IS NOT NULL) AS has_secret
    FROM guesthub.messaging_provider_connections
    WHERE tenant_id = ${tenantId} AND provider = ${provider}`;
  if (!row) return null;
  return {
    provider: row.provider as ProviderId,
    config: row.config ?? {},
    status: row.status,
    statusDetail: row.status_detail,
    lastTestedAt: row.last_tested_at,
    hasSecret: row.has_secret,
  };
}

// Resolve a connection by its opaque webhook token (webhook routing). The token
// identifies the connection AND therefore the tenant — inbound payloads are never
// trusted for tenant identity. Returns the decrypted secrets too (Twilio needs
// the auth token to verify X-Twilio-Signature). A blank/absent token never
// matches (config->>'webhookToken' is NULL when unset, and NULL = token is NULL).
export async function getConnectionByWebhookToken(
  provider: ProviderId,
  token: string,
): Promise<(ResolvedConnection & { tenantId: string }) | null> {
  if (!token) return null;
  const [row] = await sql<
    { tenant_id: string; provider: string; config: Record<string, unknown>; status: string; secret_ciphertext: string | null }[]
  >`
    SELECT tenant_id, provider, config, status, secret_ciphertext
    FROM guesthub.messaging_provider_connections
    WHERE provider = ${provider} AND config->>'webhookToken' = ${token}
    LIMIT 1`;
  if (!row) return null;
  const secrets = row.secret_ciphertext ? decryptSecretBag(row.secret_ciphertext) : {};
  return {
    tenantId: row.tenant_id,
    provider: row.provider as ProviderId,
    config: row.config ?? {},
    secrets,
    status: row.status,
  };
}

// Decrypts the secret bag. Returns null when no connection or no secret exists.
export async function getResolvedConnection(
  tenantId: string,
  provider: ProviderId,
): Promise<ResolvedConnection | null> {
  const [row] = await sql<
    { provider: string; config: Record<string, unknown>; status: string; secret_ciphertext: string | null }[]
  >`
    SELECT provider, config, status, secret_ciphertext
    FROM guesthub.messaging_provider_connections
    WHERE tenant_id = ${tenantId} AND provider = ${provider}`;
  if (!row) return null;
  const secrets = row.secret_ciphertext ? decryptSecretBag(row.secret_ciphertext) : {};
  return { provider: row.provider as ProviderId, config: row.config ?? {}, secrets, status: row.status };
}

// Upsert config and (optionally) secrets. Pass `secrets: null` to leave the
// existing encrypted secret untouched (the UI sends secrets only when changed).
export async function upsertConnection(args: {
  tenantId: string;
  provider: ProviderId;
  config: Record<string, unknown>;
  secrets: Record<string, unknown> | null;
  status?: string;
  statusDetail?: string | null;
  userId: string;
}): Promise<void> {
  const cipher = args.secrets !== null ? encryptSecretBag(args.secrets) : null;
  await sql`
    INSERT INTO guesthub.messaging_provider_connections
      (tenant_id, provider, config, secret_ciphertext, status, status_detail, created_by, updated_by)
    VALUES (
      ${args.tenantId}, ${args.provider}, ${sql.json(args.config as never)},
      ${cipher}, ${args.status ?? "not_configured"}, ${args.statusDetail ?? null},
      ${args.userId}, ${args.userId}
    )
    ON CONFLICT (tenant_id, provider) DO UPDATE SET
      config = ${sql.json(args.config as never)},
      secret_ciphertext = COALESCE(${cipher}, guesthub.messaging_provider_connections.secret_ciphertext),
      status = ${args.status ?? sql`guesthub.messaging_provider_connections.status`},
      status_detail = ${args.statusDetail ?? null},
      updated_by = ${args.userId},
      updated_at = now()`;
}

export async function updateConnectionStatus(args: {
  tenantId: string;
  provider: ProviderId;
  status: string;
  statusDetail?: string | null;
  tested?: boolean;
}): Promise<void> {
  await sql`
    UPDATE guesthub.messaging_provider_connections
    SET status = ${args.status}, status_detail = ${args.statusDetail ?? null},
        last_tested_at = ${args.tested ? sql`now()` : sql`last_tested_at`},
        updated_at = now()
    WHERE tenant_id = ${args.tenantId} AND provider = ${args.provider}`;
}

// Disconnect: clear the encrypted secret and mark not_configured. Config (e.g.
// sender email) is kept so re-connecting is easy; the SECRET is gone.
export async function clearConnectionSecret(tenantId: string, provider: ProviderId, userId: string): Promise<void> {
  await sql`
    UPDATE guesthub.messaging_provider_connections
    SET secret_ciphertext = NULL, status = 'not_configured', status_detail = NULL,
        updated_by = ${userId}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND provider = ${provider}`;
}

// ---- non-secret active-provider pointer (tenants.settings.messaging jsonb) ----

/** A pointer write that did not land. Never swallowed — see D113. */
export class ActiveWhatsAppProviderWriteError extends Error {
  constructor(readonly requested: WhatsAppProviderId, readonly stored: string | null) {
    super(`active WhatsApp provider not persisted (requested ${requested}, stored ${stored ?? "null"})`);
    this.name = "ActiveWhatsAppProviderWriteError";
  }
}

/**
 * Reads the pointer WITHOUT inventing a decision — see ActiveWhatsAppPointer.
 * Callers asking "is there a usable provider" should use usableWhatsAppProvider().
 */
export async function getActiveWhatsAppProvider(tenantId: string): Promise<ActiveWhatsAppPointer> {
  const [row] = await sql<{ v: string | null }[]>`
    SELECT settings->'messaging'->>'whatsappProvider' AS v
    FROM guesthub.tenants WHERE id = ${tenantId}`;
  const v = row?.v ?? null;
  if (v === null) return "not_configured";
  if (v === "green_api" || v === "twilio" || v === "disabled") return v;
  return "invalid";
}

/**
 * The single "can we send WhatsApp right now" reading of the pointer. Every
 * non-provider state — never chosen, explicitly off, corrupt — means no, and
 * they mean no for different reasons that only the operator-facing surfaces
 * need to tell apart.
 */
export function usableWhatsAppProvider(pointer: ActiveWhatsAppPointer): "green_api" | "twilio" | null {
  return pointer === "green_api" || pointer === "twilio" ? pointer : null;
}

/**
 * Sets the pointer and PROVES it landed.
 *
 * The previous implementation used jsonb_set(settings, '{messaging,whatsappProvider}', …, true).
 * create_missing only creates the LAST path element, so when the `messaging`
 * parent was absent — as it was for every tenant, since no migration ever
 * seeded it — PostgreSQL returned the document unchanged. The UPDATE matched
 * its row, the driver reported success, the action wrote an audit row, and
 * nothing was persisted. A connected, tested GREEN-API sat unusable for two
 * days behind six such clicks (D113).
 *
 * Two changes make that unrepresentable: the parent is built in the same
 * expression that sets the child, and the result is read back and compared.
 * `||` merges rather than replaces, so unrelated keys under `messaging`
 * survive; a write that does not land throws instead of returning.
 */
export async function setActiveWhatsAppProvider(tenantId: string, provider: WhatsAppProviderId): Promise<void> {
  const [row] = await sql<{ pointer: string | null }[]>`
    UPDATE guesthub.tenants
    SET settings = COALESCE(settings, '{}'::jsonb)
                || jsonb_build_object('messaging',
                     CASE WHEN jsonb_typeof(settings->'messaging') = 'object'
                          THEN settings->'messaging' ELSE '{}'::jsonb END
                     || jsonb_build_object('whatsappProvider', ${provider}::text)),
        updated_at = now()
    WHERE id = ${tenantId}
    RETURNING settings->'messaging'->>'whatsappProvider' AS pointer`;
  // No row = no such tenant; a mismatch = the write silently did not take.
  if (!row || row.pointer !== provider) {
    throw new ActiveWhatsAppProviderWriteError(provider, row?.pointer ?? null);
  }
}

// Masked, client-safe view of one connection for the settings UI. NEVER returns
// a secret — only a boolean + a "••••••••XXXX" hint per known secret field.
export function maskConnection(
  conn: StoredConnection | null,
  secretHints: Record<string, string> = {},
): {
  configured: boolean;
  status: string;
  statusDetail: string | null;
  lastTestedAt: string | null;
  config: Record<string, unknown>;
  secretHints: Record<string, string>;
} {
  return {
    configured: Boolean(conn?.hasSecret),
    status: conn?.status ?? "not_configured",
    statusDetail: conn?.statusDetail ?? null,
    lastTestedAt: conn?.lastTestedAt ?? null,
    config: conn?.config ?? {},
    secretHints,
  };
}

// Build masked hints from a resolved connection's decrypted secrets (server-side
// only). Returns e.g. { apiToken: "••••••••A92F" }.
export function secretHintsFrom(secrets: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(secrets)) {
    if (typeof v === "string" && v) out[k] = maskSecret(v);
  }
  return out;
}

export { messagingSecretsConfigured };
