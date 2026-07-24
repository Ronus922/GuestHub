// ============================================================
// PURE channel payload helpers — no imports, no DB, no HTTP.
//
// The room-type-keyed ARI builders that used to live here (buildAvailabilityPayloads,
// buildRatePayloads, validateAriPayload and the pooled input mapper) were deleted by D68:
// they pooled several sellable units into one channel "room type" and published the
// lexicographically-first unit's price for the whole pool. That model predates D64,
// which fixed the inventory unit as the individual physical room. The replacements
// live in ./ari-payloads.ts and are keyed by room and by (room × rate plan).
//
// What remains is inbound-only and still in use: payload redaction for stored
// webhook bodies, and card extraction for channel booking revisions.
// ============================================================

// Redaction (§Z): payment-ish fields are stripped BEFORE any payload is
// persisted or logged. Applied to webhook bodies and booking revisions.
// raw_message (D76) is the OTA's original message blob — it embeds masked
// card text and duplicates the structured fields, so it is never stored.
const SENSITIVE_KEY_RE =
  /card|cvv|cvc|pan\b|security_code|guarantee|payment_info|credit|raw_message/i;

export function redactPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPayload);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : redactPayload(v);
    }
    return out;
  }
  return value;
}

// ---- Channel card extraction (§Z reconciliation, D42) ----
// PURE parse of a raw inbound booking payload into normalized card fields. NO
// crypto, NO storage — encryption + persistence live server-only in
// src/lib/channel/card-ingest.ts. This runs on the RAW payload BEFORE
// redactPayload() strips card fields from the stored/logged revision, so the
// PAN is lifted into the encrypted vault and never survives in a log. The CVV is
// deliberately NOT extracted (D52 §2): it is never carried, encrypted or stored.
export type ChannelCardData = {
  holderName: string | null;
  pan: string | null;
  expMonth: number | null;
  expYear: number | null;
  brand: string | null;
  isVirtual: boolean;
  availableFrom: string | null; // DateOnly, channel-supplied availability window
  availableUntil: string | null;
};

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

// Accepts "MM/YY", "MM/YYYY", "MM-YY", "YYYY-MM" and explicit month/year fields.
function parseChannelExpiry(
  obj: Record<string, unknown>,
): { month: number | null; year: number | null } {
  const explicitM = Number(obj.exp_month ?? obj.expiry_month ?? obj.expiration_month);
  const explicitY = Number(obj.exp_year ?? obj.expiry_year ?? obj.expiration_year);
  if (Number.isInteger(explicitM) && Number.isInteger(explicitY)) {
    return { month: explicitM, year: explicitY < 100 ? 2000 + explicitY : explicitY };
  }
  const raw = firstString(obj, ["expiration_date", "expiry_date", "expire_date", "expiration", "expiry"]);
  if (!raw) return { month: null, year: null };
  const parts = raw.split(/[/\-.]/).map((s) => Number(s.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return { month: null, year: null };
  let [a, b] = parts;
  // YYYY-MM vs MM/YY(YY)
  if (a > 12) [a, b] = [b, a];
  const month = a;
  const year = b < 100 ? 2000 + b : b;
  if (month < 1 || month > 12) return { month: null, year: null };
  return { month, year };
}

// A GENUINELY masked card value ("375516*****1144") → its trailing four
// digits, for masked-metadata display (D76 §8). Returns null for anything that
// could be an actual PAN (all digits) — a near-PAN is discarded, never stored.
export function maskedCardLast4(value: string | null): string | null {
  if (!value) return null;
  const compact = value.replace(/\s/g, "");
  if (/^\d+$/.test(compact)) return null; // not masked — never treat as display
  const m = compact.match(/(\d{4})$/);
  return m ? m[1] : null;
}

export function extractChannelCard(payload: unknown): ChannelCardData | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  // the card object may sit under several common keys
  const card =
    [root.credit_card, root.card, root.payment_card, root.guarantee, root.payment].find(
      (v) => v && typeof v === "object",
    ) ?? root;
  const obj = card as Record<string, unknown>;

  const pan = firstString(obj, ["card_number", "number", "pan", "cardNumber"]);
  // CVV is intentionally NOT read from the payload (D52 §2) — redactPayload()
  // still scrubs it from the stored revision via SENSITIVE_KEY_RE.
  const holderName = firstString(obj, ["cardholder_name", "holder_name", "name", "cardHolder"]);
  const brand = firstString(obj, ["card_type", "brand", "type", "scheme"]);
  const { month, year } = parseChannelExpiry(obj);
  const availableFrom = firstString(obj, ["available_from", "activation_date", "valid_from"]);
  const availableUntil = firstString(obj, [
    "available_until",
    "expiration",
    "valid_until",
    "deadline",
  ]);
  const virtualRaw = obj.is_virtual ?? obj.virtual_card ?? obj.virtual ?? obj.vcc;
  const isVirtual = virtualRaw === true || virtualRaw === "true" || virtualRaw === 1;

  // nothing card-like present → no card (not an empty stub)
  if (!pan && !holderName && month === null) return null;
  return {
    holderName,
    pan,
    expMonth: month,
    expYear: year,
    brand,
    isVirtual,
    availableFrom,
    availableUntil,
  };
}
