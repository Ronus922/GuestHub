// ============================================================
// Channex connection test (D59) — the FIRST and ONLY real network call in the
// channel manager. A single GET /api/v1/properties/options with the operator's
// user-api-key, used to prove a Staging credential works. Deliberately NOT part
// of the pure provider boundary (src/lib/channel/provider.ts stays fetch-free);
// this helper is invoked ONLY from the super_admin server action in admin.ts,
// which decrypts the key and passes it in — the key is never read from env or
// the DB here.
//
// Safety invariants:
//  • Single attempt, no retries. Bounded by an AbortController timeout.
//  • The api-key is NEVER placed in a returned message/category (messages are
//    fixed strings keyed only by category), so a leak is structurally impossible.
//  • The upstream body is parsed defensively and never echoed back.
// ============================================================

export type ChannexErrorCategory =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "network_error"
  | "bad_response";

export type ChannexTestResult =
  | { ok: true; propertyCount: number }
  | { ok: false; category: ChannexErrorCategory; message: string; httpStatus?: number };

const DEFAULT_TIMEOUT_MS = 10_000;

// Fixed, safe Hebrew messages per category. Nothing from the upstream response
// (body, headers, the key) ever reaches these strings.
const CATEGORY_MESSAGE: Record<ChannexErrorCategory, string> = {
  unauthorized: "מפתח ה-API נדחה (401) — בדוק שהמפתח נכון ושייך לסביבת Staging",
  forbidden: "הגישה נאסרה (403) — למפתח אין הרשאה לפעולה זו",
  not_found: "הנתיב לא נמצא (404) — כתובת ה-API אינה תקינה",
  rate_limited: "יותר מדי בקשות (429) — נסה שוב מאוחר יותר",
  server_error: "שגיאת שרת אצל Channex — נסה שוב מאוחר יותר",
  timeout: "בקשת הבדיקה חרגה מהזמן המוקצב",
  network_error: "שגיאת רשת בחיבור ל-Channex",
  bad_response: "התקבלה תשובה בלתי צפויה מ-Channex",
};

function fail(category: ChannexErrorCategory, httpStatus?: number): ChannexTestResult {
  return { ok: false, category, message: CATEGORY_MESSAGE[category], httpStatus };
}

// Pure mapping from an HTTP status + already-parsed body to a safe result.
// Exported so it can be unit-checked without a live socket.
export function interpretChannexResponse(status: number, body: unknown): ChannexTestResult {
  if (status === 200) {
    // Expected shape: { data: [...] }. An empty array is a valid, connected
    // account. Anything else is treated as an unexpected response, not a crash.
    const data = (body as { data?: unknown } | null | undefined)?.data;
    if (!Array.isArray(data)) return fail("bad_response", 200);
    return { ok: true, propertyCount: data.length };
  }
  if (status === 401) return fail("unauthorized", 401);
  if (status === 403) return fail("forbidden", 403);
  if (status === 404) return fail("not_found", 404);
  if (status === 429) return fail("rate_limited", 429);
  if (status >= 500) return fail("server_error", status);
  return fail("bad_response", status);
}

// Read the body as JSON without ever throwing (a non-JSON error page must not
// crash the test — it becomes a bad_response / mapped status instead).
async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

export async function runChannexConnectionTest(opts: {
  apiKey: string;
  baseUrl: string; // e.g. https://staging.channex.io/api/v1
  timeoutMs?: number;
  fetchImpl?: typeof fetch; // injectable for tests; defaults to global fetch
}): Promise<ChannexTestResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchImpl(`${opts.baseUrl}/properties/options`, {
      method: "GET",
      headers: { "user-api-key": opts.apiKey, Accept: "application/json" },
      signal: controller.signal,
      // ponytail: single attempt — no retry loop. The operator re-clicks "Test".
    });
  } catch (e) {
    // AbortError ⇒ timeout; anything else ⇒ network failure. Never surface `e`.
    const aborted = e instanceof Error && e.name === "AbortError";
    return fail(aborted ? "timeout" : "network_error");
  } finally {
    clearTimeout(timer);
  }

  const body = res.status === 200 ? await safeJson(res) : undefined;
  return interpretChannexResponse(res.status, body);
}
