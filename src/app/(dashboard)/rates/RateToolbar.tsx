"use client";

import { Icon } from "@/components/shared/Icon";
import { addDays, HEBREW_MONTHS, type DateOnly } from "@/lib/dates";
import { RATE_VIEW_DAYS, type RateCan, type RateGridState, type RateView } from "./types";

function rangeLabel(from: DateOnly, toInclusive: DateOnly): string {
  const d1 = Number(from.slice(8, 10)), m1 = HEBREW_MONTHS[Number(from.slice(5, 7)) - 1];
  const d2 = Number(toInclusive.slice(8, 10)), m2 = HEBREW_MONTHS[Number(toInclusive.slice(5, 7)) - 1];
  return `${d1} ${m1} – ${d2} ${m2} ${toInclusive.slice(0, 4)}`;
}

// The Rate Grid toolbar: title + summary, primary actions, room-type filters,
// and the date-window navigation (today / prev-next / range / 2w-month).
export function RateToolbar({
  state, view, today, can, typeFilter, allCollapsed,
  onFilter, onToggleCollapseAll, onNavigate, onGroupUpdate,
}: {
  state: RateGridState;
  view: RateView;
  today: DateOnly;
  can: RateCan;
  typeFilter: string;
  allCollapsed: boolean;
  onFilter: (typeKey: string) => void;
  onToggleCollapseAll: () => void;
  onNavigate: (from: DateOnly, view: RateView) => void;
  onGroupUpdate: () => void;
}) {
  const days = RATE_VIEW_DAYS[view];
  // Commercial rates are future-facing: never navigate into a window before
  // tenant-local today (Step 6). The floor is today; prev is disabled there.
  const prevDisabled = state.from <= today;
  return (
    <>
      {/* title row */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="cb-title">רשת תעריפים</h1>
            <span className="cb-count">{state.unitCount} יחידות · {state.typeCount} סוגים</span>
          </div>
          <p className="text-[12.5px] font-medium text-[var(--color-muted)] mt-0.5">
            מחירים ומגבלות לכל יחידת מכירה ותאריך · לחיצה על תא לעריכה מהירה
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="inline-flex items-center gap-2 h-9 px-3.5 rounded-xl border-[1.5px] border-[var(--color-line)] text-[12.5px] font-bold text-[var(--color-faint)] cursor-not-allowed select-none"
            title="אין חיבור ערוצים פעיל · יסונכרן בשלב 4B"
          >
            <Icon name="channels" size={15} />
            סנכרון ערוצים
          </span>
          {can.bulk && (
            <button
              type="button" onClick={onGroupUpdate}
              className="inline-flex items-center gap-2 h-9 px-4 rounded-xl bg-[var(--color-primary)] text-white text-[12.5px] font-bold hover:bg-[var(--color-primary-dark)]"
            >
              <Icon name="bulk-update" size={15} />
              עדכון קבוצתי
            </button>
          )}
        </div>
      </div>

      {/* filters + date nav */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="rg-filters">
          <span className="rg-flabl">סוג יחידה:</span>
          <button className={`rg-chip${typeFilter === "all" ? " on" : ""}`} onClick={() => onFilter("all")}>הכל</button>
          {state.types.map((t) => (
            <button key={t.roomTypeId ?? "—"} className={`rg-chip${typeFilter === (t.roomTypeId ?? "—") ? " on" : ""}`} onClick={() => onFilter(t.roomTypeId ?? "—")}>
              {t.roomTypeName}
            </button>
          ))}
          <button className="rg-chip" onClick={onToggleCollapseAll}>{allCollapsed ? "הרחב הכל" : "כווץ הכל"}</button>
        </div>
        <div className="flex items-center gap-2">
          <div className="cb-seg">
            <button className={view === "2w" ? "on" : ""} onClick={() => onNavigate(state.from, "2w")}>שבועיים</button>
            <button className={view === "month" ? "on" : ""} onClick={() => onNavigate(state.from, "month")}>חודש</button>
          </div>
          <div className="cb-rangebox">
            <button className="cb-nav" onClick={() => onNavigate(addDays(state.from, -days), view)} disabled={prevDisabled} aria-label="הקודם" title={prevDisabled ? "לא ניתן לנווט לתאריכים שעברו" : undefined}><Icon name="chevron-right" size={18} /></button>
            <span className="cb-rl">{rangeLabel(state.from, state.toInclusive)}</span>
            <button className="cb-nav" onClick={() => onNavigate(addDays(state.from, days), view)} aria-label="הבא"><Icon name="chevron-left" size={18} /></button>
          </div>
          <button className="cb-todaybtn" onClick={() => onNavigate(today, view)}>היום</button>
        </div>
      </div>
    </>
  );
}
