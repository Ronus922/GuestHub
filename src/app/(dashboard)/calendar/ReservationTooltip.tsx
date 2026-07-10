"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/shared/Icon";
import { nightsBetween, HEBREW_MONTHS } from "@/lib/dates";
import { formatBalance } from "@/lib/inventory-rules";
import { stayPalette } from "./CalendarGrid";
import type { CalendarRoom, CalendarStay } from "./types";

// Reservation HOVER tooltip (reference rooms-calendar .pop / Tooltip.png) —
// INFORMATIONAL ONLY and NON-INTERACTIVE (D41/D44): `pointer-events: none` (see
// .cb-pop) means it can NEVER capture pointerdown/up/click/drag, never become a
// drop target, and never sits "on top of" the pill for input — so it can never
// block grabbing the pill or its resize handles. It performs no server write
// and has no buttons; editing happens by clicking the pill itself (§3). It is
// always positioned OUTSIDE the pill with an ~10px gap (above, flipping below).

export type TooltipTarget = {
  stay: CalendarStay;
  room: CalendarRoom;
  anchor: { x: number; top: number; bottom: number };
};

const POP_W = 316;
const GAP = 10; // px gap between the pill edge and the tooltip (§1: 8–12px)

function hebDayMonth(d: string): string {
  return `${Number(d.slice(8, 10))} ב${HEBREW_MONTHS[Number(d.slice(5, 7)) - 1]}`;
}

export function ReservationTooltip({
  target,
  statusLabel,
}: {
  target: TooltipTarget | null;
  statusLabel: Map<string, string>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; place: "above" | "below" } | null>(null);

  // position after render (needs the measured height): prefer ABOVE the pill
  // with a visible gap, flip BELOW when there is not enough room above; clamp
  // horizontally so it stays inside the viewport and NEVER over the pill (§1)
  useLayoutEffect(() => {
    if (!target || !ref.current) {
      setPos(null);
      return;
    }
    const h = ref.current.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.min(Math.max(target.anchor.x - POP_W / 2, 8), vw - POP_W - 8);
    // above = the whole card fits in the gap above the pill top
    const above = target.anchor.top - h - GAP;
    let place: "above" | "below";
    let top: number;
    if (above >= 8) {
      place = "above";
      top = above;
    } else {
      place = "below";
      top = Math.min(target.anchor.bottom + GAP, vh - h - 8);
    }
    setPos({ top, left, place });
  }, [target]);

  if (!target) return null;

  const { stay, room } = target;
  const pal = stayPalette(stay);
  const nights = nightsBetween(stay.check_in, stay.check_out);
  const initials = stay.guest_name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("");
  // draft (pending-approval) shows its status badge, like Tooltip.png;
  // otherwise the payment state (rooms-calendar popover)
  const PAY_LABEL: Record<CalendarStay["payment"], string> = {
    paid: "שולם מלא",
    overpaid: "שולם ביתר",
    partial: "שולם חלקית",
    unpaid: "לא שולם",
  };
  const badge =
    stay.status === "draft"
      ? { label: statusLabel.get("draft") ?? "ממתין לאישור", bg: "#FDF2E1", tx: "#B4670A" }
      : { label: PAY_LABEL[stay.payment] ?? "לא שולם", bg: pal.bg, tx: pal.tx };
  // canonical balance (D52 §7): NOT floored — a credit is shown as a credit,
  // never as a zero balance. Shared formatter, one semantics everywhere.
  const bal = formatBalance(stay.total_price, stay.paid_amount);
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
      role="tooltip"
      aria-label={`הזמנה ${stay.reservation_number}`}
      data-place={pos?.place ?? "above"}
      // physical `left` on purpose: the card is direction:rtl, so a logical
      // inset would mirror the computed viewport-clamped position
      style={
        pos
          ? { top: pos.top, left: pos.left, visibility: "visible" }
          : { top: 0, left: 0, visibility: "hidden" }
      }
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
            {bal.kind === "settled" ? (
              " · שולם במלואו"
            ) : (
              <>
                {" "}
                · {bal.label} <b>₪{bal.amount.toLocaleString()}</b>
              </>
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
        {stay.workflow_label && stay.workflow_color && (
          <p className="cb-pl">
            <span
              className="mx-0.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: stay.workflow_color }}
              aria-hidden
            />
            <span>סטטוס: {stay.workflow_label}</span>
          </p>
        )}
      </div>
      <p className="cb-pop-hint">לחצו על ההזמנה לעריכה · גררו להזזה</p>
    </div>
  );
}
