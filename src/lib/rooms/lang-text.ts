// ============================================================
// Language-aware text helpers for room content — shared by the public
// website catalog (src/lib/public-booking/rooms.ts) and the room
// completeness function (src/lib/rooms/completeness.ts), so "is this text
// really Hebrew/Arabic" is decided in exactly one place.
//
// A row in room_translations is not proof of a translation: the app seeds it
// from the room's internal name, so the "he" row of most rooms still holds the
// English PMS label. Text that carries none of the language's own script is
// treated as untranslated.
// ============================================================

export type RoomLang = "he" | "en" | "ar";

const SCRIPT: Record<RoomLang, RegExp | null> = {
  he: /[֐-׿]/,
  ar: /[؀-ۿ]/,
  en: null,
};

export const trimmed = (s: string | null | undefined): string | null => {
  const v = s?.trim();
  return v ? v : null;
};

// Text that is usable AS the requested language (see SCRIPT above).
export const inLang = (s: string | null | undefined, lang: RoomLang): string | null => {
  const v = trimmed(s);
  const script = SCRIPT[lang];
  return v && (!script || script.test(v)) ? v : null;
};
