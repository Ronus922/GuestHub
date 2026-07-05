import { z } from "zod";

// Zod schemas for the Rooms-module Server Actions. Client forms are cosmetic;
// every mutation parses through these, then validateRoomOccupancy (pure) enforces
// the cross-field occupancy rules exactly as the pre-existing occupancy editor did.

const shortText = z.string().trim().max(160);
const longText = z.string().trim().max(4000);
const money = z.number().min(0).max(1_000_000);
const count = z.number().int().min(0).max(50);

// One language's content + SEO payload. Everything optional — a language is
// saved only with what was filled in; untouched languages are never overwritten
// because the action UPDATEs only the languages present in the payload.
export const roomTranslationSchema = z.object({
  name: shortText.optional().nullable(),
  description: longText.optional().nullable(),
  summary: z.string().trim().max(200).optional().nullable(),
  slug: z
    .string()
    .trim()
    .max(120)
    .regex(/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u, "כתובת URL יכולה להכיל אותיות, ספרות ומקפים בלבד")
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  seo_title: shortText.optional().nullable(),
  meta_description: z.string().trim().max(320).optional().nullable(),
  og_title: shortText.optional().nullable(),
  og_description: z.string().trim().max(320).optional().nullable(),
  noindex: z.boolean().default(false),
});
export type RoomTranslationInput = z.infer<typeof roomTranslationSchema>;

export const roomWizardSchema = z.object({
  id: z.uuid().optional(), // absent = create
  room_number: z.string().trim().min(1, "נדרש מספר חדר").max(20),
  room_type_id: z.uuid().nullable(),
  area_id: z.uuid().nullable(), // building / wing
  floor: z.string().trim().max(20).nullable(),
  status: z.enum(["available", "inactive", "out_of_order"]),
  is_active: z.boolean(),
  show_on_website: z.boolean(),
  sort_order: z.number().int().min(0).max(10000),
  size_sqm: z.number().min(0).max(10000).nullable(),

  // occupancy — validated cross-field by validateRoomOccupancy in the action
  max_occupancy: z.number().int().min(1).max(50),
  max_adults: count,
  max_children: count,
  max_infants: count,
  min_occupancy: z.number().int().min(1, "תפוסה מינימלית חייבת להיות לפחות 1").max(50).nullable(),
  default_occupancy: z.number().int().min(1).max(50).nullable(),
  included_occupancy: z.number().int().min(1).max(50).nullable(),

  // extra-guest pricing (existing inherit/override model — unchanged semantics)
  extra_guest_pricing_mode: z.enum(["inherit", "override"]),
  extra_adult_override: money.nullable(),
  extra_child_override: money.nullable(),
  extra_infant_override: money.nullable(),
  charge_frequency_override: z.enum(["per_night", "per_stay"]).nullable(),

  // sleeping arrangements
  single_beds: count,
  double_beds: count,
  queen_beds: count,
  sofa_beds: count,
  cribs: count,

  amenity_ids: z.array(z.uuid()).max(100),
  // internal team notes (rooms.notes — approved brief §4)
  notes: longText.optional().nullable(),
  // only languages present here are written — protects the others from overwrite
  translations: z.partialRecord(z.enum(["he", "en", "ar"]), roomTranslationSchema),
});
export type RoomWizardInput = z.infer<typeof roomWizardSchema>;

export const areaSchema = z.object({
  id: z.uuid().optional(), // absent = create
  name: z.string().trim().min(1, "נדרש שם אזור").max(120),
  code: z
    .string()
    .trim()
    .max(40)
    .regex(/^[a-z0-9_-]*$/i, "קוד יכול להכיל אותיות לטיניות, ספרות ומקפים בלבד")
    .transform((s) => (s === "" ? null : s))
    .nullable(),
  area_type: z.enum(["lobby", "elevator", "corridor", "gym", "pool", "parking", "storage", "other"]),
  building_area_id: z.uuid().nullable(),
  floor: z.string().trim().max(20).nullable(),
  is_active: z.boolean(),
  relevant_cleaning: z.boolean(),
  relevant_maintenance: z.boolean(),
  status: z.enum(["ok", "maintenance", "cleaning", "blocked"]),
  status_note: z.string().trim().max(200).optional().nullable(),
  sort_order: z.number().int().min(0).max(10000),
  notes: longText.optional().nullable(),
});
export type AreaInput = z.infer<typeof areaSchema>;

// Board status popover (approved RoomsAndAreas interaction). "occupied" is
// derived from reservations and is NOT settable — deliberately absent here.
export const boardStatusSchema = z.object({
  room_id: z.uuid(),
  target: z.enum(["free", "dirty", "cleaning", "blocked", "maintenance"]),
});
export type BoardStatusInput = z.infer<typeof boardStatusSchema>;

export const areaStatusSchema = z.object({
  area_id: z.uuid(),
  status: z.enum(["ok", "cleaning", "maintenance", "blocked"]),
});
export type AreaStatusInput = z.infer<typeof areaStatusSchema>;

export const roomImageMetaSchema = z.object({
  id: z.uuid(),
  alt_text: z.string().trim().max(200).nullable(),
  is_main: z.boolean(),
  sort_order: z.number().int().min(0).max(1000),
});
export type RoomImageMetaInput = z.infer<typeof roomImageMetaSchema>;
