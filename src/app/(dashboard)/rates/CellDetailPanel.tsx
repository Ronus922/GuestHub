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
  open, onClose, unit, cell, today, editable,
}: {
  open: boolean;
  onClose: () => void;
  unit: RateGridUnit | null;
  cell: RateCellState | null;
  today: DateOnly;
  editable: boolean;
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
        <div className={`text-[14px] font-extrabold ${cell.sellable ? "text-[var(--color-status-success)]" : "text-[var(--color-status-danger)]"}`}>
          {cell.sellable ? "✓ ניתן למכירה" : "✕ לא ניתן למכירה"}
        </div>
        <div className="flex flex-wrap gap-1.5 mt-2">
          {cell.reasonCodes.map((rc) => (
            <span key={rc} className={`px-2 py-0.5 rounded-md text-[11.5px] font-bold ${rc === "SELLABLE" ? "bg-[var(--color-status-success-050)] text-[var(--color-status-success)]" : "bg-[#fbe9ee] text-[#a23b52]"}`}>
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
              <p className="text-[12px] font-bold text-[#a23b52] mt-1">
                {cell.roomAdminState === "out_of_order" ? "החדר מושבת פיזית — יש להחזירו לפעילות בניהול חדרים." : "החדר אינו פעיל — יש להפעילו בניהול חדרים."}
              </p>
            )}
            {cell.roomAdminState === "no_member" && (
              <p className="text-[12px] font-bold text-[#a23b52] mt-1">אין חדר משויך ליחידת המכירה — יש להשלים מיפוי.</p>
            )}
          </div>
        )}
      </Box>

      {/* Axis B — commercial (editable via the canonical write path) */}
      <Box title="מצב מסחרי" icon="credit-card">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[13px] font-bold text-[var(--color-muted)]">מכירה:</span>
          <span className={`px-2 py-0.5 rounded-md text-[12px] font-extrabold ${cell.commercialOpen ? "bg-[var(--color-status-success-050)] text-[var(--color-status-success)]" : "bg-[#fbe9ee] text-[#a23b52]"}`}>
            {cell.commercialOpen ? "פתוח למכירה" : "סגור למכירה"}
          </span>
          <span className="text-[12px] text-[var(--color-faint)]">
            מחיר אפקטיבי ₪{Math.round(cell.effectivePrice)} {cell.priceSource === "inherited" ? `(בסיס ₪${Math.round(cell.inheritedRate)})` : "(מוגדר)"}
          </span>
        </div>
        {!editable ? (
          <p className="text-[12.5px] font-bold text-[var(--color-faint)]">אין הרשאת עריכת תעריפים.</p>
        ) : !cell.activeRatePlan ? (
          <p className="text-[12.5px] font-bold text-[#a23b52]">אין תוכנית תמחור פעילה ליחידה — יש להגדיר תוכנית בסיס.</p>
        ) : !writable ? (
          <p className="text-[12.5px] font-bold text-[var(--color-faint)]">תאריך שעבר — לא ניתן לעריכה מסחרית.</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <button disabled={busy} onClick={() => apply({ stopSell: false })} className="flex-1 h-10 rounded-xl bg-[var(--color-status-success-050)] text-[var(--color-status-success)] text-[13px] font-extrabold border-[1.5px] border-[#bfe6cd] disabled:opacity-50">פתוח למכירה</button>
              <button disabled={busy} onClick={() => apply({ stopSell: true })} className="flex-1 h-10 rounded-xl bg-[#fbe9ee] text-[#a23b52] text-[13px] font-extrabold border-[1.5px] border-[#f0c9d3] disabled:opacity-50">סגור למכירה</button>
            </div>
            <div className="flex items-center gap-2">
              <input type="number" inputMode="numeric" value={priceInput} onChange={(e) => setPriceInput(e.target.value)} placeholder={`₪${Math.round(cell.effectivePrice)}`}
                className="h-10 px-3 rounded-xl border-[1.5px] border-[#e4e8f0] text-[13px] font-bold bg-white flex-1 outline-none" />
              <button disabled={busy} onClick={() => apply({ price: priceInput.trim() === "" ? null : Number(priceInput) })} className="h-10 px-4 rounded-xl bg-[var(--color-primary)] text-white text-[13px] font-extrabold disabled:opacity-50">שמור מחיר</button>
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
        <p className="mt-2 text-[11.5px] font-medium text-[var(--color-faint)] leading-relaxed">
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
    <section className="bg-white rounded-2xl border border-[#e8ebf2] p-4">
      <div className="flex items-center gap-2 mb-2.5">
        <span className="w-6 h-6 rounded-lg bg-[var(--color-primary-050)] text-[var(--color-primary)] flex items-center justify-center"><Icon name={icon} size={14} /></span>
        <h3 className="text-[14px] font-extrabold text-[var(--color-ink)]">{title}</h3>
      </div>
      {children}
    </section>
  );
}
function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-3 gap-2.5">{children}</div>;
}
function Stat({ label, value, strong }: { label: string; value: string | number; strong?: boolean }) {
  return (
    <div className="bg-[#f7f9fc] rounded-xl p-2.5 text-center">
      <div className={`text-[15px] font-extrabold tabular-nums ${strong ? "text-[var(--color-status-success)]" : "text-[var(--color-ink)]"}`}>{value}</div>
      <div className="text-[11px] font-bold text-[var(--color-faint)]">{label}</div>
    </div>
  );
}
function LinkRow({ icon, href, text, label }: { icon: Parameters<typeof Icon>[0]["name"]; href: string; text: string; label: string }) {
  return (
    <a href={href} className="flex items-center gap-2 px-3 py-2 rounded-lg border-[1.5px] border-[#e4e8f0] hover:bg-[#f5f7fb] text-[12.5px] font-bold text-[var(--color-ink)]">
      <Icon name={icon} size={15} className="text-[var(--color-muted)]" />
      <span className="flex-1 truncate">{text}</span>
      <span className="text-[var(--color-primary)] flex-none">{label} ›</span>
    </a>
  );
}
function Stepper({ label, value, disabled, onSet }: { label: string; value: number | null; disabled?: boolean; onSet: (v: number | null) => void }) {
  const v = value ?? 0;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[12.5px] font-bold text-[var(--color-muted)] flex-1">{label}</span>
      <button disabled={disabled} onClick={() => onSet(v <= 1 ? null : v - 1)} className="w-8 h-8 rounded-lg border-[1.5px] border-[#e4e8f0] text-[var(--color-muted)] disabled:opacity-50"><Icon name="minus" size={14} /></button>
      <span className="w-8 text-center text-[13px] font-extrabold tabular-nums">{value ?? "—"}</span>
      <button disabled={disabled} onClick={() => onSet(v + 1)} className="w-8 h-8 rounded-lg border-[1.5px] border-[#e4e8f0] text-[var(--color-muted)] disabled:opacity-50"><Icon name="plus" size={14} /></button>
    </div>
  );
}
function Toggle({ label, on, disabled, onToggle }: { label: string; on: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button disabled={disabled} onClick={onToggle} className={`flex-1 h-10 rounded-xl text-[12.5px] font-extrabold border-[1.5px] disabled:opacity-50 ${on ? "bg-[#fbf1e0] text-[#b4670a] border-[#f0d9a8]" : "bg-white text-[var(--color-muted)] border-[#e4e8f0]"}`}>
      {label}: {on ? "פעיל" : "כבוי"}
    </button>
  );
}
