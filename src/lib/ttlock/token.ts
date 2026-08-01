import type { Sql } from "postgres";
import { encryptSecret, decryptSecret } from "./crypto";
import { ttlockRequest, md5Hex, TTLockError, type TTLockRegion } from "./http";

// ============================================================
// TTLock access-token resolver (D120) — WORKER-GRAPH-SAFE, like http.ts.
// No "server-only", no next/…, no react, no "use server" module. Enforced by
// scripts/check-ttlock-secrets.mjs rule 2.
//
// TOKEN DOCTRINE (the same one beds24-token.ts follows):
//
//  • TTLock access tokens live ~30 days. The current one is cached
//    AES-256-GCM-encrypted on the connection row (access_token_ciphertext +
//    access_token_expires_at) and REUSED until <5 minutes from expiry. Minting
//    on every call would put the account password on the wire constantly.
//  • The expiry is persisted ~60s EARLY: upstream's clock is not ours, and a
//    token we believe is alive for one more second is a token that fails the
//    next call. Erring early costs one refresh; erring late costs a failure the
//    operator sees.
//  • Refresh goes through grant_type=refresh_token. If that fails FOR ANY
//    REASON we fall back to the username/MD5-password grant — a refresh token
//    can be revoked or rotated upstream without us being told, and the password
//    grant is the only path that recovers from it without operator action.
//  • The fresh token is re-encrypted and PERSISTED BEFORE it is returned, so a
//    crash between the mint and the return never orphans it.
//  • The plaintext token exists only in the caller's frame. It is never
//    returned to a browser, never logged, and never placed in an error message.
//
// SINGLE-FLIGHT — WHAT IT ACTUALLY COVERS. The in-flight Map below is
// MODULE-LEVEL, so it deduplicates concurrent refreshes WITHIN ONE NODE
// PROCESS and nothing more. The PM2 channel worker is one process, so parallel
// jobs there share one refresh. The Next.js app is a SECOND process with its
// own copy of this Map, and `next dev`/`next build` may hold more than one
// worker still. Two processes CAN therefore mint concurrently. That is
// accepted, not prevented: a duplicate mint is idempotent upstream (the older
// token simply stops being the cached one) and costs no credit, unlike Beds24.
// This comment exists so nobody later reads "single-flight" as a global
// guarantee and builds something that needs one.
// ============================================================

/** The slice of guesthub.ttlock_connections this resolver needs. It issues no
 *  SELECT of its own — the caller owns the read, mirroring beds24-token.ts. */
export type TTLockConnectionRow = {
  id: string;
  region: TTLockRegion;
  client_id: string;
  username: string;
  /** AES-GCM bag { clientSecret, password }; NULL = never configured */
  secret_ciphertext: string | null;
  /** cached access token (encrypted); NULL = no cache yet */
  access_token_ciphertext: string | null;
  access_token_expires_at: string | Date | null;
  refresh_token_ciphertext: string | null;
};

const RENEW_WITHIN_MS = 5 * 60 * 1000; // reuse the cache until <5 min from expiry
const EXPIRY_SAFETY_MS = 60 * 1000; // persist the expiry 60s early (clock skew)

const inFlight = new Map<string, Promise<string>>();

export class TTLockNotConfiguredError extends Error {
  constructor(message = "חיבור TTLock אינו מוגדר") {
    super(message);
    this.name = "TTLockNotConfiguredError";
  }
}

function readBag(row: TTLockConnectionRow): { clientSecret: string; password: string } {
  if (!row.secret_ciphertext) throw new TTLockNotConfiguredError();
  const bag = JSON.parse(decryptSecret(row.secret_ciphertext)) as Record<string, unknown>;
  const clientSecret = typeof bag.clientSecret === "string" ? bag.clientSecret : "";
  const password = typeof bag.password === "string" ? bag.password : "";
  if (!clientSecret || !password) throw new TTLockNotConfiguredError();
  return { clientSecret, password };
}

function cachedTokenIsUsable(row: TTLockConnectionRow): boolean {
  if (!row.access_token_ciphertext || !row.access_token_expires_at) return false;
  const expiresAt = new Date(row.access_token_expires_at).getTime();
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - Date.now() > RENEW_WITHIN_MS;
}

type MintedToken = { accessToken: string; refreshToken: string | null; expiresInMs: number; uid: number | null };

function readTokenResponse(body: Record<string, unknown>): MintedToken {
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  if (!accessToken) throw new TTLockError("/oauth2/token", -1, "no access_token in response");
  const refreshToken = typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null;
  // TTLock reports expires_in in SECONDS.
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : Number(body.expires_in);
  const expiresInMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 30 * 24 * 60 * 60 * 1000;
  const uidRaw = body.uid;
  const uid = typeof uidRaw === "number" ? uidRaw : Number.isFinite(Number(uidRaw)) ? Number(uidRaw) : null;
  return { accessToken, refreshToken, expiresInMs, uid };
}

async function mintByPassword(row: TTLockConnectionRow): Promise<MintedToken> {
  const { clientSecret, password } = readBag(row);
  const body = await ttlockRequest(row.region, "/oauth2/token", {
    clientId: row.client_id,
    clientSecret,
    username: row.username,
    // MD5 hex is TTLock's wire format for the password — see http.ts header.
    password: md5Hex(password),
    grant_type: "password",
  });
  return readTokenResponse(body);
}

async function mintByRefresh(row: TTLockConnectionRow, refreshToken: string): Promise<MintedToken> {
  const { clientSecret } = readBag(row);
  const body = await ttlockRequest(row.region, "/oauth2/token", {
    clientId: row.client_id,
    clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return readTokenResponse(body);
}

/**
 * Persist the minted token BEFORE it is handed back. A crash after this commit
 * loses nothing; a crash before it simply means the next call mints again.
 */
async function persist(sql: Sql, connectionId: string, minted: MintedToken): Promise<void> {
  const expiresAt = new Date(Date.now() + minted.expiresInMs - EXPIRY_SAFETY_MS);
  await sql`
    UPDATE guesthub.ttlock_connections
    SET access_token_ciphertext  = ${encryptSecret(minted.accessToken)},
        access_token_expires_at  = ${expiresAt},
        refresh_token_ciphertext = ${
          minted.refreshToken
            ? encryptSecret(minted.refreshToken)
            : sql`guesthub.ttlock_connections.refresh_token_ciphertext`
        },
        ttlock_uid  = ${minted.uid ?? sql`guesthub.ttlock_connections.ttlock_uid`},
        updated_at  = now()
    WHERE id = ${connectionId}`;
}

async function refreshAndPersist(sql: Sql, row: TTLockConnectionRow): Promise<string> {
  let minted: MintedToken | null = null;

  // Refresh first — it does not touch the account password.
  if (row.refresh_token_ciphertext) {
    try {
      minted = await mintByRefresh(row, decryptSecret(row.refresh_token_ciphertext));
    } catch {
      // Swallowed BY DESIGN: a revoked/rotated refresh token is an expected
      // upstream state, not an error the operator needs to see, and the
      // password grant below recovers from it without any action from them.
      // The error object is dropped rather than logged — it can carry the
      // request we sent.
      minted = null;
    }
  }

  if (!minted) minted = await mintByPassword(row);

  await persist(sql, row.id, minted);
  return minted.accessToken;
}

/**
 * Resolve a usable plaintext access token for this connection.
 *
 * Returns the token to the CALLER'S FRAME only. Callers must not log it,
 * return it from a Server Action, or put it in an error message.
 */
export async function resolveTTLockAccessToken(sql: Sql, row: TTLockConnectionRow): Promise<string> {
  if (!row.secret_ciphertext) throw new TTLockNotConfiguredError();

  if (cachedTokenIsUsable(row) && row.access_token_ciphertext) {
    try {
      return decryptSecret(row.access_token_ciphertext);
    } catch {
      // Undecryptable cache (key rotated, row corrupted) — fall through and
      // mint. Never surface the cause: it concerns the key, not the operator.
    }
  }

  const existing = inFlight.get(row.id);
  if (existing) return existing;

  const promise = refreshAndPersist(sql, row).finally(() => inFlight.delete(row.id));
  inFlight.set(row.id, promise);
  return promise;
}
