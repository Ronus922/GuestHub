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
//    back. The ONLY headers ever surfaced are the numeric credit meter
//    (./beds24-credits) and Retry-After.
// ============================================================

import {
  parseRetryAfterMs,
  DEFAULT_TIMEOUT_MS,
  mapErrorStatus,
  rawEvidenceOf,
  type ChannelApiErrorCategory,
  type RawResponseEvidence,
} from "./channel-http";
import {
  readBeds24Credits,
  beds24ResetWaitMs,
  type Beds24CreditSnapshot,
} from "./beds24-credits";

// Same category union — the taxonomy is provider-neutral (D77 keeps one
// vocabulary so circuit-breaker / evidence / admin code reads one shape).
export type Beds24ApiErrorCategory = ChannelApiErrorCategory;

export type Beds24ApiFailure = {
  ok: false;
  category: Beds24ApiErrorCategory;
  message: string;
  httpStatus?: number;
  /** cooldown the provider asked for, in ms: 429 Retry-After, else the credit
   *  window's own resets-in (P0-4 — never absent on a 429) */
  retryAfterMs?: number;
  /** the credit meter the failing response carried, when it reached Beds24 */
  credits?: Beds24CreditSnapshot;
  /** D112 — what Beds24 actually said: verbatim status + raw body, captured
   *  BEFORE any parsing/mapping. httpStatus:null = no response arrived. */
  raw?: RawResponseEvidence;
};

// D112/C2 — the base texts carry NO status numbers. A fixed string standing in
// for a status is forbidden: the number shown to an operator is composed below
// from the httpStatus that actually arrived, and only when one arrived.
const CATEGORY_MESSAGE: Record<Beds24ApiErrorCategory, string> = {
  unauthorized: "האימות מול Beds24 נדחה — בדוק שקוד ההזמנה/הטוקן תקף ולא פג",
  forbidden: "הגישה נאסרה — לטוקן Beds24 אין הרשאה (scope) מתאימה",
  not_found: "הפריט לא נמצא — ייתכן שאינו נגיש לטוקן Beds24 זה",
  conflict: "התקבלה התנגשות — ייתכן שהפריט כבר קיים",
  validation: "הנתונים נדחו — יש להשלים או לתקן שדות חובה",
  rate_limited: "יותר מדי בקשות ל-Beds24 — מכסת הקרדיטים מוצתה, נסה שוב מאוחר יותר",
  server_error: "שגיאת שרת אצל Beds24 — נסה שוב מאוחר יותר",
  timeout: "הבקשה חרגה מהזמן המוקצב",
  network_error: "שגיאת רשת בחיבור ל-Beds24",
  bad_response: "התקבלה תשובה בלתי צפויה מ-Beds24",
};

export function beds24Fail(
  category: Beds24ApiErrorCategory,
  httpStatus?: number,
  raw?: RawResponseEvidence,
): Beds24ApiFailure {
  // the only number ever shown is the one that was actually received
  const suffix = httpStatus !== undefined ? ` (HTTP ${httpStatus})` : "";
  return {
    ok: false, category, message: `${CATEGORY_MESSAGE[category]}${suffix}`, httpStatus,
    ...(raw ? { raw } : {}),
  };
}

export { mapErrorStatus, parseRetryAfterMs, rawEvidenceOf };
export type { RawResponseEvidence };

// D112 — the body is read as TEXT first, so the verbatim evidence exists
// before (and regardless of) JSON parsing. A non-JSON error page yields
// body:undefined but its raw text survives on `raw`.
async function readBody(res: Response): Promise<{ text: string | null; json: unknown }> {
  let text: string | null = null;
  try {
    text = await res.text();
  } catch {
    return { text: null, json: undefined };
  }
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: undefined };
  }
}

// ---- Beds24 credit metering ------------------------------------------------
// Each call costs credits (minting a token costs extra). The credit meter is the
// ONE header group ever surfaced — bare numbers read off res.headers, never an
// echoed body. The wire NAMES and the pacing policy live in ./beds24-credits
// (measured, not guessed); what stays here is the *reading*.
//
// Two properties of the wire that this code must respect:
//  1. NOT every endpoint meters. GET /authentication/details returns none of
//     them. "Absent" is therefore a legitimate state and must stay
//     distinguishable from a measured value — never defaulted to 0, which would
//     read as "no credits left" / "this call was free".
//  2. Header names are matched case-insensitively ON BOTH SIDES. `Headers.get`
//     is already case-insensitive per the Fetch spec, but a substituted
//     fetchImpl may hand back a PLAIN OBJECT whose keys carry whatever casing
//     its author typed — and that object has no `.get` at all. Trusting either
//     side alone silently returns null and the meter reads as unmetered.
type HeaderBag = Headers | Record<string, string | string[] | undefined> | null | undefined;

/** Case-insensitive raw header read across Headers and plain-object bags. */
function readHeaderRaw(headers: HeaderBag, name: string): string | null {
  if (!headers) return null;
  let raw: string | string[] | undefined | null = null;
  const getter = (headers as Headers).get;
  if (typeof getter === "function") {
    raw = getter.call(headers, name); // spec-guaranteed case-insensitive
  }
  if (raw === null || raw === undefined) {
    // plain-object bag (test doubles): normalise the keys ourselves
    const wanted = name.toLowerCase();
    for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
      if (k.toLowerCase() === wanted) { raw = v; break; }
    }
  }
  if (raw === null || raw === undefined) return null;
  return String(Array.isArray(raw) ? raw[0] : raw);
}

/** One response's view of the credit window, through the single owner module. */
function readCreditSnapshot(headers: HeaderBag): Beds24CreditSnapshot {
  return readBeds24Credits((name) => readHeaderRaw(headers, name));
}

/** The metering values of one response, with the explicit not-measured flag.
 *  Owned by ./beds24-credits so the wire names live in exactly one place. */
export type Beds24CreditReading = Beds24CreditSnapshot;

export type Beds24Response = {
  status: number;
  body: unknown;
  retryAfterMs?: number;
  /** x-five-min-limit-remaining, when Beds24 sent it. Convenience mirror of
   *  `credits.remaining`, kept because callers that only pace on the counter
   *  should not have to reach through the whole snapshot. */
  creditsRemaining?: number;
  /** x-request-cost — what THIS call consumed, when Beds24 sent it */
  requestCost?: number;
  /** the 5-minute credit window as this response reported it, including the
   *  explicit `measured` flag. ALWAYS present: an unmetered endpoint yields a
   *  snapshot of nulls with measured:false, never a missing object. */
  credits: Beds24CreditSnapshot;
  /** D112 — verbatim status + raw body text of THIS response, captured before
   *  parsing. Always present on a response that arrived. */
  raw: RawResponseEvidence;
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
    // no response arrived — the evidence records exactly that (null status,
    // null body) with the UTC moment it was observed.
    return beds24Fail(aborted ? "timeout" : "network_error", undefined, rawEvidenceOf(null, null));
  } finally {
    clearTimeout(timer);
  }
  const { text, json: body } = await readBody(res);
  const raw = rawEvidenceOf(res.status, text);
  const credits = readCreditSnapshot(res.headers);
  // `?? undefined` keeps an ABSENT header absent on the wire object, so a
  // consumer can still tell "not measured" from a real number; `credits.measured`
  // states it explicitly for consumers that would otherwise coalesce to 0.
  const creditsRemaining = credits.remaining ?? undefined;
  const requestCost = credits.requestCost ?? undefined;
  if (res.status === 429) {
    // 429 is its OWN path (P0-4): the cooldown is Retry-After when Beds24 sends
    // one, otherwise the credit window's own resets-in. It is NEVER absent —
    // an absent cooldown is what turned a 429 into a blind retry.
    const retryAfterMs =
      parseRetryAfterMs(res.headers?.get?.("retry-after") ?? null) ??
      beds24ResetWaitMs(credits.resetsInSec);
    return { status: res.status, body, retryAfterMs, creditsRemaining, requestCost, credits, raw };
  }
  return { status: res.status, body, creditsRemaining, requestCost, credits, raw };
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
