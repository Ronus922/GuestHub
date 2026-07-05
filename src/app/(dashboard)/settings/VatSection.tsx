"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { CardTitle, Field } from "@/components/reservations/BookingPanel";
import { formatVatRate, parseVatRate, VAT_MAX, VAT_MIN } from "@/lib/vat";
import { updateVatRateAction } from "./actions";

// מע״מ ומיסים (D41): a display-only percentage stored in tenants.settings->vat_rate.
// Totals stay VAT-inclusive; changing the rate never recalculates reservations.
export function VatSection({ vatRate }: { vatRate: number }) {
  const [value, setValue] = useState(formatVatRate(vatRate));
  const [saving, startSaving] = useTransition();
  const parsed = parseVatRate(value);
  const invalid = parsed === null;
  const dirty = parsed !== vatRate;

  const save = () =>
    startSaving(async () => {
      const res = await updateVatRateAction(value);
      if (res.success) toast.success("שיעור המע״מ נשמר");
      else toast.error(res.error);
    });

  return (
    <section className="bw-card max-w-xl">
      <CardTitle icon="finance" title="הגדרות מע״מ" />
      <div className="bw-grid2">
        <Field label="שיעור מע״מ (%)" required>
          <input
            className={`bw-fld ${invalid ? "bad" : ""}`}
            dir="ltr"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={invalid}
          />
        </Field>
        <div className="flex items-end">
          <button
            type="button"
            className="bw-btn bw-btn-primary"
            disabled={saving || invalid || !dirty}
            onClick={save}
          >
            <Icon name="check" size={16} />
            {saving ? "שומר…" : "שמירה"}
          </button>
        </div>
      </div>
      <p className="bw-hint">
        {invalid
          ? `ערך לא תקין — נדרש מספר בין ${VAT_MIN} ל־${VAT_MAX}, עד שתי ספרות אחרי הנקודה`
          : "המחירים במערכת כוללים מע״מ; שינוי השיעור משנה את שורת התצוגה בהזמנות בלבד ואינו מחשב מחדש הזמנות קיימות."}
      </p>
    </section>
  );
}
