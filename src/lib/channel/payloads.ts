// ============================================================
// PURE Channex payload builders + batching (§U/§V) — no imports, no DB, no
// HTTP. The disabled/dry-run provider validates these shapes locally; nothing
// is sent anywhere in Phase 3. Checkable by scripts/check-calendar.mjs.
// ============================================================

// Provider batch ceiling: one Channex ARI request carries at most this many
// value entries. Builders split — never truncate.
export const MAX_VALUES_PER_PAYLOAD = 1000;

export type AvailabilityInput = {
  room_type_id: string; // local GuestHub room_type id
  date: string; // DateOnly
  availability: number;
};

export type RateInput = {
  room_type_id: string;
  date: string;
  price: number | null;
  min_nights: number | null; // → min_stay_arrival
  min_stay_through: number | null; // distinct per-night min stay (§0.3)
  max_nights: number | null; // → max_stay
  closed: boolean;
  closed_to_arrival: boolean;
  closed_to_departure: boolean;
};

export type AvailabilityValue = {
  property_id: string;
  room_type_id: string; // Channex id
  date_from: string;
  date_to: string; // INCLUSIVE in Channex ARI ranges
  availability: number;
};

export type RateValue = {
  property_id: string;
  rate_plan_id: string; // Channex id
  date_from: string;
  date_to: string;
  rate?: number;
  min_stay_arrival?: number;
  min_stay_through?: number;
  max_stay?: number;
  stop_sell?: boolean;
  closed_to_arrival?: boolean;
  closed_to_departure?: boolean;
};

export type BuildResult<V> = {
  batches: { values: V[] }[]; // each ≤ MAX_VALUES_PER_PAYLOAD
  unmappedRoomTypeIds: string[]; // locals with no active mapping — surfaced, never dropped silently
};

// Compress consecutive per-day rows with identical values into [from, to]
// ranges (Channex date_to is inclusive). rows must be same-key.
function compressDays<T extends { date: string }>(
  rows: T[],
  sameValue: (a: T, b: T) => boolean,
): { from: string; to: string; row: T }[] {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const out: { from: string; to: string; row: T }[] = [];
  for (const row of sorted) {
    const last = out[out.length - 1];
    if (last && sameValue(last.row, row) && nextDay(last.to) === row.date) {
      last.to = row.date;
    } else {
      out.push({ from: row.date, to: row.date, row });
    }
  }
  return out;
}

// Local date increment without Date-object drift (pure string math would be
// wrong across months — use UTC-noon anchor like lib/dates).
function nextDay(d: string): string {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

function toBatches<V>(values: V[]): { values: V[] }[] {
  const batches: { values: V[] }[] = [];
  for (let i = 0; i < values.length; i += MAX_VALUES_PER_PAYLOAD) {
    batches.push({ values: values.slice(i, i + MAX_VALUES_PER_PAYLOAD) });
  }
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

// Room-type availability (derived ONLY from physical guesthub.sellable_unit_inventory
// via effective_sell_state — OTA holds are intentionally excluded, 009:150-151).
export function buildAvailabilityPayloads(
  rows: AvailabilityInput[],
  channexPropertyId: string,
  roomTypeMapping: ReadonlyMap<string, string>, // local room_type_id → channex_room_type_id
): BuildResult<AvailabilityValue> {
  const unmapped = new Set<string>();
  const values: AvailabilityValue[] = [];
  for (const [localId, group] of groupBy(rows, (r) => r.room_type_id)) {
    const channexId = roomTypeMapping.get(localId);
    if (!channexId) {
      unmapped.add(localId);
      continue;
    }
    for (const range of compressDays(group, (a, b) => a.availability === b.availability)) {
      values.push({
        property_id: channexPropertyId,
        room_type_id: channexId,
        date_from: range.from,
        date_to: range.to,
        availability: range.row.availability,
      });
    }
  }
  return { batches: toBatches(values), unmappedRoomTypeIds: [...unmapped] };
}

// Rates + restrictions from guesthub.rates semantics (D37 mapping):
// price→rate, min_nights→min_stay_arrival, min_stay_through→min_stay_through,
// max_nights→max_stay, closed→stop_sell, closed_to_arrival/departure pass
// through. The three stay fields stay distinct per the Channex contract.
export function buildRatePayloads(
  rows: RateInput[],
  channexPropertyId: string,
  ratePlanMapping: ReadonlyMap<string, string>, // local room_type_id → channex_rate_plan_id
): BuildResult<RateValue> {
  const unmapped = new Set<string>();
  const values: RateValue[] = [];
  for (const [localId, group] of groupBy(rows, (r) => r.room_type_id)) {
    const planId = ratePlanMapping.get(localId);
    if (!planId) {
      unmapped.add(localId);
      continue;
    }
    const same = (a: RateInput, b: RateInput) =>
      a.price === b.price &&
      a.min_nights === b.min_nights &&
      a.min_stay_through === b.min_stay_through &&
      a.max_nights === b.max_nights &&
      a.closed === b.closed &&
      a.closed_to_arrival === b.closed_to_arrival &&
      a.closed_to_departure === b.closed_to_departure;
    for (const range of compressDays(group, same)) {
      const r = range.row;
      values.push({
        property_id: channexPropertyId,
        rate_plan_id: planId,
        date_from: range.from,
        date_to: range.to,
        ...(r.price != null ? { rate: r.price } : {}),
        ...(r.min_nights != null ? { min_stay_arrival: r.min_nights } : {}),
        ...(r.min_stay_through != null ? { min_stay_through: r.min_stay_through } : {}),
        ...(r.max_nights != null ? { max_stay: r.max_nights } : {}),
        stop_sell: r.closed,
        closed_to_arrival: r.closed_to_arrival,
        closed_to_departure: r.closed_to_departure,
      });
    }
  }
  return { batches: toBatches(values), unmappedRoomTypeIds: [...unmapped] };
}

// ---- Effective-Sell-State → Channex inputs (§0.6.11) ----
// One row of guesthub.effective_sell_state (per Sellable Unit / day).
export type EssRow = {
  sellable_unit_id: string;
  room_type_id: string | null;
  day: string;
  availability: number;
  price: number | null;
  min_stay_arrival: number | null;
  min_stay_through: number | null;
  max_stay: number | null;
  closed_to_arrival: boolean;
  closed_to_departure: boolean;
  stop_sell: boolean;
};

// The queue payload is ALWAYS recomputed from Effective Sell State, never taken
// from UI input. Per room type: availability = SUM of its Sellable Units'
// availability (pooled count, matching room_type_inventory); the commercial row
// is the lexicographically-first SU's base-plan state, and stop_sell only when
// ALL SUs of the type are closed (any open SU keeps the type sellable). Per-SU
// price divergence within a pooled type is a 4B concern (§16 UI warning).
export function essToChannexInputs(rows: EssRow[]): {
  availability: AvailabilityInput[];
  rates: RateInput[];
} {
  const byTypeDay = groupBy(
    rows.filter((r) => r.room_type_id),
    (r) => `${r.room_type_id} ${r.day}`,
  );
  const availability: AvailabilityInput[] = [];
  const rates: RateInput[] = [];
  for (const group of byTypeDay.values()) {
    const roomTypeId = group[0].room_type_id as string;
    const day = group[0].day;
    availability.push({
      room_type_id: roomTypeId,
      date: day,
      availability: group.reduce((n, r) => n + r.availability, 0),
    });
    const lead = [...group].sort((a, b) => (a.sellable_unit_id < b.sellable_unit_id ? -1 : 1))[0];
    rates.push({
      room_type_id: roomTypeId,
      date: day,
      price: lead.price,
      min_nights: lead.min_stay_arrival,
      min_stay_through: lead.min_stay_through,
      max_nights: lead.max_stay,
      closed: group.every((r) => r.stop_sell),
      closed_to_arrival: lead.closed_to_arrival,
      closed_to_departure: lead.closed_to_departure,
    });
  }
  return { availability, rates };
}

// Structural validation used by the dry-run provider (local only).
export function validateAriPayload(batch: { values: unknown[] }): string | null {
  if (!Array.isArray(batch.values)) return "values must be an array";
  if (batch.values.length === 0) return "empty payload";
  if (batch.values.length > MAX_VALUES_PER_PAYLOAD)
    return `payload exceeds provider limit (${batch.values.length} > ${MAX_VALUES_PER_PAYLOAD})`;
  for (const v of batch.values as Record<string, unknown>[]) {
    if (!v.property_id) return "missing property_id";
    if (!v.date_from || !v.date_to) return "missing date range";
    if (String(v.date_from) > String(v.date_to)) return "date_from after date_to";
  }
  return null;
}

// Redaction (§Z): payment-ish fields are stripped BEFORE any payload is
// persisted or logged. Applied to webhook bodies and booking revisions.
const SENSITIVE_KEY_RE =
  /card|cvv|cvc|pan\b|security_code|guarantee|payment_info|credit/i;

export function redactPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPayload);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : redactPayload(v);
    }
    return out;
  }
  return value;
}
