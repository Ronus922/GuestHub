"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/shared/Icon";
import {
  addDays,
  dayOfWeek,
  eachDay,
  formatFullDate,
  hebrewMonthYear,
  HEBREW_DAY_LETTERS,
  type DateOnly,
} from "@/lib/dates";
import type { PaymentState } from "@/lib/inventory-rules";
import { paymentTriplet } from "@/lib/status-colors";
import type { CalendarData, CalendarView } from "./types";
import { VIEW_DAYS } from "./types";
import { CalendarGrid } from "./CalendarGrid";
import { EditReservationPanel } from "@/components/reservations/EditReservationPanel";
import { useNewReservation } from "@/components/reservations/NewReservationProvider";
import { ClosurePanel, type ClosurePrefill } from "./ClosurePanel";

export type LookupItem = { id: string; key: string; label: string; color: string | null };

export type CalendarCan = {
  create: boolean;
  edit: boolean;
  cancel: boolean;
  close: boolean;
  viewReservation: boolean;
  saveCard: boolean;
  revealCard: boolean;
  chargeCard: boolean;
};

// ONE open panel at a time — the single source of truth for the edit /
// closure side panels over the calendar (D41). New bookings go through the
// global shared BookingPanel (D48, useNewReservation), not a local instance.
type PanelState =
  | { kind: "edit"; id: string }
  | { kind: "closure"; prefill: ClosurePrefill }
  | null;

const VIEW_LABELS: Record<CalendarView, string> = {
  week: "שבוע",
  "3w": "3 שבועות",
  month: "30 יום",
};

// The legend IS the payment filter, so every dot is the §3.1 dot of the state it
// filters — read from the ONE source (status-colors.ts), never re-typed. "הכל"
// has no state, so it wears the neutral dot (.cb-dot-all).
const LEGEND: { key: PaymentState | "all"; label: string }[] = [
  { key: "all", label: "הכל" },
  { key: "unpaid", label: "ממתין לתשלום" },
  { key: "partial", label: "שולם חלקית" },
  { key: "paid", label: "שולם מלא" },
  { key: "overpaid", label: "שולם ביתר" },
];

export function CalendarScreen({
  data,
  view,
  statusItems,
  paymentMethods,
  bookingSources,
  workflowStatuses = [],
  ratePlans,
  can,
  vatRate,
}: {
  data: CalendarData;
  view: CalendarView;
  statusItems: LookupItem[];
  paymentMethods: LookupItem[];
  bookingSources: LookupItem[];
  workflowStatuses?: LookupItem[];
  ratePlans: { id: string; name: string; code: string }[];
  can: CalendarCan;
  vatRate: number;
}) {
  const router = useRouter();
  const { openNewReservation } = useNewReservation();
  const [paymentFilter, setPaymentFilter] = useState<PaymentState | "all">("all");
  const [panel, setPanel] = useState<PanelState>(null);
  const closePanel = useCallback(() => setPanel(null), []);

  const navigate = useCallback(
    (from: string, v: CalendarView) => {
      router.push(`/calendar?view=${v}&from=${from}`);
    },
    [router],
  );

  const statusLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of statusItems) m.set(s.key, s.label);
    return m;
  }, [statusItems]);

  const rangeEnd = addDays(data.from, data.days - 1);

  return (
    <div className="cb-screen flex h-full flex-col" dir="rtl">
      {/* ---- toolbar (reference .hd) ---- */}
      <div className="flex flex-wrap items-center gap-3 px-[26px] pt-[18px]">
        <h1 className="h1">יומן חדרים</h1>
        <span className="chip chip-neutral">
          <span className="ltr-num">{data.rooms.length}</span> יחידות
        </span>
        <span className="flex-1" />
        <div className="cb-seg">
          {(Object.keys(VIEW_LABELS) as CalendarView[]).map((v) => (
            <button
              key={v}
              type="button"
              className={view === v ? "on" : ""}
              onClick={() => navigate(data.from, v)}
            >
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>
        <div className="cb-rangebox relative">
          <button
            type="button"
            className="icon-btn"
            aria-label="תקופה קודמת"
            onClick={() => navigate(addDays(data.from, -VIEW_DAYS[view]), view)}
          >
            <Icon name="chevron-right" size={20} />
          </button>
          <RangeDatePicker
            from={data.from}
            rangeEnd={rangeEnd}
            today={data.today}
            onPick={(d) => navigate(d, view)}
          />
          <button
            type="button"
            className="icon-btn"
            aria-label="תקופה הבאה"
            onClick={() => navigate(addDays(data.from, VIEW_DAYS[view]), view)}
          >
            <Icon name="chevron-left" size={20} />
          </button>
        </div>
        <button type="button" className="cb-todaybtn" onClick={() => navigate(data.today, view)}>
          היום
        </button>
      </div>

      {/* ---- KPI row (all real DB data, §10.2) ---- */}
      <div className="grid grid-cols-2 gap-3 px-[26px] pt-[14px] xl:grid-cols-4">
        <KpiOccupancy pct={data.kpis.occupancyPct} delta={data.kpis.occupancyDeltaPct} />
        <div className="card cb-kpi">
          <span className="cb-kpi-ic k-ok">
            <Icon name="users-round" size={20} />
          </span>
          <div className="min-w-0">
            <p className="cb-kpi-l">אורחים בבית</p>
            <p className="cb-kpi-v">
              {data.kpis.guestsInHouse}
              <span className="cb-u">
                {" "}
                · {data.kpis.occupiedToday}/{data.kpis.sellableToday} חדרים
              </span>
            </p>
          </div>
        </div>
        <div className="card cb-kpi">
          <span className="cb-kpi-ic k-warn">
            <Icon name="login" size={20} />
          </span>
          <div className="min-w-0">
            <p className="cb-kpi-l">הגעות היום</p>
            <p className="cb-kpi-v">{data.kpis.arrivalsToday}</p>
          </div>
        </div>
        <div className="card cb-kpi">
          <span className="cb-kpi-ic k-info">
            <Icon name="logout" size={20} />
          </span>
          <div className="min-w-0">
            <p className="cb-kpi-l">יציאות היום</p>
            <p className="cb-kpi-v">{data.kpis.departuresToday}</p>
          </div>
        </div>
      </div>

      {/* ---- payment legend / filter — canonical .chip.clickable (§3) ---- */}
      <div className="flex flex-wrap items-center gap-1 px-[26px] pt-[10px]">
        {LEGEND.map((l) => (
          <button
            key={l.key}
            type="button"
            aria-pressed={paymentFilter === l.key}
            className={`chip clickable ${paymentFilter === l.key ? "on" : ""}`}
            onClick={() => setPaymentFilter(l.key)}
          >
            {l.key === "all" ? (
              <span className="dot cb-dot-all" />
            ) : (
              <span className="dot" style={{ background: paymentTriplet(l.key).dot }} />
            )}
            {l.label}
          </button>
        ))}
      </div>

      {/* ---- the board ---- */}
      <div className="mx-[26px] mb-[6px] mt-3 flex min-h-0 flex-1 flex-col">
        <CalendarGrid
          data={data}
          paymentFilter={paymentFilter}
          statusLabel={statusLabel}
          can={can}
          onOpenReservation={(id) => can.viewReservation && setPanel({ kind: "edit", id })}
          onNewBooking={openNewReservation}
          onNewClosure={(prefill) => can.close && setPanel({ kind: "closure", prefill })}
        />
      </div>

      <p className="cb-hint px-[30px] pb-[14px] pt-[6px]">
        גרירת הזמנה מזיזה תאריכים או חדר · הפס בקצה השמאלי משנה תאריך עזיבה · לחיצה על
        הזמנה פותחת עריכה · ריחוף מציג כרטיס פרטים · גרירה על תאים ריקים יוצרת הזמנה
        חדשה · לחיצה על סטטוס תשלום מסננת
      </p>

      {/* ---- side panels (one open at a time; calendar stays mounted).
           New bookings use the global shared panel (D48). ---- */}
      <EditReservationPanel
        reservationId={panel?.kind === "edit" ? panel.id : null}
        onClose={closePanel}
        bookingSources={bookingSources}
        paymentMethods={paymentMethods}
        ratePlans={ratePlans}
        statusItems={statusItems}
        workflowStatuses={workflowStatuses}
        canEdit={can.edit}
        canCancel={can.cancel}
        vatRate={vatRate}
        canSaveCard={can.saveCard}
        canRevealCard={can.revealCard}
        canChargeCard={can.chargeCard}
      />
      <ClosurePanel
        open={panel?.kind === "closure"}
        onClose={closePanel}
        prefill={panel?.kind === "closure" ? panel.prefill : {}}
        rooms={data.rooms}
      />
    </div>
  );
}

// Toolbar date picker (§7): the range label is a real button that opens an
// RTL month popover above the board and its sticky layers; picking a day
// navigates the board to start at that date. Escape / outside click close
// without changing the range.
function RangeDatePicker({
  from,
  rangeEnd,
  today,
  onPick,
}: {
  from: DateOnly;
  rangeEnd: DateOnly;
  today: DateOnly;
  onPick: (d: DateOnly) => void;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState<DateOnly>(monthStart(from));
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const t = setTimeout(() => window.addEventListener("click", onDoc), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("click", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const gridStart = addDays(month, -dayOfWeek(month));
  const cells = eachDay(gridStart, addDays(gridStart, 42));

  return (
    <div ref={ref} className="contents">
      <button
        type="button"
        className="cb-rl"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="בחירת תאריך תצוגה"
        onClick={() => {
          setMonth(monthStart(from));
          setOpen((v) => !v);
        }}
      >
        {formatFullDate(from)} – {formatFullDate(rangeEnd)}
      </button>
      {open && (
        <div className="cb-dpop" role="dialog" aria-label="בחירת תאריך">
          <div className="cb-dpop-h">
            <button
              type="button"
              className="icon-btn"
              aria-label="חודש קודם"
              onClick={() => setMonth(monthStart(addDays(month, -1)))}
            >
              <Icon name="chevron-right" size={17} />
            </button>
            <span className="cb-dpop-m">{hebrewMonthYear(month)}</span>
            <button
              type="button"
              className="icon-btn"
              aria-label="חודש הבא"
              onClick={() => setMonth(monthStart(addDays(month, 35)))}
            >
              <Icon name="chevron-left" size={17} />
            </button>
          </div>
          <div className="cb-dpop-g">
            {HEBREW_DAY_LETTERS.map((l) => (
              <span key={l} className="cb-dpop-w">
                {l}
              </span>
            ))}
            {cells.map((d) => (
              <button
                key={d}
                type="button"
                className={`cb-dpop-d ${d.slice(0, 7) !== month.slice(0, 7) ? "out" : ""} ${
                  d === today ? "tdy" : ""
                } ${d === from ? "on" : ""}`}
                onClick={() => {
                  setOpen(false);
                  onPick(d);
                }}
              >
                {Number(d.slice(8, 10))}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function monthStart(d: DateOnly): DateOnly {
  return `${d.slice(0, 8)}01`;
}

// Occupancy KPI — the ring is a token conic-gradient (no inline <svg>, §10) and
// the delta is a canonical .chip wearing an approved §3.1 family.
function KpiOccupancy({ pct, delta }: { pct: number; delta: number }) {
  const up = delta >= 0;
  return (
    <div className="card cb-kpi">
      <span
        className="cb-donut"
        style={{ "--cb-pct": Math.min(Math.max(pct, 0), 100) } as React.CSSProperties}
        aria-hidden
      >
        <span className="ltr-num">{pct}%</span>
      </span>
      <div className="min-w-0">
        <p className="cb-kpi-l">תפוסה היום</p>
        <div className="flex items-center gap-2">
          <span className="cb-kpi-v">{pct}%</span>
          <span className={`chip ${up ? "chip-paid" : "chip-unpaid"}`}>
            <Icon name={up ? "trending-up" : "trending-down"} size={13.5} />
            <span className="ltr-num">
              {up ? "+" : ""}
              {delta}%
            </span>{" "}
            מאתמול
          </span>
        </div>
      </div>
    </div>
  );
}
