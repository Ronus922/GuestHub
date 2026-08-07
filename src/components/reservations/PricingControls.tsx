"use client";

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
export const DISCOUNT_UNITS: { value: Exclude<DiscountMode, "none">; label: string; fieldLabel: string }[] = [
  { value: "amount_per_night", label: "₪ ללילה", fieldLabel: "הנחה ללילה (₪)" },
  { value: "percent_per_night", label: "% ללילה", fieldLabel: "אחוז הנחה ללילה (%)" },
  { value: "amount_total", label: "₪ להזמנה", fieldLabel: "הנחה להזמנה (₪)" },
  { value: "percent_total", label: "% להזמנה", fieldLabel: "אחוז הנחה להזמנה (%)" },
];

export function DiscountControls({
  mode, value, onChange, disabled,
}: {
  mode: DiscountMode;
  value: number;
  onChange: (mode: DiscountMode, value: number) => void;
  disabled?: boolean;
}) {
  // "מחיר מלא" is the none state: unit selected with value 0 ⇔ none (SPEC ס-2)
  const unit = mode === "none" ? "amount_total" : mode;
  const field = DISCOUNT_UNITS.find((u) => u.value === unit)!;
  const isPercent = unit === "percent_per_night" || unit === "percent_total";
  return (
    <div className="flex flex-col gap-2">
      <Segmented
        ariaLabel="יחידת הנחה"
        options={DISCOUNT_UNITS.map((u) => ({ value: u.value, label: u.label }))}
        value={unit}
        onChange={(u) => onChange(value > 0 ? u : "none", value)}
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
