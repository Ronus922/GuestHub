"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/shared/Icon";
import { formatFullDate } from "@/lib/dates";
import { CLOSED_TO_ARRIVAL_TEXT, CLOSED_TO_DEPARTURE_TEXT, stayLimit } from "@/lib/rates/rules";
import { clampPopoverLeft, popoverWidth, POPOVER_MARGIN } from "@/lib/popover";
import type { RateRow } from "@/lib/inventory-rules";
import type { CalendarRoom } from "./types";

// Empty-cell HOVER tooltip — the DETAIL half of the combined display decision:
// the cell itself carries only compact MARKERS (a ~37-60px column cannot hold
// more), and the full commercial state of that room-night is read here.
//
// It is deliberately a sibling of ReservationTooltip and copies its contract
// exactly, because the two share one hover budget on the same board:
//   · same open/close delays (TOOLTIP_OPEN_MS / TOOLTIP_CLOSE_MS, owned by the
//     caller's timers) — a pointer crossing the grid must not strobe;
//   · same positioning: measured after render, ABOVE the cell with a gap,
//     flipped below when it does not fit, clamped into the viewport with the
//     shared §8 geometry (lib/popover), physical `left` on purpose since the
//     card is direction:rtl;
//   · INFORMATIONAL ONLY and non-interactive (`.cb-pop` sets pointer-events:
//     none) so it can never become a drop target or swallow a pointerdown;
//   · never opened while a drag session is live — the caller guards that, the
//     same way it guards the reservation tooltip.
//
// It shows only what the cell's row actually says. A field with no restriction
// is OMITTED rather than rendered as "ללא" — six always-present rows would bury
// the one line that matters.

export type CellTipTarget = {
  room: CalendarRoom;
  date: string;
  rate: RateRow | undefined;
  /** the room-type base price, used when the plan row carries no price */
  basePrice: number;
  currency: string;
  anchor: { x: number; top: number; bottom: number };
};

const GAP = 10; // px between the cell edge and the card (§1: 8–12px)

export function RateCellTooltip({ target }: { target: CellTipTarget | null }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    place: "above" | "below";
    caret: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!target || !ref.current) {
      setPos(null);
      return;
    }
    const h = ref.current.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const popW = popoverWidth(vw);
    const left = clampPopoverLeft(target.anchor.x - popW / 2, vw);
    const above = target.anchor.top - h - GAP;
    let place: "above" | "below";
    let top: number;
    if (above >= POPOVER_MARGIN) {
      place = "above";
      top = above;
    } else {
      place = "below";
      top = Math.min(target.anchor.bottom + GAP, vh - h - POPOVER_MARGIN);
    }
    const caret = Math.min(Math.max(target.anchor.x - left, 26), popW - 26);
    setPos({ top, left, place, caret });
  }, [target]);

  if (!target) return null;

  const { room, date, rate, basePrice, currency } = target;
  const price = rate?.price != null ? Number(rate.price) : basePrice;
  const minArrival = stayLimit(rate?.min_nights);
  const minThrough = stayLimit(rate?.min_stay_through);
  const minNights = Math.max(minArrival ?? 0, minThrough ?? 0) || null;
  const maxNights = stayLimit(rate?.max_nights);
  const cta = rate?.closed_to_arrival ?? false;
  const ctd = rate?.closed_to_departure ?? false;
  const stopSell = rate?.closed ?? false;
  const symbol = currency === "ILS" ? "₪" : "";

  return (
    <div
      ref={ref}
      className="popover cb-pop cb-cellpop"
      role="tooltip"
      aria-label={`מצב מסחרי · חדר ${room.room_number} · ${formatFullDate(date)}`}
      data-place={pos?.place ?? "above"}
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
        <span className="dw-icon cb-pav">
          <Icon name="calendar" size={20} />
        </span>
        <div className="min-w-0">
          <p className="cb-pop-nm">
            <bdi className="truncate">{formatFullDate(date)}</bdi>
          </p>
          <p className="cb-pop-sub">
            חדר <b>{room.room_number}</b>
            {room.room_type_name ? ` · ${room.room_type_name}` : ""}
          </p>
        </div>
      </div>

      <div className="cb-pop-b">
        <p className="cb-pl">
          <Icon name="finance" size={17} className="cb-pli" />
          <span>
            מחיר{" "}
            <b className="ltr-num">
              {symbol}
              {Math.round(price).toLocaleString()}
            </b>
            {rate?.price == null ? " · מחיר בסיס" : ""}
          </span>
        </p>
        {minNights != null && (
          <p className="cb-pl">
            <Icon name="moon" size={17} className="cb-pli" />
            <span>
              מינימום <b className="ltr-num">{minNights}</b> לילות
            </span>
          </p>
        )}
        {maxNights != null && (
          <p className="cb-pl">
            <Icon name="hourglass" size={17} className="cb-pli" />
            <span>
              מקסימום <b className="ltr-num">{maxNights}</b> לילות
            </span>
          </p>
        )}
        {cta && (
          <p className="cb-pl">
            <Icon name="login" size={17} className="cb-pli" />
            <span>
              <b>{CLOSED_TO_ARRIVAL_TEXT}</b>
            </span>
          </p>
        )}
        {ctd && (
          <p className="cb-pl">
            <Icon name="logout" size={17} className="cb-pli" />
            <span>
              <b>{CLOSED_TO_DEPARTURE_TEXT}</b>
            </span>
          </p>
        )}
        {stopSell && (
          <p className="cb-pl">
            <Icon name="circle-slash" size={17} className="cb-pli" />
            <span>
              <b>סגור למכירה</b>
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
