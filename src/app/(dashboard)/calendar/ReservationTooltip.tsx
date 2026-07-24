"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/shared/Icon";
import { ChannelBadge } from "@/components/shared/ChannelBadge";
import { CHANNEL_CONFIG, resolveChannelBadge } from "@/lib/colors";
import { nightsBetween, HEBREW_MONTHS } from "@/lib/dates";
import { formatBalance } from "@/lib/inventory-rules";
import { STATUS_COLORS } from "@/lib/status-colors";
import { PAY_STYLE } from "./CalendarGrid";
import type { CalendarRoom, CalendarStay } from "./types";

// Reservation HOVER tooltip — the invitation card of
// ref/screens/InvitationCard.png (D88): brand-blue header, avatar + guest name +
// room/type/floor sub-line, payment chip on the far side, hairline divider, one
// icon+text row per fact, blue action line at the foot. D87 had replaced it with
// a white header taken from a different reference bundle.
//
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

// §8: the ONE canonical popover width (.popover in design-system.css). The
// caret/clamp math below derives from this constant, so it MUST mirror the CSS.
const POP_W = 316;
const GAP = 10; // px gap between the pill edge and the tooltip (§1: 8–12px)
const MARGIN = 12; // §8 viewport margin

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
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    place: "above" | "below";
    caret: number;
  } | null>(null);

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
    const left = Math.min(
      Math.max(target.anchor.x - POP_W / 2, MARGIN),
      vw - POP_W - MARGIN,
    );
    // above = the whole card fits in the gap above the pill top
    const above = target.anchor.top - h - GAP;
    let place: "above" | "below";
    let top: number;
    if (above >= MARGIN) {
      place = "above";
      top = above;
    } else {
      place = "below";
      top = Math.min(target.anchor.bottom + GAP, vh - h - MARGIN);
    }
    // the speech-bubble pointer stays under the pill it belongs to, even after
    // the card is clamped away from the viewport edge (kept off the rounded
    // corners)
    const caret = Math.min(Math.max(target.anchor.x - left, 26), POP_W - 26);
    setPos({ top, left, place, caret });
  }, [target]);

  if (!target) return null;

  const { stay, room } = target;
  // every reservation shows a channel row: external channel, or the manual pencil
  const channel = resolveChannelBadge(stay.source_key);
  // the payment badge keeps PAYMENT colors (D77.1): the pill now wears the
  // workflow family, and neither domain may repaint the other
  const pal = PAY_STYLE[stay.payment];
  const nights = nightsBetween(stay.check_in, stay.check_out);
  const initials = stay.guest_name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("");
  // draft (pending-approval) shows its status badge; otherwise the payment state.
  // The chip carries its own tint either way — payment state and reservation
  // status are two axes and neither may repaint the other.
  const PAY_LABEL: Record<CalendarStay["payment"], string> = {
    paid: "שולם מלא",
    overpaid: "שולם ביתר",
    partial: "שולם חלקית",
    unpaid: "ממתין לתשלום",
  };
  // the tag is a canonical .chip wearing an approved §3.1 class — the triplet is
  // never re-typed here
  const badge =
    stay.status === "draft"
      ? { label: statusLabel.get("draft") ?? "ממתין לאישור", chip: STATUS_COLORS.approval.chip }
      : { label: PAY_LABEL[stay.payment] ?? "ממתין לתשלום", chip: pal.chip };
  // canonical balance (D52 §7): NOT floored — a credit is shown as a credit,
  // never as a zero balance. Shared formatter, one semantics everywhere.
  const bal = formatBalance(stay.total_price, stay.paid_amount);
  // sub-line: the room number bold, type and floor muted beside it (reference)
  const subRest = [room.room_type_name, room.floor ? `קומה ${room.floor}` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      ref={ref}
      className="popover cb-pop"
      role="tooltip"
      aria-label={`הזמנה ${stay.reservation_number}`}
      data-place={pos?.place ?? "above"}
      // physical `left` on purpose: the card is direction:rtl, so a logical
      // inset would mirror the computed viewport-clamped position
      style={
        pos
          ? ({
              top: pos.top,
              left: pos.left,
              visibility: "visible",
              "--cb-caret": `${pos.caret}px`,
            } as React.CSSProperties)
          : { top: 0, left: 0, visibility: "hidden" }
      }
    >
      <div className="cb-pop-h">
        <span className="dw-icon cb-pav">{initials}</span>
        <div className="min-w-0">
          <p className="cb-pop-nm">
            {stay.is_vip && <Icon name="star" size={13.5} className="cb-vip" />}
            {/* a Latin guest name keeps its own direction inside the RTL card */}
            <bdi className="truncate">{stay.guest_name}</bdi>
          </p>
          <p className="cb-pop-sub">
            חדר <b>{room.room_number}</b>
            {subRest && ` · ${subRest}`}
          </p>
        </div>
        <span className={`chip ${badge.chip}`}>
          {badge.label}
          <span className="dot" />
        </span>
      </div>

      {/* the approved body: compact rows — dates, nights+room, channel (only
          for a visible external/site channel; an internal reservation has no
          channel row at all), money. The reservation number and the
          order-status chip are NOT on this card (InvitationCard.png); they
          live in the editor. */}
      <div className="cb-pop-b">
        <p className="cb-pl">
          <Icon name="calendar" size={17} className="cb-pli" />
          <span>
            <b>
              {hebDayMonth(stay.check_in)} – {hebDayMonth(stay.check_out)}
            </b>{" "}
            {stay.check_out.slice(0, 4)}
          </span>
        </p>
        <p className="cb-pl">
          <Icon name="moon" size={17} className="cb-pli" />
          <span>
            <b>{nights}</b> לילות · חדר <b>{room.room_number}</b> ·{" "}
            {statusLabel.get(stay.status) ?? stay.status}
          </span>
        </p>
        {/* the channel row CONSOLIDATES the old free-text "מקור" row: one
            normalized name + the same badge the pill wears (md, no ring). */}
        <p className="cb-pl">
          <Icon name="hub" size={17} className="cb-pli" />
          <span>
            ערוץ: <b>{CHANNEL_CONFIG[channel].name}</b>
          </span>
          <ChannelBadge channel={channel} size="md" />
        </p>
        <p className="cb-pl">
          <Icon name="finance" size={17} className="cb-pli" />
          <span>
            סה״כ <b className="ltr-num">₪{stay.total_price.toLocaleString()}</b>
            {bal.kind === "settled" ? (
              " · שולם במלואו"
            ) : (
              <>
                {" "}
                · {bal.label} <b className="ltr-num">₪{bal.amount.toLocaleString()}</b>
              </>
            )}
          </span>
        </p>
      </div>
      <p className="cb-pop-hint">לחצו על ההזמנה לעריכה · גררו להזזה</p>
    </div>
  );
}
