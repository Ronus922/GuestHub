"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { logoutAction } from "@/lib/auth/actions";
import { getMyTasksAction, advanceMyTaskAction, type HousekeepingTaskView } from "@/lib/housekeeping/actions";

// The cleaner's mobile screen (D88) — a single-column, no-drag worker view, the
// GuestHub twin of the PMS my-tasks screen. One tap advances a task
// (pending → in_progress → completed). Polls every 3s so the manager's
// dispatch board and this screen stay in sync without a manual refresh.

const POLL_MS = 3000;

// generic labels — the screen serves both cleaners and maintenance workers
const STATUS_LABEL: Record<string, string> = {
  pending: "ממתין",
  in_progress: "בביצוע",
  completed: "בוצע",
  inspected: "נבדק",
};
const NEXT_LABEL: Record<string, string> = {
  pending: "התחלת עבודה",
  in_progress: "סיום עבודה",
};
// right-border accent per status (PMS pattern)
const ACCENT: Record<string, string> = {
  pending: "border-r-amber-400",
  in_progress: "border-r-blue-500",
  completed: "border-r-emerald-500",
  inspected: "border-r-violet-500",
};

const checkoutHM = (t: HousekeepingTaskView) =>
  t.checkoutTime ? new Date(t.checkoutTime).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) : null;

export function MyTasksScreen({ initial }: { initial: string }) {
  const [tasks, setTasks] = useState<HousekeepingTaskView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, start] = useTransition();
  const seq = useRef(0);

  const load = useCallback(async () => {
    const s = ++seq.current;
    const res = await getMyTasksAction();
    if (s !== seq.current) return;
    if (res.success) setTasks(res.data ?? []);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const advance = (id: string) =>
    start(async () => {
      setBusyId(id);
      const res = await advanceMyTaskAction(id);
      setBusyId(null);
      if (!res.success) return void toast.error(res.error ?? "העדכון נכשל");
      await load();
    });

  const active = tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
  const done = tasks.filter((t) => t.status === "completed" || t.status === "inspected");

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-appbg">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-primary px-4 py-4 text-white">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-white/20 text-[15px] font-bold">
            {initial}
          </span>
          <div>
            <p className="text-[15px] font-bold">המשימות שלי</p>
            <p className="text-xs text-white/80">
              {active.length} לביצוע · {done.length} הושלמו · מתעדכן אוטומטית
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="grid h-10 w-10 place-items-center rounded-xl bg-white/15 hover:bg-white/25"
            onClick={() => load()}
            aria-label="רענון"
          >
            <Icon name="refresh" size={18} />
          </button>
          <form action={logoutAction}>
            <button
              type="submit"
              className="grid h-10 w-10 place-items-center rounded-xl bg-white/15 hover:bg-white/25"
              aria-label="התנתקות"
            >
              <Icon name="logout" size={18} label="התנתקות" />
            </button>
          </form>
        </div>
      </header>

      {!loaded ? (
        <main className="grid flex-1 place-items-center p-6">
          <Icon name="hourglass" size={26} className="animate-pulse text-primary" />
        </main>
      ) : active.length === 0 && done.length === 0 ? (
        <main className="flex flex-1 items-center justify-center p-6">
          <div className="empty-state max-w-xs">
            <div className="grid h-16 w-16 place-items-center rounded-2xl bg-primary-050">
              <Icon name="cleaning" size={24} className="text-primary" />
            </div>
            <h1 className="empty-t">אין משימות כרגע</h1>
            <p className="empty-s">משימות ניקיון נוצרות אוטומטית עם יציאת אורח ויופיעו כאן.</p>
          </div>
        </main>
      ) : (
        <main className="flex flex-1 flex-col gap-3 p-4">
          {active.map((t, i) => (
            <TaskCard key={t.id} task={t} index={i + 1} total={active.length} busy={busyId === t.id} onAdvance={advance} />
          ))}
          {done.length > 0 && (
            <>
              <div className="mt-2 flex items-center gap-2 text-xs font-semibold text-faint">
                <span className="h-px flex-1 bg-line" />
                הושלמו ({done.length})
                <span className="h-px flex-1 bg-line" />
              </div>
              {done.map((t) => (
                <TaskCard key={t.id} task={t} busy={false} onAdvance={advance} />
              ))}
            </>
          )}
        </main>
      )}
    </div>
  );
}

function TaskCard({
  task,
  index,
  total,
  busy,
  onAdvance,
}: {
  task: HousekeepingTaskView;
  index?: number;
  total?: number;
  busy: boolean;
  onAdvance: (id: string) => void;
}) {
  const hm = checkoutHM(task);
  const isDone = task.status === "completed" || task.status === "inspected";
  return (
    <div
      className={`rounded-[22px] border border-line border-r-4 bg-surface p-5 shadow-sm ${ACCENT[task.status] ?? "border-r-slate-300"} ${
        isDone ? "opacity-70" : ""
      }`}
    >
      <div className="flex flex-row-reverse items-start justify-between gap-3">
        <div className="flex flex-row-reverse items-center gap-3">
          <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-primary-050 text-lg font-bold text-primary">
            {task.roomNumber ?? <Icon name="cleaning" size={26} />}
          </span>
          <div className="text-right">
            <p className="text-base font-bold text-ink">{task.title ?? (task.roomNumber ? `חדר ${task.roomNumber}` : "משימה")}</p>
            <div className="mt-0.5 flex flex-row-reverse items-center gap-2">
              <span className="rounded-lg bg-field px-2 py-0.5 text-xs text-muted">{STATUS_LABEL[task.status] ?? task.status}</span>
              {task.priority === "high" && <span className="text-xs font-bold text-status-danger">דחוף</span>}
              {index && total && <span className="text-xs text-faint">{index}/{total}</span>}
            </div>
          </div>
        </div>
        {hm && (
          <div className="text-center">
            <p className="text-3xl font-extrabold tabular-nums text-primary" dir="ltr">
              {hm}
            </p>
            <p className="text-[11px] text-faint">שעת יציאה</p>
          </div>
        )}
      </div>
      {task.notes && <p className="mt-3 rounded-xl bg-field p-3 text-sm text-muted">{task.notes}</p>}
      {NEXT_LABEL[task.status] && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onAdvance(task.id)}
          className={`mt-4 min-h-[56px] w-full rounded-xl px-4 text-base font-bold text-white disabled:opacity-60 ${
            task.status === "pending" ? "bg-blue-600" : "bg-emerald-600"
          }`}
        >
          {busy ? "מעדכן…" : NEXT_LABEL[task.status]}
        </button>
      )}
    </div>
  );
}
