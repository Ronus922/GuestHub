import "server-only";

// ============================================================
// Payment-gateway seam (D46). GuestHub has NO PSP integrated today, so
// getPaymentGateway() returns null and card charging fails closed. A real
// provider implements PaymentGateway and getPaymentGateway() returns it
// (keyed off env) — the reservation UI and the card actions' call sites
// already handle null, so connecting a PSP later needs NO UI rebuild.
// ============================================================

export interface CardChargeRequest {
  amount: number; // whole currency units (e.g. ₪)
  currency: string; // ISO 4217, e.g. "ILS"
  pan: string;
  expMonth: number;
  expYear: number;
  // TRANSIENT ONLY (D52 §2): a CVV may ride a single live authorization request
  // to the PSP and MUST be discarded immediately after — never persisted, logged,
  // audited or returned. Prefer provider hosted-fields/tokenization so the CVV
  // never reaches this server at all.
  cvv?: string | null;
  holderName: string;
  holderIdNumber?: string | null;
  reference?: string; // our reservation/charge reference
}

export interface CardChargeResult {
  success: boolean;
  providerRef?: string; // gateway transaction id, on success
  error?: string;
}

export interface PaymentGateway {
  readonly id: string;
  charge(req: CardChargeRequest): Promise<CardChargeResult>;
}

// The single place a real PSP is wired in. Returns null until one exists.
export function getPaymentGateway(): PaymentGateway | null {
  // ponytail: no provider integrated yet. Construct and return the real
  // gateway here (from env) when one lands — nothing else changes.
  return null;
}

export function paymentGatewayConfigured(): boolean {
  return getPaymentGateway() !== null;
}

// Shown wherever a live charge is offered but no provider is configured.
export const NO_GATEWAY_MESSAGE = "לא מוגדר ספק סליקה פעיל";
