// Pure card-input rules shared by the card form, the guarded server actions
// and scripts/check-cards.mjs. NO storage, NO crypto here — encryption lives
// server-only in src/lib/card-vault.ts. CVV/CVC is deliberately absent from
// every type, validator and formatter in this module: as of D52 it is never
// collected for storage, never persisted and never revealed anywhere. A CVV may
// exist only transiently inside a single PSP authorization request (the gateway
// seam) and is discarded immediately — it never flows through these rules.

import { CARD_BRAND_LABEL } from "./payments/collection-labels";

export type CardBrand = "visa" | "mastercard" | "amex" | "diners" | "other";

// Where a stored card's details came from. 'channel' is set only by the
// server-side channel ingest — the manual entry form offers the rest.
export type CardSource =
  | "manual"
  | "telephone"
  | "walk_in"
  | "website"
  | "back_office"
  | "channel";

// sources a human may pick in the manual entry form (never 'channel')
export const MANUAL_CARD_SOURCES: readonly CardSource[] = [
  "back_office",
  "telephone",
  "walk_in",
  "website",
];

export const CARD_SOURCE_LABEL: Record<CardSource, string> = {
  manual: "הזנה ידנית",
  telephone: "טלפונית",
  walk_in: "מזדמן (Walk-in)",
  website: "אתר ישיר",
  back_office: "משרד (Back-office)",
  channel: "ערוץ חיצוני",
};

// digits only, grouped in 4s, max 19 digits (PAN upper bound)
export function formatCardNumber(v: string): string {
  return (v.match(/\d/g) ?? []).slice(0, 19).join("").replace(/(\d{4})(?=\d)/g, "$1 ");
}

export function formatExpiry(v: string): string {
  const d = (v.match(/\d/g) ?? []).slice(0, 4).join("");
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
}

export function normalizePan(v: string): string {
  return (v.match(/\d/g) ?? []).join("");
}

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function panValid(digits: string): boolean {
  return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
}

export function detectBrand(digits: string): CardBrand {
  if (/^4/.test(digits)) return "visa";
  if (/^(5[1-5]|2[2-7])/.test(digits)) return "mastercard";
  if (/^3[47]/.test(digits)) return "amex";
  if (/^3(0[0-5]|[689])/.test(digits)) return "diners";
  return "other";
}

export const BRAND_LABEL: Record<CardBrand, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  diners: "Diners",
  other: "כרטיס",
};

// masked display — the ONLY card-number form the normal UI ever renders
export function maskedPan(last4: string): string {
  return `•••• •••• •••• ${last4}`;
}

// ============================================================
// ONE canonical card view model (D86).
//
// A reservation's card can come from three places — a stored card in the vault
// (reservation_cards), a masked channel guarantee imported with an OTA booking
// (channel_booking_revisions.card_meta), or manual entry. Before D86 each one
// had its OWN presentation, and an OTA booking rendered two competing card
// interfaces at once. They now all resolve, HERE, into a single view model that
// feeds the single canonical field set (שם בעל הכרטיס · מספר כרטיס · תוקף ·
// תעודת זהות · מקור פרטי הכרטיס · הערת חיוב).
//
// Rules this function enforces:
//   • precedence: manual opt-in > stored card > channel guarantee > empty
//   • values are DISPLAY strings — a missing value stays empty, never invented
//     (no digits are ever reconstructed from a masked fragment)
//   • the number is the masked representation; the plaintext PAN appears only
//     when the caller passes an already-authorized `revealed` bundle
//   • brand / virtual / availability / collection state are SUBORDINATE helper
//     metadata, never a second copy of holder-number-expiry
// ============================================================

/** vault card (structural mirror of StoredCardMeta — no server import here) */
export type StoredCardInput = {
  brand: string | null;
  last4: string;
  expMonth: number;
  expYear: number;
  holderName: string;
  holderIdNumber?: string | null;
  source: CardSource;
  sourceChannel: string | null;
  isVirtual: boolean;
  availableUntil: string | null;
  billingNotes: string | null;
};

/** masked channel guarantee (structural mirror of GuaranteeMeta) */
export type ChannelCardInput = {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  holderName: string | null;
  maskedDisplay: string | null;
  isVirtual: boolean;
  availableFrom: string | null;
  availableUntil: string | null;
};

/** plaintext bundle from the audited reveal — never fetched by this module */
export type RevealedCardInput = {
  pan: string;
  holderName: string;
  holderIdNumber: string | null;
  expMonth: number;
  expYear: number;
};

export type CardViewOrigin = "stored" | "channel" | "manual" | "empty";

export type CardView = {
  origin: CardViewOrigin;
  /** true → the fields are the editable manual draft; false → read-only values */
  editable: boolean;
  holder: string;
  /** masked (•••• •••• •••• 1111) unless an authorized reveal was passed in */
  number: string;
  exp: string; // MM/YY — the format the manual field already uses
  idNumber: string;
  billingNotes: string;
  /** read-only source label; empty when `editable` (the source <select> shows instead) */
  sourceLabel: string;
  brandLabel: string | null;
  isVirtual: boolean;
  availableFrom: string | null;
  availableUntil: string | null;
  /** one subordinate status line inside the same section (never a second card) */
  helper: string | null;
};

/** Brand display for BOTH vocabularies: our internal keys (visa/amex, from
 *  detectBrand) and the 2-letter channel codes (VI/AX, from Channex). Unknown
 *  codes display verbatim — never as a wrong brand. */
function brandDisplay(code: string | null): string | null {
  if (!code) return null;
  const internal = BRAND_LABEL[code.toLowerCase() as CardBrand];
  if (internal) return internal;
  return CARD_BRAND_LABEL[code.toUpperCase()] ?? code;
}

function expDisplay(month: number | null, year: number | null): string {
  if (month == null || year == null) return "";
  return `${String(month).padStart(2, "0")}/${String(year % 100).padStart(2, "0")}`;
}

export function resolveCardView(input: {
  stored?: StoredCardInput | null;
  channel?: ChannelCardInput | null;
  /** display name of the originating channel, e.g. "Booking.com" */
  channelName?: string | null;
  /** honest collection state (COLLECTION_LABEL) — appended to the helper line */
  stateLabel?: string | null;
  draft: CardDraftInput;
  /** operator explicitly chose to key a card in instead of the imported/stored one */
  manualEntry?: boolean;
  revealed?: RevealedCardInput | null;
}): CardView {
  const { stored, channel, draft, manualEntry, revealed } = input;

  // 1 — the operator asked to type a card in, or there is nothing to show:
  //     the fields ARE the draft (this is also the empty state)
  if (manualEntry || (!stored && !channel)) {
    const touched =
      draft.holder.trim() !== "" ||
      draft.number.trim() !== "" ||
      draft.exp.trim() !== "" ||
      draft.idNum.trim() !== "";
    return {
      origin: touched || manualEntry ? "manual" : "empty",
      editable: true,
      holder: draft.holder,
      number: draft.number,
      exp: draft.exp,
      idNumber: draft.idNum,
      billingNotes: draft.billingNotes,
      sourceLabel: "",
      brandLabel: draft.number.trim() ? BRAND_LABEL[detectBrand(normalizePan(draft.number))] : null,
      isVirtual: false,
      availableFrom: null,
      availableUntil: null,
      helper: null,
    };
  }

  // 2 — a real card lives in the vault (a channel-ingested PAN also lands here)
  if (stored) {
    const fromChannel = stored.source === "channel";
    const sourceLabel = fromChannel
      ? stored.sourceChannel
        ? `${CARD_SOURCE_LABEL.channel} · ${stored.sourceChannel}`
        : CARD_SOURCE_LABEL.channel
      : CARD_SOURCE_LABEL[stored.source] ?? stored.source;
    const id = revealed ? revealed.holderIdNumber : (stored.holderIdNumber ?? null);
    return {
      origin: "stored",
      editable: false,
      holder: revealed?.holderName ?? stored.holderName,
      number: revealed ? formatCardNumber(revealed.pan) : maskedPan(stored.last4),
      exp: revealed
        ? expDisplay(revealed.expMonth, revealed.expYear)
        : expDisplay(stored.expMonth, stored.expYear),
      idNumber: id ?? "",
      billingNotes: stored.billingNotes ?? "",
      sourceLabel,
      brandLabel: brandDisplay(stored.brand),
      isVirtual: stored.isVirtual,
      availableFrom: null,
      availableUntil: stored.availableUntil,
      helper: [
        fromChannel && stored.sourceChannel
          ? `פרטי הכרטיס התקבלו מ־${stored.sourceChannel}`
          : "כרטיס שמור מוצפן",
        input.stateLabel ?? null,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }

  // 3 — only the masked channel guarantee arrived: show exactly what arrived
  const g = channel!;
  const name = input.channelName?.trim() || "הערוץ";
  const number = g.last4 ? maskedPan(g.last4) : (g.maskedDisplay ?? "");
  const exp = expDisplay(g.expMonth, g.expYear);
  // "partial" is an honest statement about the data, not a defect
  const complete = Boolean(g.holderName && number && exp);
  return {
    origin: "channel",
    editable: false,
    holder: g.holderName ?? "",
    number,
    exp,
    idNumber: "", // no channel supplies a cardholder ID — the field stays empty
    billingNotes: "",
    sourceLabel: `${CARD_SOURCE_LABEL.channel} · ${name}`,
    brandLabel: brandDisplay(g.brand),
    isVirtual: g.isVirtual,
    availableFrom: g.availableFrom,
    availableUntil: g.availableUntil,
    helper: [
      complete
        ? `פרטי הכרטיס התקבלו מ־${name}`
        : `פרטי הכרטיס התקבלו חלקית מ־${name}`,
      input.stateLabel ?? null,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

/** manual-entry draft (structural mirror of CardDraft in CardFields.tsx) */
export type CardDraftInput = {
  holder: string;
  number: string;
  exp: string;
  idNum: string;
  billingNotes: string;
};

// expiry must parse as a real month and not be in the past relative to `now`
export function parseExpiry(exp: string): { month: number; year: number } | null {
  const m = /^(\d{2})\/(\d{2})$/.exec(exp);
  if (!m) return null;
  const month = Number(m[1]);
  if (month < 1 || month > 12) return null;
  return { month, year: 2000 + Number(m[2]) };
}

export function expiryInPast(month: number, year: number, now: Date): boolean {
  const y = now.getFullYear();
  const mm = now.getMonth() + 1;
  return year < y || (year === y && month < mm);
}
