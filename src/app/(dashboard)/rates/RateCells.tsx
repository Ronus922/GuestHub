"use client";

import type { MouseEvent as ReactMouseEvent } from "react";
import { Icon } from "@/components/shared/Icon";
import type { DateOnly } from "@/lib/dates";
import { SELL_REASON_KIND, SELL_REASON_TEXT, type RateCellState, type RateGridUnit } from "./types";

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
  // Writes an EXPLICIT boolean (open→false, close→true) — never a toggle — so a
  // commercial re-open always persists stop_sell=false (Step 3, never one-way).
  setBool: (unit: RateGridUnit, field: BoolField, date: DateOnly, value: boolean) => void;
  // Opens the cell action popover (§8) — full projection + commercial actions + physical links.
  openDetail: (unit: RateGridUnit, cell: RateCellState) => void;
  hover: (e: ReactMouseEvent, unit: RateGridUnit, cell: RateCellState) => void;
  leave: () => void;
};

const cls = (col: ColGeom, extra: string[]) =>
  ["rg-cell", col.weekend ? "we" : "", col.today ? "td" : "", col.monthStart ? "ms" : "", ...extra]
    .filter(Boolean).join(" ");

// The price cell state is driven by the SINGLE sale-state reason, so unrelated
// causes look different (Step 7): physical → hatch + ⊘; mapping/plan error →
// error box; missing/invalid price → amber "no-price"; commercial stop-sell →
// red price (still editable/re-openable); sellable → normal (muted if inherited).
export function PriceCell({ unit, cell, col, ctx }: { unit: RateGridUnit; cell: RateCellState; col: ColGeom; ctx: CellCtx }) {
  const k = ctx.key(unit.sellableUnitId, cell.date, "price");
  const kind = SELL_REASON_KIND[cell.sellReason];
  const physical = kind === "physical";
  const errored = kind === "error";
  const noPrice = kind === "price";
  const commercial = kind === "commercial";
  // The price cell always opens the cell action popover (§8) — even for a viewer,
  // to read the full projection. Commercial edits inside the panel are gated by
  // permission + the writable-date policy.
  const className = cls(col, [
    "editable",
    physical ? "blocked" : "", errored ? "errored" : "", noPrice ? "noprice" : "",
    ctx.saving.has(k) ? "saving" : "",
  ]);
  const priceCls = ["rg-price", cell.priceSource === "inherited" ? "inherited" : "", commercial ? "notsell" : ""].filter(Boolean).join(" ");
  return (
    <div
      className={className}
      data-su={unit.sellableUnitId} data-date={cell.date} data-field="price" data-reason={cell.sellReason}
      onClick={() => ctx.openDetail(unit, cell)}
      onMouseEnter={(e) => ctx.hover(e, unit, cell)}
      onMouseMove={(e) => ctx.hover(e, unit, cell)}
      onMouseLeave={ctx.leave}
    >
      {physical ? <Icon name="circle-slash" size={12} className="rg-blk" />
        : errored ? <Icon name="warning" size={12} className="rg-err" />
        : noPrice ? <span className="rg-price nomprice">—</span>
        : <span className={priceCls}>{Math.round(cell.effectivePrice)}</span>}
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

// Read-only physical + derived breakdown tooltip for a hovered price cell —
// styled to the reference .rm window (tonnage.png / Calendar messages.html):
// brand header (unit · date), divided rows, full-width sale-state band.
export function CellTip({ x, y, unit, cell }: { x: number; y: number; unit: RateGridUnit; cell: RateCellState }) {
  const left = Math.min(x + 14, (typeof window !== "undefined" ? window.innerWidth : 9999) - 266);
  return (
    <div className="rg-tip" style={{ left, top: y + 16 }}>
      <div className="rg-tip-h">
        <span className="rg-tip-t">{unit.code}</span>
        <span className="rg-tip-dt">{cell.date}</span>
      </div>
      <div className="rg-tip-rows">
        <div className="rg-tip-row">
          <span className="k">מחיר</span>
          <span className="v">
            ₪{Math.round(cell.effectivePrice).toLocaleString()}{" "}
            <small>{cell.priceSource === "inherited" ? "(בסיס)" : "(מוגדר)"}</small>
          </span>
        </div>
        <div className="rg-tip-row">
          <span className="k">זמינות פיזית</span>
          <span className="v">
            {cell.availability} מתוך {cell.sellableRooms}
            {cell.totalRooms !== cell.sellableRooms ? `/${cell.totalRooms}` : ""}
          </span>
        </div>
        {cell.occupiedRooms > 0 && (
          <div className="rg-tip-row">
            <span className="k">תפוסים</span>
            <span className="v">{cell.occupiedRooms}</span>
          </div>
        )}
        {cell.closedRooms > 0 && (
          <div className="rg-tip-row">
            <span className="k">חסומים פיזית</span>
            <span className="v">{cell.closedRooms}</span>
          </div>
        )}
      </div>
      <div className={`rg-tip-f ${cell.sellable ? "op" : "cl"}`}>
        <Icon name={cell.sellable ? "check" : "circle-slash"} size={13} />
        {SELL_REASON_TEXT[cell.sellReason]}
      </div>
    </div>
  );
}

// stop_sell is the COMMERCIAL open/close switch — an explicit two-state editor
// (Step 3), not a bare toggle, so "פתוח למכירה" always writes stop_sell=false
// and a close is never one-way. (The column is NOT NULL DEFAULT false, so there
// is no nullable "inherit" state to offer — open/closed is the full model.)
// Physical unavailability is a SEPARATE axis shown on the price row; opening the
// commercial switch here never overrides a real physical block.
export function StopSellCell({ unit, cell, col, ctx }: { unit: RateGridUnit; cell: RateCellState; col: ColGeom; ctx: CellCtx }) {
  const k = ctx.key(unit.sellableUnitId, cell.date, "stopSell");
  const isEditing = ctx.editing?.unitId === unit.sellableUnitId && ctx.editing.field === "stopSell" && ctx.editing.date === cell.date;
  const closed = cell.stopSell;
  const className = cls(col, [ctx.editable ? "editable" : "", ctx.saving.has(k) ? "saving" : ""]);
  if (isEditing) {
    return (
      <div className={className}>
        <div className="rg-ss-edit">
          <button data-testid="ss-open" className={`rg-ss-b open${!closed ? " on" : ""}`} title="פתוח למכירה"
            onClick={() => ctx.setBool(unit, "stopSell", cell.date, false)}><Icon name="check" size={11} /></button>
          <button data-testid="ss-close" className={`rg-ss-b close${closed ? " on" : ""}`} title="סגור למכירה"
            onClick={() => ctx.setBool(unit, "stopSell", cell.date, true)}><Icon name="circle-slash" size={11} /></button>
        </div>
      </div>
    );
  }
  return (
    <div
      className={className}
      data-su={unit.sellableUnitId} data-date={cell.date} data-field="stopSell" data-closed={closed ? "1" : "0"}
      onClick={ctx.editable ? () => ctx.startEdit(unit.sellableUnitId, "stopSell", cell.date) : undefined}
      title={closed ? "סגור למכירה · לחיצה לפתיחה" : ctx.editable ? "פתוח למכירה · לחיצה לסגירה" : "פתוח למכירה"}
    >
      {closed ? <span className="rg-flag sell"><Icon name="circle-slash" size={12} /></span> : <span className="rg-dash">—</span>}
    </div>
  );
}
