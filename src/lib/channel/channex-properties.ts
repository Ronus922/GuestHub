// ============================================================
// Channex PROPERTIES client (D60) — server-side network calls for the
// property-mapping milestone: list accessible properties, read one, create a
// new one, update a profile. Requests go through the shared, leak-proof core in
// ./channex-http (single attempt, bounded timeout, fixed safe messages).
//
// SCOPE: this client touches /properties ONLY. It never calls room_types,
// rate_plans, webhooks, bookings, availability or restrictions —
// scripts/check-channex-properties.mjs asserts that at the source level.
//
// Only SAFE, whitelisted fields are ever surfaced; a raw upstream body, headers
// or the api-key can never reach a returned value.
// ============================================================

import {
  channexRequest,
  fail,
  mapErrorStatus,
  asObj,
  asStr,
  type ChannexApiFailure,
  type ChannexReqOpts,
} from "./channex-http";

export {
  mapErrorStatus,
  isAmbiguous,
  type ChannexApiErrorCategory,
  type ChannexApiFailure,
} from "./channex-http";

type ReqOpts = ChannexReqOpts;

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

// ---- pure body extractors (unit-checkable, never surface raw bodies) ----

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

// ---- operations ----
export async function listChannexProperties(
  opts: ReqOpts,
): Promise<{ ok: true; properties: ChannexPropertySummary[] } | ChannexApiFailure> {
  const r = await channexRequest({ ...opts, method: "GET", path: "/properties/options" });
  if ("ok" in r) return r;
  if (r.status !== 200) return fail(mapErrorStatus(r.status), r.status);
  return { ok: true, properties: extractPropertyOptions(r.body) };
}

export async function getChannexProperty(
  opts: ReqOpts & { id: string },
): Promise<{ ok: true; property: ChannexPropertyDetail } | ChannexApiFailure> {
  const r = await channexRequest({ ...opts, method: "GET", path: `/properties/${encodeURIComponent(opts.id)}` });
  if ("ok" in r) return r;
  if (r.status !== 200) return fail(mapErrorStatus(r.status), r.status);
  const property = extractPropertyDetail(r.body);
  if (!property) return fail("bad_response", 200);
  return { ok: true, property };
}

export async function createChannexProperty(
  opts: ReqOpts & { payload: Record<string, unknown> },
): Promise<{ ok: true; property: ChannexPropertyDetail } | ChannexApiFailure> {
  const r = await channexRequest({ ...opts, method: "POST", path: "/properties", body: opts.payload });
  if ("ok" in r) return r;
  if (r.status !== 200 && r.status !== 201) return fail(mapErrorStatus(r.status), r.status);
  const property = extractPropertyDetail(r.body);
  if (!property) return fail("bad_response", r.status);
  return { ok: true, property };
}

export async function updateChannexProperty(
  opts: ReqOpts & { id: string; payload: Record<string, unknown> },
): Promise<{ ok: true; property: ChannexPropertyDetail } | ChannexApiFailure> {
  const r = await channexRequest({
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
