"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon, type IconName } from "@/components/shared/Icon";
import { statusTintPalette } from "@/lib/colors";
import { paymentTriplet, STATUS_COLORS } from "@/lib/status-colors";
import { getVisibleReservationNumber } from "@/lib/reservations/visible-number";
import { EditReservationPanel } from "@/components/reservations/EditReservationPanel";
import type { LookupItem } from "@/app/(dashboard)/calendar/CalendarScreen";
import type { ListFilters, ListRow, ListTab, ReservationsListData } from "./data";

// ============================================================
// /reservations — רשימת הזמנות, 1:1 to the RENDER of ref/html/Orders.html:
// title+count / search header, filters card, ONE unified tab bar (lifecycle +
// the former quick filters are the same control, one selection, one ?tab=
// param, one predicate map in data.ts), semantic <table> with sticky head,
// client-side sort + pagination over the server page, pinned footer.
// Server-driven filtering: every control writes the URL (router.replace) and
// the force-dynamic page re-queries — realtime router.refresh() keeps rows AND
// counts live with no second data path. Row click opens the EXISTING
// reservation SidePanel by the INTERNAL id — the visible number (OTA code,
// else #internal — see lib/reservations/visible-number) is presentation only.
// ============================================================

// ---- the ONE tab configuration ----
// Lifecycle tabs and the former "quick filters" are ONE control: one bar, one
// component (.btn), one selection, one URL param (?tab=, resolved by ONE
// predicate map in data.ts). Rendered right-to-left in this exact order; each
// key appears exactly once, so "שוהים" cannot be rendered twice.
const TAB_ITEMS: { key: ListTab; label: string; icon: IconName }[] = [
  { key: "all", label: "הכל", icon: "list-alt" },
  { key: "inhouse", label: "שוהים", icon: "hotel" },
  { key: "cancelled", label: "בוטלו", icon: "cancel" },
  { key: "noshow", label: "לא הגיעו", icon: "person-off" },
  { key: "created24", label: "נוצרו ב־24 שעות", icon: "attendance" },
  { key: "arrivals", label: "הגעות היום", icon: "login" },
  { key: "departures", label: "עזיבות היום", icon: "logout" },
  { key: "cancelled24", label: "בוטלו ב־24 השעות האחרונות", icon: "circle-slash" },
  { key: "unpaid", label: "לא שולמו", icon: "money-off" },
  { key: "partial", label: "שולם חלקית", icon: "percent" },
  { key: "pending", label: "ממתינות לאישור", icon: "hourglass" },
  { key: "missing_docs", label: "חסר מסמכים", icon: "documents" },
  { key: "invalid_card", label: "כרטיס לא עבר", icon: "credit-card" },
];

// the stay lifecycle wears the SAME chip anatomy as everything else (§3),
// with the family each state wears in the reference render: confirmed=brand,
// in-house=paid green, checked-out=refunded grey-blue, cancelled=the §3.1
// בוטל grey, no-show=the crimson נכשל family.
const LIFECYCLE_PILL: Record<string, { label: string; cls: string }> = {
  confirmed: { label: "מאושרת", cls: "chip-brand" },
  checked_in: { label: "שוהה", cls: "chip-paid" },
  checked_out: { label: "עזב", cls: "chip-refunded" },
  cancelled: { label: "בוטלה", cls: "chip-cancelled" },
  draft: { label: "טיוטה", cls: "chip-approval" },
  no_show: { label: "לא הגיע", cls: "chip-failed" },
  blocked: { label: "חסום", cls: "chip-refunded" },
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

const ddmmyy = (iso: string) =>
  `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`;
const money = (n: number, currency: string) => {
  const sym = currency === "ILS" ? "₪" : currency === "USD" ? "$" : currency === "EUR" ? "€" : `${currency} `;
  const rounded = Math.round(n * 100) / 100;
  const s = Number.isInteger(rounded)
    ? rounded.toLocaleString("en-US")
    : rounded.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sym}${s}`;
};
/** two-letter avatar initials like the reference ("נועה גל" → "נג") */
const initials = (name: string) => {
  const w = name.trim().split(/\s+/);
  return `${w[0]?.[0] ?? "א"}${w[1]?.[0] ?? ""}`;
};

const PAGE_SIZE = 50;

type SortKey =
  | "guest" | "number" | "source" | "phone" | "room" | "checkin" | "checkout"
  | "nights" | "status" | "workflow" | "payment" | "total";

const COLS: { key: SortKey; label: string; num?: boolean }[] = [
  { key: "guest", label: "אורח" },
  { key: "number", label: "מס׳ הזמנה" },
  { key: "source", label: "מקור" },
  { key: "phone", label: "טלפון" },
  { key: "room", label: "חדר" },
  { key: "checkin", label: "כניסה" },
  { key: "checkout", label: "יציאה" },
  { key: "nights", label: "לילות", num: true },
  { key: "status", label: "סטטוס" },
  { key: "workflow", label: "טיפול" },
  { key: "payment", label: "תשלום" },
  { key: "total", label: "סה״כ" },
];

function sortVal(r: ListRow, k: SortKey, cancelledTab: boolean): string | number {
  switch (k) {
    case "guest": return r.guest_name;
    case "number": return getVisibleReservationNumber(r);
    case "source": return r.source_label ?? (r.is_ota ? r.ota_name ?? "" : "ישיר");
    case "phone": return r.guest_phone ?? "";
    case "room": return r.rooms_label ?? "";
    case "checkin": return r.check_in;
    case "checkout": return r.check_out;
    case "nights": return r.nights;
    case "status": return LIFECYCLE_PILL[r.status]?.label ?? r.status;
    case "workflow": return cancelledTab ? (r.cancelled_at ?? "") : (r.workflow_label ?? "");
    case "payment": return PAY_LABEL[r.payment];
    case "total": return r.total_price;
  }
}

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
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => setQ(filters.q), [filters.q]);

  // a filter change re-queries the server — restart at the first page
  const filtersKey = JSON.stringify(filters);
  useEffect(() => {
    setPage(1);
    setSort(null);
  }, [filtersKey]);

  const apply = (patch: Partial<ListFilters>) => {
    const next = { ...filters, ...patch };
    // the cancellation-origin control exists only on the בוטלו tab — leaving
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
    filters.cancellationOrigin !== null;

  const cancelledTab = filters.tab === "cancelled";

  // client-side sort over the fetched page; null = server order (check-in
  // desc — the reference's default active column)
  const sorted = useMemo(() => {
    if (!sort) return data.rows;
    const rs = [...data.rows];
    rs.sort((a, b) => {
      const va = sortVal(a, sort.key, cancelledTab);
      const vb = sortVal(b, sort.key, cancelledTab);
      const c =
        typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va).localeCompare(String(vb), "he", { numeric: true });
      return sort.dir * c;
    });
    return rs;
  }, [data.rows, sort, cancelledTab]);

  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const cur = Math.min(page, pages);
  const pageRows = sorted.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE);
  const totalMatching = data.rows.length + data.truncatedBy;

  const onSort = (k: SortKey) =>
    setSort((s) => (s && s.key === k ? { key: k, dir: -s.dir as 1 | -1 } : { key: k, dir: 1 }));

  // the sort marker: an explicit user sort wins; otherwise the server order
  // (כניסה desc; the בוטלו tab is served by cancellation time instead)
  const activeCol = sort?.key ?? (cancelledTab ? null : "checkin");
  const activeDir = sort?.dir ?? -1;

  return (
    <div className="rv-app">
      {/* ---- header: title + count (right) · search (left) ---- */}
      <div className="rv-hd">
        <div className="rv-hd-tw">
          <h1 className="h1 rv-h1">
            הזמנות
            <span className="chip chip-neutral">
              <bdi className="ltr-num">{data.counts.all}</bdi> הזמנות
            </span>
          </h1>
          <p className="t-secondary">רשימת ההזמנות הפעילות והסגורות במלון</p>
        </div>
        <span className="rv-sp" />
        <label className="rv-search field-input">
          <Icon name="search" size={20} />
          <input
            value={q}
            placeholder="חיפוש לפי מספר הזמנה, שם אורח, טלפון או חדר…"
            onChange={(e) => onSearch(e.target.value)}
          />
        </label>
      </div>

      {/* ---- filters card ---- */}
      <div className="card rv-fcard">
        <div className="card-bd">
          <div className="rv-fgrid">
            <label className="field">
              <span className="field-label">סוג תאריך</span>
              <select
                className="field-input"
                value={filters.dateType}
                onChange={(e) => apply({ dateType: e.target.value as ListFilters["dateType"] })}
              >
                <option value="checkin">תאריך כניסה</option>
                <option value="checkout">תאריך יציאה</option>
                <option value="created">תאריך הזמנה</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">מתאריך</span>
              <input
                type="date"
                className="field-input ltr-num"
                value={filters.from ?? ""}
                onChange={(e) => apply({ from: e.target.value || null })}
              />
            </label>
            <label className="field">
              <span className="field-label">עד תאריך</span>
              <input
                type="date"
                className="field-input ltr-num"
                value={filters.to ?? ""}
                onChange={(e) => apply({ to: e.target.value || null })}
              />
            </label>
            <label className="field">
              <span className="field-label">מקור</span>
              <select
                className="field-input"
                value={filters.sourceId ?? ""}
                onChange={(e) => apply({ sourceId: e.target.value || null })}
              >
                <option value="">כל המקורות</option>
                {bookingSources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">סטטוס הזמנה</span>
              <select
                className="field-input"
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
            </label>
            <label className="field">
              <span className="field-label">תשלום</span>
              <select
                className="field-input"
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
            </label>
            <label className="field">
              <span className="field-label">חדר</span>
              <select
                className="field-input"
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
            </label>
            {cancelledTab && (
              <label className="field">
                <span className="field-label">מקור ביטול</span>
                <select
                  className="field-input"
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
              </label>
            )}
            {filtersActive && (
              <button
                type="button"
                className="btn btn-secondary"
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
                    dateType: "checkin",
                  });
                }}
              >
                <Icon name="filter" size={17} />
                ניקוי סינון
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ---- the unified tab bar ---- */}
      {/* ONE unified tab bar — every item is the same control (§4: a tab IS a
          button), one selection at a time; "הכל" clears the filter. No second
          group, no divider, no second state. */}
      <div className="rv-tabsbar" role="tablist" aria-label="סינון הזמנות">
        {TAB_ITEMS.map((t) => {
          const on = filters.tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={on}
              className={`btn rv-tab ${on ? "btn-primary" : "btn-tertiary"}`}
              onClick={() => apply({ tab: t.key })}
            >
              <Icon name={t.icon} size={17} />
              {t.label}
              <span className="chip chip-neutral ltr-num">{data.counts[t.key]}</span>
            </button>
          );
        })}
      </div>

      {/* ---- table card ---- */}
      <div className="card rv-tblwrap thin-scroll">
        {pageRows.length === 0 ? (
          <div className="empty-state">
            <Icon name="search" size={24} />
            <p className="empty-t">לא נמצאו הזמנות</p>
            <p className="empty-s">נסו לשנות את הסינון או את מונח החיפוש</p>
          </div>
        ) : (
          <table className="rv-tbl">
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th
                    key={c.key}
                    className={`${c.num ? "num" : ""} ${activeCol === c.key ? "active" : ""}`}
                    aria-sort={
                      activeCol === c.key ? (activeDir === 1 ? "ascending" : "descending") : undefined
                    }
                    onClick={() => onSort(c.key)}
                  >
                    <span className="rv-th-in">
                      {c.key === "workflow" && cancelledTab ? "ביטול" : c.label}
                      <Icon
                        name={activeCol === c.key && activeDir === 1 ? "arrow-up" : "arrow-down"}
                        size={13.5}
                        className="rv-sort"
                      />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => (
                <ReservationRow
                  key={row.id}
                  row={row}
                  cancelledTab={cancelledTab}
                  onOpen={() => can.viewReservation && setPanelId(row.id)}
                />
              ))}
            </tbody>
          </table>
        )}
        {data.truncatedBy > 0 && (
          <p className="rl-truncated">
            נטענו {data.rows.length} הזמנות; עוד {data.truncatedBy} תואמות את הסינון — צמצמו את
            הסינון או השתמשו בחיפוש
          </p>
        )}
      </div>

      {/* ---- pinned footer: count · pagination ---- */}
      <div className="rv-ft">
        <p className="rv-ft-c">
          מציג <b className="ltr-num">{pageRows.length}</b> מתוך{" "}
          <b className="ltr-num">{totalMatching}</b> הזמנות
        </p>
        <span className="rv-sp" />
        {pages > 1 && (
          <div className="rv-pg">
            <button
              type="button"
              className="rv-pg-b"
              aria-label="עמוד קודם"
              disabled={cur <= 1}
              onClick={() => setPage(cur - 1)}
            >
              <Icon name="chevron-right" size={17} />
            </button>
            {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                type="button"
                className={`rv-pg-b ltr-num ${p === cur ? "on" : ""}`}
                aria-current={p === cur ? "page" : undefined}
                onClick={() => setPage(p)}
              >
                {p}
              </button>
            ))}
            <button
              type="button"
              className="rv-pg-b"
              aria-label="עמוד הבא"
              disabled={cur >= pages}
              onClick={() => setPage(cur + 1)}
            >
              <Icon name="chevron-left" size={17} />
            </button>
          </div>
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
  const pill = LIFECYCLE_PILL[row.status] ?? { label: row.status, cls: "chip-refunded" };
  return (
    <tr
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
      <td>
        <span className="rv-guest">
          <span className="rv-av">{initials(row.guest_name || "אורח")}</span>
          <span className="rl-gname">
            {row.guest_name}
            {row.is_vip && (
              <>
                {" "}
                <Icon name="star" size={13.5} className="rv-vip" label="אורח VIP" />
              </>
            )}
          </span>
        </span>
      </td>
      <td>
        {/* the ONE visible number: OTA code when the channel supplied one,
            else the internal #number — never both */}
        <span className="rv-rid ltr-num">{getVisibleReservationNumber(row)}</span>
      </td>
      <td>
        <bdi className="rv-src">{row.source_label ?? (row.is_ota ? row.ota_name : "ישיר")}</bdi>
      </td>
      <td>
        <span className="rv-phone ltr-num">{row.guest_phone ?? "—"}</span>
      </td>
      <td>
        <span className="chip chip-neutral">
          <bdi className="rv-room ltr-num">{row.rooms_label ?? "—"}</bdi>
        </span>
      </td>
      <td>
        <span className="rv-date ltr-num">{ddmmyy(row.check_in)}</span>
      </td>
      <td>
        <span className="rv-date ltr-num">{ddmmyy(row.check_out)}</span>
      </td>
      <td className="num">
        <span className="rv-nights ltr-num">{row.nights}</span>
      </td>
      <td>
        <span className={`chip ${pill.cls}`}>
          <span className="dot" />
          {pill.label}
        </span>
      </td>
      <td>
        {cancelledTab ? (
          <span className="rv-cancelinfo">
            {CANCEL_ORIGIN_SHORT[row.cancellation_origin ?? ""] ?? "—"}
            <small>
              {row.cancelled_at
                ? `${ddmmyy(row.cancelled_at)} ${row.cancelled_at.slice(11, 16)}`
                : ""}
              {row.cancelled_by_name ? ` · ${row.cancelled_by_name}` : ""}
            </small>
          </span>
        ) : row.workflow_label ? (
          /* D77.1 — the same tint family the calendar pill wears */
          <span
            className="chip rl-wf"
            style={(() => {
              const t = statusTintPalette(row.workflow_color);
              return { backgroundColor: t.bg, borderColor: t.bd, color: t.tx };
            })()}
          >
            {row.workflow_label}
          </span>
        ) : (
          <span className="rv-src">—</span>
        )}
      </td>
      <td>
        <span className={`chip ${paymentTriplet(row.payment).chip}`}>
          <span className="dot" />
          {PAY_LABEL[row.payment]}
        </span>
        {row.balance > 0 && row.payment !== "paid" && row.status !== "cancelled" && (
          /* §3.1 לא שולם TEXT token — the dot token fails AA at 12px */
          <span className="rv-bal" style={{ color: STATUS_COLORS.unpaid.tx }}>
            יתרה לתשלום: <bdi className="ltr-num">{money(row.balance, row.currency)}</bdi>
          </span>
        )}
      </td>
      <td>
        <span className="rv-price ltr-num">{money(row.total_price, row.currency)}</span>
      </td>
    </tr>
  );
}
