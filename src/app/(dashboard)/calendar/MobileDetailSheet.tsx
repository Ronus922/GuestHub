"use client";

import { Icon, type IconName } from "@/components/shared/Icon";
import { formatDayHebMonth, nightsBetween, type DateOnly } from "@/lib/dates";
import { paymentTriplet } from "@/lib/status-colors";
import { CHANNEL_CONFIG, resolveChannelBadge } from "@/lib/colors";
import type { PaymentState } from "@/lib/inventory-rules";
import { ChannelBadge } from "@/components/shared/ChannelBadge";
import type { CalendarRoom, CalendarStay } from "./types";

const PAY_LABEL: Record<PaymentState, string> = {
  unpaid: "ממתין לתשלום",
  partial: "שולם חלקית",
  paid: "שולם מלא",
  overpaid: "שולם ביתר",
};

// The primary action reflects the stay's lifecycle, but every button routes into
// the real EditReservationPanel (permission- & card-guarded) — this sheet is a
// touch quick-view, not a place to run transactional check-in/out itself.
function primaryAction(status: string, checkIn: DateOnly, today: DateOnly): {
  label: string;
  icon: IconName;
} {
  if (status === "pending" || status === "draft") return { label: "אישור הזמנה", icon: "check" };
  if (status === "confirmed" && checkIn <= today) return { label: "צ׳ק-אין", icon: "login" };
  if (status === "checked_in") return { label: "צ׳ק-אאוט", icon: "logout" };
  return { label: "עריכה", icon: "edit" };
}

// Mobile reservation card (reference bottom-sheet). Read-only detail; the smart
// primary + the edit square both open the reservation in the real edit flow.
export function MobileDetailSheet({
  stay,
  rooms,
  statusLabel,
  today,
  onClose,
  onOpenReservation,
}: {
  stay: CalendarStay | null;
  rooms: CalendarRoom[];
  statusLabel: Map<string, string>;
  today: DateOnly;
  onClose: () => void;
  onOpenReservation: (reservationId: string) => void;
}) {
  if (!stay) return null;

  const room = rooms.find((r) => r.id === stay.room_id);
  const pal = paymentTriplet(stay.payment);
  const badge = resolveChannelBadge(stay.source_key);
  const channel = CHANNEL_CONFIG[badge];
  const nights = nightsBetween(stay.check_in, stay.check_out);
  const initials = stay.guest_name
    .replace("משפחת ", "")
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("");
  const sub = [
    `חדר ${stay.room_id && room ? room.room_number : "—"}`,
    room?.room_type_name,
    room?.floor ? `קומה ${room.floor}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const primary = primaryAction(stay.status, stay.check_in, today);
  const open = () => onOpenReservation(stay.reservation_id);

  return (
    <>
      <button
        type="button"
        aria-label="סגירה"
        className="cb-sheet-backdrop"
        onClick={onClose}
      />
      <div className="cb-sheet" role="dialog" aria-label={`הזמנה · ${stay.guest_name}`}>
        <div className="cb-sheet-hd">
          <span className="cb-sheet-av">{initials}</span>
          <div className="min-w-0 flex-1">
            <div className="cb-sheet-nm">
              {stay.is_vip && <Icon name="star" size={17} className="cb-sheet-vip" />}
              {stay.guest_name}
            </div>
            <div className="cb-sheet-sub">{sub}</div>
          </div>
          <button type="button" className="cb-sheet-x" aria-label="סגירה" onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="cb-sheet-body">
          <div className="flex flex-wrap items-center gap-[10px]">
            <span
              className="cb-sheet-badge"
              style={{ background: pal.bg, color: pal.tx }}
            >
              <span className="dot" style={{ background: pal.dot }} />
              {PAY_LABEL[stay.payment]}
            </span>
            <span className="cb-sheet-ch">
              <ChannelBadge channel={badge} size="md" />
              {channel.name}
            </span>
          </div>
          <p className="cb-sheet-row">
            <Icon name="calendar" size={17} className="cb-sheet-ri" />
            {formatDayHebMonth(stay.check_in)} – {formatDayHebMonth(stay.check_out)}{" "}
            {stay.check_out.slice(0, 4)}
          </p>
          <p className="cb-sheet-row">
            <Icon name="moon" size={17} className="cb-sheet-ri" />
            <span>
              <b className="ltr-num">{nights}</b> לילות · חדר <b>{room?.room_number ?? "—"}</b> ·{" "}
              {statusLabel.get(stay.status) ?? stay.status}
            </span>
          </p>
          <p className="cb-sheet-row">
            <Icon name="payments" size={17} className="cb-sheet-ri" />
            <span>
              סה״כ <b className="ltr-num">₪{Math.round(stay.total_price).toLocaleString("en-US")}</b>{" "}
              · לפי מחירון יומי
            </span>
          </p>
        </div>

        <div className="cb-sheet-ft">
          <button type="button" className="cb-sheet-cancel" onClick={onClose}>
            ביטול
          </button>
          <button type="button" className="cb-sheet-edit" aria-label="עריכה" onClick={open}>
            <Icon name="edit" size={17} />
          </button>
          <button type="button" className="cb-sheet-main" onClick={open}>
            <Icon name={primary.icon} size={17} />
            {primary.label}
          </button>
        </div>
      </div>
    </>
  );
}
