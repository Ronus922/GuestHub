"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import { ToggleRow } from "@/app/(dashboard)/settings/controls";
import { F, QtyStep } from "@/app/(dashboard)/rooms/RoomWizard";
import { formatFullDate } from "@/lib/dates";
import type { PlanOverrideRow } from "@/lib/rate-plans/service";
import type { AssignableUnit, RatePlanListItem } from "./types";
import { getPlanOverridesAction, savePlanOverridesAction } from "./actions";

// ============================================================
// Exact-date overlay editor (spec §9): the sparse per-(plan, unit, date) rows
// that layer prices/restrictions on top of the plan formula. All edits are
// STAGED (upserts + removals) and persisted in one savePlanOverridesAction
// call; the list re-fetches after save. The server re-guards dates/tenancy.
// ============================================================

type OverrideDraft = {
  sellableUnitId: string;
  date: string;
  price: number | null;
  minStayThrough: number | null;
  minStayArrival: number | null;
  maxStay: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  stopSell: boolean;
  note: string | null;
};

type FormDraft = {
  unitId: string;
  date: string;
  price: string;
  minStay: number | null;
  maxStay: number | null;
  cta: boolean;
  ctd: boolean;
  stopSell: boolean;
  note: string;
};

const EMPTY_FORM: FormDraft = {
  unitId: "",
  date: "",
  price: "",
  minStay: null,
  maxStay: null,
  cta: false,
  ctd: false,
  stopSell: false,
  note: "",
};

export function OverridesPanel({
  open,
  onClose,
  plan,
  units,
  canEdit,
}: {
  open: boolean;
  onClose: () => void;
  plan: RatePlanListItem | null;
  units: AssignableUnit[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [saving, startSaving] = useTransition();
  const [rows, setRows] = useState<PlanOverrideRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [upserts, setUpserts] = useState<OverrideDraft[]>([]);
  const [removals, setRemovals] = useState<{ sellableUnitId: string; date: string }[]>([]);
  const [form, setForm] = useState<FormDraft>(EMPTY_FORM);

  const planId = plan?.id ?? null;

  const refresh = useCallback(async () => {
    if (!planId) return;
    setLoading(true);
    try {
      const res = await getPlanOverridesAction({ id: planId });
      if (!res.success) return void toast.error(res.error);
      setRows(res.overrides ?? []);
    } finally {
      setLoading(false);
    }
  }, [planId]);

  useEffect(() => {
    if (!open || !planId) return;
    setRows([]);
    setUpserts([]);
    setRemovals([]);
    setForm(EMPTY_FORM);
    void refresh();
  }, [open, planId, refresh]);

  const grouped = useMemo(() => {
    const byDate = new Map<string, PlanOverrideRow[]>();
    for (const r of rows) {
      const arr = byDate.get(r.date) ?? [];
      arr.push(r);
      byDate.set(r.date, arr);
    }
    return [...byDate.entries()]; // server order: date, unit
  }, [rows]);

  const isStagedRemoval = (r: PlanOverrideRow) =>
    removals.some((x) => x.sellableUnitId === r.sellable_unit_id && x.date === r.date);

  const toggleRemoval = (r: PlanOverrideRow) =>
    setRemovals((s) =>
      s.some((x) => x.sellableUnitId === r.sellable_unit_id && x.date === r.date)
        ? s.filter((x) => !(x.sellableUnitId === r.sellable_unit_id && x.date === r.date))
        : [...s, { sellableUnitId: r.sellable_unit_id, date: r.date }],
    );

  const addRow = () => {
    if (!form.unitId) return void toast.error("יש לבחור יחידה");
    if (!form.date) return void toast.error("יש לבחור תאריך");
    const priceNum = form.price.trim() ? Number(form.price) : null;
    if (priceNum != null && (!Number.isFinite(priceNum) || priceNum < 0))
      return void toast.error("מחיר לא תקין");
    const draft: OverrideDraft = {
      sellableUnitId: form.unitId,
      date: form.date,
      price: priceNum,
      minStayThrough: form.minStay,
      minStayArrival: null,
      maxStay: form.maxStay,
      closedToArrival: form.cta,
      closedToDeparture: form.ctd,
      stopSell: form.stopSell,
      note: form.note.trim() || null,
    };
    if (
      draft.price == null &&
      draft.minStayThrough == null &&
      draft.maxStay == null &&
      !draft.closedToArrival &&
      !draft.closedToDeparture &&
      !draft.stopSell
    )
      return void toast.error("שורת חריגה ריקה — אין מה לשמור");
    setUpserts((s) => [
      ...s.filter((x) => !(x.sellableUnitId === draft.sellableUnitId && x.date === draft.date)),
      draft,
    ]);
    // an upsert on the same key cancels a staged removal
    setRemovals((s) =>
      s.filter((x) => !(x.sellableUnitId === draft.sellableUnitId && x.date === draft.date)),
    );
    setForm(EMPTY_FORM);
  };

  const pendingCount = upserts.length + removals.length;

  const save = () =>
    startSaving(async () => {
      if (!planId || pendingCount === 0) return;
      const res = await savePlanOverridesAction({ planId, upserts, removals });
      if (!res.success) return void toast.error(res.error);
      toast.success("חריגות התאריך נשמרו");
      setUpserts([]);
      setRemovals([]);
      router.refresh();
      await refresh();
    });

  const unit = (id: string) => units.find((u) => u.sellable_unit_id === id) ?? null;

  return (
    <SidePanel
      open={open && plan !== null}
      onClose={onClose}
      title={`חריגות תאריך — ${plan?.name ?? ""}`}
      subtitle={plan?.formula}
      icon="percent"
      bodyClassName="p-4"
      footer={
        /* §7 — flat .dw-ft children (row-reverse): the FIRST DOM child (the
           primary) lands on the LEFT edge, "סגור" to its right; the pending
           hint is pushed to the far right with me-auto. No wrapper. */
        <>
          {canEdit && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || pendingCount === 0}
              onClick={save}
            >
              <Icon name="check" size={20} />
              {saving ? "שומר…" : "שמור שינויים"}
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            סגור
          </button>
          <span className="field-hint me-auto inline-flex items-center gap-1.5">
            <Icon name="info" size={17} />
            {pendingCount > 0
              ? `${upserts.length} עדכונים · ${removals.length} הסרות ממתינים לשמירה`
              : "אין שינויים ממתינים"}
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* staged additions/updates — saved on "שמור שינויים" */}
        {upserts.length > 0 && (
          <section className="flex flex-col gap-2 rounded-card border border-primary-100 bg-primary-050/40 p-4">
            <h3 className="inline-flex items-center gap-2 text-[14px] font-bold text-primary">
              <Icon name="plus" size={17} />
              שינויים ממתינים לשמירה ({upserts.length})
            </h3>
            {upserts.map((u) => (
              <div
                key={`${u.sellableUnitId}-${u.date}`}
                className="flex flex-wrap items-center gap-2 rounded-[12px] border border-line bg-surface px-4 py-3"
              >
                <span className="text-[14px] font-semibold text-ink">
                  <bdi className="ltr-num">{formatFullDate(u.date)}</bdi>
                </span>
                <UnitLabel unit={unit(u.sellableUnitId)} />
                <OverrideChips
                  price={u.price}
                  minThrough={u.minStayThrough}
                  minArrival={u.minStayArrival}
                  maxStay={u.maxStay}
                  cta={u.closedToArrival}
                  ctd={u.closedToDeparture}
                  stopSell={u.stopSell}
                />
                {u.note && <span className="text-[12px] text-muted">{u.note}</span>}
                <span className="flex-1" />
                <button
                  type="button"
                  aria-label="הסרה מהשינויים הממתינים"
                  title="הסרה מהשינויים הממתינים"
                  className="icon-btn"
                  onClick={() =>
                    setUpserts((s) =>
                      s.filter(
                        (x) => !(x.sellableUnitId === u.sellableUnitId && x.date === u.date),
                      ),
                    )
                  }
                >
                  <Icon name="close" size={20} />
                </button>
              </div>
            ))}
          </section>
        )}

        {/* add-row form */}
        {canEdit && (
          <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
            <h3 className="h4 inline-flex items-center gap-2">
              <Icon name="plus" size={17} />
              הוספת חריגת תאריך
            </h3>
            <div className="rm-frow">
              <F label="יחידה" required>
                <select
                  className="field-input"
                  value={form.unitId}
                  onChange={(e) => setForm((s) => ({ ...s, unitId: e.target.value }))}
                >
                  <option value="">בחרו יחידה</option>
                  {units.map((u) => (
                    <option key={u.sellable_unit_id} value={u.sellable_unit_id}>
                      {u.room_number ? `${u.room_number} · ` : ""}
                      {u.room_name ?? u.unit_name}
                    </option>
                  ))}
                </select>
              </F>
              <F label="תאריך" required>
                <input
                  type="date"
                  className="field-input"
                  dir="ltr"
                  value={form.date}
                  onChange={(e) => setForm((s) => ({ ...s, date: e.target.value }))}
                />
              </F>
            </div>
            <div className="rm-frow3">
              <F label="מחיר ללילה (₪)">
                <input
                  className="field-input"
                  dir="ltr"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="ללא שינוי מחיר"
                  value={form.price}
                  onChange={(e) => setForm((s) => ({ ...s, price: e.target.value }))}
                />
              </F>
              <QtyStep
                label="מינימום לילות"
                value={form.minStay}
                min={1}
                nullable
                onChange={(v) => setForm((s) => ({ ...s, minStay: v }))}
              />
              <QtyStep
                label="מקסימום לילות"
                value={form.maxStay}
                min={1}
                nullable
                onChange={(v) => setForm((s) => ({ ...s, maxStay: v }))}
              />
            </div>
            <div className="rm-frow3">
              <ToggleRow
                label="סגור להגעה (CTA)"
                checked={form.cta}
                onChange={(v) => setForm((s) => ({ ...s, cta: v }))}
              />
              <ToggleRow
                label="סגור לעזיבה (CTD)"
                checked={form.ctd}
                onChange={(v) => setForm((s) => ({ ...s, ctd: v }))}
              />
              <ToggleRow
                label="סגור למכירה"
                checked={form.stopSell}
                onChange={(v) => setForm((s) => ({ ...s, stopSell: v }))}
              />
            </div>
            <div className="rm-frow">
              <F label="הערה">
                <input
                  className="field-input"
                  dir="auto"
                  maxLength={500}
                  placeholder="הערה פנימית (אופציונלי)…"
                  value={form.note}
                  onChange={(e) => setForm((s) => ({ ...s, note: e.target.value }))}
                />
              </F>
              <div className="flex items-end">
                <button type="button" className="btn btn-primary" onClick={addRow}>
                  <Icon name="plus" size={20} />
                  הוסף
                </button>
              </div>
            </div>
          </section>
        )}

        {/* existing rows, grouped by date */}
        {loading && <p className="p-2 text-[14px] text-muted">טוען חריגות תאריך…</p>}
        {!loading && rows.length === 0 && upserts.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-line bg-surface p-8 text-center">
            <Icon name="percent" size={24} className="text-faint" />
            <p className="text-[14px] font-medium text-muted">
              אין חריגות תאריך לתוכנית זו — המחירים נקבעים לפי הנוסחה
            </p>
          </div>
        )}
        {grouped.map(([date, dateRows]) => (
          <section key={date} className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[14px] font-bold text-ink">
              <Icon name="calendar" size={17} className="text-muted" />
              {formatFullDate(date)}
              <bdi className="ltr-num text-[12px] font-normal text-faint">
                {date}
              </bdi>
            </div>
            {dateRows.map((r) => {
              const staged = isStagedRemoval(r);
              return (
                <div
                  key={`${r.sellable_unit_id}-${r.date}`}
                  className={`flex flex-wrap items-center gap-2 rounded-[12px] border border-line bg-surface px-4 py-3 ${
                    staged ? "opacity-60" : ""
                  }`}
                >
                  <UnitLabel unit={unit(r.sellable_unit_id)} />
                  <OverrideChips
                    price={r.price}
                    minThrough={r.min_stay_through}
                    minArrival={r.min_stay_arrival}
                    maxStay={r.max_stay}
                    cta={r.closed_to_arrival}
                    ctd={r.closed_to_departure}
                    stopSell={r.stop_sell}
                  />
                  {r.note && <span className="text-[12px] text-muted">{r.note}</span>}
                  {staged && <span className="chip chip-unpaid">יוסר בשמירה</span>}
                  <span className="flex-1" />
                  {canEdit && (
                    <button
                      type="button"
                      aria-label={staged ? "ביטול הסרה" : "הסרת חריגה"}
                      title={staged ? "ביטול הסרה" : "הסרת חריגה"}
                      className={`icon-btn ${
                        staged ? "" : "text-status-danger hover:bg-status-danger-050"
                      }`}
                      onClick={() => toggleRemoval(r)}
                    >
                      <Icon name={staged ? "refresh" : "trash"} size={20} />
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </SidePanel>
  );
}

// ---------- shared row pieces ----------

function UnitLabel({ unit }: { unit: AssignableUnit | null }) {
  if (!unit) return <span className="text-[14px] text-muted">יחידה לא מוכרת</span>;
  return (
    <span className="text-[14px] font-medium text-muted">
      {unit.room_number && (
        <>
          <bdi className="ltr-num">{unit.room_number}</bdi>
          {" · "}
        </>
      )}
      {unit.room_name ?? unit.unit_name}
    </span>
  );
}

function OverrideChips({
  price,
  minThrough,
  minArrival,
  maxStay,
  cta,
  ctd,
  stopSell,
}: {
  price: number | null;
  minThrough: number | null;
  minArrival: number | null;
  maxStay: number | null;
  cta: boolean;
  ctd: boolean;
  stopSell: boolean;
}) {
  return (
    <>
      {price != null && (
        <bdi className="ltr-num text-[14px] font-bold text-ink">
          ₪{price}
        </bdi>
      )}
      {minThrough != null && <span className="chip chip-neutral">מינ׳ {minThrough} לילות</span>}
      {minArrival != null && <span className="chip chip-neutral">מינ׳ הגעה {minArrival}</span>}
      {maxStay != null && <span className="chip chip-neutral">מקס׳ {maxStay} לילות</span>}
      {cta && <span className="chip chip-approval">CTA</span>}
      {ctd && <span className="chip chip-approval">CTD</span>}
      {stopSell && <span className="chip chip-unpaid">סגור למכירה</span>}
    </>
  );
}
