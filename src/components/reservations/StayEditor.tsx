"use client";

import { useEffect, useState } from "react";
import { DateRangeField } from "@/components/shared/DateRangeField";
import { Icon } from "@/components/shared/Icon";
import { nightsBetween } from "@/lib/dates";
import {
  getAvailableRoomsAction,
  getStayQuoteAction,
} from "@/app/(dashboard)/reservations/actions";

// One reservation-room editor block (locked per-room model §C): its own
// dates, occupancy, physical room and optional per-room guest. Used by both
// the booking wizard and the edit window — one flow, no calendar-only
// editor. Visuals per ref/screens/new-booking-step-2-stay-details.png.

export type StayDraft = {
  key: string;
  rrId?: string;
  roomId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  infants: number;
  ratePerNight?: number;
  // authorized manual override (§13) — set ONLY when the operator explicitly
  // edits the nightly price; a displayed auto price never becomes manual.
  isManualRate?: boolean;
  // tenant-level Rate Plan; null/undefined = base pricing (מחיר בסיס)
  ratePlanId?: string | null;
  guestFirstName?: string;
  guestLastName?: string;
  guestPhone?: string;
};

export type RoomOption = {
  id: string;
  room_number: string;
  name: string | null;
  room_type_name: string | null;
  max_occupancy: number;
  max_adults: number;
  max_children: number;
  max_infants: number;
  avg_price: number;
  free: boolean;
};

export function newStayKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function StayEditor({
  index,
  value,
  onChange,
  onRemove,
  excludeReservationId,
  disabled = false,
}: {
  index: number;
  value: StayDraft;
  onChange: (next: StayDraft) => void;
  onRemove?: () => void;
  excludeReservationId?: string;
  disabled?: boolean;
}) {
  const [rooms, setRooms] = useState<RoomOption[]>([]);
  const [quote, setQuote] = useState<{ total: number; restriction: string | null } | null>(null);
  const [showGuest, setShowGuest] = useState(
    Boolean(value.guestFirstName || value.guestLastName || value.guestPhone),
  );
  // reference edit-modal: a chosen room renders as a summary row with a
  // "החלף חדר" button; the select shows only while actually choosing
  const [changing, setChanging] = useState(false);

  const validRange = value.checkIn && value.checkOut && value.checkOut > value.checkIn;
  const nights = validRange ? nightsBetween(value.checkIn, value.checkOut) : 0;

  // free rooms for the chosen window
  useEffect(() => {
    if (!validRange) return;
    let alive = true;
    getAvailableRoomsAction({
      checkIn: value.checkIn,
      checkOut: value.checkOut,
      excludeReservationId,
    }).then((res) => {
      if (alive && res.success && res.data) setRooms(res.data);
    });
    return () => {
      alive = false;
    };
  }, [value.checkIn, value.checkOut, validRange, excludeReservationId]);

  // live price + restriction quote for the chosen room
  useEffect(() => {
    if (!validRange || !value.roomId) {
      setQuote(null);
      return;
    }
    let alive = true;
    getStayQuoteAction({
      roomId: value.roomId,
      checkIn: value.checkIn,
      checkOut: value.checkOut,
      adults: value.adults,
      children: value.children,
      infants: value.infants,
      ratePlanId: value.ratePlanId ?? null,
    }).then(
      (res) => {
        if (alive && res.success && res.data) {
          setQuote({ total: res.data.total, restriction: res.data.restriction });
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [value.roomId, value.checkIn, value.checkOut, value.adults, value.children, value.infants, value.ratePlanId, validRange]);

  const selected = rooms.find((r) => r.id === value.roomId);
  // the assigned room is occupied in the CHOSEN window (the list is fetched with
  // excludeReservationId, so a stay never conflicts with itself)
  const roomTaken = selected != null && !selected.free;
  const overCapacity =
    selected != null &&
    (value.adults > selected.max_adults ||
      value.children > selected.max_children ||
      value.infants > selected.max_infants ||
      value.adults + value.children > selected.max_occupancy);

  return (
    <div className="bw-roomcard">
      <div className="bw-rc-top">
        <span className="bw-rc-badge">{index + 1}</span>
        <span className="bw-rc-ttl">חדר {index + 1}</span>
        {onRemove && (
          <button type="button" onClick={onRemove} className="btn btn-tertiary bw-rc-rm">
            <Icon name="trash" size={20} />
            הסר
          </button>
        )}
      </div>

      <div className="bw-grid3">
        <DateRangeField
          from={value.checkIn}
          to={value.checkOut}
          disabled={disabled}
          // Moving the dates KEEPS the room: unassigning it silently left the
          // stay invalid, which locked "שמור שינויים" while the panel still read
          // "יש שינויים שלא נשמרו". Availability is re-checked below (and again
          // on the server, under lock) — a real conflict is SAID, never guessed.
          onApply={(checkIn, checkOut) => onChange({ ...value, checkIn, checkOut })}
        />
        <div className="field dp-after">
          <span className="field-label">
            לילות <span className="font-normal text-faint">(מחושב)</span>
          </span>
          <div className="bw-readonly">
            <span className="ltr-num">{nights || "—"}</span>
            <span className="bw-rn">
              <Icon name="moon" size={17} />
              אוטומטי
            </span>
          </div>
        </div>
      </div>

      <div className="bw-grid3 mt-4">
        <Counter label="מבוגרים" value={value.adults} min={1} disabled={disabled} onChange={(adults) => onChange({ ...value, adults })} />
        <Counter label="ילדים" value={value.children} min={0} disabled={disabled} onChange={(children) => onChange({ ...value, children })} />
        <Counter label="תינוקות" value={value.infants} min={0} disabled={disabled} onChange={(infants) => onChange({ ...value, infants })} />
      </div>

      {selected && !changing ? (
        /* V2 .roomsel — room number bold-brand first, type after, swap = outline button */
        <div className="bw-rc-room">
          <span className="bw-rc-ric">
            <Icon name="rooms" size={24} />
          </span>
          <div className="bw-rc-info">
            <p className="bw-rc-rn truncate">
              <b>חדר {selected.room_number}</b>
              {selected.room_type_name || selected.name
                ? ` · ${selected.room_type_name ?? selected.name}`
                : ""}
            </p>
            <p className="bw-rc-rs truncate">₪{selected.avg_price} / לילה</p>
          </div>
          {!disabled && (
            <button type="button" className="btn btn-secondary" onClick={() => setChanging(true)}>
              <Icon name="refresh" size={20} />
              החלף חדר
            </button>
          )}
        </div>
      ) : (
        <label className="field mt-4">
          <span className="field-label">
            חדר <span className="bw-req">*</span>
          </span>
          <select
            className="field-input"
            value={value.roomId}
            onChange={(e) => {
              setChanging(false);
              onChange({ ...value, roomId: e.target.value });
            }}
            disabled={!validRange || disabled}
          >
            <option value="">{validRange ? "בחירת חדר פנוי…" : "בחרו תאריכים תחילה"}</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id} disabled={!r.free && r.id !== value.roomId}>
                {r.room_number}
                {r.name && r.name !== r.room_number ? ` · ${r.name}` : ""} ·{" "}
                {r.room_type_name ?? ""} · ₪{r.avg_price}/לילה
                {r.free ? "" : " · תפוס"}
              </option>
            ))}
          </select>
        </label>
      )}

      {quote && value.roomId && (
        <div className="bw-price-line mt-1.5 border-b-0">
          <span className="bw-plr">
            {nights} לילות × ₪{nights ? Math.round(quote.total / nights) : 0}
          </span>
          <b className="ltr-num text-primary">₪{quote.total.toLocaleString()}</b>
        </div>
      )}
      {quote?.restriction && (
        <p role="alert" className="mt-2 rounded-xl bg-status-danger-050 px-4 py-2.5 text-sm font-semibold text-status-danger">
          {quote.restriction}
        </p>
      )}
      {roomTaken && selected && (
        <p role="alert" className="mt-2 rounded-xl bg-status-danger-050 px-4 py-2.5 text-sm font-semibold text-status-danger">
          חדר {selected.room_number} תפוס בתאריכים שנבחרו — החליפו חדר או שנו את התאריכים
        </p>
      )}
      {overCapacity && selected && (
        <p role="alert" className="mt-2 rounded-xl bg-status-danger-050 px-4 py-2.5 text-sm font-semibold text-status-danger">
          חריגה מקיבולת החדר ({selected.max_occupancy} אורחים, עד {selected.max_adults} מבוגרים
          {selected.max_infants === 0 ? ", ללא תינוקות" : ""})
        </p>
      )}

      {!disabled && (
        <button
          type="button"
          className="btn btn-tertiary mt-3 self-start"
          onClick={() => setShowGuest((v) => !v)}
        >
          {showGuest ? "− הסתר אורח לחדר זה" : "+ אורח שונה בחדר זה (אופציונלי)"}
        </button>
      )}
      {showGuest && (
        <div className="bw-grid3 mt-2">
          <input
            className="field-input"
            placeholder="שם פרטי"
            value={value.guestFirstName ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, guestFirstName: e.target.value })}
          />
          <input
            className="field-input"
            placeholder="שם משפחה"
            value={value.guestLastName ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, guestLastName: e.target.value })}
          />
          <input
            className="field-input ltr-num"
            placeholder="טלפון"
            dir="ltr"
            value={value.guestPhone ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, guestPhone: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}

// +/- occupancy stepper (reference .qty: plus right, minus left in RTL)
function Counter({
  label,
  value,
  min,
  onChange,
  disabled = false,
}: {
  label: string;
  value: number;
  min: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="bw-qty">
        <button
          type="button"
          aria-label={`הפחתת ${label}`}
          onClick={() => onChange(Math.max(value - 1, min))}
          className="icon-btn bw-qty-b"
          disabled={disabled || value <= min}
        >
          <Icon name="minus" size={20} />
        </button>
        <span className="bw-qty-v">{value}</span>
        <button
          type="button"
          aria-label={`הוספת ${label}`}
          onClick={() => onChange(Math.min(value + 1, 20))}
          className="icon-btn bw-qty-b"
          disabled={disabled}
        >
          <Icon name="plus" size={20} />
        </button>
      </div>
    </div>
  );
}
