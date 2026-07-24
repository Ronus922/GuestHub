// ============================================================
// Channex RATE PLANS client (D65) — server-side network calls for the
// (physical room × local rate plan) → Channex Rate Plan synchronization.
// Requests go through the shared, leak-proof core in ./channel-http (single
// attempt, bounded timeout, fixed safe messages, api-key never echoed).
//
// SCOPE: this client touches /rate_plans ONLY, and only with GET, POST and PUT
// (PUT strictly for renaming an EXISTING mapped plan after a local plan rename
// — never a partial body, always the full echoed field set). It never calls
// DELETE, and never availability / restrictions / webhooks / bookings /
// properties / room_types — scripts/check-channex-rate-plans.mjs asserts that
// at the source level.
//
// API contract (docs.channex.io/api-v.1-documentation/rate-plans-collection):
//   LIST   GET  /rate_plans?filter[property_id]=<uuid>&pagination[page]=N&pagination[limit]=100
//          → { data: [{ type, id, attributes, relationships }], meta: { total } }
//   GET    GET  /rate_plans/:id            → { data: { id, attributes, relationships } }
//   CREATE POST /rate_plans     body { rate_plan: {...} } → 201 { data: { id, attributes } }
//   UPDATE PUT  /rate_plans/:id body { rate_plan: {...} } → 200; same fields as Create
// ============================================================

import {
  channelRequest,
  fail,
  mapErrorStatus,
  asObj,
  asStr,
  asInt,
  type ChannelApiFailure,
  type ChannelReqOpts,
} from "./channel-http";

type ReqOpts = ChannelReqOpts;

// Safe, whitelisted external rate-plan snapshot. NO raw upstream body is kept.
export type ChannexRatePlanOption = {
  occupancy: number | null;
  isPrimary: boolean;
  rate: number | null;
};

export type ChannexRatePlan = {
  id: string;
  title: string | null;
  sellMode: string | null;
  rateMode: string | null;
  currency: string | null;
  options: ChannexRatePlanOption[];
  propertyId: string | null;
  roomTypeId: string | null;
};

export const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

// ---- pure extractors ----
function extractOptions(node: unknown): ChannexRatePlanOption[] {
  if (!Array.isArray(node)) return [];
  const out: ChannexRatePlanOption[] = [];
  for (const item of node) {
    const o = asObj(item);
    if (!o) continue;
    out.push({
      occupancy: asInt(o.occupancy),
      isPrimary: o.is_primary === true,
      rate: asInt(o.rate),
    });
  }
  return out;
}

function relId(o: Record<string, unknown> | null, key: string): string | null {
  return asStr(asObj(asObj(asObj(o?.[key]))?.data)?.id);
}

function extractOne(node: unknown): ChannexRatePlan | null {
  const o = asObj(node);
  if (!o) return null;
  const a = asObj(o.attributes) ?? o;
  const id = asStr(o.id) ?? asStr(a.id);
  if (!id) return null;
  // JSON:API: a single GET carries property/room-type ids ONLY under
  // relationships.<name>.data.id (attributes may omit them) — same lesson as D64.
  const rel = asObj(o.relationships);
  return {
    id,
    title: asStr(a.title),
    sellMode: asStr(a.sell_mode),
    rateMode: asStr(a.rate_mode),
    currency: asStr(a.currency),
    options: extractOptions(a.options),
    propertyId: asStr(a.property_id) ?? relId(rel, "property"),
    roomTypeId: asStr(a.room_type_id) ?? relId(rel, "room_type"),
  };
}

export function extractRatePlanDetail(body: unknown): ChannexRatePlan | null {
  return extractOne(asObj(asObj(body)?.data) ?? asObj(body));
}

export function extractRatePlanList(body: unknown): ChannexRatePlan[] {
  const data = asObj(body)?.data ?? body;
  if (!Array.isArray(data)) return [];
  const out: ChannexRatePlan[] = [];
  for (const item of data) {
    const rp = extractOne(item);
    if (rp) out.push(rp);
  }
  return out;
}

export function extractTotal(body: unknown): number | null {
  return asInt(asObj(asObj(body)?.meta)?.total);
}

// ---- operations ----

// List EVERY rate plan of ONE property, following pagination. Same three-way
// truncation logic as listChannexRoomTypes (D64): provably complete via
// meta.total, short page trusted only when total does not contradict it, and a
// full page that adds nothing new means the server ignores the page param.
export async function listChannexRatePlans(
  opts: ReqOpts & { propertyId: string },
): Promise<{ ok: true; ratePlans: ChannexRatePlan[]; truncated: boolean } | ChannelApiFailure> {
  const seen = new Map<string, ChannexRatePlan>();
  let total: number | null = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const path =
      `/rate_plans?filter[property_id]=${encodeURIComponent(opts.propertyId)}` +
      `&pagination[page]=${page}&pagination[limit]=${PAGE_LIMIT}`;
    const r = await channelRequest({ ...opts, method: "GET", path });
    if ("ok" in r) return r;
    if (r.status !== 200) return fail(mapErrorStatus(r.status), r.status);

    const batch = extractRatePlanList(r.body);
    if (page === 1) total = extractTotal(r.body);

    let added = 0;
    for (const rp of batch) {
      if (!seen.has(rp.id)) {
        seen.set(rp.id, rp);
        added++;
      }
    }
    if (total !== null && seen.size >= total)
      return { ok: true, ratePlans: [...seen.values()], truncated: false };
    if (batch.length < PAGE_LIMIT)
      return { ok: true, ratePlans: [...seen.values()], truncated: total !== null && seen.size < total };
    if (added === 0) return { ok: true, ratePlans: [...seen.values()], truncated: true };
  }
  return { ok: true, ratePlans: [...seen.values()], truncated: true };
}

// `attributes` is the raw upstream attribute object of the plan — needed ONLY
// to echo the full field set back on a title-update PUT (Channex updates take
// the same fields as Create; a partial body is never assumed). It is used
// in-memory server-side and is never stored, logged or audited — the persisted
// snapshot stays the whitelisted ChannexRatePlan.
export async function getChannexRatePlan(
  opts: ReqOpts & { id: string },
): Promise<{ ok: true; ratePlan: ChannexRatePlan; attributes: Record<string, unknown> } | ChannelApiFailure> {
  const r = await channelRequest({
    ...opts,
    method: "GET",
    path: `/rate_plans/${encodeURIComponent(opts.id)}`,
  });
  if ("ok" in r) return r;
  if (r.status !== 200) return fail(mapErrorStatus(r.status), r.status);
  const node = asObj(asObj(r.body)?.data) ?? asObj(r.body);
  const ratePlan = extractRatePlanDetail(r.body);
  if (!ratePlan) return fail("bad_response", 200);
  return { ok: true, ratePlan, attributes: asObj(node?.attributes) ?? {} };
}

// The ONE update operation — title rename of an existing mapped plan. The
// caller builds the payload by echoing a fresh GET (buildTitleUpdatePayload);
// the external UUID is immutable and never regenerated here.
export async function updateChannexRatePlan(
  opts: ReqOpts & { id: string; payload: { rate_plan: Record<string, unknown> } },
): Promise<{ ok: true; ratePlan: ChannexRatePlan } | ChannelApiFailure> {
  const r = await channelRequest({
    ...opts,
    method: "PUT",
    path: `/rate_plans/${encodeURIComponent(opts.id)}`,
    body: opts.payload,
  });
  if ("ok" in r) return r;
  if (r.status !== 200 && r.status !== 201) return fail(mapErrorStatus(r.status), r.status);
  const ratePlan = extractRatePlanDetail(r.body);
  // A 2xx we cannot parse is ambiguous — but a title PUT is idempotent, so the
  // caller simply re-verifies with a fresh GET on the next run; never re-POSTs.
  if (!ratePlan) return fail("bad_response", r.status);
  return { ok: true, ratePlan };
}

export async function createChannexRatePlan(
  opts: ReqOpts & { payload: { rate_plan: Record<string, unknown> } },
): Promise<{ ok: true; ratePlan: ChannexRatePlan } | ChannelApiFailure> {
  const r = await channelRequest({ ...opts, method: "POST", path: "/rate_plans", body: opts.payload });
  if ("ok" in r) return r;
  if (r.status !== 200 && r.status !== 201) return fail(mapErrorStatus(r.status), r.status);
  const ratePlan = extractRatePlanDetail(r.body);
  // A 2xx we cannot parse is AMBIGUOUS: the rate plan may exist upstream. The
  // caller treats bad_response as ambiguous and reconciles — it never re-POSTs.
  if (!ratePlan) return fail("bad_response", r.status);
  return { ok: true, ratePlan };
}
