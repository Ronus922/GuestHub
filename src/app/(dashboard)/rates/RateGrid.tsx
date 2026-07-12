"use client";

import { Fragment, useCallback, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/shared/Icon";
import { dayOfWeek, HEBREW_DAY_LETTERS, hebrewMonthYear, type DateOnly } from "@/lib/dates";
import { upsertRateCellAction } from "./actions";
import type { RateCan, RateCellState, RateGridType, RateGridUnit } from "./types";
import { BoolCell, CellTip, MetricCell, PriceCell, StopSellCell, type BoolField, type CellCtx, type ColGeom, type NumField } from "./RateCells";

const LABEL_W = 224;
const MIN_COL = 46;

// The six restriction rows under each SU price row (reference order).
type MetricDef =
  | { field: NumField; kind: "num"; label: string; tag: string }
  | { field: BoolField; kind: "bool"; label: string; tag: string };
const METRICS: MetricDef[] = [
  { field: "minStayThrough", kind: "num", label: "מינימום לילות", tag: "MIN" },
  { field: "maxStay", kind: "num", label: "מקסימום לילות", tag: "MAX" },
  { field: "minStayArrival", kind: "num", label: "מ׳ לילות בהגעה", tag: "MIN LOS" },
  { field: "closedToArrival", kind: "bool", label: "סגור להגעה", tag: "CTA" },
  { field: "closedToDeparture", kind: "bool", label: "סגור לעזיבה", tag: "CTD" },
  { field: "stopSell", kind: "bool", label: "סגור למכירה", tag: "" },
];

type CellPatch = {
  price?: number | null; minStayThrough?: number | null; maxStay?: number | null;
  minStayArrival?: number | null; closedToArrival?: boolean; closedToDeparture?: boolean; stopSell?: boolean;
};
const cellKey = (u: string, d: string, f: string) => `${u}|${d}|${f}`;

export function RateGrid({
  types, dates, today, can, collapsed, onToggleCollapse, onGroupUpdateForType, onOpenDetail, onSaved,
}: {
  types: RateGridType[];
  dates: DateOnly[];
  today: DateOnly;
  can: RateCan;
  collapsed: Set<string>;
  onToggleCollapse: (typeKey: string) => void;
  onGroupUpdateForType: (unitIds: string[]) => void;
  onOpenDetail: (unit: RateGridUnit, cell: RateCellState) => void;
  onSaved: () => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<{ unitId: string; field: string; date: DateOnly } | null>(null);
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [tip, setTip] = useState<{ x: number; y: number; unit: RateGridUnit; cell: RateCellState } | null>(null);

  // day-column geometry (weekend Fri/Sat, today, month boundaries) + month bands
  const cols: ColGeom[] = dates.map((d, i) => {
    const dow = dayOfWeek(d);
    return { date: d, weekend: dow === 5 || dow === 6, today: d === today, monthStart: i > 0 && d.slice(0, 7) !== dates[i - 1].slice(0, 7) };
  });
  const bands: { label: string; span: number }[] = [];
  for (const d of dates) {
    const label = hebrewMonthYear(d);
    const last = bands[bands.length - 1];
    if (last && last.label === label) last.span++;
    else bands.push({ label, span: 1 });
  }
  const dw = (d: DateOnly) => HEBREW_DAY_LETTERS[(dayOfWeek(d) + 6) % 7];

  const submit = useCallback(async (unit: RateGridUnit, date: DateOnly, patch: CellPatch) => {
    const k = cellKey(unit.sellableUnitId, date, Object.keys(patch)[0]);
    setSaving((s) => new Set(s).add(k));
    setEditing(null);
    const res = await upsertRateCellAction({ sellableUnitId: unit.sellableUnitId, pricingPlanId: unit.pricingPlanId ?? undefined, date, patch });
    setSaving((s) => { const n = new Set(s); n.delete(k); return n; });
    if (res.success) { onSaved(); router.refresh(); }
    else if (res.error) window.alert(res.error);
  }, [router, onSaved]);

  const ctx: CellCtx = {
    editable: can.edit,
    editing,
    saving,
    key: cellKey,
    startEdit: (unitId, field, date) => setEditing({ unitId, field, date }),
    cancel: () => setEditing(null),
    commitNumber: (unit, field, date, raw) => {
      const t = raw.trim();
      const value = t === "" ? null : Number(t);
      if (value !== null && (Number.isNaN(value) || value < 0)) { setEditing(null); return; }
      void submit(unit, date, { [field]: value } as CellPatch);
    },
    toggleBool: (unit, field, date, current) => void submit(unit, date, { [field]: !current } as CellPatch),
    setBool: (unit, field, date, value) => void submit(unit, date, { [field]: value } as CellPatch),
    openDetail: (unit, cell) => { setTip(null); onOpenDetail(unit, cell); },
    hover: (e, unit, cell) => setTip({ x: e.clientX, y: e.clientY, unit, cell }),
    leave: () => setTip(null),
  };

  const gridStyle = { minWidth: LABEL_W + dates.length * MIN_COL, "--rg-label": `${LABEL_W}px` } as CSSProperties;

  return (
    <div className="card rg-card">
      <div className="rg-scroll">
        <div className="rg-grid" style={gridStyle}>
          {/* sticky header */}
          <div className="rg-head">
            <div className="rg-row rg-mrow">
              <div className="rg-lab" />
              <div className="rg-cells">
                {bands.map((b, i) => (
                  <div className="rg-mseg" key={i} style={{ flexGrow: b.span }}><span>{b.label}</span></div>
                ))}
              </div>
            </div>
            <div className="rg-row rg-drow">
              <div className="rg-lab"><span className="rg-htitle">יחידות מכירה</span><span className="rg-hsub">{dates.length} ימים</span></div>
              <div className="rg-cells">
                {cols.map((c) => (
                  <div className={`rg-dcell${c.weekend ? " we" : ""}${c.today ? " td" : ""}${c.monthStart ? " ms" : ""}`} key={c.date}>
                    <span className="rg-dw">{dw(c.date)}</span>
                    <span className="rg-dn">{Number(c.date.slice(8, 10))}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* type bands */}
          {types.map((band) => {
            const tk = band.roomTypeId ?? "—";
            const isCollapsed = collapsed.has(tk);
            return (
              <Fragment key={tk}>
                <div className="rg-row rg-band">
                  <div className="rg-lab">
                    <button type="button" className="rg-collapse" onClick={() => onToggleCollapse(tk)} aria-label={isCollapsed ? "הרחב" : "כווץ"}>
                      <Icon name={isCollapsed ? "chevron-left" : "chevron"} size={17} />
                    </button>
                    <span className="rg-tname">{band.roomTypeName}</span>
                    <span className="rg-tcount">· {band.units.length} יחידות</span>
                  </div>
                  <div className="rg-bandinfo">
                    <span className="rg-tbase">מחיר בסיס <b>₪{Math.round(band.basePrice)}</b></span>
                    {can.bulk && (
                      <button type="button" className="rg-tlink" onClick={() => onGroupUpdateForType(band.unitIds)}>
                        <Icon name="bulk-update" size={13.5} />עדכון קבוצתי לסוג
                      </button>
                    )}
                  </div>
                </div>

                {!isCollapsed && band.units.map((unit) => (
                  <div className="rg-unit" key={unit.sellableUnitId}>
                    {/* price row */}
                    <div className="rg-row rg-prow">
                      <div className="rg-lab">
                        <span className="rg-unum">{unit.code}</span>
                        <span className="rg-utype">{unit.roomTypeName}</span>
                        {/* dense-grid internal annotations — NOT chips (coordinator
                            ruling): plain 12px/700 text labels (§12.2-class dense
                            exception), so they can never overflow the 224px sticky
                            label column the way 28px .chip elements did */}
                        {(unit.isPooled || unit.closedCount > 0 || !unit.hasBasePlan) && (
                          <span className="rg-utags">
                            {unit.isPooled && <span className="rg-utag">מאגר · {unit.roomCount}</span>}
                            {unit.closedCount > 0 && <span className="rg-utag closed">{unit.closedCount} סגורים</span>}
                            {!unit.hasBasePlan && <span className="rg-utag noplan">ללא תוכנית</span>}
                          </span>
                        )}
                      </div>
                      <div className="rg-cells">
                        {unit.cells.map((cell, i) => <PriceCell key={cell.date} unit={unit} cell={cell} col={cols[i]} ctx={ctx} />)}
                      </div>
                    </div>
                    {/* six restriction rows */}
                    {METRICS.map((m) => (
                      <div className="rg-row rg-mrow2" key={m.field}>
                        <div className="rg-lab"><span className="rg-mname">{m.label}</span>{m.tag && <span className="rg-mtag">{m.tag}</span>}</div>
                        <div className="rg-cells">
                          {unit.cells.map((cell, i) =>
                            m.kind === "num"
                              ? <MetricCell key={cell.date} unit={unit} cell={cell} col={cols[i]} field={m.field} ctx={ctx} />
                              : m.field === "stopSell"
                                ? <StopSellCell key={cell.date} unit={unit} cell={cell} col={cols[i]} ctx={ctx} />
                                : <BoolCell key={cell.date} unit={unit} cell={cell} col={cols[i]} field={m.field} ctx={ctx} />,
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </Fragment>
            );
          })}
        </div>
      </div>
      {tip && <CellTip x={tip.x} y={tip.y} unit={tip.unit} cell={tip.cell} />}
    </div>
  );
}
