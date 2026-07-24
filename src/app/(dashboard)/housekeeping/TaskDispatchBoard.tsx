"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  pointerWithin,
  closestCenter,
  type CollisionDetection,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";
import { Icon, type IconName } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import {
  getTaskBoardAction,
  assignTaskAction,
  reorderTasksAction,
  setTaskStatusAction,
  inspectTaskAction,
  updateTaskAction,
  deleteTaskAction,
  createOperationalTaskAction,
  type HousekeepingTaskView,
  type TaskBoard,
  type OperationalTaskType,
} from "@/lib/housekeeping/actions";

// ============================================================
// Drag-and-drop dispatch board (D88) — the GuestHub twin of the PMS housekeeping
// board. Columns = assignable users, cards = tasks, drag to assign, drag inside
// a column to reorder (persisted via order_index). The concurrency machinery
// (dragSourceRef / loadSeq / dragInFlight + anti-bounce) is ported verbatim from
// the PMS board — it is what makes multi-container dnd-kit feel solid.
//
// Two role-scoped boards on the same component + the same guarded Server
// Actions: scope="housekeeping" (/housekeeping — cleaning tasks, columns =
// cleaners) and scope="maintenance" (/maintenance — maintenance tasks, columns
// = maintenance workers). Each board is type-locked and shows only its own
// workers as columns; managers/reception/admins are never columns.
// ============================================================

type Scope = "housekeeping" | "maintenance";
const UNASSIGNED_ID = "__unassigned__";
const POLL_MS = 5000;

const SCOPE_TITLE: Record<Scope, string> = {
  housekeeping: "לוח ניקיון",
  maintenance: "לוח תחזוקה",
};
const SCOPE_ICON: Record<Scope, IconName> = {
  housekeeping: "cleaning",
  maintenance: "maintenance",
};

const TYPE_LABEL: Record<string, string> = {
  housekeeping: "ניקיון",
  maintenance: "תחזוקה",
  general: "כללי",
};
const TYPE_ICON: Record<string, IconName> = {
  housekeeping: "cleaning",
  maintenance: "maintenance",
  general: "list-checks",
};
const STATUS_LABEL: Record<string, string> = {
  pending: "ממתין",
  in_progress: "בביצוע",
  completed: "הושלם",
  inspected: "נבדק",
};
// named Tailwind palette only (design gate allows palette, not raw hex)
const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/20 dark:text-amber-400",
  in_progress: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/20 dark:text-blue-400",
  completed: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/20 dark:text-emerald-400",
  inspected: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/20 dark:text-violet-400",
};

type Urgency = "past" | "today" | "tomorrow" | "future" | "in_progress";
const URGENCY_DOT: Record<Urgency, string> = {
  past: "bg-red-500",
  today: "bg-amber-500",
  tomorrow: "bg-blue-500",
  future: "bg-slate-400",
  in_progress: "bg-emerald-500",
};

// local-timezone ISO (never toISOString — that is UTC and breaks around midnight)
const toLocalIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayIso = () => toLocalIso(new Date());
const shiftIso = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toLocalIso(d);
};
// a task's effective day = its checkout date (local) or its due date
const effDate = (t: HousekeepingTaskView): string | null =>
  t.checkoutTime ? toLocalIso(new Date(t.checkoutTime)) : t.dueDate ?? null;

function urgencyOf(t: HousekeepingTaskView, today: string, tomorrow: string): Urgency {
  if (t.status === "in_progress") return "in_progress";
  const d = effDate(t);
  if (!d) return "future";
  if (d < today) return "past";
  if (d === today) return "today";
  if (d === tomorrow) return "tomorrow";
  return "future";
}
const checkoutHM = (t: HousekeepingTaskView): string | null =>
  t.checkoutTime ? new Date(t.checkoutTime).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) : null;

const cardTitle = (t: HousekeepingTaskView) =>
  t.title ?? (t.roomNumber ? `חדר ${t.roomNumber}` : "משימה");

// ============================================================
// The board
// ============================================================
export function TaskDispatchBoard({
  scope,
  canManage,
}: {
  scope: Scope;
  canManage: boolean;
}) {
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [date, setDate] = useState<string>(todayIso());
  const [activeTask, setActiveTask] = useState<HousekeepingTaskView | null>(null);
  const [quickFilter, setQuickFilter] = useState<null | "unassigned" | "dueToday" | "urgent">(null);
  const [editTask, setEditTask] = useState<HousekeepingTaskView | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const loadSeq = useRef(0);
  const dragInFlight = useRef(false);
  const dragSourceRef = useRef<string | null>(null);
  const dragDestRef = useRef<string | null>(null);
  const boardRef = useRef<TaskBoard | null>(null);
  boardRef.current = board;

  const today = todayIso();
  const tomorrow = shiftIso(today, 1);

  // ---- data load (with the stale-response sequence guard) ----
  const loadBoard = useCallback(async () => {
    const seq = ++loadSeq.current;
    const res = await getTaskBoardAction(scope, date);
    if (seq !== loadSeq.current) return; // superseded (newer load / drag) → drop
    if (!res.success || !res.data) {
      setLoadError(true);
      setLoading(false);
      return;
    }
    setBoard(res.data);
    setLoadError(false);
    setLoading(false);
  }, [scope, date]);

  const loadBoardSafe = useCallback(async () => {
    if (dragInFlight.current) return; // never repaint mid-drag
    await loadBoard();
  }, [loadBoard]);

  useEffect(() => {
    setLoading(true);
    loadBoard();
    const t = setInterval(loadBoardSafe, POLL_MS);
    return () => clearInterval(t);
  }, [loadBoard, loadBoardSafe]);

  // ---- container helpers (operate on the live boardRef) ----
  const findContainer = useCallback((id: string): string | null => {
    const b = boardRef.current;
    if (!b) return null;
    if (id === UNASSIGNED_ID || b.byUser[id] !== undefined) return id; // id is a column
    if (b.unassigned.some((t) => t.id === id)) return UNASSIGNED_ID;
    for (const [uid, tasks] of Object.entries(b.byUser)) if (tasks.some((t) => t.id === id)) return uid;
    return null;
  }, []);
  const getList = useCallback((cid: string): HousekeepingTaskView[] => {
    const b = boardRef.current;
    if (!b) return [];
    return cid === UNASSIGNED_ID ? b.unassigned : b.byUser[cid] ?? [];
  }, []);
  const setList = (prev: TaskBoard, cid: string, list: HousekeepingTaskView[]): TaskBoard =>
    cid === UNASSIGNED_ID
      ? { ...prev, unassigned: list }
      : { ...prev, byUser: { ...prev.byUser, [cid]: list } };

  // ---- sensors + collision ----
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const stableCollision: CollisionDetection = useCallback((args) => {
    const within = pointerWithin(args);
    return within.length > 0 ? within : closestCenter(args);
  }, []);

  const columnLabel = useCallback(
    (cid: string) => (cid === UNASSIGNED_ID ? "לא משויך" : board?.users.find((u) => u.id === cid)?.name ?? "עמודה"),
    [board],
  );
  const taskLabel = useCallback((id: string) => {
    const b = boardRef.current;
    if (!b) return "משימה";
    const t = [...b.unassigned, ...Object.values(b.byUser).flat()].find((x) => x.id === id);
    return t ? cardTitle(t) : "משימה";
  }, []);

  // ---- drag handlers ----
  const handleDragStart = (e: DragStartEvent) => {
    if (!boardRef.current) return;
    dragInFlight.current = true;
    loadSeq.current++; // discard any in-flight poll response
    dragDestRef.current = null;
    const id = String(e.active.id);
    const cid = findContainer(id);
    if (!cid) return;
    dragSourceRef.current = cid;
    const task = getList(cid).find((t) => t.id === id);
    if (task) setActiveTask(task);
  };

  const handleDragOver = (e: DragOverEvent) => {
    if (!boardRef.current || !e.over) return;
    const activeId = String(e.active.id);
    const overId = String(e.over.id);
    const activeContainer = findContainer(activeId);
    const overContainer = findContainer(overId);
    if (!activeContainer || !overContainer || activeContainer === overContainer) return;
    // anti-bounce: the card already left its source — don't ping-pong it back
    if (overContainer === dragSourceRef.current && activeContainer !== dragSourceRef.current) return;

    setBoard((prev) => {
      if (!prev) return prev;
      const sourceList = activeContainer === UNASSIGNED_ID ? prev.unassigned : prev.byUser[activeContainer] ?? [];
      const destList = overContainer === UNASSIGNED_ID ? prev.unassigned : prev.byUser[overContainer] ?? [];
      const activeIdx = sourceList.findIndex((t) => t.id === activeId);
      if (activeIdx === -1) return prev;
      const task = sourceList[activeIdx];
      const overIdx = destList.findIndex((t) => t.id === overId);
      const insertAt = overIdx === -1 ? destList.length : overIdx;
      const newSource = sourceList.filter((_, i) => i !== activeIdx);
      const newDest = [...destList.slice(0, insertAt), task, ...destList.slice(insertAt)];
      const withSource = setList(prev, activeContainer, newSource);
      return setList(withSource, overContainer, newDest);
    });
    dragDestRef.current = overContainer;
  };

  const handleDragEnd = async (e: DragEndEvent) => {
    setActiveTask(null);
    const sourceContainer = dragSourceRef.current;
    const lastDest = dragDestRef.current;
    dragSourceRef.current = null;
    dragDestRef.current = null;
    try {
      if (!boardRef.current || !sourceContainer) {
        await loadBoard();
        return;
      }
      const activeId = String(e.active.id);
      // trust e.over unless it resolves to the dragged card itself; else the hover-ref
      const dropContainer = e.over && String(e.over.id) !== activeId ? findContainer(String(e.over.id)) : null;
      const dest = dropContainer ?? lastDest;

      // cross-container → ASSIGN
      if (dest && dest !== sourceContainer) {
        try {
          const res = await assignTaskAction(activeId, dest === UNASSIGNED_ID ? null : dest);
          if (!res.success) toast.error(`השיבוץ לא נשמר: ${res.error ?? "שגיאה"}`);
        } catch {
          toast.error("השיבוץ לא נשמר — בעיית תקשורת. נסה שוב.");
        }
        await loadBoard();
        return;
      }

      // same-container → REORDER
      if (e.over) {
        const overId = String(e.over.id);
        const list = getList(sourceContainer);
        const oldIndex = list.findIndex((t) => t.id === activeId);
        const overIndex = list.findIndex((t) => t.id === overId);
        if (oldIndex !== -1 && overIndex !== -1 && oldIndex !== overIndex) {
          const newList = arrayMove(list, oldIndex, overIndex);
          setBoard((prev) => (prev ? setList(prev, sourceContainer, newList) : prev));
          try {
            const res = await reorderTasksAction(
              sourceContainer === UNASSIGNED_ID ? null : sourceContainer,
              newList.map((t) => t.id),
            );
            if (!res.success) toast.error(`הסדר לא נשמר: ${res.error ?? "שגיאה"}`);
          } catch {
            toast.error("הסדר לא נשמר — בעיית תקשורת. נסה שוב.");
          }
        }
      }
      await loadBoard();
    } finally {
      dragInFlight.current = false;
    }
  };

  const handleDragCancel = () => {
    setActiveTask(null);
    dragInFlight.current = false;
    dragSourceRef.current = null;
    dragDestRef.current = null;
    loadBoard();
  };

  // ---- filtering + KPIs ----
  const allTasks = useMemo(
    () => (board ? [...board.unassigned, ...Object.values(board.byUser).flat()] : []),
    [board],
  );
  const kpis = useMemo(() => {
    let total = 0,
      unassigned = 0,
      dueToday = 0,
      urgent = 0;
    for (const t of allTasks) {
      if (t.status !== "pending" && t.status !== "in_progress") continue;
      total++;
      if (!t.assignedTo) unassigned++;
      const d = effDate(t);
      if (d === today) dueToday++;
      if (t.priority === "high" || (d && d < today)) urgent++;
    }
    return { total, unassigned, dueToday, urgent };
  }, [allTasks, today]);

  const passes = useCallback(
    (t: HousekeepingTaskView) => {
      if (quickFilter === "unassigned") return !t.assignedTo;
      if (quickFilter === "dueToday") return effDate(t) === today;
      if (quickFilter === "urgent") return t.priority === "high" || (!!effDate(t) && effDate(t)! < today);
      return true;
    },
    [quickFilter, today],
  );

  const filteredUnassigned = useMemo(() => (board?.unassigned ?? []).filter(passes), [board, passes]);
  const filteredByUser = useMemo(() => {
    const out: Record<string, HousekeepingTaskView[]> = {};
    if (board) for (const [uid, list] of Object.entries(board.byUser)) out[uid] = list.filter(passes);
    return out;
  }, [board, passes]);

  const refresh = useCallback(() => {
    void loadBoard();
  }, [loadBoard]);

  // ---- render ----
  return (
    <div className="flex flex-col gap-5">
      <BoardHeader
        scope={scope}
        title={SCOPE_TITLE[scope]}
        date={date}
        onDate={setDate}
        today={today}
        kpis={kpis}
        quickFilter={quickFilter}
        onQuickFilter={setQuickFilter}
        canManage={canManage}
        onCreate={() => setShowCreate(true)}
        onRefresh={refresh}
      />

      {loading && !board ? (
        <div className="grid place-items-center py-20">
          <Icon name="hourglass" size={28} className="animate-pulse text-primary" />
        </div>
      ) : loadError && !board ? (
        <div className="empty-state">
          <Icon name="warning" size={28} className="text-status-danger" />
          <h2 className="empty-t">טעינת הלוח נכשלה</h2>
          <button type="button" className="btn btn-secondary" onClick={refresh}>
            <Icon name="refresh" size={17} /> נסה שוב
          </button>
        </div>
      ) : board ? (
        <DndContext
          sensors={sensors}
          collisionDetection={stableCollision}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
          accessibility={{
            screenReaderInstructions: {
              draggable: "לחץ רווח להרמה, חצים להזזה, רווח לשחרור, Escape לביטול.",
            },
            announcements: {
              onDragStart: ({ active }) => `הרמת את ${taskLabel(String(active.id))}`,
              onDragOver: ({ active, over }) =>
                over ? `${taskLabel(String(active.id))} מעל ${columnLabel(findContainer(String(over.id)) ?? "")}` : "",
              onDragEnd: ({ active, over }) =>
                over ? `${taskLabel(String(active.id))} שובץ אל ${columnLabel(findContainer(String(over.id)) ?? "")}` : "",
              onDragCancel: ({ active }) => `בוטלה גרירת ${taskLabel(String(active.id))}`,
            },
          }}
        >
          <div className="flex flex-col gap-4">
            <UnassignedColumn
              tasks={filteredUnassigned}
              today={today}
              tomorrow={tomorrow}
              scope={scope}
              canManage={canManage}
              onOpen={setEditTask}
              onQuickDone={canManage ? (id) => void quickDone(id, refresh) : undefined}
            />
            <div className="flex flex-row-reverse gap-3 overflow-x-auto pb-2">
              {board.users.map((u) => (
                <UserColumn
                  key={u.id}
                  id={u.id}
                  name={u.name}
                  tasks={filteredByUser[u.id] ?? []}
                  today={today}
                  tomorrow={tomorrow}
                  canManage={canManage}
                  onOpen={setEditTask}
                  onQuickDone={canManage ? (id) => void quickDone(id, refresh) : undefined}
                />
              ))}
              {board.users.length === 0 && (
                <div className="rounded-2xl border-2 border-dashed border-amber-300 bg-amber-50 p-4 text-sm text-amber-700 dark:bg-amber-950/20">
                  אין עובדים פעילים להצגה כעמודות שיבוץ.
                </div>
              )}
            </div>
          </div>

          <DragOverlay
            dropAnimation={
              typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
                ? null
                : { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
            }
          >
            {activeTask ? (
              <TaskCardBody
                task={activeTask}
                today={today}
                tomorrow={tomorrow}
                className="w-[260px] rotate-2 border-2 border-primary shadow-2xl"
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : null}

      {editTask && (
        <EditTaskPanel
          task={editTask}
          users={board?.users ?? []}
          canManage={canManage}
          onClose={() => setEditTask(null)}
          onSaved={() => {
            setEditTask(null);
            refresh();
          }}
        />
      )}
      {showCreate && canManage && (
        <CreateTaskPanel
          scope={scope}
          rooms={board?.rooms ?? []}
          defaultDate={date}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

async function quickDone(taskId: string, refresh: () => void) {
  const res = await setTaskStatusAction(taskId, "completed");
  if (!res.success) toast.error(res.error ?? "העדכון נכשל");
  else {
    toast.success("המשימה הושלמה");
    refresh();
  }
}

// ============================================================
// Header: title tile · day navigation · KPI segmented filter · create
// ============================================================
function BoardHeader({
  scope,
  title,
  date,
  onDate,
  today,
  kpis,
  quickFilter,
  onQuickFilter,
  canManage,
  onCreate,
  onRefresh,
}: {
  scope: Scope;
  title: string;
  date: string;
  onDate: (d: string) => void;
  today: string;
  kpis: { total: number; unassigned: number; dueToday: number; urgent: number };
  quickFilter: null | "unassigned" | "dueToday" | "urgent";
  onQuickFilter: (q: null | "unassigned" | "dueToday" | "urgent") => void;
  canManage: boolean;
  onCreate: () => void;
  onRefresh: () => void;
}) {
  const toggle = (q: "unassigned" | "dueToday" | "urgent") => onQuickFilter(quickFilter === q ? null : q);
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-line bg-primary-050 p-4 sm:p-5">
      <div className="flex flex-row-reverse flex-wrap items-center justify-between gap-3">
        <div className="flex flex-row-reverse items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary text-white">
            <Icon name={SCOPE_ICON[scope]} size={22} />
          </span>
          <h1 className="h1">{title}</h1>
        </div>
        <div className="flex flex-row-reverse flex-wrap items-center gap-2">
          {/* day navigation — chevron-right = previous day in RTL */}
          <button
            type="button"
            className="grid h-11 w-11 place-items-center rounded-xl border border-line bg-surface"
            onClick={() => onDate(shiftIso(date, -1))}
            aria-label="יום קודם"
          >
            <Icon name="chevron-right" size={20} />
          </button>
          <input
            type="date"
            className="input w-[9.5rem]"
            value={date}
            onChange={(e) => onDate(e.target.value || todayIso())}
          />
          <button
            type="button"
            className="grid h-11 w-11 place-items-center rounded-xl border border-line bg-surface"
            onClick={() => onDate(shiftIso(date, 1))}
            aria-label="יום הבא"
          >
            <Icon name="chevron-left" size={20} />
          </button>
          {date !== today && (
            <button type="button" className="btn btn-secondary" onClick={() => onDate(today)}>
              היום
            </button>
          )}
          <button
            type="button"
            className="grid h-11 w-11 place-items-center rounded-xl border border-line bg-surface"
            onClick={onRefresh}
            aria-label="רענון"
          >
            <Icon name="refresh" size={18} />
          </button>
          {canManage && (
            <button type="button" className="btn btn-primary" onClick={onCreate}>
              <Icon name="plus" size={17} />
              משימה חדשה
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-row-reverse flex-wrap items-center gap-2">
        <div className="inline-flex flex-row-reverse gap-1 rounded-xl bg-surface p-1" dir="rtl">
          <FilterPill on={quickFilter === null} onClick={() => onQuickFilter(null)} label="הכל" count={kpis.total} />
          <FilterPill on={quickFilter === "unassigned"} onClick={() => toggle("unassigned")} label="לא משויכים" count={kpis.unassigned} tone="amber" />
          <FilterPill on={quickFilter === "dueToday"} onClick={() => toggle("dueToday")} label="יציאות היום" count={kpis.dueToday} tone="primary" />
          <FilterPill on={quickFilter === "urgent"} onClick={() => toggle("urgent")} label="דחופים" count={kpis.urgent} tone="danger" />
        </div>
      </div>
    </div>
  );
}

function FilterPill({
  on,
  onClick,
  label,
  count,
  tone = "neutral",
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  count: number;
  tone?: "neutral" | "amber" | "primary" | "danger";
}) {
  const toneCls =
    tone === "amber"
      ? "text-amber-700"
      : tone === "danger"
        ? "text-status-danger"
        : tone === "primary"
          ? "text-primary"
          : "text-muted";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
        on ? "bg-primary-050 text-ink shadow-sm" : `${toneCls} hover:bg-hover`
      }`}
    >
      <span>{label}</span>
      <span className="text-xs opacity-80">({count})</span>
    </button>
  );
}

// ============================================================
// Columns
// ============================================================
function UserColumn({
  id,
  name,
  tasks,
  today,
  tomorrow,
  canManage,
  onOpen,
  onQuickDone,
}: {
  id: string;
  name: string;
  tasks: HousekeepingTaskView[];
  today: string;
  tomorrow: string;
  canManage: boolean;
  onOpen: (t: HousekeepingTaskView) => void;
  onQuickDone?: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const urgent = tasks.filter((t) => (t.priority === "high" || (effDate(t) && effDate(t)! < today)) && t.status !== "completed").length;
  const active = tasks.filter((t) => t.status === "in_progress").length;
  return (
    <div className="flex w-[280px] min-w-[280px] shrink-0 flex-col">
      <div className="flex items-center justify-between rounded-t-2xl border-2 border-b-0 border-line bg-surface px-3 py-2.5">
        <div className="flex flex-row-reverse items-center gap-2 text-right">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary-050 text-primary">
            <Icon name="user" size={18} />
          </span>
          <div className="flex flex-col">
            <span className="text-sm font-bold text-ink">{name}</span>
            <span className="text-xs text-faint">
              {urgent > 0 && <span className="text-status-danger">{urgent} דחוף · </span>}
              {active > 0 && <span className="text-emerald-600">{active} בביצוע</span>}
            </span>
          </div>
        </div>
        <span className="flex items-center gap-1 text-sm font-bold text-muted">
          {tasks.length}
          {tasks.length >= 8 && <span className="chip chip-neutral">עמוס</span>}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex min-h-[140px] flex-col gap-2 rounded-b-2xl border-2 border-t-0 border-line p-2.5 transition ${
          isOver ? "bg-primary-050 ring-2 ring-primary/40" : "bg-field"
        }`}
      >
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((t) => (
            <SortableTaskCard
              key={t.id}
              task={t}
              today={today}
              tomorrow={tomorrow}
              draggable={canManage}
              onOpen={onOpen}
              onQuickDone={onQuickDone}
            />
          ))}
        </SortableContext>
        {tasks.length === 0 && (
          <div className="grid flex-1 place-items-center rounded-xl border-2 border-dashed border-line py-6 text-xs text-faint">
            גרור משימה לכאן
          </div>
        )}
      </div>
    </div>
  );
}

function UnassignedColumn({
  tasks,
  today,
  tomorrow,
  scope,
  canManage,
  onOpen,
  onQuickDone,
}: {
  tasks: HousekeepingTaskView[];
  today: string;
  tomorrow: string;
  scope: Scope;
  canManage: boolean;
  onOpen: (t: HousekeepingTaskView) => void;
  onQuickDone?: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: UNASSIGNED_ID });
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between rounded-t-2xl border-2 border-b-0 border-amber-300 bg-amber-50 px-4 py-2.5 dark:bg-amber-950/20">
        <div className="flex flex-row-reverse items-center gap-2">
          <Icon name="person-off" size={18} className="text-amber-700" />
          <span className="text-sm font-bold text-amber-800 dark:text-amber-300">לא משויך</span>
        </div>
        <span className="text-sm font-bold text-amber-700">{tasks.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={`min-h-[120px] rounded-b-2xl border-2 border-t-0 border-amber-300 p-2.5 transition ${
          isOver ? "bg-primary-050 ring-4 ring-primary/40" : "bg-amber-50/40 dark:bg-amber-950/10"
        }`}
      >
        <SortableContext items={tasks.map((t) => t.id)} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            {tasks.map((t) => (
              <SortableTaskCard
                key={t.id}
                task={t}
                today={today}
                tomorrow={tomorrow}
                draggable={canManage}
                onOpen={onOpen}
                onQuickDone={onQuickDone}
              />
            ))}
          </div>
        </SortableContext>
        {tasks.length === 0 && (
          <div className="grid place-items-center rounded-xl border-2 border-dashed border-amber-300 py-6 text-xs text-amber-700">
            {scope === "housekeeping"
              ? "משימות ניקיון לא משויכות יופיעו כאן"
              : "משימות תחזוקה לא משויכות יופיעו כאן"}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Cards
// ============================================================
function SortableTaskCard({
  task,
  today,
  tomorrow,
  draggable,
  onOpen,
  onQuickDone,
}: {
  task: HousekeepingTaskView;
  today: string;
  tomorrow: string;
  draggable: boolean;
  onOpen: (t: HousekeepingTaskView) => void;
  onQuickDone?: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: !draggable,
  });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.3 : 1 };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...(draggable ? listeners : {})}>
      <TaskCardBody
        task={task}
        today={today}
        tomorrow={tomorrow}
        className={draggable ? "cursor-grab active:cursor-grabbing" : ""}
        onOpen={onOpen}
        onQuickDone={onQuickDone}
      />
    </div>
  );
}

function TaskCardBody({
  task,
  today,
  tomorrow,
  className = "",
  onOpen,
  onQuickDone,
}: {
  task: HousekeepingTaskView;
  today: string;
  tomorrow: string;
  className?: string;
  onOpen?: (t: HousekeepingTaskView) => void;
  onQuickDone?: (id: string) => void;
}) {
  const urgency = urgencyOf(task, today, tomorrow);
  const hm = checkoutHM(task);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div
      className={`select-none rounded-xl border border-line bg-surface p-3 shadow-sm transition hover:border-primary/40 hover:shadow-md ${className}`}
      onClick={onOpen ? () => onOpen(task) : undefined}
    >
      <div className="flex flex-row-reverse items-start gap-2">
        <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${URGENCY_DOT[urgency]}`} aria-hidden />
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary-050 text-sm font-bold text-primary">
          {task.roomNumber ?? <Icon name={TYPE_ICON[task.taskType] ?? "list-checks"} size={18} />}
        </span>
        <div className="min-w-0 flex-1 text-right">
          <p className="truncate text-sm font-bold text-ink">{cardTitle(task)}</p>
          <div className="mt-0.5 flex flex-row-reverse flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-xs text-faint">{TYPE_LABEL[task.taskType] ?? task.taskType}</span>
            {urgency === "past" && <span className="text-xs font-bold text-status-danger">דחוף</span>}
            {hm && (
              <span className="text-xs text-primary" dir="ltr">
                יציאה {hm}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="mt-2.5 flex flex-row-reverse items-center justify-between gap-2">
        <span className={`rounded-full border px-2 py-0.5 text-xs font-bold ${STATUS_STYLE[task.status] ?? ""}`}>
          {STATUS_LABEL[task.status] ?? task.status}
        </span>
        {onQuickDone && (task.status === "pending" || task.status === "in_progress") && (
          <button
            type="button"
            className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-50 text-emerald-600 transition hover:bg-emerald-100 dark:bg-emerald-950/20"
            title="סמן כהושלם"
            onPointerDown={stop}
            onTouchStart={stop}
            onKeyDown={stop}
            onClick={(e) => {
              e.stopPropagation();
              onQuickDone(task.id);
            }}
          >
            <Icon name="check-circle" size={18} label="סמן כהושלם" />
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Edit panel
// ============================================================
const EDIT_STATUSES = ["pending", "in_progress", "completed"] as const;

function EditTaskPanel({
  task,
  users,
  canManage,
  onClose,
  onSaved,
}: {
  task: HousekeepingTaskView;
  users: { id: string; name: string }[];
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState(task.status);
  const [assignedTo, setAssignedTo] = useState(task.assignedTo ?? "");
  const [priority, setPriority] = useState<"normal" | "high">(task.priority === "high" ? "high" : "normal");
  const [dueDate, setDueDate] = useState(task.dueDate ?? "");
  const [notes, setNotes] = useState(task.notes ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, start] = useTransition();

  const save = () =>
    start(async () => {
      const ops: Promise<{ success: boolean; error?: string }>[] = [];
      if (status !== task.status) {
        // completed→inspected is the dedicated verification action
        ops.push(status === "inspected" ? inspectTaskAction(task.id) : setTaskStatusAction(task.id, status));
      }
      if ((assignedTo || null) !== (task.assignedTo ?? null)) ops.push(assignTaskAction(task.id, assignedTo || null));
      if (
        priority !== (task.priority === "high" ? "high" : "normal") ||
        (dueDate || null) !== (task.dueDate ?? null) ||
        (notes || null) !== (task.notes ?? null)
      ) {
        ops.push(
          updateTaskAction(task.id, {
            title: task.title,
            roomId: task.roomId,
            priority,
            dueDate: dueDate || null,
            notes: notes.trim() || null,
          }),
        );
      }
      if (ops.length === 0) return onClose();
      const results = await Promise.all(ops);
      const failed = results.find((r) => !r.success);
      if (failed) return void toast.error(failed.error ?? "השמירה נכשלה");
      toast.success("המשימה עודכנה");
      onSaved();
    });

  const remove = () =>
    start(async () => {
      const res = await deleteTaskAction(task.id);
      if (!res.success) return void toast.error(res.error ?? "המחיקה נכשלה");
      toast.success("המשימה נמחקה");
      onSaved();
    });

  const footer = canManage ? (
    <div className="flex flex-row-reverse items-center gap-2">
      <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
        <Icon name="check" size={17} /> שמירה
      </button>
      <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>
        ביטול
      </button>
      <span className="flex-1" />
      {confirmDelete ? (
        <span className="flex flex-row-reverse items-center gap-2">
          <button type="button" className="btn btn-danger" disabled={saving} onClick={remove}>
            אישור מחיקה
          </button>
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => setConfirmDelete(false)}>
            ביטול
          </button>
        </span>
      ) : (
        <button type="button" className="btn btn-danger" disabled={saving} onClick={() => setConfirmDelete(true)}>
          <Icon name="trash" size={17} /> מחיקה
        </button>
      )}
    </div>
  ) : undefined;

  return (
    <SidePanel
      open
      onClose={onClose}
      title={cardTitle(task)}
      subtitle={TYPE_LABEL[task.taskType] ?? task.taskType}
      icon={TYPE_ICON[task.taskType] ?? "list-checks"}
      footer={footer}
    >
      <div className="flex flex-col gap-4">
        {task.roomNumber && (
          <div className="card">
            <div className="card-bd flex flex-row-reverse items-center justify-between">
              <span className="t-label">חדר</span>
              <span className="font-bold text-ink">{task.roomNumber}</span>
            </div>
          </div>
        )}

        <label className="flex flex-col gap-1 text-right">
          <span className="t-label">שיוך</span>
          <select
            className="input"
            value={assignedTo}
            disabled={!canManage}
            onChange={(e) => setAssignedTo(e.target.value)}
          >
            <option value="">לא משויך</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-col gap-1 text-right">
          <span className="t-label">סטטוס</span>
          <div className="flex flex-row-reverse flex-wrap gap-2">
            {EDIT_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                disabled={!canManage}
                onClick={() => setStatus(s)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition ${
                  status === s ? "border-primary bg-primary text-white" : `border-line bg-surface ${STATUS_STYLE[s] ?? ""}`
                }`}
              >
                {STATUS_LABEL[s]}
              </button>
            ))}
            {task.status === "completed" && canManage && (
              <button
                type="button"
                onClick={() => setStatus("inspected")}
                className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition ${
                  status === "inspected" ? "border-primary bg-primary text-white" : "border-line bg-surface text-violet-700"
                }`}
              >
                אישור בדיקה
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-right">
            <span className="t-label">עדיפות</span>
            <select
              className="input"
              value={priority}
              disabled={!canManage}
              onChange={(e) => setPriority(e.target.value as "normal" | "high")}
            >
              <option value="normal">רגיל</option>
              <option value="high">דחוף</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-right">
            <span className="t-label">תאריך יעד</span>
            <input type="date" className="input" value={dueDate} disabled={!canManage} onChange={(e) => setDueDate(e.target.value)} />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-right">
          <span className="t-label">הערות</span>
          <textarea
            className="input min-h-[90px]"
            value={notes}
            disabled={!canManage}
            maxLength={500}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="הערות למשימה…"
          />
        </label>
      </div>
    </SidePanel>
  );
}

// ============================================================
// Create panel
// ============================================================
function CreateTaskPanel({
  scope,
  rooms,
  defaultDate,
  onClose,
  onCreated,
}: {
  scope: Scope;
  rooms: { id: string; roomNumber: string }[];
  defaultDate: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  // the board is type-locked to its scope — a created task is always that type
  const taskType: OperationalTaskType = scope;
  const [roomId, setRoomId] = useState("");
  const [priority, setPriority] = useState<"normal" | "high">("normal");
  const [dueDate, setDueDate] = useState(defaultDate);
  const [notes, setNotes] = useState("");
  const [saving, start] = useTransition();

  const submit = () => {
    if (!title.trim()) return void toast.error("נדרשת כותרת למשימה");
    start(async () => {
      const res = await createOperationalTaskAction({
        taskType,
        title: title.trim(),
        roomId: roomId || null,
        priority,
        dueDate: dueDate || null,
        notes: notes.trim() || null,
      });
      if (!res.success) return void toast.error(res.error ?? "אירעה שגיאה");
      toast.success("המשימה נוצרה");
      onCreated();
    });
  };

  const footer = (
    <div className="flex flex-row-reverse items-center gap-2">
      <button type="button" className="btn btn-primary" disabled={saving} onClick={submit}>
        <Icon name="plus" size={17} /> יצירה
      </button>
      <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>
        ביטול
      </button>
    </div>
  );

  return (
    <SidePanel
      open
      onClose={onClose}
      title="משימה חדשה"
      subtitle={scope === "housekeeping" ? "משימת ניקיון" : "משימת תחזוקה"}
      icon="plus"
      footer={footer}
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-right">
          <span className="t-label">כותרת</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="תיאור המשימה" />
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-right">
            <span className="t-label">חדר (רשות)</span>
            <select className="input" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              <option value="">ללא חדר</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  חדר {r.roomNumber}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-right">
            <span className="t-label">עדיפות</span>
            <select className="input" value={priority} onChange={(e) => setPriority(e.target.value as "normal" | "high")}>
              <option value="normal">רגיל</option>
              <option value="high">דחוף</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-right">
            <span className="t-label">תאריך יעד</span>
            <input type="date" className="input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-right">
          <span className="t-label">הערות (רשות)</span>
          <textarea
            className="input min-h-[80px]"
            value={notes}
            maxLength={500}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="הערות…"
          />
        </label>
      </div>
    </SidePanel>
  );
}
