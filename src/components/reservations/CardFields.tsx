"use client";

import { Icon } from "@/components/shared/Icon";

// פרטי כרטיס אשראי (reference .ccbox: booking-window.html step 3 +
// edit-booking-modal.png), shown only when the selected payment method is
// credit_card.
//
// SECURITY (D40): the values live ONLY in transient client state. They are
// never sent to the server, never persisted, never logged, never placed in
// a URL and never included in any action payload — GuestHub has no
// tokenized payment provider, so the truthful behavior is client-side
// format validation only. The reference's "סלוק עכשיו" button is rendered
// permanently disabled (no gateway → no charge, no fabricated success),
// and entering card details never changes payment status or amounts.

export type CardDraft = {
  holder: string;
  number: string;
  exp: string;
  cvv: string;
  idNum: string;
};

export const EMPTY_CARD: CardDraft = { holder: "", number: "", exp: "", cvv: "", idNum: "" };

export function luhnValid(digits: string): boolean {
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

// digits only, grouped in 4s, max 19 digits (PAN upper bound)
export function formatCardNumber(v: string): string {
  return (v.match(/\d/g) ?? []).slice(0, 19).join("").replace(/(\d{4})(?=\d)/g, "$1 ");
}

export function formatExpiry(v: string): string {
  const d = (v.match(/\d/g) ?? []).slice(0, 4).join("");
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
}

function expiryBad(exp: string): boolean {
  if (!exp) return false;
  const m = /^(\d{2})\/(\d{2})$/.exec(exp);
  if (!m) return true;
  const month = Number(m[1]);
  if (month < 1 || month > 12) return true;
  const now = new Date();
  const yy = now.getFullYear() % 100;
  const mm = now.getMonth() + 1;
  const y = Number(m[2]);
  return y < yy || (y === yy && month < mm);
}

export function CardFields({
  value,
  onChange,
  chargeAmount,
}: {
  value: CardDraft;
  onChange: (c: CardDraft) => void;
  chargeAmount: number;
}) {
  const digits = value.number.replace(/\D/g, "");
  const numberBad = digits.length > 0 && (digits.length < 13 || !luhnValid(digits));
  const cvvBad = value.cvv.length > 0 && !/^\d{3,4}$/.test(value.cvv);
  const idBad = value.idNum.length > 0 && !/^\d{5,9}$/.test(value.idNum);

  return (
    <div className="bw-ccbox">
      <div className="bw-cc-top">
        <Icon name="credit-card" size={19} />
        פרטי כרטיס אשראי
      </div>
      <div className="bw-grid2">
        <label className="bw-fg">
          <span className="bw-lbl">
            שם בעל הכרטיס <span className="bw-req">*</span>
          </span>
          <input
            className="bw-fld"
            placeholder="שם כפי שמופיע על הכרטיס"
            autoComplete="off"
            value={value.holder}
            onChange={(e) => onChange({ ...value, holder: e.target.value })}
          />
        </label>
        <label className="bw-fg">
          <span className="bw-lbl">
            מספר כרטיס <span className="bw-req">*</span>
          </span>
          <div className="bw-fld-wrap">
            <Icon name="credit-card" size={17} className="bw-fi" />
            <input
              className={`bw-fld ic ${numberBad ? "bad" : ""}`}
              dir="ltr"
              inputMode="numeric"
              placeholder="0000 0000 0000 0000"
              autoComplete="off"
              value={value.number}
              onChange={(e) => onChange({ ...value, number: formatCardNumber(e.target.value) })}
            />
          </div>
        </label>
      </div>
      <div className="bw-grid3 mt-4">
        <label className="bw-fg">
          <span className="bw-lbl">
            תוקף <span className="bw-req">*</span>
          </span>
          <input
            className={`bw-fld ${expiryBad(value.exp) ? "bad" : ""}`}
            dir="ltr"
            inputMode="numeric"
            placeholder="MM/YY"
            autoComplete="off"
            value={value.exp}
            onChange={(e) => onChange({ ...value, exp: formatExpiry(e.target.value) })}
          />
        </label>
        <label className="bw-fg">
          <span className="bw-lbl">
            CVV <span className="bw-req">*</span>
          </span>
          <input
            className={`bw-fld ${cvvBad ? "bad" : ""}`}
            dir="ltr"
            type="password"
            inputMode="numeric"
            placeholder="3 ספרות"
            autoComplete="off"
            maxLength={4}
            value={value.cvv}
            onChange={(e) => onChange({ ...value, cvv: e.target.value.replace(/\D/g, "") })}
          />
        </label>
        <label className="bw-fg">
          <span className="bw-lbl">
            תעודת זהות <span className="bw-opt">(לא חובה)</span>
          </span>
          <input
            className={`bw-fld ${idBad ? "bad" : ""}`}
            dir="ltr"
            inputMode="numeric"
            placeholder="9 ספרות"
            autoComplete="off"
            maxLength={9}
            value={value.idNum}
            onChange={(e) => onChange({ ...value, idNum: e.target.value.replace(/\D/g, "") })}
          />
        </label>
      </div>
      <div className="bw-cc-foot">
        <button
          type="button"
          className="bw-btn-charge"
          disabled
          title="לא מחובר ספק סליקה — אין אפשרות לחיוב מתוך המערכת"
        >
          <Icon name="finance" size={18} />
          סלוק עכשיו · ₪{Math.round(Math.max(0, chargeAmount)).toLocaleString()}
        </button>
        <span className="bw-cc-hint">
          <Icon name="check" size={15} />
          טרם בוצע חיוב בכרטיס זה
        </span>
      </div>
    </div>
  );
}
