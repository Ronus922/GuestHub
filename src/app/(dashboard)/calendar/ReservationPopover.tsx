"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/shared/Icon";
import { nightsBetween, HEBREW_MONTHS } from "@/lib/dates";
import { stayPalette } from "./CalendarGrid";
import type { CalendarRoom, CalendarStay } from "./types";

// Reservation card popover (reference rooms-calendar .pop): a single click
// on a pill opens this anchored summary — עריכה opens the full edit window.
// Pure client render from data the calendar already holds (§10.1, no
// server call).

export type PopoverTarget = {
  stay: CalendarStay;
  room: CalendarRoom;
  anchor: { x: number; top: number; bottom: number };
};

const POP_W = 316;

function hebDayMonth(d: string): string {
  return `${Number(d.slice(8, 10))} ב${HEBREW_MONTHS[Number(d.slice(5, 7)) - 1]}`;
}

export function ReservationPopover({
  target,
  statusLabel,
  onClose,
  onEdit,
}: {
  target: PopoverTarget | null;
  statusLabel: Map<string, string>;
  onClose: () => void;
  onEdit: (reservationId: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // position after render (needs the measured height), clamped to viewport
  useLayoutEffect(() => {
    if (!target || !ref.current) {
      setPos(null);
      return;
    }
    const h = ref.current.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.min(Math.max(target.anchor.x - POP_W / 2, 8), vw - POP_W - 8);
    let top = target.anchor.bottom + 6;
    if (top + h > vh - 8) top = Math.max(target.anchor.top - h - 6, 8);
    setPos({ top, left });
  }, [target]);

  // dismiss on outside click / Escape — the click listener is registered a
  // tick late so the opening click itself never closes it
  useEffect(() => {
    if (!target) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const t = setTimeout(() => window.addEventListener("click", close), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [target, onClose]);

  if (!target) return null;

  const { stay, room } = target;
  const pal = stayPalette(stay);
  const nights = nightsBetween(stay.check_in, stay.check_out);
  const initials = stay.guest_name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("");
  // draft (pending-approval) shows its status badge, like the reference
  // Tooltip.png; otherwise the payment state (rooms-calendar popover)
  const badge =
    stay.status === "draft"
      ? { label: statusLabel.get("draft") ?? "ממתינה לאישור", bg: "#FDF2E1", tx: "#B4670A" }
      : {
          label:
            stay.payment === "paid" ? "שולם מלא" : stay.payment === "partial" ? "שולם חלקית" : "לא שולם",
          bg: pal.bg,
          tx: pal.tx,
        };
  const balance = Math.max(0, stay.total_price - stay.paid_amount);
  const sub = [
    `חדר ${room.room_number}`,
    room.room_type_name,
    room.floor ? `קומה ${room.floor}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      ref={ref}
      className="cb-pop"
      role="dialog"
      aria-label={`הזמנה ${stay.reservation_number}`}
      style={pos ? { top: pos.top, insetInlineStart: pos.left, visibility: "visible" } : { top: 0, insetInlineStart: 0, visibility: "hidden" }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="cb-pop-h">
        <span className="cb-pav">{initials}</span>
        <div className="min-w-0">
          <p className="cb-pop-nm">
            {stay.is_vip && <Icon name="star" size={13} className="cb-vip" />}
            <span className="truncate">{stay.guest_name}</span>
          </p>
          <p className="cb-pop-sub">{sub}</p>
        </div>
        <span className="cb-pbadge" style={{ background: badge.bg, color: badge.tx }}>
          <span className="cb-d" style={{ background: badge.tx }} />
          {badge.label}
        </span>
      </div>

      <div className="cb-pop-b">
        <p className="cb-pl">
          <Icon name="calendar" size={17} className="cb-pli" />
          <span>
            {hebDayMonth(stay.check_in)} – {hebDayMonth(stay.check_out)} {stay.check_out.slice(0, 4)}
          </span>
        </p>
        <p className="cb-pl">
          <Icon name="moon" size={17} className="cb-pli" />
          <span>
            <b>{nights}</b> לילות · חדר <b>{room.room_number}</b> ·{" "}
            {statusLabel.get(stay.status) ?? stay.status}
          </span>
        </p>
        <p className="cb-pl">
          <Icon name="finance" size={17} className="cb-pli" />
          <span>
            סה״כ <b>₪{stay.total_price.toLocaleString()}</b>
            {balance > 0 ? (
              <>
                {" "}
                · יתרה <b>₪{balance.toLocaleString()}</b>
              </>
            ) : (
              " · שולם במלואו"
            )}
          </span>
        </p>
        {stay.room_count > 1 && (
          <p className="cb-pl">
            <Icon name="link" size={17} className="cb-pli" />
            <span>הזמנה מרובת חדרים ({stay.room_count} חדרים)</span>
          </p>
        )}
        {stay.source_label && (
          <p className="cb-pl">
            <Icon name="channels" size={17} className="cb-pli" />
            <span>מקור: {stay.source_label}</span>
          </p>
        )}
      </div>

      <div className="cb-pop-f">
        <button type="button" className="cb-pbtn g" onClick={() => onEdit(stay.reservation_id)}>
          <Icon name="edit" size={15} />
          עריכה
        </button>
      </div>
    </div>
  );
}
