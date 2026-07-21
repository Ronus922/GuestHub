import "server-only";
import { createCardcomGateway } from "./providers/cardcom";
import { createTranzilaGateway } from "./providers/tranzila";

// ============================================================
// Payment-gateway seam (D46). The active PSP is keyed off env (PSP_PROVIDER →
// cardcom / tranzila adapter under ./providers). With no/partial config,
// getPaymentGateway() returns null and card charging fails closed — the
// reservation UI and the card actions' call sites all handle null, so turning
// clearing on is env-only: set the provider vars and restart. No UI rebuild.
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

// Allowed PSPs — mirrors the DB CHECK on reservation_payment_methods.provider
// (migration 051). Owner decision: Israeli direct-API clearing only, no Stripe.
export const PSP_PROVIDERS = ["cardcom", "tranzila"] as const;
export type PspProvider = (typeof PSP_PROVIDERS)[number];

// Charge a PSP-stored token (reservation_payment_methods.provider_ref) instead
// of a raw PAN. provider is carried so a token is never sent to the wrong
// processor — a Cardcom token is meaningless at Tranzila and vice-versa.
export interface TokenChargeRequest {
  amount: number; // whole currency units (e.g. ₪)
  currency: string; // ISO 4217, e.g. "ILS"
  provider: PspProvider;
  providerRef: string; // the PSP token, never logged verbatim
  // some processors (Tranzila TK) want the card expiry alongside the token —
  // pass it when known (reservation_payment_methods.exp_month/exp_year)
  expMonth?: number;
  expYear?: number;
  reference?: string; // our reservation/charge reference
}

export interface PaymentGateway {
  readonly id: PspProvider;
  charge(req: CardChargeRequest): Promise<CardChargeResult>;
  chargeToken(req: TokenChargeRequest): Promise<CardChargeResult>;
}

// ---- env-keyed provider resolution (שלב 3) ----
// PSP_PROVIDER selects the active processor; unset → no gateway, every charge
// fails closed (the pre-PSP behavior). Credentials per provider:
//   cardcom : CARDCOM_TERMINAL, CARDCOM_API_NAME [, CARDCOM_API_PASSWORD]
//   tranzila: TRANZILA_TERMINAL [, TRANZILA_PASSWORD — required for token charges]
// Partial config also resolves to null — a charge must never guess credentials.

let cached: PaymentGateway | null | undefined;

// The single place a real PSP is wired in. Returns null until one is configured.
export function getPaymentGateway(): PaymentGateway | null {
  if (cached === undefined) cached = buildGateway();
  return cached;
}

function buildGateway(): PaymentGateway | null {
  const provider = process.env.PSP_PROVIDER;
  if (!provider) return null; // no PSP configured — fail closed
  if (provider === "cardcom") {
    const terminal = Number(process.env.CARDCOM_TERMINAL);
    const apiName = process.env.CARDCOM_API_NAME;
    if (!Number.isInteger(terminal) || terminal <= 0 || !apiName) return misconfigured(provider);
    return createCardcomGateway({
      terminal,
      apiName,
      apiPassword: process.env.CARDCOM_API_PASSWORD,
    });
  }
  if (provider === "tranzila") {
    const supplier = process.env.TRANZILA_TERMINAL;
    if (!supplier) return misconfigured(provider);
    return createTranzilaGateway({ supplier, password: process.env.TRANZILA_PASSWORD });
  }
  return misconfigured(provider);
}

function misconfigured(provider: string): null {
  // fail closed + one loud server-side line; never crash the app over PSP config
  console.error(`[payments] PSP_PROVIDER="${provider}" מוגדר אך פרטי ההתחברות חסרים/שגויים — הסליקה כבויה`);
  return null;
}

export function paymentGatewayConfigured(): boolean {
  return getPaymentGateway() !== null;
}

// Shown wherever a live charge is offered but no provider is configured.
export const NO_GATEWAY_MESSAGE = "לא מוגדר ספק סליקה פעיל";
