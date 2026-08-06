"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { StatusButton } from "@/components/shared/StatusButton";
import { setTaskStatusAction } from "@/lib/housekeeping/actions";
import type { IssueRow } from "../data";

// ============================================================
// iss — תקלות פתוחות. NOT a new table: the design's `maintenance_issues` is
// housekeeping_tasks WHERE task_type='maintenance' (D88) — the same rows the
// /maintenance board manages, so "טופל" here and "completed" there are one
// write (setTaskStatusAction), one audit trail, one screen to build nothing
// twice for.
//
// Priority is the app's real scale — normal|high, no low/med — so only high
// earns the "דחוף" chip. A fixed issue keeps its row for the rest of the day
// (dimmed, with the ✓ chip): vanishing under the operator's hand is the hk
// window's documented trap, honoured here too.
// ============================================================

const isFixed = (s: string) => s === "completed" || s === "inspected";

export function IssuesWindow({ rows }: { rows: IssueRow[] }) {
  const [done, setDone] = useState<Record<string, true>>({});
  const [pending, start] = useTransition();

  const fixed = (r: IssueRow) => isFixed(r.status) || r.taskId in done;

  const markFixed = (r: IssueRow) => {
    setDone((d) => ({ ...d, [r.taskId]: true }));
    start(async () => {
      const res = await setTaskStatusAction(r.taskId, "completed");
      if (res.success) toast.success("התקלה סומנה כטופלה");
      else {
        setDone((d) => {
          const next = { ...d };
          delete next[r.taskId];
          return next;
        });
        toast.error(res.error);
      }
    });
  };

  if (rows.length === 0) {
    return (
      <div className="empty-state empty-sm">
        <span className="empty-t">אין תקלות פתוחות ✓</span>
      </div>
    );
  }

  return (
    <>
      {rows.map((r) => {
        const closed = fixed(r);
        return (
          <div key={r.taskId} className={`hk-row${closed ? " done" : ""}`}>
            <span className={`alr-icon ${closed ? "alr-ok" : r.priority === "high" ? "alr-red" : "alr-amber"}`}>
              <Icon name={closed ? "check-circle" : "maintenance"} size={20} />
            </span>
            <span className="hk-body">
              <span className="hk-title">
                {r.roomNumber ? `חדר ${r.roomNumber} — ` : ""}
                {r.title}
              </span>
              {r.notes && <span className="hk-sub">{r.notes}</span>}
            </span>
            {r.priority === "high" && !closed && <span className="chip chip-approval">דחוף</span>}
            {closed ? (
              <StatusButton state="done" icon="check-circle" label="טופל" />
            ) : (
              <StatusButton
                state="primary"
                label="טופל"
                disabled={pending}
                onClick={() => markFixed(r)}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
