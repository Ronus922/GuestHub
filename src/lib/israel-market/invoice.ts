import "server-only";

// ============================================================
// Invoice / receipt external seam (Stage 5 §21).
//
// Israeli law requires a חשבונית מס / קבלה for money collected. GuestHub does not
// issue tax documents itself; it delegates to an external, government-approved
// provider (Green Invoice / EZcount class). This module is the PROVIDER-NEUTRAL
// seam: a typed interface the reservation/payment flow calls, plus a default
// "unconfigured" provider that fails honestly until a real provider is wired.
//
// Wiring a concrete provider (API key + allocated document numbers) is a
// deployment dependency (V2 §2), not built here. The seam guarantees the rest of
// the app is already invoice-ready and the integration is a single implementation.
// ============================================================

export type TaxDocumentKind = "invoice" | "receipt" | "invoice_receipt";

export type IssueDocumentRequest = {
  tenantId: string;
  reservationId: string;
  kind: TaxDocumentKind;
  amount: number;
  currency: string;
  taxExempt: boolean; // tourist zero-rating (§21) — provider issues a 0%-VAT doc
  customer: { name: string; email?: string | null; country?: string | null; taxId?: string | null };
  lines: Array<{ description: string; amount: number }>;
};

export type IssueDocumentResult =
  | { ok: true; documentId: string; documentNumber: string; url?: string | null }
  | { ok: false; error: string; category: "not_configured" | "provider_error" | "validation" };

export interface InvoiceProvider {
  readonly name: string;
  isConfigured(): boolean;
  issue(req: IssueDocumentRequest): Promise<IssueDocumentResult>;
}

// The default provider: nothing is wired, so every issue attempt fails closed
// with a clear, honest reason — never a fabricated document number.
class UnconfiguredInvoiceProvider implements InvoiceProvider {
  readonly name = "unconfigured";
  isConfigured(): boolean {
    return false;
  }
  async issue(): Promise<IssueDocumentResult> {
    return {
      ok: false,
      category: "not_configured",
      error: "לא הוגדר ספק חשבוניות — יש לחבר ספק (Green Invoice/EZcount) לפני הפקת מסמך מס",
    };
  }
}

let provider: InvoiceProvider = new UnconfiguredInvoiceProvider();

// A concrete provider registers itself here at wiring time (deployment concern).
export function setInvoiceProvider(p: InvoiceProvider): void {
  provider = p;
}

export function getInvoiceProvider(): InvoiceProvider {
  return provider;
}

// Validate + delegate. Callers never touch a provider directly, so the fail-closed
// + validation contract holds regardless of which provider is wired.
export async function issueTaxDocument(req: IssueDocumentRequest): Promise<IssueDocumentResult> {
  if (!(req.amount > 0)) return { ok: false, category: "validation", error: "סכום המסמך חייב להיות חיובי" };
  if (!req.customer?.name?.trim()) return { ok: false, category: "validation", error: "נדרש שם לקוח למסמך המס" };
  if (!provider.isConfigured()) return provider.issue(req); // returns the honest not_configured error
  return provider.issue(req);
}
