"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import { CardTitle, Field } from "@/components/reservations/BookingPanel";
import { Segmented, ToggleRow } from "@/app/(dashboard)/settings/controls";
import type { BuildingOption, OperationalArea } from "@/lib/rooms/service";
import type { Can } from "./RoomsScreen";
import { AREA_TYPE_LABEL } from "./RoomsScreen";
import { StepField } from "./RoomWizard";
import { deleteAreaAction, saveAreaAction } from "./actions";

const AREA_TYPES = ["lobby", "elevator", "corridor", "gym", "pool", "parking", "storage", "other"] as const;
type AreaType = (typeof AREA_TYPES)[number];
type AreaStatus = OperationalArea["status"];

export function AreaPanel({
  area,
  buildings,
  can,
  onClose,
}: {
  area: OperationalArea | null; // null = create
  buildings: BuildingOption[];
  can: Can;
  onClose: () => void;
}) {
  const router = useRouter();
  const [saving, startSaving] = useTransition();
  const [d, setD] = useState({
    name: area?.name ?? "",
    code: area?.code ?? "",
    area_type: (area?.area_type as AreaType) ?? ("lobby" as AreaType),
    building_area_id: area?.building_area_id ?? null,
    floor: area?.floor ?? "",
    is_active: area?.is_active ?? true,
    relevant_cleaning: area?.relevant_cleaning ?? false,
    relevant_maintenance: area?.relevant_maintenance ?? true,
    status: (area?.status as AreaStatus) ?? ("ok" as AreaStatus),
    status_note: area?.status_note ?? "",
    sort_order: area?.sort_order ?? 0,
    notes: area?.notes ?? "",
  });
  const set = <K extends keyof typeof d>(k: K, v: (typeof d)[K]) => setD((s) => ({ ...s, [k]: v }));

  const save = () =>
    startSaving(async () => {
      const res = await saveAreaAction({
        id: area?.id,
        name: d.name,
        code: d.code.trim() || null,
        area_type: d.area_type,
        building_area_id: d.building_area_id,
        floor: d.floor.trim() || null,
        is_active: d.is_active,
        relevant_cleaning: d.relevant_cleaning,
        relevant_maintenance: d.relevant_maintenance,
        status: d.status,
        status_note: d.status_note.trim() || null,
        sort_order: d.sort_order,
        notes: d.notes.trim() || null,
      });
      if (!res.success) return void toast.error(res.error);
      toast.success(area ? "האזור נשמר" : "האזור נוצר");
      router.refresh();
      onClose();
    });

  const doDelete = () =>
    startSaving(async () => {
      if (!area) return;
      if (!window.confirm(`למחוק את האזור ״${area.name}״?`)) return;
      const res = await deleteAreaAction(area.id);
      if (!res.success) return void toast.error(res.error);
      toast.success("האזור נמחק");
      router.refresh();
      onClose();
    });

  return (
    <SidePanel
      open
      onClose={onClose}
      title={area ? `עריכת אזור · ${area.name}` : "אזור חדש"}
      subtitle="הוספת אזור תפעולי · חדרים ואזורים"
      icon="building"
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-faint">
            {!d.name.trim() ? "נדרשים שם אזור וסוג אזור" : ""}
          </span>
          <div className="flex gap-2">
            {area && can.del && (
              <button
                type="button"
                className="bw-btn bw-btn-o text-status-danger"
                disabled={saving}
                onClick={doDelete}
              >
                <Icon name="trash" size={14} />
                מחק אזור
              </button>
            )}
            <button type="button" className="bw-btn bw-btn-o" onClick={onClose}>ביטול</button>
            <button
              type="button"
              className="bw-btn bw-btn-primary"
              disabled={saving || !d.name.trim()}
              onClick={save}
            >
              <Icon name="check" size={16} />
              {saving ? "שומר…" : area ? "שמירה" : "צור אזור"}
            </button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <section className="bw-card">
          <CardTitle icon="info" title="פרטים כלליים" />
          <div className="bw-grid2">
            <Field label="שם אזור *">
              <input
                className="bw-fld"
                placeholder="לדוגמה: לובי ראשי"
                value={d.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </Field>
            <Field label="קוד אזור">
              <input
                className="bw-fld"
                dir="ltr"
                placeholder="לדוגמה: LOBBY-1"
                value={d.code}
                onChange={(e) => set("code", e.target.value)}
              />
              <p className="mt-1 text-xs text-faint">נוצר אוטומטית לפי הסוג — ניתן לעריכה</p>
            </Field>
          </div>
          <Field label="סוג אזור *">
            <div className="flex flex-wrap gap-2">
              {AREA_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => set("area_type", t)}
                  className={`min-h-10 rounded-xl border px-3 py-1.5 text-sm font-semibold transition-colors ${
                    d.area_type === t
                      ? "border-primary bg-primary-050 text-primary"
                      : "border-line bg-surface text-text2 hover:bg-hover"
                  }`}
                >
                  {AREA_TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </Field>
          <div className="bw-grid2 mt-3">
            <Field label="בניין / אגף">
              <select
                className="bw-fld"
                value={d.building_area_id ?? ""}
                onChange={(e) => set("building_area_id", e.target.value || null)}
              >
                <option value="">ללא</option>
                {buildings.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </Field>
            <Field label="קומה">
              <input
                className="bw-fld"
                dir="ltr"
                placeholder="ללא"
                value={d.floor}
                onChange={(e) => set("floor", e.target.value)}
              />
            </Field>
          </div>
        </section>

        <section className="bw-card">
          <CardTitle icon="settings" title="הגדרות תפעוליות" />
          <div className="flex flex-col gap-3">
            <ToggleRow label="פעיל" hint="האזור מוצג ברשימות ובמערכת" checked={d.is_active} onChange={(v) => set("is_active", v)} />
            <ToggleRow label="רלוונטי לניקיון" hint="האזור נכלל במשימות ניקיון" checked={d.relevant_cleaning} onChange={(v) => set("relevant_cleaning", v)} />
            <ToggleRow label="רלוונטי לתחזוקה" hint="ניתן לפתוח תקלות תחזוקה עבור אזור זה" checked={d.relevant_maintenance} onChange={(v) => set("relevant_maintenance", v)} />
            <div className="flex items-center justify-between gap-3">
              <Field label="מצב האזור">
                <Segmented
                  ariaLabel="מצב האזור"
                  value={d.status}
                  onChange={(v) => set("status", v)}
                  options={[
                    { value: "ok", label: "תקין" },
                    { value: "cleaning", label: "בניקיון" },
                    { value: "maintenance", label: "תחזוקה" },
                    { value: "blocked", label: "חסום" },
                  ]}
                />
              </Field>
            </div>
            {d.status !== "ok" && (
              <Field label="הערת מצב">
                <input
                  className="bw-fld"
                  placeholder="לדוגמה: טכנאי הוזמן · עד 9/7"
                  value={d.status_note}
                  onChange={(e) => set("status_note", e.target.value)}
                />
              </Field>
            )}
            <StepField label="סדר תצוגה" value={d.sort_order} onChange={(v) => set("sort_order", v ?? 0)} />
            <Field label="הערות תפעוליות">
              <textarea
                className="bw-fld min-h-0 resize-y"
                style={{ height: "auto" }}
                rows={3}
                placeholder="הערות פנימיות לצוות…"
                value={d.notes}
                onChange={(e) => set("notes", e.target.value)}
              />
            </Field>
          </div>
        </section>
      </div>
    </SidePanel>
  );
}
