// ============================================================
// Hospitable HTTP core — the ONE request path every Hospitable client uses
// (hospitable-properties.ts, hospitable-ari.ts, hospitable-booking-import.ts).
// Mirror of channex-http.ts (D77): same safety invariants, same error-category
// taxonomy, different auth scheme (Bearer PAT instead of user-api-key).
//
// Safety invariants (identical to channex-http.ts):
//  • Single attempt per call, no retries. Bounded by an AbortController timeout.
//    A write is NEVER blindly retried — an ambiguous result stays ambiguous.
//  • The PAT is NEVER placed in a returned message/category (messages are
//    fixed strings keyed only by category), so a leak is structurally impossible.
//  • The upstream body/headers/stack is parsed defensively and never echoed back.
// ============================================================

import {
  parseRetryAfterMs,
  DEFAULT_TIMEOUT_MS,
  mapErrorStatus,
  type ChannelApiErrorCategory,
} from "./channel-http";

// Same category union — the taxonomy is provider-neutral (D77 keeps one
// vocabulary so circuit-breaker / evidence / admin code reads one shape).
export type HospitableApiErrorCategory = ChannelApiErrorCategory;

export type HospitableApiFailure = {
  ok: false;
  category: HospitableApiErrorCategory;
  message: string;
  httpStatus?: number;
  /** cooldown the provider asked for (429 Retry-After), in ms, when present */
  retryAfterMs?: number;
};

const CATEGORY_MESSAGE: Record<HospitableApiErrorCategory, string> = {
  unauthorized: "טוקן ה-PAT נדחה (401) — בדוק שהטוקן תקף ולא פג",
  forbidden: "הגישה נאסרה (403) — לטוקן אין scope מתאים (read/write)",
  not_found: "הפריט לא נמצא (404) — ייתכן שאינו נגיש לטוקן זה",
  conflict: "התקבלה התנגשות (409) — ייתכן שהפריט כבר קיים",
  validation: "הנתונים נדחו (422) — יש להשלים או לתקן שדות חובה",
  rate_limited: "יותר מדי בקשות (429) — נסה שוב מאוחר יותר",
  server_error: "שגיאת שרת אצל Hospitable — נסה שוב מאוחר יותר",
  timeout: "הבקשה חרגה מהזמן המוקצב",
  network_error: "שגיאת רשת בחיבור ל-Hospitable",
  bad_response: "התקבלה תשובה בלתי צפויה מ-Hospitable",
};

export function hospitableFail(
  category: HospitableApiErrorCategory,
  httpStatus?: number,
): HospitableApiFailure {
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

export type HospitableReqOpts = {
  token: string;
  baseUrl: string; // from hospitableBaseUrl() — never a literal at the call site
  timeoutMs?: number;
  fetchImpl?: typeof fetch; // injectable for tests; defaults to global fetch
};

export async function hospitableRequest(
  opts: HospitableReqOpts & { method: string; path: string; body?: unknown },
): Promise<{ status: number; body: unknown; retryAfterMs?: number } | HospitableApiFailure> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
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
    return hospitableFail(aborted ? "timeout" : "network_error");
  } finally {
    clearTimeout(timer);
  }
  const body = await safeJson(res);
  if (res.status === 429) {
    const retryAfterMs = parseRetryAfterMs(res.headers?.get?.("retry-after") ?? null) ?? undefined;
    return { status: res.status, body, retryAfterMs };
  }
  return { status: res.status, body };
}
