import type { Sql, TransactionSql } from "postgres";
import { getRoomCapacities } from "@/lib/inventory";
import { inLang, trimmed } from "@/lib/rooms/lang-text";
import {
  ROOM_MISSING_KEYS,
  type RoomCompleteness,
  type RoomMissingKey,
} from "@/lib/rooms/completeness-keys";

// ============================================================
// Room completeness — ONE server-side evaluation of the D197 §D-D criteria
// (see completeness-keys.ts for the list). The rooms list reads it for the
// "חסרים N פרטים" chip and the room wizard reads the same result for its
// "what is missing" panel; neither re-derives a criterion on its own.
//
// Occupancy is not re-implemented: getRoomCapacities (src/lib/inventory.ts)
// is the engine's resolver (room → room type → hardcoded default), and it now
// reports where max_occupancy came from. "default" is the only unresolved
// state — the room and its type both left it NULL.
// ============================================================

type RoomRow = { id: string; size_sqm: number | null; photos: number };
type TrRow = {
  room_id: string;
  lang: "he" | "en" | "ar";
  name: string | null;
  description: string | null;
  slug: string | null;
};

export async function roomCompleteness(
  db: Sql | TransactionSql,
  tenantId: string,
  roomIds?: string[],
): Promise<Map<string, RoomCompleteness>> {
  const ids = roomIds ?? null;
  const rooms = await db<RoomRow[]>`
    SELECT r.id, r.size_sqm::float8 AS size_sqm,
           (SELECT count(*) FROM guesthub.room_images i
             WHERE i.tenant_id = r.tenant_id AND i.room_id = r.id)::int AS photos
    FROM guesthub.rooms r
    WHERE r.tenant_id = ${tenantId}
      AND (${ids}::uuid[] IS NULL OR r.id = ANY(${ids}::uuid[]))`;
  if (rooms.length === 0) return new Map();
  const roomIdList = rooms.map((r) => r.id);

  const [translations, capacities] = await Promise.all([
    db<TrRow[]>`
      SELECT room_id, lang, name, description, slug
      FROM guesthub.room_translations
      WHERE tenant_id = ${tenantId} AND room_id = ANY(${roomIdList}::uuid[])`,
    getRoomCapacities(db, tenantId, roomIdList),
  ]);

  const trByRoom = new Map<string, Partial<Record<TrRow["lang"], TrRow>>>();
  for (const t of translations) {
    const byLang = trByRoom.get(t.room_id) ?? {};
    byLang[t.lang] = t;
    trByRoom.set(t.room_id, byLang);
  }

  const out = new Map<string, RoomCompleteness>();
  for (const r of rooms) {
    const tr = trByRoom.get(r.id) ?? {};
    const cap = capacities.get(r.id);
    const has: Record<RoomMissingKey, boolean> = {
      photo: r.photos > 0,
      size_sqm: r.size_sqm !== null && r.size_sqm > 0,
      name_he: inLang(tr.he?.name, "he") !== null,
      description_he: inLang(tr.he?.description, "he") !== null,
      name_en: inLang(tr.en?.name, "en") !== null,
      description_en: inLang(tr.en?.description, "en") !== null,
      name_ar: inLang(tr.ar?.name, "ar") !== null,
      description_ar: inLang(tr.ar?.description, "ar") !== null,
      slug: trimmed(tr.he?.slug) !== null,
      occupancy: cap !== undefined && cap.max_occupancy_source !== "default",
    };
    const missing = ROOM_MISSING_KEYS.filter((k) => !has[k]);
    out.set(r.id, { missing, count: missing.length });
  }
  return out;
}
