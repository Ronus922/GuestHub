// ============================================================
// PURE Hospitable calendar payload builders (D77 Phase 4) — no DB, no HTTP, no
// clock. Only type-only imports (erased at compile time), so this module stays
// checkable standalone, exactly like ari-payloads.ts.
//
// Contract (Hospitable Public API v2, verified 2026-07-19):
//   PUT /properties/{uuid}/calendar
//     { dates: [{ date: "YYYY-MM-DD",
//                 price: { amount: <integer minor units> },
//                 available: bool, min_stay: int,
//                 closed_for_checkin: bool, closed_for_checkout: bool }] }
//
//   · ONE endpoint carries price + availability + restrictions together —
//     unlike Channex's two. Every entry we emit is therefore a FULL statement
//     about its date, and the sync layer always projects BOTH halves.
//   · `price.amount` is an INTEGER in minor units: Math.round(rate * 100).
//   · Same fail-closed rule as the Channex builder: a blocked cell — no
//     sellable price exists — is published available:false with NO price.
//     Never a zero price, never a guessed price.
//   · Hospitable has no room-type / rate-plan axes (migration 044): one
//     GuestHub physical room ⇄ one Hospitable property, priced by the ONE
//     designated local plan's base-occupancy rate.
// ============================================================

import type { AriProjection, CommercialRow } from "./ari-projection";

// Dates per PUT. Hospitable documents no maximum batch size (unverified
// upstream max) — 90 keeps each request body small (~a quarter's worth of
// dates) while the 500-day full sync stays at 6 requests per property.
export const CALENDAR_DATES_PER_REQUEST = 90;

export type HospitableCalendarMapping = {
  roomId: string;
  /** Hospitable property UUID (external id; never a credential) */
  hospitablePropertyId: string;
  /** the ONE designated local plan whose base-occupancy rate is the price */
  localRatePlanId: string | null;
};

export type HospitableCalendarDate = {
  date: string;
  /** integer minor units (cents); absent on a blocked (unsellable) date */
  price?: { amount: number };
  available: boolean;
  min_stay?: number;
  closed_for_checkin: boolean;
  closed_for_checkout: boolean;
};

export type HospitablePropertyBatch = {
  roomId: string;
  hospitablePropertyId: string;
  /** ≤ CALENDAR_DATES_PER_REQUEST dates per chunk — one PUT each */
  chunks: { dates: HospitableCalendarDate[] }[];
};

export type BuildHospitableCalendarResult = {
  properties: HospitablePropertyBatch[];
  /** roomIds with no designated plan — surfaced, never dropped silently */
  unmapped: string[];
};

// The plan's base-occupancy price for a date: the LOWEST-occupancy entry of the
// projected per-person ladder. The projection builds rates in ascending
// occupancy with the extra-guest surcharge at the base occupancy being 0, so
// the minimum entry IS the resolved nightly price without surcharges.
function baseOccupancyRate(row: CommercialRow): number | null {
  if (row.rates === null || row.rates.length === 0) return null;
  let min = row.rates[0];
  for (const r of row.rates) if (r.occupancy < min.occupancy) min = r;
  return min.rate;
}

/** money → Hospitable integer minor units */
export function toMinorUnits(rate: number): number {
  return Math.round(rate * 100);
}

function toChunks(dates: HospitableCalendarDate[]): { dates: HospitableCalendarDate[] }[] {
  const chunks: { dates: HospitableCalendarDate[] }[] = [];
  for (let i = 0; i < dates.length; i += CALENDAR_DATES_PER_REQUEST) {
    chunks.push({ dates: dates.slice(i, i + CALENDAR_DATES_PER_REQUEST) });
  }
  return chunks;
}

// ---- calendar: one physical room ⇄ one Hospitable property, full entries ----
export function buildHospitableCalendarBatches(
  projection: AriProjection,
  mappings: readonly HospitableCalendarMapping[],
): BuildHospitableCalendarResult {
  const availByRoomDay = new Map<string, number>();
  for (const a of projection.availability) {
    availByRoomDay.set(`${a.roomId}|${a.date}`, a.availability);
  }
  const commercialByKey = new Map<string, CommercialRow>();
  for (const c of projection.commercial) {
    commercialByKey.set(`${c.roomId}|${c.planId}|${c.date}`, c);
  }

  const unmapped = new Set<string>();
  const properties: HospitablePropertyBatch[] = [];

  for (const m of mappings) {
    if (!m.localRatePlanId) {
      unmapped.add(m.roomId);
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

    const entries: HospitableCalendarDate[] = [];
    for (const date of dates) {
      const c = commercialByKey.get(`${m.roomId}|${m.localRatePlanId}|${date}`);
      const rate = c ? baseOccupancyRate(c) : null;
      const amount = rate !== null ? toMinorUnits(rate) : null;
      // fail closed: no resolvable positive price ⇒ NOT sellable, NO price
      // sent. A MISSING commercial row blocks too — a date without a priced
      // statement must never be pushed as available-with-no-price (a plan
      // remap between the sync layer's and the projection's mapping reads
      // would otherwise open every date on the live listing).
      const blocked = amount === null || amount < 1;
      // fail closed: a date the physical projection did not cover is 0, not 1
      const physicallyAvailable = (availByRoomDay.get(`${m.roomId}|${date}`) ?? 0) === 1;

      entries.push({
        date,
        ...(amount !== null && amount >= 1 ? { price: { amount } } : {}),
        available: physicallyAvailable && !(c?.stopSell ?? false) && !blocked,
        ...(c && c.minStayArrival != null ? { min_stay: c.minStayArrival } : {}),
        closed_for_checkin: c?.closedToArrival ?? false,
        closed_for_checkout: c?.closedToDeparture ?? false,
      });
    }

    properties.push({
      roomId: m.roomId,
      hospitablePropertyId: m.hospitablePropertyId,
      chunks: toChunks(entries),
    });
  }

  return { properties, unmapped: [...unmapped] };
}

// Serialized size of the request body one chunk becomes. UTF-8 byte length, not
// string length, exactly like ari-payloads.ts::payloadByteSize.
export function calendarPayloadByteSize(chunk: { dates: HospitableCalendarDate[] }): number {
  const json = JSON.stringify({ dates: chunk.dates });
  return Buffer.byteLength(json, "utf8");
}

// Structural validation applied before any request leaves the process
// (mirror of ari-payloads.ts::validateAriBatch).
export function validateHospitableCalendarBatch(chunk: { dates: HospitableCalendarDate[] }): string | null {
  if (!Array.isArray(chunk.dates)) return "dates must be an array";
  if (chunk.dates.length === 0) return "empty payload";
  if (chunk.dates.length > CALENDAR_DATES_PER_REQUEST)
    return `chunk exceeds ${CALENDAR_DATES_PER_REQUEST} dates`;
  for (const d of chunk.dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return "invalid date";
    if (d.price !== undefined && (!Number.isInteger(d.price.amount) || d.price.amount < 1))
      return "price.amount must be a positive integer in minor units";
    if (d.min_stay !== undefined && (!Number.isInteger(d.min_stay) || d.min_stay < 1))
      return "invalid min_stay";
    if (typeof d.available !== "boolean") return "missing available flag";
  }
  return null;
}
