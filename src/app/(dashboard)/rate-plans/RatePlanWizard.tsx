"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import { Badge } from "@/components/ui/Badge";
import { Segmented, Switch, ToggleRow } from "@/app/(dashboard)/settings/controls";
import { F, QtyStep, Sec } from "@/app/(dashboard)/rooms/RoomWizard";
import { applyPlanAdjustment, planFormulaLabel, type PlanKind } from "@/lib/pricing/resolve";
import { formatFullDate, HEBREW_DAY_LETTERS } from "@/lib/dates";
import type { RatePlanSaveInput } from "@/lib/validation/rate-plans";
import type { RatePlanDetail } from "@/lib/rate-plans/service";
import type { AssignableUnit, PolicyOption, RatePlanListItem } from "./types";
import { saveRatePlanAction } from "./actions";

// ============================================================
// Rate-plan wizard — ONE shared 3-step form for create + edit (rooms-wizard
// pattern: 60vw drawer, rm-steps band, Sec/F/QtyStep building blocks).
// detail === null → create. The live formula preview goes through the CENTRAL
// pricing utilities (planFormulaLabel / applyPlanAdjustment) — never a local
// formula. Save builds RatePlanSaveInput exactly per the zod schema.
// ============================================================

type Step = 1 | 2 | 3;

const EXAMPLE_BASE = 500; // UI illustration only — the math is applyPlanAdjustment's

type Draft = {
  name: string;
  code: string;
  publicName: string;
  description: string;
  publicDescription: string;
  isActive: boolean;
  sortOrder: number;
  isRefundable: boolean;
  cancellationPolicyId: string;
  paymentPolicyId: string;
  mealPlan: string;
  validFrom: string;
  validUntil: string;
  planKind: PlanKind;
  parentPlanId: string;
  adjustment: string; // raw input — parsed once, never re-derived locally
  minStay: number | null;
  maxStay: number | null;
  minAdvance: number | null;
  maxAdvance: number | null;
  allDays: boolean;
  days: number[]; // dayOfWeek 0=Sunday…6
  cta: boolean;
  ctd: boolean;
  visibleWebsite: boolean;
  visibleChannels: boolean;
};

type AssignDraft = { on: boolean; adj: string };

type VErr = { step: Step; msg: string };

export function RatePlanWizard({
  open,
  onClose,
  detail,
  plans,
  units,
  cancellationPolicies,
  paymentPolicies,
  canSave,
}: {
  open: boolean;
  onClose: () => void;
  detail: RatePlanDetail | null; // null = create
  plans: RatePlanListItem[];
  units: AssignableUnit[];
  cancellationPolicies: PolicyOption[];
  paymentPolicies: PolicyOption[];
  canSave: boolean;
}) {
  const router = useRouter();
  const [saving, startSaving] = useTransition();
  const [step, setStep] = useState<Step>(1);

  const [d, setD] = useState<Draft>(() => ({
    name: detail?.name ?? "",
    code: detail?.code ?? "",
    publicName: detail?.public_name ?? "",
    description: detail?.description ?? "",
    publicDescription: detail?.public_description ?? "",
    isActive: detail?.is_active ?? true,
    sortOrder: detail?.sort_order ?? 0,
    isRefundable: detail?.is_refundable ?? true,
    cancellationPolicyId: detail?.cancellation_policy_id ?? "",
    paymentPolicyId: detail?.payment_policy_id ?? "",
    mealPlan: detail?.meal_plan ?? "",
    validFrom: detail?.valid_from ?? "",
    validUntil: detail?.valid_until ?? "",
    planKind: detail?.plan_kind ?? "base",
    parentPlanId: detail?.parent_plan_id ?? "",
    adjustment: detail?.adjustment_value != null ? String(detail.adjustment_value) : "",
    minStay: detail?.default_min_stay ?? null,
    maxStay: detail?.default_max_stay ?? null,
    minAdvance: detail?.min_advance_days ?? null,
    maxAdvance: detail?.max_advance_days ?? null,
    allDays: (detail?.allowed_checkin_days ?? null) === null,
    days: detail?.allowed_checkin_days ?? [0, 1, 2, 3, 4, 5, 6],
    cta: detail?.default_closed_to_arrival ?? false,
    ctd: detail?.default_closed_to_departure ?? false,
    visibleWebsite: detail?.is_visible_website ?? false,
    visibleChannels: detail?.is_visible_channels ?? false,
  }));

  const [assign, setAssign] = useState<Record<string, AssignDraft>>(() => {
    const init: Record<string, AssignDraft> = {};
    for (const u of units) init[u.sellable_unit_id] = { on: false, adj: "" };
    for (const a of detail?.assignments ?? []) {
      init[a.sellable_unit_id] = {
        on: a.is_active,
        adj: a.adjustment_value != null ? String(a.adjustment_value) : "",
      };
    }
    return init;
  });

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((s) => ({ ...s, [k]: v }));
  const setUnit = (id: string, patch: Partial<AssignDraft>) =>
    setAssign((s) => ({
      ...s,
      [id]: { on: s[id]?.on ?? false, adj: s[id]?.adj ?? "", ...patch },
    }));

  const derived = d.planKind === "derived_percentage" || d.planKind === "derived_fixed";
  const unitSign = d.planKind === "derived_percentage" ? "%" : "₪";

  const adjNum = useMemo(() => {
    const t = d.adjustment.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }, [d.adjustment]);

  // parent candidates: tenant plans that are not archived and not this plan
  // (an archived current parent stays listed so edit mode doesn't lose it)
  const parentOptions = useMemo(
    () => plans.filter((p) => p.id !== detail?.id && (!p.is_archived || p.id === d.parentPlanId)),
    [plans, detail?.id, d.parentPlanId],
  );
  const parentName = parentOptions.find((p) => p.id === d.parentPlanId)?.name ?? null;

  // live preview — ALWAYS via the central pricing utilities
  const formula = planFormulaLabel({ planKind: d.planKind, adjustmentValue: adjNum }, parentName);
  const exampleResult =
    derived && adjNum != null ? applyPlanAdjustment(d.planKind, EXAMPLE_BASE, adjNum) : null;

  const assignedCount = units.filter((u) => assign[u.sellable_unit_id]?.on).length;

  const changeKind = (v: PlanKind) =>
    setD((s) => ({
      ...s,
      planKind: v,
      ...(v === "derived_percentage" || v === "derived_fixed"
        ? {}
        : { parentPlanId: "", adjustment: "" }),
    }));

  const toggleDay = (i: number) =>
    setD((s) => ({
      ...s,
      days: s.days.includes(i) ? s.days.filter((x) => x !== i) : [...s.days, i].sort((a, b) => a - b),
    }));

  const setAll = (on: boolean) =>
    setAssign((s) => {
      const next = { ...s };
      for (const u of units)
        next[u.sellable_unit_id] = { on, adj: next[u.sellable_unit_id]?.adj ?? "" };
      return next;
    });

  // ---- validation mirroring src/lib/validation/rate-plans.ts ----
  const validate = (): VErr[] => {
    const errs: VErr[] = [];
    if (!d.name.trim()) errs.push({ step: 1, msg: "נדרש שם לתוכנית" });
    const code = d.code.trim();
    if (!code) errs.push({ step: 1, msg: "נדרש קוד לתוכנית" });
    else if (!/^[a-zA-Z0-9_-]+$/.test(code))
      errs.push({ step: 1, msg: "קוד יכול להכיל אותיות באנגלית, ספרות, מקף וקו תחתון בלבד" });
    if (d.validFrom && d.validUntil && d.validUntil < d.validFrom)
      errs.push({ step: 1, msg: "תאריך סיום התוקף קודם לתאריך ההתחלה" });
    if (derived) {
      if (!d.parentPlanId) errs.push({ step: 2, msg: "תוכנית נגזרת חייבת תוכנית אב" });
      if (adjNum == null) errs.push({ step: 2, msg: "תוכנית נגזרת חייבת ערך התאמה" });
      if (d.planKind === "derived_percentage" && adjNum != null && adjNum <= -100)
        errs.push({ step: 2, msg: "הנחה באחוזים חייבת להיות קטנה מ-100%" });
    }
    if (d.minAdvance != null && d.maxAdvance != null && d.maxAdvance < d.minAdvance)
      errs.push({ step: 2, msg: "חלון ההזמנה המקסימלי קטן מהמינימלי" });
    if (d.minStay != null && d.maxStay != null && d.maxStay < d.minStay)
      errs.push({ step: 2, msg: "מקסימום הלילות קטן מהמינימום" });
    if (!d.allDays && d.days.length === 0)
      errs.push({ step: 2, msg: "יש לבחור לפחות יום הגעה אחד" });
    if (d.planKind === "derived_percentage") {
      for (const u of units) {
        const a = assign[u.sellable_unit_id];
        if (!a?.on || !a.adj.trim()) continue;
        const n = Number(a.adj);
        if (Number.isFinite(n) && n <= -100) {
          errs.push({ step: 3, msg: "הנחה באחוזים ליחידה חייבת להיות קטנה מ-100%" });
          break;
        }
      }
    }
    return errs;
  };
  const errs = validate();

  const buildPayload = (): RatePlanSaveInput => ({
    id: detail?.id,
    name: d.name.trim(),
    code: d.code.trim(),
    publicName: d.publicName.trim() || null,
    description: d.description.trim() || null,
    publicDescription: d.publicDescription.trim() || null,
    planKind: d.planKind,
    parentPlanId: derived ? d.parentPlanId || null : null,
    adjustmentValue: derived ? adjNum : null,
    isActive: d.isActive,
    isRefundable: d.isRefundable,
    cancellationPolicyId: d.cancellationPolicyId || null,
    paymentPolicyId: d.paymentPolicyId || null,
    mealPlan: d.mealPlan.trim() || null,
    validFrom: d.validFrom || null,
    validUntil: d.validUntil || null,
    minAdvanceDays: d.minAdvance,
    maxAdvanceDays: d.maxAdvance,
    allowedCheckinDays: d.allDays ? null : [...d.days].sort((a, b) => a - b),
    defaultMinStay: d.minStay,
    defaultMaxStay: d.maxStay,
    defaultClosedToArrival: d.cta,
    defaultClosedToDeparture: d.ctd,
    isVisibleWebsite: d.visibleWebsite,
    isVisibleChannels: d.visibleChannels,
    sortOrder: d.sortOrder,
    assignments: units
      .filter((u) => assign[u.sellable_unit_id]?.on)
      .map((u) => {
        const raw = assign[u.sellable_unit_id]?.adj.trim() ?? "";
        const n = raw ? Number(raw) : null;
        return {
          sellableUnitId: u.sellable_unit_id,
          isActive: true,
          adjustmentValue: derived && n != null && Number.isFinite(n) ? n : null,
          validFrom: null,
          validUntil: null,
        };
      }),
  });

  const save = () => {
    const blocking = validate();
    if (blocking.length > 0) {
      setStep(blocking[0].step);
      toast.error(blocking[0].msg);
      return;
    }
    startSaving(async () => {
      const res = await saveRatePlanAction(buildPayload());
      if (!res.success) return void toast.error(res.error);
      toast.success("התוכנית נשמרה");
      router.refresh();
      onClose();
    });
  };

  const goNext = () => {
    const stepErrs = validate().filter((e) => e.step === step);
    if (stepErrs.length > 0) return void toast.error(stepErrs[0].msg);
    setStep((s) => (s === 3 ? 3 : ((s + 1) as Step)));
  };

  // policy selects keep an inactive current selection visible (edit mode)
  const cancelOptions = cancellationPolicies.filter(
    (p) => p.is_active || p.id === d.cancellationPolicyId,
  );
  const paymentOptions = paymentPolicies.filter((p) => p.is_active || p.id === d.paymentPolicyId);

  // summary labels
  const validityLabel: React.ReactNode =
    d.validFrom && d.validUntil ? (
      <span>
        <span dir="ltr">{formatFullDate(d.validFrom)}</span> –{" "}
        <span dir="ltr">{formatFullDate(d.validUntil)}</span>
      </span>
    ) : d.validFrom ? (
      <span>
        מ־<span dir="ltr">{formatFullDate(d.validFrom)}</span>
      </span>
    ) : d.validUntil ? (
      <span>
        עד <span dir="ltr">{formatFullDate(d.validUntil)}</span>
      </span>
    ) : (
      "ללא הגבלת תוקף"
    );

  const restrictionParts: string[] = [];
  if (d.minStay != null) restrictionParts.push(`מינ׳ ${d.minStay} לילות`);
  if (d.maxStay != null) restrictionParts.push(`מקס׳ ${d.maxStay} לילות`);
  if (d.minAdvance != null) restrictionParts.push(`לפחות ${d.minAdvance} ימים מראש`);
  if (d.maxAdvance != null) restrictionParts.push(`עד ${d.maxAdvance} ימים מראש`);
  if (!d.allDays) restrictionParts.push(`${d.days.length} ימי הגעה מותרים`);
  if (d.cta) restrictionParts.push("CTA");
  if (d.ctd) restrictionParts.push("CTD");

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title={detail ? `עריכת תוכנית — ${detail.name}` : "תוכנית תעריף חדשה"}
      subtitle="הגדרת תמחור, הגבלות ושיוך חדרים"
      icon="tags"
      widthClassName="w-[60vw]"
      bodyClassName="p-4"
      band={<StepsBar step={step} onStep={setStep} />}
      footer={
        <div className="flex items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-faint">
            <Icon name="info" size={15} />
            שלב {step} מתוך 3
          </span>
          <span className="flex-1" />
          {step > 1 && (
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => setStep((s) => (s === 1 ? 1 : ((s - 1) as Step)))}
            >
              חזרה
              <Icon name="chevron-right" size={17} />
            </button>
          )}
          <button type="button" className="btn btn-outline" onClick={onClose}>
            ביטול
          </button>
          {step < 3 ? (
            <button type="button" className="btn btn-primary" onClick={goNext}>
              הבא
              <Icon name="chevron-left" size={17} />
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || !canSave}
              title={!canSave ? "אין הרשאת שמירה" : undefined}
              onClick={save}
            >
              <Icon name="check" size={17} />
              {saving ? "שומר…" : "שמירת התוכנית"}
            </button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-3.5">
        {step === 1 && (
          <>
            <Sec icon="tags" title="פרטים כלליים">
              <div className="rm-frow">
                <F label="שם התוכנית" required>
                  <input
                    className="rm-fld"
                    dir="auto"
                    placeholder="לדוגמה: תעריף גמיש עם ארוחת בוקר"
                    value={d.name}
                    onChange={(e) => set("name", e.target.value)}
                  />
                </F>
                <F label="קוד התוכנית" required>
                  <input
                    className="rm-fld text-right"
                    dir="ltr"
                    placeholder="FLEX-BB"
                    value={d.code}
                    onChange={(e) => set("code", e.target.value)}
                  />
                  <span className="rm-hint">אותיות באנגלית, ספרות, מקף וקו תחתון בלבד</span>
                </F>
              </div>
              <div className="rm-frow">
                <F label="שם ציבורי (מוצג לאורח)">
                  <input
                    className="rm-fld"
                    dir="auto"
                    placeholder="ריק = שם התוכנית"
                    value={d.publicName}
                    onChange={(e) => set("publicName", e.target.value)}
                  />
                </F>
                <QtyStep label="סדר מיון" value={d.sortOrder} onChange={(v) => set("sortOrder", v ?? 0)} />
              </div>
              <div className="rm-frow">
                <F label="תיאור פנימי">
                  <textarea
                    className="rm-fld"
                    rows={2}
                    dir="auto"
                    maxLength={2000}
                    placeholder="הערות פנימיות לצוות…"
                    value={d.description}
                    onChange={(e) => set("description", e.target.value)}
                  />
                </F>
                <F label="תיאור ציבורי">
                  <textarea
                    className="rm-fld"
                    rows={2}
                    dir="auto"
                    maxLength={2000}
                    placeholder="תיאור המוצג לאורחים…"
                    value={d.publicDescription}
                    onChange={(e) => set("publicDescription", e.target.value)}
                  />
                </F>
              </div>
              <ToggleRow
                label="תוכנית פעילה"
                hint="תוכנית פעילה זמינה לתמחור ולהזמנות"
                checked={d.isActive}
                onChange={(v) => set("isActive", v)}
              />
            </Sec>

            <Sec icon="circle-slash" title="מדיניות ומסחר">
              <div className="rm-frow">
                <F label="מדיניות החזר">
                  <Segmented
                    ariaLabel="מדיניות החזר"
                    value={d.isRefundable ? "flex" : "nonref"}
                    onChange={(v) => set("isRefundable", v === "flex")}
                    options={[
                      { value: "flex", label: "גמיש" },
                      { value: "nonref", label: "ללא החזר" },
                    ]}
                  />
                </F>
                <F label="ארוחה כלולה">
                  <input
                    className="rm-fld"
                    dir="auto"
                    maxLength={120}
                    placeholder="לדוגמה: ארוחת בוקר"
                    value={d.mealPlan}
                    onChange={(e) => set("mealPlan", e.target.value)}
                  />
                  <span className="rm-hint">טקסט חופשי, אופציונלי</span>
                </F>
              </div>
              <div className="rm-frow">
                <F label="מדיניות ביטול">
                  <select
                    className="rm-fld"
                    value={d.cancellationPolicyId}
                    onChange={(e) => set("cancellationPolicyId", e.target.value)}
                  >
                    <option value="">ללא</option>
                    {cancelOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </F>
                <F label="מדיניות תשלום">
                  <select
                    className="rm-fld"
                    value={d.paymentPolicyId}
                    onChange={(e) => set("paymentPolicyId", e.target.value)}
                  >
                    <option value="">ללא</option>
                    {paymentOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </F>
              </div>
              <div className="rm-frow">
                <F label="בתוקף מתאריך">
                  <input
                    type="date"
                    className="rm-fld"
                    dir="ltr"
                    value={d.validFrom}
                    onChange={(e) => set("validFrom", e.target.value)}
                  />
                </F>
                <F label="בתוקף עד תאריך">
                  <input
                    type="date"
                    className="rm-fld"
                    dir="ltr"
                    value={d.validUntil}
                    onChange={(e) => set("validUntil", e.target.value)}
                  />
                </F>
              </div>
            </Sec>
          </>
        )}

        {step === 2 && (
          <>
            <Sec icon="percent" title="מצב תמחור">
              <F label="סוג התוכנית">
                <Segmented
                  ariaLabel="סוג תמחור"
                  value={d.planKind}
                  onChange={changeKind}
                  options={[
                    { value: "base", label: "מחיר בסיס" },
                    { value: "derived_percentage", label: "נגזרת %" },
                    { value: "derived_fixed", label: "נגזרת ₪" },
                    { value: "independent", label: "עצמאי" },
                  ]}
                />
              </F>
              {derived && (
                <div className="rm-frow">
                  <F label="תוכנית אב" required>
                    <select
                      className="rm-fld"
                      value={d.parentPlanId}
                      onChange={(e) => set("parentPlanId", e.target.value)}
                    >
                      <option value="">בחרו תוכנית אב</option>
                      {parentOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} — {p.formula}
                        </option>
                      ))}
                    </select>
                  </F>
                  <F
                    label={d.planKind === "derived_percentage" ? "התאמה באחוזים" : "התאמה בסכום ללילה"}
                    required
                  >
                    <div className="flex items-center gap-2">
                      <input
                        className="rm-fld"
                        dir="ltr"
                        type="number"
                        step="0.01"
                        placeholder={d.planKind === "derived_percentage" ? "-10" : "-50"}
                        value={d.adjustment}
                        onChange={(e) => set("adjustment", e.target.value)}
                      />
                      <span className="shrink-0 text-sm font-bold text-muted" dir="ltr">
                        {unitSign}
                      </span>
                    </div>
                    <span className="rm-hint">ערך שלילי = הנחה · ערך חיובי = תוספת</span>
                  </F>
                </div>
              )}
              {derived && (
                <div className="flex flex-col gap-2 rounded-xl border border-primary-100 bg-primary-050 p-4">
                  <span className="inline-flex items-center gap-2 text-sm font-bold text-primary">
                    <Icon name="calculator" size={16} />
                    {formula}
                  </span>
                  {exampleResult != null ? (
                    <span className="text-sm text-text2">
                      מחיר בסיס לדוגמה: <strong dir="ltr">₪{EXAMPLE_BASE}</strong> ← מחיר בתוכנית:{" "}
                      <strong dir="ltr">₪{exampleResult}</strong>
                    </span>
                  ) : (
                    <span className="text-sm text-muted">הזינו ערך התאמה לצפייה בדוגמה מחושבת</span>
                  )}
                </div>
              )}
              {d.planKind === "independent" && (
                <p className="flex items-center gap-2 rounded-xl bg-hover p-4 text-sm text-text2">
                  <Icon name="info" size={16} className="shrink-0" />
                  המחירים מוגדרים ידנית לכל חדר ותאריך בחריגות התאריך
                </p>
              )}
              {d.planKind === "base" && (
                <p className="flex items-center gap-2 rounded-xl bg-hover p-4 text-sm text-text2">
                  <Icon name="info" size={16} className="shrink-0" />
                  {formula} — המחיר ללילה נלקח מתעריף הבסיס של כל חדר
                </p>
              )}
            </Sec>

            <Sec icon="filter" title="הגבלות שהייה והזמנה">
              <div className="rm-frow">
                <QtyStep label="מינימום לילות" value={d.minStay} min={1} nullable onChange={(v) => set("minStay", v)} />
                <QtyStep label="מקסימום לילות" value={d.maxStay} min={1} nullable onChange={(v) => set("maxStay", v)} />
              </div>
              <div className="rm-frow">
                <QtyStep label="מינימום ימים מראש" value={d.minAdvance} min={0} nullable onChange={(v) => set("minAdvance", v)} />
                <QtyStep label="מקסימום ימים מראש" value={d.maxAdvance} min={0} nullable onChange={(v) => set("maxAdvance", v)} />
              </div>
              <F label="ימי הגעה מותרים">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex min-h-11 items-center gap-2">
                    <Switch
                      checked={d.allDays}
                      onChange={(v) => set("allDays", v)}
                      label="כל הימים"
                    />
                    <span className="text-sm font-medium text-text2">כל הימים</span>
                  </span>
                  {!d.allDays && (
                    <span className="flex flex-wrap gap-2">
                      {HEBREW_DAY_LETTERS.map((label, idx) => {
                        const on = d.days.includes(idx);
                        return (
                          <button
                            key={label}
                            type="button"
                            aria-pressed={on}
                            aria-label={`יום ${label}`}
                            onClick={() => toggleDay(idx)}
                            className={`grid h-11 w-11 place-items-center rounded-xl border text-sm font-semibold transition-colors ${
                              on
                                ? "border-primary bg-primary-050 text-primary"
                                : "border-line bg-surface text-muted hover:bg-hover"
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </span>
                  )}
                </div>
              </F>
            </Sec>

            <Sec icon="globe" title="ברירות מחדל והפצה">
              <div className="rm-frow">
                <ToggleRow
                  label="סגור להגעה (CTA) כברירת מחדל"
                  hint="הגעה נחסמת אלא אם נפתחה בחריגת תאריך"
                  checked={d.cta}
                  onChange={(v) => set("cta", v)}
                />
                <ToggleRow
                  label="סגור לעזיבה (CTD) כברירת מחדל"
                  hint="עזיבה נחסמת אלא אם נפתחה בחריגת תאריך"
                  checked={d.ctd}
                  onChange={(v) => set("ctd", v)}
                />
              </div>
              <div className="rm-frow">
                <ToggleRow
                  label="מוצג באתר"
                  hint="התוכנית מוצעת למזמינים באתר"
                  checked={d.visibleWebsite}
                  onChange={(v) => set("visibleWebsite", v)}
                />
                <ToggleRow
                  label="הפצה לערוצים (עתידי)"
                  hint="סנכרון לערוצי הפצה — שלב 4B"
                  checked={d.visibleChannels}
                  onChange={(v) => set("visibleChannels", v)}
                />
              </div>
            </Sec>
          </>
        )}

        {step === 3 && (
          <>
            <Sec icon="rooms" title="שיוך חדרים" note={`${assignedCount} מתוך ${units.length} יחידות`}>
              <div className="flex items-center gap-2">
                <button type="button" className="btn btn-filter" onClick={() => setAll(true)}>
                  בחר הכל
                </button>
                <button type="button" className="btn btn-filter" onClick={() => setAll(false)}>
                  נקה בחירה
                </button>
              </div>
              <div className="flex flex-col gap-2">
                {units.map((u) => {
                  const a = assign[u.sellable_unit_id] ?? { on: false, adj: "" };
                  const st = unitStatus(u);
                  const label = u.room_name ?? u.unit_name;
                  return (
                    <div
                      key={u.sellable_unit_id}
                      className={`flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 ${
                        a.on ? "border-primary-100 bg-primary-050/40" : "border-line bg-surface"
                      }`}
                    >
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={a.on}
                        aria-label={`שיוך ${label}`}
                        onClick={() => setUnit(u.sellable_unit_id, { on: !a.on })}
                        className="grid h-11 w-11 shrink-0 place-items-center rounded-xl transition-colors hover:bg-hover"
                      >
                        <span
                          className={`grid h-6 w-6 place-items-center rounded-md border transition-colors ${
                            a.on ? "border-primary bg-primary text-white" : "border-line bg-surface"
                          }`}
                        >
                          {a.on && <Icon name="check" size={14} />}
                        </span>
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-ink">
                          {u.room_number && (
                            <>
                              <span dir="ltr">{u.room_number}</span>
                              {" · "}
                            </>
                          )}
                          {label}
                        </p>
                        <p className="truncate text-xs text-muted">
                          {u.room_type_name ?? "יחידת מכירה"}
                        </p>
                      </div>
                      {st && <Badge tone="warning">{st}</Badge>}
                      {derived && a.on && (
                        <span className="flex items-center gap-1.5">
                          <input
                            className="w-28 rounded-lg border border-line bg-field px-3 py-2 text-sm text-ink"
                            dir="ltr"
                            type="number"
                            step="0.01"
                            aria-label="חריגת התאמה ליחידה"
                            title="חריגת התאמה ליחידה"
                            placeholder={d.adjustment.trim() || "ברירת מחדל"}
                            value={a.adj}
                            onChange={(e) => setUnit(u.sellable_unit_id, { adj: e.target.value })}
                          />
                          <span className="text-xs font-bold text-muted" dir="ltr">
                            {unitSign}
                          </span>
                        </span>
                      )}
                    </div>
                  );
                })}
                {units.length === 0 && <p className="rm-hint">אין יחידות מכירה מוגדרות בנכס.</p>}
              </div>
            </Sec>

            <Sec icon="list-checks" title="סיכום ואימות">
              <div className="flex flex-col gap-1.5">
                <SummaryRow label="שם" value={d.name.trim() || "—"} />
                <SummaryRow label="קוד" value={<span dir="ltr">{d.code.trim() || "—"}</span>} />
                <SummaryRow label="נוסחה" value={formula} />
                <SummaryRow label="חדרים משויכים" value={`${assignedCount} יחידות`} />
                <SummaryRow label="תוקף" value={validityLabel} />
                <SummaryRow
                  label="הגבלות"
                  value={restrictionParts.length > 0 ? restrictionParts.join(" · ") : "ללא הגבלות"}
                />
              </div>
              {errs.length > 0 ? (
                <div className="rm-vlist">
                  {errs.map((e) => (
                    <p key={`${e.step}-${e.msg}`} className="rm-vitem w">
                      <Icon name="warning" size={17} /> {e.msg}
                    </p>
                  ))}
                </div>
              ) : (
                <p className="rm-vitem ok">
                  <Icon name="check-circle" size={17} /> כל הנתונים תקינים — אפשר לשמור
                </p>
              )}
            </Sec>
          </>
        )}
      </div>
    </SidePanel>
  );
}

// ---------- helpers ----------

function unitStatus(u: AssignableUnit): string | null {
  if (u.unit_active === false || u.room_active === false) return "לא פעיל";
  if (u.room_status === "out_of_order") return "חסימה זמנית";
  if (u.room_status === "inactive") return "בשיפוץ";
  return null;
}

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <span className="w-28 shrink-0 font-medium text-faint">{label}</span>
      <span className="min-w-0 text-text2">{value}</span>
    </div>
  );
}

// band stepper — rooms-wizard reference markup (.rm-steps / .rm-stp)
function StepsBar({ step, onStep }: { step: Step; onStep: (s: Step) => void }) {
  const steps: { n: Step; label: string }[] = [
    { n: 1, label: "כללי ומסחרי" },
    { n: 2, label: "תמחור והגבלות" },
    { n: 3, label: "חדרים והפצה" },
  ];
  return (
    <div className="rm-steps" dir="rtl">
      {steps.map((s, i) => (
        <span key={s.n} className="contents">
          <button
            type="button"
            onClick={() => onStep(s.n)}
            className={`rm-stp${step === s.n ? " on" : step > s.n ? " done" : ""}`}
          >
            <span className="rm-n">{step > s.n ? <Icon name="check" size={16} /> : s.n}</span>
            <span className="rm-l">{s.label}</span>
          </button>
          {i < steps.length - 1 && <span className={`rm-stln${step > s.n ? " done" : ""}`} />}
        </span>
      ))}
    </div>
  );
}
