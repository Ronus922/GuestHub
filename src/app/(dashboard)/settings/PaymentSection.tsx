"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import { STATUS_COLORS } from "@/lib/status-colors";
import {
  validatePaymentStages,
  type PaymentStage,
  type PaymentTriggerType,
  type PaymentAmountType,
  type RetryBehavior,
} from "@/lib/commercial/payment";
import { savePaymentPolicyAction, deletePaymentPolicyAction } from "./commercial-actions";
import { PolicyToolbar, PolicyCard, EmptyState } from "./PolicyList";
import { Field, FormGrid, IconBtn, SettingsCard, Switch } from "./controls";
import { PAY_TRIGGER, PAY_AMOUNT, RETRY, TIME_UNIT, opts } from "./labels";
import type { PaymentPolicyView, PaymentMethodRef } from "./types";

type Draft = {
  id?: string;
  name: string;
  public_title: string;
  code: string;
  is_active: boolean;
  is_default: boolean;
  internal_notes: string;
  guest_description: string;
  stages: PaymentStage[];
};

const emptyStage = (): PaymentStage => ({
  trigger_type: "booking",
  trigger_offset_unit: null,
  trigger_offset_value: null,
  amount_type: "percentage",
  amount_value: 0,
  amount_percent: 100,
  methods: [],
  require_card_guarantee: false,
  retry_behavior: "manual",
  staff_instructions: "",
  guest_text: "",
});

const blankDraft = (): Draft => ({
  name: "",
  public_title: "",
  code: "",
  is_active: true,
  is_default: false,
  internal_notes: "",
  guest_description: "",
  stages: [emptyStage()],
});

const toDraft = (p: PaymentPolicyView): Draft => ({
  id: p.id,
  name: p.name,
  public_title: p.public_title,
  code: p.code,
  is_active: p.is_active,
  is_default: p.is_default,
  internal_notes: p.internal_notes ?? "",
  guest_description: p.guest_description ?? "",
  stages: p.stages.length ? p.stages : [emptyStage()],
});

export function PaymentSection({ policies, methods }: { policies: PaymentPolicyView[]; methods: PaymentMethodRef[] }) {
  const [editing, setEditing] = useState<Draft | null>(null);

  return (
    <div className="card">
      <div className="card-bd">
        <PolicyToolbar
          title="מדיניות תשלום"
          subtitle="תבניות גביית תשלום לשימוש חוזר — שלבי גבייה מרובים לכל מדיניות"
          onAdd={() => setEditing(blankDraft())}
        />
        {policies.length === 0 ? (
          <EmptyState label="אין עדיין מדיניות תשלום. הוסף מדיניות ראשונה." />
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
                summary={`${p.stages.length} שלבים`}
                onEdit={() => setEditing(toDraft(p))}
                onDelete={() => deletePaymentPolicyAction(p.id)}
              />
            ))}
          </div>
        )}
      </div>
      {editing && <PaymentEditor draft={editing} methods={methods} onClose={() => setEditing(null)} />}
    </div>
  );
}

function PaymentEditor({ draft, methods, onClose }: { draft: Draft; methods: PaymentMethodRef[]; onClose: () => void }) {
  const router = useRouter();
  const [d, setD] = useState<Draft>(draft);
  const [saving, startSaving] = useTransition();
  const allowed = methods.map((m) => m.key);
  const { errors, warnings } = validatePaymentStages(d.stages, allowed);
  const metaOk = d.name.trim() && d.public_title.trim() && /^[a-z0-9_-]+$/i.test(d.code.trim());
  const canSave = !!metaOk && errors.length === 0;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((s) => ({ ...s, [k]: v }));
  const setStage = (i: number, patch: Partial<PaymentStage>) =>
    setD((s) => ({ ...s, stages: s.stages.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));
  const addStage = () => setD((s) => ({ ...s, stages: [...s.stages, emptyStage()] }));
  const dupStage = (i: number) => setD((s) => ({ ...s, stages: [...s.stages.slice(0, i + 1), { ...s.stages[i] }, ...s.stages.slice(i + 1)] }));
  const rmStage = (i: number) => setD((s) => ({ ...s, stages: s.stages.filter((_, j) => j !== i) }));
  const move = (i: number, dir: -1 | 1) =>
    setD((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.stages.length) return s;
      const t = [...s.stages];
      [t[i], t[j]] = [t[j], t[i]];
      return { ...s, stages: t };
    });

  const save = () =>
    startSaving(async () => {
      const res = await savePaymentPolicyAction({
        ...d,
        name: d.name.trim(),
        public_title: d.public_title.trim(),
        code: d.code.trim(),
        internal_notes: d.internal_notes || null,
        guest_description: d.guest_description || null,
        translations: {},
      });
      if (res.success) {
        toast.success("מדיניות התשלום נשמרה");
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
      title={d.id ? "עריכת מדיניות תשלום" : "מדיניות תשלום חדשה"}
      icon="credit-card"
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
              <input className="field-input ltr-num" value={d.code} onChange={(e) => set("code", e.target.value)} placeholder="deposit-30" />
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
          icon="credit-card"
          title="שלבי גבייה"
          action={
            <button type="button" className="btn btn-secondary shrink-0" onClick={addStage}>
              <Icon name="plus" size={20} /> הוסף שלב
            </button>
          }
        >
          <div className="flex flex-col gap-3">
            {d.stages.map((s, i) => (
              <StageRow
                key={i}
                index={i}
                total={d.stages.length}
                stage={s}
                methods={methods}
                onChange={(patch) => setStage(i, patch)}
                onMove={(dir) => move(i, dir)}
                onDup={() => dupStage(i)}
                onRemove={() => rmStage(i)}
              />
            ))}
          </div>
          {methods.length === 0 && (
            <p className="field-msg mt-3 flex items-center gap-2">
              <Icon name="warning" size={13.5} /> לא הוגדרו אמצעי תשלום — הגדר תחילה תחת אמצעי תשלום.
            </p>
          )}
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

function StageRow({
  index,
  total,
  stage,
  methods,
  onChange,
  onMove,
  onDup,
  onRemove,
}: {
  index: number;
  total: number;
  stage: PaymentStage;
  methods: PaymentMethodRef[];
  onChange: (patch: Partial<PaymentStage>) => void;
  onMove: (dir: -1 | 1) => void;
  onDup: () => void;
  onRemove: () => void;
}) {
  const timed = stage.trigger_type === "before_checkin";
  const showAmount = stage.amount_type === "fixed";
  const showPercent = stage.amount_type === "percentage";
  const toggleMethod = (key: string) =>
    onChange({ methods: stage.methods.includes(key) ? stage.methods.filter((m) => m !== key) : [...stage.methods, key] });

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
          <select className="field-input" value={stage.trigger_type} onChange={(e) => onChange({ trigger_type: e.target.value as PaymentTriggerType })}>
            {opts(PAY_TRIGGER).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        {timed ? (
          <>
            <Field label="יחידה">
              <select className="field-input" value={stage.trigger_offset_unit ?? "days"} onChange={(e) => onChange({ trigger_offset_unit: e.target.value as "hours" | "days" })}>
                {opts(TIME_UNIT).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="לפני הגעה">
              <input className="field-input ltr-num" inputMode="numeric" value={stage.trigger_offset_value ?? ""} onChange={(e) => onChange({ trigger_offset_value: intOrNull(e.target.value) })} />
            </Field>
          </>
        ) : (
          <div className="col-span-2 self-end field-hint">ללא היסט זמן</div>
        )}
        <Field label="סוג סכום">
          <select className="field-input" value={stage.amount_type} onChange={(e) => onChange({ amount_type: e.target.value as PaymentAmountType })}>
            {opts(PAY_AMOUNT).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        {showAmount && (
          <Field label="סכום">
            <input className="field-input ltr-num" inputMode="decimal" value={stage.amount_value} onChange={(e) => onChange({ amount_value: numOf(e.target.value) })} />
          </Field>
        )}
        {showPercent && (
          <Field label="אחוז">
            <input className="field-input ltr-num" inputMode="decimal" value={stage.amount_percent} onChange={(e) => onChange({ amount_percent: numOf(e.target.value) })} />
          </Field>
        )}
        <Field label="התנהגות כשל">
          <select className="field-input" value={stage.retry_behavior} onChange={(e) => onChange({ retry_behavior: e.target.value as RetryBehavior })}>
            {opts(RETRY).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="t-label">אמצעי תשלום מותרים:</span>
        {methods.map((m) => {
          const on = stage.methods.includes(m.key);
          return (
            <button
              key={m.key}
              type="button"
              aria-pressed={on}
              onClick={() => toggleMethod(m.key)}
              className={`chip clickable ${on ? "on" : ""}`}
            >
              {m.label}
            </button>
          );
        })}
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm text-ink">
        <Switch checked={stage.require_card_guarantee} onChange={(v) => onChange({ require_card_guarantee: v })} label="נדרש כרטיס להבטחה" />
        נדרש כרטיס אשראי להבטחה
      </label>
      <div className="mt-3">
        <FormGrid>
          <Field label="הוראות לצוות">
            <textarea className="field-input" rows={2} value={stage.staff_instructions ?? ""} onChange={(e) => onChange({ staff_instructions: e.target.value })} />
          </Field>
          <Field label="טקסט ללקוח">
            <textarea className="field-input" rows={2} value={stage.guest_text ?? ""} onChange={(e) => onChange({ guest_text: e.target.value })} />
          </Field>
        </FormGrid>
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
