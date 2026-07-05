"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { CardTitle, Field } from "@/components/reservations/BookingPanel";
import {
  adultMinAge,
  validateExtraGuestDefaults,
  type ExtraGuestDefaults,
} from "@/lib/commercial/extra-guest";
import { saveExtraGuestDefaultsAction } from "./commercial-actions";
import { Segmented, ToggleRow, useUnsavedGuard } from "./controls";
import type { ExtraGuestView } from "./types";

// §A — default extra-adult/child/infant pricing for the property. Currency is the
// canonical tenants.currency (referenced, read-only here); tax follows the
// canonical VAT setting. These are DEFAULTS only — rooms inherit or override next
// phase (included_occupancy etc. are room-level, not here).
export function ExtraGuestSection({
  value,
  currency,
  vatRate,
}: {
  value: ExtraGuestView;
  currency: string;
  vatRate: number;
}) {
  const [form, setForm] = useState<ExtraGuestDefaults>(strip(value));
  const [saving, startSaving] = useTransition();

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(strip(value)), [form, value]);
  useUnsavedGuard(dirty);
  const errors = validateExtraGuestDefaults(form);

  const set = <K extends keyof ExtraGuestDefaults>(k: K, v: ExtraGuestDefaults[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const save = () =>
    startSaving(async () => {
      const res = await saveExtraGuestDefaultsAction(form);
      if (res.success) toast.success("הגדרות התמחור נשמרו");
      else toast.error(res.error);
    });

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <section className="bw-card">
        <CardTitle icon="users-round" title="סכומי אורח נוסף (ברירת מחדל)" />
        <div className="bw-grid2">
          <MoneyField label="אורח בוגר נוסף" currency={currency} value={form.extra_adult} onChange={(v) => set("extra_adult", v)} />
          <MoneyField label="ילד נוסף" currency={currency} value={form.extra_child} onChange={(v) => set("extra_child", v)} />
          <MoneyField label="תינוק נוסף" currency={currency} value={form.extra_infant} onChange={(v) => set("extra_infant", v)} />
          <Field label="תדירות חיוב" required>
            <Segmented
              ariaLabel="תדירות חיוב"
              value={form.charge_frequency}
              onChange={(v) => set("charge_frequency", v)}
              options={[
                { value: "per_night", label: "לכל לילה" },
                { value: "per_stay", label: "לכל השהות" },
              ]}
            />
          </Field>
        </div>
        <p className="bw-hint">המטבע נקבע לפי הגדרת המטבע הקנונית של הנכס ({currency}).</p>
      </section>

      <section className="bw-card">
        <CardTitle icon="baby" title="גילאים וספירת תפוסה" />
        <div className="bw-grid2">
          <Field label="גיל תינוק מרבי" required>
            <input className="bw-fld" dir="ltr" inputMode="numeric" value={form.infant_max_age}
              onChange={(e) => set("infant_max_age", intOf(e.target.value))} />
          </Field>
          <Field label="גיל ילד מרבי" required>
            <input className="bw-fld" dir="ltr" inputMode="numeric" value={form.child_max_age}
              onChange={(e) => set("child_max_age", intOf(e.target.value))} />
          </Field>
          <Field label="גיל מינימלי לבוגר (נגזר)">
            <input className="bw-fld" dir="ltr" value={adultMinAge(form.child_max_age)} disabled readOnly />
          </Field>
        </div>
        <div className="mt-3 flex flex-col gap-2">
          <ToggleRow
            label="תינוקות נספרים בתפוסת החדר"
            hint="האם תינוק נחשב לצורך תפוסת החדר המרבית"
            checked={form.infants_count_occupancy}
            onChange={(v) => set("infants_count_occupancy", v)}
          />
          <ToggleRow
            label="תינוק תופס מקום מהאורחים הכלולים במחיר"
            hint="האם תינוק מנצל אחד מהאורחים הכלולים במחיר הבסיס"
            checked={form.infants_use_included}
            onChange={(v) => set("infants_use_included", v)}
          />
        </div>
      </section>

      <section className="bw-card">
        <CardTitle icon="finance" title="מס ועיגול" />
        <div className="flex flex-col gap-3">
          <Field label="בסיס מס לסכומי אורח נוסף">
            <Segmented
              ariaLabel="בסיס מס"
              value={form.tax_mode}
              onChange={(v) => set("tax_mode", v)}
              options={[
                { value: "inclusive", label: "כולל מע״מ" },
                { value: "canonical", label: `לפי הגדרת המע״מ (${vatRate}%)` },
              ]}
            />
          </Field>
          <Field label="כלל עיגול מחיר">
            <Segmented
              ariaLabel="כלל עיגול"
              value={form.rounding_mode}
              onChange={(v) => set("rounding_mode", v)}
              options={[
                { value: "none", label: "ללא עיגול" },
                { value: "unit", label: "יחידת מטבע שלמה" },
                { value: "increment", label: "מרווח מוגדר" },
              ]}
            />
          </Field>
          {form.rounding_mode === "increment" && (
            <Field label="מרווח עיגול" required>
              <input className="bw-fld max-w-[160px]" dir="ltr" inputMode="decimal" value={form.rounding_increment}
                onChange={(e) => set("rounding_increment", numOf(e.target.value))} />
            </Field>
          )}
        </div>
      </section>

      {errors.length > 0 && (
        <p className="bw-hint text-status-danger" role="alert">
          <Icon name="warning" size={14} /> {errors[0]}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="button" className="bw-btn bw-btn-primary" disabled={saving || !dirty || errors.length > 0} onClick={save}>
          <Icon name="check" size={16} />
          {saving ? "שומר…" : "שמירת ברירות מחדל"}
        </button>
        {dirty && <span className="text-xs text-faint">יש שינויים שלא נשמרו</span>}
      </div>
    </div>
  );
}

function MoneyField({
  label,
  currency,
  value,
  onChange,
}: {
  label: string;
  currency: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <Field label={`${label} (${currency})`}>
      <input className="bw-fld" dir="ltr" inputMode="decimal" value={value}
        onChange={(e) => onChange(numOf(e.target.value))} />
    </Field>
  );
}

const numOf = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const intOf = (s: string) => {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
};

// Drop the derived adult_min_age before comparing/saving — it is not stored.
function strip(v: ExtraGuestView): ExtraGuestDefaults {
  const { adult_min_age: _drop, ...rest } = v;
  void _drop;
  return rest;
}
