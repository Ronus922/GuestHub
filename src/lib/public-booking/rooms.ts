import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { PUBLIC_TENANT_ID } from "./config";

// ============================================================
// Public rooms read model — the catalog behind GET /api/public/rooms.
// Content-only: names, copy, size, beds, amenities and gallery for the rooms
// the owner marked show_on_website. Availability and price never come from
// here (they are per-date, and live in publicAvailability) — a card built on
// this model may say WHAT a room is, never whether it is free tonight.
//
// Only rooms that have at least one image are returned: a room card without a
// photo is a hole in a public gallery, and every consumer would otherwise have
// to filter for itself.
// ============================================================

export type PublicRoomLang = "he" | "en" | "ar";

// A row in room_translations is not proof of a translation: the app seeds it
// from the room's internal name, so the "he" row of most rooms still holds the
// English PMS label. Text that carries none of the language's own script is
// treated as untranslated, so the fallback chain can reach real Hebrew copy.
const SCRIPT: Record<PublicRoomLang, RegExp | null> = {
  he: /[\u0590-\u05FF]/,
  ar: /[\u0600-\u06FF]/,
  en: null,
};

type RoomRow = {
  id: string;
  room_number: string;
  room_name: string | null;
  floor: string | null;
  size_sqm: number | null;
  max_occupancy: number | null;
  single_beds: number;
  double_beds: number;
  queen_beds: number;
  sofa_beds: number;
  cribs: number;
  room_type_id: string | null;
  room_type_name: string | null;
  type_max_occupancy: number | null;
  tr_name: string | null;
  tr_summary: string | null;
  tr_description: string | null;
  tr_slug: string | null;
};

export type PublicRoomImage = { url: string; alt: string | null };

// Where `title` came from. A consumer that renders the room type as its own
// badge uses this to avoid printing the same words twice.
export type PublicRoomTitleSource = "translation" | "room" | "type" | "number";

export type PublicRoom = {
  id: string;
  roomNumber: string;
  slug: string | null;
  title: string;
  titleSource: PublicRoomTitleSource;
  summary: string | null;
  description: string | null;
  floor: string | null;
  sizeSqm: number | null;
  maxOccupancy: number | null;
  roomType: { id: string; name: string } | null;
  beds: { single: number; double: number; queen: number; sofa: number; cribs: number };
  amenities: string[];
  images: PublicRoomImage[];
};

const trimmed = (s: string | null): string | null => {
  const v = s?.trim();
  return v ? v : null;
};

// Text that is usable AS the requested language (see SCRIPT above).
const inLang = (s: string | null, lang: PublicRoomLang): string | null => {
  const v = trimmed(s);
  const script = SCRIPT[lang];
  return v && (!script || script.test(v)) ? v : null;
};

// The heading a card shows, and where it came from. The owner's translation
// wins; then the room's own name if it happens to be written in the requested
// language; then the room type, which the owner maintains in Hebrew and is the
// approved public label for an untranslated room. The room number is the last
// resort so a card can never render an empty heading.
function resolveTitle(
  r: RoomRow,
  lang: PublicRoomLang,
): { title: string; titleSource: PublicRoomTitleSource } {
  const translation = inLang(r.tr_name, lang);
  if (translation) return { title: translation, titleSource: "translation" };
  const own = inLang(r.room_name, lang);
  if (own) return { title: own, titleSource: "room" };
  const type = inLang(r.room_type_name, lang);
  if (type) return { title: type, titleSource: "type" };
  return { title: r.room_number, titleSource: "number" };
}

export async function publicWebsiteRooms(
  db: Sql | TransactionSql,
  lang: PublicRoomLang = "he",
): Promise<PublicRoom[]> {
  const rooms = await db<RoomRow[]>`
    SELECT r.id, r.room_number, r.name AS room_name, r.floor,
           r.size_sqm::float8 AS size_sqm, r.max_occupancy,
           r.single_beds, r.double_beds, r.queen_beds, r.sofa_beds, r.cribs,
           rt.id AS room_type_id, rt.name AS room_type_name,
           rt.max_occupancy AS type_max_occupancy,
           t.name AS tr_name, t.summary AS tr_summary,
           t.description AS tr_description, t.slug AS tr_slug
    FROM guesthub.rooms r
    LEFT JOIN guesthub.room_types rt ON rt.id = r.room_type_id
    LEFT JOIN guesthub.room_translations t
           ON t.room_id = r.id AND t.lang = ${lang}
    WHERE r.tenant_id = ${PUBLIC_TENANT_ID}
      AND r.show_on_website AND r.is_active AND r.status <> 'inactive'
      AND EXISTS (SELECT 1 FROM guesthub.room_images ri
                   WHERE ri.tenant_id = r.tenant_id AND ri.room_id = r.id)
    ORDER BY r.sort_order, r.room_number`;

  if (rooms.length === 0) return [];
  const ids = rooms.map((r) => r.id);

  // Gallery: main image first, then the owner's order — the site takes [0] as
  // the card image without needing to know the is_main flag.
  const images = await db<{ room_id: string; url: string; alt_text: string | null }[]>`
    SELECT room_id, url, alt_text
    FROM guesthub.room_images
    WHERE tenant_id = ${PUBLIC_TENANT_ID} AND room_id = ANY(${ids})
    ORDER BY is_main DESC, sort_order`;

  const amenities = await db<{ room_id: string; label: string }[]>`
    SELECT ra.room_id, li.label
    FROM guesthub.room_amenities ra
    JOIN guesthub.lookup_items li ON li.id = ra.amenity_id AND li.is_active
    WHERE ra.tenant_id = ${PUBLIC_TENANT_ID} AND ra.room_id = ANY(${ids})
    ORDER BY li.sort_order, li.label`;

  const imagesBy = new Map<string, PublicRoomImage[]>();
  for (const i of images) {
    const list = imagesBy.get(i.room_id) ?? [];
    list.push({ url: i.url, alt: trimmed(i.alt_text) });
    imagesBy.set(i.room_id, list);
  }
  const amenitiesBy = new Map<string, string[]>();
  for (const a of amenities) {
    const list = amenitiesBy.get(a.room_id) ?? [];
    const label = trimmed(a.label);
    if (label) list.push(label);
    amenitiesBy.set(a.room_id, list);
  }

  return rooms.map((r) => ({
    id: r.id,
    roomNumber: r.room_number,
    slug: trimmed(r.tr_slug),
    ...resolveTitle(r, lang),
    // Copy in the wrong language is worse than no copy: the consumer hides an
    // absent summary, but would print an English paragraph on a Hebrew page.
    summary: inLang(r.tr_summary, lang),
    description: inLang(r.tr_description, lang),
    floor: trimmed(r.floor),
    sizeSqm: r.size_sqm,
    maxOccupancy: r.max_occupancy ?? r.type_max_occupancy,
    roomType:
      r.room_type_id && r.room_type_name
        ? { id: r.room_type_id, name: r.room_type_name }
        : null,
    beds: {
      single: r.single_beds,
      double: r.double_beds,
      queen: r.queen_beds,
      sofa: r.sofa_beds,
      cribs: r.cribs,
    },
    amenities: amenitiesBy.get(r.id) ?? [],
    images: imagesBy.get(r.id) ?? [],
  }));
}
