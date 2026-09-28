// ============================================================
// Room completeness — the closed key set, labels and wizard targets
// (owner decision D197 §D-D). Client-safe: no DB, no server-only import.
// The server-side evaluation lives in ./completeness.ts (ONE function, used
// by the rooms list and the room wizard alike).
//
// Criteria (all required for a "complete" room):
//   1. at least one photo                 → photo
//   2. size in sqm                         → size_sqm
//   3. Hebrew name + Hebrew description    → name_he, description_he
//   4. English name + description          → name_en, description_en
//   5. Arabic name + description           → name_ar, description_ar
//   6. slug (the website reads lang=he)    → slug
//   7. resolved occupancy — room value, else room-type value, the SAME
//      resolution the booking engine uses (getRoomCapacities); "missing"
//      means the engine would fall back to its hardcoded default → occupancy
// ============================================================

export const ROOM_MISSING_KEYS = [
  "photo",
  "size_sqm",
  "name_he",
  "description_he",
  "name_en",
  "description_en",
  "name_ar",
  "description_ar",
  "slug",
  "occupancy",
] as const;

export type RoomMissingKey = (typeof ROOM_MISSING_KEYS)[number];

export type RoomCompleteness = { missing: RoomMissingKey[]; count: number };

export const ROOM_MISSING_LABEL: Record<RoomMissingKey, string> = {
  photo: "תמונה אחת לפחות",
  size_sqm: "גודל במ״ר",
  name_he: "שם בעברית",
  description_he: "תיאור בעברית",
  name_en: "שם באנגלית",
  description_en: "תיאור באנגלית",
  name_ar: "שם בערבית",
  description_ar: "תיאור בערבית",
  slug: "כתובת URL (slug)",
  occupancy: "תפוסה מקסימלית",
};

// Where the wizard has to go so the owner can fill the item: step, the
// editing language (for per-language fields) and the DOM id of the field.
export type RoomMissingTarget = { step: 1 | 2 | 3; lang?: "he" | "en" | "ar"; field: string };

export const ROOM_MISSING_TARGET: Record<RoomMissingKey, RoomMissingTarget> = {
  photo: { step: 2, field: "rm-f-images" },
  size_sqm: { step: 2, field: "rm-f-size_sqm" },
  name_he: { step: 1, lang: "he", field: "rm-f-name" },
  description_he: { step: 1, lang: "he", field: "rm-f-description" },
  name_en: { step: 1, lang: "en", field: "rm-f-name" },
  description_en: { step: 1, lang: "en", field: "rm-f-description" },
  name_ar: { step: 1, lang: "ar", field: "rm-f-name" },
  description_ar: { step: 1, lang: "ar", field: "rm-f-description" },
  slug: { step: 3, lang: "he", field: "rm-f-slug" },
  occupancy: { step: 1, field: "rm-f-max_occupancy" },
};
