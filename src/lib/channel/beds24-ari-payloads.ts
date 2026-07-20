// ============================================================
// PURE Beds24 calendar payload builders (D78/D79) — no DB, no HTTP, no clock.
// Only type-only imports (erased at compile time), so this module stays
// checkable standalone, exactly like ari-payloads.ts / hospitable-ari-payloads.ts.
//
// Contract (Beds24 API v2, probed live 2026-07-19):
//   POST /inventory/rooms/calendar
//     [{ "roomId": 707484,
//        "calendar": [{ "from": "2026-07-21", "to": "2026-07-23",
//                       "numAvail": 0|1, "minStay": int, "maxStay": int,
//                       "price1": 474.54 }] }]
//
//   · ONE endpoint carries price + availability + restrictions together —
//     like Hospitable, unlike Channex's two. Every range we emit is therefore
//     a FULL statement about its dates, and the sync layer always projects
//     BOTH halves.
//   · `price1` is in MAJOR currency units WITH decimals (474.54 — NOT minor
//     units; the exact opposite of Hospitable's integer cents). Rounded to 2
//     decimals, never more.
//   · RANGE COMPRESSION: consecutive dates with identical values collapse
//     into one {from,to} entry (to is INCLUSIVE). Beds24 bills per request by
//     credits, so fewer entries = fewer bytes = cheaper; a 500-day horizon of
//     stable prices compresses to a handful of ranges.
//   · Same fail-closed rule as the reviewed Channex/Hospitable builders: a
//     blocked cell — no sellable price exists — is published numAvail:0 with
//     NO price1. Never a zero price, never a guessed price. A MISSING
//     commercial row blocks too.
//   · DOCUMENTED LIMITATION: the verified calendar shape has NO
//     closed-for-checkin/checkout fields. GuestHub's closedToArrival /
//     closedToDeparture therefore CANNOT be expressed on this endpoint and
//     are intentionally not emitted — do NOT invent field names for them.
//     (They still shape minStayArrival upstream in the projection.)
//   · Beds24 has no room-type / rate-plan axes here (migration 045): one
//     GuestHub physical room ⇄ one Beds24 room (propertyId+roomId), priced by
//     the ONE designated local plan's base-occupancy rate.
// ============================================================

import type { AriProjection, CommercialRow } from "./ari-projection";

// Calendar RANGES per POST, summed across the rooms in the request body.
// Beds24 documents no maximum batch size (unverified upstream max) — 100
// keeps each request body small while compression keeps the count low anyway.
export const CALENDAR_ENTRIES_PER_REQUEST = 100;

export type Beds24CalendarMapping = {
  roomId: string;
  /** Beds24 property id (external id; never a credential) */
  beds24PropertyId: string;
  /** Beds24 room id — numeric upstream, stored as text (migration 045) */
  beds24RoomId: string;
  /** the ONE designated local plan whose base-occupancy rate is the price */
  localRatePlanId: string | null;
};

/** One compressed calendar range. `to` is INCLUSIVE (verified upstream). */
export type Beds24CalendarRange = {
  from: string;
  to: string;
  numAvail: 0 | 1;
  /** MAJOR currency units, ≤2 decimals; absent on a blocked (unsellable) range */
  price1?: number;
  minStay?: number;
  maxStay?: number;
};

export type Beds24RoomCalendarEntry = {
  /** numeric Beds24 roomId — the wire type the verified API takes */
  roomId: number;
  calendar: Beds24CalendarRange[];
};

/** One POST body: ≤ CALENDAR_ENTRIES_PER_REQUEST ranges summed over its rooms. */
export type Beds24CalendarRequest = Beds24RoomCalendarEntry[];

export type BuildBeds24CalendarResult = {
  requests: Beds24CalendarRequest[];
  /** roomIds with no designated plan — surfaced, never dropped silently */
  unmapped: string[];
  /** roomIds whose beds24_room_id is not a positive integer — nothing can be
   *  pushed for them (the wire roomId is numeric); surfaced, never guessed */
  invalidRoomIds: string[];
};

// The plan's base-occupancy price for a date: the LOWEST-occupancy entry of the
// projected per-person ladder. The projection builds exactly one entry for
// Beds24, but the extraction stays defensive and identical to the Hospitable
// builder so both siblings read one convention.
function baseOccupancyRate(row: CommercialRow): number | null {
  if (row.rates === null || row.rates.length === 0) return null;
  let min = row.rates[0];
  for (const r of row.rates) if (r.occupancy < min.occupancy) min = r;
  return min.rate;
}

/** money → Beds24 price1: MAJOR units rounded to 2 decimals (NOT cents). */
export function toBeds24Price(rate: number): number {
  return Math.round(rate * 100) / 100;
}

// Pure "YYYY-MM-DD" + 1 day — no imports (this module must stay import-free
// beyond types). UTC arithmetic; date-only strings cannot be DST-shifted.
function nextDay(d: string): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

// One fully-resolved per-date cell, pre-compression.
type Cell = {
  date: string;
  numAvail: 0 | 1;
  price1: number | null;
  minStay: number | null;
  maxStay: number | null;
};

const sameValues = (a: Cell, b: Cell): boolean =>
  a.numAvail === b.numAvail && a.price1 === b.price1 &&
  a.minStay === b.minStay && a.maxStay === b.maxStay;

// ---- compression: consecutive dates with identical values → one range ----
function compressCells(cells: Cell[]): Beds24CalendarRange[] {
  const out: Beds24CalendarRange[] = [];
  let run: { first: Cell; to: string } | null = null;
  const flush = () => {
    if (!run) return;
    const c = run.first;
    out.push({
      from: c.date,
      to: run.to,
      numAvail: c.numAvail,
      ...(c.price1 !== null ? { price1: c.price1 } : {}),
      ...(c.minStay !== null ? { minStay: c.minStay } : {}),
      ...(c.maxStay !== null ? { maxStay: c.maxStay } : {}),
    });
    run = null;
  };
  for (const cell of cells) {
    // extend only when the date is CONSECUTIVE and every value is identical —
    // a gap (drain-scoped dates) must never be papered over by a range.
    if (run && sameValues(run.first, cell) && nextDay(run.to) === cell.date) {
      run.to = cell.date;
      continue;
    }
    flush();
    run = { first: cell, to: cell.date };
  }
  flush();
  return out;
}

// ---- pack (room, ranges) into request bodies of ≤ N ranges each. A room's
// ranges may split across requests — every range is a self-contained
// statement, so the split is safe and keeps the packing simple. ----
function packRequests(
  perRoom: { roomId: number; ranges: Beds24CalendarRange[] }[],
): Beds24CalendarRequest[] {
  const requests: Beds24CalendarRequest[] = [];
  let current: Beds24CalendarRequest = [];
  let count = 0;
  for (const room of perRoom) {
    for (const range of room.ranges) {
      if (count === CALENDAR_ENTRIES_PER_REQUEST) {
        requests.push(current);
        current = [];
        count = 0;
      }
      const last = current[current.length - 1];
      if (last && last.roomId === room.roomId) last.calendar.push(range);
      else current.push({ roomId: room.roomId, calendar: [range] });
      count += 1;
    }
  }
  if (current.length > 0) requests.push(current);
  return requests;
}

// ---- calendar: one physical room ⇄ one Beds24 room, compressed ranges ----
export function buildBeds24CalendarRequests(
  projection: AriProjection,
  mappings: readonly Beds24CalendarMapping[],
): BuildBeds24CalendarResult {
  const availByRoomDay = new Map<string, number>();
  for (const a of projection.availability) {
    availByRoomDay.set(`${a.roomId}|${a.date}`, a.availability);
  }
  const commercialByKey = new Map<string, CommercialRow>();
  for (const c of projection.commercial) {
    commercialByKey.set(`${c.roomId}|${c.planId}|${c.date}`, c);
  }

  const unmapped = new Set<string>();
  const invalidRoomIds = new Set<string>();
  const perRoom: { roomId: number; ranges: Beds24CalendarRange[] }[] = [];

  for (const m of mappings) {
    if (!m.localRatePlanId) {
      unmapped.add(m.roomId);
      continue;
    }
    // the wire roomId is numeric; a non-numeric stored id can never be pushed
    const beds24RoomId = Number(m.beds24RoomId);
    if (!Number.isInteger(beds24RoomId) || beds24RoomId <= 0) {
      invalidRoomIds.add(m.roomId);
      continue;
    }

    // union of the projected dates for this room (either half may carry a date)
    const dateSet = new Set<string>();
    for (const a of projection.availability) if (a.roomId === m.roomId) dateSet.add(a.date);
    for (const c of projection.commercial) {
      if (c.roomId === m.roomId && c.planId === m.localRatePlanId) dateSet.add(c.date);
    }
    const dates = [...dateSet].sort();
    if (dates.length === 0) continue;

    const cells: Cell[] = [];
    for (const date of dates) {
      const c = commercialByKey.get(`${m.roomId}|${m.localRatePlanId}|${date}`);
      const rate = c ? baseOccupancyRate(c) : null;
      const price1 = rate !== null ? toBeds24Price(rate) : null;
      // fail closed: no resolvable positive price ⇒ NOT sellable, NO price1
      // sent. A MISSING commercial row blocks too — a date without a priced
      // statement must never be pushed as available-with-no-price (a plan
      // remap between the sync layer's and the projection's mapping reads
      // would otherwise open every date on the live listing).
      const blocked = price1 === null || price1 <= 0;
      // fail closed: a date the physical projection did not cover is 0, not 1
      const physicallyAvailable = (availByRoomDay.get(`${m.roomId}|${date}`) ?? 0) === 1;
      const available = physicallyAvailable && !(c?.stopSell ?? false) && !blocked;

      cells.push({
        date,
        numAvail: available ? 1 : 0,
        price1: blocked ? null : price1,
        minStay: c && c.minStayArrival != null ? c.minStayArrival : null,
        // maxStay only when the restrictions carry one — omitted otherwise
        maxStay: c && c.maxStay != null ? c.maxStay : null,
      });
    }

    perRoom.push({ roomId: beds24RoomId, ranges: compressCells(cells) });
  }

  return {
    requests: packRequests(perRoom),
    unmapped: [...unmapped],
    invalidRoomIds: [...invalidRoomIds],
  };
}

// Serialized size of one POST body. UTF-8 byte length, not string length,
// exactly like ari-payloads.ts::payloadByteSize.
export function beds24PayloadByteSize(request: Beds24CalendarRequest): number {
  return Buffer.byteLength(JSON.stringify(request), "utf8");
}

/** total ranges in one request body (the unit the per-POST cap counts) */
export function beds24RequestEntryCount(request: Beds24CalendarRequest): number {
  return request.reduce((n, e) => n + e.calendar.length, 0);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Structural validation applied before any request leaves the process
// (mirror of ari-payloads.ts::validateAriBatch).
export function validateBeds24CalendarRequest(request: Beds24CalendarRequest): string | null {
  if (!Array.isArray(request)) return "request must be an array";
  if (request.length === 0) return "empty payload";
  if (beds24RequestEntryCount(request) > CALENDAR_ENTRIES_PER_REQUEST)
    return `request exceeds ${CALENDAR_ENTRIES_PER_REQUEST} calendar ranges`;
  for (const entry of request) {
    if (!Number.isInteger(entry.roomId) || entry.roomId <= 0) return "invalid roomId";
    if (!Array.isArray(entry.calendar) || entry.calendar.length === 0)
      return "empty calendar for a room";
    for (const r of entry.calendar) {
      if (!DATE_RE.test(r.from) || !DATE_RE.test(r.to)) return "invalid date";
      if (r.from > r.to) return "range from after to";
      if (r.numAvail !== 0 && r.numAvail !== 1) return "invalid numAvail";
      if (r.price1 !== undefined) {
        if (!Number.isFinite(r.price1) || r.price1 <= 0)
          return "price1 must be a positive number in major units";
        if (Math.round(r.price1 * 100) / 100 !== r.price1)
          return "price1 must have at most 2 decimals";
      }
      if (r.minStay !== undefined && (!Number.isInteger(r.minStay) || r.minStay < 1))
        return "invalid minStay";
      if (r.maxStay !== undefined && (!Number.isInteger(r.maxStay) || r.maxStay < 1))
        return "invalid maxStay";
    }
  }
  return null;
}
