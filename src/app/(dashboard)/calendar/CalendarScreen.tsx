"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/shared/Icon";
import { addDays, formatFullDate } from "@/lib/dates";
import type { PaymentState } from "@/lib/inventory-rules";
import type { CalendarData, CalendarView } from "./types";
import { VIEW_DAYS } from "./types";
import { CalendarGrid } from "./CalendarGrid";
import { BookingPanel, type BookingPrefill } from "@/components/reservations/BookingPanel";
import { EditReservationPanel } from "@/components/reservations/EditReservationPanel";
import { ClosurePanel, type ClosurePrefill } from "./ClosurePanel";

export type LookupItem = { id: string; key: string; label: string; color: string | null };

export type CalendarCan = {
  create: boolean;
  edit: boolean;
  cancel: boolean;
  close: boolean;
  viewReservation: boolean;
};

const VIEW_LABELS: Record<CalendarView, string> = {
  week: "שבוע",
  "3w": "3 שבועות",
  month: "30 יום",
};

export function CalendarScreen({
  data,
  view,
  statusItems,
  paymentMethods,
  bookingSources,
  can,
}: {
  data: CalendarData;
  view: CalendarView;
  statusItems: LookupItem[];
  paymentMethods: LookupItem[];
  bookingSources: LookupItem[];
  can: CalendarCan;
}) {
  const router = useRouter();
  const [paymentFilter, setPaymentFilter] = useState<PaymentState | "all">("all");
  const [booking, setBooking] = useState<BookingPrefill | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [closure, setClosure] = useState<ClosurePrefill | null>(null);

  const navigate = useCallback(
    (from: string, v: CalendarView) => {
      router.push(`/calendar?view=${v}&from=${from}`);
    },
    [router],
  );

  const statusColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of statusItems) if (s.color) m.set(s.key, s.color);
    return m;
  }, [statusItems]);
  const statusLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of statusItems) m.set(s.key, s.label);
    return m;
  }, [statusItems]);

  const rangeEnd = addDays(data.from, data.days - 1);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* ---- toolbar ---- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-[18.5px] font-extrabold text-ink">יומן חדרים</h1>
          <span className="rounded-full bg-primary-050 px-3 py-1 text-xs font-semibold text-primary">
            {data.rooms.length} יחידות
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* view switcher — Tabs variation 3 */}
          <div className="flex rounded-xl bg-[#f4f2fc] p-1">
            {(Object.keys(VIEW_LABELS) as CalendarView[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => navigate(data.from, v)}
                className={`min-h-[36px] rounded-lg px-4 text-sm transition-colors ${
                  view === v
                    ? "bg-white font-semibold text-primary shadow-sm"
                    : "font-medium text-muted hover:text-ink"
                }`}
              >
                {VIEW_LABELS[v]}
              </button>
            ))}
          </div>

          {/* range nav — RTL: earlier dates on the right, later on the left */}
          <div className="flex items-center gap-1 rounded-xl border border-line bg-surface px-2 py-1">
            <button
              type="button"
              aria-label="טווח קודם"
              onClick={() => navigate(addDays(data.from, -VIEW_DAYS[view]), view)}
              className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-hover"
            >
              <Icon name="chevron-right" size={18} />
            </button>
            <span className="min-w-[178px] text-center text-sm font-semibold text-ink" dir="ltr">
              {formatFullDate(data.from)} – {formatFullDate(rangeEnd)}
            </span>
            <button
              type="button"
              aria-label="טווח הבא"
              onClick={() => navigate(addDays(data.from, VIEW_DAYS[view]), view)}
              className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-hover"
            >
              <Icon name="chevron-left" size={18} />
            </button>
          </div>

          <button
            type="button"
            onClick={() => navigate(data.today, view)}
            className="btn btn-outline !min-h-[44px] text-primary"
          >
            היום
          </button>
        </div>
      </div>

      {/* ---- KPI row (all real DB data, §10.2) ---- */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <KpiOccupancy pct={data.kpis.occupancyPct} delta={data.kpis.occupancyDeltaPct} />
        <KpiCard
          icon="users-round"
          label="אורחים בבית"
          value={String(data.kpis.guestsInHouse)}
          sub={`${data.kpis.occupiedToday}/${data.kpis.sellableToday} חדרים תפוסים`}
        />
        <KpiCard icon="login" label="הגעות היום" value={String(data.kpis.arrivalsToday)} />
        <KpiCard icon="logout" label="יציאות היום" value={String(data.kpis.departuresToday)} />
      </div>

      {/* ---- payment legend / filter ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <LegendChip
          active={paymentFilter === "all"}
          onClick={() => setPaymentFilter("all")}
          label="הכל"
          dot="#1B2233"
        />
        <LegendChip
          active={paymentFilter === "unpaid"}
          onClick={() => setPaymentFilter("unpaid")}
          label="לא שולם"
          dot="#DC2626"
        />
        <LegendChip
          active={paymentFilter === "partial"}
          onClick={() => setPaymentFilter("partial")}
          label="שולם חלקית"
          dot="#0EA47B"
        />
        <LegendChip
          active={paymentFilter === "paid"}
          onClick={() => setPaymentFilter("paid")}
          label="שולם מלא"
          dot="#16A34A"
        />
      </div>

      {/* ---- the board ---- */}
      <CalendarGrid
        data={data}
        view={view}
        paymentFilter={paymentFilter}
        statusColor={statusColor}
        statusLabel={statusLabel}
        can={can}
        onOpenReservation={(id) => can.viewReservation && setEditId(id)}
        onNewBooking={(prefill) => can.create && setBooking(prefill)}
        onNewClosure={(prefill) => can.close && setClosure(prefill)}
      />

      <p className="text-xs text-faint">
        גרירת הזמנה מזיזה תאריכים או חדר · הפס בקצה השמאלי משנה תאריך עזיבה · לחיצה על
        הזמנה פותחת את כרטיס ההזמנה · לחיצה כפולה על תא ריק פותחת הזמנה חדשה · לחיצה על
        סטטוס תשלום מסננת
      </p>

      {/* ---- panels ---- */}
      <BookingPanel
        open={booking !== null}
        onClose={() => setBooking(null)}
        prefill={booking ?? {}}
        bookingSources={bookingSources}
        paymentMethods={paymentMethods}
      />
      <EditReservationPanel
        reservationId={editId}
        onClose={() => setEditId(null)}
        bookingSources={bookingSources}
        paymentMethods={paymentMethods}
        statusItems={statusItems}
        canEdit={can.edit}
        canCancel={can.cancel}
      />
      <ClosurePanel
        open={closure !== null}
        onClose={() => setClosure(null)}
        prefill={closure ?? {}}
        rooms={data.rooms}
      />
    </div>
  );
}

// ---- KPI building blocks (DESIGN_SYSTEM card + accent icon square) ----

function KpiCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-line bg-surface p-5 shadow-card">
      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-primary-050 text-primary">
        <Icon name={icon} size={22} />
      </span>
      <div className="min-w-0">
        <p className="text-sm text-muted">{label}</p>
        <p className="text-2xl font-extrabold text-ink">
          {value}
          {sub ? <span className="ms-2 text-xs font-medium text-faint">{sub}</span> : null}
        </p>
      </div>
    </div>
  );
}

function KpiOccupancy({ pct, delta }: { pct: number; delta: number }) {
  const r = 20;
  const c = 2 * Math.PI * r;
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-line bg-surface p-5 shadow-card">
      <svg width="52" height="52" viewBox="0 0 52 52" className="-rotate-90 shrink-0">
        <circle cx="26" cy="26" r={r} fill="none" stroke="#E7EAF1" strokeWidth="6" />
        <circle
          cx="26"
          cy="26"
          r={r}
          fill="none"
          stroke="#2540C8"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
        />
      </svg>
      <div>
        <p className="text-sm text-muted">תפוסה היום</p>
        <div className="flex items-center gap-2">
          <p className="text-2xl font-extrabold text-ink">{pct}%</p>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              delta >= 0 ? "bg-status-success-050 text-[#15803D]" : "bg-status-danger-050 text-[#B4231F]"
            }`}
            dir="ltr"
          >
            {delta >= 0 ? "+" : ""}
            {delta}% מאתמול
          </span>
        </div>
      </div>
    </div>
  );
}

function LegendChip({
  active,
  onClick,
  label,
  dot,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  dot: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex min-h-[36px] items-center gap-2 rounded-full border px-4 py-1 text-sm transition-colors ${
        active
          ? "border-primary bg-primary-050 font-semibold text-primary"
          : "border-line bg-surface font-medium text-text2 hover:bg-hover"
      }`}
    >
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: dot }} />
      {label}
    </button>
  );
}
