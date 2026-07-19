// ============================================================
// Hospitable PROPERTIES client (D77) — server-side network calls for the
// room ↔ Hospitable-property mapping milestone: list accessible properties
// (paginated), read one. Requests go through the shared, leak-proof core in
// ./hospitable-http (single attempt, bounded timeout, fixed safe messages).
//
// SCOPE: this client touches /properties ONLY — read-only GETs. It never calls
// calendar, reservations, messages or webhooks, and it NEVER issues a write.
//
// Only SAFE, whitelisted fields are ever surfaced; a raw upstream body, headers
// or the PAT can never reach a returned value. Mirror of channex-properties.ts.
// ============================================================

import {
  hospitableRequest,
  hospitableFail,
  mapErrorStatus,
  type HospitableApiFailure,
  type HospitableReqOpts,
} from "./hospitable-http";
import { asObj, asStr, asInt } from "./channex-http";

export { mapErrorStatus, type HospitableApiFailure } from "./hospitable-http";

type ReqOpts = HospitableReqOpts;

// Safe, whitelisted external property snapshot. NO raw upstream body is kept.
export type HospitablePropertySummary = {
  /** the Hospitable property UUID */
  id: string;
  name: string | null;
  publicName: string | null;
  currency: string | null;
  timezone: string | null;
  /** Hospitable flag: calendar pushes are rejected upstream while true */
  calendarRestricted: boolean;
  /** listed/visible on the connected channels; null when absent from the body */
  listed: boolean | null;
  /** street + number + apt + city, best-effort — the operator's ONLY way to
   *  tell apart same-named units in one building */
  addressLine: string | null;
  /** main photo URL — the practical way to tell same-named units apart */
  pictureUrl: string | null;
  /** bedrooms / max guests, when present */
  bedrooms: number | null;
  maxGuests: number | null;
  /** host-defined tags — hosts often tag units with their apartment number */
  tags: string[];
};

// Hospitable caps per_page at 100; MAX_PAGES bounds the loop so a malformed
// meta block can never make it spin forever.
export const HOSPITABLE_PROPERTIES_PER_PAGE = 100;
const MAX_PAGES = 50;

// ---- pure body extractors (unit-checkable, never surface raw bodies) ----

const asBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

// address → one display line. Field names probed defensively (street/number/
// apt/city appear across Hospitable payload variants); empty → null.
export function extractAddressLine(v: unknown): string | null {
  const a = asObj(v);
  if (!a) return null;
  const parts = [
    asStr(a.street),
    asStr(a.number) ?? (typeof a.number === "number" ? String(a.number) : null),
    asStr(a.apt) ?? asStr(a.apartment) ?? asStr(a.unit),
    asStr(a.city),
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// One property object → safe summary. Accepts both `id` (documented) and `uuid`
// defensively; ignores anything unrecognisable.
export function extractHospitableProperty(item: unknown): HospitablePropertySummary | null {
  const o = asObj(item);
  if (!o) return null;
  const id = asStr(o.id) ?? asStr(o.uuid);
  if (!id) return null;
  return {
    id,
    name: asStr(o.name),
    publicName: asStr(o.public_name) ?? asStr(o.publicName),
    currency: asStr(o.currency),
    timezone: asStr(o.timezone) ?? asStr(o.time_zone),
    calendarRestricted: asBool(o.calendar_restricted) ?? false,
    listed: asBool(o.listed),
    addressLine: extractAddressLine(o.address),
    pictureUrl: asStr(o.picture) ?? asStr(asObj(o.picture)?.url) ?? null,
    bedrooms: asInt(asObj(o.capacity)?.bedrooms),
    maxGuests: asInt(asObj(o.capacity)?.max),
    tags: Array.isArray(o.tags)
      ? o.tags.map((t) => asStr(t)).filter((t): t is string => t !== null)
      : [],
  };
}

// GET /properties → { data: [...], meta: { current_page, last_page, ... } }.
// last_page is read defensively: null when absent/malformed, and the caller
// falls back to "stop when a short page arrives".
export function extractHospitablePropertyList(body: unknown): {
  properties: HospitablePropertySummary[];
  lastPage: number | null;
  total: number | null;
} {
  const root = asObj(body);
  const data = root?.data ?? body;
  const properties: HospitablePropertySummary[] = [];
  if (Array.isArray(data)) {
    for (const item of data) {
      const p = extractHospitableProperty(item);
      if (p) properties.push(p);
    }
  }
  const meta = asObj(root?.meta);
  return {
    properties,
    lastPage: asInt(meta?.last_page),
    total: asInt(meta?.total),
  };
}

// GET /properties/{uuid} → { data: {...} } (or a flat object, defensively).
export function extractHospitablePropertyDetail(body: unknown): HospitablePropertySummary | null {
  const root = asObj(body);
  return extractHospitableProperty(root?.data ?? body);
}

// ---- operations (read-only GETs; a write is never issued from here) ----

// List ALL accessible properties, walking page/per_page pagination to the end.
// Any non-200 page aborts the whole listing with a safe failure — a partial
// list is never presented as complete.
export async function listHospitableProperties(
  opts: ReqOpts,
): Promise<{ ok: true; properties: HospitablePropertySummary[] } | HospitableApiFailure> {
  const all: HospitablePropertySummary[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await hospitableRequest({
      ...opts,
      method: "GET",
      path: `/properties?page=${page}&per_page=${HOSPITABLE_PROPERTIES_PER_PAGE}`,
    });
    if ("ok" in r) return r;
    if (r.status !== 200) return hospitableFail(mapErrorStatus(r.status), r.status);
    const { properties, lastPage } = extractHospitablePropertyList(r.body);
    all.push(...properties);
    const done =
      lastPage !== null ? page >= lastPage : properties.length < HOSPITABLE_PROPERTIES_PER_PAGE;
    if (done) break;
  }
  return { ok: true, properties: all };
}

export async function getHospitableProperty(
  opts: ReqOpts & { id: string },
): Promise<{ ok: true; property: HospitablePropertySummary } | HospitableApiFailure> {
  const r = await hospitableRequest({
    ...opts,
    method: "GET",
    path: `/properties/${encodeURIComponent(opts.id)}`,
  });
  if ("ok" in r) return r;
  if (r.status !== 200) return hospitableFail(mapErrorStatus(r.status), r.status);
  const property = extractHospitablePropertyDetail(r.body);
  if (!property) return hospitableFail("bad_response", 200);
  return { ok: true, property };
}
