"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import {
  addDays,
  dayOfWeek,
  eachDay,
  formatFullDate,
  hebrewMonthYear,
  nightsBetween,
  HEBREW_DAY_LETTERS,
  type DateOnly,
} from "@/lib/dates";
import {
  INVENTORY_BLOCKING_STATUSES,
  type PaymentState,
  type RateRow,
} from "@/lib/inventory-rules";
import { rescheduleReservationRoomAction } from "@/app/(dashboard)/reservations/actions";
import { deleteClosureAction } from "./actions";
import type {
  CalendarClosure,
  CalendarData,
  CalendarRoom,
  CalendarStay,
  CalendarView,
} from "./types";
import type { BookingPrefill } from "@/components/reservations/BookingPanel";
import type { ClosurePrefill } from "./ClosurePanel";
import type { CalendarCan } from "./CalendarScreen";

// ---- geometry ----
const ROOM_COL = 190;
const ROW_H = 56;
const COL_W: Record<CalendarView, number> = { week: 150, "3w": 96, month: 84 };

// payment-state pill colors — DESIGN_SYSTEM §1 status table, no invented hex
const PAY_STYLE: Record<PaymentState, { bg: string; bd: string; tx: string }> = {
  unpaid: { bg: "#FDECEC", bd: "#F4B9B9", tx: "#B4231F" },
  partial: { bg: "#E4F6EE", bd: "#A6E2CC", tx: "#0B7355" },
  paid: { bg: "#E7F6EC", bd: "#AADDB7", tx: "#15803D" },
};

type DragState =
  | {
      mode: "move";
      stay: CalendarStay;
      roomIndex: number;
      startX: number;
      startY: number;
      dayDelta: number;
      roomDelta: number;
      active: boolean; // passed the movement threshold
    }
  | {
      mode: "resize";
      stay: CalendarStay;
      roomIndex: number;
      startX: number;
      startY: number;
      dayDelta: number;
      active: boolean;
    };

type ContextMenu = { x: number; y: number; roomId: string; date: DateOnly };
type ClosurePopover = { x: number; y: number; id: string; label: string };

const isBlocking = (s: string) => (INVENTORY_BLOCKING_STATUSES as readonly string[]).includes(s);

export function CalendarGrid({
  data,
  view,
  paymentFilter,
  statusColor,
  statusLabel,
  can,
  onOpenReservation,
  onNewBooking,
  onNewClosure,
}: {
  data: CalendarData;
  view: CalendarView;
  paymentFilter: PaymentState | "all";
  statusColor: Map<string, string>;
  statusLabel: Map<string, string>;
  can: CalendarCan;
  onOpenReservation: (id: string) => void;
  onNewBooking: (prefill: BookingPrefill) => void;
  onNewClosure: (prefill: ClosurePrefill) => void;
}) {
  const colW = COL_W[view];
  const dates = useMemo(() => eachDay(data.from, addDays(data.from, data.days)), [data.from, data.days]);
  const lastVisible = dates[dates.length - 1];
  const bodyW = data.days * colW;

  const [drag, setDrag] = useState<DragState | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const [closurePop, setClosurePop] = useState<ClosurePopover | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  const staysByRoom = useMemo(() => {
    const m = new Map<string, CalendarStay[]>();
    for (const s of data.stays) {
      const arr = m.get(s.room_id);
      if (arr) arr.push(s);
      else m.set(s.room_id, [s]);
    }
    return m;
  }, [data.stays]);

  const closuresByRoom = useMemo(() => {
    const m = new Map<string, CalendarClosure[]>();
    for (const c of data.closures) {
      const arr = m.get(c.room_id);
      if (arr) arr.push(c);
      else m.set(c.room_id, [c]);
    }
    return m;
  }, [data.closures]);

  // O(1) rate lookup per cell — same priority as resolveRate (room > type)
  const rateIdx = useMemo(() => {
    const room = new Map<string, RateRow>();
    const type = new Map<string, RateRow>();
    for (const r of data.rates) {
      if (r.room_id) room.set(`${r.room_id}|${r.date}`, r);
      else if (r.room_type_id) type.set(`${r.room_type_id}|${r.date}`, r);
    }
    return { room, type };
  }, [data.rates]);

  const cellRate = (roomItem: CalendarRoom, date: DateOnly): RateRow | undefined =>
    rateIdx.room.get(`${roomItem.id}|${date}`) ??
    (roomItem.room_type_id ? rateIdx.type.get(`${roomItem.room_type_id}|${date}`) : undefined);

  // ---- client-side collision PREVIEW (visual only — the server re-validates
  // everything inside a transaction before any commit, §I) ----
  const previewInvalid = (
    stay: CalendarStay,
    targetRoom: CalendarRoom,
    ci: DateOnly,
    co: DateOnly,
  ): boolean => {
    if (targetRoom.status !== "available" || !targetRoom.is_active) return true;
    if (stay.adults + stay.children > targetRoom.max_occupancy) return true;
    for (const other of staysByRoom.get(targetRoom.id) ?? []) {
      if (other.rr_id === stay.rr_id) continue;
      if (!isBlocking(other.status)) continue;
      if (other.check_in < co && other.check_out > ci) return true;
    }
    for (const c of closuresByRoom.get(targetRoom.id) ?? []) {
      if (c.start_date < co && c.end_date > ci) return true;
    }
    return false;
  };

  // ---- drag wiring (move + resize) ----
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = d.startX - e.clientX; // RTL: leftwards = later dates
      const dy = e.clientY - d.startY;
      const dayDelta = Math.round(dx / colW);
      const active = d.active || Math.abs(dx) > 6 || Math.abs(dy) > 6;
      if (d.mode === "move") {
        const roomDelta = Math.round(dy / ROW_H);
        setDrag({ ...d, dayDelta, roomDelta, active });
      } else {
        setDrag({ ...d, dayDelta, active });
      }
    };
    const onUp = async () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d) return;
      if (!d.active) {
        // plain click — open the existing reservation flow (§F)
        onOpenReservation(d.stay.reservation_id);
        return;
      }
      const commit = computeDragTarget(d);
      if (!commit) return;
      const { targetRoom, ci, co, changed } = commit;
      if (!changed) return;
      if (previewInvalid(d.stay, targetRoom, ci, co)) {
        toast.error("היעד אינו זמין — הפעולה בוטלה");
        return;
      }
      setPending((p) => new Set(p).add(d.stay.rr_id));
      const res = await rescheduleReservationRoomAction({
        rrId: d.stay.rr_id,
        targetRoomId: targetRoom.id,
        checkIn: ci,
        checkOut: co,
      });
      setPending((p) => {
        const n = new Set(p);
        n.delete(d.stay.rr_id);
        return n;
      });
      if (res.success) toast.success(d.mode === "move" ? "ההזמנה הועברה" : "התאריכים עודכנו");
      else toast.error(res.error);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null, colW]);

  const computeDragTarget = (d: DragState) => {
    if (d.mode === "move") {
      const targetIdx = Math.min(Math.max(d.roomIndex + d.roomDelta, 0), data.rooms.length - 1);
      const targetRoom = data.rooms[targetIdx];
      const ci = addDays(d.stay.check_in, d.dayDelta);
      const co = addDays(d.stay.check_out, d.dayDelta);
      return {
        targetRoom,
        ci,
        co,
        changed: d.dayDelta !== 0 || targetRoom.id !== d.stay.room_id,
      };
    }
    const targetRoom = data.rooms[d.roomIndex];
    const co = maxDateOnly(addDays(d.stay.check_out, d.dayDelta), addDays(d.stay.check_in, 1));
    return { targetRoom, ci: d.stay.check_in, co, changed: co !== d.stay.check_out };
  };

  // dismiss popovers on outside click / escape
  useEffect(() => {
    if (!menu && !closurePop) return;
    const close = () => {
      setMenu(null);
      setClosurePop(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, closurePop]);

  // ---- bar geometry: mid-cell to mid-cell so a checkout and a same-day
  // check-in coexist; visual width = occupied nights (§E) ----
  const barBox = (ci: DateOnly, co: DateOnly) => {
    const clippedStart = ci < data.from;
    const clippedEnd = co > lastVisible;
    const startPx = clippedStart ? 0 : nightsBetween(data.from, ci) * colW + colW / 2;
    const endPx = clippedEnd ? bodyW : nightsBetween(data.from, co) * colW + colW / 2;
    return { startPx, width: Math.max(endPx - startPx, colW / 2), clippedStart, clippedEnd };
  };

  const monthStarts = useMemo(
    () => dates.filter((d, i) => i === 0 || d.slice(8, 10) === "01"),
    [dates],
  );

  return (
    <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      {data.rooms.length === 0 ? (
        <div className="grid h-64 place-items-center text-muted">
          <div className="text-center">
            <Icon name="rooms" size={32} className="mx-auto mb-2 text-faint" />
            <p className="font-semibold">אין חדרים להצגה</p>
            <p className="text-sm text-faint">הוסיפו חדרים כדי לראות את היומן</p>
          </div>
        </div>
      ) : (
        <div
          className="thin-scroll h-full overflow-auto overscroll-contain"
          style={{ maxHeight: "calc(100vh - 350px)", minHeight: 320 }}
          dir="rtl"
        >
          <div style={{ width: ROOM_COL + bodyW }} className={drag?.active ? "select-none" : ""}>
            {/* ===== sticky header ===== */}
            <div className="sticky top-0 z-30 flex border-b border-line bg-surface">
              <div
                className="sticky start-0 z-40 shrink-0 border-e border-line bg-surface px-4 py-2"
                style={{ width: ROOM_COL }}
              >
                <p className="text-sm font-bold text-ink">חדרים</p>
                <p className="text-[11px] text-faint">
                  {data.rooms.length} יחידות
                </p>
              </div>
              <div className="relative flex">
                {/* month labels */}
                <div className="pointer-events-none absolute inset-x-0 top-0 h-4">
                  {monthStarts.map((d) => (
                    <span
                      key={d}
                      className="absolute top-0 whitespace-nowrap ps-2 text-[10px] font-semibold text-faint"
                      style={{ insetInlineStart: nightsBetween(data.from, d) * colW }}
                    >
                      {hebrewMonthYear(d)}
                    </span>
                  ))}
                </div>
                {dates.map((d) => {
                  const dow = dayOfWeek(d);
                  const isToday = d === data.today;
                  const weekend = dow === 5 || dow === 6;
                  return (
                    <div
                      key={d}
                      className={`flex flex-col items-center justify-end border-e border-line/60 pb-1.5 pt-4 ${
                        weekend ? "bg-[#FBF7EC]" : ""
                      }`}
                      style={{ width: colW }}
                    >
                      <span className="text-[10px] font-medium text-faint">
                        יום {HEBREW_DAY_LETTERS[dow]}
                      </span>
                      <span
                        className={`grid h-7 min-w-7 place-items-center rounded-lg px-1 text-sm font-bold ${
                          isToday ? "bg-primary text-white" : "text-ink"
                        }`}
                      >
                        {Number(d.slice(8, 10))}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ===== unassigned external-booking lane (renders only when
                 active holds exist, §R) ===== */}
            {data.holds.length > 0 && (
              <div className="flex border-b border-line" style={{ minHeight: ROW_H }}>
                <div
                  className="sticky start-0 z-20 flex shrink-0 items-center gap-2 border-e border-line bg-[#FDF2E1] px-4"
                  style={{ width: ROOM_COL }}
                >
                  <Icon name="warning" size={16} className="text-[#B4670A]" />
                  <div>
                    <p className="text-sm font-bold text-[#B4670A]">ללא שיוך</p>
                    <p className="text-[10px] text-[#B4670A]/70">הזמנות חיצוניות ממתינות לחדר</p>
                  </div>
                </div>
                <div className="relative" style={{ width: bodyW, height: ROW_H }}>
                  {data.holds.map((h) => {
                    const box = barBox(h.check_in, h.check_out);
                    return (
                      <div
                        key={h.id}
                        className="absolute flex items-center gap-1.5 truncate rounded-full border border-dashed border-[#F5D19A] bg-[#FDF2E1] px-3 text-xs font-semibold text-[#B4670A]"
                        style={{
                          insetInlineStart: box.startPx,
                          width: box.width - 6,
                          top: 10,
                          height: ROW_H - 20,
                        }}
                      >
                        {h.guest_name ?? h.room_type_name} · {h.rooms_count} יח׳
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ===== room rows ===== */}
            {data.rooms.map((room, roomIndex) => {
              const sellable = room.status === "available" && room.is_active;
              const occupiedNow = (staysByRoom.get(room.id) ?? []).some(
                (s) =>
                  isBlocking(s.status) && s.check_in <= data.today && s.check_out > data.today,
              );
              const isDragTargetRow =
                drag?.active && drag.mode === "move"
                  ? Math.min(Math.max(drag.roomIndex + drag.roomDelta, 0), data.rooms.length - 1) === roomIndex
                  : drag?.active && drag.mode === "resize"
                    ? drag.roomIndex === roomIndex
                    : false;

              return (
                <div key={room.id} className="group/row flex border-b border-line/70 last:border-b-0">
                  {/* room info — sticky inline-start column */}
                  <div
                    className="sticky start-0 z-20 flex shrink-0 items-center justify-between border-e border-line bg-surface px-4 py-2 group-hover/row:bg-hover"
                    style={{ width: ROOM_COL, height: ROW_H }}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-ink">
                        {room.room_number}
                        {room.name && room.name !== room.room_number ? (
                          <span className="ms-1.5 truncate text-[11px] font-medium text-muted">
                            {room.name}
                          </span>
                        ) : null}
                      </p>
                      <p className="truncate text-[11px] text-faint">
                        {room.room_type_name ?? "—"}
                        {room.floor ? ` · קומה ${room.floor}` : ""}
                      </p>
                    </div>
                    <span
                      className="flex shrink-0 items-center gap-1 text-[10px] font-semibold"
                      style={{
                        color: !sellable ? "#64748B" : occupiedNow ? "#DC2626" : "#16A34A",
                      }}
                    >
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{
                          background: !sellable ? "#94A3B8" : occupiedNow ? "#DC2626" : "#16A34A",
                        }}
                      />
                      {!sellable
                        ? room.status === "out_of_order"
                          ? "מושבת"
                          : room.status === "maintenance"
                            ? "תחזוקה"
                            : "לא פעיל"
                        : occupiedNow
                          ? "תפוס"
                          : "פנוי"}
                    </span>
                  </div>

                  {/* day cells + bars */}
                  <div
                    className={`relative ${isDragTargetRow ? "bg-primary-050/40" : ""}`}
                    style={{ width: bodyW, height: ROW_H }}
                  >
                    {dates.map((d, di) => {
                      const dow = dayOfWeek(d);
                      const weekend = dow === 5 || dow === 6;
                      const rate = cellRate(room, d);
                      const price = rate?.price != null ? Number(rate.price) : room.base_price;
                      const minN = rate?.min_nights ?? null;
                      return (
                        <div
                          key={d}
                          className={`absolute top-0 flex h-full flex-col items-center justify-center border-e border-line/50 ${
                            d === data.today
                              ? "bg-primary-050/50"
                              : weekend
                                ? "bg-[#FBF7EC]/70"
                                : ""
                          } ${!sellable ? "bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,#F1F3F6_6px,#F1F3F6_12px)]" : ""}`}
                          style={{ insetInlineStart: di * colW, width: colW }}
                          onDoubleClick={
                            can.create && sellable
                              ? () =>
                                  onNewBooking({
                                    roomId: room.id,
                                    checkIn: d,
                                    checkOut: addDays(d, Math.max(1, minN ?? 1)),
                                  })
                              : undefined
                          }
                          onContextMenu={
                            can.create || can.close
                              ? (e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setClosurePop(null);
                                  setMenu({ x: e.clientX, y: e.clientY, roomId: room.id, date: d });
                                }
                              : undefined
                          }
                        >
                          {sellable && (
                            <>
                              <span className="text-[11px] font-semibold text-muted" dir="ltr">
                                ₪{Math.round(price)}
                              </span>
                              {minN != null && minN >= 2 && (
                                <span className="flex items-center gap-0.5 text-[11px] text-[#64748B]">
                                  {minN}
                                  <Icon name="moon" size={10} />
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}

                    {/* closures — rounded soft-pink, dashed (§H) */}
                    {(closuresByRoom.get(room.id) ?? []).map((c) => {
                      const box = barBox(c.start_date, c.end_date);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenu(null);
                            setClosurePop({
                              x: e.clientX,
                              y: e.clientY,
                              id: c.id,
                              label: `${c.reason || "סגור חדר"} · ${formatFullDate(c.start_date)} – ${formatFullDate(c.end_date)}`,
                            });
                          }}
                          className="absolute z-[5] flex items-center justify-center gap-1.5 truncate border border-dashed px-3 text-xs font-semibold"
                          style={{
                            insetInlineStart: box.startPx,
                            width: box.width - 6,
                            top: 8,
                            height: ROW_H - 16,
                            background: "#FDE7EC",
                            borderColor: "#F5AEC0",
                            color: "#BE123C",
                            borderRadius: 999,
                          }}
                        >
                          <Icon name="circle-slash" size={13} />
                          <span className="truncate">{c.reason || "סגור חדר"}</span>
                        </button>
                      );
                    })}

                    {/* reservation cards */}
                    {(staysByRoom.get(room.id) ?? []).map((stay) => (
                      <StayBar
                        key={stay.rr_id}
                        stay={stay}
                        box={barBox(stay.check_in, stay.check_out)}
                        dimmed={paymentFilter !== "all" && stay.payment !== paymentFilter}
                        pending={pending.has(stay.rr_id)}
                        moving={
                          drag?.active && drag.mode === "move" && drag.stay.rr_id === stay.rr_id
                        }
                        statusColor={statusColor.get(stay.status) ?? "#6B7385"}
                        statusText={statusLabel.get(stay.status) ?? stay.status}
                        canEdit={can.edit}
                        onPointerDown={(e, mode) => {
                          if (!can.edit) return;
                          e.preventDefault();
                          setMenu(null);
                          setClosurePop(null);
                          setDrag({
                            mode,
                            stay,
                            roomIndex,
                            startX: e.clientX,
                            startY: e.clientY,
                            dayDelta: 0,
                            roomDelta: 0,
                            active: false,
                          } as DragState);
                        }}
                        onClick={() => {
                          if (!can.edit) onOpenReservation(stay.reservation_id);
                        }}
                      />
                    ))}

                    {/* move preview (full ghost bar in the target row) */}
                    {drag?.active &&
                      drag.mode === "move" &&
                      isDragTargetRow &&
                      (() => {
                        const t = computeDragTarget(drag);
                        if (!t) return null;
                        const box = barBox(t.ci, t.co);
                        const invalid = previewInvalid(drag.stay, t.targetRoom, t.ci, t.co);
                        return (
                          <div
                            className="pointer-events-none absolute z-20 rounded-full border-2"
                            style={{
                              insetInlineStart: box.startPx,
                              width: box.width - 6,
                              top: 6,
                              height: ROW_H - 12,
                              background: invalid ? "rgba(220,38,38,.12)" : "rgba(22,163,74,.12)",
                              borderColor: invalid ? "#DC2626" : "#16A34A",
                            }}
                          />
                        );
                      })()}

                    {/* resize preview — DELTA ONLY, committed pill untouched (§J) */}
                    {drag?.active &&
                      drag.mode === "resize" &&
                      drag.roomIndex === roomIndex &&
                      (() => {
                        const t = computeDragTarget(drag);
                        if (!t || t.co === drag.stay.check_out) return null;
                        const extending = t.co > drag.stay.check_out;
                        const dFrom = extending ? drag.stay.check_out : t.co;
                        const dTo = extending ? t.co : drag.stay.check_out;
                        const box = barBox(dFrom, dTo);
                        const invalid =
                          extending &&
                          previewInvalid(drag.stay, data.rooms[roomIndex], dFrom, dTo);
                        const color = !extending || invalid ? "#DC2626" : "#16A34A";
                        return (
                          <div
                            className={`pointer-events-none absolute z-20 rounded-lg ${invalid ? "border-2" : "border"}`}
                            style={{
                              insetInlineStart: box.startPx,
                              width: box.width,
                              top: 6,
                              height: ROW_H - 12,
                              background:
                                !extending || invalid
                                  ? "rgba(220,38,38,.14)"
                                  : "rgba(22,163,74,.14)",
                              borderColor: color,
                            }}
                          />
                        );
                      })()}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ===== empty-cell context menu (§G) ===== */}
      {menu && (
        <div
          className="fixed z-50 min-w-[180px] overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-pop"
          style={{ top: menu.y + 4, insetInlineStart: Math.max(menu.x - 170, 8) }}
          dir="rtl"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="border-b border-line px-4 py-2 text-[11px] font-semibold text-faint" dir="rtl">
            {formatFullDate(menu.date)}
          </p>
          {can.create && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-4 py-2.5 text-sm font-medium text-ink hover:bg-hover"
              onClick={() => {
                onNewBooking({ roomId: menu.roomId, checkIn: menu.date, checkOut: addDays(menu.date, 1) });
                setMenu(null);
              }}
            >
              <Icon name="calendar-plus" size={16} className="text-primary" />
              הזמנה חדשה
            </button>
          )}
          {can.close && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-4 py-2.5 text-sm font-medium text-ink hover:bg-hover"
              onClick={() => {
                onNewClosure({ roomId: menu.roomId, startDate: menu.date, endDate: addDays(menu.date, 1) });
                setMenu(null);
              }}
            >
              <Icon name="circle-slash" size={16} className="text-[#BE123C]" />
              סגור חדר
            </button>
          )}
        </div>
      )}

      {/* ===== closure popover (delete) ===== */}
      {closurePop && (
        <div
          className="fixed z-50 min-w-[220px] overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-pop"
          style={{ top: closurePop.y + 4, insetInlineStart: Math.max(closurePop.x - 200, 8) }}
          dir="rtl"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="border-b border-line px-4 py-2 text-xs font-semibold text-muted">
            {closurePop.label}
          </p>
          {can.close ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-4 py-2.5 text-sm font-medium text-status-danger hover:bg-status-danger-050"
              onClick={async () => {
                const id = closurePop.id;
                setClosurePop(null);
                const res = await deleteClosureAction(id);
                if (res.success) toast.success("החסימה הוסרה");
                else toast.error(res.error);
              }}
            >
              <Icon name="trash" size={16} />
              הסר חסימה
            </button>
          ) : (
            <p className="px-4 py-2.5 text-xs text-faint">אין הרשאה להסרת חסימה</p>
          )}
        </div>
      )}
    </div>
  );
}

function maxDateOnly(a: DateOnly, b: DateOnly): DateOnly {
  return a > b ? a : b;
}

// ---- one reservation-room card ----
function StayBar({
  stay,
  box,
  dimmed,
  pending,
  moving,
  statusColor,
  statusText,
  canEdit,
  onPointerDown,
  onClick,
}: {
  stay: CalendarStay;
  box: { startPx: number; width: number; clippedStart: boolean; clippedEnd: boolean };
  dimmed: boolean;
  pending: boolean;
  moving: boolean | undefined;
  statusColor: string;
  statusText: string;
  canEdit: boolean;
  onPointerDown: (e: React.PointerEvent, mode: "move" | "resize") => void;
  onClick: () => void;
}) {
  const pay = PAY_STYLE[stay.payment];
  const nights = nightsBetween(stay.check_in, stay.check_out);
  const guests = stay.adults + stay.children + stay.infants;
  const isDraft = stay.status === "draft";
  const wide = box.width > 150;

  return (
    <div
      className={`group absolute z-10 flex items-center transition-opacity ${
        moving ? "opacity-40" : dimmed ? "opacity-25" : ""
      } ${pending ? "animate-pulse" : ""}`}
      style={{
        insetInlineStart: box.startPx,
        width: box.width - 6,
        top: 8,
        height: ROW_H - 16,
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={`הזמנה ${stay.reservation_number} · ${stay.guest_name}`}
        onPointerDown={(e) => onPointerDown(e, "move")}
        onClick={onClick}
        onKeyDown={(e) => e.key === "Enter" && onClick()}
        className={`flex h-full w-full min-w-0 items-center gap-1.5 border px-2.5 text-xs font-semibold ${
          isDraft ? "border-dashed" : ""
        } ${canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}`}
        style={{
          background: pay.bg,
          borderColor: pay.bd,
          color: pay.tx,
          borderStartStartRadius: box.clippedStart ? 4 : 999,
          borderEndStartRadius: box.clippedStart ? 4 : 999,
          borderStartEndRadius: box.clippedEnd ? 4 : 999,
          borderEndEndRadius: box.clippedEnd ? 4 : 999,
        }}
      >
        {/* reservation status dot (shared reservation_id ⇒ same status on
            every card of the reservation) */}
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: statusColor }} />
        {stay.is_vip && <Icon name="star" size={11} className="shrink-0 text-[#EA9314]" />}
        <span className="truncate">{stay.guest_name}</span>
        {stay.room_count > 1 && (
          <span className="shrink-0 opacity-70">
            <Icon name="link" size={11} />
          </span>
        )}
        <span className="ms-auto flex shrink-0 items-center gap-0.5 opacity-80">
          {wide ? (
            <span className="whitespace-nowrap">
              {nights} לילות · {guests} אורחים
            </span>
          ) : (
            <>
              {nights}
              <Icon name="moon" size={10} />
            </>
          )}
        </span>

        {/* hover tooltip — read-only, no server call (§10.1) */}
        <div className="pointer-events-none absolute bottom-full start-2 z-40 mb-1.5 hidden w-56 rounded-xl border border-line bg-surface p-3 text-start shadow-pop group-hover:block">
          <p className="mb-1 flex items-center justify-between gap-2 text-sm font-bold text-ink">
            <span className="truncate">{stay.guest_name}</span>
            <span className="shrink-0 text-[10px] font-semibold text-faint" dir="ltr">
              #{stay.reservation_number}
            </span>
          </p>
          <div className="space-y-0.5 text-[11px] text-text2">
            <p dir="ltr" className="text-end">
              {formatFullDate(stay.check_in)} → {formatFullDate(stay.check_out)}
            </p>
            <p>
              {nights} לילות · {stay.adults} מבוגרים
              {stay.children > 0 ? ` · ${stay.children} ילדים` : ""}
              {stay.infants > 0 ? ` · ${stay.infants} תינוקות` : ""}
            </p>
            <p>
              סטטוס: <b style={{ color: statusColor }}>{statusText}</b>
              {stay.source_label ? ` · מקור: ${stay.source_label}` : ""}
            </p>
            <p dir="ltr" className="text-end">
              ₪{stay.total_price.toLocaleString()} · שולם ₪{stay.paid_amount.toLocaleString()} ·
              יתרה ₪{Math.max(0, stay.total_price - stay.paid_amount).toLocaleString()}
            </p>
            {stay.room_count > 1 && <p>הזמנה מרובת חדרים ({stay.room_count} חדרים)</p>}
          </div>
        </div>
      </div>

      {/* departure resize handle — the bar's inline-end edge (left in RTL) */}
      {canEdit && !pending && (
        <div
          role="separator"
          aria-label="שינוי תאריך עזיבה"
          onPointerDown={(e) => {
            e.stopPropagation();
            onPointerDown(e, "resize");
          }}
          className="absolute inset-y-0 -end-1 z-20 w-2.5 cursor-ew-resize rounded-full opacity-0 transition-opacity group-hover:opacity-100"
          style={{ background: pay.tx }}
        />
      )}
    </div>
  );
}
