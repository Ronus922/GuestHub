// ============================================================
// Beds24 PROPERTIES client (D78) — server-side network calls for the
// room ↔ Beds24-room mapping milestone: list accessible properties WITH their
// rooms (paginated), read one. Requests go through the shared, leak-proof core
// in ./beds24-http (single attempt, bounded timeout, fixed safe messages).
//
// SCOPE: this client touches /properties ONLY — read-only GETs. It never calls
// bookings, calendar, inventory or messages, and it NEVER issues a write.
//
// Only SAFE, whitelisted fields are ever surfaced; a raw upstream body, headers
// or a token can never reach a returned value.
//
// Payload-shape assumptions (probed DEFENSIVELY, never trusted):
//  • GET /properties?includeAllRooms=true → { success, count, pages, data: [...] }
//    (a bare array body is also accepted). Each property: numeric `id`, `name`,
//    `currency`; its rooms under `roomTypes` (documented) or `rooms` (probed).
//  • Each room: numeric `id`, `name`, `maxPeople` when present.
//  • Pagination: `page` query param; `pages.nextPageExists` boolean signals
//    more pages. When absent/malformed, an empty page terminates the loop.
// ============================================================

import {
  beds24Request,
  beds24Fail,
  mapErrorStatus,
  type Beds24ApiFailure,
  type Beds24ReqOpts,
} from "./beds24-http";
import { asObj, asStr, asInt } from "./channel-http";

export { mapErrorStatus, type Beds24ApiFailure } from "./beds24-http";

type ReqOpts = Beds24ReqOpts;

// Safe, whitelisted external snapshots. NO raw upstream body is kept.
export type Beds24RoomSummary = {
  /** the Beds24 room id (numeric upstream — normalized to string) */
  id: string;
  name: string | null;
  maxPeople: number | null;
};

export type Beds24PropertySummary = {
  /** the Beds24 property id (numeric upstream — normalized to string) */
  id: string;
  name: string | null;
  currency: string | null;
  rooms: Beds24RoomSummary[];
};

// Bounds the pagination loop so a malformed `pages` block can never make it
// spin forever.
const MAX_PAGES = 50;

// ---- pure body extractors (unit-checkable, never surface raw bodies) ----

// Beds24 ids arrive as NUMBERS; the DB mapping columns are text — normalize.
const asIdStr = (v: unknown): string | null =>
  asStr(v) ?? (typeof v === "number" && Number.isFinite(v) ? String(v) : null);

export function extractBeds24Room(item: unknown): Beds24RoomSummary | null {
  const o = asObj(item);
  if (!o) return null;
  const id = asIdStr(o.id) ?? asIdStr(o.roomId);
  if (!id) return null;
  return { id, name: asStr(o.name), maxPeople: asInt(o.maxPeople) };
}

// One property object → safe summary. Rooms live under `roomTypes`
// (documented for includeAllRooms=true) or `rooms` — probed defensively;
// anything unrecognisable is ignored.
export function extractBeds24Property(item: unknown): Beds24PropertySummary | null {
  const o = asObj(item);
  if (!o) return null;
  const id = asIdStr(o.id) ?? asIdStr(o.propId) ?? asIdStr(o.propertyId);
  if (!id) return null;
  const rawRooms = Array.isArray(o.roomTypes) ? o.roomTypes : Array.isArray(o.rooms) ? o.rooms : [];
  const rooms: Beds24RoomSummary[] = [];
  for (const r of rawRooms) {
    const room = extractBeds24Room(r);
    if (room) rooms.push(room);
  }
  return { id, name: asStr(o.name), currency: asStr(o.currency), rooms };
}

// GET /properties → { success, data: [...], pages: { nextPageExists } }.
// `success:false` with a 200 is treated as a bad response; `nextPageExists` is
// read defensively — when absent, the caller stops on the first empty page.
export function extractBeds24PropertyList(body: unknown): {
  ok: boolean;
  properties: Beds24PropertySummary[];
  nextPageExists: boolean;
} {
  const root = asObj(body);
  if (root && root.success === false) return { ok: false, properties: [], nextPageExists: false };
  const data = root?.data ?? body;
  const properties: Beds24PropertySummary[] = [];
  if (Array.isArray(data)) {
    for (const item of data) {
      const p = extractBeds24Property(item);
      if (p) properties.push(p);
    }
  }
  return {
    ok: true,
    properties,
    nextPageExists: asObj(root?.pages)?.nextPageExists === true,
  };
}

// ---- operations (read-only GETs; a write is never issued from here) ----

// List ALL accessible properties with their rooms, walking `page` pagination to
// the end. Any non-200 page aborts the whole listing with a safe failure — a
// partial list is never presented as complete.
export async function listBeds24Properties(
  opts: ReqOpts,
): Promise<{ ok: true; properties: Beds24PropertySummary[] } | Beds24ApiFailure> {
  const all: Beds24PropertySummary[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await beds24Request({
      ...opts,
      method: "GET",
      path: `/properties?includeAllRooms=true&page=${page}`,
    });
    if ("ok" in r) return r;
    if (r.status !== 200) return beds24Fail(mapErrorStatus(r.status), r.status);
    const { ok, properties, nextPageExists } = extractBeds24PropertyList(r.body);
    if (!ok) return beds24Fail("bad_response", r.status);
    all.push(...properties);
    if (!nextPageExists || properties.length === 0) break;
  }
  return { ok: true, properties: all };
}

// Read ONE property (with rooms) by id — GET /properties?id=X filtered
// server-side by Beds24; the id match is still verified locally so a
// disregarded filter can never verify the wrong property.
export async function getBeds24Property(
  opts: ReqOpts & { id: string },
): Promise<{ ok: true; property: Beds24PropertySummary } | Beds24ApiFailure> {
  const r = await beds24Request({
    ...opts,
    method: "GET",
    path: `/properties?id=${encodeURIComponent(opts.id)}&includeAllRooms=true`,
  });
  if ("ok" in r) return r;
  if (r.status !== 200) return beds24Fail(mapErrorStatus(r.status), r.status);
  const { ok, properties } = extractBeds24PropertyList(r.body);
  if (!ok) return beds24Fail("bad_response", r.status);
  const property = properties.find((p) => p.id === opts.id);
  if (!property) return beds24Fail("not_found", 404);
  return { ok: true, property };
}
