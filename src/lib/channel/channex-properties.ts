// ============================================================
// Channex PROPERTIES client (D60) — server-side network calls for the
// property-mapping milestone: list accessible properties, read one, create a
// new one, update a profile. Same safety posture as connection-test.ts and,
// like it, deliberately OUTSIDE the pure provider boundary (provider.ts stays
// fetch-free). Invoked ONLY from super_admin server actions in admin.ts, which
// decrypt the key and pass it in — the key is never read from env/DB here.
//
// Safety invariants (identical to connection-test.ts):
//  • Single attempt per call, no retries. Bounded by an AbortController timeout.
//  • The api-key is NEVER placed in a returned message/category (fixed strings
//    keyed only by category) — a leak is structurally impossible.
//  • The upstream body is parsed defensively and only SAFE, whitelisted fields
//    are ever surfaced; a raw upstream body/headers/stack is never echoed.
// ============================================================

export type ChannexApiErrorCategory =
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

export type ChannexApiFailure = {
  ok: false;
  category: ChannexApiErrorCategory;
  message: string;
  httpStatus?: number;
};

// Safe, whitelisted external property snapshot. NO raw upstream body is kept.
export type ChannexPropertySummary = {
  id: string;
  title: string | null;
  currency: string | null;
};

export type ChannexPropertyDetail = ChannexPropertySummary & {
  country: string | null;
  city: string | null;
  address: string | null;
  zipCode: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  timezone: string | null;
  propertyType: string | null;
  latitude: string | null;
  longitude: string | null;
  isActive: boolean | null;
  roomTypeCount: number | null;
};

const DEFAULT_TIMEOUT_MS = 12_000;

const CATEGORY_MESSAGE: Record<ChannexApiErrorCategory, string> = {
  unauthorized: "מפתח ה-API נדחה (401) — בדוק שהמפתח נכון ושייך לסביבת Staging",
  forbidden: "הגישה נאסרה (403) — למפתח אין הרשאה לפעולה זו",
  not_found: "הנכס לא נמצא (404) — ייתכן שאינו נגיש למפתח זה",
  conflict: "התקבלה התנגשות (409) — ייתכן שהנכס כבר קיים",
  validation: "פרטי הנכס נדחו (422) — יש להשלים או לתקן שדות חובה",
  rate_limited: "יותר מדי בקשות (429) — נסה שוב מאוחר יותר",
  server_error: "שגיאת שרת אצל Channex — נסה שוב מאוחר יותר",
  timeout: "הבקשה חרגה מהזמן המוקצב",
  network_error: "שגיאת רשת בחיבור ל-Channex",
  bad_response: "התקבלה תשובה בלתי צפויה מ-Channex",
};

function fail(category: ChannexApiErrorCategory, httpStatus?: number): ChannexApiFailure {
  return { ok: false, category, message: CATEGORY_MESSAGE[category], httpStatus };
}

// Map a non-2xx status (or an unexpected 2xx) to a safe failure category.
export function mapErrorStatus(status: number): ChannexApiErrorCategory {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422) return "validation";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "bad_response";
}

// ---- pure body extractors (unit-checkable, never surface raw bodies) ----
type RawObj = Record<string, unknown>;
const asObj = (v: unknown): RawObj | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as RawObj) : null;
const asStr = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

// /properties/options returns { data: [{ id, title, ... }] } or a flat array of
// [title, id] pairs depending on account; handle the documented object form and
// the id/title object form, ignore anything else safely.
export function extractPropertyOptions(body: unknown): ChannexPropertySummary[] {
  const data = asObj(body)?.data ?? body;
  if (!Array.isArray(data)) return [];
  const out: ChannexPropertySummary[] = [];
  for (const item of data) {
    const o = asObj(item);
    if (!o) continue;
    const id = asStr(o.id) ?? asStr(asObj(o.attributes)?.id);
    if (!id) continue;
    const attrs = asObj(o.attributes) ?? o;
    out.push({
      id,
      title: asStr(attrs.title) ?? asStr(o.title),
      currency: asStr(attrs.currency) ?? asStr(o.currency),
    });
  }
  return out;
}

// GET/POST /properties → { data: { id, attributes: {...} } }
export function extractPropertyDetail(body: unknown): ChannexPropertyDetail | null {
  const data = asObj(asObj(body)?.data) ?? asObj(body);
  if (!data) return null;
  const id = asStr(data.id);
  if (!id) return null;
  const a = asObj(data.attributes) ?? data;
  const rtRaw = a.room_types_count ?? a.room_type_count;
  const active = a.is_active;
  const numAsStr = (v: unknown): string | null =>
    typeof v === "number" && Number.isFinite(v) ? String(v) : asStr(v);
  return {
    id,
    title: asStr(a.title),
    currency: asStr(a.currency),
    country: asStr(a.country),
    city: asStr(a.city),
    address: asStr(a.address),
    zipCode: asStr(a.zip_code),
    email: asStr(a.email),
    phone: asStr(a.phone),
    website: asStr(a.website),
    timezone: asStr(a.timezone),
    propertyType: asStr(a.property_type),
    latitude: numAsStr(a.latitude),
    longitude: numAsStr(a.longitude),
    isActive: typeof active === "boolean" ? active : null,
    roomTypeCount: typeof rtRaw === "number" ? rtRaw : null,
  };
}

// ---- request core ----
async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

type ReqOpts = {
  apiKey: string;
  baseUrl: string; // e.g. https://staging.channex.io/api/v1
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

async function request(
  opts: ReqOpts & { method: string; path: string; body?: unknown },
): Promise<{ status: number; body: unknown } | ChannexApiFailure> {
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
      // ponytail: single attempt — no retry loop. A write is never blindly retried.
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return fail(aborted ? "timeout" : "network_error");
  } finally {
    clearTimeout(timer);
  }
  const body = await safeJson(res);
  return { status: res.status, body };
}

// ---- operations ----
export async function listChannexProperties(
  opts: ReqOpts,
): Promise<{ ok: true; properties: ChannexPropertySummary[] } | ChannexApiFailure> {
  const r = await request({ ...opts, method: "GET", path: "/properties/options" });
  if ("ok" in r) return r;
  if (r.status !== 200) return fail(mapErrorStatus(r.status), r.status);
  return { ok: true, properties: extractPropertyOptions(r.body) };
}

export async function getChannexProperty(
  opts: ReqOpts & { id: string },
): Promise<{ ok: true; property: ChannexPropertyDetail } | ChannexApiFailure> {
  const r = await request({ ...opts, method: "GET", path: `/properties/${encodeURIComponent(opts.id)}` });
  if ("ok" in r) return r;
  if (r.status !== 200) return fail(mapErrorStatus(r.status), r.status);
  const property = extractPropertyDetail(r.body);
  if (!property) return fail("bad_response", 200);
  return { ok: true, property };
}

export async function createChannexProperty(
  opts: ReqOpts & { payload: Record<string, unknown> },
): Promise<{ ok: true; property: ChannexPropertyDetail } | ChannexApiFailure> {
  const r = await request({ ...opts, method: "POST", path: "/properties", body: opts.payload });
  if ("ok" in r) return r;
  if (r.status !== 200 && r.status !== 201) return fail(mapErrorStatus(r.status), r.status);
  const property = extractPropertyDetail(r.body);
  if (!property) return fail("bad_response", r.status);
  return { ok: true, property };
}

export async function updateChannexProperty(
  opts: ReqOpts & { id: string; payload: Record<string, unknown> },
): Promise<{ ok: true; property: ChannexPropertyDetail } | ChannexApiFailure> {
  const r = await request({
    ...opts,
    method: "PUT",
    path: `/properties/${encodeURIComponent(opts.id)}`,
    body: opts.payload,
  });
  if ("ok" in r) return r;
  if (r.status !== 200) return fail(mapErrorStatus(r.status), r.status);
  const property = extractPropertyDetail(r.body);
  if (!property) return fail("bad_response", 200);
  return { ok: true, property };
}
