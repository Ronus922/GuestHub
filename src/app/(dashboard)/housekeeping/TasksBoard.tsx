"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import type { HousekeepingTaskView, OperationalTaskType } from "@/lib/housekeeping/actions";
import {
  assignTaskAction,
  inspectTaskAction,
  createOperationalTaskAction,
} from "@/lib/housekeeping/actions";
import type { AssignableUser, RoomOption } from "./data";

// Manager task board. Shared by /housekeeping (scope="housekeeping" — the cleaning
// queue, type locked) and /tasks (scope="all" — every operational task, with a
// type filter + free type on create). All mutations go through the existing
// housekeeping Server Actions; the board only reads + refreshes.

type Scope = "housekeeping" | "all";

const TYPE_LABEL: Record<string, string> = {
  housekeeping: "ניקיון",
  maintenance: "תחזוקה",
  general: "כללי",
};
const STATUS_LABEL: Record<string, string> = {
  pending: "ממתין",
  in_progress: "בביצוע",
  completed: "הושלם",
  inspected: "נבדק",
};
// named-palette only (design-system gate allows Tailwind palette, not raw hex)
const STATUS_STYLE: Record<string, string> = {
  pending: "bg-slate-100 text-slate-700",
  in_progress: "bg-amber-50 text-amber-700",
  completed: "bg-emerald-50 text-emerald-700",
  inspected: "bg-blue-50 text-blue-700",
};

const STATUS_FILTERS = ["all", "pending", "in_progress", "completed"] as const;

export function TasksBoard({
  scope,
  tasks,
  users,
  rooms,
  canManage,
}: {
  scope: Scope;
  tasks: HousekeepingTaskView[];
  users: AssignableUser[];
  rooms: RoomOption[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [showCreate, setShowCreate] = useState(false);

  const scoped = useMemo(
    () => (scope === "housekeeping" ? tasks.filter((t) => t.taskType === "housekeeping") : tasks),
    [scope, tasks],
  );
  const filtered = useMemo(
    () =>
      scoped.filter(
        (t) =>
          (statusFilter === "all" || t.status === statusFilter) &&
          (scope === "housekeeping" || typeFilter === "all" || t.taskType === typeFilter),
      ),
    [scoped, statusFilter, typeFilter, scope],
  );

  function run(fn: () => Promise<{ success: boolean; error?: string }>, ok: string) {
    start(async () => {
      const res = await fn();
      if (!res.success) return void toast.error(res.error ?? "אירעה שגיאה");
      toast.success(ok);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-row-reverse flex-wrap items-center justify-between gap-3">
        <div className="flex flex-row-reverse flex-wrap items-center gap-2">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`chip clickable ${statusFilter === s ? "on" : ""}`}
            >
              {s === "all" ? "הכל" : STATUS_LABEL[s]}
            </button>
          ))}
          {scope === "all" &&
            ["all", "housekeeping", "maintenance", "general"].map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTypeFilter(t)}
                className={`chip chip-neutral clickable ${typeFilter === t ? "on" : ""}`}
              >
                {t === "all" ? "כל הסוגים" : TYPE_LABEL[t]}
              </button>
            ))}
        </div>
        {canManage && (
          <button type="button" className="btn btn-primary" onClick={() => setShowCreate((v) => !v)}>
            <Icon name="plus" size={17} />
            משימה חדשה
          </button>
        )}
      </div>

      {showCreate && canManage && (
        <CreateTaskForm
          scope={scope}
          rooms={rooms}
          disabled={pending}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            router.refresh();
          }}
        />
      )}

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="grid h-16 w-16 place-items-center rounded-2xl bg-primary-050">
            <Icon name={scope === "housekeeping" ? "cleaning" : "my-requests"} size={24} className="text-primary" />
          </div>
          <h2 className="empty-t">אין משימות</h2>
          <p className="empty-s">
            {scope === "housekeeping"
              ? "משימות ניקיון נוצרות אוטומטית עם יציאת אורח."
              : "אין משימות פתוחות בסינון הנוכחי."}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((t) => (
            <div key={t.id} className="card">
              <div className="card-bd flex flex-col gap-3">
                <div className="flex flex-row-reverse flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-col gap-1 text-right">
                    <span className="h4">{t.title ?? (t.roomNumber ? `חדר ${t.roomNumber}` : "משימה")}</span>
                    <div className="flex flex-row-reverse flex-wrap items-center gap-2">
                      <span className="chip chip-neutral">{TYPE_LABEL[t.taskType] ?? t.taskType}</span>
                      {t.roomNumber && <span className="t-label text-faint">חדר {t.roomNumber}</span>}
                      {t.priority === "high" && <span className="t-label text-status-danger">דחוף</span>}
                    </div>
                    {t.notes && <p className="t-secondary">{t.notes}</p>}
                  </div>
                  <span className={`rounded-lg px-3 py-1 text-sm ${STATUS_STYLE[t.status] ?? "bg-slate-100 text-slate-700"}`}>
                    {STATUS_LABEL[t.status] ?? t.status}
                  </span>
                </div>

                {canManage && (
                  <div className="flex flex-row-reverse flex-wrap items-center gap-2">
                    {(t.status === "pending" || t.status === "in_progress") && (
                      <select
                        className="input max-w-[16rem]"
                        value={t.assignedTo ?? ""}
                        disabled={pending}
                        onChange={(e) =>
                          run(() => assignTaskAction(t.id, e.target.value || null), "המשימה שויכה")
                        }
                      >
                        <option value="">לא משויך</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {t.status === "completed" && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={pending}
                        onClick={() => run(() => inspectTaskAction(t.id), "המשימה אושרה")}
                      >
                        <Icon name="check" size={17} />
                        אישור בדיקה
                      </button>
                    )}
                    {t.assignedToName && t.status !== "completed" && (
                      <span className="t-label text-faint">אחראי: {t.assignedToName}</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateTaskForm({
  scope,
  rooms,
  disabled,
  onClose,
  onCreated,
}: {
  scope: Scope;
  rooms: RoomOption[];
  disabled: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [saving, start] = useTransition();
  const [title, setTitle] = useState("");
  const [taskType, setTaskType] = useState<OperationalTaskType>(scope === "housekeeping" ? "housekeeping" : "general");
  const [roomId, setRoomId] = useState("");
  const [priority, setPriority] = useState<"normal" | "high">("normal");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");

  function submit() {
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
  }

  return (
    <div className="card">
      <div className="card-bd flex flex-col gap-3">
        <div className="flex flex-row-reverse items-center justify-between">
          <h3 className="h4">משימה חדשה</h3>
          <button type="button" className="icon-btn" onClick={onClose}>
            <Icon name="close" size={20} label="סגירה" />
          </button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-right sm:col-span-2">
            <span className="t-label">כותרת</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="תיאור המשימה" />
          </label>
          {scope === "all" && (
            <label className="flex flex-col gap-1 text-right">
              <span className="t-label">סוג</span>
              <select className="input" value={taskType} onChange={(e) => setTaskType(e.target.value as OperationalTaskType)}>
                <option value="general">כללי</option>
                <option value="housekeeping">ניקיון</option>
                <option value="maintenance">תחזוקה</option>
              </select>
            </label>
          )}
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
            <span className="t-label">תאריך יעד (רשות)</span>
            <input type="date" className="input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-right sm:col-span-2">
            <span className="t-label">הערות (רשות)</span>
            <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>
        <div className="flex flex-row-reverse gap-2">
          <button type="button" className="btn btn-primary" disabled={saving || disabled} onClick={submit}>
            יצירה
          </button>
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>
            ביטול
          </button>
        </div>
      </div>
    </div>
  );
}
