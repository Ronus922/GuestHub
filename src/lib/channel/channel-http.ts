// ============================================================
// Channel-provider HTTP core — the ONE request path every channel API client
// uses (beds24-http.ts, beds24-token.ts et al). Extracted so the no-leak
// guarantees below exist once, not once per client. Deliberately OUTSIDE the
// pure provider boundary (src/lib/channel/provider.ts stays fetch-free); these
// helpers are invoked ONLY from super_admin server actions, which decrypt the
// key and pass it in — the key is never read from env or the DB here.
//
// Safety invariants:
//  • Single attempt per call, no retries. Bounded by an AbortController timeout.
//    A write is NEVER blindly retried — an ambiguous result stays ambiguous.
//  • The api-key is NEVER placed in a returned message/category (messages are
//    fixed strings keyed only by category), so a leak is structurally impossible.
//  • The upstream body/headers/stack is parsed defensively and never echoed back.
// ============================================================

export type ChannelApiErrorCategory =
  | "unauthorized" // 401
  | "forbidden" // 403
  | "not_found" // 404
  | "conflict" // 409
  | "validation" // 422
  | "rate_limited" // 429
  | "server_error" // 5xx
  | "timeout"
  | "network_error"
  | "bad_response";

export type ChannelApiFailure = {
  ok: false;
  category: ChannelApiErrorCategory;
  message: string;
  httpStatus?: number;
  /** §16 — cooldown the provider asked for (429 Retry-After), in ms, when present */
  retryAfterMs?: number;
};

// Parse a Retry-After header: either delta-seconds ("120") or an HTTP-date.
// Returns ms, or null when absent/unparseable. `now` is injectable for tests.
export function parseRetryAfterMs(headerValue: string | null, now: number = Date.now()): number | null {
  if (!headerValue) return null;
  const secs = Number(headerValue.trim());
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const when = Date.parse(headerValue);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - now);
}

export const DEFAULT_TIMEOUT_MS = 12_000;

const CATEGORY_MESSAGE: Record<ChannelApiErrorCategory, string> = {
  unauthorized: "מפתח ה-API נדחה (401) — בדוק שהמפתח נכון ושייך לסביבת Staging",
  forbidden: "הגישה נאסרה (403) — למפתח אין הרשאה לפעולה זו",
  not_found: "הפריט לא נמצא (404) — ייתכן שאינו נגיש למפתח זה",
  conflict: "התקבלה התנגשות (409) — ייתכן שהפריט כבר קיים",
  validation: "הנתונים נדחו (422) — יש להשלים או לתקן שדות חובה",
  rate_limited: "יותר מדי בקשות (429) — נסה שוב מאוחר יותר",
  server_error: "שגיאת שרת אצל ספק הערוצים — נסה שוב מאוחר יותר",
  timeout: "הבקשה חרגה מהזמן המוקצב",
  network_error: "שגיאת רשת בחיבור לספק הערוצים",
  bad_response: "התקבלה תשובה בלתי צפויה מספק הערוצים",
};

export function fail(category: ChannelApiErrorCategory, httpStatus?: number): ChannelApiFailure {
  return { ok: false, category, message: CATEGORY_MESSAGE[category], httpStatus };
}

// Map a non-2xx status (or an unexpected 2xx) to a safe failure category.
export function mapErrorStatus(status: number): ChannelApiErrorCategory {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422) return "validation";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "bad_response";
}

// An AMBIGUOUS failure leaves the external state unknown: the request may or may
// not have been applied upstream. Such a write must never be blindly re-issued —
// the caller must re-read the external collection and reconcile explicitly.
export function isAmbiguous(category: ChannelApiErrorCategory): boolean {
  return (
    category === "timeout" ||
    category === "network_error" ||
    category === "server_error" ||
    category === "bad_response"
  );
}

// ---- defensive body parsing ----
export type RawObj = Record<string, unknown>;
export const asObj = (v: unknown): RawObj | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as RawObj) : null;
export const asStr = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;
export const asInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) ? v : null;

// Read the body as JSON without ever throwing (a non-JSON error page must not
// crash the call — it becomes a bad_response / mapped status instead).
async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

export type ChannelReqOpts = {
  apiKey: string;
  baseUrl: string; // the provider API base URL
  timeoutMs?: number;
  fetchImpl?: typeof fetch; // injectable for tests; defaults to global fetch
};

export async function channelRequest(
  opts: ChannelReqOpts & { method: string; path: string; body?: unknown },
): Promise<{ status: number; body: unknown; retryAfterMs?: number } | ChannelApiFailure> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const headers: Record<string, string> = {
    "user-api-key": opts.apiKey,
    Accept: "application/json",
  };
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
    return fail(aborted ? "timeout" : "network_error");
  } finally {
    clearTimeout(timer);
  }
  const body = await safeJson(res);
  // §16 — surface the provider's requested cooldown on a 429 so the caller can
  // open the circuit for exactly that long instead of guessing.
  if (res.status === 429) {
    const retryAfterMs = parseRetryAfterMs(res.headers?.get?.("retry-after") ?? null) ?? undefined;
    return { status: res.status, body, retryAfterMs };
  }
  return { status: res.status, body };
}
