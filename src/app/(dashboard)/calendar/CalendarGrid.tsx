"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
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
  nightsRuleViolation,
  stayViolationMessage,
  type NightsRuleRow,
} from "@/lib/rates/rules";
import { normalizeVisibleChannel, statusTintPalette } from "@/lib/colors";
import { ChannelBadge } from "@/components/shared/ChannelBadge";
import {
  NEUTRAL_STATUS,
  paymentTriplet,
  STATUS_COLORS,
  type StatusTriplet,
} from "@/lib/status-colors";
import {
  barGeometry,
  canDragCard,
  cellRangeGeometry,
  createActivated,
  createRangeTarget,
  describeReschedule,
  dragActivated,
  dragEndAction,
  moveTarget,
  resizeDeltaRange,
  resizeTarget,
  snapDayDelta,
  snapRowDelta,
  TOOLTIP_CLOSE_MS,
  TOOLTIP_OPEN_MS,
  type DragMode,
} from "@/lib/calendar-interactions";
import { rescheduleReservationRoomAction } from "@/app/(dashboard)/reservations/actions";
import { MoveConfirmDialog, type MoveProposal } from "./MoveConfirmDialog";
import { deleteClosureAction } from "./actions";
import type {
  CalendarClosure,
  CalendarData,
  CalendarRoom,
  CalendarStay,
} from "./types";
import type { NewReservationPrefill } from "@/components/reservations/NewReservationProvider";
import type { ClosurePrefill } from "./ClosurePanel";
import type { CalendarCan } from "./CalendarScreen";
import { ReservationTooltip, type TooltipTarget } from "./ReservationTooltip";
import { RateCellTooltip, type CellTipTarget } from "./RateCellTooltip";

// ---- geometry — the ONE source (reference: GuesthubCalandrUpdate.html) ----
// These numbers drive BOTH the drag math (which needs them as numbers) and the
// stylesheet (which needs them as lengths). They used to be duplicated: the
// constants here and the same pixel values hand-copied into calendar.css, so a
// row-height change silently desynced the grid from the drop target. Now the
// constants are published as custom properties on .cb-calin (see GEOMETRY_VARS)
// and calendar.css consumes them — change a value here and both follow.
const ROOM_COL = 176; // sticky room column
const ROW_H = 64; // room row
const BAR_TOP = 11; // pill inset inside the row
const BAR_H = ROW_H - BAR_TOP * 2; // 42 — pill height falls out of the inset
const DAY_H = 58; // day-header row
const MONTH_H = 40; // month band

const GEOMETRY_VARS = {
  "--cb-room-col": `${ROOM_COL}px`,
  "--cb-row-h": `${ROW_H}px`,
  "--cb-bar-top": `${BAR_TOP}px`,
  "--cb-bar-h": `${BAR_H}px`,
  "--cb-day-h": `${DAY_H}px`,
  "--cb-month-h": `${MONTH_H}px`,
} as React.CSSProperties;

// Payment-state pill palettes — GUIDELINES §3.1. The triplets are NOT re-typed
// here: they come from the one source (src/lib/status-colors.ts), so the pill,
// the tooltip tag and the filter chip can never drift apart. `overpaid` wears
// the approved purple ("ממתין להעברה") family — the old bespoke teal was not an
// approved family and is gone (its LABEL and semantics are unchanged). §3.1 has
// no "שולם ביתר" family of its own, so an approved one is borrowed; this
// presentation-only mapping is flagged for OWNER SIGN-OFF (coordinator
// decision: keep, do not invent a new colour family).
export const PAY_STYLE: Record<PaymentState, StatusTriplet> = {
  unpaid: paymentTriplet("unpaid"),
  partial: paymentTriplet("partial"),
  paid: paymentTriplet("paid"),
  overpaid: paymentTriplet("overpaid"),
};
// Departed stays use the approved neutral ("הוחזר") family.
const PAST_STYLE = NEUTRAL_STATUS;

// D77.1 — the WHOLE pill wears the tenant's workflow-status color family
// (soft tint bg, the color as border, readable derived text), exactly like
// the reference pill families but for ANY tenant-configured hex. Departed
// stays keep the canonical past-gray; stays without a workflow status fall
// back to the payment palette. Hover/selected/drag reuse this same palette
// (shadow/opacity-only CSS states), so the family survives every state.
export function stayPalette(stay: Pick<CalendarStay, "status" | "payment" | "workflow_color">) {
  if (stay.status === "checked_out") return PAST_STYLE;
  if (stay.workflow_color) {
    const t = statusTintPalette(stay.workflow_color);
    return { bg: t.bg, bd: t.bd, tx: t.tx };
  }
  return PAY_STYLE[stay.payment];
}

type ContextMenu = { x: number; y: number; roomId: string; date: DateOnly };
type ClosurePopover = { x: number; y: number; id: string; label: string };

// §8: a popover opens at the click point and is CLAMPED to the viewport with a
// 12px margin. The box is the canonical `.popover` (316px), so only the height
// needs measuring — positioned after render, like the hover tooltips. Physical
// `left` on purpose: the card is direction:rtl, so a logical inset would mirror
// the computed viewport-clamped position. In RTL the menu hangs its top-RIGHT
// corner off the click point.
function useClampedMenu(anchor: { x: number; y: number } | null) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<React.CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!anchor || !ref.current) {
      setPos(null);
      return;
    }
    const r = ref.current.getBoundingClientRect();
    const left = Math.min(Math.max(anchor.x - r.width, 12), window.innerWidth - r.width - 12);
    const top = Math.max(
      Math.min(anchor.y + 4, window.innerHeight - r.height - 12),
      12,
    );
    setPos({ top, left, visibility: "visible" });
  }, [anchor]);
  return { ref, style: pos ?? ({ top: 0, left: 0, visibility: "hidden" } as React.CSSProperties) };
}

// Live drag session — kept OUT of React state so pointer movement never
// re-renders the grid; only the ghost node is mutated (rAF-throttled).
// mode "create" is an empty-cell range selection: stay is null and
// startDate anchors the selected night range (§4).
type DragSession = {
  mode: DragMode;
  stay: CalendarStay | null;
  startDate: DateOnly | null;
  minNights: number;
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
  onNewBooking: (prefill: NewReservationPrefill) => void;
  onNewClosure: (prefill: ClosurePrefill) => void;
}) {
  const router = useRouter();

  const dates = useMemo(
    () => eachDay(data.from, addDays(data.from, data.days)),
    [data.from, data.days],
  );

  const [pending, setPending] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const [closurePop, setClosurePop] = useState<ClosurePopover | null>(null);
  const menuPop = useClampedMenu(menu);
  const closureMenuPop = useClampedMenu(closurePop);
  // hover tooltip (reference Tooltip.png) — opened by a deliberate hover
  // delay, kept alive while the pointer is inside the card or the tooltip
  const [tip, setTip] = useState<TooltipTarget | null>(null);
  // empty-cell commercial (rate) hover tooltip (§2) — independent of the
  // reservation tooltip; informational only, no write path.
  const [cellTip, setCellTip] = useState<CellTipTarget | null>(null);
  // set once when the movement threshold is crossed, cleared on release —
  // NOT updated per pointer move (that path is ref + rAF + DOM only).
  const [dragUi, setDragUi] = useState<{ mode: DragMode; rrId: string } | null>(null);
  // a completed move/resize proposes a change and waits for confirmation (§2/§3);
  // NOTHING is persisted until "אישור". null = no pending confirmation.
  const [confirmMove, setConfirmMove] = useState<MoveProposal | null>(null);
  const [committing, startCommit] = useTransition();

  const sessionRef = useRef<DragSession | null>(null);
  // ---- deterministic reservation-interaction lifecycle (D44) ----
  // phaseRef: where the current pointer sequence is. openEditor may run ONLY
  // from a genuine click (phase "pressed", threshold not crossed) — never from
  // "dragging"/"resizing"/"awaiting_confirmation". A ref (not state) so the
  // per-pointer path never re-renders and reads are synchronous.
  const phaseRef = useRef<
    "idle" | "pressed" | "dragging" | "resizing" | "awaiting_confirmation"
  >("idle");
  // completed-drag marker: the pointerId whose ONE synthetic click must be
  // swallowed. Set on an activated pointer-up, consumed by the matching
  // capture-phase click, or cleared by the next pointer-down (never a timeout).
  const suppressClickRef = useRef<number | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const gnRef = useRef<HTMLSpanElement | null>(null);
  const tipOpenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tipCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cellTipOpenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cellTipCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelTipTimers = useCallback(() => {
    if (tipOpenTimer.current) clearTimeout(tipOpenTimer.current);
    if (tipCloseTimer.current) clearTimeout(tipCloseTimer.current);
    tipOpenTimer.current = null;
    tipCloseTimer.current = null;
  }, []);
  useEffect(() => cancelTipTimers, [cancelTipTimers]);

  const cancelCellTipTimers = useCallback(() => {
    if (cellTipOpenTimer.current) clearTimeout(cellTipOpenTimer.current);
    if (cellTipCloseTimer.current) clearTimeout(cellTipCloseTimer.current);
    cellTipOpenTimer.current = null;
    cellTipCloseTimer.current = null;
  }, []);
  useEffect(() => cancelCellTipTimers, [cancelCellTipTimers]);

  const closeCellTip = useCallback(() => {
    cancelCellTipTimers();
    setCellTip(null);
  }, [cancelCellTipTimers]);

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
  const rangeInvalid = useCallback(
    (targetRoom: CalendarRoom, ci: DateOnly, co: DateOnly, excludeRrId?: string): boolean => {
      if (targetRoom.status !== "available" || !targetRoom.is_active) return true;
      for (const other of staysByRoom.get(targetRoom.id) ?? []) {
        if (excludeRrId && other.rr_id === excludeRrId) continue;
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

  const previewInvalid = useCallback(
    (stay: CalendarStay, targetRoom: CalendarRoom, ci: DateOnly, co: DateOnly): boolean => {
      if (stay.adults + stay.children > targetRoom.max_occupancy) return true;
      return rangeInvalid(targetRoom, ci, co, stay.rr_id);
    },
    [rangeInvalid],
  );

  // Stay-LENGTH gate for a NEW range [ci, co) — the same min/max-nights rule the
  // server enforces on create (nightsRuleViolation shares the canonical Hebrew
  // message). Built from the already-fetched per-cell rates, so a selection that
  // violates minimum/maximum nights is blocked at selection time and never opens
  // the booking panel. Returns the Hebrew message, or null when the length is legal.
  const nightsViolation = useCallback(
    (room: CalendarRoom, ci: DateOnly, co: DateOnly): string | null => {
      const nights = eachDay(ci, co); // occupied nights [ci, co)
      const byDate = new Map<string, NightsRuleRow>();
      for (const d of nights) {
        const r = cellRate(room, d);
        if (r)
          byDate.set(d, {
            min_stay_arrival: r.min_nights,
            min_stay_through: r.min_stay_through,
            max_stay: r.max_nights,
          });
      }
      const v = nightsRuleViolation(byDate, { checkIn: ci, nights });
      return v ? stayViolationMessage(v) : null;
    },
    [cellRate],
  );

  // ---- ghost rendering (direct DOM, rAF-throttled — zero React work) ----
  const paintGhost = useCallback(() => {
    const s = sessionRef.current;
    const ghost = ghostRef.current;
    const body = bodyRef.current;
    if (!s || !ghost || !body || !s.activated) return;

    const dayDelta = snapDayDelta(s.startX, s.lastX, s.colW);
    if (s.mode === "move" && s.stay) {
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
      ghost.classList.remove("rsz", "new");
      ghost.classList.add("live");
    } else if (s.mode === "resize" && s.stay) {
      const t = resizeTarget(s.stay, dayDelta);
      const delta = resizeDeltaRange(s.stay, t.co);
      if (!delta) {
        ghost.classList.remove("live");
        return;
      }
      const geo = barGeometry(data.from, data.days, delta.from, delta.to);
      // extension must be free; shortening turns invalid only when the
      // result drops below the cell's minimum-stay restriction (§1)
      const nightsAfter = nightsBetween(s.stay.check_in, t.co);
      const invalid = delta.extending
        ? previewInvalid(s.stay, data.rooms[s.roomIndex], delta.from, delta.to)
        : nightsAfter < s.minNights;
      const x = s.stripWidth * (1 - geo.start - geo.width);
      const y = s.roomIndex * ROW_H + BAR_TOP;
      ghost.style.width = `${geo.width * s.stripWidth}px`;
      ghost.style.transform = `translate(${x}px, ${y}px)`;
      ghost.dataset.kind = delta.extending ? "extend" : "shorten";
      ghost.dataset.invalid = invalid ? "true" : "false";
      ghost.classList.remove("new");
      ghost.classList.add("rsz", "live");
    } else if (s.mode === "create" && s.startDate) {
      // preview the RAW dragged range (min=1) so the highlighted band is exactly
      // what will be validated on release — no silent extend-to-minimum.
      const t = createRangeTarget(s.startDate, dayDelta, 1);
      const geo = cellRangeGeometry(data.from, data.days, t.ci, t.co);
      const room = data.rooms[s.roomIndex];
      const invalid = rangeInvalid(room, t.ci, t.co);
      const x = s.stripWidth * (1 - geo.start - geo.width);
      const y = s.roomIndex * ROW_H + BAR_TOP;
      ghost.style.width = `${geo.width * s.stripWidth}px`;
      ghost.style.transform = `translate(${x}px, ${y}px)`;
      ghost.dataset.invalid = invalid ? "true" : "false";
      ghost.classList.remove("rsz");
      ghost.classList.add("new", "live");
      if (gnRef.current) gnRef.current.textContent = `${t.nights} לילות`;
    }
  }, [data.from, data.days, data.rooms, previewInvalid, rangeInvalid]);

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

  const roomLabelOf = useCallback(
    (roomId: string): string => {
      const r = data.rooms.find((x) => x.id === roomId);
      return r ? (r.name || r.room_number || "—") : "—";
    },
    [data.rooms],
  );

  // A completed move/resize does NOT persist — it computes the proposed change,
  // runs the client-side availability PREVIEW (the server re-validates on
  // confirm), and opens the floating confirmation dialog (§2/§3).
  const openConfirm = useCallback(
    (s: DragSession) => {
      const stay = s.stay;
      if (!stay) return;
      const dayDelta = snapDayDelta(s.startX, s.lastX, s.colW);
      let targetRoom: CalendarRoom;
      let ci: DateOnly;
      let co: DateOnly;
      let changed: boolean;
      if (s.mode === "move") {
        const roomDelta = snapRowDelta(s.startY, s.lastY, ROW_H);
        const t = moveTarget(stay, s.roomIndex, dayDelta, roomDelta, data.rooms.length);
        targetRoom = data.rooms[t.roomIndex];
        ci = t.ci;
        co = t.co;
        changed = t.changed || targetRoom.id !== stay.room_id;
      } else {
        const t = resizeTarget(stay, dayDelta);
        targetRoom = data.rooms[s.roomIndex];
        ci = t.ci;
        co = t.co;
        changed = t.changed;
        // same rule the red preview shows: shortening below the check-in
        // cell's minimum stay is rejected client-side too (§1)
        if (changed && co < stay.check_out && nightsBetween(ci, co) < s.minNights) {
          toast.error("קיצור מתחת לשהות המינימלית אינו אפשרי");
          phaseRef.current = "idle"; // no dialog opened → interaction is done
          return;
        }
      }
      if (!changed) {
        phaseRef.current = "idle";
        return;
      }
      if (previewInvalid(stay, targetRoom, ci, co)) {
        toast.error("היעד אינו זמין — הפעולה בוטלה");
        phaseRef.current = "idle";
        return;
      }
      const op = describeReschedule(
        { roomId: stay.room_id, checkIn: stay.check_in, checkOut: stay.check_out },
        { roomId: targetRoom.id, checkIn: ci, checkOut: co },
      );
      if (op === "none") {
        phaseRef.current = "idle";
        return;
      }
      // the dialog opens (§5): clear tooltip state, keep the edit panel closed
      phaseRef.current = "awaiting_confirmation";
      cancelTipTimers();
      setTip(null);
      setConfirmMove({
        rrId: stay.rr_id,
        op,
        guestName: stay.guest_name,
        reservationNumber: stay.reservation_number,
        targetRoomId: targetRoom.id,
        before: {
          roomLabel: roomLabelOf(stay.room_id),
          checkIn: stay.check_in,
          checkOut: stay.check_out,
          nights: nightsBetween(stay.check_in, stay.check_out),
          total: stay.total_price,
        },
        after: {
          roomLabel: roomLabelOf(targetRoom.id),
          checkIn: ci,
          checkOut: co,
          nights: nightsBetween(ci, co),
        },
      });
    },
    [data.rooms, previewInvalid, roomLabelOf, cancelTipTimers],
  );

  // close the confirmation dialog and return the interaction to idle so the
  // NEXT genuine click may open the editor and the next drag confirms again (§5)
  const closeConfirm = useCallback(() => {
    setConfirmMove(null);
    phaseRef.current = "idle";
  }, []);

  // "אישור" — persist atomically via the server action (it re-validates
  // availability, overlaps, closures, restrictions, re-prices, updates
  // inventory and queues Channex), then close and stay on the calendar.
  const runReschedule = useCallback(
    (p: MoveProposal) => {
      startCommit(async () => {
        setPending((prev) => new Set(prev).add(p.rrId));
        const res = await rescheduleReservationRoomAction({
          rrId: p.rrId,
          targetRoomId: p.targetRoomId,
          checkIn: p.after.checkIn,
          checkOut: p.after.checkOut,
        });
        setPending((prev) => {
          const n = new Set(prev);
          n.delete(p.rrId);
          return n;
        });
        setConfirmMove(null);
        phaseRef.current = "idle"; // dialog closed → next click may open the editor
        if (res.success) toast.success(p.op === "room" ? "ההזמנה הועברה" : "התאריכים עודכנו");
        else toast.error(res.error);
      });
    },
    [],
  );

  // ---- click → the FULL edit window, directly (§3; hover shows the
  // tooltip, clicking edits) ----
  const openEditor = useCallback(
    (stay: CalendarStay) => {
      // opens ONLY for a genuine click: never mid-drag/resize, never while a
      // completed drag's synthetic click is still pending, never while a move
      // confirmation is open (§4). Belt-and-suspenders — the capture-phase
      // suppressor below already neutralises the post-drag synthetic click.
      if (
        suppressClickRef.current !== null ||
        phaseRef.current === "dragging" ||
        phaseRef.current === "resizing" ||
        phaseRef.current === "awaiting_confirmation"
      ) {
        return;
      }
      if (!can.viewReservation) return;
      cancelTipTimers();
      setTip(null);
      closeCellTip();
      setMenu(null);
      setClosurePop(null);
      onOpenReservation(stay.reservation_id);
    },
    [can.viewReservation, cancelTipTimers, closeCellTip, onOpenReservation],
  );

  // Capture-phase click suppressor on the grid body (§4). Exactly one synthetic
  // click follows a completed drag/resize; consume it here — in the CAPTURE
  // phase, before it can reach any pill / row / cell / grid handler — so no
  // parent can reopen the editor through bubbling. Tied to the pointer sequence
  // (the marker), not a timeout, so it is reliable on every repeated drag.
  const onBodyClickCapture = useCallback((e: React.MouseEvent) => {
    if (suppressClickRef.current !== null) {
      suppressClickRef.current = null;
      e.stopPropagation();
      e.preventDefault();
    }
  }, []);

  // ---- hover tooltip wiring (§2): open after a deliberate delay, close
  // with a short grace so the pointer can travel into the tooltip ----
  const onBarHoverStart = useCallback(
    (e: React.PointerEvent, stay: CalendarStay, room: CalendarRoom) => {
      if (e.pointerType !== "mouse" || !can.viewReservation) return;
      // never open the tooltip during a drag/resize or a pending confirmation
      if (sessionRef.current || phaseRef.current !== "idle") return;
      const el = e.currentTarget as HTMLElement;
      if (tipCloseTimer.current) clearTimeout(tipCloseTimer.current);
      tipCloseTimer.current = null;
      if (tipOpenTimer.current) clearTimeout(tipOpenTimer.current);
      tipOpenTimer.current = setTimeout(() => {
        tipOpenTimer.current = null;
        if (sessionRef.current || phaseRef.current !== "idle" || !el.isConnected) return;
        const r = el.getBoundingClientRect();
        setTip({ stay, room, anchor: { x: r.left + r.width / 2, top: r.top, bottom: r.bottom } });
      }, TOOLTIP_OPEN_MS);
    },
    [can.viewReservation],
  );

  const scheduleTipClose = useCallback(() => {
    if (tipOpenTimer.current) clearTimeout(tipOpenTimer.current);
    tipOpenTimer.current = null;
    if (tipCloseTimer.current) clearTimeout(tipCloseTimer.current);
    tipCloseTimer.current = setTimeout(() => {
      tipCloseTimer.current = null;
      setTip(null);
    }, TOOLTIP_CLOSE_MS);
  }, []);

  // hovering the resize handle never opens the tooltip (§2)
  const cancelTipOpen = useCallback(() => {
    if (tipOpenTimer.current) clearTimeout(tipOpenTimer.current);
    tipOpenTimer.current = null;
  }, []);

  // ---- empty-cell commercial tooltip wiring (§2): mirrors the reservation
  // tooltip's deliberate open delay + close grace, on its own timers so the
  // two never fight. Never opens during a drag/selection. ----
  const onCellHoverStart = useCallback(
    (e: React.PointerEvent, room: CalendarRoom, date: DateOnly, rate: RateRow | undefined) => {
      if (e.pointerType !== "mouse") return;
      if (sessionRef.current) return; // never during a drag/resize/selection
      const el = e.currentTarget as HTMLElement;
      if (cellTipCloseTimer.current) clearTimeout(cellTipCloseTimer.current);
      cellTipCloseTimer.current = null;
      if (cellTipOpenTimer.current) clearTimeout(cellTipOpenTimer.current);
      cellTipOpenTimer.current = setTimeout(() => {
        cellTipOpenTimer.current = null;
        if (sessionRef.current || !el.isConnected) return;
        const r = el.getBoundingClientRect();
        setCellTip({
          room,
          date,
          rate,
          anchor: { x: r.left + r.width / 2, top: r.top, bottom: r.bottom },
        });
      }, TOOLTIP_OPEN_MS);
    },
    [],
  );

  const scheduleCellTipClose = useCallback(() => {
    if (cellTipOpenTimer.current) clearTimeout(cellTipOpenTimer.current);
    cellTipOpenTimer.current = null;
    if (cellTipCloseTimer.current) clearTimeout(cellTipCloseTimer.current);
    cellTipCloseTimer.current = setTimeout(() => {
      cellTipCloseTimer.current = null;
      setCellTip(null);
    }, TOOLTIP_CLOSE_MS);
  }, []);

  const keepCellTipAlive = useCallback(() => {
    if (cellTipCloseTimer.current) clearTimeout(cellTipCloseTimer.current);
    cellTipCloseTimer.current = null;
  }, []);

  // ---- pointer wiring (handlers live ON the card via pointer capture —
  // no document-level listeners, nothing leaks) ----
  const onBarPointerDown = useCallback(
    (e: React.PointerEvent, stay: CalendarStay, roomIndex: number, mode: DragMode) => {
      if (!canDragCard(can.edit, pending.has(stay.rr_id))) return;
      if (e.button !== 0) return;
      e.preventDefault();
      // a new pointer sequence starts: clear any stale completed-drag marker
      // (the previous sequence's synthetic click has already fired by now) and
      // hide the tooltip immediately so it can never sit over the pill (§1)
      suppressClickRef.current = null;
      phaseRef.current = "pressed";
      cancelTipTimers();
      setTip(null);
      setMenu(null);
      setClosurePop(null);
      const body = bodyRef.current;
      if (!body) return;
      const room = data.rooms[roomIndex];
      const minN = room ? (cellRate(room, stay.check_in)?.min_nights ?? 1) : 1;
      const stripWidth = body.getBoundingClientRect().width - ROOM_COL;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      sessionRef.current = {
        mode,
        stay,
        startDate: null,
        minNights: Math.max(1, minN ?? 1),
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
    [can.edit, pending, data.days, data.rooms, cellRate, cancelTipTimers],
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
        // threshold crossed → this is a drag/resize, not a click. Record the
        // phase, close the tooltip and never reopen it during the gesture (§1/§2)
        phaseRef.current = s.mode === "resize" ? "resizing" : "dragging";
        cancelTipTimers();
        setTip(null);
        setDragUi({ mode: s.mode, rrId: s.stay?.rr_id ?? "" });
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
    [paintGhost, cancelTipTimers],
  );

  const onBarPointerUp = useCallback(
    (e: React.PointerEvent, stay: CalendarStay) => {
      const s = sessionRef.current;
      if (!s || e.pointerId !== s.pointerId) return;
      const action = dragEndAction(s.mode, s.activated);
      endDrag();
      if (action === "open") {
        // genuine click (threshold never crossed) → open the side panel
        phaseRef.current = "idle";
        openEditor(stay);
      } else if (action === "confirm") {
        // completed drag/resize → mark the pending synthetic click for this
        // pointer (consumed by onBodyClickCapture) and open the confirmation
        // dialog. NEVER open the editor, NEVER persist here (§3/§4). The marker
        // is NOT cleared on a timeout — only by the matching click or next press.
        suppressClickRef.current = e.pointerId;
        phaseRef.current = "awaiting_confirmation";
        openConfirm(s);
      } else {
        // resize-handle click with no movement, etc. → back to idle
        phaseRef.current = "idle";
      }
    },
    [endDrag, openEditor, openConfirm],
  );

  const onBarPointerCancel = useCallback(() => {
    if (sessionRef.current) endDrag();
    if (phaseRef.current !== "awaiting_confirmation") phaseRef.current = "idle";
  }, [endDrag]);

  // ---- empty-cell range selection → prefilled new booking (§4).
  // Explicit input rule: mouse/pen only (touch keeps native panning), and
  // the gesture must be horizontal-dominant past the threshold — vertical
  // movement aborts the session and scrolls as usual. ----
  const onCellPointerDown = useCallback(
    (e: React.PointerEvent, roomIndex: number, date: DateOnly, minNights: number) => {
      if (!can.create) return;
      if (e.button !== 0 || e.pointerType === "touch") return;
      if (sessionRef.current) return;
      const body = bodyRef.current;
      if (!body) return;
      cancelTipTimers();
      setTip(null);
      closeCellTip();
      setMenu(null);
      setClosurePop(null);
      const stripWidth = body.getBoundingClientRect().width - ROOM_COL;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      // no preventDefault — a sub-threshold press must still double-click
      sessionRef.current = {
        mode: "create",
        stay: null,
        startDate: date,
        minNights: Math.max(1, minNights),
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
    [can.create, data.days, cancelTipTimers, closeCellTip],
  );

  const onCellPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const s = sessionRef.current;
      if (!s || s.mode !== "create" || e.pointerId !== s.pointerId) return;
      s.lastX = e.clientX;
      s.lastY = e.clientY;
      if (!s.activated) {
        const dx = e.clientX - s.startX;
        const dy = e.clientY - s.startY;
        if (createActivated(dx, dy)) {
          s.activated = true;
          setDragUi({ mode: "create", rrId: "" });
        } else if (dragActivated(dx, dy)) {
          // vertical-dominant = scroll gesture → abort the selection
          sessionRef.current = null;
          (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
          return;
        } else return;
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

  const onCellPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const s = sessionRef.current;
      if (!s || s.mode !== "create" || e.pointerId !== s.pointerId) return;
      endDrag();
      if (!s.activated || !s.startDate) return; // plain click → double-click still creates
      const dayDelta = snapDayDelta(s.startX, s.lastX, s.colW);
      // RAW selection — never auto-extend to the minimum (owner decision): a
      // sub-minimum drag must be BLOCKED with a message, not silently grown to a
      // legal length, so the enforcement is visible at the moment of selection.
      const t = createRangeTarget(s.startDate, dayDelta, 1);
      const room = data.rooms[s.roomIndex];
      if (!room) return;
      if (rangeInvalid(room, t.ci, t.co)) {
        toast.error("הטווח המסומן אינו זמין");
        return;
      }
      const lenMsg = nightsViolation(room, t.ci, t.co);
      if (lenMsg) {
        toast.error(lenMsg);
        return;
      }
      onNewBooking({ roomId: room.id, checkIn: t.ci, checkOut: t.co, source: "calendar_drag" });
    },
    [endDrag, data.rooms, rangeInvalid, nightsViolation, onNewBooking],
  );

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
      setTip(null);
      closeCellTip();
      setMenu({ x: e.clientX, y: e.clientY, roomId, date });
    },
    [closeCellTip],
  );

  const onCellDouble = useCallback(
    (roomId: string, date: DateOnly, minNights: number) => {
      onNewBooking({
        roomId,
        checkIn: date,
        checkOut: addDays(date, Math.max(1, minNights)),
        source: "calendar_double_click",
      });
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

  // A month boundary is drawn ONCE per boundary, as a full-height line over the
  // canonical column edge — never as a border on the month segment AND on the day
  // cell AND on the body cell. Those three sized their own boxes differently (a
  // percentage-wide month band vs `flex: 1 1 0` cells, whose border sits OUTSIDE
  // the zero basis), so the header line landed ~3px away from the body line and
  // the month-start column came out 3px wider than every other column.
  const monthBounds = useMemo(() => {
    const out: number[] = [];
    let at = 0;
    for (const seg of monthSegs.slice(0, -1)) {
      at += seg.days;
      out.push(at);
    }
    return out;
  }, [monthSegs]);
  const monthSeparators = monthBounds.map((day) => (
    <span
      key={day}
      className="cb-msep"
      aria-hidden
      // fraction of the day strip — the SAME number the cells divide by
      style={{ "--cb-sep": day / data.days } as React.CSSProperties}
    />
  ));

  const floorCount = useMemo(
    () => new Set(data.rooms.map((r) => r.floor).filter(Boolean)).size,
    [data.rooms],
  );

  const dragStay = dragUi ? data.stays.find((s) => s.rr_id === dragUi.rrId) : null;
  const dragPalette = dragStay ? stayPalette(dragStay) : null;
  // ghost badge follows the same rule as the pill: internal reservations wear none
  const dragChannel = dragStay ? normalizeVisibleChannel(dragStay.source_key) : null;
  // dim only the source card of a MOVE, and only re-render its own row
  const dimRoomId = dragUi?.mode === "move" ? (dragStay?.room_id ?? null) : null;
  // highlighted card = the one whose hover tooltip is open (row-scoped)
  const selRoomId = tip?.stay.room_id ?? null;

  return (
    <div className="card cb-calcard">
      {data.rooms.length === 0 ? (
        <div className="empty-state">
          <Icon name="rooms" size={24} className="text-faint" />
          <p className="empty-t">אין חדרים להצגה</p>
          <p className="empty-s">הוסיפו חדרים כדי לראות את היומן</p>
        </div>
      ) : (
        <div className="cb-calwrap thin-scroll" dir="rtl">
          <div
            style={GEOMETRY_VARS}
            className={`cb-calin ${
              dragUi
                ? dragUi.mode === "move"
                  ? "dragging"
                  : dragUi.mode === "resize"
                    ? "resizing"
                    : "selecting"
                : ""
            }`}
          >
            {/* ===== sticky header: month band + day band ===== */}
            <div className="cb-chead">
              {monthSeparators}
              <div className="cb-hrow cb-mrow">
                <div className="cb-hcorn" style={{ width: ROOM_COL }} />
                <div className="cb-hcells">
                  {monthSegs.map((seg) => (
                    <div
                      key={seg.label}
                      className="cb-mseg"
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
                    return (
                      <div
                        key={d}
                        className={`cb-dcell ${weekend ? "we" : ""} ${d === data.today ? "td" : ""}`}
                      >
                        <span className="cb-dw">יום {HEBREW_DAY_LETTERS[dow]}</span>
                        <span className="cb-dn">{Number(d.slice(8, 10))}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* ===== grid body: ONE positioned block, so a month separator runs
                 through every lane as a single line ===== */}
            <div className="cb-cbody">
              {monthSeparators}

            {/* ===== unassigned external-booking lane (renders only when
                 active holds exist, §R) ===== */}
            {data.holds.length > 0 && (
              <div className="cb-rrow">
                <div className="cb-rlabel" style={{ width: ROOM_COL }}>
                  <div className="cb-rl1">
                    <span className="cb-rnum hold">ללא שיוך</span>
                  </div>
                  <div className="cb-rl2 hold">הזמנות חיצוניות ממתינות לחדר</div>
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
                        // §3.1 "ממתין לאישור" — the approved triplet, not a local colour
                        style={{
                          insetInlineStart: `${geo.start * 100}%`,
                          width: `${geo.width * 100}%`,
                          background: STATUS_COLORS.approval.bg,
                          borderColor: STATUS_COLORS.approval.bd,
                          color: STATUS_COLORS.approval.tx,
                        }}
                      >
                        <Icon name="warning" size={13.5} />
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
            {/* onClickCapture swallows the ONE synthetic click that follows a
                completed drag/resize, in the capture phase, before any child or
                parent handler can open the editor (§4) */}
            <div ref={bodyRef} className="relative" onClickCapture={onBodyClickCapture}>
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
                  selectedRrId={room.id === selRoomId && tip ? tip.stay.rr_id : null}
                  can={can}
                  onBarPointerDown={onBarPointerDown}
                  onBarPointerMove={onBarPointerMove}
                  onBarPointerUp={onBarPointerUp}
                  onBarPointerCancel={onBarPointerCancel}
                  onBarHoverStart={onBarHoverStart}
                  onBarHoverEnd={scheduleTipClose}
                  onHandleHover={cancelTipOpen}
                  onOpenEditor={openEditor}
                  onCellPointerDown={onCellPointerDown}
                  onCellPointerMove={onCellPointerMove}
                  onCellPointerUp={onCellPointerUp}
                  onCellPointerCancel={onBarPointerCancel}
                  onCellContext={onCellContext}
                  onCellDouble={onCellDouble}
                  onCellHoverStart={onCellHoverStart}
                  onCellHoverEnd={scheduleCellTipClose}
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
                    {dragChannel && <ChannelBadge channel={dragChannel} size="lg" ring />}
                    {dragStay.is_vip && <Icon name="star" size={13.5} className="cb-vip" />}
                    <span className="cb-nm">{dragStay.guest_name}</span>
                    <span className="cb-bn">
                      <Icon name="moon" size={13.5} />
                      {nightsBetween(dragStay.check_in, dragStay.check_out)}
                    </span>
                  </>
                ) : null}
                {/* live nights label of the create-selection band — text is
                    written imperatively per frame, never via React */}
                <span ref={gnRef} className="cb-gn" />
              </div>
            </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== empty-cell context menu (§G) — the canonical §8 popover,
           clamped to the viewport; outside-click / Escape dismissal is handled
           by the global listener above (the §8 transparent closing layer) ===== */}
      {menu && (
        <div
          ref={menuPop.ref}
          className="popover cb-menu"
          style={menuPop.style}
          onClick={(e) => e.stopPropagation()}
        >
          <p className="cb-menu-h">{formatFullDate(menu.date)}</p>
          {can.create && (
            <button
              type="button"
              className="cb-menu-it"
              onClick={() => {
                onNewBooking({
                  roomId: menu.roomId,
                  checkIn: menu.date,
                  checkOut: addDays(menu.date, 1),
                  source: "calendar_context",
                });
                setMenu(null);
              }}
            >
              <Icon name="calendar-plus" size={17} className="text-primary" />
              הזמנה חדשה
            </button>
          )}
          {can.close && (
            <button
              type="button"
              className="cb-menu-it"
              onClick={() => {
                onNewClosure({ roomId: menu.roomId, startDate: menu.date, endDate: addDays(menu.date, 1) });
                setMenu(null);
              }}
            >
              <Icon name="circle-slash" size={17} className="text-muted" />
              סגור חדר
            </button>
          )}
          {/* deep-link to the commercial editor for this exact date (§3) —
              navigation only; the /rates page enforces its own permission */}
          <div className="cb-menu-sep">
            <button
              type="button"
              className="cb-menu-it"
              onClick={() => {
                router.push(`/rates?from=${menu.date}`);
                setMenu(null);
              }}
            >
              <Icon name="credit-card" size={17} className="text-primary" />
              פתיחת רשת התעריפים לתאריך זה
            </button>
          </div>
        </div>
      )}

      {/* ===== closure popover (delete) — same canonical §8 popover ===== */}
      {closurePop && (
        <div
          ref={closureMenuPop.ref}
          className="popover cb-menu"
          style={closureMenuPop.style}
          onClick={(e) => e.stopPropagation()}
        >
          <p className="cb-menu-h">{closurePop.label}</p>
          {can.close ? (
            <button
              type="button"
              className="cb-menu-it danger"
              onClick={async () => {
                const id = closurePop.id;
                setClosurePop(null);
                const res = await deleteClosureAction(id);
                if (res.success) toast.success("החסימה הוסרה");
                else toast.error(res.error);
              }}
            >
              <Icon name="trash" size={17} />
              הסר חסימה
            </button>
          ) : (
            <p className="cb-menu-note">אין הרשאה להסרת חסימה</p>
          )}
        </div>
      )}

      {/* ===== reservation hover tooltip — informational, pointer-events:none,
           positioned OUTSIDE the pill; never an interaction target (§1) ===== */}
      <ReservationTooltip target={tip} statusLabel={statusLabel} />

      {/* ===== empty-cell commercial (rate) hover tooltip (§2, #11) ===== */}
      <RateCellTooltip
        target={cellTip}
        onKeepAlive={keepCellTipAlive}
        onRelease={scheduleCellTipClose}
      />

      {/* ===== drag/resize confirmation (§2/§3): persists only on אישור ===== */}
      {confirmMove && (
        <MoveConfirmDialog
          proposal={confirmMove}
          currency={data.currency}
          committing={committing}
          onConfirm={() => runReschedule(confirmMove)}
          onReject={closeConfirm}
        />
      )}
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
  onBarHoverStart,
  onBarHoverEnd,
  onHandleHover,
  onOpenEditor,
  onCellPointerDown,
  onCellPointerMove,
  onCellPointerUp,
  onCellPointerCancel,
  onCellContext,
  onCellDouble,
  onCellHoverStart,
  onCellHoverEnd,
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
  onBarPointerUp: (e: React.PointerEvent, stay: CalendarStay) => void;
  onBarPointerCancel: () => void;
  onBarHoverStart: (e: React.PointerEvent, stay: CalendarStay, room: CalendarRoom) => void;
  onBarHoverEnd: () => void;
  onHandleHover: () => void;
  onOpenEditor: (stay: CalendarStay) => void;
  onCellPointerDown: (e: React.PointerEvent, roomIndex: number, date: DateOnly, minNights: number) => void;
  onCellPointerMove: (e: React.PointerEvent) => void;
  onCellPointerUp: (e: React.PointerEvent) => void;
  onCellPointerCancel: () => void;
  onCellContext: (e: React.MouseEvent, roomId: string, date: DateOnly) => void;
  onCellDouble: (roomId: string, date: DateOnly, minNights: number) => void;
  onCellHoverStart: (e: React.PointerEvent, room: CalendarRoom, date: DateOnly, rate: RateRow | undefined) => void;
  onCellHoverEnd: () => void;
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
  // the state colour is a §1 token, carried by a class (dot + word share it)
  const statusTone = !sellable ? "off" : occupiedNow ? "busy" : "free";

  return (
    <div className="cb-rrow">
      {/* room info — sticky inline-start column */}
      <div className="cb-rlabel" style={{ width: ROOM_COL }}>
        <div className="cb-rl1">
          <span className="cb-rnum ltr-num">{room.room_number}</span>
          <span className="cb-rtype">
            {room.room_type_name ?? room.name ?? "—"}
          </span>
        </div>
        <div className="cb-rl2">
          {room.floor ? <span>קומה {room.floor}</span> : <span>{room.area_name ?? ""}</span>}
          <span className={`cb-rst ${statusTone}`}>
            <span className="cb-d" />
            {statusText}
          </span>
        </div>
      </div>

      {/* day cells + bars */}
      <div className="cb-rstrip">
        {dates.map((d) => {
          const dow = dayOfWeek(d);
          const weekend = dow === 5 || dow === 6;
            const rate = cellRate(room, d);
          const price = rate?.price != null ? Number(rate.price) : room.base_price;
          // Binding minimum for a guest arriving this day = stricter of arrival-min
          // and this cell's through-min (the Group Update's primary "מינימום לילות").
          // 0 = no minimum. Shown as the moon hint and used to size a double-click.
          const minN = Math.max(rate?.min_nights ?? 0, rate?.min_stay_through ?? 0);
          const closed = rate?.closed ?? false;
          const creatable = can.create && sellable;
          return (
            <div
              key={d}
              className={`cb-rcell ${weekend ? "we" : ""} ${d === today ? "td" : ""} ${!sellable ? "blocked" : ""} ${creatable ? "cr" : ""}`}
              onPointerDown={
                creatable ? (e) => onCellPointerDown(e, roomIndex, d, minN || 1) : undefined
              }
              onPointerMove={creatable ? onCellPointerMove : undefined}
              onPointerUp={creatable ? onCellPointerUp : undefined}
              onPointerCancel={creatable ? onCellPointerCancel : undefined}
              onDoubleClick={creatable ? () => onCellDouble(room.id, d, minN || 1) : undefined}
              onContextMenu={
                can.create || can.close ? (e) => onCellContext(e, room.id, d) : undefined
              }
              onPointerEnter={sellable ? (e) => onCellHoverStart(e, room, d, rate) : undefined}
              onPointerLeave={sellable ? onCellHoverEnd : undefined}
            >
              {sellable && (
                <>
                  <span className={`cb-pr ltr-num ${closed ? "cx" : ""}`}>
                    ₪{Math.round(price)}
                  </span>
                  {closed ? (
                    // commercial stop-sell — a dense-cell marker (§12.1), distinct
                    // from the gray dashed physical .cb-blockbar and from pills.
                    // A 28px .chip cannot fit a ~37px-wide day column.
                    <span className="cb-cx">סגור</span>
                  ) : (
                    minN >= 2 && (
                      <span className="cb-mn">
                        <Icon name="moon" size={13.5} />
                        {minN}
                      </span>
                    )
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
              // §3.1 neutral ("הוחזר") — the approved triplet, not a local colour
              style={{
                insetInlineStart: `${geo.start * 100}%`,
                width: `${geo.width * 100}%`,
                background: NEUTRAL_STATUS.bg,
                borderColor: NEUTRAL_STATUS.bd,
                color: NEUTRAL_STATUS.tx,
              }}
            >
              <Icon name="circle-slash" size={13.5} />
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
            onHoverStart={onBarHoverStart}
            onHoverEnd={onBarHoverEnd}
            onHandleHover={onHandleHover}
            onOpenEditor={onOpenEditor}
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
  onHoverStart,
  onHoverEnd,
  onHandleHover,
  onOpenEditor,
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
  onPointerUp: (e: React.PointerEvent, stay: CalendarStay) => void;
  onPointerCancel: () => void;
  onHoverStart: (e: React.PointerEvent, stay: CalendarStay, room: CalendarRoom) => void;
  onHoverEnd: () => void;
  onHandleHover: () => void;
  onOpenEditor: (stay: CalendarStay) => void;
}) {
  const pal = stayPalette(stay);
  const geo = barGeometry(from, days, stay.check_in, stay.check_out);
  const nights = nightsBetween(stay.check_in, stay.check_out);
  const draggable = canDragCard(canEdit, pending);
  // null for internal reservations → no badge, no wrapper, no reserved width
  const channel = normalizeVisibleChannel(stay.source_key);

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
      onPointerUp={draggable ? (e) => onPointerUp(e, stay) : undefined}
      onPointerCancel={draggable ? onPointerCancel : undefined}
      onPointerEnter={canView ? (e) => onHoverStart(e, stay, room) : undefined}
      onPointerLeave={canView ? onHoverEnd : undefined}
      onClick={draggable ? undefined : () => onOpenEditor(stay)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenEditor(stay);
        }
      }}
    >
      {/* channel first (RTL: right-hand leading edge), then VIP, then name */}
      {channel && <ChannelBadge channel={channel} size="lg" ring />}
      {stay.is_vip && <Icon name="star" size={13.5} className="cb-vip" />}
      <span className="cb-nm">{stay.guest_name}</span>
      {stay.room_count > 1 && <Icon name="link" size={13.5} className="shrink-0 opacity-70" />}
      <span className="cb-bn">
        <Icon name="moon" size={13.5} />
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
          onPointerEnter={onHandleHover}
          onPointerDown={(e) => {
            e.stopPropagation();
            onPointerDown(e, stay, roomIndex, "resize");
          }}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => {
            e.stopPropagation();
            onPointerUp(e, stay);
          }}
          onPointerCancel={onPointerCancel}
        />
      )}
    </div>
  );
});
