"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import {
  validateCheckInCheckOutSettings,
  type CheckInCheckOutSettings,
} from "@/lib/check-in-check-out";
import { useUnsavedGuard } from "./controls";
import { saveCheckInCheckOutSettingsAction } from "./check-in-check-out-actions";

const WEEKDAYS = [
  { value: 0, label: "א" },
  { value: 1, label: "ב" },
  { value: 2, label: "ג" },
  { value: 3, label: "ד" },
  { value: 4, label: "ה" },
  { value: 5, label: "ו" },
  { value: 6, label: "ש" },
] as const;

export function CheckInCheckOutSection({ initial }: { initial: CheckInCheckOutSettings }) {
  const [form, setForm] = useState<CheckInCheckOutSettings>(initial);
  const [saved, setSaved] = useState<CheckInCheckOutSettings>(initial);
  const [saving, startSaving] = useTransition();
  const submittingRef = useRef(false);
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(saved), [form, saved]);
  const validation = validateCheckInCheckOutSettings(form);
  useUnsavedGuard(dirty);

  const toggleWeekday = (weekday: number) => {
    setForm((current) => {
      const selected = current.regular.weekdays.includes(weekday);
      const weekdays = selected
        ? current.regular.weekdays.filter((item) => item !== weekday)
        : [...current.regular.weekdays, weekday].sort((a, b) => a - b);
      return { ...current, regular: { ...current.regular, weekdays } };
    });
  };

  const save = () => {
    if (submittingRef.current || saving || !dirty || !validation.success) return;
    submittingRef.current = true;
    startSaving(async () => {
      try {
        const result = await saveCheckInCheckOutSettingsAction(form);
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        const next = result.data ?? form;
        setForm(next);
        setSaved(next);
        toast.success("שעות הצ׳ק-אין והצ׳ק-אאוט נשמרו");
      } catch {
        toast.error("שמירת השעות נכשלה. השינויים נשמרו בטופס וניתן לנסות שוב");
      } finally {
        submittingRef.current = false;
      }
    });
  };

  return (
    <section className="check-hours" aria-labelledby="check-hours-title">
      <header className="check-hours__page-header">
        <span className="check-hours__page-icon"><Icon name="attendance" size={24} /></span>
        <div>
          <h2 id="check-hours-title">שעות צ׳ק-אין וצ׳ק-אאוט</h2>
          <p>השעות מוצגות לאורח במייל האישור, לפי יום ההגעה והעזיבה בפועל</p>
        </div>
      </header>

      <div className="check-hours__grid">
        <HoursCard
          icon="date-range"
          title="ימים א׳–ו׳"
          subtitle="ימי חול וערבי שבת"
          chips={WEEKDAYS.map((weekday) => ({
            key: String(weekday.value),
            label: weekday.label,
            selected: form.regular.weekdays.includes(weekday.value),
            onClick: () => toggleWeekday(weekday.value),
            ariaLabel: `יום ${weekday.label}`,
          }))}
          checkIn={form.regular.check_in_from}
          checkOut={form.regular.check_out_until}
          onCheckIn={(value) => setForm((current) => ({
            ...current,
            regular: { ...current.regular, check_in_from: value },
          }))}
          onCheckOut={(value) => setForm((current) => ({
            ...current,
            regular: { ...current.regular, check_out_until: value },
          }))}
        />

        <HoursCard
          icon="sun"
          title="שבת וחג"
          subtitle="שבתות, חגים וימים מיוחדים"
          chips={[
            {
              key: "saturday", label: "ש", selected: form.special.saturday,
              onClick: () => setSpecialFlag("saturday"), ariaLabel: "שבת",
            },
            {
              key: "holiday_eve", label: "ערב חג", selected: form.special.holiday_eve,
              onClick: () => setSpecialFlag("holiday_eve"), ariaLabel: "ערב חג", wide: true,
            },
            {
              key: "holiday", label: "חג", selected: form.special.holiday,
              onClick: () => setSpecialFlag("holiday"), ariaLabel: "חג", wide: true,
            },
          ]}
          checkIn={form.special.check_in_from}
          checkOut={form.special.check_out_until}
          onCheckIn={(value) => setForm((current) => ({
            ...current,
            special: { ...current.special, check_in_from: value },
          }))}
          onCheckOut={(value) => setForm((current) => ({
            ...current,
            special: { ...current.special, check_out_until: value },
          }))}
          note="חלות על הזמנות שבהן ההגעה או העזיבה יוצאות בשבת או בחג"
        />
      </div>

      <section className="check-hours__preview" aria-labelledby="check-hours-preview-title">
        <header>
          <Icon name="eye" size={20} />
          <h3 id="check-hours-preview-title">כך יוצג לאורח במייל האישור</h3>
        </header>
        <div className="check-hours__preview-body" aria-live="polite">
          <PreviewRow
            label="ימים א׳–ו׳"
            checkIn={form.regular.check_in_from}
            checkOut={form.regular.check_out_until}
          />
          <PreviewRow
            label="שבת וחג"
            special
            checkIn={form.special.check_in_from}
            checkOut={form.special.check_out_until}
          />
        </div>
      </section>

      {!validation.success && <p className="field-msg" role="alert">{validation.error}</p>}

      <footer className="check-hours__footer">
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || !dirty || !validation.success}
          onClick={save}
        >
          <Icon name="check" size={20} />
          {saving ? "שומר…" : "שמירת הגדרות"}
        </button>
      </footer>
    </section>
  );

  function setSpecialFlag(key: "saturday" | "holiday_eve" | "holiday") {
    setForm((current) => ({
      ...current,
      special: { ...current.special, [key]: !current.special[key] },
    }));
  }
}

type ChipDef = {
  key: string;
  label: string;
  ariaLabel: string;
  selected: boolean;
  onClick: () => void;
  wide?: boolean;
};

function HoursCard({
  icon,
  title,
  subtitle,
  chips,
  checkIn,
  checkOut,
  onCheckIn,
  onCheckOut,
  note,
}: {
  icon: "date-range" | "sun";
  title: string;
  subtitle: string;
  chips: ChipDef[];
  checkIn: string;
  checkOut: string;
  onCheckIn: (value: string) => void;
  onCheckOut: (value: string) => void;
  note?: string;
}) {
  return (
    <section className="check-hours__card">
      <header>
        <span className="check-hours__card-icon"><Icon name={icon} size={20} /></span>
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
      </header>
      <div className="check-hours__card-body">
        <div className="check-hours__chips" role="group" aria-label={`בחירת ימים — ${title}`}>
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              aria-pressed={chip.selected}
              aria-label={chip.ariaLabel}
              className={`check-hours__chip-target${chip.wide ? " check-hours__chip-target--wide" : ""}`}
              onClick={chip.onClick}
            >
              <span className={`chip${chip.selected ? " is-selected" : ""}`}>{chip.label}</span>
            </button>
          ))}
        </div>
        <div className="check-hours__fields">
          <TimeField id={`${title}-check-in`} icon="login" label="צ׳ק-אין החל מ-" value={checkIn} onChange={onCheckIn} />
          <TimeField id={`${title}-check-out`} icon="logout" label="צ׳ק-אאוט עד" value={checkOut} onChange={onCheckOut} />
        </div>
        {note && <p className="check-hours__note"><Icon name="info" size={17} />{note}</p>}
      </div>
    </section>
  );
}

function TimeField({
  id,
  icon,
  label,
  value,
  onChange,
}: {
  id: string;
  icon: "login" | "logout";
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="check-hours__field" htmlFor={id}>
      <span><Icon name={icon} size={17} />{label}</span>
      <input id={id} type="time" value={value} onChange={(event) => onChange(event.target.value)} required />
    </label>
  );
}

function PreviewRow({
  label,
  checkIn,
  checkOut,
  special,
}: {
  label: string;
  checkIn: string;
  checkOut: string;
  special?: boolean;
}) {
  return (
    <p>
      <span className={`chip${special ? " is-selected" : ""}`}>{label}</span>
      <span>צ׳ק-אין החל מ- <strong>{checkIn}</strong> · צ׳ק-אאוט עד <strong>{checkOut}</strong></span>
    </p>
  );
}
