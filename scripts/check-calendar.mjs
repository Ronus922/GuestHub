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
// commonjs so compiled inter-module imports resolve without extensions under plain node
execSync(
  `pnpm exec tsc src/lib/dates.ts src/lib/inventory-rules.ts src/lib/rooms/sort.ts src/lib/channel/ranges.ts src/lib/channel/payloads.ts src/lib/channel/ari-payloads.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const dates = require(join(out, "dates.js"));
const rules = require(join(out, "inventory-rules.js"));
const ranges = require(join(out, "channel/ranges.js"));
const payloads = require(join(out, "channel/payloads.js"));
const ari = require(join(out, "channel/ari-payloads.js"));

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

// ---- payment state (§F) + canonical balance (D52 §6/§7) ----
assert.equal(rules.paymentState(1000, 0), "unpaid");
assert.equal(rules.paymentState(1000, 500), "partial");
assert.equal(rules.paymentState(1000, 1000), "paid");
assert.equal(rules.paymentState(1000, 1200), "overpaid", "paid over total → overpaid, not silently 'paid'");
assert.equal(rules.paymentState(0, 0), "unpaid", "a zero-total unpaid stay is unpaid");

// balanceOf is NOT floored — a credit is negative, shown as a credit (never a
// zero balance). ONE definition shared by tooltip / panel / payment section.
assert.equal(rules.balanceOf(1000, 400), 600, "positive balance = amount still due");
assert.equal(rules.balanceOf(1000, 1000), 0, "settled");
assert.equal(rules.balanceOf(1000, 1200), -200, "overpayment is a NEGATIVE balance (credit), not floored to 0");
assert.deepEqual(rules.formatBalance(1000, 400), { kind: "due", amount: 600, label: "יתרה לתשלום" });
assert.deepEqual(rules.formatBalance(1000, 1000), { kind: "settled", amount: 0, label: "שולם במלואו" });
assert.deepEqual(rules.formatBalance(1000, 1200), { kind: "credit", amount: 200, label: "זיכוי ללקוח" },
  "an overpayment is a ₪200 customer credit — absolute amount + credit label");

// ---- canonical pricing + restriction rules moved to check-effective-state.mjs ----
// Phase 4A: the room/type resolveRate is retired; the single validator/pricer is
// src/lib/rates/rules.ts (planNightlyPrice + stayRestrictionViolation), asserted
// pure + against the DB by scripts/check-effective-state.mjs.

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
  // D68: availability is keyed by PHYSICAL ROOM (one room ⇄ one Channex Room Type)
  const mapping = new Map([["room-1", "cx-1"]]);
  const rows = [
    { roomId: "room-1", date: "2026-07-01", availability: 1 },
    { roomId: "room-1", date: "2026-07-02", availability: 1 },
    { roomId: "room-1", date: "2026-07-03", availability: 0 },
    { roomId: "room-2", date: "2026-07-01", availability: 1 }, // unmapped
  ];
  const built = ari.buildAvailabilityValues(rows, "prop-1", mapping);
  assert.equal(built.batches.length, 1);
  assert.equal(built.batches[0].values.length, 2, "consecutive equal days compress into one range");
  assert.deepEqual(built.batches[0].values[0], {
    property_id: "prop-1", room_type_id: "cx-1",
    date_from: "2026-07-01", date_to: "2026-07-02", availability: 1,
  });
  assert.deepEqual(built.unmapped, ["room-2"], "unmapped rooms surfaced, not dropped silently");

  // splitting over the provider limit — never truncate
  const many = Array.from({ length: 2500 }, (_, i) => ({
    roomId: "room-1",
    date: dates.addDays("2026-01-01", i),
    availability: i % 2, // alternating → no compression
  }));
  const big = ari.buildAvailabilityValues(many, "p", mapping);
  const totalValues = big.batches.reduce((n, b) => n + b.values.length, 0);
  assert.ok(big.batches.every((b) => ari.payloadByteSize(b) <= ari.PAYLOAD_BYTE_LIMIT), "each batch within 10MB");
  assert.equal(totalValues, 2500, "no values lost when splitting");

  assert.ok(ari.validateAriBatch({ values: [] }), "empty payload rejected");
  assert.equal(ari.validateAriBatch(built.batches[0]), null, "valid payload passes");
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

// ---- outbound ARI cannot originate from a save path (§M/§W, D68) ----
// The old ChannelManagerProvider factory (disabled/dry-run) enforced this by
// construction. It is gone; the guarantee is now structural and asserted here:
// no module a canonical save imports may reach the network, and the outbox
// itself performs no HTTP call. Only the PM2 worker talks to Channex.
{
  const SAVE_PATHS = [
    "src/lib/channel/outbox.ts",
    "src/lib/channel/ranges.ts",
    "src/lib/rates/service.ts",
    "src/app/(dashboard)/rates/actions.ts",
    "src/app/(dashboard)/calendar/actions.ts",
    "src/app/(dashboard)/reservations/actions.ts",
    "src/app/(dashboard)/rate-plans/actions.ts",
  ];
  const HTTP = /\bfetch\(|XMLHttpRequest|axios|http\.request|https\.request/;
  // importing any of these transitively drags in the Channex HTTP client
  const HTTP_MODULES = channel-http|channex-ari|channex-properties|channex-room-types|channex-rate-plans|ari-sync|channel\/worker/;
  for (const f of SAVE_PATHS) {
    const src = readFileSync(f, "utf8");
    assert.ok(!HTTP.test(src), `${f} contains no network code`);
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(!HTTP_MODULES.test(spec), `${f} must not import the Channex HTTP layer (${spec})`);
    }
  }
}

// the pure modules contain no network code at all — structural guarantee
for (const f of ["src/lib/channel/ari-payloads.ts", "src/lib/channel/payloads.ts", "src/lib/channel/ranges.ts"]) {
  const src = readFileSync(f, "utf8");
  assert.ok(!/fetch\(|XMLHttpRequest|axios|http\.request|https\.request/.test(src), `${f} contains no network code`);
  assert.ok(!/^import /m.test(src), `${f} stays import-free (standalone-compilable)`);
}

// ---- canonical room ordering (D86) ----
// The calendar orders rooms by ONE comparator; room_number is a text column, so
// both Postgres and JS would otherwise sort "1006" before "926".
{
  const { compareRoomNumber, sortRoomsByNumber } = require(join(out, "rooms/sort.js"));

  assert.equal(compareRoomNumber("100", "926") < 0, true, "100 before 926");
  assert.equal(compareRoomNumber("926", "1006") < 0, true, "926 before 1006 (never string order)");
  assert.equal(compareRoomNumber("1006", "926") > 0, true, "comparator is antisymmetric");
  assert.equal(compareRoomNumber("100", "100"), 0, "equal numbers tie");

  // the live room set, deliberately fed in the scrambled order the old
  // area-grouped SQL produced (צפוני block, then דרומי block, then no-area)
  const scrambled = ["1102", "1142", "1235", "1237", "1238", "1242", "1245", "1424", "1000", "1006", "1130", "1131", "1329", "926"];
  assert.deepEqual(
    sortRoomsByNumber(scrambled.map((room_number) => ({ room_number }))).map((r) => r.room_number),
    ["926", "1000", "1006", "1102", "1130", "1131", "1142", "1235", "1237", "1238", "1242", "1245", "1329", "1424"],
    "rooms ascend numerically regardless of area/insertion order",
  );

  // legacy non-numeric room numbers sort AFTER every numeric one (their relative
  // order is the locale's natural order — asserted as a set, not an ICU tie-break)
  const mixed = sortRoomsByNumber(
    ["A12", "1006", "פנטהאוז", "926", "12B"].map((room_number) => ({ room_number })),
  ).map((r) => r.room_number);
  assert.deepEqual(mixed.slice(0, 2), ["926", "1006"], "numeric rooms come first, ascending");
  assert.deepEqual(
    [...mixed.slice(2)].sort(),
    ["12B", "A12", "פנטהאוז"].sort(),
    "every non-numeric room number lands after the numeric ones",
  );

  // equal numeric values keep input order (stable) — ids stay attached to rows
  const dupes = [
    { room_number: "101", id: "first" },
    { room_number: "101", id: "second" },
  ];
  assert.deepEqual(sortRoomsByNumber(dupes).map((r) => r.id), ["first", "second"], "stable on ties");
}

// the calendar loader must not re-introduce an area-grouped/text ORDER BY
{
  const src = readFileSync("src/app/(dashboard)/calendar/data.ts", "utf8");
  assert.ok(
    /sortRoomsByNumber\(/.test(src),
    "calendar loader orders rooms through the canonical comparator",
  );
  assert.ok(
    !/ORDER BY a\.sort_order/.test(src),
    "calendar rooms are no longer grouped by area sort_order",
  );
}

console.log("check-calendar: all assertions passed");
