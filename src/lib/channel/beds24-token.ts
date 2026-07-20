import type { Sql } from "postgres";
import { beds24BaseUrl } from "./config";
import { encryptSecret, decryptSecret, channelSecretsConfigured } from "./crypto";
import { beds24AuthRequest, beds24Fail, mapErrorStatus } from "./beds24-http";
import type { Beds24ApiErrorCategory } from "./beds24-http";
import { asObj, asStr, asInt } from "./channex-http";

// ============================================================
// Beds24 access-token resolver (D78 → D79) — the WORKER-GRAPH-SAFE sibling of
// the module-private getBeds24AccessToken in beds24-admin.ts.
//
// WHY A SEPARATE MODULE. beds24-admin.ts is a "use server" actions module: it
// imports the actor/guard/audit stack and can never enter the PM2 worker's
// compile graph (tsconfig.worker.json forbids next/react/server-action
// modules). The worker's outbound calendar push still needs a plaintext access
// token, so the resolver lives HERE — deliberately free of "server-only" and
// of every Next-coupled import — and beds24-ari-sync.ts (worker graph) calls
// it. beds24-admin.ts keeps its own private copy for the admin phase; the
// TOKEN DOCTRINE is identical in both:
//
//  • Beds24 access tokens live ~24h and COST CREDITS to mint. The current one
//    is cached AES-256-GCM-encrypted on the connection row
//    (access_token_ciphertext + access_token_expires_at) and reused until
//    <5 minutes from expiry.
//  • A refresh goes through GET /authentication/token with the long-life
//    REFRESH token (api_key_ciphertext, decrypted just-in-time) in the
//    dedicated `refreshToken` header — never `token`, never Bearer.
//  • The fresh token is re-encrypted and persisted BEFORE it is returned, so a
//    crash after the mint never orphans a paid-for token.
//  • The plaintext token exists only in the caller's frame — never returned to
//    a browser, never logged, never placed in an error message.
//
// SINGLE-FLIGHT (the admin module's "worker phase" note, honoured here): the
// PM2 worker is ONE process, so a module-level in-flight Map keyed by
// connection id is sufficient — parallel jobs on the same connection await the
// SAME refresh promise instead of each burning a token-mint credit. No
// cross-process lock is needed because the job queue is FIFO per connection
// (queue.ts::claimChannelJobs) and there is one worker.
// ============================================================

// Reuse the cached access token until this close to expiry (minting costs credits).
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;
// Store the expiry a little EARLY so a clock skew never presents a dead token.
const TOKEN_EXPIRY_SAFETY_MS = 60_000;
// Beds24 documents expiresIn as 24h; used only when the field is absent/malformed.
const TOKEN_DEFAULT_TTL_S = 86_400;

/** The connection-row slice the resolver reads. Loaded by the caller — this
 *  module issues NO SELECT of its own, so the sync layer stays the single
 *  reader of channel_connections. */
export type Beds24TokenConnection = {
  id: string;
  /** the encrypted REFRESH token (long-life); NULL = never configured */
  api_key_ciphertext: string | null;
  /** 24h access-token cache (encrypted); NULL = no cache yet */
  access_token_ciphertext: string | null;
  /** postgres.js returns timestamptz as Date; a ::text load is also accepted */
  access_token_expires_at: Date | string | null;
};

export type Beds24AccessTokenResult =
  | { ok: true; token: string }
  | {
      ok: false;
      error: string;
      category: Beds24ApiErrorCategory | "not_configured" | "undecryptable";
    };

export type Beds24TokenDeps = {
  fetchImpl?: typeof fetch;
  /** injectable clock for expiry comparison ONLY */
  now?: () => number;
};

const expiryMs = (v: Date | string | null): number | null => {
  if (v === null) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

// ---- single-flight: one refresh per connection at a time (see header) ----
const inFlightByConnection = new Map<string, Promise<Beds24AccessTokenResult>>();

export async function getBeds24AccessToken(
  db: Sql,
  conn: Beds24TokenConnection,
  deps?: Beds24TokenDeps,
): Promise<Beds24AccessTokenResult> {
  const existing = inFlightByConnection.get(conn.id);
  if (existing) return existing;
  const flight = resolveToken(db, conn, deps).finally(() => {
    inFlightByConnection.delete(conn.id);
  });
  inFlightByConnection.set(conn.id, flight);
  return flight;
}

async function resolveToken(
  db: Sql,
  conn: Beds24TokenConnection,
  deps?: Beds24TokenDeps,
): Promise<Beds24AccessTokenResult> {
  const now = deps?.now ?? (() => Date.now());
  if (!channelSecretsConfigured())
    return {
      ok: false,
      error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת",
      category: "not_configured",
    };
  if (!conn.api_key_ciphertext)
    return {
      ok: false,
      error: "חיבור Beds24 לא הוגדר — הזן קוד הזמנה (invite code) תחילה",
      category: "not_configured",
    };

  // 1) cached token, still valid for >5 minutes → reuse (minting costs credits).
  const expiresAtMs = expiryMs(conn.access_token_expires_at);
  if (
    conn.access_token_ciphertext &&
    expiresAtMs !== null &&
    expiresAtMs - now() > TOKEN_REUSE_MARGIN_MS
  ) {
    try {
      return { ok: true, token: decryptSecret(conn.access_token_ciphertext) };
    } catch {
      // an undecryptable CACHE is recoverable — fall through and re-mint
    }
  }

  // 2) mint a fresh access token from the stored refresh token.
  let refreshToken: string;
  try {
    refreshToken = decryptSecret(conn.api_key_ciphertext);
  } catch {
    return {
      ok: false,
      error: "פענוח טוקן הרענון נכשל — ייתכן שמפתח ההצפנה בשרת השתנה",
      category: "undecryptable",
    };
  }

  const r = await beds24AuthRequest({
    baseUrl: beds24BaseUrl(), // §11 canonical routing — never a literal here
    path: "/authentication/token",
    authHeader: { name: "refreshToken", value: refreshToken },
    ...(deps?.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
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
  const expiresAt = new Date(now() + expiresInS * 1000 - TOKEN_EXPIRY_SAFETY_MS);

  // persist-then-return: a crash after this UPDATE never orphans the mint.
  await db`
    UPDATE guesthub.channel_connections
    SET access_token_ciphertext = ${encryptSecret(token)},
        access_token_expires_at = ${expiresAt},
        updated_at = now()
    WHERE id = ${conn.id}`;
  return { ok: true, token };
}
