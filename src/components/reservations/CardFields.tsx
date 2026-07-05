"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import {
  BRAND_LABEL,
  CARD_SOURCE_LABEL,
  MANUAL_CARD_SOURCES,
  cvvValid,
  expiryInPast,
  formatCardNumber,
  formatCvv,
  formatExpiry,
  maskedCvv,
  maskedPan,
  normalizePan,
  panValid,
  parseExpiry,
  type CardBrand,
  type CardSource,
} from "@/lib/card-rules";
import {
  chargeReservationCardAction,
  revealReservationCardAction,
  type RevealedCard,
  type StoredCardMeta,
} from "@/app/(dashboard)/reservations/card-actions";

// פרטי כרטיס אשראי (reference .ccbox) — the ENTRY form + the saved-card box.
//
// SECURITY (D41/D42/D43): PAN and CVV are sent ONLY through the dedicated
// guarded save action (encrypted server-side, AES-256-GCM), and read back ONLY
// via the explicit, permission-guarded, audited reveal. The saved card is
// masked by default (PAN → •••• last4, CVV → •••); the full values appear only
// after an explicit "הצגת פרטי אשראי" and are dropped from client state on hide,
// card change, unmount and after a short inactivity window. Saving never charges.

export type CardDraft = {
  holder: string;
  number: string;
  exp: string;
  cvv: string;
  idNum: string;
  source: CardSource;
  billingNotes: string;
};

export const EMPTY_CARD: CardDraft = {
  holder: "",
  number: "",
  exp: "",
  cvv: "",
  idNum: "",
  source: "back_office",
  billingNotes: "",
};

// "empty" → nothing entered; "valid" → save-ready; "invalid" → block submit.
// source/billingNotes never make a card "non-empty" on their own.
export function cardDraftState(c: CardDraft): "empty" | "valid" | "invalid" {
  if (!c.holder.trim() && !c.number.trim() && !c.exp.trim() && !c.cvv.trim() && !c.idNum.trim())
    return "empty";
  const pan = normalizePan(c.number);
  const exp = parseExpiry(c.exp);
  const ok =
    c.holder.trim().length >= 2 &&
    panValid(pan) &&
    exp !== null &&
    !expiryInPast(exp.month, exp.year, new Date()) &&
    (!c.cvv || cvvValid(c.cvv)) &&
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
  const cvvBad = value.cvv.length > 0 && !cvvValid(value.cvv);
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
            CVV <span className="bw-opt">(3–4 ספרות)</span>
          </span>
          <input
            className={`bw-fld ${cvvBad ? "bad" : ""}`}
            dir="ltr"
            inputMode="numeric"
            placeholder="•••"
            autoComplete="off"
            maxLength={4}
            value={value.cvv}
            onChange={(e) => onChange({ ...value, cvv: formatCvv(e.target.value) })}
          />
        </label>
      </div>
      <div className="bw-grid2 mt-4">
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
        <label className="bw-fg">
          <span className="bw-lbl">מקור פרטי הכרטיס</span>
          <select
            className="bw-fld"
            value={value.source}
            onChange={(e) => onChange({ ...value, source: e.target.value as CardSource })}
          >
            {MANUAL_CARD_SOURCES.map((s) => (
              <option key={s} value={s}>
                {CARD_SOURCE_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="bw-fg mt-4 block">
        <span className="bw-lbl">
          הערות חיוב <span className="bw-opt">(לא חובה)</span>
        </span>
        <input
          className="bw-fld"
          placeholder="הערה לחיוב"
          autoComplete="off"
          maxLength={500}
          value={value.billingNotes}
          onChange={(e) => onChange({ ...value, billingNotes: e.target.value })}
        />
      </label>
      <div className="bw-cc-foot">
        <button
          type="button"
          className="bw-btn-charge"
          disabled
          title="שמור את הכרטיס תחילה — הסליקה מתבצעת על כרטיס שמור"
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

// how long revealed details stay on screen without interaction
const REVEAL_TIMEOUT_MS = 45_000;

function CopyBtn({ value, label }: { value: string; label: string }) {
  return (
    <button
      type="button"
      className="bw-btn bw-btn-ghost"
      title={`העתקת ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast.success(`${label} הועתק`);
        } catch {
          toast.error("העתקה נכשלה");
        }
      }}
    >
      <Icon name="copy" size={14} />
    </button>
  );
}

// Saved-card box: masked by default (PAN + CVV); the full details appear ONLY
// after an explicit, permission-guarded, audited reveal ("הצגת פרטי אשראי"),
// are re-masked on hide/close/card-change/inactivity, and are never logged or
// toasted. The encrypted values on the server are untouched by a reveal, so it
// is repeatable. Charging (fail-closed placeholder) is separate.
export function StoredCardBox({
  card,
  canReveal,
  canManage,
  canCharge = false,
  chargeAmount = 0,
  onReplace,
  onDelete,
  deleting,
}: {
  card: StoredCardMeta | Omit<StoredCardMeta, "holderIdNumber">;
  canReveal: boolean;
  canManage: boolean;
  canCharge?: boolean;
  chargeAmount?: number;
  onReplace?: () => void;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const [revealed, setRevealed] = useState<RevealedCard | null>(null);
  const [revealing, startReveal] = useTransition();
  const [charging, startCharge] = useTransition();
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setRevealed(null);
  };

  // re-mask + drop decrypted values when switching card/reservation or unmounting
  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = null;
      setRevealed(null);
    };
  }, [card.id]);

  const reveal = () =>
    startReveal(async () => {
      const res = await revealReservationCardAction(card.id);
      if (!res.success || !res.data) {
        toast.error(res.success ? "כרטיס לא נמצא" : res.error);
        return;
      }
      setRevealed(res.data);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setRevealed(null), REVEAL_TIMEOUT_MS);
    });

  const charge = () =>
    startCharge(async () => {
      const res = await chargeReservationCardAction({ cardId: card.id, amount: chargeAmount });
      if (!res.success) toast.error(res.error);
      else toast.success("החיוב בוצע");
    });

  const brand = (card.brand ?? "other") as CardBrand;
  const source = card.source as CardSource;
  const sourceLabel =
    source === "channel"
      ? card.sourceChannel || CARD_SOURCE_LABEL.channel
      : CARD_SOURCE_LABEL[source] ?? source;
  const expMasked = `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear % 100).padStart(2, "0")}`;

  return (
    <div className="bw-ccbox">
      <div className="bw-cc-top">
        <Icon name="credit-card" size={19} />
        כרטיס שמור
        <span className="bw-opt">
          {BRAND_LABEL[brand] ?? card.brand} · עודכן {card.updatedAt.slice(0, 10)}
        </span>
      </div>

      {/* default masked line: brand · masked PAN (last4 visible) · expiry · CVV */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="text-lg font-extrabold tracking-wider text-ink" dir="ltr">
          {revealed ? formatCardNumber(revealed.pan) : maskedPan(card.last4)}
        </span>
        <span className="text-sm font-semibold text-muted" dir="ltr">
          {revealed ? `${String(revealed.expMonth).padStart(2, "0")}/${revealed.expYear}` : expMasked}
        </span>
        <span className="text-sm font-semibold text-muted" dir="ltr">
          CVV {revealed ? (revealed.cvv ?? "—") : card.hasCvv ? maskedCvv() : "—"}
        </span>
        <span className="text-sm font-semibold text-muted">{card.holderName}</span>
      </div>

      {/* channel / source / virtual metadata */}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-muted">
        <span className="rounded bg-black/5 px-2 py-0.5">מקור: {sourceLabel}</span>
        {card.isVirtual && (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800">כרטיס וירטואלי</span>
        )}
        {card.availableUntil && <span>זמין עד {card.availableUntil.slice(0, 10)}</span>}
        {card.billingNotes && <span className="truncate">· {card.billingNotes}</span>}
      </div>

      {/* full revealed details + copy affordances */}
      {revealed && (
        <div className="mt-3 grid grid-cols-1 gap-2 rounded-lg bg-black/[0.03] p-3 text-sm sm:grid-cols-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted">מספר כרטיס</span>
            <span className="flex items-center gap-1">
              <span dir="ltr" className="font-bold">{formatCardNumber(revealed.pan)}</span>
              <CopyBtn value={revealed.pan} label="מספר כרטיס" />
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted">תוקף</span>
            <span className="flex items-center gap-1">
              <span dir="ltr" className="font-bold">
                {String(revealed.expMonth).padStart(2, "0")}/{revealed.expYear}
              </span>
              <CopyBtn value={`${String(revealed.expMonth).padStart(2, "0")}/${revealed.expYear}`} label="תוקף" />
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted">CVV</span>
            <span className="flex items-center gap-1">
              <span dir="ltr" className="font-bold">{revealed.cvv ?? "—"}</span>
              {revealed.cvv && <CopyBtn value={revealed.cvv} label="CVV" />}
            </span>
          </div>
          {revealed.holderIdNumber && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted">ת״ז בעל הכרטיס</span>
              <span className="flex items-center gap-1">
                <span dir="ltr" className="font-bold">{revealed.holderIdNumber}</span>
                <CopyBtn value={revealed.holderIdNumber} label="תעודת זהות" />
              </span>
            </div>
          )}
        </div>
      )}

      <div className="bw-cc-foot">
        {canReveal &&
          (revealed ? (
            <button type="button" className="bw-btn bw-btn-o" onClick={hide}>
              <Icon name="circle-slash" size={15} />
              הסתרת פרטי אשראי
            </button>
          ) : (
            <button type="button" className="bw-btn bw-btn-o" disabled={revealing} onClick={reveal}>
              <Icon name="search" size={15} />
              {revealing ? "טוען…" : "הצגת פרטי אשראי"}
            </button>
          ))}
        {canCharge && (
          <button type="button" className="bw-btn bw-btn-o" disabled={charging} onClick={charge}>
            <Icon name="finance" size={15} />
            {charging ? "מחייב…" : `סליקה · ₪${Math.round(Math.max(0, chargeAmount)).toLocaleString()}`}
          </button>
        )}
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
