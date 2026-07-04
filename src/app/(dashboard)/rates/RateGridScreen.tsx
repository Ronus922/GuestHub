"use client";

import { useMemo, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
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
  state, view, today, can,
}: {
  state: RateGridState;
  view: RateView;
  today: DateOnly;
  can: RateCan;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Group Update open/close is the canonical panel opened over this same grid;
  // its state lives in the URL (?panel=group-update) so the sidebar active
  // highlight, deep-links and Back/Forward all work. from/view are preserved.
  const groupOpen = can.bulk && searchParams.get("panel") === "group-update";
  const [preset, setPreset] = useState<string[]>(() => state.types.flatMap((t) => t.unitIds));
  const panelHref = (open: boolean) => {
    const p = new URLSearchParams(searchParams.toString());
    if (open) p.set("panel", "group-update"); else p.delete("panel");
    const q = p.toString();
    return q ? `${pathname}?${q}` : pathname;
  };
  const openGroupUpdate = (units: string[]) => { setPreset(units); router.push(panelHref(true)); };
  const closeGroupUpdate = () => {
    setPreset(state.types.flatMap((t) => t.unitIds));
    router.push(panelHref(false));
  };

  const navigate = (from: DateOnly, v: RateView) => router.push(`/rates?from=${from}&view=${v}`);
  const visibleTypes = useMemo(
    () => (typeFilter === "all" ? state.types : state.types.filter((t) => (t.roomTypeId ?? "—") === typeFilter)),
    [state.types, typeFilter],
  );
  const allCollapsed = collapsed.size >= state.types.length && state.types.length > 0;
  const toggleCollapse = (tk: string) =>
    setCollapsed((s) => { const n = new Set(s); if (n.has(tk)) n.delete(tk); else n.add(tk); return n; });

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

      <GroupUpdatePanel
        open={groupOpen}
        types={state.types} from={state.from} toInclusive={state.toInclusive}
        presetUnitIds={preset} onClose={closeGroupUpdate}
      />
    </div>
  );
}
