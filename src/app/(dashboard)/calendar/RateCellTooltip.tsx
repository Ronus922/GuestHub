"use client";

import { useLayoutEffect, useState, useRef } from "react";
import { Icon } from "@/components/shared/Icon";
import { formatFullDate, type DateOnly } from "@/lib/dates";
import type { RateRow } from "@/lib/inventory-rules";
import type { CalendarRoom } from "./types";

// Empty-cell COMMERCIAL hover tooltip (§2) — INFORMATIONAL ONLY. It reads
// exclusively from the already-fetched data.rates row for one room/date and
// performs no write of any kind. Deliberately distinct from the reservation
// ReservationTooltip: this describes commercial policy (price / restrictions /
// stop-sell), never a booking, an occupied room, or a physical closure.

export type CellTipTarget = {
  room: CalendarRoom;
  date: DateOnly;
  rate: RateRow | undefined;
  anchor: { x: number; top: number; bottom: number };
};

// §8: the ONE canonical popover width (.popover in design-system.css). The
// clamp math below derives from this constant, so it MUST mirror the CSS.
const TIP_W = 316;
const MARGIN = 12; // §8 viewport margin
const DASH = "—";

export function RateCellTooltip({
  target,
  onKeepAlive,
  onRelease,
}: {
  target: CellTipTarget | null;
  onKeepAlive: () => void;
  onRelease: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; place: "above" | "below" } | null>(null);

  // position after render (needs the measured height): prefer ABOVE the cell,
  // flip below near the viewport top; clamped so it never leaves the viewport.
  useLayoutEffect(() => {
    if (!target || !ref.current) {
      setPos(null);
      return;
    }
    const h = ref.current.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.min(
      Math.max(target.anchor.x - TIP_W / 2, MARGIN),
      vw - TIP_W - MARGIN,
    );
    let place: "above" | "below" = "above";
    let top = target.anchor.top - h - 10;
    if (top < MARGIN) {
      place = "below";
      top = Math.min(target.anchor.bottom + 10, vh - h - MARGIN);
    }
    setPos({ top, left, place });
  }, [target]);

  if (!target) return null;

  const { room, date, rate } = target;
  // effective price mirrors the cell chip's fallback (rate price → base price)
  const price = rate?.price != null ? Number(rate.price) : room.base_price;
  const closed = rate?.closed ?? false;
  const minN = rate?.min_nights ?? null;
  const maxN = rate?.max_nights ?? null;
  const cta = rate?.closed_to_arrival ?? false;
  const ctd = rate?.closed_to_departure ?? false;

  return (
    <div
      ref={ref}
      className={`popover cb-rtip ${closed ? "cl-card" : ""}`}
      role="tooltip"
      aria-label={`תעריף · חדר ${room.room_number} · ${formatFullDate(date)}`}
      data-place={pos?.place ?? "above"}
      // physical `left`: the card is direction:rtl, so a logical inset would
      // mirror the computed viewport-clamped position
      style={
        pos
          ? { top: pos.top, left: pos.left, visibility: "visible" }
          : { top: 0, left: 0, visibility: "hidden" }
      }
      onPointerEnter={onKeepAlive}
      onPointerLeave={onRelease}
    >
      <div className="cb-rtip-h">
        <span className="cb-rtip-t">חדר {room.room_number}</span>
        <span className="cb-rtip-dt">{formatFullDate(date)}</span>
      </div>

      <div className="cb-rtip-b">
        <div className="cb-rtip-row">
          <span className="cb-rtip-k">מחיר</span>
          <span className="cb-rtip-v ltr-num">₪{Math.round(price).toLocaleString()}</span>
        </div>
        <div className="cb-rtip-row">
          <span className="cb-rtip-k">מינימום לילות</span>
          <span className={`cb-rtip-v ${minN == null ? "dash" : ""}`}>{minN != null ? minN : DASH}</span>
        </div>
        <div className="cb-rtip-row">
          <span className="cb-rtip-k">מקסימום לילות</span>
          <span className={`cb-rtip-v ${maxN == null ? "dash" : ""}`}>{maxN != null ? maxN : DASH}</span>
        </div>
        <div className="cb-rtip-row">
          <span className="cb-rtip-k">הגעה (CTA)</span>
          <span className={`cb-rtip-v ${cta ? "no" : "yes"}`}>{cta ? "חסום" : "פתוח"}</span>
        </div>
        <div className="cb-rtip-row">
          <span className="cb-rtip-k">עזיבה (CTD)</span>
          <span className={`cb-rtip-v ${ctd ? "no" : "yes"}`}>{ctd ? "חסום" : "פתוח"}</span>
        </div>
      </div>

      <div className={`cb-rtip-f ${closed ? "cl" : "op"}`}>
        <Icon name={closed ? "circle-slash" : "check"} size={13.5} />
        {closed ? "סגור למכירה" : "פתוח למכירה"}
      </div>
    </div>
  );
}
