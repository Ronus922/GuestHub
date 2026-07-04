"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  barGeometry,
  canDragCard,
  dragActivated,
  dragEndAction,
  moveTarget,
  resizeDeltaRange,
  resizeTarget,
  snapDayDelta,
  snapRowDelta,
  type DragMode,
} from "@/lib/calendar-interactions";
import { rescheduleReservationRoomAction } from "@/app/(dashboard)/reservations/actions";
import { deleteClosureAction } from "./actions";
import type {
  CalendarClosure,
  CalendarData,
  CalendarRoom,
  CalendarStay,
} from "./types";
import type { BookingPrefill } from "@/components/reservations/BookingPanel";
import type { ClosurePrefill } from "./ClosurePanel";
import type { CalendarCan } from "./CalendarScreen";
import { ReservationPopover, type PopoverTarget } from "./ReservationPopover";

// ---- geometry (reference: 176px room column, 56px rows, 38px pills) ----
const ROOM_COL = 176;
const ROW_H = 56;
const BAR_TOP = 9;

// Payment-state pill palettes — extracted from the rendered reference
// (ref/html/rooms-calendar.html): bg / border / text per family.
export const PAY_STYLE: Record<PaymentState, { bg: string; bd: string; tx: string }> = {
  unpaid: { bg: "#FDEBEC", bd: "#EFA3A9", tx: "#B4232D" },
  partial: { bg: "#EAF7EE", bd: "#93D3A5", tx: "#1F7A3D" },
  paid: { bg: "#DFF2E7", bd: "#4FB47E", tx: "#0F6B3C" },
};
// Departed stays use the reference's neutral gray family (רון פרידמן card).
const PAST_STYLE = { bg: "#EAEEF4", bd: "#AEBACB", tx: "#3C4A5E" };

export function stayPalette(stay: Pick<CalendarStay, "status" | "payment">) {
  return stay.status === "checked_out" ? PAST_STYLE : PAY_STYLE[stay.payment];
}

type ContextMenu = { x: number; y: number; roomId: string; date: DateOnly };
type ClosurePopover = { x: number; y: number; id: string; label: string };

// Live drag session — kept OUT of React state so pointer movement never
// re-renders the grid; only the ghost node is mutated (rAF-throttled).
type DragSession = {
  mode: DragMode;
  stay: CalendarStay;
  roomIndex: number;
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  colW: number;
  stripWidth: number;
  activated: boolean;
  raf: number;
};

const isBlocking = (s: string) => (INVENTORY_BLOCKING_STATUSES as readonly string[]).includes(s);

export function CalendarGrid({
  data,
  paymentFilter,
  statusLabel,
  can,
  onOpenReservation,
  onNewBooking,
  onNewClosure,
}: {
  data: CalendarData;
  paymentFilter: PaymentState | "all";
  statusLabel: Map<string, string>;
  can: CalendarCan;
  onOpenReservation: (id: string) => void;
  onNewBooking: (prefill: BookingPrefill) => void;
  onNewClosure: (prefill: ClosurePrefill) => void;
}) {
  const dates = useMemo(
    () => eachDay(data.from, addDays(data.from, data.days)),
    [data.from, data.days],
  );

  const [pending, setPending] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const [closurePop, setClosurePop] = useState<ClosurePopover | null>(null);
  const [popover, setPopover] = useState<PopoverTarget | null>(null);
  // set once when the movement threshold is crossed, cleared on release —
  // NOT updated per pointer move (that path is ref + rAF + DOM only).
  const [dragUi, setDragUi] = useState<{ mode: DragMode; rrId: string } | null>(null);

  const sessionRef = useRef<DragSession | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);

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

  const cellRate = useCallback(
    (roomItem: CalendarRoom, date: DateOnly): RateRow | undefined =>
      rateIdx.room.get(`${roomItem.id}|${date}`) ??
      (roomItem.room_type_id ? rateIdx.type.get(`${roomItem.room_type_id}|${date}`) : undefined),
    [rateIdx],
  );

  // ---- client-side collision PREVIEW (visual only — the server re-validates
  // everything inside a transaction before any commit, §I) ----
  const previewInvalid = useCallback(
    (stay: CalendarStay, targetRoom: CalendarRoom, ci: DateOnly, co: DateOnly): boolean => {
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
    },
    [staysByRoom, closuresByRoom],
  );

  // ---- ghost rendering (direct DOM, rAF-throttled — zero React work) ----
  const paintGhost = useCallback(() => {
    const s = sessionRef.current;
    const ghost = ghostRef.current;
    const body = bodyRef.current;
    if (!s || !ghost || !body || !s.activated) return;

    const dayDelta = snapDayDelta(s.startX, s.lastX, s.colW);
    if (s.mode === "move") {
      const roomDelta = snapRowDelta(s.startY, s.lastY, ROW_H);
      const t = moveTarget(s.stay, s.roomIndex, dayDelta, roomDelta, data.rooms.length);
      const geo = barGeometry(data.from, data.days, t.ci, t.co);
      const targetRoom = data.rooms[t.roomIndex];
      const invalid = previewInvalid(s.stay, targetRoom, t.ci, t.co);
      // physical left inside the body: strips sit left of the sticky RTL
      // room column, so x = stripWidth * (1 - start - width)
      const x = s.stripWidth * (1 - geo.start - geo.width);
      const y = t.roomIndex * ROW_H + BAR_TOP;
      ghost.style.width = `${geo.width * s.stripWidth}px`;
      ghost.style.transform = `translate(${x}px, ${y}px)`;
      ghost.dataset.invalid = invalid ? "true" : "false";
      ghost.classList.remove("rsz");
      ghost.classList.add("live");
    } else {
      const t = resizeTarget(s.stay, dayDelta);
      const delta = resizeDeltaRange(s.stay, t.co);
      if (!delta) {
        ghost.classList.remove("live");
        return;
      }
      const geo = barGeometry(data.from, data.days, delta.from, delta.to);
      const invalid =
        delta.extending &&
        previewInvalid(s.stay, data.rooms[s.roomIndex], delta.from, delta.to);
      const x = s.stripWidth * (1 - geo.start - geo.width);
      const y = s.roomIndex * ROW_H + BAR_TOP;
      ghost.style.width = `${geo.width * s.stripWidth}px`;
      ghost.style.transform = `translate(${x}px, ${y}px)`;
      ghost.dataset.kind = delta.extending ? "extend" : "shorten";
      ghost.dataset.invalid = invalid ? "true" : "false";
      ghost.classList.add("rsz", "live");
    }
  }, [data.from, data.days, data.rooms, previewInvalid]);

  const endDrag = useCallback(() => {
    const s = sessionRef.current;
    sessionRef.current = null;
    if (s?.raf) cancelAnimationFrame(s.raf);
    ghostRef.current?.classList.remove("live");
    setDragUi(null);
  }, []);

  // Escape cancels a live drag (§4) — listener exists only while dragging.
  useEffect(() => {
    if (!dragUi) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") endDrag();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragUi, endDrag]);

  const commitDrag = useCallback(
    async (s: DragSession) => {
      const dayDelta = snapDayDelta(s.startX, s.lastX, s.colW);
      let targetRoom: CalendarRoom;
      let ci: DateOnly;
      let co: DateOnly;
      let changed: boolean;
      if (s.mode === "move") {
        const roomDelta = snapRowDelta(s.startY, s.lastY, ROW_H);
        const t = moveTarget(s.stay, s.roomIndex, dayDelta, roomDelta, data.rooms.length);
        targetRoom = data.rooms[t.roomIndex];
        ci = t.ci;
        co = t.co;
        changed = t.changed || targetRoom.id !== s.stay.room_id;
      } else {
        const t = resizeTarget(s.stay, dayDelta);
        targetRoom = data.rooms[s.roomIndex];
        ci = t.ci;
        co = t.co;
        changed = t.changed;
      }
      if (!changed) return;
      if (previewInvalid(s.stay, targetRoom, ci, co)) {
        toast.error("היעד אינו זמין — הפעולה בוטלה");
        return;
      }
      setPending((p) => new Set(p).add(s.stay.rr_id));
      const res = await rescheduleReservationRoomAction({
        rrId: s.stay.rr_id,
        targetRoomId: targetRoom.id,
        checkIn: ci,
        checkOut: co,
      });
      setPending((p) => {
        const n = new Set(p);
        n.delete(s.stay.rr_id);
        return n;
      });
      if (res.success) toast.success(s.mode === "move" ? "ההזמנה הועברה" : "התאריכים עודכנו");
      else toast.error(res.error);
    },
    [data.rooms, previewInvalid],
  );

  const openPopover = useCallback(
    (stay: CalendarStay, room: CalendarRoom, anchor: DOMRect) => {
      if (!can.viewReservation) return;
      setMenu(null);
      setClosurePop(null);
      setPopover({ stay, room, anchor: { x: anchor.left + anchor.width / 2, top: anchor.top, bottom: anchor.bottom } });
    },
    [can.viewReservation],
  );

  // ---- pointer wiring (handlers live ON the card via pointer capture —
  // no document-level listeners, nothing leaks) ----
  const onBarPointerDown = useCallback(
    (e: React.PointerEvent, stay: CalendarStay, roomIndex: number, mode: DragMode) => {
      if (!canDragCard(can.edit, pending.has(stay.rr_id))) return;
      if (e.button !== 0) return;
      e.preventDefault();
      setMenu(null);
      setClosurePop(null);
      setPopover(null);
      const body = bodyRef.current;
      if (!body) return;
      const stripWidth = body.getBoundingClientRect().width - ROOM_COL;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      sessionRef.current = {
        mode,
        stay,
        roomIndex,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        colW: stripWidth / data.days,
        stripWidth,
        activated: false,
        raf: 0,
      };
    },
    [can.edit, pending, data.days],
  );

  const onBarPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const s = sessionRef.current;
      if (!s || e.pointerId !== s.pointerId) return;
      s.lastX = e.clientX;
      s.lastY = e.clientY;
      if (!s.activated) {
        if (!dragActivated(e.clientX - s.startX, e.clientY - s.startY)) return;
        s.activated = true;
        setDragUi({ mode: s.mode, rrId: s.stay.rr_id });
      }
      if (!s.raf) {
        s.raf = requestAnimationFrame(() => {
          if (sessionRef.current === s) {
            s.raf = 0;
            paintGhost();
          }
        });
      }
    },
    [paintGhost],
  );

  const onBarPointerUp = useCallback(
    (e: React.PointerEvent, stay: CalendarStay, room: CalendarRoom) => {
      const s = sessionRef.current;
      if (!s || e.pointerId !== s.pointerId) return;
      const action = dragEndAction(s.mode, s.activated);
      const anchor = (e.currentTarget as HTMLElement).getBoundingClientRect();
      endDrag();
      if (action === "open") openPopover(stay, room, anchor);
      else if (action === "commit") void commitDrag(s);
    },
    [endDrag, openPopover, commitDrag],
  );

  const onBarPointerCancel = useCallback(() => {
    if (sessionRef.current) endDrag();
  }, [endDrag]);

  // dismiss context menus on outside click / escape
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

  const onCellContext = useCallback(
    (e: React.MouseEvent, roomId: string, date: DateOnly) => {
      e.preventDefault();
      e.stopPropagation();
      setClosurePop(null);
      setPopover(null);
      setMenu({ x: e.clientX, y: e.clientY, roomId, date });
    },
    [],
  );

  const onCellDouble = useCallback(
    (roomId: string, date: DateOnly, minNights: number) => {
      onNewBooking({ roomId, checkIn: date, checkOut: addDays(date, Math.max(1, minNights)) });
    },
    [onNewBooking],
  );

  const onClosureClick = useCallback((e: React.MouseEvent, c: CalendarClosure) => {
    e.stopPropagation();
    setMenu(null);
    setClosurePop({
      x: e.clientX,
      y: e.clientY,
      id: c.id,
      label: `${c.reason || "סגור חדר"} · ${formatFullDate(c.start_date)} – ${formatFullDate(c.end_date)}`,
    });
  }, []);

  // month band segments (reference .mrow/.mseg)
  const monthSegs = useMemo(() => {
    const segs: { label: string; days: number }[] = [];
    for (const d of dates) {
      const label = hebrewMonthYear(d);
      const last = segs[segs.length - 1];
      if (last && last.label === label) last.days += 1;
      else segs.push({ label, days: 1 });
    }
    return segs;
  }, [dates]);

  const floorCount = useMemo(
    () => new Set(data.rooms.map((r) => r.floor).filter(Boolean)).size,
    [data.rooms],
  );

  const dragStay = dragUi ? data.stays.find((s) => s.rr_id === dragUi.rrId) : null;
  const dragPalette = dragStay ? stayPalette(dragStay) : null;
  // dim only the source card of a MOVE, and only re-render its own row
  const dimRoomId = dragUi?.mode === "move" ? (dragStay?.room_id ?? null) : null;
  // selected card = the one whose popover is open (row-scoped for memo)
  const selRoomId = popover?.stay.room_id ?? null;

  return (
    <div className="cb-calcard">
      {data.rooms.length === 0 ? (
        <div className="grid h-64 place-items-center text-muted">
          <div className="text-center">
            <Icon name="rooms" size={32} className="mx-auto mb-2 text-faint" />
            <p className="font-semibold">אין חדרים להצגה</p>
            <p className="text-sm text-faint">הוסיפו חדרים כדי לראות את היומן</p>
          </div>
        </div>
      ) : (
        <div className="cb-calwrap thin-scroll" dir="rtl">
          <div
            className={`cb-calin ${dragUi ? (dragUi.mode === "move" ? "dragging" : "resizing") : ""}`}
          >
            {/* ===== sticky header: month band + day band ===== */}
            <div className="cb-chead">
              <div className="cb-hrow cb-mrow">
                <div className="cb-hcorn" style={{ width: ROOM_COL }} />
                <div className="cb-hcells">
                  {monthSegs.map((seg, i) => (
                    <div
                      key={seg.label}
                      className={`cb-mseg ${i > 0 ? "ms" : ""}`}
                      style={{ width: `${(seg.days / data.days) * 100}%` }}
                    >
                      <span className="cb-min">{seg.label}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="cb-hrow cb-drow">
                <div className="cb-hcorn" style={{ width: ROOM_COL }}>
                  <span className="cb-t">חדרים</span>
                  <span className="cb-cnt">
                    {data.rooms.length} יחידות
                    {floorCount > 1 ? ` · ${floorCount} קומות` : ""}
                  </span>
                </div>
                <div className="cb-hcells">
                  {dates.map((d) => {
                    const dow = dayOfWeek(d);
                    const weekend = dow === 5 || dow === 6;
                    const monthStart = d.slice(8, 10) === "01" && d !== data.from;
                    return (
                      <div
                        key={d}
                        className={`cb-dcell ${weekend ? "we" : ""} ${d === data.today ? "td" : ""} ${monthStart ? "ms" : ""}`}
                      >
                        <span className="cb-dw">יום {HEBREW_DAY_LETTERS[dow]}</span>
                        <span className="cb-dn">{Number(d.slice(8, 10))}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* ===== unassigned external-booking lane (renders only when
                 active holds exist, §R) ===== */}
            {data.holds.length > 0 && (
              <div className="cb-rrow">
                <div className="cb-rlabel" style={{ width: ROOM_COL }}>
                  <div className="cb-rl1">
                    <span className="cb-rnum" style={{ color: "#8A5207" }}>
                      ללא שיוך
                    </span>
                  </div>
                  <div className="cb-rl2" style={{ color: "#B4670A" }}>
                    הזמנות חיצוניות ממתינות לחדר
                  </div>
                </div>
                <div className="cb-rstrip">
                  {dates.map((d) => {
                    const dow = dayOfWeek(d);
                    return (
                      <div
                        key={d}
                        className={`cb-rcell ${dow === 5 || dow === 6 ? "we" : ""} ${d === data.today ? "td" : ""}`}
                      />
                    );
                  })}
                  {data.holds.map((h) => {
                    const geo = barGeometry(data.from, data.days, h.check_in, h.check_out);
                    return (
                      <div
                        key={h.id}
                        className="cb-holdbar"
                        style={{
                          insetInlineStart: `${geo.start * 100}%`,
                          width: `${geo.width * 100}%`,
                        }}
                      >
                        <Icon name="warning" size={13} />
                        <span className="cb-nm">
                          {h.guest_name ?? h.room_type_name} · {h.rooms_count} יח׳
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ===== room rows + drag ghost layer ===== */}
            <div ref={bodyRef} className="relative">
              {data.rooms.map((room, roomIndex) => (
                <RoomRow
                  key={room.id}
                  room={room}
                  roomIndex={roomIndex}
                  dates={dates}
                  from={data.from}
                  days={data.days}
                  today={data.today}
                  stays={staysByRoom.get(room.id)}
                  closures={closuresByRoom.get(room.id)}
                  cellRate={cellRate}
                  paymentFilter={paymentFilter}
                  pending={pending}
                  dragRrId={room.id === dimRoomId && dragUi ? dragUi.rrId : null}
                  selectedRrId={room.id === selRoomId && popover ? popover.stay.rr_id : null}
                  can={can}
                  onBarPointerDown={onBarPointerDown}
                  onBarPointerMove={onBarPointerMove}
                  onBarPointerUp={onBarPointerUp}
                  onBarPointerCancel={onBarPointerCancel}
                  onOpenPopover={openPopover}
                  onCellContext={onCellContext}
                  onCellDouble={onCellDouble}
                  onClosureClick={onClosureClick}
                />
              ))}

              {/* the single drag/resize ghost — positioned via transform,
                  content rendered once per drag, never per pointer move */}
              <div
                ref={ghostRef}
                className="cb-ghost"
                style={
                  dragUi?.mode === "move" && dragPalette
                    ? { background: dragPalette.bg, color: dragPalette.tx }
                    : undefined
                }
              >
                {dragUi?.mode === "move" && dragStay ? (
                  <>
                    {dragStay.is_vip && <Icon name="star" size={12} className="cb-vip" />}
                    <span className="cb-nm">{dragStay.guest_name}</span>
                    <span className="cb-bn">
                      <Icon name="moon" size={12} />
                      {nightsBetween(dragStay.check_in, dragStay.check_out)}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
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
              <Icon name="circle-slash" size={16} className="text-[#3C4A5E]" />
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

      {/* ===== reservation card popover (reference .pop) ===== */}
      <ReservationPopover
        target={popover}
        statusLabel={statusLabel}
        onClose={() => setPopover(null)}
        onEdit={(reservationId) => {
          setPopover(null);
          onOpenReservation(reservationId);
        }}
      />
    </div>
  );
}

// ============================================================
// One room row — memoized so pointer-driven UI state (dim/pending) only
// re-renders the row it touches.
// ============================================================
const RoomRow = memo(function RoomRow({
  room,
  roomIndex,
  dates,
  from,
  days,
  today,
  stays,
  closures,
  cellRate,
  paymentFilter,
  pending,
  dragRrId,
  selectedRrId,
  can,
  onBarPointerDown,
  onBarPointerMove,
  onBarPointerUp,
  onBarPointerCancel,
  onOpenPopover,
  onCellContext,
  onCellDouble,
  onClosureClick,
}: {
  room: CalendarRoom;
  roomIndex: number;
  dates: DateOnly[];
  from: DateOnly;
  days: number;
  today: DateOnly;
  stays: CalendarStay[] | undefined;
  closures: CalendarClosure[] | undefined;
  cellRate: (room: CalendarRoom, date: DateOnly) => RateRow | undefined;
  paymentFilter: PaymentState | "all";
  pending: Set<string>;
  dragRrId: string | null;
  selectedRrId: string | null;
  can: CalendarCan;
  onBarPointerDown: (e: React.PointerEvent, stay: CalendarStay, roomIndex: number, mode: DragMode) => void;
  onBarPointerMove: (e: React.PointerEvent) => void;
  onBarPointerUp: (e: React.PointerEvent, stay: CalendarStay, room: CalendarRoom) => void;
  onBarPointerCancel: () => void;
  onOpenPopover: (stay: CalendarStay, room: CalendarRoom, anchor: DOMRect) => void;
  onCellContext: (e: React.MouseEvent, roomId: string, date: DateOnly) => void;
  onCellDouble: (roomId: string, date: DateOnly, minNights: number) => void;
  onClosureClick: (e: React.MouseEvent, c: CalendarClosure) => void;
}) {
  const sellable = room.status === "available" && room.is_active;
  const occupiedNow = (stays ?? []).some(
    (s) => isBlocking(s.status) && s.check_in <= today && s.check_out > today,
  );
  const statusText = !sellable
    ? room.status === "out_of_order"
      ? "מושבת"
      : room.status === "maintenance"
        ? "תחזוקה"
        : "לא פעיל"
    : occupiedNow
      ? "תפוס"
      : "פנוי";
  const statusColor = !sellable ? "#94A3B8" : occupiedNow ? "#E5484D" : "#16A34A";

  return (
    <div className="cb-rrow">
      {/* room info — sticky inline-start column */}
      <div className="cb-rlabel" style={{ width: ROOM_COL }}>
        <div className="cb-rl1">
          <span className="cb-rnum">{room.room_number}</span>
          <span className="cb-rtype">
            {room.room_type_name ?? room.name ?? "—"}
          </span>
        </div>
        <div className="cb-rl2">
          {room.floor ? <span>קומה {room.floor}</span> : <span>{room.area_name ?? ""}</span>}
          <span className="cb-d" style={{ background: statusColor }} />
          <span style={{ color: statusColor }}>{statusText}</span>
        </div>
      </div>

      {/* day cells + bars */}
      <div className="cb-rstrip">
        {dates.map((d) => {
          const dow = dayOfWeek(d);
          const weekend = dow === 5 || dow === 6;
          const monthStart = d.slice(8, 10) === "01" && d !== from;
          const rate = cellRate(room, d);
          const price = rate?.price != null ? Number(rate.price) : room.base_price;
          const minN = rate?.min_nights ?? null;
          return (
            <div
              key={d}
              className={`cb-rcell ${weekend ? "we" : ""} ${d === today ? "td" : ""} ${monthStart ? "ms" : ""} ${!sellable ? "blocked" : ""}`}
              onDoubleClick={
                can.create && sellable ? () => onCellDouble(room.id, d, minN ?? 1) : undefined
              }
              onContextMenu={
                can.create || can.close ? (e) => onCellContext(e, room.id, d) : undefined
              }
            >
              {sellable && (
                <>
                  <span className="cb-pr" dir="ltr">
                    ₪{Math.round(price)}
                  </span>
                  {minN != null && minN >= 2 && (
                    <span className="cb-mn">
                      <Icon name="moon" size={11} />
                      {minN}
                    </span>
                  )}
                </>
              )}
            </div>
          );
        })}

        {/* closures — dashed neutral block (reference .blockbar) */}
        {(closures ?? []).map((c) => {
          const geo = barGeometry(from, days, c.start_date, c.end_date);
          return (
            <button
              key={c.id}
              type="button"
              onClick={(e) => onClosureClick(e, c)}
              className="cb-blockbar"
              style={{
                insetInlineStart: `${geo.start * 100}%`,
                width: `${geo.width * 100}%`,
              }}
            >
              <Icon name="circle-slash" size={13} />
              <span className="cb-nm">{c.reason || "סגור"}</span>
            </button>
          );
        })}

        {/* reservation pills */}
        {(stays ?? []).map((stay) => (
          <StayBar
            key={stay.rr_id}
            stay={stay}
            room={room}
            roomIndex={roomIndex}
            from={from}
            days={days}
            dimmed={paymentFilter !== "all" && stay.payment !== paymentFilter}
            pending={pending.has(stay.rr_id)}
            dragSource={dragRrId === stay.rr_id}
            selected={selectedRrId === stay.rr_id}
            canEdit={can.edit}
            canView={can.viewReservation}
            onPointerDown={onBarPointerDown}
            onPointerMove={onBarPointerMove}
            onPointerUp={onBarPointerUp}
            onPointerCancel={onBarPointerCancel}
            onOpenPopover={onOpenPopover}
          />
        ))}
      </div>
    </div>
  );
});

// ============================================================
// One reservation pill (reference .resbar): [★][name]…[nights ☾][handle]
// ============================================================
const StayBar = memo(function StayBar({
  stay,
  room,
  roomIndex,
  from,
  days,
  dimmed,
  pending,
  dragSource,
  selected,
  canEdit,
  canView,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onOpenPopover,
}: {
  stay: CalendarStay;
  room: CalendarRoom;
  roomIndex: number;
  from: DateOnly;
  days: number;
  dimmed: boolean;
  pending: boolean;
  dragSource: boolean;
  selected: boolean;
  canEdit: boolean;
  canView: boolean;
  onPointerDown: (e: React.PointerEvent, stay: CalendarStay, roomIndex: number, mode: DragMode) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent, stay: CalendarStay, room: CalendarRoom) => void;
  onPointerCancel: () => void;
  onOpenPopover: (stay: CalendarStay, room: CalendarRoom, anchor: DOMRect) => void;
}) {
  const pal = stayPalette(stay);
  const geo = barGeometry(from, days, stay.check_in, stay.check_out);
  const nights = nightsBetween(stay.check_in, stay.check_out);
  const draggable = canDragCard(canEdit, pending);

  return (
    <div
      role="button"
      tabIndex={canView ? 0 : -1}
      aria-label={`הזמנה ${stay.reservation_number} · ${stay.guest_name}`}
      className={`cb-resbar ${geo.clippedStart ? "cutR" : ""} ${geo.clippedEnd ? "cutL" : ""} ${
        stay.status === "draft" ? "draft" : ""
      } ${dimmed ? "dim" : ""} ${dragSource ? "src" : ""} ${selected ? "sel" : ""} ${pending ? "pending" : ""} ${
        draggable ? "" : canView ? "viewonly" : "lk"
      }`}
      style={{
        insetInlineStart: `${geo.start * 100}%`,
        width: `${geo.width * 100}%`,
        background: pal.bg,
        borderColor: pal.bd,
        color: pal.tx,
      }}
      onPointerDown={draggable ? (e) => onPointerDown(e, stay, roomIndex, "move") : undefined}
      onPointerMove={draggable ? onPointerMove : undefined}
      onPointerUp={draggable ? (e) => onPointerUp(e, stay, room) : undefined}
      onPointerCancel={draggable ? onPointerCancel : undefined}
      onClick={
        draggable
          ? undefined
          : (e) => onOpenPopover(stay, room, (e.currentTarget as HTMLElement).getBoundingClientRect())
      }
      onKeyDown={(e) => {
        if (e.key === "Enter")
          onOpenPopover(stay, room, (e.currentTarget as HTMLElement).getBoundingClientRect());
      }}
    >
      {stay.is_vip && <Icon name="star" size={12} className="cb-vip" />}
      <span className="cb-nm">{stay.guest_name}</span>
      {stay.room_count > 1 && <Icon name="link" size={11} className="shrink-0 opacity-70" />}
      <span className="cb-bn">
        <Icon name="moon" size={12} />
        {nights}
      </span>

      {/* departure resize handle — inside the pill's inline-end edge (§5);
          pointer-down here starts a RESIZE session on the same capture flow */}
      {draggable && (
        <span
          className="cb-rh"
          role="separator"
          aria-label="שינוי תאריך עזיבה"
          title="גרירה לשינוי תאריך עזיבה"
          onPointerDown={(e) => {
            e.stopPropagation();
            onPointerDown(e, stay, roomIndex, "resize");
          }}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => {
            e.stopPropagation();
            onPointerUp(e, stay, room);
          }}
          onPointerCancel={onPointerCancel}
        />
      )}
    </div>
  );
});
