"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Icon } from "@/components/shared/Icon";
import { DashboardWindow } from "@/components/shared/DashboardWindow";
import { useNewReservation } from "@/components/reservations/NewReservationProvider";
import { saveDashboardLayoutAction } from "./actions";
import {
  COLUMNS,
  columnOf,
  isWindowId,
  windowById,
  type DashboardLayout,
  type DashboardPreferences,
  type DashboardWindowId,
} from "./windows";

// ============================================================
// The dashboard's client half: drag order, hidden set, and the debounced write.
//
// PHASE 1 IS CHROME. No window fetches anything; each renders the sentence that
// describes what Phase 2 will put there. The KPI values are "—" for the same
// reason — a placeholder number is a lie an operator cannot tell from data.
//
// DRAG. @dnd-kit, one SortableContext per column, and onDragEnd refuses any
// move whose source and target columns differ (DeshbordMain.md §3: "drop מותר
// רק בתוך אותה עמודה"). The header is the only handle; the ✕ inside it stops
// the pointer event so a click is a click.
//
// WRITE. Debounced — a drag must not fire a request per pixel, and dnd-kit
// fires onDragEnd once per drop, so the debounce is really about the operator
// who reorders four cards in six seconds. The flush on unmount is what makes a
// drop-then-navigate durable.
// ============================================================

const SAVE_DEBOUNCE_MS = 800;

export type KpiCard = {
  key: string;
  icon: "hotel" | "login" | "logout" | "payments";
  tone: "brand" | "ok" | "warn" | "mut";
  label: string;
  sub: string;
};

const KPIS: readonly KpiCard[] = [
  { key: "occ", icon: "hotel", tone: "brand", label: "תפוסה הלילה", sub: "מתוך יחידות פעילות" },
  { key: "arr", icon: "login", tone: "ok", label: "הגעות היום", sub: "צ׳ק-אין מתוכנן" },
  { key: "dep", icon: "logout", tone: "warn", label: "עזיבות היום", sub: "צ׳ק-אאוט מתוכנן" },
  { key: "rev", icon: "payments", tone: "mut", label: "הכנסה צפויה הלילה", sub: "כולל מע״מ" },
];

export function DashboardScreen({
  initial,
  todayLabel,
  unitLabel,
}: {
  initial: DashboardPreferences;
  todayLabel: string;
  unitLabel: string;
}) {
  const [layout, setLayout] = useState<DashboardLayout>(initial.layout);
  const [hidden, setHidden] = useState<DashboardWindowId[]>(initial.hidden);
  const [activeId, setActiveId] = useState<DashboardWindowId | null>(null);
  const { openNewReservation, canCreate } = useNewReservation();

  // ---- debounced persistence ----
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<DashboardPreferences | null>(null);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const next = pending.current;
    pending.current = null;
    if (next) void saveDashboardLayoutAction(next);
  }, []);

  const save = useCallback(
    (next: DashboardPreferences) => {
      pending.current = next;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  // a drop followed immediately by navigation must still land
  useEffect(() => flush, [flush]);

  const sensors = useSensors(
    // 6px of travel before a press becomes a drag — otherwise the header's ✕
    // and any future header control are unclickable
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const visible = useMemo<DashboardLayout>(
    () => ({
      l: layout.l.filter((id) => !hiddenSet.has(id)),
      r: layout.r.filter((id) => !hiddenSet.has(id)),
    }),
    [layout, hiddenSet],
  );

  const onDragStart = (e: DragStartEvent) => {
    const id = e.active.id;
    if (isWindowId(id)) setActiveId(id);
  };

  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const from = e.active.id;
    const to = e.over?.id;
    if (!isWindowId(from) || !isWindowId(to) || from === to) return;
    // §3 — reordering happens WITHIN a column; a cross-column drop is refused
    // rather than silently relocating a window out of its registered column.
    const col = columnOf(from);
    if (columnOf(to) !== col) return;

    const oldIndex = layout[col].indexOf(from);
    const newIndex = layout[col].indexOf(to);
    if (oldIndex < 0 || newIndex < 0) return;

    const next: DashboardLayout = { ...layout, [col]: arrayMove(layout[col], oldIndex, newIndex) };
    setLayout(next);
    save({ layout: next, hidden });
  };

  const hideWindow = (id: DashboardWindowId) => {
    if (hiddenSet.has(id)) return;
    const next = [...hidden, id];
    setHidden(next);
    save({ layout, hidden: next });
    toast.success(`החלון "${windowById(id)?.title ?? id}" הוסתר`);
  };

  const showWindow = (id: DashboardWindowId) => {
    const next = hidden.filter((h) => h !== id);
    setHidden(next);
    save({ layout, hidden: next });
  };

  const showAll = () => {
    setHidden([]);
    save({ layout, hidden: [] });
  };

  const activeDef = activeId ? windowById(activeId) : undefined;

  return (
    <div className="dash">
      {/* ---- top bar ---- */}
      <header className="dash-hd">
        <div className="dash-hd-text">
          <h1 className="h3">דשבורד</h1>
          <p className="t-secondary">
            {todayLabel} · {unitLabel}
          </p>
        </div>
        <Link className="btn btn-secondary" href="/calendar">
          <Icon name="calendar" size={20} />
          יומן חדרים
        </Link>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canCreate}
          onClick={() => openNewReservation({ source: "dashboard_topbar" })}
        >
          <Icon name="plus" size={20} />
          הזמנה חדשה
        </button>
      </header>

      {/* ---- KPI row ---- */}
      <section className="kpis" aria-label="מדדי היום">
        {KPIS.map((k) => (
          <div key={k.key} className="card kpi">
            <span className={`kpi-icon kpi-${k.tone}`}>
              <Icon name={k.icon} size={20} />
            </span>
            <div className="kpi-text">
              {/* Phase 2 replaces the em dash. A zero here would be a number the
                  operator cannot tell from a measurement.

                  .ltr-num goes on an INLINE span, never on this block. It carries
                  `direction: ltr`, and on the block that flips the line's start
                  edge to the left while the label and subline below stay RTL —
                  measured at 1440px, the value drifted 9/41/44px away from the
                  label's edge. Isolating the digits inline keeps the shekel sign,
                  the percent and the thousands separators in the right order AND
                  keeps the value flush with its own label, as
                  DeshbordMain.source.html renders it (.kv is plain RTL there). */}
              <div className="kpi-value">
                <span className="ltr-num">—</span>
              </div>
              <div className="kpi-label">{k.label}</div>
              <div className="kpi-sub">{k.sub}</div>
            </div>
          </div>
        ))}
      </section>

      {/* ---- hidden-windows bar ---- */}
      {hidden.length > 0 && (
        <section className="card hidden-bar" aria-label="חלונות מוסתרים">
          <Icon name="eye-off" size={20} />
          <span className="t-secondary">חלונות מוסתרים</span>
          {hidden.map((id) => (
            <button
              key={id}
              type="button"
              className="chip chip-restore"
              onClick={() => showWindow(id)}
            >
              <Icon name="plus" size={13.5} />
              {windowById(id)?.title ?? id}
            </button>
          ))}
          <button type="button" className="btn btn-sm btn-secondary hidden-bar-all" onClick={showAll}>
            החזרת הכול
          </button>
        </section>
      )}

      {/* ---- the two columns ---- */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="dash-cols">
          {COLUMNS.map((col) => (
            <div key={col} className="dash-col">
              {/* every card lives INSIDE its column div (DeshbordMain.md §8.3) */}
              <SortableContext items={visible[col]} strategy={verticalListSortingStrategy}>
                {visible[col].map((id) => (
                  <SortableWindow key={id} id={id} onHide={() => hideWindow(id)} />
                ))}
              </SortableContext>
            </div>
          ))}
        </div>
        <DragOverlay>
          {activeDef ? (
            <DashboardWindow icon={activeDef.icon} title={activeDef.title}>
              <div className="empty-state empty-sm">
                <span className="empty-t">{activeDef.title}</span>
              </div>
            </DashboardWindow>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function SortableWindow({ id, onHide }: { id: DashboardWindowId; onHide: () => void }) {
  const def = windowById(id);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id });

  if (!def) return null;

  return (
    <DashboardWindow
      icon={def.icon}
      title={def.title}
      onHide={onHide}
      containerRef={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      dragging={isDragging}
      dropzone={isOver && !isDragging}
      headerProps={{ ...attributes, ...listeners }}
    >
      <div className="empty-state empty-sm">
        <span className="empty-t">אין נתונים להצגה עדיין</span>
        <span className="empty-s">{def.empty}</span>
      </div>
    </DashboardWindow>
  );
}
