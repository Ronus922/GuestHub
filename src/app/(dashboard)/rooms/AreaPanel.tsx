"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon, type IconName } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import { Segmented, Switch } from "@/app/(dashboard)/settings/controls";
import type { BuildingOption, OperationalArea } from "@/lib/rooms/service";
import type { Can } from "./RoomsScreen";
import { AREA_TYPE_LABEL, AREA_STATUS_META } from "./RoomsScreen";
import { Sec, F } from "./RoomWizard";
import { deleteAreaAction, saveAreaAction } from "./actions";

// ============================================================
// Area window — ported 1:1 from ref/html/WindowNewArea.html +
// ref/screens/NewArea.png (D49). 45vw drawer, two columns: form (פרטים
// כלליים + הגדרות תפעוליות with icon rows) and a sticky live preview of the
// board card + requirements checklist. Status controls appear on edit only
// (the approved create window has none; the board popover manages status).
// ============================================================

const AREA_TYPES: { key: string; icon: IconName }[] = [
  { key: "lobby", icon: "armchair" },
  { key: "elevator", icon: "elevator" },
  { key: "corridor", icon: "corridor" },
  { key: "gym", icon: "dumbbell" },
  { key: "pool", icon: "waves" },
  { key: "parking", icon: "parking" },
  { key: "storage", icon: "package" },
];
type AreaStatus = OperationalArea["status"];

const FLOOR_OPTIONS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
const floorLabel = (f: string) => (f === "0" ? "קרקע" : `קומה ${f}`);

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
    area_type: area?.area_type ?? "",
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

  const valid = Boolean(d.name.trim() && d.area_type);
  const statusMeta = AREA_STATUS_META[d.status];

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

  // reference type list + the legacy "אחר" only when an existing area uses it
  const typeChips = area?.area_type === "other"
    ? [...AREA_TYPES, { key: "other", icon: "more" as IconName }]
    : AREA_TYPES;

  return (
    <SidePanel
      open
      onClose={onClose}
      title={area ? `עריכת אזור · ${area.name}` : "אזור חדש"}
      subtitle="הוספת אזור תפעולי · חדרים ואזורים"
      icon="building"
      widthClassName="w-[45vw] max-lg:w-[70%]"
      bodyClassName="p-4"
      footer={
        /* §7 footer — DIRECT children of .dw-ft (row-reverse): the PRIMARY is
           FIRST in the DOM and lands on the LEFT edge, "ביטול" to its right.
           No local flex wrapper — the shared .dw-ft rule owns the ordering. */
        <>
          <button type="button" className="btn btn-primary" disabled={saving || !valid} onClick={save}>
            <Icon name="check" size={20} />
            {saving ? "שומר…" : area ? "שמור" : "צור אזור"}
          </button>
          <button type="button" className="btn btn-tertiary" onClick={onClose}>ביטול</button>
          {area && can.del && (
            <button type="button" className="btn btn-danger" disabled={saving} onClick={doDelete}>
              <Icon name="trash" size={20} />
              מחק אזור
            </button>
          )}
          <span className="flex-1" />
          <span className="rm-ftnote">
            {!valid && (
              <>
                <Icon name="info" size={17} />
                נדרשים שם אזור וסוג אזור
              </>
            )}
          </span>
        </>
      }
    >
      <div className="rm-cols">
        <div className="rm-colmain">
          <Sec icon="info" title="פרטים כלליים">
            <div className="rm-frow">
              <F label="שם אזור" required>
                <input
                  className="field-input"
                  placeholder="לדוגמה: לובי ראשי"
                  value={d.name}
                  onChange={(e) => set("name", e.target.value)}
                />
              </F>
              <F label="קוד אזור">
                <input
                  className="field-input ltr-num text-end"
                  dir="ltr"
                  placeholder="לדוגמה: LOBBY-1"
                  value={d.code}
                  onChange={(e) => set("code", e.target.value)}
                />
                <span className="field-hint">נוצר אוטומטית לפי הסוג — ניתן לעריכה</span>
              </F>
            </div>
            <F label="סוג אזור" required>
              <div className="rm-tchips">
                {typeChips.map((t) => (
                  /* .rm-opt: visible resting boundary on the white card body */
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => set("area_type", t.key)}
                    className={`chip clickable rm-opt${d.area_type === t.key ? " on" : ""}`}
                  >
                    <Icon name={t.icon} size={13.5} />
                    {AREA_TYPE_LABEL[t.key]}
                  </button>
                ))}
              </div>
              <span className="field-hint">סוגי אזורים מנוהלים מתוך ההגדרות</span>
            </F>
            <div className="rm-frow">
              <F label="בניין / אגף">
                <select
                  className="field-input"
                  value={d.building_area_id ?? ""}
                  onChange={(e) => set("building_area_id", e.target.value || null)}
                >
                  <option value="">ללא</option>
                  {buildings.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </F>
              <F label="קומה">
                <select className="field-input" value={d.floor} onChange={(e) => set("floor", e.target.value)}>
                  <option value="">ללא</option>
                  {!FLOOR_OPTIONS.includes(d.floor) && d.floor !== "" && (
                    <option value={d.floor}>{floorLabel(d.floor)}</option>
                  )}
                  {FLOOR_OPTIONS.map((f) => (
                    <option key={f} value={f}>{floorLabel(f)}</option>
                  ))}
                </select>
              </F>
            </div>
          </Sec>

          <Sec icon="filter" title="הגדרות תפעוליות" note="קובעות איפה האזור מופיע במערכת">
            <div className="flex flex-col">
              <SwLine icon="eye" label="פעיל" hint="האזור מוצג ברשימות ובמערכת" checked={d.is_active} onChange={(v) => set("is_active", v)} />
              <SwLine icon="brush" label="רלוונטי לניקיון" hint="האזור נכלל במשימות ניקיון" checked={d.relevant_cleaning} onChange={(v) => set("relevant_cleaning", v)} />
              <SwLine icon="maintenance" label="רלוונטי לתחזוקה" hint="ניתן לפתוח תקלות עבור אזור זה" checked={d.relevant_maintenance} onChange={(v) => set("relevant_maintenance", v)} />
              <div className="rm-swline">
                <span className="rm-swic">
                  <Icon name="sort" size={20} />
                </span>
                <div className="min-w-0">
                  <p className="rm-swt">סדר תצוגה</p>
                  <p className="rm-swd">מיקום האזור ברשימות — נמוך מוצג קודם</p>
                </div>
                <span className="flex-1" />
                <span className="rm-step">
                  <button type="button" aria-label="הוספה" onClick={() => set("sort_order", d.sort_order + 1)}>
                    <Icon name="plus" size={20} />
                  </button>
                  <input
                    className="rm-v"
                    dir="ltr"
                    inputMode="numeric"
                    aria-label="סדר תצוגה"
                    value={d.sort_order}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      set("sort_order", Number.isFinite(n) ? Math.max(0, n) : 0);
                    }}
                  />
                  <button type="button" aria-label="הפחתה" onClick={() => set("sort_order", Math.max(0, d.sort_order - 1))}>
                    <Icon name="minus" size={20} />
                  </button>
                </span>
              </div>
              <div className="pt-3.5">
                <F label="הערות תפעוליות">
                  <textarea
                    className="field-input"
                    rows={3}
                    placeholder="הערות פנימיות לצוות…"
                    value={d.notes}
                    onChange={(e) => set("notes", e.target.value)}
                  />
                </F>
              </div>
            </div>
          </Sec>

          {/* status lives on the board popover; kept here for edit so an open
              incident (תחזוקה/חסום + note) can be adjusted from the window */}
          {area && (
            <Sec icon="warning" title="מצב האזור">
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
              {d.status !== "ok" && (
                <F label="הערת מצב">
                  <input
                    className="field-input"
                    placeholder="לדוגמה: טכנאי הוזמן · עד 9/7"
                    value={d.status_note}
                    onChange={(e) => set("status_note", e.target.value)}
                  />
                </F>
              )}
            </Sec>
          )}
        </div>

        {/* live preview + requirements (reference side column) */}
        <div className="rm-colside">
          <Sec icon="eye" title="תצוגה מקדימה">
            <div className="card rm-bcard" style={{ cursor: "default" }}>
              <span className="rm-strip" style={{ background: statusMeta.triplet.dot }} />
              <div className="rm-cr1">
                <span className="rm-num">{d.name.trim() || "שם האזור"}</span>
                {/* KIND tag — type label, not a status: .chip-neutral (mirrors
                    the board's AreaCard so the preview is truthful) */}
                <span className="chip chip-neutral">אזור</span>
                <span className="rm-csp" />
                <span className={`chip ${statusMeta.triplet.chip}`}>
                  <Icon name={statusMeta.icon} size={13.5} />
                  {statusMeta.label}
                </span>
              </div>
              <div className="rm-cr2">
                {d.area_type ? AREA_TYPE_LABEL[d.area_type] : "סוג אזור"}
              </div>
              <div className="rm-cr3">
                {d.status !== "ok" && d.status_note ? (
                  <>
                    <Icon name={statusMeta.icon} size={13.5} />
                    {d.status_note}
                  </>
                ) : null}
              </div>
            </div>
            <div className="rm-pvnote">כך ייראה האזור במסך חדרים ואזורים</div>
            <div className="rm-chklist">
              <ChkItem ok={Boolean(d.name.trim())} label="שם אזור" />
              <ChkItem ok={Boolean(d.area_type)} label="סוג אזור" />
              <ChkItem ok={d.relevant_cleaning} label="ייכלל במשימות ניקיון" />
              <ChkItem ok={d.relevant_maintenance} label="פתיחת תקלות תחזוקה" />
            </div>
          </Sec>
        </div>
      </div>
    </SidePanel>
  );
}

function SwLine({
  icon,
  label,
  hint,
  checked,
  onChange,
}: {
  icon: IconName;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="rm-swline">
      <span className="rm-swic">
        <Icon name={icon} size={20} />
      </span>
      <div className="min-w-0">
        <p className="rm-swt">{label}</p>
        <p className="rm-swd">{hint}</p>
      </div>
      <span className="flex-1" />
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

function ChkItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className={`rm-chki ${ok ? "ok" : "no"}`}>
      <Icon name={ok ? "check-circle" : "circle"} size={17} />
      {label}
    </div>
  );
}
