"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import { tierBandLabel } from "@/lib/pricing/los";
import type { LosDiscountKind } from "@/lib/pricing/types";
import type { LosDiscountRow, BookableRatePlan } from "@/lib/rate-plans/service";
import { deleteLosDiscountAction, saveLosDiscountAction } from "./actions";

// ============================================================
// Length-of-stay discounts (D104) — "4 nights", "weekly", "monthly". THE
// central pricing engine reads these tiers, so a tier defined here applies
// identically to a manual reservation, the website and every channel quote.
// A stay wins the tier with the highest minimum it satisfies; the quote then
// prints which tier it chose and the arithmetic behind it.
// ============================================================

const KIND_LABEL: Record<LosDiscountKind, string> = {
  percent: "אחוז מהלינה",
  amount_per_night: "סכום ללילה",
  amount_per_stay: "סכום לשהות",
};

type Draft = {
  id?: string;
  pricingPlanId: string | null;
  name: string;
  minNights: number;
  maxNights: number | null;
  kind: LosDiscountKind;
  value: number;
  isActive: boolean;
};

const EMPTY: Draft = {
  pricingPlanId: null,
  name: "",
  minNights: 7,
  maxNights: null,
  kind: "percent",
  value: 10,
  isActive: true,
};

const fromRow = (r: LosDiscountRow): Draft => ({
  id: r.id,
  pricingPlanId: r.pricing_plan_id,
  name: r.name,
  minNights: r.min_nights,
  maxNights: r.max_nights,
  kind: r.discount_kind,
  value: r.discount_value,
  isActive: r.is_active,
});

export function LosDiscountsPanel({
  open,
  onClose,
  discounts,
  plans,
  canEdit,
}: {
  open: boolean;
  onClose: () => void;
  discounts: LosDiscountRow[];
  plans: BookableRatePlan[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, startBusy] = useTransition();
  const [draft, setDraft] = useState<Draft | null>(null);

  const run = (fn: () => Promise<{ success: boolean; error?: string }>, okMsg: string) =>
    startBusy(async () => {
      const res = await fn();
      if (!res.success) return void toast.error(res.error ?? "אירעה שגיאה בלתי צפויה");
      toast.success(okMsg);
      setDraft(null);
      router.refresh();
    });

  const valueSuffix = (k: LosDiscountKind) => (k === "percent" ? "%" : "₪");

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title="הנחות אורך שהייה"
      subtitle="הנחת שבוע, חודש או כל סף לילות אחר — מוחלת אוטומטית בכל תמחור: הקמה ידנית, אתר וערוצים"
      icon="tags"
      widthClassName="w-[46vw] max-w-[calc(100vw-48px)] max-sm:max-w-none"
    >
      {/* the panel body already carries the canonical 24px padding (.dw-bd) */}
      <div className="flex flex-col gap-4">
        <p className="rounded-card bg-field p-4 text-[13.5px] font-semibold text-muted">
          שהות מקבלת את המדרגה <b className="text-ink">הגבוהה ביותר</b> שהיא עומדת בה (30+ גובר על 7+
          שגובר על 4+). הנחה מחושבת על סכום הלינה בלבד — תוספות אורח אינן מוזלות, ומחיר שנקבע ידנית
          אינו מוזל אוטומטית. תוכנית עם מדרגות משלה אינה יורשת את מדרגות ברירת המחדל.
        </p>

        {discounts.length === 0 && !draft && (
          <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-line p-10 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-[16px] bg-primary-050 text-primary">
              <Icon name="tags" size={24} />
            </span>
            <p className="h4">טרם הוגדרו הנחות אורך שהייה</p>
            <p className="max-w-md text-[14px] text-muted">
              כל עוד אין מדרגות, שהות ארוכה מתומחרת לילה-לילה ללא הנחה.
            </p>
          </div>
        )}

        {discounts.length > 0 && (
          <ul className="flex flex-col divide-y divide-line">
            {discounts.map((d) => (
              <li key={d.id} className="flex items-center gap-3 py-3">
                <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[7px] bg-field text-muted">
                  <Icon name="moon" size={17} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13.5px] font-extrabold text-ink">{d.name}</span>
                    <span className="chip chip-neutral">
                      {tierBandLabel({ minNights: d.min_nights, maxNights: d.max_nights })}
                    </span>
                    <span className="chip chip-neutral">{d.plan_name ?? "כל התוכניות (ברירת מחדל)"}</span>
                    {!d.is_active && <span className="chip chip-neutral">מושבת</span>}
                  </div>
                  <p className="field-hint">
                    {KIND_LABEL[d.discount_kind]} ·{" "}
                    <bdi className="ltr-num">
                      {d.discount_value.toLocaleString()}
                      {valueSuffix(d.discount_kind)}
                    </bdi>
                  </p>
                </div>
                {canEdit && (
                  <div className="flex flex-none items-center gap-2">
                    <button type="button" className="btn btn-tertiary btn-sm" onClick={() => setDraft(fromRow(d))}>
                      עריכה
                    </button>
                    <button
                      type="button"
                      className="btn btn-tertiary btn-sm text-status-danger"
                      disabled={busy}
                      onClick={() => run(() => deleteLosDiscountAction({ id: d.id }), "ההנחה נמחקה")}
                    >
                      <Icon name="trash" size={17} />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {canEdit && !draft && (
          <button type="button" className="btn btn-secondary self-start" onClick={() => setDraft({ ...EMPTY })}>
            <Icon name="plus" size={20} />
            מדרגת הנחה חדשה
          </button>
        )}

        {draft && (
          <div className="flex flex-col gap-4 rounded-card border border-line p-4">
            <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
              <label className="field">
                <span className="field-label">שם ההנחה</span>
                <input
                  className="field-input"
                  placeholder="למשל: תעריף שבועי"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">חלה על</span>
                <select
                  className="field-input"
                  value={draft.pricingPlanId ?? ""}
                  onChange={(e) => setDraft({ ...draft, pricingPlanId: e.target.value || null })}
                >
                  <option value="">כל התוכניות (ברירת מחדל)</option>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">מינימום לילות</span>
                <input
                  type="number" min={1} dir="ltr"
                  className="field-input ltr-num"
                  value={draft.minNights}
                  onChange={(e) => setDraft({ ...draft, minNights: Number(e.target.value) || 1 })}
                />
              </label>
              <label className="field">
                <span className="field-label">
                  מקסימום לילות <span className="font-normal text-faint">(ריק = ללא הגבלה)</span>
                </span>
                <input
                  type="number" min={1} dir="ltr"
                  className="field-input ltr-num"
                  value={draft.maxNights ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, maxNights: e.target.value ? Number(e.target.value) : null })
                  }
                />
              </label>
              <label className="field">
                <span className="field-label">סוג ההנחה</span>
                <select
                  className="field-input"
                  value={draft.kind}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value as LosDiscountKind })}
                >
                  {(Object.keys(KIND_LABEL) as LosDiscountKind[]).map((k) => (
                    <option key={k} value={k}>{KIND_LABEL[k]}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">ערך ({valueSuffix(draft.kind)})</span>
                <input
                  type="number" min={0} step="0.01" dir="ltr"
                  className="field-input ltr-num"
                  value={draft.value}
                  onChange={(e) => setDraft({ ...draft, value: Number(e.target.value) || 0 })}
                />
              </label>
            </div>
            <label className="flex items-center gap-2 text-[13.5px] font-extrabold text-ink">
              <input
                type="checkbox"
                checked={draft.isActive}
                onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
              />
              פעילה
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || draft.name.trim() === ""}
                onClick={() => run(() => saveLosDiscountAction(draft), "ההנחה נשמרה")}
              >
                <Icon name="check" size={20} />
                {busy ? "שומר…" : "שמירה"}
              </button>
              <button type="button" className="btn btn-tertiary" onClick={() => setDraft(null)}>
                ביטול
              </button>
            </div>
          </div>
        )}
      </div>
    </SidePanel>
  );
}
