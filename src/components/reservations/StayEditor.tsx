"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/shared/Icon";
import { nightsBetween } from "@/lib/dates";
import {
  getAvailableRoomsAction,
  getStayQuoteAction,
} from "@/app/(dashboard)/reservations/actions";

// One reservation-room editor block (locked per-room model §C): its own
// dates, occupancy, physical room and optional per-room guest. Used by both
// the booking wizard and the edit panel — one flow, no calendar-only editor.

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
}: {
  index: number;
  value: StayDraft;
  onChange: (next: StayDraft) => void;
  onRemove?: () => void;
  excludeReservationId?: string;
}) {
  const [rooms, setRooms] = useState<RoomOption[]>([]);
  const [quote, setQuote] = useState<{ total: number; restriction: string | null } | null>(null);
  const [showGuest, setShowGuest] = useState(
    Boolean(value.guestFirstName || value.guestLastName || value.guestPhone),
  );

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
    getStayQuoteAction({ roomId: value.roomId, checkIn: value.checkIn, checkOut: value.checkOut }).then(
      (res) => {
        if (alive && res.success && res.data) {
          setQuote({ total: res.data.total, restriction: res.data.restriction });
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [value.roomId, value.checkIn, value.checkOut, validRange]);

  const selected = rooms.find((r) => r.id === value.roomId);
  const overCapacity =
    selected != null &&
    (value.adults > selected.max_adults ||
      value.children > selected.max_children ||
      value.infants > selected.max_infants ||
      value.adults + value.children > selected.max_occupancy);

  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="mb-4 flex items-center justify-between">
        <p className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className="grid h-6 w-6 place-items-center rounded-lg bg-primary-050 text-xs font-bold text-primary">
            {index + 1}
          </span>
          חדר {index + 1}
        </p>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="הסרת חדר"
            className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-status-danger-050 hover:text-status-danger"
          >
            <Icon name="trash" size={16} />
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1.5 block text-sm font-semibold text-text2">תאריך כניסה *</span>
          <input
            type="date"
            className="field"
            value={value.checkIn}
            onChange={(e) => onChange({ ...value, checkIn: e.target.value, roomId: "" })}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-semibold text-text2">תאריך יציאה *</span>
          <input
            type="date"
            className="field"
            value={value.checkOut}
            min={value.checkIn}
            onChange={(e) => onChange({ ...value, checkOut: e.target.value, roomId: value.roomId })}
          />
        </label>
        <div className="block">
          <span className="mb-1.5 block text-sm font-semibold text-text2">
            לילות <span className="font-normal text-faint">(מחושב)</span>
          </span>
          <div className="field flex items-center justify-between">
            <span className="font-bold">{nights || "—"}</span>
            <Icon name="moon" size={16} className="text-faint" />
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-4">
        <Counter
          label="מבוגרים"
          value={value.adults}
          min={1}
          onChange={(adults) => onChange({ ...value, adults })}
        />
        <Counter
          label="ילדים"
          value={value.children}
          min={0}
          onChange={(children) => onChange({ ...value, children })}
        />
        <Counter
          label="תינוקות"
          value={value.infants}
          min={0}
          onChange={(infants) => onChange({ ...value, infants })}
        />
      </div>

      <label className="mt-4 block">
        <span className="mb-1.5 block text-sm font-semibold text-text2">חדר *</span>
        <select
          className="field"
          value={value.roomId}
          onChange={(e) => onChange({ ...value, roomId: e.target.value })}
          disabled={!validRange}
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

      {quote && value.roomId && (
        <div className="mt-3 flex items-center justify-between rounded-xl bg-field px-4 py-3 text-sm">
          <span className="font-semibold text-text2">
            {nights} לילות × ₪{nights ? Math.round(quote.total / nights) : 0}
          </span>
          <span className="font-bold text-primary" dir="ltr">
            ₪{quote.total.toLocaleString()}
          </span>
        </div>
      )}
      {quote?.restriction && (
        <p role="alert" className="mt-2 rounded-xl bg-status-danger-050 px-4 py-2.5 text-sm font-semibold text-[#B4231F]">
          {quote.restriction}
        </p>
      )}
      {overCapacity && selected && (
        <p role="alert" className="mt-2 rounded-xl bg-status-danger-050 px-4 py-2.5 text-sm font-semibold text-[#B4231F]">
          חריגה מקיבולת החדר ({selected.max_occupancy} אורחים, עד {selected.max_adults} מבוגרים
          {selected.max_infants === 0 ? ", ללא תינוקות" : ""})
        </p>
      )}

      <button
        type="button"
        className="mt-3 text-sm font-semibold text-primary hover:underline"
        onClick={() => setShowGuest((v) => !v)}
      >
        {showGuest ? "− הסתר אורח לחדר זה" : "+ אורח שונה בחדר זה (אופציונלי)"}
      </button>
      {showGuest && (
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <input
            className="field"
            placeholder="שם פרטי"
            value={value.guestFirstName ?? ""}
            onChange={(e) => onChange({ ...value, guestFirstName: e.target.value })}
          />
          <input
            className="field"
            placeholder="שם משפחה"
            value={value.guestLastName ?? ""}
            onChange={(e) => onChange({ ...value, guestLastName: e.target.value })}
          />
          <input
            className="field"
            placeholder="טלפון"
            dir="ltr"
            value={value.guestPhone ?? ""}
            onChange={(e) => onChange({ ...value, guestPhone: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}

function Counter({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  onChange: (n: number) => void;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-sm font-semibold text-text2">{label}</span>
      <div className="flex items-center justify-between rounded-[13px] bg-field p-1.5">
        <button
          type="button"
          aria-label={`הוספת ${label}`}
          onClick={() => onChange(Math.min(value + 1, 20))}
          className="grid h-10 w-10 place-items-center rounded-lg bg-surface text-primary shadow-sm hover:bg-primary-050"
        >
          <Icon name="plus" size={16} />
        </button>
        <span className="min-w-8 text-center text-base font-bold text-ink">{value}</span>
        <button
          type="button"
          aria-label={`הפחתת ${label}`}
          onClick={() => onChange(Math.max(value - 1, min))}
          className="grid h-10 w-10 place-items-center rounded-lg bg-surface text-muted shadow-sm hover:bg-hover disabled:opacity-40"
          disabled={value <= min}
        >
          <Icon name="minus" size={16} />
        </button>
      </div>
    </div>
  );
}
