"use client";

import { useEffect, useState } from "react";
import { DateRangeField } from "@/components/shared/DateRangeField";
import { Icon } from "@/components/shared/Icon";
import { addDays, nightsBetween } from "@/lib/dates";
import {
  roomsFromResult,
  quoteFromResult,
  type RoomsFetchOutcome,
  type QuoteFetchOutcome,
} from "@/lib/reservations/room-picker-result";
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
  // per-room price mode (D106): absent = legacy isManualRate semantics
  priceMode?: "auto" | "manual_night" | "manual_total";
  manualTotal?: number | null;
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

// A ceiling for the nights field that is NOT a pricing rule: it only stops a
// slipped keystroke ("300" typed as "3000") and a held-down + button from
// walking the check-out date into the next century. The real bound is the
// tenant's `max_quote_nights` (D100) and it is the server's to enforce — the
// room and quote fetches already answer with that number by name, so this must
// never be re-tuned to imitate it.
const NIGHTS_TYPO_GUARD = 3650;

/** what both booking surfaces render from one engine quote (D104) */
export type LiveQuote = {
  total: number;
  /** server-resolved nightly price (2dp) — never re-derived by dividing on the client */
  ratePerNight: number;
  /** the "N לילות × ₪R" line really reproduces the total */
  uniformNightly: boolean;
  /** accommodation before the length-of-stay discount (D104) */
  accommodationSubtotal: number;
  restriction: string | null;
};

// `uniformNightly` is the honest test of the multiplication shown to the
// operator: every night priced, all of them equal, AND rate × nights landing on
// the total (a per-stay extra-guest fee is the case that breaks the last one).
export function toLiveQuote(d: {
  total: number;
  nights: number;
  ratePerNight: number;
  accommodationSubtotal: number;
  restriction: string | null;
  nightly: { price: number | null }[];
}): LiveQuote {
  const priced = d.nightly.map((n) => n.price).filter((p): p is number => p != null);
  return {
    total: d.total,
    ratePerNight: d.ratePerNight,
    uniformNightly:
      priced.length === d.nights &&
      priced.every((p) => p === priced[0]) &&
      Math.abs(d.ratePerNight * d.nights - d.total) < 0.005,
    accommodationSubtotal: d.accommodationSubtotal,
    restriction: d.restriction,
  };
}

export function StayEditor({
  index,
  value,
  onChange,
  onRemove,
  excludeReservationId,
  disabled = false,
  showErrors = false,
}: {
  index: number;
  value: StayDraft;
  onChange: (next: StayDraft) => void;
  onRemove?: () => void;
  excludeReservationId?: string;
  disabled?: boolean;
  /** red the empty room / date-range controls (booking-form validation) */
  showErrors?: boolean;
}) {
  const [rooms, setRooms] = useState<RoomOption[]>([]);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [quote, setQuote] = useState<LiveQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [showGuest, setShowGuest] = useState(
    Boolean(value.guestFirstName || value.guestLastName || value.guestPhone),
  );
  // reference edit-modal: a chosen room renders as a summary row with a
  // "החלף חדר" button; the select shows only while actually choosing
  const [changing, setChanging] = useState(false);

  const validRange = value.checkIn && value.checkOut && value.checkOut > value.checkIn;
  const nights = validRange ? nightsBetween(value.checkIn, value.checkOut) : 0;
  const datesInvalid = showErrors && !validRange;
  const roomInvalid = showErrors && !value.roomId;

  // free rooms for the chosen window. A failed refresh must never leave the
  // previous window's rows on screen — their free flags and avg_price belong
  // to other dates — so every outcome goes through roomsFromResult.
  useEffect(() => {
    if (!validRange) {
      setRooms([]);
      setRoomsError(null);
      return;
    }
    let alive = true;
    const apply = (outcome: RoomsFetchOutcome<RoomOption>) => {
      if (!alive) return;
      setRooms(outcome.rooms);
      setRoomsError(outcome.error);
    };
    getAvailableRoomsAction({
      checkIn: value.checkIn,
      checkOut: value.checkOut,
      excludeReservationId,
    }).then(
      (res) => apply(roomsFromResult(res)),
      () => apply(roomsFromResult(null)),
    );
    return () => {
      alive = false;
    };
  }, [value.checkIn, value.checkOut, validRange, excludeReservationId]);

  // live price + restriction quote for the chosen room. This number is read
  // aloud to guests, so it is stricter than the room list: the moment any
  // input changes the old total leaves the screen (no in-flight carry-over),
  // and only a success-with-data response for THESE inputs puts one back —
  // every other outcome renders a reason instead (quoteFromResult).
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (!validRange || !value.roomId) return;
    let alive = true;
    const apply = (
      outcome: QuoteFetchOutcome<{
        total: number;
        nights: number;
        ratePerNight: number;
        accommodationSubtotal: number;
        restriction: string | null;
        nightly: { price: number | null }[];
      }>,
    ) => {
      if (!alive) return;
      setQuote(outcome.quote && toLiveQuote(outcome.quote));
      setQuoteError(outcome.error);
    };
    getStayQuoteAction({
      roomId: value.roomId,
      checkIn: value.checkIn,
      checkOut: value.checkOut,
      adults: value.adults,
      children: value.children,
      infants: value.infants,
      ratePlanId: value.ratePlanId ?? null,
    }).then(
      (res) => apply(quoteFromResult(res)),
      () => apply(quoteFromResult(null)),
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
          invalid={datesInvalid}
          // Moving the dates KEEPS the room: unassigning it silently left the
          // stay invalid, which locked "שמור שינויים" while the panel still read
          // "יש שינויים שלא נשמרו". Availability is re-checked below (and again
          // on the server, under lock) — a real conflict is SAID, never guessed.
          onApply={(checkIn, checkOut) => onChange({ ...value, checkIn, checkOut })}
        />
        {/* Nights is an INPUT, not a readout: typing 5 (or stepping to it) moves
            the CHECK-OUT date to check-in + 5 and leaves check-in alone. The
            hint says so, because a control that silently rewrites a date the
            operator picked would be worse than no control at all.
            No client-side pricing-window cap lives here — that bound is the
            tenant's `max_quote_nights` and belongs to the server (D100); the
            room/quote fetches already answer with the real number. The max
            below is a typo guard, not a pricing rule. */}
        <Counter
          // dp-after keeps this cell on the trigger's row when the date panel
          // opens (.dp-panel is order:2 and takes the full row) — the nights
          // control has to stay put while dates are being picked.
          className="dp-after"
          label="לילות"
          hint={value.checkIn ? "שינוי מזיז את תאריך היציאה" : "בחרו תאריך כניסה תחילה"}
          value={nights}
          min={1}
          max={NIGHTS_TYPO_GUARD}
          editable
          disabled={disabled || !value.checkIn}
          onChange={(n) => onChange({ ...value, checkOut: addDays(value.checkIn, n) })}
        />
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
            className={`field-input${roomInvalid ? " field-error" : ""}`}
            aria-invalid={roomInvalid || undefined}
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

      {roomsError && (
        <p role="alert" className="mt-2 rounded-xl bg-status-danger-050 px-4 py-2.5 text-sm font-semibold text-status-danger">
          {roomsError}
        </p>
      )}

      {quote && value.roomId && (
        <>
          <div className="bw-price-line mt-1.5 border-b-0">
            <span className="bw-plr">
              {nights} לילות × ₪{quote.ratePerNight.toLocaleString()}
              {!quote.uniformNightly && <span className="text-xs text-muted"> (ממוצע)</span>}
            </span>
            <b className="ltr-num text-primary">
              ₪{quote.total.toLocaleString()}
            </b>
          </div>
        </>
      )}
      {quoteError && value.roomId && (
        <p role="alert" className="mt-2 rounded-xl bg-status-danger-050 px-4 py-2.5 text-sm font-semibold text-status-danger">
          {quoteError}
        </p>
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

// +/- stepper (reference .qty: plus right, minus left in RTL). `editable` swaps
// the readout for a typed field — used by nights, where the operator knows the
// length of stay and should not have to click to it.
function Counter({
  label,
  value,
  min,
  max = 20,
  onChange,
  disabled = false,
  editable = false,
  hint,
  className,
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  /** render the value as a typed field, not a readout */
  editable?: boolean;
  hint?: string;
  /** extra classes on the field wrapper (e.g. the date-picker's `dp-after` order) */
  className?: string;
}) {
  // While the field has focus the operator owns the text: committing on every
  // keystroke would clamp "1" out of "12" before the 2 arrives, and would fire a
  // rooms+quote round-trip per character. The draft commits on blur or Enter.
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.min(Math.max(n, min), max);
  const step = (delta: number) => {
    setDraft(null);
    onChange(clamp(value + delta));
  };
  const commit = () => {
    if (draft === null) return;
    const n = Number.parseInt(draft, 10);
    setDraft(null);
    if (Number.isFinite(n) && clamp(n) !== value) onChange(clamp(n));
  };

  return (
    <div className={`field${className ? ` ${className}` : ""}`}>
      <span className="field-label">{label}</span>
      <div className="bw-qty">
        <button
          type="button"
          aria-label={`הפחתת ${label}`}
          onClick={() => step(-1)}
          className="icon-btn bw-qty-b"
          disabled={disabled || value <= min}
        >
          <Icon name="minus" size={20} />
        </button>
        {editable ? (
          <input
            className="bw-qty-v bw-qty-i ltr-num"
            inputMode="numeric"
            aria-label={label}
            disabled={disabled}
            value={draft ?? (value || "")}
            onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                setDraft(null);
              }
            }}
          />
        ) : (
          <span className="bw-qty-v">{value}</span>
        )}
        <button
          type="button"
          aria-label={`הוספת ${label}`}
          onClick={() => step(1)}
          className="icon-btn bw-qty-b"
          disabled={disabled || value >= max}
        >
          <Icon name="plus" size={20} />
        </button>
      </div>
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}
