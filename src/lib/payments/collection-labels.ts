// ============================================================
// Collection-state vocabulary (D77 §14) — PURE module (no server-only):
// shared by the server derivation (./collection) and the client display
// (EditReservationPanel collection box, /reservations list).
// ============================================================

export type CollectionState =
  | "ota_collected"
  | "property_tokenized"
  | "property_masked_only"
  | "no_card_or_other_method";

export const COLLECTION_LABEL: Record<CollectionState, string> = {
  ota_collected: "נגבה על ידי הערוץ",
  property_tokenized: "אמצעי תשלום מאובטח קיים",
  property_masked_only: "כרטיס ממוסך בלבד — אינו זמין כרגע לחיוב",
  no_card_or_other_method: "ללא כרטיס / אמצעי אחר",
};

/** who collects — verbatim channel value → Hebrew */
export const COLLECT_OWNER_LABEL: Record<string, string> = {
  property: "המלון גובה",
  ota: "הערוץ גובה",
};

/** channel payment_type → Hebrew method label */
export const PAYMENT_TYPE_LABEL: Record<string, string> = {
  credit_card: "אשראי",
  bank_transfer: "העברה בנקאית",
  cash: "מזומן",
};

/** channel card-brand codes → display name (unknown codes display verbatim) */
export const CARD_BRAND_LABEL: Record<string, string> = {
  AX: "American Express",
  VI: "Visa",
  MC: "Mastercard",
  CA: "Mastercard",
  DC: "Diners Club",
  JC: "JCB",
  DS: "Discover",
};

export function cardBrandLabel(code: string | null): string {
  if (!code) return "כרטיס";
  return CARD_BRAND_LABEL[code.toUpperCase()] ?? code;
}
