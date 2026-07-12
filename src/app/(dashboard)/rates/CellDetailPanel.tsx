"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import { formatFullDate, isRateDateWritable, type DateOnly } from "@/lib/dates";
import { getCellDetailAction, upsertRateCellAction, type CellDetailData } from "./actions";
import {
  ROOM_ADMIN_TEXT, SELL_REASON_TEXT, SYNC_STATE_TEXT,
  type RateCellState, type RateGridUnit,
} from "./types";

// The cell ACTION popover (§8). Opened by clicking a price cell. Shows the full
// canonical projection with the three axes kept SEPARATE (physical / commercial /
// sync), every applicable reason, and the calculated outbound values. Commercial
// actions write through upsertRateCellAction (the same canonical path); PHYSICAL
// facts are shown read-only with LINKS to the proper operational screens — the
// grid never changes room status, reservations, or blocks (§5).
export function CellDetailPanel({
  open, onClose, unit, cell, today, editable, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  unit: RateGridUnit | null;
  cell: RateCellState | null;
  today: DateOnly;
  editable: boolean;
  onSaved: () => void;
}) {
  const router = useRouter();
  const [detail, setDetail] = useState<CellDetailData | null>(null);
  const [busy, setBusy] = useState(false);
  const [priceInput, setPriceInput] = useState("");

  const load = useCallback(async () => {
    if (!unit || !cell) return;
    const res = await getCellDetailAction(unit.sellableUnitId, cell.date);
    if (res.success && res.data) setDetail(res.data);
  }, [unit, cell]);

  useEffect(() => {
    if (!open) return;
    setDetail(null);
    setPriceInput(cell?.price != null ? String(cell.price) : "");
    void load();
  }, [open, load, cell?.price]);

  if (!unit || !cell) return null;
  const writable = isRateDateWritable(cell.date, today);

  async function apply(patch: Record<string, unknown>) {
    if (!unit || !cell) return;
    setBusy(true);
    const res = await upsertRateCellAction({
      sellableUnitId: unit.sellableUnitId,
      pricingPlanId: unit.pricingPlanId ?? undefined,
      date: cell.date,
      patch,
    });
    setBusy(false);
    if (res.success) {
      onSaved();
      router.refresh(); // re-render the grid (server) without remounting → scroll kept
      void load();
    } else if (res.error) window.alert(res.error);
  }

  const r = cell.outboundRestrictions;
  const num = (v: number | null) => (v == null ? "—" : String(v));

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title={`${unit.code} · ${formatFullDate(cell.date)}`}
      subtitle={`${unit.roomTypeName ?? "ללא סוג"}${unit.isPooled ? ` · מאגר ${unit.roomCount}` : ""} · תוכנית בסיס`}
      icon="credit-card"
      bodyClassName="p-5 flex flex-col gap-4"
    >
      {/* Final sale state + every applicable reason */}
      <Box title="מצב מכירה סופי" icon="info">
        <div className={`flex items-center gap-2 text-[14px] font-extrabold ${cell.sellable ? "text-status-success" : "text-status-danger"}`}>
          <Icon name={cell.sellable ? "check" : "circle-slash"} size={17} />
          {cell.sellable ? "ניתן למכירה" : "לא ניתן למכירה"}
        </div>
        <div className="flex flex-wrap gap-1.5 mt-2">
          {cell.reasonCodes.map((rc) => (
            <span key={rc} className={`chip ${rc === "SELLABLE" ? "chip-paid" : "chip-unpaid"}`}>
              {SELL_REASON_TEXT[rc]}
            </span>
          ))}
        </div>
      </Box>

      {/* Axis A — physical inventory (read-only; links to operational screens) */}
      <Box title="מלאי פיזי" icon="rooms">
        <Grid>
          <Stat label="קיבולת" value={cell.totalRooms} />
          <Stat label="זמין" value={cell.availability} strong={cell.availability > 0} />
          <Stat label="תפוסים" value={cell.occupiedRooms} />
          <Stat label="חסומים" value={cell.closedRooms} />
          <Stat label="הולד (OTA)" value={cell.physicalHeld} />
          <Stat label="מצב חדר" value={ROOM_ADMIN_TEXT[cell.roomAdminState]} />
        </Grid>
        {detail && (detail.reservations.length > 0 || detail.closures.length > 0 || cell.roomAdminState !== "available") && (
          <div className="mt-3 flex flex-col gap-1.5">
            {detail.reservations.map((rv) => (
              <LinkRow key={rv.id} icon="calendar" href={`/calendar?from=${rv.checkIn}`}
                text={`הזמנה #${rv.reservationNumber} (${rv.status}) · ${rv.checkIn}→${rv.checkOut}`} label="צפייה בלוח" />
            ))}
            {detail.closures.map((c) => (
              <LinkRow key={c.id} icon="room-blocks" href={`/calendar?from=${c.startDate}`}
                text={`חסימה פיזית${c.reason ? ` · ${c.reason}` : ""} · ${c.startDate}→${c.endDate}`} label="ניהול חסימה" />
            ))}
            {cell.roomAdminState !== "available" && cell.roomAdminState !== "no_member" && (
              <p className="field-msg mt-1">
                {cell.roomAdminState === "out_of_order" ? "החדר מושבת פיזית — יש להחזירו לפעילות בניהול חדרים." : "החדר אינו פעיל — יש להפעילו בניהול חדרים."}
              </p>
            )}
            {cell.roomAdminState === "no_member" && (
              <p className="field-msg mt-1">אין חדר משויך ליחידת המכירה — יש להשלים מיפוי.</p>
            )}
          </div>
        )}
      </Box>

      {/* Axis B — commercial (editable via the canonical write path) */}
      <Box title="מצב מסחרי" icon="credit-card">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="t-label">מכירה:</span>
          <span className={`chip ${cell.commercialOpen ? "chip-paid" : "chip-unpaid"}`}>
            <span className="dot" />
            {cell.commercialOpen ? "פתוח למכירה" : "סגור למכירה"}
          </span>
          <span className="field-hint">
            מחיר אפקטיבי <bdi className="ltr-num">₪{Math.round(cell.effectivePrice)}</bdi>{" "}
            {cell.priceSource === "inherited" ? <>(בסיס <bdi className="ltr-num">₪{Math.round(cell.inheritedRate)}</bdi>)</> : "(מוגדר)"}
          </span>
        </div>
        {!editable ? (
          <p className="field-hint">אין הרשאת עריכת תעריפים.</p>
        ) : !cell.activeRatePlan ? (
          <p className="field-msg">אין תוכנית תמחור פעילה ליחידה — יש להגדיר תוכנית בסיס.</p>
        ) : !writable ? (
          <p className="field-hint">תאריך שעבר — לא ניתן לעריכה מסחרית.</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
              {/* the CURRENT state is signalled by aria-pressed + a check glyph (shape cue),
                  never by colour alone (WCAG 1.4.1) */}
              <button type="button" aria-pressed={cell.commercialOpen} disabled={busy} onClick={() => apply({ stopSell: false })} className={`btn btn-secondary flex-1 ${cell.commercialOpen ? "text-status-success" : ""}`}>
                {cell.commercialOpen && <Icon name="check" size={20} />}
                פתוח למכירה
              </button>
              <button type="button" aria-pressed={!cell.commercialOpen} disabled={busy} onClick={() => apply({ stopSell: true })} className={`btn btn-secondary flex-1 ${cell.commercialOpen ? "" : "text-status-danger"}`}>
                {!cell.commercialOpen && <Icon name="check" size={20} />}
                סגור למכירה
              </button>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="rg-cell-price">מחיר ללילה</label>
              <div className="flex items-center gap-2">
                <input
                  id="rg-cell-price" type="number" inputMode="numeric" dir="ltr"
                  value={priceInput} onChange={(e) => setPriceInput(e.target.value)}
                  placeholder={`₪${Math.round(cell.effectivePrice)}`}
                  className="field-input ltr-num flex-1"
                />
                <button type="button" disabled={busy} onClick={() => apply({ price: priceInput.trim() === "" ? null : Number(priceInput) })} className="btn btn-primary">שמור מחיר</button>
              </div>
            </div>
            <Stepper label="מ׳ לילות בהגעה" value={cell.minStayArrival} disabled={busy} onSet={(v) => apply({ minStayArrival: v })} />
            <Stepper label="מינימום לילות בטווח" value={cell.minStayThrough} disabled={busy} onSet={(v) => apply({ minStayThrough: v })} />
            <Stepper label="מקסימום לילות" value={cell.maxStay} disabled={busy} onSet={(v) => apply({ maxStay: v })} />
            <div className="flex items-center gap-2">
              <Toggle label="סגור להגעה (CTA)" on={cell.closedToArrival} disabled={busy} onToggle={() => apply({ closedToArrival: !cell.closedToArrival })} />
              <Toggle label="סגור לעזיבה (CTD)" on={cell.closedToDeparture} disabled={busy} onToggle={() => apply({ closedToDeparture: !cell.closedToDeparture })} />
            </div>
          </div>
        )}
      </Box>

      {/* Axis — synchronization projection (calculated; nothing sent this phase) */}
      <Box title="סנכרון ערוצים" icon="channels">
        <Grid>
          <Stat label="מצב סנכרון" value={SYNC_STATE_TEXT[cell.syncState]} />
          <Stat label="מיפוי ערוץ" value={cell.mappingValid ? "ממופה" : "לא ממופה"} />
          <Stat label="זמינות ליציאה" value={cell.outboundAvailability} />
        </Grid>
        <p className="field-hint mt-2 leading-relaxed">
          ערכים מחושבים בלבד — לא נשלח דבר לערוץ בשלב זה. זמינות ליציאה נגזרת מהמלאי הפיזי בלבד;
          המגבלות ({r.stopSell ? "סגור" : "פתוח"}, CTA {r.closedToArrival ? "✓" : "—"}, CTD {r.closedToDeparture ? "✓" : "—"},
          מ׳ הגעה {num(r.minStayArrival)}, מ׳ טווח {num(r.minStayThrough)}, מקס {num(r.maxStay)}, ₪{Math.round(r.rate)}) נגזרות מה-ARI המסחרי.
        </p>
      </Box>
    </SidePanel>
  );
}

function Box({ title, icon, children }: { title: string; icon: Parameters<typeof Icon>[0]["name"]; children: React.ReactNode }) {
  return (
    <section className="card">
      {/* a real <h3> keeps the panel's document outline / screen-reader heading
          navigation; it inherits .card-hd's 17px/800 (§6) */}
      <div className="card-hd">
        <span className="flex h-6 w-6 items-center justify-center rounded-[7px] bg-primary-050 text-primary">
          <Icon name={icon} size={13.5} />
        </span>
        <h3>{title}</h3>
      </div>
      <div className="card-bd">{children}</div>
    </section>
  );
}
function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-3 gap-2.5">{children}</div>;
}
function Stat({ label, value, strong }: { label: string; value: string | number; strong?: boolean }) {
  return (
    <div className="rounded-[12px] bg-field p-2.5 text-center">
      <div className={`text-[15px] font-extrabold tabular-nums ${strong ? "text-status-success" : "text-ink"}`}>{value}</div>
      <div className="t-label">{label}</div>
    </div>
  );
}
function LinkRow({ icon, href, text, label }: { icon: Parameters<typeof Icon>[0]["name"]; href: string; text: string; label: string }) {
  return (
    <a href={href} className="flex items-center gap-2 rounded-[8px] border-[1.5px] border-line px-3 py-2 text-[12px] font-bold text-ink hover:bg-hover">
      <Icon name={icon} size={17} className="text-muted" />
      <span className="flex-1 truncate">{text}</span>
      <span className="flex-none text-primary">{label} ›</span>
    </a>
  );
}
function Stepper({ label, value, disabled, onSet }: { label: string; value: number | null; disabled?: boolean; onSet: (v: number | null) => void }) {
  const v = value ?? 0;
  return (
    <div className="flex items-center gap-2">
      <span className="field-label flex-1">{label}</span>
      {/* border-solid is REQUIRED: .icon-btn resets `border: none` (style), so the
          width/colour utilities alone would never paint the outline */}
      <button type="button" aria-label={`${label} — פחות`} disabled={disabled} onClick={() => onSet(v <= 1 ? null : v - 1)} className="icon-btn border-[1.5px] border-solid border-line"><Icon name="minus" size={20} /></button>
      <span className="w-8 text-center text-[13.5px] font-extrabold tabular-nums">{value ?? "—"}</span>
      <button type="button" aria-label={`${label} — עוד`} disabled={disabled} onClick={() => onSet(v + 1)} className="icon-btn border-[1.5px] border-solid border-line"><Icon name="plus" size={20} /></button>
    </div>
  );
}
function Toggle({ label, on, disabled, onToggle }: { label: string; on: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button" aria-pressed={on} disabled={disabled} onClick={onToggle}
      className={`btn btn-secondary flex-1 ${on ? "text-status-warning" : ""}`}
    >
      {label}: {on ? "פעיל" : "כבוי"}
    </button>
  );
}
