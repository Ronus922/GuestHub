import "server-only";
import { sql } from "@/lib/db";
import { encryptSecretBag, decryptSecretBag, maskSecret, ttlockSecretsConfigured } from "./crypto";
import type { TTLockRegion } from "./http";
import type { TTLockConnectionRow } from "./token";

// ============================================================
// Persistence for the per-tenant TTLock connection (D122).
//
// THE BOUNDARY THIS FILE IS. Everything above it (actions, UI) may see only
// what getConnection returns — a MASKED view with a hint string and never a
// value. Everything that genuinely needs plaintext goes through
// getResolvedConnection, which is server-only and is called by the connection
// test and, later, the worker's code-issuing path. `server-only` stays HERE
// (unlike crypto/http/token, see crypto.ts header) precisely because this is
// where a secret is read out of the database.
//
// Every query is tenant-scoped and every table is qualified guesthub.<table>.
// ============================================================

export type TTLockConnectionView = {
  configured: boolean;
  region: TTLockRegion;
  clientId: string;
  username: string;
  /** "••••••••A92F" or "" — the masked TAIL, never the value */
  secretHint: string;
  status: string; // not_configured | connected | error
  statusDetail: string | null;
  lastTestedAt: string | null;
};

/** Server-only: config + the DECRYPTED bag. Never a client-facing return value. */
export type ResolvedTTLockConnection = TTLockConnectionRow & {
  clientSecret: string;
  password: string;
};

export type UpsertTTLockInput = {
  region: TTLockRegion;
  clientId: string;
  username: string;
  /** blank/undefined keeps the stored value (mirrors mergeSecret) */
  clientSecret?: string;
  /** blank/undefined keeps the stored value */
  password?: string;
};

const EMPTY_VIEW: TTLockConnectionView = {
  configured: false,
  region: "eu",
  clientId: "",
  username: "",
  secretHint: "",
  status: "not_configured",
  statusDetail: null,
  lastTestedAt: null,
};

type Row = {
  id: string;
  region: string;
  client_id: string;
  username: string;
  secret_ciphertext: string | null;
  secret_hint: string | null;
  access_token_ciphertext: string | null;
  access_token_expires_at: string | null;
  refresh_token_ciphertext: string | null;
  status: string;
  status_detail: string | null;
  last_tested_at: string | null;
};

/**
 * The masked view. NEVER returns a decrypted secret, token or password — the
 * SELECT deliberately does not even read the token columns, so there is no
 * plaintext anywhere in this function's frame to leak by accident.
 */
export async function getConnection(tenantId: string): Promise<TTLockConnectionView> {
  const [row] = await sql<
    {
      region: string;
      client_id: string;
      username: string;
      secret_hint: string | null;
      has_secret: boolean;
      status: string;
      status_detail: string | null;
      last_tested_at: string | null;
    }[]
  >`
    SELECT region, client_id, username, secret_hint,
           (secret_ciphertext IS NOT NULL) AS has_secret,
           status, status_detail,
           last_tested_at::text AS last_tested_at
    FROM guesthub.ttlock_connections
    WHERE tenant_id = ${tenantId}`;
  if (!row) return EMPTY_VIEW;
  return {
    configured: row.has_secret,
    region: (row.region === "global" ? "global" : "eu") as TTLockRegion,
    clientId: row.client_id,
    username: row.username,
    secretHint: row.secret_hint ?? "",
    status: row.status,
    statusDetail: row.status_detail,
    lastTestedAt: row.last_tested_at,
  };
}

/** Server-only: the row plus its decrypted bag. Returns null when unconfigured. */
export async function getResolvedConnection(tenantId: string): Promise<ResolvedTTLockConnection | null> {
  const [row] = await sql<Row[]>`
    SELECT id, region, client_id, username, secret_ciphertext, secret_hint,
           access_token_ciphertext, access_token_expires_at::text AS access_token_expires_at,
           refresh_token_ciphertext, status, status_detail,
           last_tested_at::text AS last_tested_at
    FROM guesthub.ttlock_connections
    WHERE tenant_id = ${tenantId}`;
  if (!row || !row.secret_ciphertext) return null;

  const bag = decryptSecretBag(row.secret_ciphertext);
  return {
    id: row.id,
    region: (row.region === "global" ? "global" : "eu") as TTLockRegion,
    client_id: row.client_id,
    username: row.username,
    secret_ciphertext: row.secret_ciphertext,
    access_token_ciphertext: row.access_token_ciphertext,
    access_token_expires_at: row.access_token_expires_at,
    refresh_token_ciphertext: row.refresh_token_ciphertext,
    clientSecret: typeof bag.clientSecret === "string" ? bag.clientSecret : "",
    password: typeof bag.password === "string" ? bag.password : "",
  };
}

/**
 * Upsert. A BLANK incoming secret keeps the stored one — the UI never renders a
 * secret back into an input, so "unchanged" arrives as an empty string and must
 * not be mistaken for "clear it".
 *
 * Changing either secret invalidates the cached token: the old access token was
 * minted from credentials that may no longer be the ones on file, and silently
 * reusing it would make a wrong secret look like it still works.
 */
export async function upsertConnection(tenantId: string, input: UpsertTTLockInput): Promise<void> {
  if (!ttlockSecretsConfigured()) throw new Error("TTLOCK_SECRETS_KEY is not configured");

  const existing = await getResolvedConnection(tenantId);
  const clientSecret = input.clientSecret?.trim() || existing?.clientSecret || "";
  const password = input.password?.trim() || existing?.password || "";
  const secretsChanged =
    clientSecret !== (existing?.clientSecret ?? "") || password !== (existing?.password ?? "");

  const hasBoth = Boolean(clientSecret && password);
  const cipher = hasBoth ? encryptSecretBag({ clientSecret, password }) : null;
  const hint = hasBoth ? maskSecret(clientSecret) : null;

  await sql`
    INSERT INTO guesthub.ttlock_connections
      (tenant_id, region, client_id, username, secret_ciphertext, secret_hint, status)
    VALUES (
      ${tenantId}, ${input.region}, ${input.clientId}, ${input.username},
      ${cipher}, ${hint}, 'not_configured'
    )
    ON CONFLICT (tenant_id) DO UPDATE SET
      region     = ${input.region},
      client_id  = ${input.clientId},
      username   = ${input.username},
      secret_ciphertext = COALESCE(${cipher}, guesthub.ttlock_connections.secret_ciphertext),
      secret_hint       = COALESCE(${hint}, guesthub.ttlock_connections.secret_hint),
      access_token_ciphertext  = ${secretsChanged ? null : sql`guesthub.ttlock_connections.access_token_ciphertext`},
      access_token_expires_at  = ${secretsChanged ? null : sql`guesthub.ttlock_connections.access_token_expires_at`},
      refresh_token_ciphertext = ${secretsChanged ? null : sql`guesthub.ttlock_connections.refresh_token_ciphertext`},
      updated_at = now()`;
}

export async function updateConnectionStatus(
  tenantId: string,
  status: "not_configured" | "connected" | "error",
  detail: string | null,
): Promise<void> {
  await sql`
    UPDATE guesthub.ttlock_connections
    SET status = ${status},
        status_detail = ${detail},
        last_tested_at = now(),
        updated_at = now()
    WHERE tenant_id = ${tenantId}`;
}

/** Remove the connection entirely — credentials and every cached token with it. */
export async function clearConnection(tenantId: string): Promise<void> {
  await sql`DELETE FROM guesthub.ttlock_connections WHERE tenant_id = ${tenantId}`;
}

export { ttlockSecretsConfigured };
