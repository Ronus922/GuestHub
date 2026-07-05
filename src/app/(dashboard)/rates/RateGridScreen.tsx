"use client";

import { useMemo, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Icon } from "@/components/shared/Icon";
import { addYears, clampRatesFrom, RATES_HORIZON_YEARS, type DateOnly } from "@/lib/dates";
import { RateToolbar } from "./RateToolbar";
import { RateGrid } from "./RateGrid";
import { GroupUpdatePanel } from "./GroupUpdatePanel";
import { CellDetailPanel } from "./CellDetailPanel";
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

  // Navigation is clamped to [today, today+horizon] so the grid never opens on a
  // past window (Step 6). horizonLatest bounds the Group Update date pickers.
  const horizonLatest = addYears(today, RATES_HORIZON_YEARS);
  const navigate = (from: DateOnly, v: RateView) =>
    router.push(`/rates?from=${clampRatesFrom(from, today)}&view=${v}`);
  const visibleTypes = useMemo(
    () => (typeFilter === "all" ? state.types : state.types.filter((t) => (t.roomTypeId ?? "—") === typeFilter)),
    [state.types, typeFilter],
  );
  const allCollapsed = collapsed.size >= state.types.length && state.types.length > 0;
  const toggleCollapse = (tk: string) =>
    setCollapsed((s) => { const n = new Set(s); if (n.has(tk)) n.delete(tk); else n.add(tk); return n; });

  // Cell action popover (§8): store only the (unit, date) key so that after a
  // router.refresh() the panel re-reads the FRESH cell from the new server state
  // (never a stale snapshot). Derived each render.
  const [detailKey, setDetailKey] = useState<{ unitId: string; date: DateOnly } | null>(null);
  const detail = useMemo(() => {
    if (!detailKey) return null;
    for (const t of state.types) {
      const u = t.units.find((x) => x.sellableUnitId === detailKey.unitId);
      const c = u?.cells.find((x) => x.date === detailKey.date);
      if (u && c) return { unit: u, cell: c };
    }
    return null;
  }, [detailKey, state.types]);

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
          onOpenDetail={(u, c) => setDetailKey({ unitId: u.sellableUnitId, date: c.date })}
        />
      )}

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="rg-legend">
          <span className="rg-leg"><span className="rg-sw" style={{ background: "#eef1fd" }} />היום</span>
          <span className="rg-leg"><span className="rg-sw" style={{ background: "#eef1fb" }} />סוף שבוע</span>
          <span className="rg-leg"><span className="rg-sw hatch" />לא זמין פיזית</span>
          <span className="rg-leg"><Icon name="circle-slash" size={12} className="text-[#c0455b]" />סגור למכירה (מסחרי)</span>
          <span className="rg-leg"><span className="rg-sw" style={{ background: "#fbeecd", border: "1px solid #f0d9a8" }} />חסר מחיר</span>
          <span className="rg-leg"><Icon name="warning" size={12} className="text-[#c0455b]" />שגיאת מיפוי</span>
          <span className="rg-leg"><span className="rg-price inherited">₪350</span>מחיר בסיס (מוסק)</span>
        </div>
        <span className="rg-hint">לחיצה על תא לעריכה · Enter לשמירה · Esc לביטול</span>
      </div>

      <GroupUpdatePanel
        open={groupOpen}
        types={state.types} from={state.from} toInclusive={state.toInclusive}
        minDate={today} maxDate={horizonLatest}
        presetUnitIds={preset} onClose={closeGroupUpdate}
      />

      <CellDetailPanel
        open={!!detailKey}
        onClose={() => setDetailKey(null)}
        unit={detail?.unit ?? null}
        cell={detail?.cell ?? null}
        today={today}
        editable={can.edit}
      />
    </div>
  );
}
