"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@/components/shared/Icon";
import { addYears, clampRatesFrom, RATES_HORIZON_YEARS, type DateOnly } from "@/lib/dates";
import type { RatesSyncStatus } from "@/lib/channel/sync-state";
import { RateToolbar } from "./RateToolbar";
import { RateGrid } from "./RateGrid";
import { GroupUpdatePanel } from "./GroupUpdatePanel";
import { CellDetailPanel } from "./CellDetailPanel";
import type { RateCan, RateGridState, RateView } from "./types";

// Page shell: owns view state (type filter, collapsed bands, Group Update panel)
// and composes the toolbar + grid + legend + panel. Data-loading is the server
// view-model (src/lib/rates/grid-state.ts); interaction lives in the children.
export function RateGridScreen({
  state, view, today, can, syncStatus,
}: {
  state: RateGridState;
  view: RateView;
  today: DateOnly;
  can: RateCan;
  syncStatus: RatesSyncStatus;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Every successful canonical save on this screen bumps the pulse; the sync
  // control refetches the persisted status and narrates it (Phase 5 feedback).
  const [savePulse, setSavePulse] = useState(0);
  const onSaved = useCallback(() => setSavePulse((p) => p + 1), []);
  // Group Update is an in-page surface. Local state deliberately keeps opening,
  // closing and browser Back independent from routing, so the mounted grid keeps
  // filters, disclosures, scroll position and pending cell UI intact.
  const [groupOpen, setGroupOpen] = useState(false);
  const [preset, setPreset] = useState<string[]>(() => state.types.flatMap((t) => t.unitIds));
  const openGroupUpdate = (units: string[]) => { setPreset(units); setGroupOpen(true); };
  const closeGroupUpdate = () => {
    setGroupOpen(false);
    setPreset(state.types.flatMap((t) => t.unitIds));
  };

  // Backward compatibility only: old links used panel/group query keys. Strip
  // those keys without opening anything and without a Next navigation. Legitimate
  // date/view parameters remain byte-for-byte represented by URLSearchParams.
  const query = searchParams.toString();
  useEffect(() => {
    const params = new URLSearchParams(query);
    const hadLegacyPanel = params.has("panel") || params.has("group");
    if (!hadLegacyPanel) return;
    params.delete("panel");
    params.delete("group");
    const cleanQuery = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      cleanQuery ? `/rates?${cleanQuery}` : "/rates",
    );
  }, [query]);

  // Navigation is clamped to [today, today+horizon] so the grid never opens on a
  // past window (Step 6). horizonLatest bounds the Group Update date pickers.
  const horizonLatest = addYears(today, RATES_HORIZON_YEARS);
  const navigate = (from: DateOnly, v: RateView) =>
    router.push(`/rates?from=${clampRatesFrom(from, today)}&view=${v}`);
  const visibleTypes = useMemo(
    () => (typeFilter === "all" ? state.types : state.types.filter((t) => (t.roomTypeId ?? "—") === typeFilter)),
    [state.types, typeFilter],
  );
  // Collapse is per ROOM (reference: "לחיצה על שורת חדר פותחת מגבלות") — a room
  // row hides/shows its own six restriction rows. The toolbar's "כווץ הכול"
  // drives the same set, so one control and one state, never two.
  //
  // It is scoped to the rooms ON THE BOARD (visibleTypes), not to every room:
  // derived from all of them, the control lied under an active type filter —
  // with every visible room collapsed it still read "כווץ הכול", and pressing it
  // collapsed the hidden rooms too, so expanding what you could see took two
  // presses. What the button says must be true of what you are looking at.
  const visibleUnitIds = useMemo(() => visibleTypes.flatMap((t) => t.unitIds), [visibleTypes]);
  const allCollapsed =
    visibleUnitIds.length > 0 && visibleUnitIds.every((id) => collapsed.has(id));
  // collapse/expand only what is on the board; rooms hidden by the filter keep
  // whatever state they had, so switching filters never surprises you.
  const toggleCollapseAll = () =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (allCollapsed) visibleUnitIds.forEach((id) => n.delete(id));
      else visibleUnitIds.forEach((id) => n.add(id));
      return n;
    });
  // Group Update keeps its existing scope (every room, not just the filtered
  // view) — that is pre-existing behaviour and out of a visual redesign's remit.
  const allUnitIds = useMemo(() => state.types.flatMap((t) => t.unitIds), [state.types]);
  const toggleCollapse = (unitId: string) =>
    setCollapsed((s) => { const n = new Set(s); if (n.has(unitId)) n.delete(unitId); else n.add(unitId); return n; });

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

  // The legend is the board card's FOOTER (reference). It documents every state
  // the grid can actually paint — the reference mock shows only 5 because its
  // demo data never produces the physical / no-price / mapping-error cells.
  const legend = (
    <>
      <span className="rg-leg"><span className="rg-sw today" />היום</span>
      <span className="rg-leg"><span className="rg-sw we" />סוף שבוע</span>
      <span className="rg-leg"><span className="rg-sw hatch" />לא זמין פיזית</span>
      <span className="rg-leg"><Icon name="circle-slash" size={13.5} className="rg-err" />סגור למכירה (מסחרי)</span>
      <span className="rg-leg"><span className="rg-sw noprice" />חסר מחיר</span>
      <span className="rg-leg"><Icon name="warning" size={13.5} className="rg-err" />שגיאת מיפוי</span>
      <span className="rg-leg"><span className="rg-price inherited ltr-num">₪350</span>מחיר בסיס (מוסק)</span>
      <span className="rg-hint">לחיצה על שורת חדר פותחת מגבלות · Enter לשמירה, Esc לביטול</span>
    </>
  );

  return (
    <div className="rg-wrap">
      <RateToolbar
        state={state} view={view} today={today} can={can}
        typeFilter={typeFilter} allCollapsed={allCollapsed}
        syncStatus={syncStatus} savePulse={savePulse}
        onFilter={setTypeFilter}
        onToggleCollapseAll={toggleCollapseAll}
        onNavigate={navigate}
        onGroupUpdate={() => openGroupUpdate(allUnitIds)}
      />

      {state.unitCount === 0 ? (
        <div className="card rg-card"><div className="empty-state"><span className="empty-t">לא הוגדרו חדרים</span></div></div>
      ) : (
        <RateGrid
          types={visibleTypes} dates={state.dates} today={today} can={can}
          collapsed={collapsed} legend={legend}
          onToggleCollapse={toggleCollapse} onGroupUpdateForType={openGroupUpdate}
          onOpenDetail={(u, c) => setDetailKey({ unitId: u.sellableUnitId, date: c.date })}
          onSaved={onSaved}
        />
      )}

      <GroupUpdatePanel
        open={groupOpen}
        types={state.types} from={state.from} toInclusive={state.toInclusive}
        minDate={today} maxDate={horizonLatest}
        presetUnitIds={preset} onClose={closeGroupUpdate}
        onSaved={onSaved}
      />

      <CellDetailPanel
        open={!!detailKey}
        onClose={() => setDetailKey(null)}
        unit={detail?.unit ?? null}
        cell={detail?.cell ?? null}
        today={today}
        editable={can.edit}
        onSaved={onSaved}
      />
    </div>
  );
}
