import { beds24Request } from "./beds24-http";
import { asObj, asInt } from "./channel-http";

// ============================================================
// Beds24 ROOM-LEVEL maxStay — the ceiling a daily value is clamped to.
//
// WHY THIS MODULE EXISTS. Beds24's daily calendar has NO value meaning "no
// maximum stay". Measured live 2026-07-25 against production (there is no
// staging), room 1318, seven days 191 days out, each variant preceded by a
// maxStay=5 sentinel so "ignored" and "cleared" stay distinguishable:
//
//   maxStay: 0      → 201 + warning "maxStay capped to 1"          → becomes 1
//   maxStay: null   → 201 {"success":true}, no modified, no warning → IGNORED
//   maxStay: ""     → same                                          → IGNORED
//   maxStay: 3650   → 201 + warning "capped to room maxStay 365"   → becomes 365
//   omitted         → IGNORED (control)
//
// So the accepted range is [1, room-level maxStay] and there is NO clear
// operation at all: once a daily value exists nothing removes it, only
// replaces it. A local reset to NULL therefore makes our UI say "ללא הגבלה"
// while Beds24 keeps enforcing the old number forever — silent under-selling
// that nobody can see. ~4,830 rows across 15 units are in that position.
//
// The fix is to translate NULL into an EXPLICIT number in the payload builder,
// and the number has to be the room's OWN ceiling:
//   · sending the room's own maxStay → clean 201, no warning (verified by the
//     A.3 restore, which wrote 365 back without one).
//   · sending 3650 and letting Beds24 clamp → a warning on EVERY push, and
//     inspectEnvelope marks any warnings[] array as `partial`. Every commercial
//     push would read partial forever and the real warnings would drown.
// This module implements the first. See docs/MAXSTAY_NO_LIMIT_SPEC.md §2.3.
//
// NOT A HARDCODED 365. Every room happens to carry 365 today, but a room whose
// ceiling is raised or lowered in the Beds24 panel must not break: the value is
// read from the provider, per room, and a room we could not read is left alone.
// ============================================================

/** beds24RoomId (as stored: text) → that room's own maxStay ceiling. */
export type Beds24RoomCeilings = ReadonlyMap<string, number>;

export const EMPTY_BEDS24_CEILINGS: Beds24RoomCeilings = new Map();

type Creds = { token: string; baseUrl: string; fetchImpl?: typeof fetch };

/**
 * How long a ceiling stays trusted. The value lives in the Beds24 panel and
 * changes about never; re-reading it on every drain would spend a credit per
 * run for a constant. Six hours bounds how long a panel edit stays invisible.
 */
export const BEDS24_CEILING_TTL_MS = 6 * 60 * 60 * 1000;

type CacheEntry = { ceilings: Map<string, number>; expiresAt: number };
const cache = new Map<string, CacheEntry>();

/** Test seam: drop the process-level cache. */
export function clearBeds24CeilingCache(): void {
  cache.clear();
}

/**
 * Read the room-level maxStay for every room of the given properties.
 *
 * FAIL-OPEN BY DESIGN. A ceiling we cannot read yields no entry, and the
 * payload builder then falls back to omitting maxStay — exactly today's
 * behaviour. A provider hiccup must never block a commercial push, and must
 * never invent a ceiling: guessing one would write a REAL restriction onto a
 * live listing.
 */
export async function loadBeds24RoomCeilings(
  creds: Creds,
  propertyIds: readonly string[],
  now: number = Date.now(),
): Promise<Beds24RoomCeilings> {
  const out = new Map<string, number>();
  const wanted = [...new Set(propertyIds)].filter((p) => p.trim() !== "");

  for (const propertyId of wanted) {
    const key = `${creds.baseUrl}|${propertyId}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) {
      for (const [roomId, ceiling] of hit.ceilings) out.set(roomId, ceiling);
      continue;
    }

    const r = await beds24Request({
      token: creds.token,
      baseUrl: creds.baseUrl,
      fetchImpl: creds.fetchImpl,
      method: "GET", // READ-ONLY — this module never issues another method
      path: `/properties?id=${encodeURIComponent(propertyId)}&includeAllRooms=true`,
    });
    // a failure is not an error here: no entry ⇒ the builder omits maxStay
    if ("ok" in r || r.status !== 200) continue;
    const root = asObj(r.body);
    if (root?.success === false) continue;

    const fresh = new Map<string, number>();
    const properties = Array.isArray(root?.data) ? root.data : [];
    for (const p of properties) {
      const rooms = Array.isArray(asObj(p)?.roomTypes) ? asObj(p)!.roomTypes as unknown[] : [];
      for (const room of rooms) {
        const ro = asObj(room);
        const roomId = ro?.id;
        const ceiling = asInt(ro?.maxStay);
        // a ceiling below 1 is not a ceiling — it would translate "no limit"
        // into the strictest possible limit. Refuse it and omit instead.
        if (roomId === undefined || roomId === null || ceiling === null || ceiling < 1) continue;
        fresh.set(String(roomId), ceiling);
      }
    }
    if (fresh.size > 0) cache.set(key, { ceilings: fresh, expiresAt: now + BEDS24_CEILING_TTL_MS });
    for (const [roomId, ceiling] of fresh) out.set(roomId, ceiling);
  }
  return out;
}
