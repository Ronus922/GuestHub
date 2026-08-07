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
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
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
import { StuckWindow } from "./windows/StuckWindow";
import { PayWindow } from "./windows/PayWindow";
import { AgendaWindow } from "./windows/AgendaWindow";
import { IssuesWindow } from "./windows/IssuesWindow";
import { RevenueWindow } from "./windows/RevenueWindow";
import { SourcesWindow } from "./windows/SourcesWindow";
import { ReviewsWindow } from "./windows/ReviewsWindow";
import { MessagesWindow } from "./windows/MessagesWindow";
import type { DashboardData } from "./data";
import {
  COLUMNS,
  isWindowId,
  windowById,
  type DashboardColumn,
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
// DRAG. @dnd-kit, one SortableContext per column, and moves may CROSS columns
// (DeshbordMain.md §3): onDragOver relocates the window live as it crosses the
// border (with TaskDispatchBoard's anti-bounce guard so it doesn't ping-pong),
// onDragEnd commits the order — a drop on a card lands BEFORE that card, a
// drop on the column itself (empty column, or the space under its last card,
// via useDroppable) appends. Escape restores the pre-drag snapshot. The column
// a window lives in is state; windows.ts only supplies the default. The header
// is the only handle; the ✕ inside it stops the pointer event so a click is a
// click.
//
// WRITE. Debounced — a drag must not fire a request per pixel, and dnd-kit
// fires onDragEnd once per drop, so the debounce is really about the operator
// who reorders four cards in six seconds. The flush on unmount is what makes a
// drop-then-navigate durable.
// ============================================================

const SAVE_DEBOUNCE_MS = 800;

// The column droppables live in the same DndContext as the cards, so their ids
// share a namespace with window ids — "col:" keeps them apart (every window id
// is three letters, no colon).
const colDroppableId = (c: DashboardColumn) => `col:${c}`;
const colFromDroppable = (id: unknown): DashboardColumn | null =>
  id === "col:l" ? "l" : id === "col:r" ? "r" : null;

// Which column an id belongs to, asked of the LAYOUT STATE — never of the
// registry, whose defaultCol stops meaning "current column" the moment a
// window is dragged across. Resolves both card ids and column-droppable ids.
function findColumn(layout: DashboardLayout, id: unknown): DashboardColumn | null {
  const asCol = colFromDroppable(id);
  if (asCol) return asCol;
  if (isWindowId(id)) {
    if (layout.l.includes(id)) return "l";
    if (layout.r.includes(id)) return "r";
  }
  return null;
}

const COLUMN_LABEL: Record<DashboardColumn, string> = {
  l: "העמודה הראשית",
  r: "העמודה המשנית",
};

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
  now,
}: {
  initial: DashboardPreferences;
  todayLabel: string;
  unitLabel: string;
  data: DashboardData;
  /** HH:MM in the PROPERTY's timezone, computed by the server — agd's clock */
  now: string;
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

  // pointerWithin first — closestCenter alone never resolves an empty column
  // or the strip under a column's last card; it falls back for keyboard drags,
  // where there is no pointer (TaskDispatchBoard's stableCollision).
  const stableCollision: CollisionDetection = useCallback((args) => {
    const within = pointerWithin(args);
    return within.length > 0 ? within : closestCenter(args);
  }, []);

  // onDragOver moves state live, so handlers need the CURRENT layout (state
  // reads inside a drag are stale), the source column for the anti-bounce
  // guard, and a snapshot to restore when the drag is cancelled.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const dragSourceColRef = useRef<DashboardColumn | null>(null);
  const preDragLayoutRef = useRef<DashboardLayout | null>(null);

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
    if (!isWindowId(id)) return;
    setActiveId(id);
    preDragLayoutRef.current = layoutRef.current;
    dragSourceColRef.current = findColumn(layoutRef.current, id);
  };

  // Cross-column moves happen HERE, live, so the card visibly leaves one
  // column and opens a slot in the other while still in flight. Same-column
  // ordering stays in onDragEnd — dnd-kit's sortable transforms handle the
  // preview within a list.
  const onDragOver = (e: DragOverEvent) => {
    if (!e.over) return;
    const activeIdNow = e.active.id;
    const overId = e.over.id;
    if (!isWindowId(activeIdNow)) return;
    const from = findColumn(layoutRef.current, activeIdNow);
    const to = findColumn(layoutRef.current, overId);
    if (!from || !to || from === to) return;
    // anti-bounce: the card already left its source — don't ping-pong it back
    if (to === dragSourceColRef.current && from !== dragSourceColRef.current) return;
    setLayout((prev) => {
      const src = prev[from].filter((x) => x !== activeIdNow);
      const dest = [...prev[to]];
      const overIdx = isWindowId(overId) ? dest.indexOf(overId) : -1;
      // before the target card; on the column itself (empty / below the last
      // card) — append
      dest.splice(overIdx === -1 ? dest.length : overIdx, 0, activeIdNow);
      return { ...prev, [from]: src, [to]: dest };
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    dragSourceColRef.current = null;
    preDragLayoutRef.current = null;
    const from = e.active.id;
    const overId = e.over?.id;
    const cur = layoutRef.current;
    if (!isWindowId(from)) return;

    let next = cur;
    const fromCol = findColumn(cur, from);
    const toCol = overId === undefined ? null : findColumn(cur, overId);
    if (fromCol && toCol && isWindowId(overId) && overId !== from) {
      if (fromCol === toCol) {
        const oldIndex = cur[fromCol].indexOf(from);
        const newIndex = cur[fromCol].indexOf(overId);
        if (oldIndex >= 0 && newIndex >= 0 && oldIndex !== newIndex)
          next = { ...cur, [fromCol]: arrayMove(cur[fromCol], oldIndex, newIndex) };
      } else {
        // the final frame crossed a column without a dragOver — same
        // insert-before-target rule, idempotent with the live move
        const src = cur[fromCol].filter((x) => x !== from);
        const dest = [...cur[toCol]];
        dest.splice(dest.indexOf(overId), 0, from);
        next = { ...cur, [fromCol]: src, [toCol]: dest };
      }
    }
    // save even when the order is unchanged — onDragOver may have already
    // crossed a column, and this is that move's commit
    setLayout(next);
    save({ layout: next, hidden });
  };

  const onDragCancel = () => {
    setActiveId(null);
    // onDragOver already moved the card — Escape must put it back, unsaved
    if (preDragLayoutRef.current) setLayout(preDragLayoutRef.current);
    preDragLayoutRef.current = null;
    dragSourceColRef.current = null;
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
        collisionDetection={stableCollision}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
        accessibility={{
          screenReaderInstructions: {
            draggable: "לחץ רווח להרמה, חצים להזזה, רווח לשחרור, Escape לביטול.",
          },
          announcements: {
            onDragStart: ({ active }) => `הרמת את ${windowLabel(active.id)}`,
            onDragOver: ({ active, over }) => {
              const col = over ? findColumn(layoutRef.current, over.id) : null;
              return col ? `${windowLabel(active.id)} מעל ${COLUMN_LABEL[col]}` : "";
            },
            onDragEnd: ({ active, over }) => {
              const col = over ? findColumn(layoutRef.current, over.id) : null;
              return col ? `${windowLabel(active.id)} הונח ב${COLUMN_LABEL[col]}` : "";
            },
            onDragCancel: ({ active }) => `בוטלה גרירת ${windowLabel(active.id)}`,
          },
        }}
      >
        {/* dnd-active gives an emptied column a minimum drop height, only
            while something is actually in flight */}
        <div className={`dash-cols${activeId ? " dnd-active" : ""}`}>
          {COLUMNS.map((col) => (
            <DroppableColumn key={col} col={col}>
              {/* every card lives INSIDE its column div (DeshbordMain.md §8.3) */}
              <SortableContext items={visible[col]} strategy={verticalListSortingStrategy}>
                {visible[col].map((id) => (
                  <SortableWindow
                    key={id}
                    id={id}
                    onHide={() => hideWindow(id)}
                    data={data}
                    now={now}
                  />
                ))}
              </SortableContext>
            </DroppableColumn>
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

// The column div is itself a drop target, so a drop lands even where no card
// is under the pointer — an emptied column, or the strip below a column's last
// card. A drop here appends (onDragOver's overIdx === -1 rule).
function DroppableColumn({
  col,
  children,
}: {
  col: DashboardColumn;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: colDroppableId(col) });
  return (
    <div ref={setNodeRef} className={`dash-col${isOver ? " drop-target" : ""}`}>
      {children}
    </div>
  );
}

function windowLabel(id: unknown): string {
  return (isWindowId(id) ? windowById(id)?.title : undefined) ?? "חלון";
}

function SortableWindow({
  id,
  onHide,
  data,
  now,
}: {
  id: DashboardWindowId;
  onHide: () => void;
  data: DashboardData;
  now: string;
}) {
  const def = windowById(id);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id });

  if (!def) return null;

  // Eleven windows are live. tsk alone keeps the Phase 1 sentence that says
  // what will go there — a window with no source renders the promise, never a
  // fabricated row.
  const live = liveContent(id, data, now);

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
  now: string,
): { subtitle?: React.ReactNode; body: React.ReactNode } | null {
  switch (id) {
    case "stk":
      return {
        subtitle: data.stuck.count > 0 ? `${data.stuck.count} תקועות` : undefined,
        body: <StuckWindow stuck={data.stuck} />,
      };
    case "pay":
      return {
        subtitle: data.payRows.length > 0 ? `${data.payRows.length} ממתינות` : undefined,
        body: <PayWindow rows={data.payRows} approvedId={data.approvedWorkflowStatusId} />,
      };
    case "agd": {
      const next = data.agenda.find((it) => it.time >= now);
      return {
        subtitle: next ? (
          <>
            הבא: <span className="ltr-num">{next.time}</span>
          </>
        ) : undefined,
        body: <AgendaWindow items={data.agenda} now={now} />,
      };
    }
    case "iss": {
      const open = data.issues.filter(
        (r) => r.status !== "completed" && r.status !== "inspected",
      );
      const urgent = open.filter((r) => r.priority === "high").length;
      return {
        subtitle:
          open.length > 0
            ? `${open.length} פתוחות${urgent > 0 ? ` · ${urgent} דחופות` : ""}`
            : undefined,
        body: <IssuesWindow rows={data.issues} />,
      };
    }
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
        subtitle: freshness(data.lastReviewsSyncMinutes),
        body: <ReviewsWindow summary={data.reviewsSummary} rows={data.reviews} />,
      };
    case "msg":
      return {
        subtitle: freshness(data.lastMessagesSyncMinutes),
        body: <MessagesWindow summary={data.messagesSummary} rows={data.conversations} />,
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

// The msg/rvw chrome line — how stale the window is, from the sync stamps
// (DeshbordMain §5.4/§5.5: "עודכן לפני 12 דק׳"). Minutes are the native unit;
// an older stamp escalates to hours/days rather than stating "540 דק'".
function freshness(minutes: number | null): string | undefined {
  if (minutes === null) return undefined;
  if (minutes < 1) return "עודכן ממש עכשיו";
  if (minutes === 1) return "עודכן לפני דקה";
  if (minutes < 60) return `עודכן לפני ${minutes} דק׳`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "עודכן לפני שעה";
  if (hours < 24) return `עודכן לפני ${hours} שע׳`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "עודכן אתמול" : `עודכן לפני ${days} ימים`;
}
