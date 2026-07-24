// ============================================================
// PURE normalization of a Beds24 booking payload (D78/D79). No imports beyond
// types, no DB, no HTTP, so the import
// pipeline and check scripts exercise the exact same parse.
//
// Consumes GET /bookings[?includeGuests=true&includeInvoiceItems=true] items
// VERBATIM and produces the SAME NormalizedRevision shape the D76 import core
// consumes:
//  • bookingId   = String(id) — Beds24 ids arrive as NUMBERS.
//  • revisionId  = a PLACEHOLDER (the booking id). Beds24 has no revisions
//    feed — the caller (beds24-booking-import.ts) overrides it with the
//    synthetic "{id}:{modifiedTime}" id of the persisted revision row before
//    handing the value to importNormalizedRevision.
//  • ONE NormalizedRoom whose `externalRoomId` slot carries the Beds24
//    ROOM ID — in-memory only, threaded to the injected room resolver
//    (channel_beds24_room_mappings); it is NEVER persisted to
//    channel_room_mappings, which stays reserved for the legacy pooled model (D64).
//
// Defensive by doctrine: statuses are verified at runtime — an unknown or
// non-importable status (request/inquiry/black) and an unmapped room return
// { ok:false } (the quarantine shape that parks a revision) and NEVER throw.
// Money: Beds24 speaks MAJOR
// currency units (474.54-style decimals) — NO /100 division. Integer-or-two-
// decimal values are accepted verbatim; anything else is null, never guessed.
// ============================================================

import type { NormalizedRevision, NormalizedRoom } from "./booking-normalize";

export type Beds24RoomMapping = {
  roomId: string;
};

export type Beds24NormalizeResult =
  | { ok: true; value: NormalizedRevision }
  | { ok: false; error: string; unmappedRoomId?: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

// Beds24 ids (booking/room/property) arrive as NUMBERS; every downstream key
// (mapping columns, provider_booking_id) is text — normalize once, here.
const idStr = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return str(v);
};

// Occupancy counters (numAdult/numChild) — a non-negative integer, arriving as
// a number or a numeric string; anything else counts as 0 (informative field).
const count = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

// Beds24 dates arrive as plain dates ("2026-08-01") or ISO datetimes — only
// the calendar date is trusted; anything else is dropped.
const dateOnly = (v: unknown): string | null => {
  const s = str(v);
  const m = s ? DATE_RE.exec(s) : null;
  return m ? m[0] : null;
};

// Beds24 money convention: MAJOR currency units as decimals (474.54) — used
// VERBATIM, never divided. Accepted only when the value is an integer or has
// at most two decimal places (numeric strings parsed the same way); anything
// else is null — a wrong guess on the unit would corrupt prices 100×.
const money = (v: unknown): number | null => {
  const n =
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  // review M-1: a negative price is never a valid reservation amount — null,
  // never a negative total flowing into the ledger
  if (!Number.isFinite(n) || n < 0) return null;
  const cents = n * 100;
  return Math.abs(cents - Math.round(cents)) < 1e-6 ? n : null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

const nightsOf = (checkin: string, checkout: string): number => {
  const ms = Date.parse(`${checkout}T00:00:00Z`) - Date.parse(`${checkin}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86_400_000));
};

// Guest fields ride either FLAT on the booking (firstName/lastName/email/
// phone/mobile) or under guests[] (includeGuests=true) — flat wins, the first
// guests[] entry backfills. Both shapes are probed defensively.
function guestField(
  p: Record<string, unknown>,
  g: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const flat = str(p[key]);
    if (flat) return flat;
  }
  for (const key of keys) {
    const nested = str(g[key]);
    if (nested) return nested;
  }
  return null;
}

// Best-effort identity of a booking whose FULL normalization may fail —
// enough to persist the revision row visibly and to key the synthetic
// revision id.
export function beds24BookingIdentity(payload: unknown): {
  bookingId: string | null;
  roomId: string | null;
  propertyId: string | null;
  rawStatus: string | null;
  otaReservationCode: string | null;
  otaName: string | null;
  /** the natural revision key — Beds24 stamps it on every change */
  modifiedTime: string | null;
} {
  const p = obj(payload) ?? {};
  return {
    bookingId: idStr(p.id),
    roomId: idStr(p.roomId),
    propertyId: idStr(p.propertyId) ?? idStr(p.propId),
    rawStatus: str(p.status),
    otaReservationCode: str(p.apiReference),
    otaName: str(p.channel) ?? str(p.referer),
    modifiedTime: str(p.modifiedTime),
  };
}

// Statuses verified at runtime (D78): only an explicitly live or explicitly
// cancelled booking imports. request/inquiry/black are KNOWN states that must
// not occupy the calendar — visible quarantine carrying the raw status, like
// any unknown value; never guessed, never thrown.
const LIVE_STATUSES = new Set(["confirmed", "new"]);
const CANCELLED_STATUSES = new Set(["cancelled"]);
const NON_IMPORTABLE_STATUSES = new Set(["request", "inquiry", "black"]);

export function normalizeBeds24Booking(
  payload: unknown,
  mappingsByRoomId: ReadonlyMap<string, Beds24RoomMapping>,
): Beds24NormalizeResult {
  const p = obj(payload);
  if (!p) return { ok: false, error: "גוף ההזמנה מ-Beds24 אינו אובייקט תקין" };

  const bookingId = idStr(p.id);
  if (!bookingId) return { ok: false, error: "להזמנה מ-Beds24 חסר מזהה (id)" };

  const roomId = idStr(p.roomId);
  if (!roomId) return { ok: false, error: "להזמנה מ-Beds24 חסר מזהה חדר (roomId)" };

  const propertyId = idStr(p.propertyId) ?? idStr(p.propId);
  if (!propertyId) return { ok: false, error: "להזמנה מ-Beds24 חסר מזהה נכס (propertyId)" };

  const arrival = dateOnly(p.arrival);
  const departure = dateOnly(p.departure);
  if (!arrival || !departure || departure <= arrival)
    return { ok: false, error: "תאריכי ההזמנה מ-Beds24 אינם תקינים" };

  const rawStatus = str(p.status)?.toLowerCase() ?? null;
  // "new" vs "modified" is immaterial to the import core — applyLiveRevision
  // decides create-vs-update by the existing-reservation lock, not the kind.
  let kind: NormalizedRevision["kind"];
  if (rawStatus && LIVE_STATUSES.has(rawStatus)) kind = "new";
  else if (rawStatus && CANCELLED_STATUSES.has(rawStatus)) kind = "cancelled";
  else if (rawStatus && NON_IMPORTABLE_STATUSES.has(rawStatus))
    return { ok: false, error: `סטטוס הזמנה ב-Beds24 אינו בר-ייבוא (${rawStatus})` };
  else return { ok: false, error: `סטטוס הזמנה לא מוכר ב-Beds24 (${rawStatus ?? "חסר"})` };

  // unmapped room → the quarantine shape, with the Beds24 room id surfaced so
  // the caller can log its ownership guard (the Beds24 analogue of a channel
  // wrong-property rejection)
  if (!mappingsByRoomId.has(roomId)) {
    return {
      ok: false,
      error: `חדר Beds24 ללא מיפוי לחדר מקומי (${roomId})`,
      unmappedRoomId: roomId,
    };
  }

  const guests = Array.isArray(p.guests) ? p.guests : [];
  const g = obj(guests[0]) ?? {};

  const adults = count(p.numAdult);
  const children = count(p.numChild);
  const infants = 0; // Beds24 carries no infant axis — never invented

  const currency = str(p.currency); // often absent — the account currency rules
  // price = the booking's room price in MAJOR units. deposit / invoice items
  // are informative extras and are deliberately NOT folded into the total —
  // nothing is guessed on top of the channel's own price.
  const roomAmount = money(p.price);
  const totalAmount = roomAmount;

  const nights = nightsOf(arrival, departure);
  const days: Record<string, number> = {};
  if (roomAmount !== null) {
    // Beds24 supplies no per-night breakdown → distribute price/nights uniformly
    const perNight = round2(roomAmount / nights);
    for (let i = 0; i < nights; i++) {
      const d = new Date(Date.parse(`${arrival}T00:00:00Z`) + i * 86_400_000);
      days[d.toISOString().slice(0, 10)] = perNight;
    }
  }

  const room: NormalizedRoom = {
    // the Beds24 ROOM ID rides the room-type slot IN MEMORY ONLY — consumed by
    // the injected resolver, never written to channel_room_mappings
    externalRoomId: roomId,
    // Beds24 bookings carry no rate-plan axis (D78) — pricing is the designated plan on the mapping
    checkinDate: arrival,
    checkoutDate: departure,
    adults,
    children,
    infants,
    amount: roomAmount,
    days,
    isCancelled: kind === "cancelled",
  };

  return {
    ok: true,
    value: {
      revisionId: bookingId, // placeholder — overridden by the caller
      bookingId,
      propertyId,
      kind,
      uniqueId: null,
      systemId: null,
      otaReservationCode: str(p.apiReference),
      otaName: str(p.channel) ?? str(p.referer), // verbatim ("Booking.com"/"Airbnb"/…)
      currency,
      amount: totalAmount,
      // Beds24's arrivalTime is free-text and not reliably a guest-stated ETA —
      // never promoted to expected_arrival_time (D76 doctrine)
      arrivalHour: null,
      arrivalDate: arrival,
      departureDate: departure,
      insertedAt: str(p.bookingTime),
      otaCommission: money(p.commission),
      customer: {
        firstName: guestField(p, g, ["firstName"]) ?? "אורח",
        lastName: guestField(p, g, ["lastName"]) ?? "",
        email: guestField(p, g, ["email"]),
        phone: guestField(p, g, ["phone", "mobile"]),
        country: guestField(p, g, ["country", "country2"]),
        language: guestField(p, g, ["lang", "language"]),
        address: guestField(p, g, ["address"]),
        city: guestField(p, g, ["city"]),
        zip: guestField(p, g, ["postcode", "postCode"]),
      },
      occupancy: { adults, children, infants },
      notes: str(p.comments) ?? str(p.notes),
      paymentCollect: null, // no reliable hotel-collect signal — never guessed
      paymentType: null,
      rooms: [room],
      cancellation: null, // Beds24 supplies no structured cancellation terms
    },
  };
}
