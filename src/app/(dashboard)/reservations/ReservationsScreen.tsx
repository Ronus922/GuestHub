"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon, type IconName } from "@/components/shared/Icon";
import { readableTextColor } from "@/lib/colors";
import { EditReservationPanel } from "@/components/reservations/EditReservationPanel";
import type { LookupItem } from "@/app/(dashboard)/calendar/CalendarScreen";
import type {
  ListFilters,
  ListRow,
  ListTab,
  QuickFilter,
  ReservationsListData,
} from "./data";

// ============================================================
// /reservations — רשימת הזמנות (D77 §17/§18), 1:1 to ref/html/Orders.html +
// ref/screens/Orders.png. Server-driven filtering: every control writes the
// URL (router.replace) and the force-dynamic page re-queries — so realtime
// router.refresh() (RealtimeProvider) keeps the list AND the tab counts live
// with no second data path. Row click opens the EXISTING reservation
// SidePanel — never a second editor.
// ============================================================

const TABS: { key: ListTab; label: string }[] = [
  { key: "all", label: "הכל" },
  { key: "confirmed", label: "מאושר" },
  { key: "inhouse", label: "In House" },
  { key: "out", label: "יצא" },
  { key: "cancelled", label: "בוטל" },
  { key: "noshow", label: "No Show" },
];

const QUICK_CHIPS: { key: QuickFilter; label: string; icon: IconName }[] = [
  { key: "created24", label: "נוצרו ב-24 שעות", icon: "refresh" },
  { key: "arrivals", label: "הגעות היום", icon: "login" },
  { key: "arrivals24", label: "הגעות ב-24 שעות", icon: "calendar-plus" },
  { key: "departures", label: "עזיבות היום", icon: "logout" },
  { key: "inhouse", label: "שוהים", icon: "hotel" },
  { key: "unpaid", label: "הזמנות שלא שולמו", icon: "finance" },
  { key: "partial", label: "שולם חלקית", icon: "percent" },
  { key: "pending", label: "הזמנות ממתינות", icon: "moon" },
  { key: "missing_docs", label: "חסר מסמכים", icon: "documents" },
  { key: "invalid_card", label: "כרטיס לא עבר", icon: "credit-card" },
  { key: "cancelled24", label: "בוטלו ביממה האחרונה", icon: "circle-slash" },
  { key: "cancelled_today", label: "בוטלו היום", icon: "circle-slash" },
  { key: "noshow_candidates", label: "מועמדי No-show", icon: "warning" },
];

const LIFECYCLE_PILL: Record<string, { label: string; cls: string; icon: IconName }> = {
  confirmed: { label: "מאושר", cls: "confirmed", icon: "check" },
  checked_in: { label: "In House", cls: "inhouse", icon: "hotel" },
  checked_out: { label: "צ׳ק אאוט", cls: "out", icon: "logout" },
  cancelled: { label: "בוטל", cls: "cancelled", icon: "circle-slash" },
  draft: { label: "טיוטה", cls: "draft", icon: "moon" },
  no_show: { label: "No Show", cls: "noshow", icon: "warning" },
  blocked: { label: "חסום", cls: "out", icon: "lock" },
};

const PAY_LABEL: Record<string, string> = {
  unpaid: "לא שולם",
  partial: "שולם חלקית",
  paid: "שולם מלא",
  overpaid: "שולם ביתר",
};

const CANCEL_ORIGIN_SHORT: Record<string, string> = {
  guest_booking_page: "האורח",
  operator_direct_booking: "המלון",
  ota_revision: "הערוץ",
  booking_com: "Booking.com",
  expedia: "Expedia",
  invalid_card: "כרטיס לא תקין",
  no_show: "אי-הגעה",
  external: "חיצוני",
  system: "מערכת",
};

const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const money = (n: number, currency: string) => {
  const sym = currency === "ILS" ? "₪" : currency === "USD" ? "$" : currency === "EUR" ? "€" : `${currency} `;
  const rounded = Math.round(n * 100) / 100;
  const s = Number.isInteger(rounded)
    ? rounded.toLocaleString("en-US")
    : rounded.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sym}${s}`;
};

export function ReservationsScreen({
  data,
  filters,
  bookingSources,
  paymentMethods,
  workflowStatuses,
  statusItems,
  ratePlans,
  rooms,
  can,
  vatRate,
}: {
  data: ReservationsListData;
  filters: ListFilters;
  bookingSources: LookupItem[];
  paymentMethods: LookupItem[];
  workflowStatuses: LookupItem[];
  statusItems: LookupItem[];
  ratePlans: { id: string; name: string; code: string }[];
  rooms: { id: string; room_number: string }[];
  can: {
    edit: boolean;
    cancel: boolean;
    viewReservation: boolean;
    saveCard: boolean;
    revealCard: boolean;
    chargeCard: boolean;
  };
  vatRate: number;
}) {
  const router = useRouter();
  const [panelId, setPanelId] = useState<string | null>(null);
  // local echo of the search box — the URL updates debounced
  const [q, setQ] = useState(filters.q);
  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setQ(filters.q), [filters.q]);

  const apply = (patch: Partial<ListFilters>) => {
    const next = { ...filters, ...patch };
    // the cancellation-origin control exists only on the בוטל tab — leaving
    // it must drop the filter, or other tabs silently show nothing
    if (next.tab !== "cancelled") next.cancellationOrigin = null;
    const p = new URLSearchParams();
    if (next.tab !== "all") p.set("tab", next.tab);
    if (next.q.trim()) p.set("q", next.q.trim());
    if (next.dateType !== "checkin") p.set("dtype", next.dateType);
    if (next.from) p.set("from", next.from);
    if (next.to) p.set("to", next.to);
    if (next.sourceId) p.set("source", next.sourceId);
    if (next.workflowId) p.set("wf", next.workflowId);
    if (next.payment) p.set("pay", next.payment);
    if (next.roomId) p.set("room", next.roomId);
    if (next.cancellationOrigin) p.set("corigin", next.cancellationOrigin);
    if (next.quick) p.set("quick", next.quick);
    const qs = p.toString();
    router.replace(qs ? `/reservations?${qs}` : "/reservations");
  };

  const onSearch = (value: string) => {
    setQ(value);
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => apply({ q: value }), 350);
  };

  const filtersActive =
    filters.q.trim() !== "" ||
    filters.from !== null ||
    filters.to !== null ||
    filters.sourceId !== null ||
    filters.workflowId !== null ||
    filters.payment !== null ||
    filters.roomId !== null ||
    filters.cancellationOrigin !== null ||
    filters.quick !== null;

  const cancelledTab = filters.tab === "cancelled";

  return (
    <div className="rl-app">
      {/* ---- header ---- */}
      <div className="rl-hd">
        <h1 className="rl-hd-t">הזמנות</h1>
        <p className="rl-hd-sub">רשימת ההזמנות הפעילות והסגורות במלון</p>
      </div>

      {/* ---- tabs (right) + search (left) ---- */}
      <div className="rl-toolbar">
        <div className="rl-tabs" role="tablist" aria-label="סטטוס הזמנה">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={filters.tab === t.key}
              className={`rl-tab ${filters.tab === t.key ? "on" : ""}`}
              onClick={() => apply({ tab: t.key })}
            >
              {t.label}
              <span className="rl-cnt">{data.counts[t.key]}</span>
            </button>
          ))}
        </div>
        <span className="rl-sp" />
        <label className="rl-search">
          <Icon name="search" size={22} />
          <input
            value={q}
            placeholder="חיפוש לפי מספר הזמנה, שם אורח, טלפון או חדר…"
            onChange={(e) => onSearch(e.target.value)}
          />
        </label>
      </div>

      {/* ---- filters card ---- */}
      <div className="rl-filters">
        <div className="rl-fbar">
          <div className="rl-fld-g">
            <span className="rl-flbl">סוג תאריך</span>
            <select
              className="rl-fsel"
              value={filters.dateType}
              onChange={(e) => apply({ dateType: e.target.value as ListFilters["dateType"] })}
            >
              <option value="checkin">תאריך כניסה</option>
              <option value="checkout">תאריך יציאה</option>
              <option value="created">תאריך הזמנה</option>
            </select>
          </div>
          <div className="rl-fld-g">
            <span className="rl-flbl">מתאריך</span>
            <input
              type="date"
              className="rl-fdate"
              value={filters.from ?? ""}
              onChange={(e) => apply({ from: e.target.value || null })}
            />
          </div>
          <div className="rl-fld-g">
            <span className="rl-flbl">עד תאריך</span>
            <input
              type="date"
              className="rl-fdate"
              value={filters.to ?? ""}
              onChange={(e) => apply({ to: e.target.value || null })}
            />
          </div>
          <div className="rl-fld-g">
            <span className="rl-flbl">סוכן</span>
            <select
              className="rl-fsel"
              value={filters.sourceId ?? ""}
              onChange={(e) => apply({ sourceId: e.target.value || null })}
            >
              <option value="">כל הסוכנים</option>
              {bookingSources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="rl-fld-g">
            <span className="rl-flbl">סטטוס טיפול</span>
            <select
              className="rl-fsel"
              value={filters.workflowId ?? ""}
              onChange={(e) => apply({ workflowId: e.target.value || null })}
            >
              <option value="">כל הסטטוסים</option>
              {workflowStatuses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
          </div>
          <div className="rl-fld-g">
            <span className="rl-flbl">תשלום</span>
            <select
              className="rl-fsel"
              value={filters.payment ?? ""}
              onChange={(e) =>
                apply({ payment: (e.target.value || null) as ListFilters["payment"] })
              }
            >
              <option value="">כל התשלומים</option>
              <option value="unpaid">לא שולם</option>
              <option value="partial">שולם חלקית</option>
              <option value="paid">שולם מלא</option>
            </select>
          </div>
          <div className="rl-fld-g">
            <span className="rl-flbl">חדר</span>
            <select
              className="rl-fsel"
              style={{ minWidth: 110 }}
              value={filters.roomId ?? ""}
              onChange={(e) => apply({ roomId: e.target.value || null })}
            >
              <option value="">כל החדרים</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.room_number}
                </option>
              ))}
            </select>
          </div>
          {cancelledTab && (
            <div className="rl-fld-g">
              <span className="rl-flbl">מקור ביטול</span>
              <select
                className="rl-fsel"
                value={filters.cancellationOrigin ?? ""}
                onChange={(e) => apply({ cancellationOrigin: e.target.value || null })}
              >
                <option value="">כל המקורות</option>
                {Object.entries(CANCEL_ORIGIN_SHORT).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
          )}
          {filtersActive && (
            <button
              type="button"
              className="rl-clear"
              onClick={() => {
                setQ("");
                apply({
                  q: "",
                  from: null,
                  to: null,
                  sourceId: null,
                  workflowId: null,
                  payment: null,
                  roomId: null,
                  cancellationOrigin: null,
                  quick: null,
                  dateType: "checkin",
                });
              }}
            >
              <Icon name="filter" size={16} />
              ניקוי סינון
            </button>
          )}
        </div>
        <div className="rl-quick">
          <span className="rl-quick-lbl">סינון מהיר:</span>
          {QUICK_CHIPS.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`rl-qchip ${filters.quick === c.key ? "on" : ""}`}
              onClick={() => apply({ quick: filters.quick === c.key ? null : c.key })}
            >
              <Icon name={c.icon} size={17} />
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* ---- table card ---- */}
      <div className="rl-card">
        <div className="rl-twrap thin-scroll">
          <div className="rl-thead rl-rowg">
            <div className="rl-th start">אורח</div>
            <div className="rl-th start">מס׳ הזמנה</div>
            <div className="rl-th">מקור</div>
            <div className="rl-th">טלפון</div>
            <div className="rl-th">חדר</div>
            <div className="rl-th">כניסה</div>
            <div className="rl-th">יציאה</div>
            <div className="rl-th">לילות</div>
            <div className="rl-th">סטטוס</div>
            <div className="rl-th">{cancelledTab ? "ביטול" : "טיפול"}</div>
            <div className="rl-th">תשלום</div>
            <div className="rl-th end">סה״כ</div>
          </div>
          {data.rows.length === 0 ? (
            <div className="rl-empty">
              <Icon name="search" size={44} />
              <p className="rl-empty-t">לא נמצאו הזמנות</p>
              <p className="rl-empty-s">נסו לשנות את הסינון או את מונח החיפוש</p>
            </div>
          ) : (
            data.rows.map((row) => (
              <ReservationRow
                key={row.id}
                row={row}
                cancelledTab={cancelledTab}
                onOpen={() => can.viewReservation && setPanelId(row.id)}
              />
            ))
          )}
        </div>
        {data.truncatedBy > 0 && (
          <p className="rl-truncated">
            מוצגות {data.rows.length} הזמנות; עוד {data.truncatedBy} תואמות את הסינון — צמצמו את
            הסינון או השתמשו בחיפוש
          </p>
        )}
      </div>

      {/* the ONE existing reservation SidePanel — no second editor */}
      <EditReservationPanel
        reservationId={panelId}
        onClose={() => setPanelId(null)}
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
    </div>
  );
}

function ReservationRow({
  row,
  cancelledTab,
  onOpen,
}: {
  row: ListRow;
  cancelledTab: boolean;
  onOpen: () => void;
}) {
  const pill = LIFECYCLE_PILL[row.status] ?? {
    label: row.status,
    cls: "out",
    icon: "info" as IconName,
  };
  const initial = (row.guest_name || "א").slice(0, 1);
  return (
    <div
      className={`rl-rowg rl-trow ${row.payment === "unpaid" && row.status !== "cancelled" ? "unpaid" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="rl-td rl-guest">
        <span className="rl-av">{initial}</span>
        <span className="rl-gname">{row.guest_name}</span>
        {row.is_vip && <Icon name="star" size={19} className="rl-star" />}
      </div>
      <div className="rl-td" style={{ textAlign: "right" }}>
        <span className="rl-resno">#{row.reservation_number}</span>
        {row.ota_reservation_code && (
          <span className="rl-otacode">{row.ota_reservation_code}</span>
        )}
      </div>
      <div className="rl-td">
        <span className="rl-src">{row.source_label ?? (row.is_ota ? row.ota_name : "ישיר")}</span>
      </div>
      <div className="rl-td">
        <span className="rl-phone">{row.guest_phone ?? "—"}</span>
      </div>
      <div className="rl-td">
        <span className="rl-roomchip">{row.rooms_label ?? "—"}</span>
      </div>
      <div className="rl-td">
        <span className="rl-date">{ddmm(row.check_in)}</span>
      </div>
      <div className="rl-td">
        <span className="rl-date">{ddmm(row.check_out)}</span>
      </div>
      <div className="rl-td">
        <span className="rl-nights">{row.nights}</span>
      </div>
      <div className="rl-td">
        <span className={`rl-pill ${pill.cls}`}>
          <Icon name={pill.icon} size={15} />
          {pill.label}
        </span>
      </div>
      <div className="rl-td">
        {cancelledTab ? (
          <span className="rl-cancelinfo">
            {CANCEL_ORIGIN_SHORT[row.cancellation_origin ?? ""] ?? "—"}
            <small>
              {row.cancelled_at
                ? `${ddmm(row.cancelled_at)} ${row.cancelled_at.slice(11, 16)}`
                : ""}
              {row.cancelled_by_name ? ` · ${row.cancelled_by_name}` : ""}
            </small>
          </span>
        ) : row.workflow_label ? (
          <span
            className="rl-wf"
            style={{
              background: row.workflow_color ?? "#64748B",
              color: readableTextColor(row.workflow_color ?? "#64748B"),
            }}
          >
            {row.workflow_label}
          </span>
        ) : (
          <span className="rl-src">—</span>
        )}
      </div>
      <div className="rl-td">
        <span className={`rl-pay ${row.payment}`}>{PAY_LABEL[row.payment]}</span>
        {row.balance > 0 && row.payment !== "paid" && row.status !== "cancelled" && (
          <span className="rl-balance">יתרה {money(row.balance, row.currency)}</span>
        )}
      </div>
      <div className="rl-td" style={{ textAlign: "left" }}>
        <span className="rl-total">
          {money(row.total_price, row.currency)}
          <Icon name="finance" size={16} />
        </span>
      </div>
    </div>
  );
}
