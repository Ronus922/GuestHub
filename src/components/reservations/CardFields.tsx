"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import {
  BRAND_LABEL,
  expiryInPast,
  formatCardNumber,
  formatExpiry,
  maskedPan,
  normalizePan,
  panValid,
  parseExpiry,
  type CardBrand,
} from "@/lib/card-rules";
import {
  revealReservationCardAction,
  type StoredCardMeta,
} from "@/app/(dashboard)/reservations/card-actions";

// פרטי כרטיס אשראי (reference .ccbox) — the ENTRY form + the saved-card box.
//
// SECURITY (D41): the PAN is sent ONLY through the dedicated guarded save
// action (saveReservationCardAction — encrypted server-side, AES-256-GCM),
// and read back ONLY via the explicit, permission-guarded, audited reveal.
// CVV was removed from the form entirely: with no live gateway there is no
// immediate authorization, and CVV must never be persisted or recoverable,
// so it is not collected at all. "סלוק עכשיו" stays permanently disabled
// (no gateway → no charge, no fabricated success); saving a card never
// changes payment status or amounts.

export type CardDraft = {
  holder: string;
  number: string;
  exp: string;
  idNum: string;
};

export const EMPTY_CARD: CardDraft = { holder: "", number: "", exp: "", idNum: "" };

// "empty" → nothing entered; "valid" → save-ready; "invalid" → block submit
export function cardDraftState(c: CardDraft): "empty" | "valid" | "invalid" {
  if (!c.holder.trim() && !c.number.trim() && !c.exp.trim() && !c.idNum.trim()) return "empty";
  const pan = normalizePan(c.number);
  const exp = parseExpiry(c.exp);
  const ok =
    c.holder.trim().length >= 2 &&
    panValid(pan) &&
    exp !== null &&
    !expiryInPast(exp.month, exp.year, new Date()) &&
    (!c.idNum || /^\d{5,9}$/.test(c.idNum));
  return ok ? "valid" : "invalid";
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
  const digits = normalizePan(value.number);
  const numberBad = digits.length > 0 && !panValid(digits);
  const exp = parseExpiry(value.exp);
  const expiryBad =
    value.exp.length > 0 && (exp === null || expiryInPast(exp.month, exp.year, new Date()));
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
      <div className="bw-grid2 mt-4">
        <label className="bw-fg">
          <span className="bw-lbl">
            תוקף <span className="bw-req">*</span>
          </span>
          <input
            className={`bw-fld ${expiryBad ? "bad" : ""}`}
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
          הכרטיס נשמר מוצפן · לא מתבצע חיוב
        </span>
      </div>
    </div>
  );
}

// how long a revealed number stays on screen without interaction
const REVEAL_TIMEOUT_MS = 45_000;

// Saved-card box: masked by default; the full number appears ONLY after an
// explicit, permission-guarded reveal request, and is re-masked on hide,
// on card change, on unmount (panel close) and after a short inactivity
// window. The revealed value is never logged or toasted.
export function StoredCardBox({
  card,
  canReveal,
  canManage,
  onReplace,
  onDelete,
  deleting,
}: {
  card: StoredCardMeta | Omit<StoredCardMeta, "holderIdNumber">;
  canReveal: boolean;
  canManage: boolean;
  onReplace?: () => void;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const [pan, setPan] = useState<string | null>(null);
  const [revealing, startReveal] = useTransition();
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setPan(null);
  };

  // re-mask when switching card/reservation or unmounting (panel close)
  useEffect(() => hide, [card.id]);

  const reveal = () =>
    startReveal(async () => {
      const res = await revealReservationCardAction(card.id);
      if (!res.success || !res.data) {
        toast.error(res.success ? "כרטיס לא נמצא" : res.error);
        return;
      }
      setPan(res.data.pan);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setPan(null), REVEAL_TIMEOUT_MS);
    });

  const brand = (card.brand ?? "other") as CardBrand;
  return (
    <div className="bw-ccbox">
      <div className="bw-cc-top">
        <Icon name="credit-card" size={19} />
        כרטיס שמור
        <span className="bw-opt">
          {BRAND_LABEL[brand] ?? card.brand} · עודכן {card.updatedAt.slice(0, 10)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="text-lg font-extrabold tracking-wider text-ink" dir="ltr">
          {pan ? formatCardNumber(pan) : maskedPan(card.last4)}
        </span>
        <span className="text-sm font-semibold text-muted" dir="ltr">
          {String(card.expMonth).padStart(2, "0")}/{String(card.expYear % 100).padStart(2, "0")}
        </span>
        <span className="text-sm font-semibold text-muted">{card.holderName}</span>
      </div>
      <div className="bw-cc-foot">
        {canReveal &&
          (pan ? (
            <button type="button" className="bw-btn bw-btn-o" onClick={hide}>
              <Icon name="circle-slash" size={15} />
              הסתר
            </button>
          ) : (
            <button type="button" className="bw-btn bw-btn-o" disabled={revealing} onClick={reveal}>
              <Icon name="search" size={15} />
              {revealing ? "טוען…" : "הצג מספר מלא"}
            </button>
          ))}
        {canManage && onReplace && (
          <button type="button" className="bw-btn bw-btn-ghost" onClick={onReplace}>
            <Icon name="refresh" size={15} />
            החלף כרטיס
          </button>
        )}
        {canManage && onDelete && (
          <button
            type="button"
            className="bw-btn bw-btn-danger"
            disabled={deleting}
            onClick={onDelete}
          >
            <Icon name="trash" size={15} />
            הסר כרטיס
          </button>
        )}
      </div>
    </div>
  );
}
