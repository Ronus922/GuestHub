// Phone normalization (D53). The messaging layer needs one canonical form for a
// guest phone. Israeli-first (the property default), but any already-E.164
// international number passes through. Pure + unit-checkable (see demo() below).

export type NormalizedPhone = {
  e164: string; // "+972525460546"
  digits: string; // "972525460546"  (E.164 without "+", green-api chatId prefix)
  whatsapp: string; // "whatsapp:+972525460546"  (Twilio "to" form)
  valid: boolean;
};

const DEFAULT_CC = "972"; // Israel

// Best-effort normalization. Handles: local "052-546-0546" / "0525460546",
// "+972 52 546 0546", "00972…", bare "972…". Falls back to a generic E.164
// cleanup for other country codes.
export function normalizePhone(raw: string | null | undefined, defaultCc = DEFAULT_CC): NormalizedPhone {
  const empty: NormalizedPhone = { e164: "", digits: "", whatsapp: "", valid: false };
  if (!raw) return empty;

  const hadPlus = raw.trim().startsWith("+");
  let d = raw.replace(/\D/g, "");
  if (!d) return empty;

  // 00-prefixed international → drop it
  if (d.startsWith("00")) d = d.slice(2);
  else if (!hadPlus && d.startsWith("0")) {
    // national trunk "0" → default country code
    d = defaultCc + d.slice(1);
  } else if (!hadPlus && !d.startsWith(defaultCc) && d.length <= 9) {
    // bare local number without trunk 0 (e.g. "525460546") → prepend cc
    d = defaultCc + d;
  }
  // else: already has a country code (had "+" or starts with a cc)

  const valid = d.length >= 8 && d.length <= 15;
  return {
    e164: "+" + d,
    digits: d,
    whatsapp: "whatsapp:+" + d,
    valid,
  };
}

// Stricter: an Israeli MOBILE (972 + 5X + 7 digits). WhatsApp needs a mobile.
export function isIsraeliMobile(raw: string | null | undefined): boolean {
  const n = normalizePhone(raw);
  return n.valid && /^9725\d{8}$/.test(n.digits);
}

// GREEN-API chatId for a personal number: "<digits>@c.us"
export function greenApiChatId(raw: string | null | undefined): string | null {
  const n = normalizePhone(raw);
  return n.valid ? `${n.digits}@c.us` : null;
}
