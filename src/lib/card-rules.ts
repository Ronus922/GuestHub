// Pure card-input rules shared by the card form, the guarded server actions
// and scripts/check-cards.mjs. NO storage, NO crypto here — encryption lives
// server-only in src/lib/card-vault.ts. CVV is deliberately absent from every
// type in this module: it is never persisted anywhere (D41).

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

// CVV is collected transiently for an immediate charge ONLY — never stored,
// never encrypted at rest, never logged. Shape check only (3–4 digits).
export function cvvValid(v: string): boolean {
  return /^\d{3,4}$/.test(v);
}

export function formatCvv(v: string): string {
  return (v.match(/\d/g) ?? []).slice(0, 4).join("");
}

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

// masked CVV placeholder — the plaintext CVV is shown only after an explicit,
// permission-guarded, audited reveal
export function maskedCvv(): string {
  return "•••";
}

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
