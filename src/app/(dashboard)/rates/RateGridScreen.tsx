"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/shared/Icon";
import { addDays, HEBREW_MONTHS, type DateOnly } from "@/lib/dates";
import { RateGrid } from "./RateGrid";
import { GroupUpdatePanel } from "./GroupUpdatePanel";
import { RATE_VIEW_DAYS, type RateCan, type RateGridState, type RateView } from "./types";

function rangeLabel(from: DateOnly, toInclusive: DateOnly): string {
  const d1 = Number(from.slice(8, 10)), m1 = HEBREW_MONTHS[Number(from.slice(5, 7)) - 1];
  const d2 = Number(toInclusive.slice(8, 10)), m2 = HEBREW_MONTHS[Number(toInclusive.slice(5, 7)) - 1];
  const y = toInclusive.slice(0, 4);
  return `${d1} ${m1} – ${d2} ${m2} ${y}`;
}

export function RateGridScreen({
  state,
  view,
  today,
  can,
  initialGroupOpen = false,
}: {
  state: RateGridState;
  view: RateView;
  today: DateOnly;
  can: RateCan;
  initialGroupOpen?: boolean;
}) {
  const router = useRouter();
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [groupUpdate, setGroupUpdate] = useState<{ open: boolean; preset: string[] }>({
    open: initialGroupOpen,
    preset: initialGroupOpen ? state.types.flatMap((t) => t.unitIds) : [],
  });

  const go = (from: DateOnly, v: RateView) => router.push(`/rates?from=${from}&view=${v}`);
  const days = RATE_VIEW_DAYS[view];

  const visibleTypes = useMemo(
    () => (typeFilter === "all" ? state.types : state.types.filter((t) => (t.roomTypeId ?? "—") === typeFilter)),
    [state.types, typeFilter],
  );

  const allCollapsed = collapsed.size >= state.types.length && state.types.length > 0;
  const toggleCollapse = (tk: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(tk)) n.delete(tk);
      else n.add(tk);
      return n;
    });

  const openGroupUpdate = (preset: string[]) => setGroupUpdate({ open: true, preset });

  return (
    <div className="rg-wrap">
      {/* ---------- toolbar ---------- */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="cb-title">רשת תעריפים</h1>
            <span className="cb-count">{state.unitCount} יחידות · {state.typeCount} סוגים</span>
          </div>
          <p className="text-[13px] font-medium text-[var(--color-muted)] mt-1">
            מחירים ומגבלות לכל יחידת מכירה ותאריך · לחיצה על תא לעריכה מהירה
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* channel-sync placeholder — NO Channex connection yet (Phase 4B) */}
          <span
            className="inline-flex items-center gap-2 h-10 px-4 rounded-xl border-[1.5px] border-[#e4e8f0] text-[13px] font-bold text-[var(--color-faint)] cursor-not-allowed select-none"
            title="אין חיבור ערוצים פעיל · יסונכרן בשלב 4B"
          >
            <Icon name="channels" size={16} />
            סנכרון ערוצים
          </span>
          {can.bulk && (
            <button
              type="button"
              onClick={() => openGroupUpdate(state.types.flatMap((t) => t.unitIds))}
              className="inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-[var(--color-primary)] text-white text-[13px] font-bold hover:bg-[var(--color-primary-dark)]"
            >
              <Icon name="bulk-update" size={16} />
              עדכון קבוצתי
            </button>
          )}
        </div>
      </div>

      {/* ---------- date nav + filters ---------- */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="rg-filters">
          <button className={`rg-chip${typeFilter === "all" ? " on" : ""}`} onClick={() => setTypeFilter("all")}>הכל</button>
          {state.types.map((t) => (
            <button
              key={t.roomTypeId ?? "—"}
              className={`rg-chip${typeFilter === (t.roomTypeId ?? "—") ? " on" : ""}`}
              onClick={() => setTypeFilter(t.roomTypeId ?? "—")}
            >
              {t.roomTypeName}
            </button>
          ))}
          <button
            className="rg-chip"
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(state.types.map((t) => t.roomTypeId ?? "—")))}
          >
            {allCollapsed ? "הרחב הכל" : "כווץ הכל"}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <div className="cb-seg">
            <button className={view === "2w" ? "on" : ""} onClick={() => go(state.from, "2w")}>שבועיים</button>
            <button className={view === "month" ? "on" : ""} onClick={() => go(state.from, "month")}>חודש</button>
          </div>
          <div className="cb-rangebox">
            <button className="cb-nav" onClick={() => go(addDays(state.from, -days), view)} aria-label="הקודם">
              <Icon name="chevron-right" size={18} />
            </button>
            <span className="cb-rl">{rangeLabel(state.from, state.toInclusive)}</span>
            <button className="cb-nav" onClick={() => go(addDays(state.from, days), view)} aria-label="הבא">
              <Icon name="chevron-left" size={18} />
            </button>
          </div>
          <button className="cb-todaybtn" onClick={() => go(today, view)}>היום</button>
        </div>
      </div>

      {/* ---------- grid ---------- */}
      {state.unitCount === 0 ? (
        <div className="rg-card"><div className="rg-empty">לא הוגדרו יחידות מכירה</div></div>
      ) : (
        <RateGrid
          types={visibleTypes}
          dates={state.dates}
          today={today}
          can={can}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapse}
          onGroupUpdateForType={openGroupUpdate}
        />
      )}

      {/* ---------- legend + hint ---------- */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="rg-legend">
          <span className="rg-leg"><span className="rg-sw" style={{ background: "#eef1fd" }} />היום</span>
          <span className="rg-leg"><span className="rg-sw" style={{ background: "#fbf6e7" }} />סוף שבוע</span>
          <span className="rg-leg"><span className="rg-sw hatch" />לא זמין פיזית</span>
          <span className="rg-leg"><Icon name="circle-slash" size={13} className="text-[#c0455b]" />סגור למכירה</span>
          <span className="rg-leg"><span className="rg-price inherited">350</span>מחיר בסיס (מוסק)</span>
        </div>
        <span className="rg-hint">לחיצה על תא לעריכה · Enter לשמירה · Esc לביטול</span>
      </div>

      {groupUpdate.open && (
        <GroupUpdatePanel
          types={state.types}
          from={state.from}
          toInclusive={state.toInclusive}
          presetUnitIds={groupUpdate.preset}
          onClose={() => setGroupUpdate({ open: false, preset: [] })}
        />
      )}
    </div>
  );
}
