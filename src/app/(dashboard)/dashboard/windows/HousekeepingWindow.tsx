"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { StatusButton } from "@/components/shared/StatusButton";
import { markTasksCleanAction, setTaskStatusAction } from "@/lib/housekeeping/actions";
import type { HousekeepingRow } from "../data";

// ============================================================
// hk — חדרים לניקיון, עזיבות היום (DeshbordMain.md §4.3).
//
// TWO COLUMN TRAPS the audit records, both honoured in data.ts:
//  · the departure time is the BOOKING's check_out_time (default 11:00), NOT
//    housekeeping_tasks.checkout_time — that column holds now() at the moment
//    the button was pressed, i.e. the operator's click, not the guest's
//    departure (contradiction 9);
//  · "next arrival today" is its own query — no existing one computes it.
//
// "סימון הכל כנקי" is ONE server action over the ids this window is showing,
// not N round-trips. A slow network must not leave a half-cleaned board with no
// way to tell which half landed.
// ============================================================

const isClean = (s: string) => s === "completed" || s === "inspected";

export function HousekeepingWindow({ rows }: { rows: HousekeepingRow[] }) {
  const [done, setDone] = useState<Record<string, string | null>>({});
  const [pending, start] = useTransition();

  const cleaned = (r: HousekeepingRow) => isClean(r.status) || r.taskId in done;
  const dirty = rows.filter((r) => !cleaned(r));

  const markOne = (r: HousekeepingRow) => {
    setDone((d) => ({ ...d, [r.taskId]: r.cleanedByName }));
    start(async () => {
      const res = await setTaskStatusAction(r.taskId, "completed");
      if (res.success) toast.success(`חדר ${r.roomNumber ?? ""} סומן כנקי`);
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

  const markAll = () => {
    const ids = dirty.map((r) => r.taskId);
    if (ids.length === 0) return;
    setDone((d) => ({ ...d, ...Object.fromEntries(dirty.map((r) => [r.taskId, r.cleanedByName])) }));
    start(async () => {
      const res = await markTasksCleanAction(ids);
      if (res.success) toast.success(`${res.count ?? ids.length} חדרים סומנו כנקיים`);
      else {
        setDone((d) => {
          const next = { ...d };
          for (const id of ids) delete next[id];
          return next;
        });
        toast.error(res.error);
      }
    });
  };

  if (rows.length === 0) {
    return (
      <div className="empty-state empty-sm">
        <span className="empty-t">כל החדרים שיצאו היום נוקו ✓</span>
      </div>
    );
  }

  return (
    <>
      <div className="hk-bar">
        <span className="hk-count ltr-num">
          {dirty.length} מלוכלכים מתוך {rows.length}
        </span>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={markAll}
          disabled={pending || dirty.length === 0}
        >
          סימון הכל כנקי
        </button>
      </div>
      {dirty.length === 0 && (
        <div className="empty-state empty-sm">
          <span className="empty-t">כל החדרים שיצאו היום נוקו ✓</span>
        </div>
      )}
      {rows.map((r) => {
        const clean = cleaned(r);
        // the chip names whoever is responsible for the room being clean: the
        // assigned cleaner if there was one, otherwise the person who declared
        // it. setTaskStatusAction now writes that (COALESCE), so the chip is
        // never "נקי · —"; before the round-trip lands we show the bare "נקי".
        const by = r.taskId in done ? done[r.taskId] : r.cleanedByName;
        return (
          <div key={r.taskId} className={`hk-row${clean ? " done" : ""}`}>
            <span className={`hk-icon${clean ? " ok" : ""}`}>
              <Icon name={clean ? "check-circle" : "cleaning"} size={20} />
            </span>
            <span className="hk-body">
              <span className="hk-title">
                חדר {r.roomNumber ?? "—"}
                {r.roomTypeName ? ` — ${r.roomTypeName}` : ""}
              </span>
              <span className="hk-sub">
                יצא {r.guestName ?? "אורח"} ב-<span className="ltr-num">{r.departedAt}</span>
                {r.nextArrival && (
                  <>
                    {" · הגעה הבאה "}
                    <span className="ltr-num">{r.nextArrival}</span>
                  </>
                )}
              </span>
            </span>
            {r.nextArrival && !clean && (
              <span className="chip chip-approval">
                הגעה <span className="ltr-num">{r.nextArrival}</span>
              </span>
            )}
            {clean ? (
              <StatusButton state="done" icon="check-circle" label={by ? `נקי · ${by}` : "נקי"} />
            ) : (
              <StatusButton
                state="primary"
                label="סמן כנקי"
                disabled={pending}
                onClick={() => markOne(r)}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
