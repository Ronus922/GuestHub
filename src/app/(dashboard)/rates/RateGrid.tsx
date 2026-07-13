"use client";

import { Fragment, useCallback, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/shared/Icon";
import { dayOfWeek, HEBREW_DAY_LETTERS, hebrewMonthYear, type DateOnly } from "@/lib/dates";
import { compareRoomNumber } from "@/lib/rooms/sort";
import { upsertRateCellAction } from "./actions";
import type { RateCan, RateCellState, RateGridType, RateGridUnit } from "./types";
import { BoolCell, CellTip, MetricCell, PriceCell, StopSellCell, type BoolField, type CellCtx, type ColGeom, type NumField } from "./RateCells";

// The six restriction rows under each room price row (reference order).
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
  types, dates, today, can, collapsed, legend, onToggleCollapse, onOpenDetail, onSaved,
}: {
  /** the room-type bands are still the DATA shape; the board renders one flat,
      ascending room list out of them (no per-type grouping row) */
  types: RateGridType[];
  dates: DateOnly[];
  today: DateOnly;
  can: RateCan;
  /** room ids whose restriction rows are hidden (the room row is the disclosure) */
  collapsed: Set<string>;
  /** the card's footer bar (reference: the legend is part of the board card) */
  legend: ReactNode;
  onToggleCollapse: (sellableUnitId: string) => void;
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
  // The reference spells the weekday out ("יום ש"), not the calendar's "ש'" —
  // the day column is wide enough for it, unlike a calendar cell.
  // Index with dayOfWeek() DIRECTLY: it returns getUTCDay() (0=Sunday) and
  // HEBREW_DAY_LETTERS is Sunday-first, so the two already align — exactly as
  // CalendarGrid and GroupUpdatePanel index it. The old `(dow + 6) % 7` rotated
  // every label back one day, which stayed invisible while the label was a bare
  // glyph ("א'") but printed the wrong weekday once it was spelled out — and it
  // disagreed with the weekend tint on the same cell, which is keyed off the
  // very same dayOfWeek() (dow === 5 || dow === 6).
  const dw = (d: DateOnly) => `יום ${HEBREW_DAY_LETTERS[dayOfWeek(d)].replace("'", "")}`;

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

  // ONE grid: a 250px sticky label track + one stretch-to-fit track per day.
  // `minmax(--rg-col, 1fr)` is the whole responsive rule — the tracks fill the
  // card when it is wide and clamp to the 46px floor (scrolling) when it is not.
  //
  // minWidth is what keeps the label column PINNED. A sticky item can only
  // travel inside its containing block, which is the grid BOX — so with
  // `width:100%` alone the box stays at the card's width while the tracks
  // overflow it, and the sticky labels run out of box and slide away (then get
  // clipped) as soon as the board is scrolled past `cardWidth − 250px`. Sizing
  // the box to the full track span gives sticky the whole scroll range, so the
  // labels stay pinned at every offset — while `1fr` still stretches the day
  // columns whenever the card is wider than that span.
  const gridStyle = {
    gridTemplateColumns: `var(--rg-label) repeat(${dates.length}, minmax(var(--rg-col), 1fr))`,
    minWidth: `calc(var(--rg-label) + ${dates.length} * var(--rg-col))`,
  } as CSSProperties;
  // the board counts ROOMS (D74: the room is the canonical identity), which is
  // not the SU count — a pooled unit stands for several rooms.
  const roomTotal = types.reduce(
    (n, t) => n + t.units.reduce((m, u) => m + u.roomCount, 0),
    0,
  );
  // ONE ascending list across every room type — the ONE canonical comparator
  // (D86), the same one the calendar orders by.
  const rooms = useMemo(
    () => types.flatMap((t) => t.units).sort((a, b) => compareRoomNumber(a.code, b.code)),
    [types],
  );

  return (
    <div className="card rg-card">
      <div className="rg-scroll">
        <div className="rg-grid" style={gridStyle}>
          {/* row 1 — month band */}
          <div className="rg-corner mo" />
          {bands.map((b, i) => (
            <div className="rg-mseg" key={i} style={{ gridColumn: `span ${b.span}` }}><span>{b.label}</span></div>
          ))}

          {/* row 2 — day header */}
          <div className="rg-corner dy">
            חדרים
            <span className="rg-cnt">{roomTotal} חדרים · ₪ ללילה</span>
          </div>
          {cols.map((c) => (
            <div className={`rg-dcell${c.weekend ? " we" : ""}${c.today ? " td" : ""}${c.monthStart ? " ms" : ""}`} key={c.date}>
              <span className="rg-dw">{dw(c.date)}</span>
              <span className="rg-dn">{Number(c.date.slice(8, 10))}</span>
            </div>
          ))}

          {/* ONE ascending list of rooms — 926 → 1000 → 1006 → 1102 … The board
              used to be banded by room type, which made the order ascend only
              INSIDE a band. The type still labels every room row (.rg-utype), so
              nothing is lost but the grouping itself. */}
          {rooms.map((unit) => {
                const open = !collapsed.has(unit.sellableUnitId);
                return (
                  <Fragment key={unit.sellableUnitId}>
                    {/* the room row: its label is the disclosure control for the
                        six restriction rows (reference behaviour) */}
                    <button
                      type="button" className="rg-rlabel" aria-expanded={open}
                      onClick={() => onToggleCollapse(unit.sellableUnitId)}
                    >
                      <Icon name="chevron" size={20} className="rg-rchev" />
                      <span className="rg-unum">{unit.code}</span>
                      <span className="rg-utype">{unit.roomTypeName}</span>
                      {(unit.isPooled || unit.closedCount > 0 || !unit.hasBasePlan) && (
                        <span className="rg-utags">
                          {unit.isPooled && <span className="rg-utag">מאגר · {unit.roomCount}</span>}
                          {unit.closedCount > 0 && <span className="rg-utag">{unit.closedCount} סגורים</span>}
                          {!unit.hasBasePlan && <span className="rg-utag noplan">ללא תוכנית</span>}
                        </span>
                      )}
                    </button>
                    {unit.cells.map((cell, i) => <PriceCell key={cell.date} unit={unit} cell={cell} col={cols[i]} ctx={ctx} />)}

                    {open && METRICS.map((m) => (
                      <Fragment key={m.field}>
                        <div className="rg-slabel">
                          {m.label}
                          {m.tag && <span className="rg-mtag">{m.tag}</span>}
                        </div>
                        {unit.cells.map((cell, i) =>
                          m.kind === "num"
                            ? <MetricCell key={cell.date} unit={unit} cell={cell} col={cols[i]} field={m.field} ctx={ctx} />
                            : m.field === "stopSell"
                              ? <StopSellCell key={cell.date} unit={unit} cell={cell} col={cols[i]} ctx={ctx} />
                              : <BoolCell key={cell.date} unit={unit} cell={cell} col={cols[i]} field={m.field} ctx={ctx} />,
                        )}
                      </Fragment>
                    ))}
                  </Fragment>
                );
              })}
        </div>
      </div>
      <div className="rg-legend">{legend}</div>
      {tip && <CellTip x={tip.x} y={tip.y} unit={tip.unit} cell={tip.cell} />}
    </div>
  );
}
