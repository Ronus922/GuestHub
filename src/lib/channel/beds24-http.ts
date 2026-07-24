// ============================================================
// Beds24 HTTP core — the ONE request path every Beds24 client uses
// (beds24-properties.ts, beds24-admin.ts) (D77 → D78). Standard safety
// invariants and error-category taxonomy, with the Beds24 auth
// scheme — Beds24 API v2 authenticates with a `token` header (NOT Bearer), and
// the two /authentication endpoints use dedicated headers instead:
//   • GET /authentication/setup  — header `code: <inviteCode>`  (one-time)
//   • GET /authentication/token  — header `refreshToken: <refreshToken>`
//
// Safety invariants:
//  • Single attempt per call, no retries. Bounded by an AbortController timeout.
//    A write is NEVER blindly retried — an ambiguous result stays ambiguous.
//  • The token/inviteCode/refreshToken is NEVER placed in a returned message or
//    category (messages are fixed strings keyed only by category), so a leak is
//    structurally impossible.
//  • The upstream body/headers/stack is parsed defensively and never echoed
//    back. The ONLY header ever surfaced is the numeric credit-limit counter.
// ============================================================

import {
  parseRetryAfterMs,
  DEFAULT_TIMEOUT_MS,
  mapErrorStatus,
  type ChannelApiErrorCategory,
} from "./channel-http";

// Same category union — the taxonomy is provider-neutral (D77 keeps one
// vocabulary so circuit-breaker / evidence / admin code reads one shape).
export type Beds24ApiErrorCategory = ChannelApiErrorCategory;

export type Beds24ApiFailure = {
  ok: false;
  category: Beds24ApiErrorCategory;
  message: string;
  httpStatus?: number;
  /** cooldown the provider asked for (429 Retry-After), in ms, when present */
  retryAfterMs?: number;
};

const CATEGORY_MESSAGE: Record<Beds24ApiErrorCategory, string> = {
  unauthorized: "האימות מול Beds24 נדחה (401) — בדוק שקוד ההזמנה/הטוקן תקף ולא פג",
  forbidden: "הגישה נאסרה (403) — לטוקן Beds24 אין הרשאה (scope) מתאימה",
  not_found: "הפריט לא נמצא (404) — ייתכן שאינו נגיש לטוקן Beds24 זה",
  conflict: "התקבלה התנגשות (409) — ייתכן שהפריט כבר קיים",
  validation: "הנתונים נדחו (422) — יש להשלים או לתקן שדות חובה",
  rate_limited: "יותר מדי בקשות ל-Beds24 (429) — מכסת הקרדיטים מוצתה, נסה שוב מאוחר יותר",
  server_error: "שגיאת שרת אצל Beds24 — נסה שוב מאוחר יותר",
  timeout: "הבקשה חרגה מהזמן המוקצב",
  network_error: "שגיאת רשת בחיבור ל-Beds24",
  bad_response: "התקבלה תשובה בלתי צפויה מ-Beds24",
};

export function beds24Fail(
  category: Beds24ApiErrorCategory,
  httpStatus?: number,
): Beds24ApiFailure {
  return { ok: false, category, message: CATEGORY_MESSAGE[category], httpStatus };
}

export { mapErrorStatus, parseRetryAfterMs };

// Read the body as JSON without ever throwing.
async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

// Beds24 credit metering (each call costs credits; minting a token costs
// extra). The remaining 5-minute-window credit counter is the ONE header value
// ever surfaced — a bare number read via res.headers, never an echoed body.
function readCreditsRemaining(headers: Headers): number | null {
  const raw = headers?.get?.("x-fivemincreditlimit-remaining") ?? null;
  if (raw === null) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

export type Beds24Response = {
  status: number;
  body: unknown;
  retryAfterMs?: number;
  /** X-FiveMinCreditLimit-Remaining, when Beds24 sent it */
  creditsRemaining?: number;
};

export type Beds24ReqOpts = {
  token: string; // a short-lived ACCESS token (24h), never the refresh token
  baseUrl: string; // from beds24BaseUrl() — never a literal at the call site
  timeoutMs?: number;
  fetchImpl?: typeof fetch; // injectable for tests; defaults to global fetch
};

// Shared fetch core for both the `token`-authenticated calls and the two
// /authentication endpoints — the no-leak/no-retry invariants exist ONCE.
async function beds24Fetch(opts: {
  baseUrl: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<Beds24Response | Beds24ApiFailure> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetchImpl(`${opts.baseUrl}${opts.path}`, {
      method: opts.method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
      // ponytail: single attempt — no retry loop, by design (see header).
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return beds24Fail(aborted ? "timeout" : "network_error");
  } finally {
    clearTimeout(timer);
  }
  const body = await safeJson(res);
  const creditsRemaining = readCreditsRemaining(res.headers) ?? undefined;
  if (res.status === 429) {
    const retryAfterMs = parseRetryAfterMs(res.headers?.get?.("retry-after") ?? null) ?? undefined;
    return { status: res.status, body, retryAfterMs, creditsRemaining };
  }
  return { status: res.status, body, creditsRemaining };
}

// Regular API call — header `token: <accessToken>` (Beds24's scheme; NOT Bearer).
export async function beds24Request(
  opts: Beds24ReqOpts & { method: string; path: string; body?: unknown },
): Promise<Beds24Response | Beds24ApiFailure> {
  return beds24Fetch({
    baseUrl: opts.baseUrl,
    method: opts.method,
    path: opts.path,
    headers: { token: opts.token },
    body: opts.body,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });
}

// The two auth endpoints — read-only GETs that carry the credential in a
// DEDICATED header (`code` for the one-time invite-code exchange,
// `refreshToken` for minting a fresh 24h access token). Minting costs credits:
// callers must reuse a cached access token until it nears expiry.
export async function beds24AuthRequest(opts: {
  baseUrl: string;
  path: "/authentication/setup" | "/authentication/token";
  authHeader: { name: "code" | "refreshToken"; value: string };
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<Beds24Response | Beds24ApiFailure> {
  return beds24Fetch({
    baseUrl: opts.baseUrl,
    method: "GET",
    path: opts.path,
    headers: { [opts.authHeader.name]: opts.authHeader.value },
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });
}
