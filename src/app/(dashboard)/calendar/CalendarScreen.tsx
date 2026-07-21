"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/shared/Icon";
import { addDays, formatFullDate, formatDayHebMonth, type DateOnly } from "@/lib/dates";
import type { PaymentState } from "@/lib/inventory-rules";
import { paymentTriplet } from "@/lib/status-colors";
import { CHANNEL_CONFIG, CHANNEL_ORDER } from "@/lib/colors";
import { ChannelBadge } from "@/components/shared/ChannelBadge";
import type { CalendarData } from "./types";
import { CALENDAR_DAYS } from "./types";
import { CalendarGrid } from "./CalendarGrid";
import { MobileCalendar } from "./MobileCalendar";
import { MobileDetailSheet } from "./MobileDetailSheet";
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

// The legend IS the payment filter, so every dot is the §3.1 dot of the state it
// filters — read from the ONE source (status-colors.ts), never re-typed. "הכל"
// has no state, so it wears the neutral dot (.cb-dot-all). Only the four REAL
// payment states are shown (the reference's extra chips can never match, §3).
const LEGEND: { key: PaymentState | "all"; label: string }[] = [
  { key: "all", label: "הכל" },
  { key: "unpaid", label: "ממתין לתשלום" },
  { key: "partial", label: "שולם חלקית" },
  { key: "paid", label: "שולם מלא" },
  { key: "overpaid", label: "שולם ביתר" },
];

// Desktop granular jump nav (§5). DOM order is RTL-visual: the first child sits
// on the RIGHT, so [-14…-1] land right of "היום" and [+1…+14] left of it —
// exactly the reference row read right-to-left.
const DESKTOP_JUMPS: (number | "today")[] = [-14, -7, -1, "today", 1, 7, 14];
const MOBILE_JUMPS: (number | "today")[] = [-5, -1, "today", 1, 5];
const DAY_OPTIONS = [3, 5, 7] as const;

export function CalendarScreen({
  data,
  statusItems,
  paymentMethods,
  bookingSources,
  workflowStatuses = [],
  ratePlans,
  can,
  vatRate,
}: {
  data: CalendarData;
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
  // mobile: which reservation's quick-view bottom-sheet is open (null = none)
  const [sheetId, setSheetId] = useState<string | null>(null);
  // mobile: how many days the timeline slices out of the fetched window (§4)
  const [mobileDays, setMobileDays] = useState<3 | 5 | 7>(5);
  const closePanel = useCallback(() => setPanel(null), []);

  const navigate = useCallback(
    (from: string) => {
      router.push(`/calendar?from=${from}`);
    },
    [router],
  );

  const openReservation = useCallback(
    (id: string) => {
      if (!can.viewReservation) return;
      setSheetId(null);
      setPanel({ kind: "edit", id });
    },
    [can.viewReservation],
  );

  const statusLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of statusItems) m.set(s.key, s.label);
    return m;
  }, [statusItems]);

  const rangeEnd = addDays(data.from, data.days - 1);
  const mobileEnd = addDays(data.from, mobileDays - 1);

  const jumpLabel = (n: number) => (n > 0 ? `+${n}` : `${n}`);

  return (
    <div className="cb-screen flex h-full flex-col" dir="rtl">
      {/* ============ DESKTOP (md and up) ============ */}
      {/* ponytail: both trees mount; CSS breakpoints show one. Zero hydration
          flash and no isMobile guess; the hidden 12-row grid is negligible. */}
      <div className="hidden min-h-0 flex-1 flex-col md:flex">
        {/* ---- toolbar (reference .hd) ---- */}
        <div className="flex flex-wrap items-center gap-3 px-[26px] pt-[18px]">
          <h1 className="h1">יומן חדרים</h1>
          <span className="chip chip-neutral">
            <span className="ltr-num">{data.rooms.length}</span> יחידות
          </span>
          <span className="flex-1" />
          {/* reference order (RTL, right→left): range box nearest the title,
              then the date-jump button, then the jumpbox on the far left */}
          <div className="cb-crb">
            <button
              type="button"
              className="cb-crb-nav"
              aria-label="תקופה קודמת"
              onClick={() => navigate(addDays(data.from, -CALENDAR_DAYS))}
            >
              <Icon name="chevron-right" size={17} />
            </button>
            <span className="cb-range-label">
              {formatFullDate(data.from)} – {formatFullDate(rangeEnd)}
            </span>
            <button
              type="button"
              className="cb-crb-nav"
              aria-label="תקופה הבאה"
              onClick={() => navigate(addDays(data.from, CALENDAR_DAYS))}
            >
              <Icon name="chevron-left" size={17} />
            </button>
          </div>
          <DateJumpButton value={data.from} onPick={navigate} />
          <div className="cb-jumpbox">
            {DESKTOP_JUMPS.map((n) =>
              n === "today" ? (
                <button
                  key="today"
                  type="button"
                  className="cb-jb td"
                  onClick={() => navigate(data.today)}
                >
                  <Icon name="today" size={17} />
                  היום
                </button>
              ) : (
                <button
                  key={n}
                  type="button"
                  className="cb-jb"
                  aria-label={`${n > 0 ? "קדימה" : "אחורה"} ${Math.abs(n)} ימים`}
                  onClick={() => navigate(addDays(data.from, n))}
                >
                  {jumpLabel(n)}
                </button>
              ),
            )}
          </div>
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

        {/* ---- payment legend / filter + channel legend ---- */}
        <PaymentLegend filter={paymentFilter} onFilter={setPaymentFilter} />

        {/* ---- the board ---- */}
        <div className="mx-[26px] mb-[6px] mt-3 flex min-h-0 flex-1 flex-col">
          <CalendarGrid
            data={data}
            paymentFilter={paymentFilter}
            statusLabel={statusLabel}
            can={can}
            onOpenReservation={openReservation}
            onNewBooking={openNewReservation}
            onNewClosure={(prefill) => can.close && setPanel({ kind: "closure", prefill })}
          />
        </div>

        <p className="cb-hint px-[30px] pb-[14px] pt-[6px]">
          גרירת הזמנה מזיזה תאריכים או חדר · הפס בקצה השמאלי משנה תאריך עזיבה · לחיצה על
          הזמנה פותחת עריכה · ריחוף מציג כרטיס פרטים · גרירה על תאים ריקים יוצרת הזמנה
          חדשה · לחיצה על סטטוס תשלום מסננת
        </p>
      </div>

      {/* ============ MOBILE (below md) — reference: ציר זמן ============ */}
      <div className="flex min-h-0 flex-1 flex-col md:hidden">
        {/* sticky header — calendar controls only; the app shell owns the
            hamburger + nav drawer (Shell.tsx), so we never rebuild them. */}
        <div className="cb-m-head">
          <div className="cb-m-row1">
            <span className="cb-m-title">יומן חדרים</span>
            <span className="flex-1" />
            <div className="cb-m-seg">
              {DAY_OPTIONS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={mobileDays === n ? "on" : ""}
                  onClick={() => setMobileDays(n)}
                >
                  {n} ימים
                </button>
              ))}
            </div>
          </div>
          <div className="cb-m-nav">
            {MOBILE_JUMPS.map((n) =>
              n === "today" ? (
                <button key="today" type="button" className="td" onClick={() => navigate(data.today)}>
                  היום
                </button>
              ) : (
                <button
                  key={n}
                  type="button"
                  aria-label={`${n > 0 ? "קדימה" : "אחורה"} ${Math.abs(n)} ימים`}
                  onClick={() => navigate(addDays(data.from, n))}
                >
                  {jumpLabel(n)}
                </button>
              ),
            )}
          </div>
          <div className="cb-m-daterow">
            <DateJumpButton value={data.from} onPick={navigate} variant="mobile" />
            <span className="cb-m-range">
              {formatDayHebMonth(data.from)} – {formatDayHebMonth(mobileEnd)}{" "}
              {mobileEnd.slice(0, 4)}
            </span>
          </div>
        </div>

        <MobileCalendar
          data={data}
          days={mobileDays}
          canCreate={can.create}
          onBarTap={(id) => can.viewReservation && setSheetId(id)}
          onEmptyTap={(roomId, checkIn) =>
            can.create &&
            openNewReservation({ roomId, checkIn, source: "calendar_mobile" })
          }
        />

        <div className="cb-m-legend">
          <span className="cb-m-legend-h">ערוצים:</span>
          {CHANNEL_ORDER.map((ch) => (
            <span key={ch} className="ch-leg">
              <ChannelBadge channel={ch} size="sm" />
              {CHANNEL_CONFIG[ch].name}
            </span>
          ))}
        </div>
        <p className="cb-m-hint">
          לחיצה על פס הזמנה פותחת כרטיס פעולות · צבע הפס לפי סטטוס תשלום
        </p>
      </div>

      {/* ---- side panels (one open at a time; both trees stay mounted).
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

      {/* mobile quick-view: read-only card whose actions open the real flow */}
      <MobileDetailSheet
        stay={sheetId ? (data.stays.find((s) => s.rr_id === sheetId) ?? null) : null}
        rooms={data.rooms}
        statusLabel={statusLabel}
        today={data.today}
        onClose={() => setSheetId(null)}
        onOpenReservation={openReservation}
      />
    </div>
  );
}

// The payment filter + channel legend row, shared by the desktop layout.
function PaymentLegend({
  filter,
  onFilter,
}: {
  filter: PaymentState | "all";
  onFilter: (f: PaymentState | "all") => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 px-[26px] pt-[10px]">
      {LEGEND.map((l) => (
        <button
          key={l.key}
          type="button"
          aria-pressed={filter === l.key}
          className={`cb-leg ${filter === l.key ? "on" : ""}`}
          onClick={() => onFilter(l.key)}
        >
          {l.key === "all" ? (
            <span className="dot cb-dot-all" />
          ) : (
            <span className="dot" style={{ background: paymentTriplet(l.key).dot }} />
          )}
          {l.label}
        </button>
      ))}
      {/* channel legend — visual identification only, no filtering. Same badge
          component + ONE config as the pill and the popover. */}
      <span className="ch-leg cb-leg-h">ערוצים</span>
      {CHANNEL_ORDER.map((ch) => (
        <span key={ch} className="ch-leg">
          <ChannelBadge channel={ch} size="sm" />
          {CHANNEL_CONFIG[ch].name}
        </span>
      ))}
    </div>
  );
}

// Jump-to-date (§6, mandated mechanism): a native <input type="date"> whose
// ::-webkit-calendar-picker-indicator is stretched over the whole button, so a
// click anywhere opens the browser picker in every Chromium build. showPicker()
// is a best-effort first attempt only (throws in cross-origin iframes).
function DateJumpButton({
  value,
  onPick,
  variant,
}: {
  value: DateOnly;
  onPick: (d: DateOnly) => void;
  variant?: "mobile";
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <div
      className={variant === "mobile" ? "cb-datejump-m" : "cb-datejump"}
      title="קפיצה לתאריך"
      onClick={() => {
        try {
          ref.current?.showPicker();
        } catch {
          /* cross-origin / unsupported → the stretched indicator handles it */
        }
      }}
    >
      <Icon name="calendar" size={20} />
      <input
        ref={ref}
        type="date"
        className="cb-dtpick"
        aria-label="קפיצה לתאריך"
        value={value}
        onChange={(e) => e.target.value && onPick(e.target.value)}
      />
    </div>
  );
}

// Occupancy KPI — the ring is a token conic-gradient (no inline <svg>, §10) with
// an EMPTY centre (the % reads once, as the big stat number). The delta is the
// reference's borderless soft pill (.cb-kpi-delta), not a bordered chip.
function KpiOccupancy({ pct, delta }: { pct: number; delta: number }) {
  const up = delta >= 0;
  return (
    <div className="card cb-kpi">
      <span
        className="cb-donut"
        style={{ "--cb-pct": Math.min(Math.max(pct, 0), 100) } as React.CSSProperties}
        aria-hidden
      >
        <span className="cb-donut-hole" />
      </span>
      <div className="min-w-0">
        <p className="cb-kpi-l">תפוסה היום</p>
        <div className="flex items-center gap-2">
          <span className="cb-kpi-v">{pct}%</span>
          <span className={`cb-kpi-delta ${up ? "up" : "down"}`}>
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
