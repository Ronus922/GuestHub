// ============================================================
// Channex ROOM TYPES client (D64) — server-side network calls for the
// physical-room → Room Type synchronization milestone. Requests go through the
// shared, leak-proof core in ./channel-http (single attempt, bounded timeout,
// fixed safe messages, api-key never echoed).
//
// SCOPE: this client touches /room_types ONLY, and only with GET and POST.
// It never calls DELETE (forbidden this milestone), never PUT, and never
// rate_plans / availability / restrictions / webhooks / bookings / properties —
// scripts/check-channex-room-types.mjs asserts that at the source level.
//
// API contract (docs.channex.io/api-v.1-documentation/room-types-collection):
//   LIST   GET  /room_types?filter[property_id]=<uuid>&pagination[page]=N&pagination[limit]=100
//          → { data: [{ type, id, attributes: {...} }], meta: { page, limit, total } }
//          `total` is the RECORD count (not page count); max limit is 100.
//   GET    GET  /room_types/:id            → { data: { id, attributes: {...} } }
//   CREATE POST /room_types  body { room_type: {...} } → 201 { data: { id, attributes } }
// Required create attributes: property_id, title, count_of_rooms, occ_adults,
// occ_children, occ_infants, default_occupancy. room_kind is optional.
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

// Safe, whitelisted external room-type snapshot. NO raw upstream body is kept.
export type ChannexRoomType = {
  id: string;
  title: string | null;
  countOfRooms: number | null;
  occAdults: number | null;
  occChildren: number | null;
  occInfants: number | null;
  defaultOccupancy: number | null;
  roomKind: string | null;
  propertyId: string | null;
};

// Channex caps `pagination[limit]` at 100. A property with more room types than
// MAX_PAGES × 100 would be truncated — the list result reports `truncated` so
// the caller can refuse to create rather than silently duplicate.
export const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

// ---- pure extractors ----
function extractOne(node: unknown): ChannexRoomType | null {
  const o = asObj(node);
  if (!o) return null;
  const a = asObj(o.attributes) ?? o;
  // JSON:API mirrors the id at data.id and data.attributes.id — prefer data.id.
  const id = asStr(o.id) ?? asStr(a.id);
  if (!id) return null;
  const rel = asObj(asObj(asObj(o.relationships)?.property)?.data);
  return {
    id,
    title: asStr(a.title),
    countOfRooms: asInt(a.count_of_rooms),
    occAdults: asInt(a.occ_adults),
    occChildren: asInt(a.occ_children),
    occInfants: asInt(a.occ_infants),
    defaultOccupancy: asInt(a.default_occupancy),
    roomKind: asStr(a.room_kind),
    propertyId: asStr(a.property_id) ?? asStr(rel?.id),
  };
}

export function extractRoomTypeDetail(body: unknown): ChannexRoomType | null {
  return extractOne(asObj(asObj(body)?.data) ?? asObj(body));
}

export function extractRoomTypeList(body: unknown): ChannexRoomType[] {
  const data = asObj(body)?.data ?? body;
  if (!Array.isArray(data)) return [];
  const out: ChannexRoomType[] = [];
  for (const item of data) {
    const rt = extractOne(item);
    if (rt) out.push(rt);
  }
  return out;
}

// meta.total is a RECORD count. Absent/garbage meta → null (caller falls back to
// "stop when a page adds nothing new"), never a fabricated number.
export function extractTotal(body: unknown): number | null {
  return asInt(asObj(asObj(body)?.meta)?.total);
}

// ---- operations ----

// List EVERY room type of ONE property, following pagination. Stops when the
// collected count reaches meta.total, when a page yields no NEW ids (defensive
// against a server that ignores the page param), or at MAX_PAGES — in which case
// `truncated: true` is returned and the caller must not treat the list as complete.
export async function listChannexRoomTypes(
  opts: ReqOpts & { propertyId: string },
): Promise<{ ok: true; roomTypes: ChannexRoomType[]; truncated: boolean } | ChannelApiFailure> {
  const seen = new Map<string, ChannexRoomType>();
  let total: number | null = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const path =
      `/room_types?filter[property_id]=${encodeURIComponent(opts.propertyId)}` +
      `&pagination[page]=${page}&pagination[limit]=${PAGE_LIMIT}`;
    const r = await channelRequest({ ...opts, method: "GET", path });
    if ("ok" in r) return r;
    if (r.status !== 200) return fail(mapErrorStatus(r.status), r.status);

    const batch = extractRoomTypeList(r.body);
    if (page === 1) total = extractTotal(r.body);

    let added = 0;
    for (const rt of batch) {
      if (!seen.has(rt.id)) {
        seen.set(rt.id, rt);
        added++;
      }
    }
    // We hold every advertised record → provably complete.
    if (total !== null && seen.size >= total)
      return { ok: true, roomTypes: [...seen.values()], truncated: false };
    // A short page is the normal end-of-list signal. Trust it as complete only
    // when meta.total does not contradict it — if total says more records exist
    // than we collected, the list IS truncated (never reported as complete).
    if (batch.length < PAGE_LIMIT)
      return { ok: true, roomTypes: [...seen.values()], truncated: total !== null && seen.size < total };
    // A FULL page that added nothing new means the server is not honouring the
    // page param (it keeps returning the same records). We cannot page past it
    // and total is not yet satisfied, so completeness is unprovable → truncated.
    if (added === 0) return { ok: true, roomTypes: [...seen.values()], truncated: true };
  }
  return { ok: true, roomTypes: [...seen.values()], truncated: true };
}

export async function getChannexRoomType(
  opts: ReqOpts & { id: string },
): Promise<{ ok: true; roomType: ChannexRoomType } | ChannelApiFailure> {
  const r = await channelRequest({
    ...opts,
    method: "GET",
    path: `/room_types/${encodeURIComponent(opts.id)}`,
  });
  if ("ok" in r) return r;
  if (r.status !== 200) return fail(mapErrorStatus(r.status), r.status);
  const roomType = extractRoomTypeDetail(r.body);
  if (!roomType) return fail("bad_response", 200);
  return { ok: true, roomType };
}

export async function createChannexRoomType(
  opts: ReqOpts & { payload: { room_type: Record<string, unknown> } },
): Promise<{ ok: true; roomType: ChannexRoomType } | ChannelApiFailure> {
  const r = await channelRequest({ ...opts, method: "POST", path: "/room_types", body: opts.payload });
  if ("ok" in r) return r;
  if (r.status !== 200 && r.status !== 201) return fail(mapErrorStatus(r.status), r.status);
  const roomType = extractRoomTypeDetail(r.body);
  // A 2xx we cannot parse is AMBIGUOUS: the room type may exist upstream. The
  // caller treats bad_response as ambiguous and reconciles — it never re-POSTs.
  if (!roomType) return fail("bad_response", r.status);
  return { ok: true, roomType };
}
