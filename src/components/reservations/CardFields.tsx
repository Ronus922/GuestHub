"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import {
  BRAND_LABEL,
  CARD_SOURCE_LABEL,
  MANUAL_CARD_SOURCES,
  expiryInPast,
  formatCardNumber,
  formatExpiry,
  maskedPan,
  normalizePan,
  panValid,
  parseExpiry,
  type CardBrand,
  type CardSource,
} from "@/lib/card-rules";
import {
  chargeReservationCardAction,
  recordExternalPaymentAction,
  revealReservationCardAction,
  type RevealedCard,
  type StoredCardMeta,
} from "@/app/(dashboard)/reservations/card-actions";

// no PSP is wired yet — the live-charge button is shown disabled with this text
const NO_GATEWAY_MESSAGE = "לא מוגדר ספק סליקה פעיל";

export type RecordedPayment = {
  paid: number;
  balance: number;
  payment: { id: string; amount: number; method: string | null; paid_at: string; reference: string | null };
};

// פרטי כרטיס אשראי (reference .ccbox) — the ENTRY form + the saved-card box.
//
// SECURITY (D41/D42/D52): the PAN is sent ONLY through the dedicated guarded
// save action (encrypted server-side, AES-256-GCM) and read back ONLY via the
// explicit, permission-guarded, audited reveal. The CVV is NEVER collected,
// stored or revealed (D52 §2) — there is no CVV field. The saved card is masked
// by default (PAN → •••• last4); the full PAN appears only after an explicit
// "הצגת פרטי אשראי" and is dropped from client state on hide, card change,
// unmount and after a short inactivity window. Saving never charges.

export type CardDraft = {
  holder: string;
  number: string;
  exp: string;
  idNum: string;
  source: CardSource;
  billingNotes: string;
};

export const EMPTY_CARD: CardDraft = {
  holder: "",
  number: "",
  exp: "",
  idNum: "",
  source: "back_office",
  billingNotes: "",
};

// "empty" → nothing entered; "valid" → save-ready; "invalid" → block submit.
// source/billingNotes never make a card "non-empty" on their own.
export function cardDraftState(c: CardDraft): "empty" | "valid" | "invalid" {
  if (!c.holder.trim() && !c.number.trim() && !c.exp.trim() && !c.idNum.trim())
    return "empty";
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
  disabled = false,
}: {
  value: CardDraft;
  // functional updater (owners pass setCc): each field patches the PREVIOUS
  // draft, never a captured snapshot, so keystrokes can never clobber each other
  onChange: (updater: (prev: CardDraft) => CardDraft) => void;
  chargeAmount: number;
  /** D77 §15 — card entry activates ONLY when the selected payment method is
   *  credit card; otherwise the whole area is grey, disabled, unfocusable.
   *  The OWNER also clears the draft on deactivation (unsaved sensitive state
   *  must not survive a method switch). */
  disabled?: boolean;
}) {
  const digits = normalizePan(value.number);
  const numberBad = digits.length > 0 && !panValid(digits);
  const exp = parseExpiry(value.exp);
  const expiryBad =
    value.exp.length > 0 && (exp === null || expiryInPast(exp.month, exp.year, new Date()));
  const idBad = value.idNum.length > 0 && !/^\d{5,9}$/.test(value.idNum);

  return (
    <div className={`bw-ccbox ${disabled ? "bw-ccbox-off" : ""}`}>
      <div className="bw-cc-top">
        <Icon name="credit-card" size={19} />
        פרטי כרטיס אשראי
      </div>
      {disabled && (
        <p className="mb-3 text-xs font-bold text-muted">
          בחרו אמצעי תשלום ״כרטיס אשראי״ כדי להפעיל את הזנת פרטי הכרטיס
        </p>
      )}
      <fieldset disabled={disabled} className="m-0 min-w-0 border-0 p-0">
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
            onChange={(e) => onChange((p) => ({ ...p, holder: e.target.value }))}
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
              onChange={(e) => onChange((p) => ({ ...p, number: formatCardNumber(e.target.value) }))}
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
            onChange={(e) => onChange((p) => ({ ...p, exp: formatExpiry(e.target.value) }))}
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
            onChange={(e) => onChange((p) => ({ ...p, idNum: e.target.value.replace(/\D/g, "") }))}
          />
        </label>
      </div>
      <label className="bw-fg mt-4 block">
        <span className="bw-lbl">מקור פרטי הכרטיס</span>
        <select
          className="bw-fld"
          value={value.source}
          onChange={(e) => onChange((p) => ({ ...p, source: e.target.value as CardSource }))}
        >
          {MANUAL_CARD_SOURCES.map((s) => (
            <option key={s} value={s}>
              {CARD_SOURCE_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
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
          onChange={(e) => onChange((p) => ({ ...p, billingNotes: e.target.value }))}
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
      </fieldset>
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

// Saved-card box: masked by default (PAN → •••• last4); the full PAN appears
// ONLY after an explicit, permission-guarded, audited reveal ("הצגת פרטי אשראי"),
// is re-masked on hide/close/card-change/inactivity, and is never logged or
// toasted. No CVV is ever shown — none is stored (D52 §2). The encrypted PAN on
// the server is untouched by a reveal, so it is repeatable. Charging (fail-closed
// placeholder) is separate.
export function StoredCardBox({
  card,
  canReveal,
  canManage,
  canCharge = false,
  canRecordPayment = false,
  chargeAmount = 0,
  reservationId,
  onReplace,
  onDelete,
  onPaymentRecorded,
  deleting,
}: {
  card: StoredCardMeta | Omit<StoredCardMeta, "holderIdNumber">;
  canReveal: boolean;
  canManage: boolean;
  canCharge?: boolean;
  canRecordPayment?: boolean;
  chargeAmount?: number;
  reservationId?: string;
  onReplace?: () => void;
  onDelete?: () => void;
  onPaymentRecorded?: (p: RecordedPayment) => void;
  deleting?: boolean;
}) {
  const [revealed, setRevealed] = useState<RevealedCard | null>(null);
  const [revealing, startReveal] = useTransition();
  const [charging, startCharge] = useTransition();
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // "record payment collected externally" inline form (NOT a GuestHub charge)
  const [payOpen, setPayOpen] = useState(false);
  const [payAmount, setPayAmount] = useState(0);
  const [payRef, setPayRef] = useState("");
  const [payConfirm, setPayConfirm] = useState(false);
  const [recording, startRecord] = useTransition();

  const openPay = () => {
    setPayAmount(Math.round(Math.max(0, chargeAmount)));
    setPayRef("");
    setPayConfirm(false);
    setPayOpen(true);
  };
  const record = () =>
    startRecord(async () => {
      if (!reservationId) return;
      const res = await recordExternalPaymentAction({
        reservationId,
        amount: payAmount,
        method: "credit_card",
        reference: payRef.trim() || undefined,
        confirmed: true,
      });
      if (!res.success || !res.data) {
        toast.error(res.success ? "רישום התשלום נכשל" : res.error);
        return;
      }
      toast.success("התשלום נרשם");
      onPaymentRecorded?.(res.data);
      setPayOpen(false);
      setPayConfirm(false);
    });

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

      {/* default masked line: brand · masked PAN (last4 visible) · expiry (no CVV) */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="text-lg font-extrabold tracking-wider text-ink" dir="ltr">
          {revealed ? formatCardNumber(revealed.pan) : maskedPan(card.last4)}
        </span>
        <span className="text-sm font-semibold text-muted" dir="ltr">
          {revealed ? `${String(revealed.expMonth).padStart(2, "0")}/${revealed.expYear}` : expMasked}
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
          /* live charge stays VISIBLE but DISABLED until a PSP is wired
             (chargeReservationCardAction is fail-closed) */
          <span className="flex items-center gap-2">
            <button
              type="button"
              className="bw-btn bw-btn-o"
              disabled
              onClick={charge}
              title={NO_GATEWAY_MESSAGE}
            >
              <Icon name="finance" size={15} />
              {charging ? "מחייב…" : `סליקה · ₪${Math.round(Math.max(0, chargeAmount)).toLocaleString()}`}
            </button>
            <span className="text-xs font-semibold text-muted">{NO_GATEWAY_MESSAGE}</span>
          </span>
        )}
        {canRecordPayment && reservationId && !payOpen && (
          <button type="button" className="bw-btn bw-btn-o" onClick={openPay}>
            <Icon name="finance" size={15} />
            רישום תשלום שבוצע חיצונית
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

      {/* record a payment collected OUTSIDE GuestHub — not a charge; updates
          paid/balance only after explicit staff confirmation */}
      {payOpen && (
        <div className="mt-3 rounded-lg bg-black/[0.03] p-3">
          <p className="mb-2 text-xs font-semibold text-muted">
            רישום תשלום שבוצע חיצונית — GuestHub אינו מבצע כאן חיוב. אשרו רק לאחר
            שהתשלום נגבה בפועל בטרמינל או אצל ספק חיצוני.
          </p>
          <div className="bw-grid2">
            <label className="bw-fg">
              <span className="bw-lbl">סכום (₪)</span>
              <input
                className="bw-fld"
                type="text"
                inputMode="numeric"
                dir="ltr"
                value={payAmount || ""}
                onChange={(e) => setPayAmount(Math.max(0, Number(e.target.value.replace(/\D/g, "")) || 0))}
              />
            </label>
            <label className="bw-fg">
              <span className="bw-lbl">
                אסמכתא / מספר אישור <span className="bw-opt">(לא חובה)</span>
              </span>
              <input
                className="bw-fld"
                dir="ltr"
                maxLength={120}
                value={payRef}
                onChange={(e) => setPayRef(e.target.value)}
              />
            </label>
          </div>
          <div className="mt-3 flex items-center gap-2">
            {payConfirm ? (
              <>
                <span className="text-sm font-bold text-ink">לאשר שהתשלום נגבה בפועל?</span>
                <span className="flex-1" />
                <button
                  type="button"
                  className="bw-btn bw-btn-primary"
                  disabled={recording || payAmount <= 0}
                  onClick={record}
                >
                  <Icon name="check" size={15} />
                  {recording ? "רושם…" : "אשר וסכם תשלום"}
                </button>
                <button type="button" className="bw-btn bw-btn-ghost" onClick={() => setPayConfirm(false)}>
                  חזרה
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="bw-btn bw-btn-o"
                  disabled={payAmount <= 0}
                  onClick={() => setPayConfirm(true)}
                >
                  <Icon name="finance" size={15} />
                  רישום תשלום
                </button>
                <button type="button" className="bw-btn bw-btn-ghost" onClick={() => setPayOpen(false)}>
                  ביטול
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
