"use client";

import type { MouseEvent as ReactMouseEvent } from "react";
import { Icon } from "@/components/shared/Icon";
import type { DateOnly } from "@/lib/dates";
import type { RateCellState, RateGridUnit } from "./types";

// Pure cell renderers for the Rate Grid. Editing/saving/hover state lives in the
// grid; these components only draw a cell and forward intent. Each keeps a
// data-su/data-date/data-field hook for deterministic E2E targeting.

export type ColGeom = { date: DateOnly; weekend: boolean; today: boolean; monthStart: boolean };
export type BoolField = "closedToArrival" | "closedToDeparture" | "stopSell";
export type NumField = "minStayThrough" | "maxStay" | "minStayArrival";

export type CellCtx = {
  editable: boolean;
  editing: { field: string; date: DateOnly; unitId: string } | null;
  saving: Set<string>;
  key: (unitId: string, date: DateOnly, field: string) => string;
  startEdit: (unitId: string, field: string, date: DateOnly) => void;
  cancel: () => void;
  commitNumber: (unit: RateGridUnit, field: "price" | NumField, date: DateOnly, raw: string) => void;
  toggleBool: (unit: RateGridUnit, field: BoolField, date: DateOnly, current: boolean) => void;
  hover: (e: ReactMouseEvent, unit: RateGridUnit, cell: RateCellState) => void;
  leave: () => void;
};

const cls = (col: ColGeom, extra: string[]) =>
  ["rg-cell", col.weekend ? "we" : "", col.today ? "td" : "", col.monthStart ? "ms" : "", ...extra]
    .filter(Boolean).join(" ");

// The price cell: physically-blocked → hatch + ⊘ (read-only); else the effective
// price, muted when inherited from base, red when commercially not sellable.
export function PriceCell({ unit, cell, col, ctx }: { unit: RateGridUnit; cell: RateCellState; col: ColGeom; ctx: CellCtx }) {
  const k = ctx.key(unit.sellableUnitId, cell.date, "price");
  const isEditing = ctx.editing?.unitId === unit.sellableUnitId && ctx.editing.field === "price" && ctx.editing.date === cell.date;
  const blocked = cell.availability === 0;
  const className = cls(col, [ctx.editable ? "editable" : "", blocked ? "blocked" : "", ctx.saving.has(k) ? "saving" : ""]);

  if (isEditing) {
    return (
      <div className={className}>
        <input
          className="rg-input" type="number" inputMode="numeric" defaultValue={cell.price ?? ""} autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") ctx.commitNumber(unit, "price", cell.date, (e.target as HTMLInputElement).value);
            else if (e.key === "Escape") ctx.cancel();
          }}
          onBlur={(e) => ctx.commitNumber(unit, "price", cell.date, e.target.value)}
        />
      </div>
    );
  }
  const priceCls = ["rg-price", cell.priceSource === "inherited" ? "inherited" : "", !cell.sellable && !blocked ? "notsell" : ""].filter(Boolean).join(" ");
  return (
    <div
      className={className}
      data-su={unit.sellableUnitId} data-date={cell.date} data-field="price"
      onClick={ctx.editable ? () => ctx.startEdit(unit.sellableUnitId, "price", cell.date) : undefined}
      onMouseEnter={(e) => ctx.hover(e, unit, cell)}
      onMouseMove={(e) => ctx.hover(e, unit, cell)}
      onMouseLeave={ctx.leave}
    >
      {blocked ? <Icon name="circle-slash" size={12} className="rg-blk" /> : <span className={priceCls}>{Math.round(cell.effectivePrice)}</span>}
    </div>
  );
}

// A numeric restriction cell (min/max stay): value or an em-dash; click to edit.
export function MetricCell({ unit, cell, col, field, ctx }: { unit: RateGridUnit; cell: RateCellState; col: ColGeom; field: NumField; ctx: CellCtx }) {
  const k = ctx.key(unit.sellableUnitId, cell.date, field);
  const isEditing = ctx.editing?.unitId === unit.sellableUnitId && ctx.editing.field === field && ctx.editing.date === cell.date;
  const value = cell[field] as number | null;
  const className = cls(col, [ctx.editable ? "editable" : "", ctx.saving.has(k) ? "saving" : ""]);
  if (isEditing) {
    return (
      <div className={className}>
        <input
          className="rg-input" type="number" inputMode="numeric" defaultValue={value ?? ""} autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") ctx.commitNumber(unit, field, cell.date, (e.target as HTMLInputElement).value);
            else if (e.key === "Escape") ctx.cancel();
          }}
          onBlur={(e) => ctx.commitNumber(unit, field, cell.date, e.target.value)}
        />
      </div>
    );
  }
  return (
    <div
      className={className}
      data-su={unit.sellableUnitId} data-date={cell.date} data-field={field}
      onClick={ctx.editable ? () => ctx.startEdit(unit.sellableUnitId, field, cell.date) : undefined}
    >
      {value == null ? <span className="rg-dash">—</span> : <span className="rg-num">{value}</span>}
    </div>
  );
}

// A boolean restriction cell (CTA/CTD/stop_sell): icon when on, click to toggle.
export function BoolCell({ unit, cell, col, field, ctx }: { unit: RateGridUnit; cell: RateCellState; col: ColGeom; field: BoolField; ctx: CellCtx }) {
  const k = ctx.key(unit.sellableUnitId, cell.date, field);
  const on = cell[field] as boolean;
  const className = cls(col, [ctx.editable ? "editable" : "", ctx.saving.has(k) ? "saving" : ""]);
  const iconName = field === "stopSell" ? "circle-slash" : field === "closedToArrival" ? "login" : "logout";
  return (
    <div
      className={className}
      data-su={unit.sellableUnitId} data-date={cell.date} data-field={field}
      onClick={ctx.editable ? () => ctx.toggleBool(unit, field, cell.date, on) : undefined}
      title={on ? "פעיל · לחיצה לביטול" : ctx.editable ? "לחיצה להפעלה" : undefined}
    >
      {on ? <span className={`rg-flag ${field === "stopSell" ? "sell" : field === "closedToArrival" ? "cta" : "ctd"}`}><Icon name={iconName} size={12} /></span> : <span className="rg-dash">—</span>}
    </div>
  );
}

// Read-only physical + derived breakdown tooltip for a hovered price cell.
export function CellTip({ x, y, unit, cell }: { x: number; y: number; unit: RateGridUnit; cell: RateCellState }) {
  const left = Math.min(x + 14, (typeof window !== "undefined" ? window.innerWidth : 9999) - 250);
  return (
    <div className="rg-tip" style={{ left, top: y + 16 }}>
      <div className="rg-tip-t">{unit.code} · {cell.date}</div>
      <div>מחיר: <b>₪{Math.round(cell.effectivePrice)}</b> {cell.priceSource === "inherited" ? "(בסיס)" : "(מוגדר)"}</div>
      <div>זמינות פיזית: <b>{cell.availability}</b> מתוך {cell.sellableRooms}/{cell.totalRooms}</div>
      {cell.occupiedRooms > 0 && <div>תפוסים: {cell.occupiedRooms}</div>}
      {cell.closedRooms > 0 && <div>חסומים פיזית: {cell.closedRooms}</div>}
      {cell.stopSell && <div className="rg-tip-no">סגור למכירה (מסחרי)</div>}
      <div className={cell.sellable ? "rg-tip-ok" : "rg-tip-no"}>{cell.sellable ? "✓ ניתן למכירה" : "✕ לא ניתן למכירה"}</div>
    </div>
  );
}
