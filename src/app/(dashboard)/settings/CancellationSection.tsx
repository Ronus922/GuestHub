"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import { STATUS_COLORS } from "@/lib/status-colors";
import {
  validateCancellationTiers,
  type CancellationTier,
  type CancellationTriggerType,
  type CancellationFeeType,
} from "@/lib/commercial/cancellation";
import { saveCancellationPolicyAction, deleteCancellationPolicyAction } from "./commercial-actions";
import { PolicyToolbar, PolicyCard, EmptyState } from "./PolicyList";
import { Field, FormGrid, IconBtn, SettingsCard, Switch } from "./controls";
import { CANCEL_TRIGGER, CANCEL_FEE, CALC_BASE, DISTRIBUTION, TIME_UNIT, opts } from "./labels";
import type { CancellationPolicyView } from "./types";

type Draft = {
  id?: string;
  name: string;
  public_title: string;
  code: string;
  is_active: boolean;
  is_default: boolean;
  internal_notes: string;
  guest_description: string;
  distribution_scope: CancellationPolicyView["distribution_scope"];
  tiers: CancellationTier[];
};

const emptyTier = (): CancellationTier => ({
  trigger_type: "before_checkin",
  time_unit: "days",
  time_from: 0,
  time_to: null,
  fee_type: "percentage",
  fee_amount: 0,
  fee_percent: 100,
  fee_nights: 0,
  calc_base: "accommodation",
});

const blankDraft = (): Draft => ({
  name: "",
  public_title: "",
  code: "",
  is_active: true,
  is_default: false,
  internal_notes: "",
  guest_description: "",
  distribution_scope: "direct_and_channels",
  tiers: [emptyTier()],
});

const toDraft = (p: CancellationPolicyView): Draft => ({
  id: p.id,
  name: p.name,
  public_title: p.public_title,
  code: p.code,
  is_active: p.is_active,
  is_default: p.is_default,
  internal_notes: p.internal_notes ?? "",
  guest_description: p.guest_description ?? "",
  distribution_scope: p.distribution_scope,
  tiers: p.tiers.length ? p.tiers : [emptyTier()],
});

export function CancellationSection({ policies }: { policies: CancellationPolicyView[] }) {
  const [editing, setEditing] = useState<Draft | null>(null);

  return (
    <div className="card">
      <div className="card-bd">
        <PolicyToolbar
          title="מדיניות ביטול"
          subtitle="תבניות מדיניות ביטול לשימוש חוזר — מספר שלבי עמלה בלתי מוגבל לכל מדיניות"
          onAdd={() => setEditing(blankDraft())}
        />
        {policies.length === 0 ? (
          <EmptyState label="אין עדיין מדיניות ביטול. הוסף מדיניות ראשונה." />
        ) : (
          <div className="flex flex-col gap-3">
            {policies.map((p) => (
              <PolicyCard
                key={p.id}
                name={p.name}
                title={p.public_title}
                code={p.code}
                isDefault={p.is_default}
                isActive={p.is_active}
                summary={`${p.tiers.length} שלבים · ${DISTRIBUTION[p.distribution_scope]}`}
                onEdit={() => setEditing(toDraft(p))}
                onDelete={() => deleteCancellationPolicyAction(p.id)}
              />
            ))}
          </div>
        )}
      </div>
      {editing && <CancellationEditor draft={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function CancellationEditor({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const router = useRouter();
  const [d, setD] = useState<Draft>(draft);
  const [saving, startSaving] = useTransition();
  const { errors, warnings } = validateCancellationTiers(d.tiers);
  const metaOk = d.name.trim() && d.public_title.trim() && /^[a-z0-9_-]+$/i.test(d.code.trim());
  const canSave = !!metaOk && errors.length === 0;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((s) => ({ ...s, [k]: v }));
  const setTier = (i: number, patch: Partial<CancellationTier>) =>
    setD((s) => ({ ...s, tiers: s.tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));
  const addTier = () => setD((s) => ({ ...s, tiers: [...s.tiers, emptyTier()] }));
  const dupTier = (i: number) => setD((s) => ({ ...s, tiers: [...s.tiers.slice(0, i + 1), { ...s.tiers[i] }, ...s.tiers.slice(i + 1)] }));
  const rmTier = (i: number) => setD((s) => ({ ...s, tiers: s.tiers.filter((_, j) => j !== i) }));
  const move = (i: number, dir: -1 | 1) =>
    setD((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.tiers.length) return s;
      const t = [...s.tiers];
      [t[i], t[j]] = [t[j], t[i]];
      return { ...s, tiers: t };
    });

  const save = () =>
    startSaving(async () => {
      const res = await saveCancellationPolicyAction({
        ...d,
        name: d.name.trim(),
        public_title: d.public_title.trim(),
        code: d.code.trim(),
        internal_notes: d.internal_notes || null,
        guest_description: d.guest_description || null,
        translations: {},
      });
      if (res.success) {
        toast.success("מדיניות הביטול נשמרה");
        router.refresh();
        onClose();
      } else {
        toast.error(res.error);
      }
    });

  return (
    <SidePanel
      open
      onClose={onClose}
      title={d.id ? "עריכת מדיניות ביטול" : "מדיניות ביטול חדשה"}
      icon="circle-slash"
      footer={
        /* §7 flat footer: .dw-ft is row-reverse, so the FIRST DOM child (the
           primary) hugs the LEFT edge, cancel to its right; the tertiary meta
           rides the far right via me-auto (margin-left in RTL row-reverse). */
        <>
          <button type="button" className="btn btn-primary" disabled={saving || !canSave} onClick={save}>
            <Icon name="check" size={20} />
            {saving ? "שומר…" : "שמירה"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>ביטול</button>
          <span className="field-hint me-auto">{warnings.length > 0 ? `${warnings.length} אזהרות` : ""}</span>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <SettingsCard icon="documents" title="פרטי מדיניות">
          <FormGrid>
            <Field label="שם פנימי" required>
              <input className="field-input" value={d.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field label="כותרת ללקוח" required>
              <input className="field-input" value={d.public_title} onChange={(e) => set("public_title", e.target.value)} />
            </Field>
            <Field label="קוד/מפתח" required>
              <input className="field-input ltr-num" value={d.code} onChange={(e) => set("code", e.target.value)} placeholder="flex-14d" />
            </Field>
            <Field label="הפצה">
              <select className="field-input" value={d.distribution_scope} onChange={(e) => set("distribution_scope", e.target.value as Draft["distribution_scope"])}>
                {opts(DISTRIBUTION).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
          </FormGrid>
          <div className="mt-3 flex flex-wrap items-center gap-5">
            <label className="flex items-center gap-2 text-sm text-ink">
              <Switch checked={d.is_active} onChange={(v) => set("is_active", v)} label="פעיל" /> פעיל
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <Switch checked={d.is_default} onChange={(v) => set("is_default", v)} label="ברירת מחדל" /> ברירת מחדל
            </label>
          </div>
          <div className="mt-3">
            <FormGrid>
              <Field label="תיאור ללקוח">
                <textarea className="field-input" rows={2} value={d.guest_description} onChange={(e) => set("guest_description", e.target.value)} />
              </Field>
              <Field label="הערות פנימיות">
                <textarea className="field-input" rows={2} value={d.internal_notes} onChange={(e) => set("internal_notes", e.target.value)} />
              </Field>
            </FormGrid>
          </div>
        </SettingsCard>

        <SettingsCard
          icon="circle-slash"
          title="שלבי עמלת ביטול"
          action={
            <button type="button" className="btn btn-secondary shrink-0" onClick={addTier}>
              <Icon name="plus" size={20} /> הוסף שלב
            </button>
          }
        >
          <div className="flex flex-col gap-3">
            {d.tiers.map((t, i) => (
              <TierRow
                key={i}
                index={i}
                total={d.tiers.length}
                tier={t}
                onChange={(patch) => setTier(i, patch)}
                onMove={(dir) => move(i, dir)}
                onDup={() => dupTier(i)}
                onRemove={() => rmTier(i)}
              />
            ))}
          </div>
        </SettingsCard>

        {(errors.length > 0 || warnings.length > 0) && (
          <section className="card">
            <div className="card-bd flex flex-col gap-1">
              {errors.map((e, i) => (
                <p key={`e${i}`} className="field-msg flex items-center gap-2">
                  <Icon name="warning" size={13.5} /> {e}
                </p>
              ))}
              {warnings.map((w, i) => (
                // the approved §3.1 "ממתין לאישור" text colour — the system's one amber
                <p key={`w${i}`} className="flex items-center gap-2 text-sm" style={{ color: STATUS_COLORS.approval.tx }}>
                  <Icon name="info" size={13.5} /> {w}
                </p>
              ))}
            </div>
          </section>
        )}
      </div>
    </SidePanel>
  );
}

function TierRow({
  index,
  total,
  tier,
  onChange,
  onMove,
  onDup,
  onRemove,
}: {
  index: number;
  total: number;
  tier: CancellationTier;
  onChange: (patch: Partial<CancellationTier>) => void;
  onMove: (dir: -1 | 1) => void;
  onDup: () => void;
  onRemove: () => void;
}) {
  const timed = tier.trigger_type === "before_checkin";
  const showAmount = tier.fee_type === "fixed" || tier.fee_type === "higher_of" || tier.fee_type === "lower_of";
  const showPercent = tier.fee_type === "percentage" || tier.fee_type === "percentage_remaining" || tier.fee_type === "higher_of" || tier.fee_type === "lower_of";
  const showNights = tier.fee_type === "nights";

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="t-label">שלב {index + 1}</span>
        <div className="flex items-center gap-1">
          <IconBtn name="arrow-up" label="הזז מעלה" disabled={index === 0} onClick={() => onMove(-1)} />
          <IconBtn name="arrow-down" label="הזז מטה" disabled={index === total - 1} onClick={() => onMove(1)} />
          <IconBtn name="copy" label="שכפול" onClick={onDup} />
          <IconBtn name="trash" label="מחיקה" disabled={total <= 1} onClick={onRemove} danger />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="טריגר">
          <select className="field-input" value={tier.trigger_type} onChange={(e) => onChange({ trigger_type: e.target.value as CancellationTriggerType })}>
            {opts(CANCEL_TRIGGER).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        {timed ? (
          <>
            <Field label="יחידה">
              <select className="field-input" value={tier.time_unit ?? "days"} onChange={(e) => onChange({ time_unit: e.target.value as "hours" | "days" })}>
                {opts(TIME_UNIT).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="מ־ (קרוב להגעה)">
              <input className="field-input ltr-num" inputMode="numeric" value={tier.time_from ?? 0} onChange={(e) => onChange({ time_from: intOrNull(e.target.value) ?? 0 })} />
            </Field>
            <Field label="עד (ריק=פתוח)">
              <input className="field-input ltr-num" inputMode="numeric" value={tier.time_to ?? ""} onChange={(e) => onChange({ time_to: intOrNull(e.target.value) })} />
            </Field>
          </>
        ) : (
          <div className="col-span-3 self-end field-hint">אין טווח זמן לטריגר זה</div>
        )}
        <Field label="סוג עמלה">
          <select className="field-input" value={tier.fee_type} onChange={(e) => onChange({ fee_type: e.target.value as CancellationFeeType })}>
            {opts(CANCEL_FEE).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        {showAmount && (
          <Field label="סכום">
            <input className="field-input ltr-num" inputMode="decimal" value={tier.fee_amount} onChange={(e) => onChange({ fee_amount: numOf(e.target.value) })} />
          </Field>
        )}
        {showPercent && (
          <Field label="אחוז">
            <input className="field-input ltr-num" inputMode="decimal" value={tier.fee_percent} onChange={(e) => onChange({ fee_percent: numOf(e.target.value) })} />
          </Field>
        )}
        {showNights && (
          <Field label="לילות">
            <input className="field-input ltr-num" inputMode="numeric" value={tier.fee_nights} onChange={(e) => onChange({ fee_nights: intOrNull(e.target.value) ?? 0 })} />
          </Field>
        )}
        <Field label="בסיס חישוב">
          <select className="field-input" value={tier.calc_base} onChange={(e) => onChange({ calc_base: e.target.value as CancellationTier["calc_base"] })}>
            {opts(CALC_BASE).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
      </div>
    </div>
  );
}

const numOf = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const intOrNull = (s: string): number | null => {
  if (s.trim() === "") return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
};
