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
import { ArrivalsWindow } from "./windows/ArrivalsWindow";
import { InHouseWindow } from "./windows/InHouseWindow";
import { HousekeepingWindow } from "./windows/HousekeepingWindow";
import { AlertsWindow } from "./windows/AlertsWindow";
import { RevenueWindow } from "./windows/RevenueWindow";
import { SourcesWindow } from "./windows/SourcesWindow";
import { ReviewsWindow } from "./windows/ReviewsWindow";
import { MessagesWindow } from "./windows/MessagesWindow";
import type { DashboardData } from "./data";
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
  value: string;
  sub: string;
};

const ils = (n: number) => `₪${Math.round(n).toLocaleString("he-IL")}`;

// Every subline states WHAT WAS COUNTED. "מתוך N יחידות" carries the computed
// denominator (D128 — status='available' AND is_active), never a hardcoded
// number and never a generic caption; and the revenue line says כולל מע״מ,
// because every stored price is VAT-inclusive at 18% and an unlabelled figure
// is wrong by exactly that (audit §4.4).
function kpiCards(d: DashboardData): readonly KpiCard[] {
  const k = d.kpi;
  return [
    {
      key: "occ", icon: "hotel", tone: "brand", label: "תפוסה הלילה",
      value: `${k.occupancyPct}%`,
      sub: `${k.occupied} מתוך ${k.sellable} יחידות`,
    },
    {
      key: "arr", icon: "login", tone: "ok", label: "הגעות היום",
      value: String(k.arrivals), sub: "צ׳ק-אין מתוכנן",
    },
    {
      key: "dep", icon: "logout", tone: "warn", label: "עזיבות היום",
      value: String(k.departures), sub: "צ׳ק-אאוט מתוכנן",
    },
    {
      key: "rev", icon: "payments", tone: "mut", label: "הכנסה צפויה הלילה",
      value: ils(k.revenueTonight), sub: "כולל מע״מ",
    },
  ];
}

export function DashboardScreen({
  initial,
  todayLabel,
  unitLabel,
  data,
}: {
  initial: DashboardPreferences;
  todayLabel: string;
  unitLabel: string;
  data: DashboardData;
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
        {kpiCards(data).map((k) => (
          <div key={k.key} className="card kpi">
            <span className={`kpi-icon kpi-${k.tone}`}>
              <Icon name={k.icon} size={20} />
            </span>
            <div className="kpi-text">
              {/* .ltr-num goes on an INLINE span, never on this block. It carries
                  `direction: ltr`, and on the block that flips the line's start
                  edge to the left while the label and subline below stay RTL —
                  measured at 1440px, the value drifted 9/41/44px away from the
                  label's edge. Isolating the digits inline keeps the shekel sign,
                  the percent and the thousands separators in the right order AND
                  keeps the value flush with its own label, as
                  DeshbordMain.source.html renders it (.kv is plain RTL there). */}
              <div className="kpi-value">
                <span className="ltr-num">{k.value}</span>
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
                  <SortableWindow key={id} id={id} onHide={() => hideWindow(id)} data={data} />
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

function SortableWindow({
  id,
  onHide,
  data,
}: {
  id: DashboardWindowId;
  onHide: () => void;
  data: DashboardData;
}) {
  const def = windowById(id);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id });

  if (!def) return null;

  // Eight windows are live. The other three (agd, iss, tsk) keep the Phase 1
  // sentence that says what will go there — a window with no source renders
  // the promise, never a fabricated row.
  const live = liveContent(id, data);

  return (
    <DashboardWindow
      icon={def.icon}
      title={def.title}
      subtitle={live?.subtitle}
      onHide={onHide}
      containerRef={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      dragging={isDragging}
      dropzone={isOver && !isDragging}
      headerProps={{ ...attributes, ...listeners }}
    >
      {live ? (
        live.body
      ) : (
        <div className="empty-state empty-sm">
          <span className="empty-t">אין נתונים להצגה עדיין</span>
          <span className="empty-s">{def.empty}</span>
        </div>
      )}
    </DashboardWindow>
  );
}

function liveContent(
  id: DashboardWindowId,
  data: DashboardData,
): { subtitle?: React.ReactNode; body: React.ReactNode } | null {
  switch (id) {
    case "arr":
      return {
        subtitle: `${data.arrivals.length} הגעות · ${data.departures.length} עזיבות`,
        body: <ArrivalsWindow arrivals={data.arrivals} departures={data.departures} />,
      };
    case "inh":
      return {
        subtitle: `${data.inHouse.length} אורחים`,
        body: <InHouseWindow rows={data.inHouse} />,
      };
    case "hk": {
      const dirty = data.housekeeping.filter(
        (r) => r.status !== "completed" && r.status !== "inspected",
      ).length;
      return {
        subtitle: data.housekeeping.length > 0 ? `${dirty} מלוכלכים` : undefined,
        body: <HousekeepingWindow rows={data.housekeeping} />,
      };
    }
    case "alr":
      return {
        subtitle: data.alerts.length > 0 ? `${data.alerts.length} פריטים` : undefined,
        body: <AlertsWindow rows={data.alerts} />,
      };
    case "rev":
      return { body: <RevenueWindow series={data.monthly} /> };
    case "rvw":
      return {
        // singular has its own form, as staySubline's "לילה אחד" already does
        subtitle:
          data.reviewsAwaitingReply === 1
            ? "חוות דעת אחת ממתינה למענה"
            : data.reviewsAwaitingReply > 0
              ? `${data.reviewsAwaitingReply} ממתינות למענה`
              : undefined,
        body: <ReviewsWindow rows={data.reviews} />,
      };
    case "msg":
      return {
        subtitle:
          data.unreadConversations === 1
            ? "שיחה אחת טרם נענתה"
            : data.unreadConversations > 0
              ? `${data.unreadConversations} שיחות טרם נענו`
              : undefined,
        body: <MessagesWindow rows={data.conversations} />,
      };
    case "src":
      return {
        subtitle: `${data.sources.totals.guests} אורחים`,
        body: <SourcesWindow breakdown={data.sources} />,
      };
    default:
      return null;
  }
}
