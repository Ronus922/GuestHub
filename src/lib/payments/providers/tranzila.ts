import "server-only";
import type {
  CardChargeRequest,
  CardChargeResult,
  PaymentGateway,
  TokenChargeRequest,
} from "../gateway";

// ============================================================
// Tranzila direct-API adapter (classic tranzila71u handshake, form-encoded).
// ⚠️ UNVERIFIED WIRE FORMAT: written from Tranzila's published API; MUST be
// exercised against the test terminal before any production charge.
// Sensitive values (PAN/CVV/token) travel ONLY inside the request body to
// Tranzila — never logged, never audited, never embedded in error strings;
// errors carry Tranzila's response code alone.
// Success is ONLY Response=000 — anything else, including network/parse
// failures, fails closed (D46: no fabricated success).
// ============================================================

const ENDPOINT = "https://secure5.tranzila.com/cgi-bin/tranzila71u.cgi";

export interface TranzilaConfig {
  supplier: string; // שם מסוף (supplier / terminal name)
  password?: string; // TranzilaPW — required for token (TranzilaTK) charges
}

async function post(fields: Record<string, string>): Promise<CardChargeResult> {
  let out: Record<string, string>;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    out = Object.fromEntries(new URLSearchParams(await res.text()));
  } catch {
    // network / timeout / unparsable — the charge state is unknown → fail closed
    return { success: false, error: "שגיאת תקשורת מול טרנזילה — החיוב לא אושר" };
  }
  if (out.Response === "000") {
    return { success: true, providerRef: out.index ?? out.ConfirmationCode ?? "000" };
  }
  return { success: false, error: `טרנזילה דחתה את החיוב (קוד ${out.Response ?? "לא ידוע"})` };
}

// ponytail: ILS-only (currency=1) — add a currency map only when a
// foreign-currency terminal actually exists.
const NOT_ILS = "נתמך חיוב בשקלים (ILS) בלבד";

export function createTranzilaGateway(cfg: TranzilaConfig): PaymentGateway {
  const base: Record<string, string> = {
    supplier: cfg.supplier,
    ...(cfg.password ? { TranzilaPW: cfg.password } : {}),
  };
  return {
    id: "tranzila",
    async charge(req: CardChargeRequest): Promise<CardChargeResult> {
      if (req.currency !== "ILS") return { success: false, error: NOT_ILS };
      return post({
        ...base,
        tranmode: "A", // regular immediate charge
        sum: String(req.amount),
        currency: "1", // ILS
        ccno: req.pan,
        expdate:
          String(req.expMonth).padStart(2, "0") + String(req.expYear % 100).padStart(2, "0"),
        ...(req.cvv ? { mycvv: req.cvv } : {}),
        contact: req.holderName,
        ...(req.holderIdNumber ? { myid: req.holderIdNumber } : {}),
        ...(req.reference ? { remarks: req.reference } : {}),
      });
    },
    async chargeToken(req: TokenChargeRequest): Promise<CardChargeResult> {
      if (req.currency !== "ILS") return { success: false, error: NOT_ILS };
      // token charges are rejected by Tranzila without the terminal password —
      // fail closed here with a clear config error instead of a cryptic decline
      if (!cfg.password) {
        return { success: false, error: "חיוב בטוקן דורש הגדרת TRANZILA_PASSWORD בשרת" };
      }
      return post({
        ...base,
        tranmode: "A",
        sum: String(req.amount),
        currency: "1",
        TranzilaTK: req.providerRef,
        ...(req.expMonth && req.expYear
          ? {
              expdate:
                String(req.expMonth).padStart(2, "0") + String(req.expYear % 100).padStart(2, "0"),
            }
          : {}),
        ...(req.reference ? { remarks: req.reference } : {}),
      });
    },
  };
}
