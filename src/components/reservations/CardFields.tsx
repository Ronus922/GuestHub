"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import {
  CARD_SOURCE_LABEL,
  MANUAL_CARD_SOURCES,
  expiryInPast,
  formatCardNumber,
  formatExpiry,
  normalizePan,
  panValid,
  parseExpiry,
  resolveCardView,
  type CardSource,
  type ChannelCardInput,
  type RevealedCardInput,
  type StoredCardInput,
} from "@/lib/card-rules";
import {
  chargeReservationCardAction,
  recordExternalPaymentAction,
  revealReservationCardAction,
  type StoredCardMeta,
} from "@/app/(dashboard)/reservations/card-actions";

// no PSP is wired yet — the live-charge button is shown disabled with this text
const NO_GATEWAY_MESSAGE = "לא מוגדר ספק סליקה פעיל";

export type RecordedPayment = {
  paid: number;
  balance: number;
  payment: { id: string; amount: number; method: string | null; paid_at: string; reference: string | null };
};

// ============================================================
// פרטי כרטיס אשראי — the ONE credit-card section (D86).
//
// There is exactly one card interface in GuestHub. A stored (vaulted) card, a
// masked channel guarantee imported with an OTA booking, a manually keyed card
// and the empty state ALL render through the same six canonical fields; which
// one is shown is decided by the pure resolveCardView() view model, never by a
// second component. Before D86 an OTA reservation stacked a read-only channel
// summary card ON TOP of an empty-looking form — that duplicate is gone.
//
// SECURITY (D41/D42/D52 — unchanged by the visual merge): the PAN is sent ONLY
// through the dedicated guarded save action (encrypted server-side, AES-256-GCM)
// and read back ONLY via the explicit, permission-guarded, audited reveal. The
// CVV is NEVER collected, stored or revealed — there is no CVV field anywhere.
// The number field renders the masked PAN (•••• last4); the plaintext appears
// only after "הצגת פרטי אשראי" and is dropped from client state on hide, card
// change, unmount and after a short inactivity window. Saving never charges.
// Masked channel fragments are never padded out into a full card number.
// ============================================================

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

// how long revealed details stay on screen without interaction
const REVEAL_TIMEOUT_MS = 45_000;

// copy affordance for a revealed value — never logged, never toasted with the value
function CopyBtn({ value, label }: { value: string; label: string }) {
  return (
    <button
      type="button"
      className="icon-btn"
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
      <Icon name="copy" size={20} label={`העתקת ${label}`} />
    </button>
  );
}

export function CardFields({
  value,
  onChange,
  chargeAmount,
  disabled = false,
  stored = null,
  channel = null,
  channelName = null,
  stateLabel = null,
  manualEntry = false,
  onToggleManual,
  canReveal = false,
  canManage = false,
  canCharge = false,
  canRecordPayment = false,
  reservationId,
  onDelete,
  onPaymentRecorded,
  deleting = false,
}: {
  value: CardDraft;
  // functional updater (owners pass setCc): each field patches the PREVIOUS
  // draft, never a captured snapshot, so keystrokes can never clobber each other
  onChange: (updater: (prev: CardDraft) => CardDraft) => void;
  chargeAmount: number;
  /** D77 §15 — MANUAL entry activates only when the selected payment method is
   *  credit card; otherwise the entry area is grey, disabled, unfocusable. Never
   *  applied to populated read-only values: real data must not look empty. */
  disabled?: boolean;
  /** the vaulted card for this reservation, if one exists */
  stored?: StoredCardMeta | Omit<StoredCardMeta, "holderIdNumber"> | null;
  /** the masked channel guarantee imported with an OTA booking */
  channel?: ChannelCardInput | null;
  channelName?: string | null;
  /** honest collection state — shown as the section's subordinate helper line */
  stateLabel?: string | null;
  /** operator explicitly chose to key in a card instead of the imported/stored one */
  manualEntry?: boolean;
  onToggleManual?: (manual: boolean) => void;
  canReveal?: boolean;
  /** may replace/remove the stored card (permission + live reservation) */
  canManage?: boolean;
  canCharge?: boolean;
  canRecordPayment?: boolean;
  reservationId?: string;
  onDelete?: () => void;
  onPaymentRecorded?: (p: RecordedPayment) => void;
  deleting?: boolean;
}) {
  const [revealed, setRevealed] = useState<RevealedCardInput | null>(null);
  const [revealing, startReveal] = useTransition();
  const [charging, startCharge] = useTransition();
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // "record payment collected externally" inline form (NOT a GuestHub charge)
  const [payOpen, setPayOpen] = useState(false);
  const [payAmount, setPayAmount] = useState(0);
  const [payRef, setPayRef] = useState("");
  const [payConfirm, setPayConfirm] = useState(false);
  const [recording, startRecord] = useTransition();

  const storedId = stored?.id ?? null;

  // re-mask + drop decrypted values when switching card/reservation or unmounting
  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = null;
      setRevealed(null);
    };
  }, [storedId]);

  // ONE view model → ONE field set. Missing values stay empty, never invented.
  const view = resolveCardView({
    stored: stored as StoredCardInput | null,
    channel,
    channelName,
    stateLabel,
    draft: value,
    manualEntry,
    revealed,
  });

  const digits = normalizePan(value.number);
  const numberBad = view.editable && digits.length > 0 && !panValid(digits);
  const exp = parseExpiry(value.exp);
  const expiryBad =
    view.editable &&
    value.exp.length > 0 &&
    (exp === null || expiryInPast(exp.month, exp.year, new Date()));
  const idBad = view.editable && value.idNum.length > 0 && !/^\d{5,9}$/.test(value.idNum);

  // grey-out applies to MANUAL ENTRY only — a read-only card that actually holds
  // data is never rendered as if it were empty
  const entryOff = view.editable && disabled;
  const ro = !view.editable;
  const roCls = ro ? "bw-ro" : "";

  const hide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setRevealed(null);
  };

  const reveal = () =>
    startReveal(async () => {
      if (!storedId) return;
      const res = await revealReservationCardAction(storedId);
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
      if (!storedId) return;
      const res = await chargeReservationCardAction({ cardId: storedId, amount: chargeAmount });
      if (!res.success) toast.error(res.error);
      else toast.success("החיוב בוצע");
    });

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

  // the ID field is only meaningful where the source can actually carry one
  const showIdField = view.editable || view.origin === "stored";

  return (
    <div className={`bw-ccbox ${entryOff ? "bw-ccbox-off" : ""}`}>
      <div className="bw-cc-top">
        <Icon name="credit-card" size={20} />
        פרטי כרטיס אשראי
        {view.brandLabel && <span className="field-hint">{view.brandLabel}</span>}
        {view.isVirtual && <span className="chip chip-approval">כרטיס וירטואלי</span>}
      </div>

      {entryOff && (
        <p className="mb-3 text-xs font-bold text-muted">
          בחרו אמצעי תשלום ״כרטיס אשראי״ כדי להפעיל את הזנת פרטי הכרטיס
        </p>
      )}

      <fieldset disabled={entryOff} className="m-0 min-w-0 border-0 p-0">
        <div className="bw-grid2">
          <label className="field">
            <span className="field-label">
              שם בעל הכרטיס {view.editable && <span className="bw-req">*</span>}
            </span>
            <input
              className={`field-input ${roCls}`}
              placeholder={ro ? "לא התקבל" : "שם כפי שמופיע על הכרטיס"}
              autoComplete="off"
              readOnly={ro}
              value={view.holder}
              onChange={(e) => onChange((p) => ({ ...p, holder: e.target.value }))}
            />
          </label>
          <label className="field">
            <span className="field-label">
              מספר כרטיס {view.editable && <span className="bw-req">*</span>}
              {revealed && <CopyBtn value={revealed.pan} label="מספר כרטיס" />}
            </span>
            <div className="bw-fld-wrap">
              <Icon name="credit-card" size={17} className="bw-fi" />
              <input
                className={`field-input bw-ic ltr-num ${roCls} ${numberBad ? "field-error" : ""}`}
                dir="ltr"
                inputMode="numeric"
                placeholder={ro ? "לא התקבל" : "0000 0000 0000 0000"}
                autoComplete="off"
                readOnly={ro}
                value={view.number}
                onChange={(e) => onChange((p) => ({ ...p, number: formatCardNumber(e.target.value) }))}
              />
            </div>
          </label>
        </div>

        <div className="bw-grid2 mt-4">
          <label className="field">
            <span className="field-label">
              תוקף {view.editable && <span className="bw-req">*</span>}
              {revealed && <CopyBtn value={view.exp} label="תוקף" />}
            </span>
            <input
              className={`field-input ltr-num ${roCls} ${expiryBad ? "field-error" : ""}`}
              dir="ltr"
              inputMode="numeric"
              placeholder={ro ? "לא התקבל" : "MM/YY"}
              autoComplete="off"
              readOnly={ro}
              value={view.exp}
              onChange={(e) => onChange((p) => ({ ...p, exp: formatExpiry(e.target.value) }))}
            />
          </label>
          {showIdField && (
            <label className="field">
              <span className="field-label">
                תעודת זהות <span className="field-hint">(לא חובה)</span>
                {revealed && view.idNumber && <CopyBtn value={view.idNumber} label="תעודת זהות" />}
              </span>
              <input
                className={`field-input ltr-num ${roCls} ${idBad ? "field-error" : ""}`}
                dir="ltr"
                inputMode="numeric"
                placeholder={ro ? (revealed ? "לא נשמר" : "מוצג לאחר הצגת פרטי אשראי") : "9 ספרות"}
                autoComplete="off"
                maxLength={9}
                readOnly={ro}
                value={view.idNumber}
                onChange={(e) => onChange((p) => ({ ...p, idNum: e.target.value.replace(/\D/g, "") }))}
              />
            </label>
          )}
        </div>

        <label className="field mt-4">
          <span className="field-label">מקור פרטי הכרטיס</span>
          {view.editable ? (
            <select
              className="field-input"
              value={value.source}
              onChange={(e) => onChange((p) => ({ ...p, source: e.target.value as CardSource }))}
            >
              {MANUAL_CARD_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {CARD_SOURCE_LABEL[s]}
                </option>
              ))}
            </select>
          ) : (
            /* the REAL origin of the values above — never hardcoded back-office */
            <input className="field-input bw-ro" readOnly value={view.sourceLabel} />
          )}
        </label>

        <label className="field mt-4">
          <span className="field-label">
            הערות חיוב <span className="field-hint">(לא חובה)</span>
          </span>
          <textarea
            className={`field-input ${roCls}`}
            placeholder={ro ? "—" : "הערה לחיוב"}
            autoComplete="off"
            maxLength={500}
            rows={3}
            readOnly={ro}
            value={view.billingNotes}
            onChange={(e) => onChange((p) => ({ ...p, billingNotes: e.target.value }))}
          />
        </label>
      </fieldset>

      {/* subordinate status metadata — NOT a second presentation of the card */}
      {(view.helper || view.availableUntil) && (
        <p className="bw-cc-status">
          <Icon name="check" size={17} />
          <span>
            {view.helper}
            {view.availableUntil && (
              <>
                {" · "}
                חלון חיוב{" "}
                <span dir="ltr">
                  {view.availableFrom ? `${view.availableFrom} → ` : "עד "}
                  {view.availableUntil}
                </span>
              </>
            )}
          </span>
        </p>
      )}

      <div className="bw-cc-foot">
        {view.origin === "stored" && canReveal && (
          revealed ? (
            <button type="button" className="btn btn-secondary" onClick={hide}>
              <Icon name="circle-slash" size={17} />
              הסתרת פרטי אשראי
            </button>
          ) : (
            <button type="button" className="btn btn-secondary" disabled={revealing} onClick={reveal}>
              <Icon name="search" size={17} />
              {revealing ? "טוען…" : "הצגת פרטי אשראי"}
            </button>
          )
        )}

        {view.origin === "stored" && canCharge && (
          /* live charge stays VISIBLE but DISABLED until a PSP is wired
             (chargeReservationCardAction is fail-closed) */
          <span className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              disabled
              onClick={charge}
              title={NO_GATEWAY_MESSAGE}
            >
              <Icon name="finance" size={17} />
              {charging ? "מחייב…" : `סליקה · ₪${Math.round(Math.max(0, chargeAmount)).toLocaleString()}`}
            </button>
            <span className="text-xs font-semibold text-muted">{NO_GATEWAY_MESSAGE}</span>
          </span>
        )}

        {canRecordPayment && reservationId && !payOpen && (
          <button type="button" className="btn btn-secondary" onClick={openPay}>
            <Icon name="finance" size={17} />
            רישום תשלום שבוצע חיצונית
          </button>
        )}

        {/* switch the SAME fields to manual entry — not a second form */}
        {!view.editable && canManage && onToggleManual && (
          <button type="button" className="btn btn-tertiary" onClick={() => onToggleManual(true)}>
            <Icon name="refresh" size={17} />
            {view.origin === "stored" ? "החלף כרטיס" : "הזנת כרטיס ידנית במקום"}
          </button>
        )}
        {view.editable && manualEntry && onToggleManual && (
          <button type="button" className="btn btn-tertiary" onClick={() => onToggleManual(false)}>
            <Icon name="circle-slash" size={17} />
            ביטול — חזרה לפרטי הכרטיס הקיימים
          </button>
        )}

        {view.origin === "stored" && canManage && onDelete && (
          <button type="button" className="btn btn-danger" disabled={deleting} onClick={onDelete}>
            <Icon name="trash" size={17} />
            הסר כרטיס
          </button>
        )}

        {view.editable && !entryOff && (
          <span className="bw-cc-hint">
            <Icon name="check" size={17} />
            הכרטיס נשמר מוצפן · לא מתבצע חיוב
          </span>
        )}
      </div>

      {/* record a payment collected OUTSIDE GuestHub — not a charge; updates
          paid/balance only after explicit staff confirmation */}
      {payOpen && (
        <div className="mt-3 rounded-xl bg-field p-4">
          <p className="mb-2 text-xs font-semibold text-muted">
            רישום תשלום שבוצע חיצונית — GuestHub אינו מבצע כאן חיוב. אשרו רק לאחר
            שהתשלום נגבה בפועל בטרמינל או אצל ספק חיצוני.
          </p>
          <div className="bw-grid2">
            <label className="field">
              <span className="field-label">סכום (₪)</span>
              <input
                className="field-input ltr-num"
                type="text"
                inputMode="numeric"
                dir="ltr"
                value={payAmount || ""}
                onChange={(e) => setPayAmount(Math.max(0, Number(e.target.value.replace(/\D/g, "")) || 0))}
              />
            </label>
            <label className="field">
              <span className="field-label">
                אסמכתא / מספר אישור <span className="field-hint">(לא חובה)</span>
              </span>
              <input
                className="field-input ltr-num"
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
                  className="btn btn-primary"
                  disabled={recording || payAmount <= 0}
                  onClick={record}
                >
                  <Icon name="check" size={17} />
                  {recording ? "רושם…" : "אשר וסכם תשלום"}
                </button>
                <button type="button" className="btn btn-tertiary" onClick={() => setPayConfirm(false)}>
                  חזרה
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={payAmount <= 0}
                  onClick={() => setPayConfirm(true)}
                >
                  <Icon name="finance" size={17} />
                  רישום תשלום
                </button>
                <button type="button" className="btn btn-tertiary" onClick={() => setPayOpen(false)}>
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
