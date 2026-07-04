// Runnable checks for the pure Phase-3 calendar/channel logic (same pattern
// as check-guards.mjs): compiles the pure modules with tsc, imports them and
// asserts the business rules. Usage: node scripts/check-calendar.mjs
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const out = mkdtempSync(join(tmpdir(), "calendar-"));
// commonjs so the compiled inter-module imports (provider → payloads) resolve
// without extensions under plain node
execSync(
  `pnpm exec tsc src/lib/dates.ts src/lib/inventory-rules.ts src/lib/channel/ranges.ts src/lib/channel/payloads.ts src/lib/channel/provider.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const dates = require(join(out, "dates.js"));
const rules = require(join(out, "inventory-rules.js"));
const ranges = require(join(out, "channel/ranges.js"));
const payloads = require(join(out, "channel/payloads.js"));
const provider = require(join(out, "channel/provider.js"));

// ---- hotel-night date semantics (§E) ----
assert.equal(dates.nightsBetween("2026-07-04", "2026-07-05"), 1, "July 4→5 is exactly one night");
assert.equal(dates.nightsBetween("2026-07-01", "2026-07-08"), 7);
assert.equal(dates.addDays("2026-07-31", 1), "2026-08-01", "month rollover");
assert.equal(dates.addDays("2026-01-01", -1), "2025-12-31", "year rollover");
assert.equal(dates.addDays("2026-03-27", 1), "2026-03-28", "IL DST switch does not drift");
assert.deepEqual(dates.eachDay("2026-07-04", "2026-07-06"), ["2026-07-04", "2026-07-05"], "checkout day excluded");

// overlap: half-open [start, end)
assert.equal(dates.rangesOverlap("2026-07-04", "2026-07-06", "2026-07-05", "2026-07-08"), true);
assert.equal(
  dates.rangesOverlap("2026-07-04", "2026-07-06", "2026-07-06", "2026-07-08"),
  false,
  "checkout + same-day check-in must coexist",
);
assert.equal(dates.rangesOverlap("2026-07-06", "2026-07-08", "2026-07-04", "2026-07-06"), false);
assert.equal(dates.rangesOverlap("2026-07-01", "2026-07-31", "2026-07-10", "2026-07-11"), true, "containment");
assert.equal(dates.rangesOverlap("2026-07-04", "2026-07-05", "2026-07-04", "2026-07-05"), true, "one-night self");
assert.equal(dates.isDateOnly("2026-02-30"), false, "impossible date rejected");
assert.equal(dates.isDateOnly("2026-07-04"), true);

// ---- capacity (§L) ----
const CAP = { max_occupancy: 4, max_adults: 2, max_children: 2, max_infants: 0 };
assert.equal(rules.capacityViolation(CAP, { adults: 2, children: 2, infants: 0 }), null);
assert.ok(rules.capacityViolation(CAP, { adults: 3, children: 0, infants: 0 }), "over max_adults");
assert.ok(rules.capacityViolation(CAP, { adults: 2, children: 3, infants: 0 }), "over max_children");
assert.ok(
  rules.capacityViolation(CAP, { adults: 1, children: 0, infants: 1 }),
  "infants not silently accepted when capacity is 0",
);
assert.ok(rules.capacityViolation(CAP, { adults: 0, children: 1, infants: 0 }), "at least one adult");
assert.equal(
  rules.capacityViolation({ ...CAP, max_infants: 1 }, { adults: 1, children: 0, infants: 1 }),
  null,
  "infant allowed when capacity exists",
);

// ---- blocking statuses (§8) ----
assert.deepEqual([...rules.INVENTORY_BLOCKING_STATUSES], ["confirmed", "checked_in", "blocked"]);
assert.ok(!rules.INVENTORY_BLOCKING_STATUSES.includes("cancelled"), "cancelled never consumes inventory");
assert.ok(!rules.CALENDAR_VISIBLE_STATUSES.includes("cancelled"), "cancelled never renders");

// ---- payment state (§F) ----
assert.equal(rules.paymentState(1000, 0), "unpaid");
assert.equal(rules.paymentState(1000, 500), "partial");
assert.equal(rules.paymentState(1000, 1000), "paid");

// ---- rate resolution + restrictions (§K/§9) ----
const RATES = [
  { date: "2026-07-10", room_id: "r1", room_type_id: null, price: 500, min_nights: 3, max_nights: null, closed: false, closed_to_arrival: false, closed_to_departure: false },
  { date: "2026-07-10", room_id: null, room_type_id: "t1", price: 400, min_nights: null, max_nights: null, closed: false, closed_to_arrival: false, closed_to_departure: false },
  { date: "2026-07-11", room_id: null, room_type_id: "t1", price: 420, min_nights: null, max_nights: null, closed: true, closed_to_arrival: false, closed_to_departure: false },
  { date: "2026-07-12", room_id: null, room_type_id: "t1", price: null, min_nights: null, max_nights: null, closed: false, closed_to_arrival: true, closed_to_departure: true },
];
assert.equal(rules.effectiveNightlyPrice(RATES, "2026-07-10", "r1", "t1", 300), 500, "room rate beats type rate");
assert.equal(rules.effectiveNightlyPrice(RATES, "2026-07-10", "r2", "t1", 300), 400, "type rate fallback");
assert.equal(rules.effectiveNightlyPrice(RATES, "2026-07-20", "r2", "t1", 300), 300, "base_price fallback");
assert.ok(
  rules.restrictionViolation(RATES, { checkIn: "2026-07-10", checkOut: "2026-07-11", nights: ["2026-07-10"] }, "r1", "t1"),
  "min_nights enforced on arrival date",
);
assert.equal(
  rules.restrictionViolation(RATES, { checkIn: "2026-07-10", checkOut: "2026-07-13", nights: ["2026-07-10", "2026-07-11", "2026-07-12"] }, "r2", "t1")?.includes("סגור למכירה"),
  true,
  "closed night blocks the sale",
);
assert.ok(
  rules.restrictionViolation(RATES, { checkIn: "2026-07-12", checkOut: "2026-07-13", nights: ["2026-07-12"] }, "r2", "t1"),
  "closed_to_arrival blocks arrival",
);
assert.equal(
  rules.restrictionViolation(RATES, { checkIn: "2026-07-13", checkOut: "2026-07-14", nights: ["2026-07-13"] }, "r2", "t1"),
  null,
  "unrestricted stay passes",
);

// ---- dirty-range coalescing (§S) ----
{
  const existing = [
    { id: "a", date_from: "2026-07-01", date_to: "2026-07-05" },
    { id: "b", date_from: "2026-07-10", date_to: "2026-07-12" },
  ];
  const r1 = ranges.coalesceRange(existing, { date_from: "2026-07-05", date_to: "2026-07-10" });
  assert.deepEqual(r1.merged, { date_from: "2026-07-01", date_to: "2026-07-12" }, "adjacency bridges both ranges");
  assert.equal(r1.absorbedIds.length, 2);
  const r2 = ranges.coalesceRange(existing, { date_from: "2026-07-20", date_to: "2026-07-21" });
  assert.equal(r2.absorbedIds.length, 0, "distant range untouched");
  const r3 = ranges.coalesceRange([existing[0]], { date_from: "2026-07-02", date_to: "2026-07-03" });
  assert.deepEqual(r3.merged, { date_from: "2026-07-01", date_to: "2026-07-05" }, "contained range absorbed — no duplicate work");
}

// ---- retry/backoff (§U) ----
assert.ok(ranges.backoffMs(1, () => 0.5) < ranges.backoffMs(5, () => 0.5), "backoff grows");
assert.ok(ranges.backoffMs(30, () => 1) <= 60 * 60 * 1000, "backoff capped at 1h");
assert.equal(ranges.isPermanentError("validation_error"), true);
assert.equal(ranges.isPermanentError("rate_limited"), false, "rate limits retry");

// ---- payload builders + batching (§U) ----
{
  const mapping = new Map([["t1", "cx-1"]]);
  const rows = [
    { room_type_id: "t1", date: "2026-07-01", availability: 3 },
    { room_type_id: "t1", date: "2026-07-02", availability: 3 },
    { room_type_id: "t1", date: "2026-07-03", availability: 2 },
    { room_type_id: "t2", date: "2026-07-01", availability: 1 }, // unmapped
  ];
  const built = payloads.buildAvailabilityPayloads(rows, "prop-1", mapping);
  assert.equal(built.batches.length, 1);
  assert.equal(built.batches[0].values.length, 2, "consecutive equal days compress into one range");
  assert.deepEqual(built.batches[0].values[0], {
    property_id: "prop-1", room_type_id: "cx-1",
    date_from: "2026-07-01", date_to: "2026-07-02", availability: 3,
  });
  assert.deepEqual(built.unmappedRoomTypeIds, ["t2"], "unmapped types surfaced, not dropped silently");

  // splitting over the provider limit — never truncate
  const many = Array.from({ length: 2500 }, (_, i) => ({
    room_type_id: "t1",
    date: `2026-0${(i % 2) + 1}-01`,
    availability: i, // all distinct → no compression
  }));
  const big = payloads.buildAvailabilityPayloads(many, "p", mapping);
  const totalValues = big.batches.reduce((n, b) => n + b.values.length, 0);
  assert.ok(big.batches.every((b) => b.values.length <= payloads.MAX_VALUES_PER_PAYLOAD), "each batch ≤ limit");
  assert.equal(totalValues, 2500, "no values lost when splitting");

  assert.ok(payloads.validateAriPayload({ values: [] }), "empty payload rejected");
  assert.equal(payloads.validateAriPayload(built.batches[0]), null, "valid payload passes");
}

// ---- redaction (§Z) ----
{
  const red = payloads.redactPayload({
    guest: { name: "א", card_number: "4111111111111111" },
    payment: { cvc: "123", guarantee: { pan: "x" } },
    rooms: [{ price: 100 }],
  });
  assert.equal(red.guest.card_number, "[redacted]");
  assert.equal(red.payment.cvc, "[redacted]");
  assert.equal(red.payment.guarantee, "[redacted]");
  assert.equal(red.rooms[0].price, 100, "non-sensitive data intact");
}

// ---- disabled provider boundary (§M/§W) ----
{
  const p1 = provider.createChannelProvider({ channexEnabled: false, connectionState: "active" });
  assert.equal(p1.kind, "disabled", "flag off ⇒ disabled even with an active connection");
  const p2 = provider.createChannelProvider({ channexEnabled: true, connectionState: "configured" });
  assert.equal(p2.kind, "disabled", "non-active connection ⇒ disabled");
  const p3 = provider.createChannelProvider({ channexEnabled: true, connectionState: null });
  assert.equal(p3.kind, "disabled");
  const push = await p1.pushAvailability([{ values: [{ property_id: "x", date_from: "a", date_to: "b" }] }]);
  assert.equal(push.ok, false);
  assert.equal(push.code, "disabled", "disabled provider refuses every operation");
  // Phase-3 ceiling: even fully enabled+active resolves to dry-run, never HTTP
  const p4 = provider.createChannelProvider({ channexEnabled: true, connectionState: "active" });
  assert.equal(p4.kind, "dry_run", "no code path reaches a network provider in Phase 3");
  const pull = await p4.pullBookingRevisions();
  assert.equal(pull.ok, false, "dry-run refuses inbound pulls");
}

// no HTTP client can even exist in the provider modules — structural guarantee
for (const f of ["src/lib/channel/provider.ts", "src/lib/channel/payloads.ts", "src/lib/channel/ranges.ts"]) {
  const src = readFileSync(f, "utf8");
  assert.ok(!/fetch\(|XMLHttpRequest|axios|http\.request|https\.request/.test(src), `${f} contains no network code`);
}

console.log("check-calendar: all assertions passed");
