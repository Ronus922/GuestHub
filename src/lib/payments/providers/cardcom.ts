import "server-only";
import type {
  CardChargeRequest,
  CardChargeResult,
  PaymentGateway,
  TokenChargeRequest,
} from "../gateway";

// ============================================================
// Cardcom direct-API adapter (v11 Transactions/Transaction, server-to-server).
// ⚠️ UNVERIFIED WIRE FORMAT: written from Cardcom's published API; MUST be
// exercised against the sandbox/test terminal before any production charge.
// Sensitive values (PAN/CVV/token) travel ONLY inside the request body to
// Cardcom — never logged, never audited, never embedded in error strings;
// errors carry Cardcom's numeric ResponseCode alone.
// Success is ONLY ResponseCode 0 with a transaction id — anything else,
// including network/parse failures, fails closed (D46: no fabricated success).
// ============================================================

const ENDPOINT = "https://secure.cardcom.solutions/api/v11/Transactions/Transaction";

export interface CardcomConfig {
  terminal: number; // מספר מסוף
  apiName: string; // API username (שם משתמש API)
  apiPassword?: string; // required by some terminal configurations
}

interface CardcomResponse {
  ResponseCode?: number;
  Description?: string;
  TranzactionId?: number;
}

async function post(body: Record<string, unknown>): Promise<CardChargeResult> {
  let json: CardcomResponse;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    json = (await res.json()) as CardcomResponse;
  } catch {
    // network / timeout / non-JSON — the charge state is unknown → fail closed
    return { success: false, error: "שגיאת תקשורת מול קארדקום — החיוב לא אושר" };
  }
  if (json.ResponseCode === 0 && json.TranzactionId != null) {
    return { success: true, providerRef: String(json.TranzactionId) };
  }
  const code = typeof json.ResponseCode === "number" ? json.ResponseCode : "לא ידוע";
  return { success: false, error: `קארדקום דחה את החיוב (קוד ${code})` };
}

// ponytail: ILS-only — the hotel charges in ₪; add an ISOCoinId map only when a
// foreign-currency terminal actually exists.
const NOT_ILS = "נתמך חיוב בשקלים (ILS) בלבד";

export function createCardcomGateway(cfg: CardcomConfig): PaymentGateway {
  const base: Record<string, unknown> = {
    TerminalNumber: cfg.terminal,
    ApiName: cfg.apiName,
    ...(cfg.apiPassword ? { APIPassword: cfg.apiPassword } : {}),
  };
  return {
    id: "cardcom",
    async charge(req: CardChargeRequest): Promise<CardChargeResult> {
      if (req.currency !== "ILS") return { success: false, error: NOT_ILS };
      return post({
        ...base,
        Amount: req.amount,
        ISOCoinId: 1, // ILS
        CardNumber: req.pan,
        CardExpirationMMYY:
          String(req.expMonth).padStart(2, "0") + String(req.expYear % 100).padStart(2, "0"),
        ...(req.cvv ? { CVV2: req.cvv } : {}),
        CardOwnerName: req.holderName,
        ...(req.holderIdNumber ? { CardOwnerIdentityNumber: req.holderIdNumber } : {}),
        // unique per attempt (caller supplies) — Cardcom rejects a replayed id,
        // so a double-submit cannot double-charge
        ...(req.reference ? { ExternalUniqTranId: req.reference } : {}),
      });
    },
    async chargeToken(req: TokenChargeRequest): Promise<CardChargeResult> {
      if (req.currency !== "ILS") return { success: false, error: NOT_ILS };
      return post({
        ...base,
        Amount: req.amount,
        ISOCoinId: 1,
        Token: req.providerRef,
        ...(req.reference ? { ExternalUniqTranId: req.reference } : {}),
      });
    },
  };
}
