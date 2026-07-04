"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/shared/Icon";
import type { DateOnly } from "@/lib/dates";
import { RateToolbar } from "./RateToolbar";
import { RateGrid } from "./RateGrid";
import { GroupUpdatePanel } from "./GroupUpdatePanel";
import type { RateCan, RateGridState, RateView } from "./types";

// Page shell: owns view state (type filter, collapsed bands, Group Update panel)
// and composes the toolbar + grid + legend + panel. Data-loading is the server
// view-model (src/lib/rates/grid-state.ts); interaction lives in the children.
export function RateGridScreen({
  state, view, today, can, initialGroupOpen = false,
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

  const navigate = (from: DateOnly, v: RateView) => router.push(`/rates?from=${from}&view=${v}`);
  const visibleTypes = useMemo(
    () => (typeFilter === "all" ? state.types : state.types.filter((t) => (t.roomTypeId ?? "—") === typeFilter)),
    [state.types, typeFilter],
  );
  const allCollapsed = collapsed.size >= state.types.length && state.types.length > 0;
  const toggleCollapse = (tk: string) =>
    setCollapsed((s) => { const n = new Set(s); if (n.has(tk)) n.delete(tk); else n.add(tk); return n; });
  const openGroupUpdate = (preset: string[]) => setGroupUpdate({ open: true, preset });

  return (
    <div className="rg-wrap">
      <RateToolbar
        state={state} view={view} today={today} can={can}
        typeFilter={typeFilter} allCollapsed={allCollapsed}
        onFilter={setTypeFilter}
        onToggleCollapseAll={() => setCollapsed(allCollapsed ? new Set() : new Set(state.types.map((t) => t.roomTypeId ?? "—")))}
        onNavigate={navigate}
        onGroupUpdate={() => openGroupUpdate(state.types.flatMap((t) => t.unitIds))}
      />

      {state.unitCount === 0 ? (
        <div className="rg-card"><div className="rg-empty">לא הוגדרו יחידות מכירה</div></div>
      ) : (
        <RateGrid
          types={visibleTypes} dates={state.dates} today={today} can={can}
          collapsed={collapsed} onToggleCollapse={toggleCollapse} onGroupUpdateForType={openGroupUpdate}
        />
      )}

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="rg-legend">
          <span className="rg-leg"><span className="rg-sw" style={{ background: "#eef1fd" }} />היום</span>
          <span className="rg-leg"><span className="rg-sw" style={{ background: "#eef1fb" }} />סוף שבוע</span>
          <span className="rg-leg"><span className="rg-sw hatch" />לא זמין פיזית</span>
          <span className="rg-leg"><Icon name="circle-slash" size={12} className="text-[#c0455b]" />סגור למכירה</span>
          <span className="rg-leg"><span className="rg-price inherited">₪350</span>מחיר בסיס (מוסק)</span>
        </div>
        <span className="rg-hint">לחיצה על תא לעריכה · Enter לשמירה · Esc לביטול</span>
      </div>

      {groupUpdate.open && (
        <GroupUpdatePanel
          types={state.types} from={state.from} toInclusive={state.toInclusive}
          presetUnitIds={groupUpdate.preset} onClose={() => setGroupUpdate({ open: false, preset: [] })}
        />
      )}
    </div>
  );
}
