import "server-only";
import { randomBytes } from "node:crypto";
import { sql } from "@/lib/db";
import {
  encryptSecretBag,
  decryptSecretBag,
  maskSecret,
  messagingSecretsConfigured,
} from "./secrets";
import type { ProviderId, WhatsAppProviderId } from "./types";

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

export async function getActiveWhatsAppProvider(tenantId: string): Promise<WhatsAppProviderId> {
  const [row] = await sql<{ v: string | null }[]>`
    SELECT settings->'messaging'->>'whatsappProvider' AS v
    FROM guesthub.tenants WHERE id = ${tenantId}`;
  const v = row?.v;
  return v === "green_api" || v === "twilio" ? v : "disabled";
}

export async function setActiveWhatsAppProvider(tenantId: string, provider: WhatsAppProviderId): Promise<void> {
  await sql`
    UPDATE guesthub.tenants
    SET settings = jsonb_set(
      COALESCE(settings, '{}'::jsonb), '{messaging,whatsappProvider}', to_jsonb(${provider}::text), true
    )
    WHERE id = ${tenantId}`;
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
