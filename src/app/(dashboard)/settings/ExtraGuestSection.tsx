"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { STATUS_COLORS } from "@/lib/status-colors";
import {
  adultMinAge,
  validateExtraGuestDefaults,
  type ExtraGuestDefaults,
} from "@/lib/commercial/extra-guest";
import { saveExtraGuestDefaultsAction } from "./commercial-actions";
import { Field, FormGrid, Segmented, SettingsCard, ToggleRow, useUnsavedGuard } from "./controls";
import type { ExtraGuestView } from "./types";

// §A — default extra-adult/child/infant pricing for the property. Currency is the
// canonical tenants.currency (referenced, read-only here); tax follows the
// canonical VAT setting. Prices are nullable: "טרם הוגדר" until an authorized user
// explicitly saves (0 is a valid explicit value, never a silent default).
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
  // Saving the section configures it — validate as configured so amounts are required.
  const errors = validateExtraGuestDefaults({ ...form, configured: true });

  const set = <K extends keyof ExtraGuestDefaults>(k: K, v: ExtraGuestDefaults[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const save = () =>
    startSaving(async () => {
      const res = await saveExtraGuestDefaultsAction({ ...form, configured: true });
      if (res.success) toast.success("הגדרות התמחור נשמרו");
      else toast.error(res.error);
    });

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      {!value.configured && (
        // the approved §3.1 "ממתין לאישור" family — the only amber the system owns
        <div
          className="flex items-center gap-2 rounded-xl border px-4 py-3 text-sm"
          style={{
            background: STATUS_COLORS.approval.bg,
            borderColor: STATUS_COLORS.approval.bd,
            color: STATUS_COLORS.approval.tx,
          }}
        >
          <Icon name="info" size={17} />
          תמחור אורח נוסף <strong>טרם הוגדר</strong> לנכס. חדרים היורשים מהנכס יסומנו כדורשים השלמה עד שתגדיר ותשמור כאן.
        </div>
      )}

      <SettingsCard icon="users-round" title="סכומי אורח נוסף (ברירת מחדל)">
        <FormGrid>
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
        </FormGrid>
        <p className="field-hint mt-3">
          המטבע נקבע לפי הגדרת המטבע הקנונית של הנכס ({currency}). ניתן לשמור 0 כערך מפורש.
        </p>
      </SettingsCard>

      <SettingsCard icon="baby" title="גילאים וספירת תפוסה">
        <FormGrid>
          <Field label="גיל תינוק מרבי" required>
            <input className="field-input ltr-num" inputMode="numeric" value={form.infant_max_age}
              onChange={(e) => set("infant_max_age", intOf(e.target.value))} />
          </Field>
          <Field label="גיל ילד מרבי" required>
            <input className="field-input ltr-num" inputMode="numeric" value={form.child_max_age}
              onChange={(e) => set("child_max_age", intOf(e.target.value))} />
          </Field>
          <Field label="גיל מינימלי לבוגר (נגזר)">
            <input className="field-input ltr-num" value={adultMinAge(form.child_max_age)} disabled readOnly />
          </Field>
        </FormGrid>
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
      </SettingsCard>

      <SettingsCard icon="finance" title="מס ועיגול">
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
              <input className="field-input ltr-num max-w-[160px]" inputMode="decimal" value={form.rounding_increment}
                onChange={(e) => set("rounding_increment", numOf(e.target.value) ?? 0)} />
            </Field>
          )}
        </div>
      </SettingsCard>

      {errors.length > 0 && (
        <p className="field-msg flex items-center gap-2" role="alert">
          <Icon name="warning" size={13.5} /> {errors[0]}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="button" className="btn btn-primary" disabled={saving || !dirty || errors.length > 0} onClick={save}>
          <Icon name="check" size={20} />
          {saving ? "שומר…" : "שמירת ברירות מחדל"}
        </button>
        {dirty && <span className="field-hint">יש שינויים שלא נשמרו</span>}
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
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <Field label={`${label} (${currency})`}>
      <input
        className="field-input ltr-num"
        inputMode="decimal"
        placeholder="טרם הוגדר"
        value={value ?? ""}
        onChange={(e) => onChange(numOf(e.target.value))}
      />
    </Field>
  );
}

// empty string → null (not configured); a number → 2-decimal money (0 allowed)
const numOf = (s: string): number | null => {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
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
