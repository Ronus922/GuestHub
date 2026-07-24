import "server-only";
import { sql } from "@/lib/db";

// ============================================================
// Rooms-module READ layer. The one server-side path the /rooms board and the
// room wizard read through. Tenant-scoped by the caller's actor.tenantId.
// Occupancy/pricing reads stay in lib/commercial/service (unchanged seam).
// ============================================================

export type Lang = "he" | "en" | "ar";
export const LANGS: Lang[] = ["he", "en", "ar"];

export type RoomTranslation = {
  lang: Lang;
  name: string | null;
  description: string | null;
  summary: string | null;
  slug: string | null;
  seo_title: string | null;
  meta_description: string | null;
  og_title: string | null;
  og_description: string | null;
  noindex: boolean;
};

export type RoomImage = {
  id: string;
  url: string;
  alt_text: string | null;
  is_main: boolean;
  sort_order: number;
};

// derived, single chip per card (priority: blocked > maintenance > occupied > cleaning > dirty > free)
export type RoomDerivedStatus = "blocked" | "maintenance" | "occupied" | "cleaning" | "dirty" | "free";

export type BoardRoom = {
  id: string;
  room_number: string;
  name: string | null;
  floor: string | null;
  status: string;
  is_active: boolean;
  show_on_website: boolean;
  show_on_calendar: boolean;
  sort_order: number;
  size_sqm: number | null;
  max_occupancy: number;
  max_adults: number;
  max_children: number;
  max_infants: number;
  min_occupancy: number | null;
  default_occupancy: number | null;
  included_occupancy: number | null;
  notes: string | null;
  extra_guest_pricing_mode: "inherit" | "override";
  extra_adult_override: number | null;
  extra_child_override: number | null;
  extra_infant_override: number | null;
  charge_frequency_override: "per_night" | "per_stay" | null;
  single_beds: number;
  double_beds: number;
  queen_beds: number;
  sofa_beds: number;
  cribs: number;
  area_id: string | null;
  area_name: string | null;
  room_type_id: string | null;
  room_type_name: string | null;
  // derived
  derived_status: RoomDerivedStatus;
  current_guest: string | null;
  current_until: string | null; // date the current stay ends
  next_arrival: string | null; // date of the next confirmed arrival
  next_guest: string | null;
  // completeness
  incomplete: boolean;
  missing: string[];
  langs_complete: Record<Lang, boolean>;
  amenity_ids: string[];
  translations: RoomTranslation[];
  images: RoomImage[];
  main_image_url: string | null;
  image_count: number;
};

export type OperationalArea = {
  id: string;
  name: string;
  code: string | null;
  area_type: string;
  building_area_id: string | null;
  building_name: string | null;
  floor: string | null;
  is_active: boolean;
  relevant_cleaning: boolean;
  relevant_maintenance: boolean;
  status: "ok" | "maintenance" | "cleaning" | "blocked";
  status_note: string | null;
  sort_order: number;
  notes: string | null;
};

export type BuildingOption = { id: string; name: string };
export type RoomTypeOption = { id: string; name: string };
export type AmenityOption = {
  id: string;
  key: string;
  label: string;
  icon: string | null;
  group: string | null; // approved catalog groups: חדר רחצה / בידור / כללי / מטבח / יוקרה
};

type StayRow = {
  room_id: string;
  guest_name: string;
  check_in: string;
  check_out: string;
};

type HkRow = { room_id: string; status: string };
type TrRow = RoomTranslation & { room_id: string };
type ImgRow = RoomImage & { room_id: string };
type AmRow = { room_id: string; amenity_id: string };

// A room is "complete" when its operational + commercial + website essentials are
// all present. Missing items are reported so the card can say what's left.
function missingOf(r: Omit<BoardRoom, "derived_status" | "current_guest" | "current_until" | "next_arrival" | "next_guest" | "incomplete" | "missing" | "langs_complete" | "amenity_ids" | "main_image_url" | "image_count">, heName: string | null): string[] {
  const missing: string[] = [];
  if (!heName && !r.name) missing.push("שם");
  if (r.included_occupancy === null) missing.push("אורחים כלולים במחיר");
  if (r.default_occupancy === null) missing.push("תפוסת ברירת מחדל");
  if (!r.room_type_id) missing.push("סוג חדר");
  return missing;
}

export async function listBoardRooms(tenantId: string, today: string): Promise<BoardRoom[]> {
  const [rooms, stays, hk, closures, translations, images, amenities] = await Promise.all([
    sql<Omit<BoardRoom, "derived_status" | "current_guest" | "current_until" | "next_arrival" | "next_guest" | "incomplete" | "missing" | "langs_complete" | "amenity_ids" | "main_image_url" | "image_count">[]>`
      SELECT r.id, r.room_number, r.name, r.floor, r.status, r.is_active,
             r.show_on_website, r.show_on_calendar, r.sort_order, r.size_sqm::float8 AS size_sqm,
             r.max_occupancy, r.max_adults, r.max_children, r.max_infants,
             r.min_occupancy, r.default_occupancy, r.included_occupancy, r.notes,
             r.extra_guest_pricing_mode,
             r.extra_adult_override::float8  AS extra_adult_override,
             r.extra_child_override::float8  AS extra_child_override,
             r.extra_infant_override::float8 AS extra_infant_override,
             r.charge_frequency_override,
             r.single_beds, r.double_beds, r.queen_beds, r.sofa_beds, r.cribs,
             r.area_id, a.name AS area_name,
             r.room_type_id, rt.name AS room_type_name
      FROM guesthub.rooms r
      LEFT JOIN guesthub.areas a       ON a.id  = r.area_id
      LEFT JOIN guesthub.room_types rt ON rt.id = r.room_type_id
      WHERE r.tenant_id = ${tenantId}
      ORDER BY r.sort_order, r.room_number`,
    // current stay + next confirmed arrival per room, in one window
    sql<StayRow[]>`
      SELECT rr.room_id,
             COALESCE(NULLIF(TRIM(CONCAT(rr.guest_first_name, ' ', rr.guest_last_name)), ''), g.full_name, 'אורח') AS guest_name,
             rr.check_in::text AS check_in, rr.check_out::text AS check_out
      FROM guesthub.reservation_rooms rr
      JOIN guesthub.reservations res ON res.id = rr.reservation_id
      LEFT JOIN guesthub.guests g ON g.id = res.primary_guest_id
      WHERE rr.tenant_id = ${tenantId} AND res.status = 'confirmed'
        AND rr.room_id IS NOT NULL AND rr.check_out >= ${today}
      ORDER BY rr.check_in`,
    sql<HkRow[]>`
      SELECT DISTINCT ON (room_id) room_id, status
      FROM guesthub.housekeeping_tasks
      WHERE tenant_id = ${tenantId} AND room_id IS NOT NULL
        AND status IN ('pending', 'in_progress')
      ORDER BY room_id, created_at DESC`,
    sql<{ room_id: string }[]>`
      SELECT DISTINCT room_id FROM guesthub.room_closures
      WHERE tenant_id = ${tenantId} AND start_date <= ${today} AND end_date > ${today}`,
    sql<TrRow[]>`
      SELECT room_id, lang, name, description, summary, slug, seo_title,
             meta_description, og_title, og_description, noindex
      FROM guesthub.room_translations rt
      WHERE tenant_id = ${tenantId}`,
    sql<ImgRow[]>`
      SELECT room_id, id, url, alt_text, is_main, sort_order
      FROM guesthub.room_images WHERE tenant_id = ${tenantId}
      ORDER BY is_main DESC, sort_order`,
    sql<AmRow[]>`
      SELECT room_id, amenity_id FROM guesthub.room_amenities WHERE tenant_id = ${tenantId}`,
  ]);

  const closed = new Set(closures.map((c) => c.room_id));
  const hkByRoom = new Map(hk.map((h) => [h.room_id, h.status]));
  const staysByRoom = new Map<string, StayRow[]>();
  for (const s of stays) {
    const arr = staysByRoom.get(s.room_id) ?? [];
    arr.push(s);
    staysByRoom.set(s.room_id, arr);
  }
  const trByRoom = new Map<string, TrRow[]>();
  for (const t of translations) {
    const arr = trByRoom.get(t.room_id) ?? [];
    arr.push(t);
    trByRoom.set(t.room_id, arr);
  }
  const imgByRoom = new Map<string, ImgRow[]>();
  for (const i of images) {
    const arr = imgByRoom.get(i.room_id) ?? [];
    arr.push(i);
    imgByRoom.set(i.room_id, arr);
  }
  const amByRoom = new Map<string, string[]>();
  for (const a of amenities) {
    const arr = amByRoom.get(a.room_id) ?? [];
    arr.push(a.amenity_id);
    amByRoom.set(a.room_id, arr);
  }

  return rooms.map((r) => {
    const roomStays = staysByRoom.get(r.id) ?? [];
    const current = roomStays.find((s) => s.check_in <= today && s.check_out > today) ?? null;
    const next = roomStays.find((s) => s.check_in >= today && s !== current) ?? null;

    let derived: RoomDerivedStatus = "free";
    if (r.status === "out_of_order" || closed.has(r.id)) derived = "blocked";
    else if (r.status === "inactive" || !r.is_active) derived = "maintenance";
    else if (current) derived = "occupied";
    else if (hkByRoom.get(r.id) === "in_progress") derived = "cleaning";
    else if (hkByRoom.get(r.id) === "pending") derived = "dirty";

    const trs = trByRoom.get(r.id) ?? [];
    const langComplete = (lang: Lang) => {
      const t = trs.find((x) => x.lang === lang);
      return Boolean(t && t.name && t.seo_title && t.meta_description);
    };
    const heName = trs.find((t) => t.lang === "he")?.name ?? null;
    const missing = missingOf(r, heName);
    const imgs = imgByRoom.get(r.id) ?? [];

    return {
      ...r,
      derived_status: derived,
      current_guest: current?.guest_name ?? null,
      current_until: current?.check_out ?? null,
      next_arrival: next?.check_in ?? null,
      next_guest: next?.guest_name ?? null,
      incomplete: missing.length > 0,
      missing,
      langs_complete: { he: langComplete("he"), en: langComplete("en"), ar: langComplete("ar") },
      amenity_ids: amByRoom.get(r.id) ?? [],
      translations: trs.map((t) => ({
        lang: t.lang, name: t.name, description: t.description, summary: t.summary,
        slug: t.slug, seo_title: t.seo_title, meta_description: t.meta_description,
        og_title: t.og_title, og_description: t.og_description, noindex: t.noindex,
      })),
      images: imgs.map((i) => ({
        id: i.id, url: i.url, alt_text: i.alt_text, is_main: i.is_main, sort_order: i.sort_order,
      })),
      main_image_url: imgs[0]?.url ?? null,
      image_count: imgs.length,
    };
  });
}

export async function listOperationalAreas(tenantId: string): Promise<OperationalArea[]> {
  return sql<OperationalArea[]>`
    SELECT oa.id, oa.name, oa.code, oa.area_type, oa.building_area_id,
           b.name AS building_name, oa.floor, oa.is_active, oa.relevant_cleaning,
           oa.relevant_maintenance, oa.status, oa.status_note, oa.sort_order, oa.notes
    FROM guesthub.operational_areas oa
    LEFT JOIN guesthub.areas b ON b.id = oa.building_area_id
    WHERE oa.tenant_id = ${tenantId}
    ORDER BY oa.sort_order, oa.name`;
}

export async function listBuildings(tenantId: string): Promise<BuildingOption[]> {
  return sql<BuildingOption[]>`
    SELECT id, name FROM guesthub.areas
    WHERE tenant_id = ${tenantId} AND is_active
    ORDER BY sort_order, name`;
}

export async function listRoomTypes(tenantId: string): Promise<RoomTypeOption[]> {
  return sql<RoomTypeOption[]>`
    SELECT id, name FROM guesthub.room_types
    WHERE tenant_id = ${tenantId} AND is_active
    ORDER BY sort_order, name`;
}

export async function listAmenities(tenantId: string): Promise<AmenityOption[]> {
  return sql<AmenityOption[]>`
    SELECT id, key, label, icon, metadata->>'group' AS "group"
    FROM guesthub.lookup_items
    WHERE tenant_id = ${tenantId} AND category = 'amenities' AND is_active
    ORDER BY sort_order, label`;
}
