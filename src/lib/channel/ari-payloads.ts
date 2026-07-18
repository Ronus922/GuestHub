// ============================================================
// PURE Channex ARI payload builders (D68) — no imports, no DB, no HTTP, no
// clock. Checkable standalone by scripts/check-channex-ari.mjs.
//
// Contract (docs.channex.io, fetched 2026-07-10):
//   POST /api/v1/availability
//     { values: [{ property_id, room_type_id, date_from, date_to, availability }] }
//   POST /api/v1/restrictions
//     { values: [{ property_id, rate_plan_id, date_from, date_to,
//                  rates: [{ occupancy, rate }],          ← per_person plans
//                  min_stay_arrival, min_stay_through, max_stay,
//                  stop_sell, closed_to_arrival, closed_to_departure }] }
//
//   · date_to is INCLUSIVE in Channex ARI ranges (GuestHub is end-exclusive
//     everywhere, so the conversion happens exactly here and nowhere else).
//   · `rate` is sent as a decimal STRING ("200.00"). The API also accepts an
//     integer in minor units; the string form removes the ambiguity entirely.
//   · "The value should be greater than 0" — a zero/absent rate is never sent as
//     a sellable value. A blocked cell carries stop_sell and NO rates.
//   · "At least one restriction should be present on the request" — every value
//     we emit carries stop_sell, so that always holds.
// ============================================================

// §14 size preflight — Channex rejects a request body over 10MB. We enforce a
// real byte ceiling (not just the value-count bound) BEFORE anything leaves the
// process, with a safety margin for the `{"values":[…]}` envelope + headers.
export const PAYLOAD_BYTE_LIMIT = 10 * 1024 * 1024; // 10 MiB
export const PAYLOAD_BYTE_MARGIN = 256 * 1024; // keep 256 KiB clear of the hard cap

// Serialized size of the request body this batch becomes. Uses UTF-8 byte length
// (not string length) so multi-byte content is measured honestly.
export function payloadByteSize(batch: { values: unknown[] }): number {
  const json = JSON.stringify({ values: batch.values });
  // Buffer is always present in the Node/Next server runtime this module targets.
  return Buffer.byteLength(json, "utf8");
}

export type OccupancyRate = { occupancy: number; rate: number };

export type AvailabilityInput = { roomId: string; date: string; availability: number };

export type RestrictionInput = {
  roomId: string;
  planId: string;
  date: string;
  rates: OccupancyRate[] | null;
  minStayArrival: number | null;
  minStayThrough: number | null;
  maxStay: number | null;
  stopSell: boolean;
  closedToArrival: boolean;
  closedToDeparture: boolean;
};

export type AvailabilityValue = {
  property_id: string;
  room_type_id: string;
  date_from: string;
  date_to: string; // inclusive
  availability: number;
};

export type RestrictionValue = {
  property_id: string;
  rate_plan_id: string;
  date_from: string;
  date_to: string; // inclusive
  rates?: { occupancy: number; rate: string }[];
  min_stay_arrival?: number;
  min_stay_through?: number;
  max_stay?: number;
  stop_sell: boolean;
  closed_to_arrival: boolean;
  closed_to_departure: boolean;
};

export type BuildResult<V> = {
  batches: { values: V[] }[];
  /** locals with no active external mapping — surfaced, never dropped silently */
  unmapped: string[];
};

// Date increment without Date-object drift (string math breaks across months).
function nextDay(d: string): string {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

// Collapse consecutive days carrying identical values into one inclusive range.
function compressDays<T extends { date: string }>(
  rows: T[],
  sameValue: (a: T, b: T) => boolean,
): { from: string; to: string; row: T }[] {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const out: { from: string; to: string; row: T }[] = [];
  for (const row of sorted) {
    const last = out[out.length - 1];
    if (last && sameValue(last.row, row) && nextDay(last.to) === row.date) last.to = row.date;
    else out.push({ from: row.date, to: row.date, row });
  }
  return out;
}

// §14 — pack values into as FEW requests as the 10MB provider limit allows, so a
// Full Sync is genuinely two requests (one availability, one rates/restrictions)
// for any realistic property, splitting into more ONLY when a dimension truly
// exceeds 10MB. Bounds by real serialized bytes (the earlier 1000-value count cap
// forced spurious extra requests and broke the two-request certification
// semantics). A single value larger than the budget still gets its own batch
// rather than being dropped — validateAriBatch then rejects it honestly.
const BATCH_BYTE_BUDGET = PAYLOAD_BYTE_LIMIT - PAYLOAD_BYTE_MARGIN;
const ENVELOPE_BYTES = 12; // {"values":[]}

function toBatches<V>(values: V[]): { values: V[] }[] {
  const batches: { values: V[] }[] = [];
  let current: V[] = [];
  let bytes = ENVELOPE_BYTES;
  for (const v of values) {
    // +1 for the comma separator between values.
    const size = Buffer.byteLength(JSON.stringify(v), "utf8") + 1;
    if (current.length > 0 && bytes + size > BATCH_BYTE_BUDGET) {
      batches.push({ values: current });
      current = [];
      bytes = ENVELOPE_BYTES;
    }
    current.push(v);
    bytes += size;
  }
  if (current.length > 0) batches.push({ values: current });
  return batches;
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const arr = m.get(k);
    if (arr) arr.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/** money → the unambiguous Channex decimal string form */
export function toRateString(n: number): string {
  return n.toFixed(2);
}

// ---- availability: one physical room ⇄ one Channex Room Type, value 0 or 1 ----
export function buildAvailabilityValues(
  rows: AvailabilityInput[],
  channexPropertyId: string,
  roomTypeByRoomId: ReadonlyMap<string, string>,
): BuildResult<AvailabilityValue> {
  const unmapped = new Set<string>();
  const values: AvailabilityValue[] = [];
  for (const [roomId, group] of groupBy(rows, (r) => r.roomId)) {
    const channexRoomTypeId = roomTypeByRoomId.get(roomId);
    if (!channexRoomTypeId) {
      unmapped.add(roomId);
      continue;
    }
    for (const range of compressDays(group, (a, b) => a.availability === b.availability)) {
      values.push({
        property_id: channexPropertyId,
        room_type_id: channexRoomTypeId,
        date_from: range.from,
        date_to: range.to,
        availability: range.row.availability,
      });
    }
  }
  return { batches: toBatches(values), unmapped: [...unmapped] };
}

const sameRates = (a: OccupancyRate[] | null, b: OccupancyRate[] | null): boolean => {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.occupancy === b[i].occupancy && x.rate === b[i].rate);
};

// ---- rates + restrictions: (room × local plan) ⇄ one Channex Rate Plan ----
export function buildRestrictionValues(
  rows: RestrictionInput[],
  channexPropertyId: string,
  ratePlanByCombo: ReadonlyMap<string, string>, // `${roomId}|${planId}` → channex rate plan id
): BuildResult<RestrictionValue> {
  const unmapped = new Set<string>();
  const values: RestrictionValue[] = [];
  for (const [combo, group] of groupBy(rows, (r) => `${r.roomId}|${r.planId}`)) {
    const ratePlanId = ratePlanByCombo.get(combo);
    if (!ratePlanId) {
      unmapped.add(combo);
      continue;
    }
    const same = (a: RestrictionInput, b: RestrictionInput) =>
      a.minStayArrival === b.minStayArrival &&
      a.minStayThrough === b.minStayThrough &&
      a.maxStay === b.maxStay &&
      a.stopSell === b.stopSell &&
      a.closedToArrival === b.closedToArrival &&
      a.closedToDeparture === b.closedToDeparture &&
      sameRates(a.rates, b.rates);

    for (const range of compressDays(group, same)) {
      const r = range.row;
      values.push({
        property_id: channexPropertyId,
        rate_plan_id: ratePlanId,
        date_from: range.from,
        date_to: range.to,
        // a blocked cell publishes stop_sell WITHOUT a rate — never a zero price
        ...(r.rates && r.rates.length > 0
          ? { rates: r.rates.map((o) => ({ occupancy: o.occupancy, rate: toRateString(o.rate) })) }
          : {}),
        ...(r.minStayArrival != null ? { min_stay_arrival: r.minStayArrival } : {}),
        ...(r.minStayThrough != null ? { min_stay_through: r.minStayThrough } : {}),
        ...(r.maxStay != null ? { max_stay: r.maxStay } : {}),
        stop_sell: r.stopSell,
        closed_to_arrival: r.closedToArrival,
        closed_to_departure: r.closedToDeparture,
      });
    }
  }
  return { batches: toBatches(values), unmapped: [...unmapped] };
}

// Structural validation applied before any request leaves the process.
export function validateAriBatch(batch: { values: unknown[] }): string | null {
  if (!Array.isArray(batch.values)) return "values must be an array";
  if (batch.values.length === 0) return "empty payload";
  // §14 size preflight — never dispatch a body Channex would reject at 10MB.
  const bytes = payloadByteSize(batch);
  if (bytes > PAYLOAD_BYTE_LIMIT - PAYLOAD_BYTE_MARGIN)
    return `payload exceeds 10MB provider limit (${bytes} bytes)`;
  for (const v of batch.values as Record<string, unknown>[]) {
    if (!v.property_id) return "missing property_id";
    if (!v.date_from || !v.date_to) return "missing date range";
    if (String(v.date_from) > String(v.date_to)) return "date_from after date_to";
    if (!v.room_type_id && !v.rate_plan_id) return "missing room_type_id / rate_plan_id";
    const rates = v.rates;
    if (rates !== undefined) {
      if (!Array.isArray(rates) || rates.length === 0) return "rates must be a non-empty array when present";
      for (const o of rates as Record<string, unknown>[]) {
        if (!Number.isInteger(o.occupancy) || (o.occupancy as number) < 1) return "invalid occupancy";
        if (typeof o.rate !== "string" || !(Number(o.rate) > 0)) return "rate must be a positive decimal string";
      }
    }
  }
  return null;
}
