// ============================================================
// PURE normalization of a Hospitable reservation payload (D77). No imports
// beyond types, no DB, no HTTP — mirrors booking-normalize.ts so the import
// pipeline and check scripts exercise the exact same parse.
//
// Consumes GET /reservations[?include=guest,financials] items VERBATIM and
// produces the SAME NormalizedRevision shape the D76 import core consumes:
//  • bookingId   = the Hospitable reservation uuid.
//  • revisionId  = a PLACEHOLDER (the reservation uuid). Hospitable has no
//    revisions feed — the caller (hospitable-booking-import.ts) overrides it
//    with the synthetic content-hash id of the persisted revision row before
//    handing the value to importNormalizedRevision.
//  • ONE NormalizedRoom whose `channexRoomTypeId` slot carries the Hospitable
//    PROPERTY UUID — in-memory only, threaded to the injected room resolver
//    (channel_hospitable_property_mappings); it is NEVER persisted to
//    channel_room_mappings, which stays Channex-owned (D64).
//
// Defensive by doctrine: statuses/platforms are verified at runtime — an
// unknown status or unmapped property returns { ok:false } (the quarantine
// shape, exactly how a Channex normalize failure parks a revision) and NEVER
// throws. Money: Hospitable v2 speaks integer minor units (cents) — integer
// amounts divide by 100; anything else is null, never guessed.
// ============================================================

import type { NormalizedRevision, NormalizedRoom } from "./booking-normalize";

export type HospitablePropertyMapping = {
  roomId: string;
};

export type HospitableNormalizeResult =
  | { ok: true; value: NormalizedRevision }
  | { ok: false; error: string; unmappedPropertyId?: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;
const count = (v: unknown): number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;

// Hospitable dates arrive as ISO datetimes ("2026-08-01T15:00:00Z") or plain
// dates — only the calendar date is trusted; anything else is dropped.
const dateOnly = (v: unknown): string | null => {
  const s = str(v);
  const m = s ? DATE_RE.exec(s) : null;
  return m ? m[0] : null;
};

// Hospitable v2 money convention: integer amounts in the smallest currency
// unit (cents) — divided by 100 here. An { amount } object is unwrapped the
// same way. Any other shape (string decimals included) is null — a wrong
// guess on the unit would corrupt prices 100×.
const money = (v: unknown): number | null => {
  // Number.isInteger enforces the doctrine above: a decimal (major-unit) value
  // must become null — dividing it by 100 would understate the price 100×.
  if (typeof v === "number" && Number.isInteger(v)) return v / 100;
  const o = obj(v);
  if (o && typeof o.amount === "number" && Number.isInteger(o.amount)) return o.amount / 100;
  return null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

const nightsOf = (checkin: string, checkout: string): number => {
  const ms = Date.parse(`${checkout}T00:00:00Z`) - Date.parse(`${checkin}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86_400_000));
};

// Best-effort identity of a reservation whose FULL normalization may fail —
// enough to persist the revision row visibly (mirror of booking-import.ts
// rawRevisionIdentity) and to key the synthetic revision id.
export function hospitableReservationIdentity(payload: unknown): {
  reservationUuid: string | null;
  propertyId: string | null;
  rawStatus: string | null;
  otaReservationCode: string | null;
  otaName: string | null;
} {
  const p = obj(payload) ?? {};
  return {
    reservationUuid: str(p.id) ?? str(p.uuid),
    propertyId: extractPropertyId(p),
    rawStatus: str(p.status) ?? str(p.reservation_status),
    otaReservationCode: str(p.code) ?? str(p.confirmation_code) ?? str(p.reservation_code),
    otaName: str(p.platform) ?? str(p.channel) ?? str(p.source),
  };
}

// The reservation's Hospitable property uuid — shape verified defensively
// (the API has carried it as property_id, property_uuid, a property object,
// a properties array and a listing reference across resources).
function extractPropertyId(p: Record<string, unknown>): string | null {
  const direct = str(p.property_id) ?? str(p.property_uuid);
  if (direct) return direct;
  const property = obj(p.property);
  const fromObject = property ? (str(property.id) ?? str(property.uuid)) : null;
  if (fromObject) return fromObject;
  if (Array.isArray(p.properties) && p.properties.length > 0) {
    const first = p.properties[0];
    const fromArray = str(first) ?? (obj(first) ? (str(obj(first)!.id) ?? str(obj(first)!.uuid)) : null);
    if (fromArray) return fromArray;
  }
  const listing = obj(p.listing);
  return listing ? str(listing.property_id) : null;
}

// Per-night price breakdown, where the financials supply one. Probed at the
// few shapes seen in the wild ({ date, amount|price } arrays); absence is
// normal and falls back to total/nights.
function nightlyBreakdown(financials: Record<string, unknown> | null): Record<string, number> {
  const candidates: unknown[] = [
    financials?.nights,
    obj(financials?.guest)?.nights,
    financials?.nightly,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || candidate.length === 0) continue;
    const days: Record<string, number> = {};
    for (const item of candidate) {
      const o = obj(item);
      const date = o ? dateOnly(o.date) : null;
      const amount = o ? (money(o.amount) ?? money(o.price)) : null;
      if (date && amount !== null) days[date] = amount;
    }
    if (Object.keys(days).length > 0) return days;
  }
  return {};
}

// Channel commission where the financials report one — informative only
// (audit trail), so a miss is a null, never a guess.
function extractCommission(host: Record<string, unknown> | null): number | null {
  if (!host) return null;
  const direct = money(host.commission) ?? money(host.channel_fee);
  if (direct !== null) return direct;
  if (Array.isArray(host.host_fees) && host.host_fees.length > 0) {
    let sum = 0;
    let found = false;
    for (const fee of host.host_fees) {
      const amount = money(fee) ?? money(obj(fee)?.amount);
      if (amount !== null) {
        sum += amount;
        found = true;
      }
    }
    if (found) return round2(sum);
  }
  return null;
}

// Statuses verified at runtime (D77): only an explicitly live or explicitly
// cancelled reservation imports; anything unknown (inquiry/pending/denied/…)
// returns the quarantine shape — visible, never guessed, never thrown.
const LIVE_STATUSES = new Set(["accepted", "confirmed"]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled"]);

export function normalizeHospitableReservation(
  payload: unknown,
  mappingsByPropertyId: ReadonlyMap<string, HospitablePropertyMapping>,
): HospitableNormalizeResult {
  const p = obj(payload);
  if (!p) return { ok: false, error: "גוף ההזמנה מ-Hospitable אינו אובייקט תקין" };

  const reservationUuid = str(p.id) ?? str(p.uuid);
  if (!reservationUuid) return { ok: false, error: "להזמנה מ-Hospitable חסר מזהה (uuid)" };

  const propertyId = extractPropertyId(p);
  if (!propertyId) return { ok: false, error: "להזמנה מ-Hospitable חסר מזהה נכס" };

  const arrival = dateOnly(p.check_in) ?? dateOnly(p.arrival_date);
  const departure = dateOnly(p.check_out) ?? dateOnly(p.departure_date);
  if (!arrival || !departure || departure <= arrival)
    return { ok: false, error: "תאריכי ההזמנה מ-Hospitable אינם תקינים" };

  const rawStatus = (str(p.status) ?? str(p.reservation_status))?.toLowerCase() ?? null;
  // "new" vs "modified" is immaterial to the import core — applyLiveRevision
  // decides create-vs-update by the existing-reservation lock, not the kind.
  let kind: NormalizedRevision["kind"];
  if (rawStatus && LIVE_STATUSES.has(rawStatus)) kind = "new";
  else if (rawStatus && CANCELLED_STATUSES.has(rawStatus)) kind = "cancelled";
  else return { ok: false, error: `סטטוס הזמנה לא מוכר ב-Hospitable (${rawStatus ?? "חסר"})` };

  // unmapped property → the quarantine shape, with the uuid surfaced so the
  // caller can log its ownership guard (the Hospitable analogue of the Channex
  // wrong-property rejection)
  if (!mappingsByPropertyId.has(propertyId)) {
    return {
      ok: false,
      error: `נכס Hospitable ללא מיפוי לחדר מקומי (${propertyId.slice(0, 8)}…)`,
      unmappedPropertyId: propertyId,
    };
  }

  const guest = obj(p.guest) ?? {};
  const guestLocation = obj(guest.location) ?? {};
  const phone =
    (Array.isArray(guest.phone_numbers) ? str(guest.phone_numbers[0]) : null) ?? str(guest.phone);

  const occ = obj(p.guests) ?? {};
  let adults = count(occ.adult_count) || count(occ.adults) || count(p.adults);
  const children = count(occ.child_count) || count(occ.children) || count(p.children);
  const infants = count(occ.infant_count) || count(occ.infants) || count(p.infants);
  // a total with no split still describes real occupancy — folded into adults
  if (adults + children + infants === 0) adults = count(occ.total);

  const financials = obj(p.financials);
  const guestFinancials = obj(financials?.guest);
  const currency = financials ? str(financials.currency) : null;
  const totalAmount =
    money(guestFinancials?.total_price) ??
    money(guestFinancials?.total) ??
    money(financials?.total_price) ??
    money(financials?.total);
  const roomAmount = money(guestFinancials?.accommodation) ?? totalAmount;

  const nights = nightsOf(arrival, departure);
  let days = nightlyBreakdown(financials);
  if (Object.keys(days).length === 0 && roomAmount !== null) {
    // no per-night breakdown supplied → distribute total/nights uniformly
    const perNight = round2(roomAmount / nights);
    days = {};
    for (let i = 0; i < nights; i++) {
      const d = new Date(Date.parse(`${arrival}T00:00:00Z`) + i * 86_400_000);
      days[d.toISOString().slice(0, 10)] = perNight;
    }
  }

  const room: NormalizedRoom = {
    // the Hospitable PROPERTY uuid rides the room-type slot IN MEMORY ONLY —
    // consumed by the injected resolver, never written to channel_room_mappings
    channexRoomTypeId: propertyId,
    channexRatePlanId: null, // Hospitable has no rate-plan axis (D77)
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
      revisionId: reservationUuid, // placeholder — overridden by the caller
      bookingId: reservationUuid,
      propertyId,
      kind,
      uniqueId: str(p.platform_id),
      systemId: null,
      otaReservationCode:
        str(p.code) ?? str(p.confirmation_code) ?? str(p.reservation_code),
      otaName: str(p.platform) ?? str(p.channel) ?? str(p.source), // verbatim (airbnb/booking/vrbo/direct/manual/…)
      currency,
      amount: totalAmount,
      // check_in carries the PROPERTY's check-in hour, not a guest-stated
      // arrival time — never promoted to expected_arrival_time (D76 doctrine)
      arrivalHour: null,
      arrivalDate: arrival,
      departureDate: departure,
      insertedAt: str(p.booked_at) ?? str(p.created_at),
      otaCommission: extractCommission(obj(financials?.host)),
      customer: {
        firstName: str(guest.first_name) ?? "אורח",
        lastName: str(guest.last_name) ?? "",
        email: str(guest.email),
        phone,
        country: str(guest.country) ?? str(guestLocation.country),
        language: str(guest.language),
        address: null,
        city: str(guestLocation.city),
        zip: null,
      },
      occupancy: { adults, children, infants },
      notes: str(p.guest_note) ?? str(p.notes) ?? str(p.note),
      paymentCollect: null, // OTA-collect by construction — no hotel-collect signal exists
      paymentType: null,
      rooms: [room],
      cancellation: null, // Hospitable supplies no structured cancellation terms
    },
  };
}
