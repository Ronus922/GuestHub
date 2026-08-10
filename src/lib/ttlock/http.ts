import { createHash } from "node:crypto";

// ============================================================
// TTLock Open Platform HTTP layer (D122) — WORKER-GRAPH-SAFE.
//
// Nothing here may import "server-only", next/…, react, or a "use server"
// module. The later worker task compiles its graph through
// tsconfig.worker.json (plain CommonJS, no React condition), and this file has
// to survive that compile unchanged. This is the same split that forced
// beds24-token.ts to exist apart from beds24-admin.ts — obeyed here from the
// start so no refactor is owed later. Enforced by
// scripts/check-ttlock-secrets.mjs rule 2.
//
// THE FOUR THINGS THIS API DOES DIFFERENTLY FROM EVERY OTHER ONE WE TALK TO:
//
//  1. EVERY endpoint is POST with application/x-www-form-urlencoded — INCLUDING
//     reads. /v3/lock/list is a POST. There is no JSON request body anywhere.
//  2. The account password travels as a LOWERCASE HEX MD5 of the plaintext,
//     never the plaintext. (MD5 is TTLock's wire format, not our choice and not
//     a security claim — the plaintext is what we protect, with AES-256-GCM at
//     rest in crypto.ts.)
//  3. Authenticated calls carry clientId + accessToken + date, where date is a
//     13-digit epoch MILLISECOND stamp. A seconds-precision stamp is rejected.
//  4. TTLock ANSWERS 200 OK ON FAILURE. res.ok proves nothing. The real status
//     is `errcode` in the JSON body: 0 or absent means success, anything else
//     is a failure and MUST throw. Any code here that trusted the HTTP status
//     would report a broken connection as working.
// ============================================================

export type TTLockRegion = "eu" | "global";

// An application registered on euopen.ttlock.com does not exist for
// api.ttlock.com and vice versa. Getting this wrong yields errcode 10001,
// which is indistinguishable from a wrong clientSecret — hence a stored,
// operator-selectable column rather than a constant. See migration 069.
const BASE_URL: Record<TTLockRegion, string> = {
  eu: "https://euapi.ttlock.com",
  global: "https://api.ttlock.com",
};

export function ttlockBaseUrl(region: TTLockRegion): string {
  return BASE_URL[region] ?? BASE_URL.eu;
}

const TIMEOUT_MS = 20_000;

// TTLock's wire format for the account password (see header note 2).
export function md5Hex(plaintext: string): string {
  return createHash("md5").update(plaintext, "utf8").digest("hex").toLowerCase();
}

// 13-digit epoch ms. TTLock rejects a seconds-precision stamp outright.
export function ttlockDate(): string {
  return String(Date.now());
}

export class TTLockError extends Error {
  readonly errcode: number;
  readonly errmsg: string;
  readonly endpoint: string;

  constructor(endpoint: string, errcode: number, errmsg: string) {
    // The MESSAGE is for our logs and is deliberately code-only. errmsg is
    // Chinese and is kept as a field for debugging, never interpolated into
    // anything an operator or a log line will read.
    super(`TTLock ${endpoint} failed with errcode ${errcode}`);
    this.name = "TTLockError";
    this.endpoint = endpoint;
    this.errcode = errcode;
    this.errmsg = errmsg;
  }

  // Token rejected / expired. Worth exactly ONE retry after a forced refresh —
  // more than one turns an authentication failure into a mint loop.
  get isAuthError(): boolean {
    return this.errcode === 10003;
  }

  // 10001 "invalid client": the clientId/clientSecret pair or the REGION is
  // wrong. This fires BEFORE TTLock ever looks at the account, so it must
  // never be reported to the operator as a password problem — they would
  // rotate a perfectly good password and still be broken. See hebrewMessageFor.
  get isClientError(): boolean {
    return this.errcode === 10001;
  }
}

/** errcodes that mean "the API-call quota is exhausted". 30007 ("exceeded the
 *  monthly limit for API calls") was measured from production on 2026-08-10,
 *  after the 5-minute poll burned the MONTHLY budget in eight days. Drives the
 *  quota wording here, the /locks amber banner, and the circuit breaker's
 *  immediate-open path in passcodes.ts. */
export const TTLOCK_QUOTA_ERRCODES: ReadonlySet<number> = new Set([30007]);

// Operator-facing Hebrew. The upstream errmsg is NEVER echoed — it is Chinese,
// and for 10001 it is actively misleading about which half is wrong.
export function hebrewMessageFor(errcode: number): string {
  if (TTLOCK_QUOTA_ERRCODES.has(errcode)) {
    return "מכסת הקריאות החודשית של TTLock מוצתה — נסו לסנכרן שוב מאוחר יותר";
  }
  switch (errcode) {
    case 10001:
      return "מזהה האפליקציה או הסוד שגויים, או שהאפליקציה רשומה באזור אחר";
    case 10003:
      return "הטוקן פג תוקף";
    default:
      return `שגיאה מ-TTLock (קוד ${errcode})`;
  }
}

function parseErrcode(body: unknown): { errcode: number; errmsg: string } {
  const obj = (body ?? {}) as Record<string, unknown>;
  const raw = obj.errcode;
  // absent === success. TTLock omits errcode entirely on some successful reads.
  const errcode = typeof raw === "number" ? raw : raw === undefined || raw === null ? 0 : Number(raw);
  const errmsg = typeof obj.errmsg === "string" ? obj.errmsg : "";
  return { errcode: Number.isFinite(errcode) ? errcode : -1, errmsg };
}

/**
 * The single request primitive. POST + form-encoding + 20s timeout + the
 * errcode-not-HTTP-status rule, in one place so no caller can forget one.
 * Throws TTLockError on any non-zero errcode.
 */
export async function ttlockRequest(
  region: TTLockRegion,
  endpoint: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = `${ttlockBaseUrl(region)}${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  // A non-200 IS still a real failure (gateway, rate limiter) — it just is not
  // the only kind. Body text is not surfaced: it is not ours to show.
  if (!res.ok) {
    throw new TTLockError(endpoint, -1, `HTTP ${res.status}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new TTLockError(endpoint, -1, "non-JSON response");
  }

  const { errcode, errmsg } = parseErrcode(body);
  if (errcode !== 0) throw new TTLockError(endpoint, errcode, errmsg);

  return (body ?? {}) as Record<string, unknown>;
}

/**
 * An authenticated call: adds clientId + accessToken + date to the form.
 * The token is a parameter, never a module-level value — it exists only for
 * the duration of the call.
 */
export async function ttlockAuthedRequest(
  region: TTLockRegion,
  endpoint: string,
  auth: { clientId: string; accessToken: string },
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  return ttlockRequest(region, endpoint, {
    clientId: auth.clientId,
    accessToken: auth.accessToken,
    date: ttlockDate(),
    ...params,
  });
}
