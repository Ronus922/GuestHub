"use client";

import { useState, useRef, useCallback, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/shared/Icon";
import { dayOfWeek, HEBREW_DAY_LETTERS, hebrewMonthYear, type DateOnly } from "@/lib/dates";
import { upsertRateCellAction } from "./actions";
import type { RateCan, RateCellState, RateGridType, RateGridUnit } from "./types";

// The seven editable commercial fields, in the reference row order (price on top).
type FieldKind = "price" | "num" | "bool";
const FIELDS: { key: keyof RateCellState; kind: FieldKind; label: string; tag: string }[] = [
  { key: "price", kind: "price", label: "מחיר ללילה", tag: "₪" },
  { key: "minStayThrough", kind: "num", label: "מינימום לילות", tag: "MIN" },
  { key: "maxStay", kind: "num", label: "מקסימום לילות", tag: "MAX" },
  { key: "minStayArrival", kind: "num", label: "מ׳ לילות בהגעה", tag: "MIN LOS" },
  { key: "closedToArrival", kind: "bool", label: "סגור להגעה", tag: "CTA" },
  { key: "closedToDeparture", kind: "bool", label: "סגור לעזיבה", tag: "CTD" },
  { key: "stopSell", kind: "bool", label: "סגור למכירה", tag: "" },
];

// camelCase patch keys accepted by upsertRateCellSchema.patch
type PatchKey =
  | "price" | "minStayThrough" | "maxStay" | "minStayArrival"
  | "closedToArrival" | "closedToDeparture" | "stopSell";

// One touched field, matching the action's rateCellPatch shape (camelCase).
type CellPatch = {
  price?: number | null;
  minStayThrough?: number | null;
  maxStay?: number | null;
  minStayArrival?: number | null;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
  stopSell?: boolean;
};

type Editing = { unitId: string; field: PatchKey; date: DateOnly } | null;
type Tip = { x: number; y: number; unit: RateGridUnit; cell: RateCellState } | null;

const cellKey = (u: string, d: string, f: string) => `${u}|${d}|${f}`;

export function RateGrid({
  types,
  dates,
  today,
  can,
  collapsed,
  onToggleCollapse,
  onGroupUpdateForType,
}: {
  types: RateGridType[];
  dates: DateOnly[];
  today: DateOnly;
  can: RateCan;
  collapsed: Set<string>;
  onToggleCollapse: (typeKey: string) => void;
  onGroupUpdateForType: (unitIds: string[]) => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Editing>(null);
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [tip, setTip] = useState<Tip>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Day-column geometry (weekend Fri/Sat, today, month boundaries + bands).
  const cols = dates.map((d, i) => {
    const dow = dayOfWeek(d);
    return {
      date: d,
      dow,
      weekend: dow === 5 || dow === 6,
      today: d === today,
      monthStart: i > 0 && d.slice(0, 7) !== dates[i - 1].slice(0, 7),
      dn: Number(d.slice(8, 10)),
      dw: HEBREW_DAY_LETTERS[(dow + 6) % 7], // HEBREW_DAY_LETTERS is Sun..Sat
    };
  });
  // month bands (label + column span) for the sticky month row
  const bands: { label: string; span: number }[] = [];
  for (const d of dates) {
    const label = hebrewMonthYear(d);
    const last = bands[bands.length - 1];
    if (last && last.label === label) last.span++;
    else bands.push({ label, span: 1 });
  }

  const submit = useCallback(
    async (unit: RateGridUnit, date: DateOnly, patch: CellPatch) => {
      const field = Object.keys(patch)[0];
      const k = cellKey(unit.sellableUnitId, date, field);
      setSaving((s) => new Set(s).add(k));
      setEditing(null);
      const res = await upsertRateCellAction({
        sellableUnitId: unit.sellableUnitId,
        pricingPlanId: unit.pricingPlanId ?? undefined,
        date,
        patch,
      });
      setSaving((s) => {
        const n = new Set(s);
        n.delete(k);
        return n;
      });
      if (res.success) router.refresh();
      else if (res.error) window.alert(res.error);
    },
    [router],
  );

  // commit an inline numeric edit ("" → null clears the explicit value)
  const commitNumber = (unit: RateGridUnit, field: PatchKey, date: DateOnly, raw: string) => {
    const trimmed = raw.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (value !== null && (Number.isNaN(value) || value < 0)) {
      setEditing(null);
      return;
    }
    void submit(unit, date, { [field]: value } as CellPatch);
  };

  const renderPriceCell = (unit: RateGridUnit, cell: RateCellState, col: (typeof cols)[number]) => {
    const k = cellKey(unit.sellableUnitId, cell.date, "price");
    const isEditing = editing?.unitId === unit.sellableUnitId && editing.field === "price" && editing.date === cell.date;
    const blocked = cell.availability === 0; // physically unavailable (occupied/closed/inactive)
    const cls = [
      "rg-cell",
      col.weekend ? "we" : "",
      col.today ? "td" : "",
      col.monthStart ? "ms" : "",
      can.edit ? "editable" : "",
      blocked ? "blocked" : "",
      saving.has(k) ? "saving" : "",
    ].filter(Boolean).join(" ");

    if (isEditing) {
      return (
        <div className={cls} key={cell.date}>
          <input
            ref={inputRef}
            className="rg-input"
            type="number"
            inputMode="numeric"
            defaultValue={cell.price ?? ""}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") commitNumber(unit, "price", cell.date, (e.target as HTMLInputElement).value);
              else if (e.key === "Escape") setEditing(null);
            }}
            onBlur={(e) => commitNumber(unit, "price", cell.date, e.target.value)}
          />
        </div>
      );
    }
    const priceCls = [
      "rg-price",
      cell.priceSource === "inherited" ? "inherited" : "",
      !cell.sellable ? "notsell" : "",
    ].filter(Boolean).join(" ");
    return (
      <div
        className={cls}
        key={cell.date}
        data-su={unit.sellableUnitId}
        data-date={cell.date}
        data-field="price"
        onClick={can.edit ? () => setEditing({ unitId: unit.sellableUnitId, field: "price", date: cell.date }) : undefined}
        onMouseEnter={(e) => setTip({ x: e.clientX, y: e.clientY, unit, cell })}
        onMouseMove={(e) => setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t))}
        onMouseLeave={() => setTip(null)}
      >
        <span className={priceCls}>{Math.round(cell.effectivePrice)}</span>
      </div>
    );
  };

  const renderNumCell = (unit: RateGridUnit, cell: RateCellState, field: PatchKey, col: (typeof cols)[number]) => {
    const k = cellKey(unit.sellableUnitId, cell.date, field);
    const isEditing = editing?.unitId === unit.sellableUnitId && editing.field === field && editing.date === cell.date;
    const value = cell[field as keyof RateCellState] as number | null;
    const cls = ["rg-cell", col.weekend ? "we" : "", col.today ? "td" : "", col.monthStart ? "ms" : "", can.edit ? "editable" : "", saving.has(k) ? "saving" : ""].filter(Boolean).join(" ");
    if (isEditing) {
      return (
        <div className={cls} key={cell.date}>
          <input
            className="rg-input"
            type="number"
            inputMode="numeric"
            defaultValue={value ?? ""}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") commitNumber(unit, field, cell.date, (e.target as HTMLInputElement).value);
              else if (e.key === "Escape") setEditing(null);
            }}
            onBlur={(e) => commitNumber(unit, field, cell.date, e.target.value)}
          />
        </div>
      );
    }
    return (
      <div
        className={cls}
        key={cell.date}
        data-su={unit.sellableUnitId}
        data-date={cell.date}
        data-field={field}
        onClick={can.edit ? () => setEditing({ unitId: unit.sellableUnitId, field, date: cell.date }) : undefined}
      >
        {value == null ? <span className="rg-dash">—</span> : <span className="rg-num">{value}</span>}
      </div>
    );
  };

  const renderBoolCell = (unit: RateGridUnit, cell: RateCellState, field: PatchKey, col: (typeof cols)[number]) => {
    const k = cellKey(unit.sellableUnitId, cell.date, field);
    const on = cell[field as keyof RateCellState] as boolean;
    const cls = ["rg-cell", col.weekend ? "we" : "", col.today ? "td" : "", col.monthStart ? "ms" : "", can.edit ? "editable" : "", saving.has(k) ? "saving" : ""].filter(Boolean).join(" ");
    const iconName = field === "stopSell" ? "circle-slash" : field === "closedToArrival" ? "login" : "logout";
    return (
      <div
        className={cls}
        key={cell.date}
        data-su={unit.sellableUnitId}
        data-date={cell.date}
        data-field={field}
        onClick={can.edit ? () => submit(unit, cell.date, { [field]: !on } as CellPatch) : undefined}
        title={on ? "פעיל · לחיצה לביטול" : "לחיצה להפעלה"}
      >
        {on ? (
          <span className={`rg-flag${field === "stopSell" ? "" : " warn"}`}>
            <Icon name={iconName} size={13} />
          </span>
        ) : (
          <span className="rg-dash">—</span>
        )}
      </div>
    );
  };

  return (
    <div className="rg-card">
      <div className="rg-scroll">
        <div className="rg-grid" style={{ "--rg-cell": "46px", "--rg-label": "216px" } as CSSProperties}>
          {/* sticky header: month bands + day cells */}
          <div className="rg-head">
            <div className="rg-row rg-mrow">
              <div className="rg-corner" />
              {bands.map((b, i) => (
                <div className="rg-mseg" key={i} style={{ width: `calc(${b.span} * var(--rg-cell))` }}>
                  <span>{b.label}</span>
                </div>
              ))}
            </div>
            <div className="rg-row rg-drow">
              <div className="rg-corner">
                <span className="rg-htitle">יחידות מכירה</span>
                <span className="rg-hsub">{dates.length} ימים</span>
              </div>
              {cols.map((c) => (
                <div className={`rg-dcell${c.weekend ? " we" : ""}${c.today ? " td" : ""}${c.monthStart ? " ms" : ""}`} key={c.date}>
                  <span className="rg-dw">{c.dw}</span>
                  <span className="rg-dn">{c.dn}</span>
                </div>
              ))}
            </div>
          </div>

          {/* type bands */}
          {types.map((band) => {
            const tk = band.roomTypeId ?? "—";
            const isCollapsed = collapsed.has(tk);
            return (
              <div key={tk}>
                <div className="rg-typerow">
                  <div className="rg-tlabel">
                    <button
                      type="button"
                      className="rg-tlink"
                      onClick={() => onToggleCollapse(tk)}
                      aria-label={isCollapsed ? "הרחב" : "כווץ"}
                    >
                      <Icon name={isCollapsed ? "chevron-left" : "chevron"} size={15} />
                    </button>
                    <span className="rg-tname">{band.roomTypeName}</span>
                    <span className="rg-tcount">· {band.units.length} יחידות</span>
                  </div>
                  <div className="rg-tstrip">
                    <span className="rg-tbase">מחיר בסיס <b>₪{Math.round(band.basePrice)}</b></span>
                    {can.bulk && (
                      <button type="button" className="rg-tlink" onClick={() => onGroupUpdateForType(band.unitIds)}>
                        <Icon name="bulk-update" size={14} />
                        עדכון קבוצתי לסוג
                      </button>
                    )}
                  </div>
                </div>

                {!isCollapsed &&
                  band.units.map((unit) => (
                    <div className="rg-unit" key={unit.sellableUnitId}>
                      {FIELDS.map((f) => (
                        <div className={`rg-frow ${f.kind === "price" ? "price" : "rest"}`} key={f.key as string}>
                          <div className="rg-flabel">
                            {f.kind === "price" ? (
                              <>
                                <span className="rg-unum">{unit.code}</span>
                                <span className="rg-utype">{unit.roomTypeName}</span>
                                {unit.isPooled && <span className="rg-pool">מאגר · {unit.roomCount}</span>}
                                {!unit.hasBasePlan && <span className="rg-pool" style={{ color: "#b4670a", background: "#fbf1e0" }}>ללא תוכנית</span>}
                              </>
                            ) : (
                              <span className="rg-flabel-rest">
                                <span className="rg-lname">{f.label}</span>
                                {f.tag && <span className="rg-tag">{f.tag}</span>}
                              </span>
                            )}
                          </div>
                          {unit.cells.map((cell, ci) =>
                            f.kind === "price"
                              ? renderPriceCell(unit, cell, cols[ci])
                              : f.kind === "num"
                                ? renderNumCell(unit, cell, f.key as PatchKey, cols[ci])
                                : renderBoolCell(unit, cell, f.key as PatchKey, cols[ci]),
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
              </div>
            );
          })}
        </div>
      </div>

      {tip && <CellTip tip={tip} />}
    </div>
  );
}

// Read-only physical + derived breakdown for a price cell (never editable state).
function CellTip({ tip }: { tip: NonNullable<Tip> }) {
  const { cell, unit } = tip;
  const left = Math.min(tip.x + 14, (typeof window !== "undefined" ? window.innerWidth : 9999) - 250);
  return (
    <div className="rg-tip" style={{ left, top: tip.y + 16 }}>
      <div className="rg-tip-t">{unit.code} · {cell.date}</div>
      <div>מחיר: <b>₪{Math.round(cell.effectivePrice)}</b> {cell.priceSource === "inherited" ? "(בסיס)" : "(מוגדר)"}</div>
      <div>זמינות פיזית: <b>{cell.availability}</b> מתוך {cell.sellableRooms}/{cell.totalRooms}</div>
      {cell.occupiedRooms > 0 && <div>תפוסים: {cell.occupiedRooms}</div>}
      {cell.closedRooms > 0 && <div>חסומים פיזית: {cell.closedRooms}</div>}
      {cell.stopSell && <div className="rg-tip-no">סגור למכירה (מסחרי)</div>}
      <div className={cell.sellable ? "rg-tip-ok" : "rg-tip-no"}>
        {cell.sellable ? "✓ ניתן למכירה" : "✕ לא ניתן למכירה"}
      </div>
    </div>
  );
}
