"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/shared/Icon";
import { formatVatRate, includedVatForReservation } from "@/lib/vat";
import { formatBalance } from "@/lib/inventory-rules";
import { spreadTotalOverNights, type DiscountMode, type PriceMode } from "@/lib/pricing/totals";

// ============================================================
// The pricing controls of Booking Window V2 (SPEC — docs/booking-window/
// SPEC.md, step 3), shared verbatim by the create and edit panels so the two
// flows can never drift (requirement 2: identical in create and edit).
// Pure presentational pieces — every amount they show is computed by
// computeReservationTotals / the engine; nothing here does money math beyond
// calling the shared pure helpers.
// ============================================================

export const PRICE_MODE_LABELS: Record<PriceMode, string> = {
  auto: "מחיר מקורי",
  manual_night: "מחיר ידני ללילה",
  manual_total: "סה״כ מחיר",
};

// segmented control (mock: .seg/.seg-b) — RTL order comes from DOM order
function Segmented<T extends string>({
  options, value, onChange, disabled, ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex flex-wrap gap-1 rounded-xl bg-field p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={`min-h-11 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
            value === o.value ? "bg-surface text-primary shadow-sm" : "text-muted hover:text-ink"
          } ${disabled ? "opacity-60" : ""}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---- per-room price mode + values (mock: חדר N block in step 3) ----
export function StayPriceModeControls({
  mode, onMode, nights,
  autoRate, autoTotal,
  ratePerNight, onRatePerNight,
  manualTotal, onManualTotal,
  canPriceOverride, disabled,
  autoField, noteSuffix,
}: {
  mode: PriceMode;
  onMode: (m: PriceMode) => void;
  nights: number;
  /** engine figures (display when mode=auto) */
  autoRate: number;
  autoTotal: number;
  ratePerNight: number | null;
  onRatePerNight: (v: number) => void;
  manualTotal: number | null;
  onManualTotal: (v: number) => void;
  canPriceOverride: boolean;
  disabled?: boolean;
  /** the "מחיר מקורי" mode's field — the rate-plan select the parent owns */
  autoField?: React.ReactNode;
  /** appended to the live calc note (the edit window adds "כולל מע״מ") */
  noteSuffix?: string;
}) {
  const nightValue =
    mode === "manual_night" ? (ratePerNight ?? 0)
    : mode === "manual_total" ? (nights > 0 ? (spreadTotalOverNights(manualTotal ?? 0, nights)[0] ?? 0) : 0)
    : autoRate;
  const totalValue =
    mode === "manual_total" ? (manualTotal ?? 0)
    : mode === "manual_night" ? Math.round(((ratePerNight ?? 0) * nights) * 100) / 100
    : autoTotal;
  return (
    <div className="flex flex-col gap-2">
      {canPriceOverride && (
        <Segmented<PriceMode>
          ariaLabel="מצב מחיר"
          options={(Object.keys(PRICE_MODE_LABELS) as PriceMode[]).map((m) => ({
            value: m, label: PRICE_MODE_LABELS[m],
          }))}
          value={mode}
          onChange={onMode}
          disabled={disabled}
        />
      )}
      {/* ONE field, swapped by the segment (the MD spec, "כמו בהנחה"):
          מחיר מקורי → the rate-plan select · ידני ללילה → the nightly field ·
          סה״כ מחיר → the per-room total field. The live calc note sits beside
          the active field; the inactive values keep living in state. */}
      <div className="flex flex-wrap items-center gap-3">
        {mode === "auto" && autoField}
        {mode === "manual_night" && (
          <label className="flex items-center gap-2 text-sm">
            מחיר ללילה (₪)
            <input
              type="number"
              min={0}
              step="0.01"
              dir="ltr"
              aria-label="מחיר ללילה"
              className="field-input ltr-num w-28 text-center tabular-nums"
              value={nightValue}
              readOnly={disabled}
              onChange={(e) => onRatePerNight(Number(e.target.value) || 0)}
            />
          </label>
        )}
        {mode === "manual_total" && (
          <label className="flex items-center gap-2 text-sm">
            סה״כ לחדר (₪)
            <input
              type="number"
              min={0}
              step="0.01"
              dir="ltr"
              aria-label="סה״כ לחדר"
              className="field-input ltr-num w-32 text-center tabular-nums"
              value={totalValue}
              readOnly={disabled}
              onChange={(e) => onManualTotal(Number(e.target.value) || 0)}
            />
          </label>
        )}
        <span className="text-sm font-semibold text-muted tabular-nums">
          ₪<bdi className="ltr-num">{nightValue.toLocaleString()}</bdi> ללילה · סה״כ ₪
          <bdi className="ltr-num">{totalValue.toLocaleString()}</bdi>
          {noteSuffix ? ` · ${noteSuffix}` : ""}
        </span>
        {mode !== "auto" && !disabled && (
          <button
            type="button"
            className="text-xs font-semibold text-primary underline"
            onClick={() => onMode("auto")}
          >
            חזרה למחיר אוטומטי
          </button>
        )}
      </div>
      {mode === "manual_total" && nights > 1 && (
        <p className="text-xs text-muted">
          הסכום שהוזן הוא הסכום הסופי לחדר — החלוקה ללילות היא לתצוגה בלבד
        </p>
      )}
    </div>
  );
}

// ---- reservation-level discount: unit segmented + one value field (mock) ----
// the MD's three units (הקמת הזמנה §"הנחה" ש'99): ₪ ללילה / % ללילה / % להזמנה.
// "amount_total" is NOT offered any more — it survives only as a legacy
// passthrough so an existing reservation that stored it still displays honestly.
export const DISCOUNT_UNITS: { value: Exclude<DiscountMode, "none">; label: string; fieldLabel: string }[] = [
  { value: "amount_per_night", label: "₪ ללילה", fieldLabel: "הנחה ללילה (₪)" },
  { value: "percent_per_night", label: "% ללילה", fieldLabel: "אחוז הנחה ללילה (%)" },
  { value: "percent_total", label: "% להזמנה", fieldLabel: "אחוז הנחה להזמנה (%)" },
];
const LEGACY_AMOUNT_TOTAL = { value: "amount_total" as const, label: "₪ להזמנה", fieldLabel: "הנחה להזמנה (₪)" };

export function DiscountControls({
  mode, value, onChange, disabled,
}: {
  mode: DiscountMode;
  value: number;
  onChange: (mode: DiscountMode, value: number) => void;
  disabled?: boolean;
}) {
  // "מחיר מלא" is the none state: unit selected with value 0 ⇔ none (SPEC ס-2).
  // The unit TABS are free-standing UI state so they are ALWAYS clickable —
  // unit first, value later, exactly like the price-mode segmented. (The old
  // `value > 0 ? u : "none"` alone swallowed the click while the field was
  // empty/0: mode stayed "none" and the tab visibly never moved.) The none⇔0
  // pact with the parent is untouched — mode still carries a unit only while
  // value > 0 — so the live feedback and every computed total are unchanged.
  const [uiUnit, setUiUnit] = useState<Exclude<DiscountMode, "none">>(
    mode === "none" ? "amount_per_night" : mode,
  );
  // an outside mode change (a loaded reservation's stored unit) re-syncs the tabs
  useEffect(() => {
    if (mode !== "none") setUiUnit(mode);
  }, [mode]);
  const unit = mode === "none" ? uiUnit : mode;
  // legacy passthrough: a stored ₪-להזמנה discount keeps its segment visible
  const units =
    unit === "amount_total" ? [...DISCOUNT_UNITS, LEGACY_AMOUNT_TOTAL] : DISCOUNT_UNITS;
  const field = units.find((u) => u.value === unit)!;
  const isPercent = unit === "percent_per_night" || unit === "percent_total";
  return (
    <div className="flex flex-col gap-2">
      <Segmented
        ariaLabel="יחידת הנחה"
        options={units.map((u) => ({ value: u.value, label: u.label }))}
        value={unit}
        onChange={(u) => {
          setUiUnit(u);
          // with a value the existing #180-era behavior is kept verbatim
          // (the unit switches, the number stays); with 0 the parent keeps
          // "none" and only the visible tab moves
          onChange(value > 0 ? u : "none", value);
        }}
        disabled={disabled}
      />
      <label className="flex items-center gap-2 text-sm">
        {field.fieldLabel}
        <input
          type="number"
          min={0}
          max={isPercent ? 100 : undefined}
          step={isPercent ? 1 : "0.01"}
          dir="ltr"
          aria-label={field.fieldLabel}
          className="field-input ltr-num w-28 text-center tabular-nums"
          placeholder="0"
          value={value || ""}
          disabled={disabled}
          onChange={(e) => {
            const v = Math.max(0, Number(e.target.value) || 0);
            onChange(v > 0 ? unit : "none", v);
          }}
        />
      </label>
      <p className="text-xs text-muted">בחרו יחידת הנחה והזינו ערך — החישוב מתעדכן מיד.</p>
    </div>
  );
}

// ---- the VAT toggle + included-amount line (mock: מע״מ (18%) — כלול במחיר) ----
export function VatToggleRow({
  vatRate, grandTotal, taxExempt, onToggle, disabled,
}: {
  vatRate: number;
  grandTotal: number;
  taxExempt: boolean;
  onToggle: (exempt: boolean) => void;
  disabled?: boolean;
}) {
  const vat = includedVatForReservation(grandTotal, vatRate, taxExempt);
  return (
    <div className="bw-price-line">
      <span className="bw-plr flex items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={!taxExempt}
          aria-label="המחיר כולל מע״מ"
          disabled={disabled}
          onClick={() => onToggle(!taxExempt)}
          className={`relative h-6 w-11 rounded-full transition-colors ${
            !taxExempt ? "bg-primary" : "bg-field"
          } ${disabled ? "opacity-60" : ""}`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
              !taxExempt ? "right-0.5" : "right-[22px]"
            }`}
          />
        </button>
        מע״מ ({formatVatRate(vatRate)}%) — {taxExempt ? "לא נגבה" : "כלול במחיר"}
      </span>
      <b className="ltr-num text-muted tabular-nums">₪{vat.toLocaleString()}</b>
    </div>
  );
}

// ---- the balance strip (MD step 5: the three cubes — שולם עד כה (ירוק) /
// יתרה לתשלום (אדום כשחייבים, ירוק כשאין) / סטטוס תשלום) ----
export function BalanceBoxes({
  total, paid, statusChip,
}: {
  total: number;
  paid: number;
  /** the third cube's content — the payment-status badge the parent owns */
  statusChip?: React.ReactNode;
}) {
  const bal = formatBalance(total, paid);
  return (
    <div className="grid grid-cols-3 gap-3">
      <div className="bw-bal">
        <p className="bw-bal-l">שולם עד כה</p>
        <p className="bw-bal-v ltr-num text-status-success">₪{paid.toLocaleString()}</p>
      </div>
      <div className="bw-bal">
        <p className="bw-bal-l">{bal.label}</p>
        <p
          className={`bw-bal-v ltr-num ${
            bal.kind === "credit" || bal.kind === "settled"
              ? "text-status-success"
              : "text-status-danger"
          }`}
        >
          ₪{bal.amount.toLocaleString()}
        </p>
      </div>
      <div className="bw-bal">
        <p className="bw-bal-l">סטטוס תשלום</p>
        <div className="mt-1">{statusChip}</div>
      </div>
    </div>
  );
}

// ---- currency selector (mock: מטבע ₪ ILS · $ USD · € EUR) ----
const CURRENCY_SIGNS: Record<string, string> = { ILS: "₪", USD: "$", EUR: "€", GBP: "£" };

// ---- conditional payment-method windows. מזומן → no block at all (the
// callers also hide the card box for every non-credit method); ביט/פייבוקס/
// אפליקציה → a single optional "מספר אישור" field; העברה בנקאית → a block in
// the card-box style (בנק, סניף, מס' חשבון, שם בעל החשבון prefilled from the
// guest name); צ'ק → שם הבנק, סניף, מספר חשבון, מספר צ'ק.
// GRAPHIC SHELL: the values live in local state only.
// TODO(wire-up): persist the reference / bank / cheque details with the payment.
// Method keys are tenant-defined lookup_items (an operator-added פייבוקס or
// אפליקציה may carry a generated key), so the match falls back to the visible
// label — a method added later in Settings picks its window up automatically.
export function PaymentMethodExtras({
  methodKey,
  methodLabel,
  guestName,
}: {
  methodKey: string;
  methodLabel?: string;
  guestName?: string;
}) {
  const [reference, setReference] = useState("");
  const [bank, setBank] = useState("");
  const [branch, setBranch] = useState("");
  const [account, setAccount] = useState("");
  const [chequeNo, setChequeNo] = useState("");
  // שם בעל החשבון — prefilled from the guest name typed in the guest step and
  // editable; once edited by hand, later guest-name changes never overwrite it
  const [holder, setHolder] = useState(guestName ?? "");
  const holderTouched = useRef(false);
  useEffect(() => {
    if (!holderTouched.current) setHolder(guestName ?? "");
  }, [guestName]);
  const label = methodLabel ?? "";
  const isRefMethod =
    methodKey === "bit" ||
    methodKey === "paybox" ||
    label === "ביט" ||
    label === "פייבוקס" ||
    label === "אפליקציה";
  const isBankTransfer = methodKey === "bank_transfer" || label === "העברה בנקאית";
  const isCheque = methodKey === "cheque" || methodKey === "check" || /צ['׳]ק/.test(label);
  if (isRefMethod) {
    return (
      <div className="bw-grid2 mt-4">
        <label className="field">
          <span className="field-label">
            מספר אישור <span className="field-hint">(לא חובה)</span>
          </span>
          <input
            className="field-input ltr-num"
            dir="ltr"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </label>
      </div>
    );
  }
  if (isBankTransfer) {
    return (
      <div className="bw-metabox">
        <div className="bw-cc-top">
          <Icon name="finance" size={20} />
          פרטי העברה בנקאית
        </div>
        <div className="bw-grid2">
          <label className="field">
            <span className="field-label">בנק</span>
            <input className="field-input" value={bank} onChange={(e) => setBank(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">סניף</span>
            <input
              className="field-input ltr-num"
              dir="ltr"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
          </label>
        </div>
        <div className="bw-grid2 mt-4">
          <label className="field">
            <span className="field-label">מס׳ חשבון</span>
            <input
              className="field-input ltr-num"
              dir="ltr"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">שם בעל החשבון</span>
            <input
              className="field-input"
              value={holder}
              onChange={(e) => {
                holderTouched.current = true;
                setHolder(e.target.value);
              }}
            />
          </label>
        </div>
      </div>
    );
  }
  if (isCheque) {
    return (
      <div className="bw-metabox">
        <div className="bw-cc-top">
          <Icon name="documents" size={20} />
          פרטי צ׳ק
        </div>
        <div className="bw-grid2">
          <label className="field">
            <span className="field-label">שם הבנק</span>
            <input className="field-input" value={bank} onChange={(e) => setBank(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">סניף</span>
            <input
              className="field-input ltr-num"
              dir="ltr"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
          </label>
        </div>
        <div className="bw-grid2 mt-4">
          <label className="field">
            <span className="field-label">מספר חשבון</span>
            <input
              className="field-input ltr-num"
              dir="ltr"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">מספר צ׳ק</span>
            <input
              className="field-input ltr-num"
              dir="ltr"
              value={chequeNo}
              onChange={(e) => setChequeNo(e.target.value)}
            />
          </label>
        </div>
      </div>
    );
  }
  return null;
}

export function CurrencySelector({
  currencies, value, onChange, disabled,
}: {
  currencies: string[];
  value: string;
  onChange: (c: string) => void;
  disabled?: boolean;
}) {
  if (currencies.length <= 1) return null;
  return (
    <label className="flex items-center gap-2 text-sm text-muted">
      מטבע
      <select
        className="field-input w-28"
        aria-label="מטבע"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {currencies.map((c) => (
          <option key={c} value={c}>
            {CURRENCY_SIGNS[c] ? `${CURRENCY_SIGNS[c]} ${c}` : c}
          </option>
        ))}
      </select>
    </label>
  );
}
