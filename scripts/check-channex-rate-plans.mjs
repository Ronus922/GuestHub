// Runnable checks for the (local Rate Plan × mapped physical room) → Channex
// Rate Plan synchronization (D65), same harness as check-channex-room-types.mjs:
// compile the PURE modules with tsc, import them, assert. NO DB, NO live socket,
// NO Channex entity is ever created — every network call is an injected fake.
//
// Covers: the dynamic Cartesian model (plans × mapped rooms — never hardcoded),
// eligibility (inactive/archived/channel-hidden plans, inactive/unmapped rooms),
// the exact title format + 255 boundary + duplicate-name blocking, the
// per_person occupancy options (primary = included_occupancy per the pricing
// engine, capped, one per adult count), the SAFE create payload (rate_mode
// manual, zero placeholder rates, stop_sell on all 7 weekdays, NO fabricated
// children/infant fees), the API client (pagination/truncation + every error
// status + timeout/network/malformed + no key leak), ambiguity classification,
// durable job keys, source-level scope + durability guards, and the D67 title
// rename (mismatch derivation, GET-before-PUT full-echo update, UUID pinning,
// failed items kept mapped and retryable).
//
// Usage: node scripts/check-channex-rate-plans.mjs
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const out = mkdtempSync(join(tmpdir(), "channex-rp-"));
execSync(
  `pnpm exec tsc src/lib/channel/channex-rate-plans.ts src/lib/channel/rate-plan-sync.ts src/lib/channel/channex-http.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const api = require(join(out, "channex-rate-plans.js"));
const sync = require(join(out, "rate-plan-sync.js"));
const http = require(join(out, "channex-http.js"));

const STAGING = "https://staging.channex.io/api/v1";
const PROP = "10338c65-5b0e-402b-bdaa-f3efe10e9896";
const mkRes = (status, body) => ({ status, json: async () => body });

let n = 0;
const ok = (name) => {
  console.log(`  ✓ ${name}`);
  n++;
};

// The 13 ACTIVE mapped production rooms: included_occupancy from guesthub.rooms,
// occ_adults from the D64 mapping snapshots. Verification fixture only — the
// application always reads the live tables.
const PROD_ROOMS = [
  { num: "926", inc: 4, occAd: 2 },
  { num: "1006", inc: 2, occAd: 4 },
  { num: "1102", inc: 4, occAd: 3 },
  { num: "1130", inc: 2, occAd: 2 },
  { num: "1131", inc: 2, occAd: 2 },
  { num: "1142", inc: 2, occAd: 4 },
  { num: "1235", inc: 2, occAd: 2 },
  { num: "1237", inc: 4, occAd: 4 },
  { num: "1238", inc: 2, occAd: 2 },
  { num: "1242", inc: 2, occAd: 4 },
  { num: "1245", inc: 2, occAd: 2 },
  { num: "1329", inc: 2, occAd: 6 },
  { num: "1424", inc: 2, occAd: 2 },
];
// The 5 operator-defined local plans. Fixture only — the app reads pricing_plans.
const PLAN_NAMES = ["ללא דמי ביטול", "שבועי", "חודשי", "גמיש", "ללא החזר"];

const mkRoom = (r, over = {}) => ({
  roomId: `room-${r.num}`,
  roomNumber: r.num,
  isActive: true,
  includedOccupancy: r.inc,
  mappingStatus: "mapped",
  channexRoomTypeId: `rt-${r.num}`,
  roomTypeOccAdults: r.occAd,
  ...over,
});
const mkPlan = (name, i, over = {}) => ({
  id: `plan-${i}`,
  name,
  is_active: true,
  is_archived: false,
  is_visible_channels: true,
  ...over,
});

// ============================================================
// MODEL — dynamic Cartesian product, never hardcoded
// ============================================================
const rooms13 = PROD_ROOMS.map((r) => mkRoom(r));
const plans5 = PLAN_NAMES.map((p, i) => mkPlan(p, i));

let plan = sync.buildComboPlan({ plans: plans5, rooms: rooms13, rateMappings: [] });
assert.equal(plan.summary.activePlans, 5);
assert.equal(plan.summary.mappedRooms, 13);
assert.equal(plan.summary.requiredCombinations, 65, "5 plans × 13 mapped rooms = 65 combinations");
assert.equal(plan.summary.creatable, 65, "all 65 valid and creatable before any sync");
assert.equal(plan.summary.mappedCombinations, 0);

let one = sync.buildComboPlan({ plans: [plans5[0]], rooms: rooms13, rateMappings: [] });
assert.equal(one.summary.requiredCombinations, 13, "1 plan × 13 rooms = 13 — the count is computed");
let two = sync.buildComboPlan({ plans: plans5.slice(0, 2), rooms: rooms13.slice(0, 3), rateMappings: [] });
assert.equal(two.summary.requiredCombinations, 6, "2 plans × 3 rooms = 6 — nothing is hardcoded");
ok("dynamic model: plans × mapped rooms, computed for 5×13=65, 1×13=13, 2×3=6");

// every combination references the physical room + the LOCAL plan id (no
// duplication of local plans, no descriptive category anywhere)
const room926 = plan.rows.filter((r) => r.roomNumber === "926");
assert.equal(room926.length, 5, "room 926 gets one combination per local plan");
assert.deepEqual(
  room926.map((r) => r.proposedTitle),
  ["חדר 926 - ללא דמי ביטול", "חדר 926 - שבועי", "חדר 926 - חודשי", "חדר 926 - גמיש", "חדר 926 - ללא החזר"],
);
assert.equal(new Set(plan.rows.map((r) => r.localRatePlanId)).size, 5, "still exactly 5 local plan ids — never duplicated");
assert.equal(new Set(plan.rows.map((r) => r.proposedTitle)).size, 65, "all 65 titles unique per property");
ok("one external plan per (room × local plan); local plans never duplicated; titles unique");

// rooms sort numerically inside each plan
assert.deepEqual(
  plan.rows.slice(0, 13).map((r) => r.roomNumber),
  ["926", "1006", "1102", "1130", "1131", "1142", "1235", "1237", "1238", "1242", "1245", "1329", "1424"],
);
ok("rooms ordered numerically");

// ============================================================
// ELIGIBILITY — inactive/archived/hidden plans, inactive/unmapped rooms
// ============================================================
const inactivePlan = mkPlan("מושבת", 90, { is_active: false });
const archivedPlan = mkPlan("ארכיון", 91, { is_archived: true });
const hiddenPlan = mkPlan("פנימי", 92, { is_visible_channels: false });
plan = sync.buildComboPlan({
  plans: [...plans5, inactivePlan, archivedPlan, hiddenPlan],
  rooms: rooms13,
  rateMappings: [],
});
assert.equal(plan.summary.activePlans, 5, "inactive / archived / channel-hidden plans are excluded");
assert.equal(plan.summary.requiredCombinations, 65);

const inactiveRoom = mkRoom({ num: "999", inc: 2, occAd: 2 }, { isActive: false });
const unmappedRoom = mkRoom({ num: "998", inc: 2, occAd: null }, { mappingStatus: null, channexRoomTypeId: null });
const reconcilingRoom = mkRoom({ num: "997", inc: 2, occAd: 2 }, { mappingStatus: "reconciliation_required" });
plan = sync.buildComboPlan({
  plans: plans5,
  rooms: [...rooms13, inactiveRoom, unmappedRoom, reconcilingRoom],
  rateMappings: [],
});
assert.equal(plan.summary.mappedRooms, 13, "inactive / unmapped / unreconciled rooms never join the product");
assert.equal(plan.summary.requiredCombinations, 65);
ok("eligibility: only active channel-visible plans × active fully-mapped rooms");

// ============================================================
// TITLES — exact format, 255 boundary, duplicate names blocked
// ============================================================
assert.deepEqual(sync.buildRatePlanTitle("1006", "ללא דמי ביטול"), { ok: true, title: "חדר 1006 - ללא דמי ביטול" });
assert.deepEqual(sync.buildRatePlanTitle(" 926 ", " שבועי "), { ok: true, title: "חדר 926 - שבועי" }, "trimmed");
assert.equal(sync.buildRatePlanTitle("", "x").ok, false);
assert.equal(sync.buildRatePlanTitle("926", " ").ok, false);
// "חדר " (4) + "926" (3) + " - " (3) = 10 fixed chars → a 245-char name hits 255
assert.equal(sync.buildRatePlanTitle("926", "א".repeat(245)).ok, true, "255 symbols exactly is allowed");
assert.equal(sync.buildRatePlanTitle("926", "א".repeat(246)).ok, false, "256 symbols is rejected");
for (const bad of ["GuestHub", "Staging", PROP]) {
  const t = sync.buildRatePlanTitle("926", "ללא דמי ביטול");
  assert.ok(!t.title.includes(bad), `title never contains ${bad}`);
}
// two local plans with the same name would collide on every Channex title
plan = sync.buildComboPlan({
  plans: [mkPlan("כפול", 1), mkPlan("כפול", 2)],
  rooms: rooms13.slice(0, 2),
  rateMappings: [],
});
assert.equal(plan.summary.creatable, 0, "duplicate plan names block creation");
assert.equal(plan.summary.validationErrors, 4);
assert.ok(plan.rows[0].validationError.includes("ייחודי"));
ok("titles: exact 'חדר <num> - <plan>' format, 255 boundary, duplicate names blocked");

// ============================================================
// OCCUPANCY OPTIONS — per_person, primary = included_occupancy (engine §11)
// ============================================================
assert.equal(sync.SELL_MODE, "per_person", "GuestHub prices vary by adult count (base + extra beyond included)");
assert.equal(sync.RATE_MODE, "manual");

// room 1006: occ_adults 4, included 2 → options 1..4, primary 2
let occ = sync.buildOccupancyOptions(4, 2);
assert.deepEqual(
  occ.options,
  [
    { occupancy: 1, is_primary: false, rate: 0 },
    { occupancy: 2, is_primary: true, rate: 0 },
    { occupancy: 3, is_primary: false, rate: 0 },
    { occupancy: 4, is_primary: false, rate: 0 },
  ],
  "one option per possible adult count, primary at included_occupancy, zero placeholder rates",
);
assert.equal(occ.primaryCapped, false);
// room 926: included 4 but the Room Type allows 2 adults → primary capped to 2
occ = sync.buildOccupancyOptions(2, 4);
assert.deepEqual(occ.options.map((o) => [o.occupancy, o.is_primary]), [[1, false], [2, true]]);
assert.equal(occ.primaryCapped, true, "primary above occ_adults is capped, never invalid");
// room 1102 (corrected): occ_adults 3, included 4 → 1..3, primary 3 capped
occ = sync.buildOccupancyOptions(3, 4);
assert.deepEqual(occ.options.map((o) => [o.occupancy, o.is_primary]), [[1, false], [2, false], [3, true]]);
// room 1329: 6 adults
occ = sync.buildOccupancyOptions(6, 2);
assert.equal(occ.options.length, 6);
assert.equal(occ.options.filter((o) => o.is_primary).length, 1, "exactly one primary");
assert.equal(new Set(occ.options.map((o) => o.occupancy)).size, 6, "no duplicate occupancy");
assert.ok(occ.options.every((o) => o.occupancy >= 1 && o.occupancy <= 6), "no zero, none above capacity");

// fail closed exactly like the pricing engine
assert.equal(sync.buildOccupancyOptions(4, null).ok, false, "no included_occupancy → blocked (never guessed)");
assert.ok(sync.buildOccupancyOptions(4, null).message.includes("הכלולים"));
assert.equal(sync.buildOccupancyOptions(4, 0).ok, false);
assert.equal(sync.buildOccupancyOptions(4, 2.5).ok, false);
assert.equal(sync.buildOccupancyOptions(0, 2).ok, false);
assert.equal(sync.buildOccupancyOptions(null, 2).ok, false);

// every production room derives valid options
for (const r of PROD_ROOMS) {
  const o = sync.buildOccupancyOptions(r.occAd, r.inc);
  assert.equal(o.ok, true, `room ${r.num} derives options`);
  assert.equal(o.options.length, r.occAd);
  assert.equal(o.options.filter((x) => x.is_primary).length, 1);
  assert.equal(o.primary, Math.min(r.inc, r.occAd));
}
ok("occupancy options: 1..occ_adults, exactly one primary at included_occupancy, fail-closed like the engine");

// a room with no included_occupancy is blocked in the combo plan too
plan = sync.buildComboPlan({
  plans: [plans5[0]],
  rooms: [mkRoom({ num: "926", inc: null, occAd: 2 })],
  rateMappings: [],
});
assert.equal(plan.rows[0].status, "validation_required");
assert.equal(plan.summary.creatable, 0);
ok("combo plan blocks a room whose included occupancy is undefined");

// ============================================================
// CREATE PAYLOAD — structure + safety only, nothing sellable
// ============================================================
const payload = sync.buildCreateRatePlanPayload({
  propertyId: PROP,
  roomTypeId: "rt-926",
  title: "חדר 926 - ללא דמי ביטול",
  currency: "ILS",
  options: sync.buildOccupancyOptions(2, 4).options,
});
assert.deepEqual(
  Object.keys(payload.rate_plan).sort(),
  ["currency", "options", "property_id", "rate_mode", "room_type_id", "sell_mode", "stop_sell", "title"].sort(),
  "exactly the structural attributes — nothing else",
);
assert.equal(payload.rate_plan.sell_mode, "per_person");
assert.equal(payload.rate_plan.rate_mode, "manual");
assert.equal(payload.rate_plan.currency, "ILS");
assert.deepEqual(payload.rate_plan.stop_sell, [true, true, true, true, true, true, true], "born stop-sold on all 7 weekdays");
assert.ok(payload.rate_plan.options.every((o) => o.rate === 0), "zero placeholder rates — no real GuestHub price is sent");
for (const fabricated of ["children_fee", "infant_fee", "parent_rate_plan_id", "meal_type", "inherit_rate", "max_stay", "min_stay_arrival", "min_stay_through", "closed_to_arrival", "closed_to_departure", "auto_rate_settings"])
  assert.ok(!(fabricated in payload.rate_plan), `${fabricated} is never sent (Channex defaults apply; fees never fabricated)`);
// purity: the options array is copied, not aliased
const opts = sync.buildOccupancyOptions(2, 2).options;
const p2 = sync.buildCreateRatePlanPayload({ propertyId: PROP, roomTypeId: "x", title: "t", currency: "ILS", options: opts });
p2.rate_plan.options[0].rate = 999;
assert.equal(opts[0].rate, 0, "payload mutation never leaks back into the caller's options");
ok("payload: manual + per_person + ILS + stop_sell×7 + rate 0; no fees, no restrictions, no inheritance");

// ============================================================
// MAPPING STATES — skip mapped, resume failed, respect reconciliation
// ============================================================
const mapped8 = rooms13.slice(0, 8).map((r) => ({
  room_id: r.roomId,
  local_rate_plan_id: "plan-0",
  channex_rate_plan_id: `ext-${r.roomNumber}`,
  status: "mapped",
}));
plan = sync.buildComboPlan({ plans: [plans5[0]], rooms: rooms13, rateMappings: mapped8 });
assert.equal(plan.summary.mappedCombinations, 8);
assert.equal(plan.summary.creatable, 5, "resume creates ONLY the 5 missing combinations");
assert.ok(plan.rows.filter((r) => r.status === "mapped").every((r) => !r.creatable), "a mapped combination is never re-created");

plan = sync.buildComboPlan({
  plans: [plans5[0]],
  rooms: rooms13.slice(0, 2),
  rateMappings: [
    { room_id: "room-926", local_rate_plan_id: "plan-0", channex_rate_plan_id: null, status: "failed" },
    { room_id: "room-1006", local_rate_plan_id: "plan-0", channex_rate_plan_id: null, status: "reconciliation_required" },
  ],
});
assert.equal(plan.rows.find((r) => r.roomNumber === "926").creatable, true, "a definite failure is retryable");
assert.equal(plan.rows.find((r) => r.roomNumber === "1006").creatable, false, "an ambiguous result is NOT blindly retryable");
assert.equal(plan.summary.reconciliationRequired, 1);
ok("states: mapped skipped, failed resumable, reconciliation_required never blindly re-POSTed");

// ============================================================
// JOB IDENTITY — tenant/provider/env via connection; property+plan+room explicit
// ============================================================
assert.equal(sync.ratePlanJobKey(PROP, "plan-0", "room-926"), `channex:rate_plan:create:${PROP}:plan-0:room-926`);
assert.notEqual(sync.ratePlanJobKey(PROP, "plan-0", "room-926"), sync.ratePlanJobKey(PROP, "plan-1", "room-926"), "same room, different plan → different durable identity");
assert.notEqual(sync.ratePlanJobKey(PROP, "plan-0", "room-926"), sync.ratePlanJobKey(PROP, "plan-0", "room-1006"));
assert.equal(sync.ratePlanSyncJobKey(PROP), `channex:rate_plan:sync:${PROP}`);
assert.equal(sync.ratePlanTitleSyncJobKey(PROP), `channex:rate_plan:title_sync:${PROP}`);
assert.notEqual(sync.ratePlanTitleSyncJobKey(PROP), sync.ratePlanSyncJobKey(PROP), "title runs never collide with create runs");
ok("durable job keys: property + local plan + room + operation");

// ============================================================
// TITLE RENAME (D67) — mismatch derivation + full-echo update payload
// ============================================================
// 4 plans × 13 mapped rooms, all created under each plan's ORIGINAL name; then
// ONE local plan is renamed. Everything below is derived — no old/new name, no
// count, no plan id, no external UUID is special-cased anywhere.
{
  const plans4 = ["ללא דמי ביטול", "ביטול גמיש", "תעריף שבועי", "תעריף חודשי"].map((p, i) => mkPlan(p, i));
  const mkMappings = (plans) => {
    const out = [];
    for (const p of plans)
      for (const r of rooms13)
        out.push({
          room_id: r.roomId,
          local_rate_plan_id: p.id,
          channex_rate_plan_id: `ext-${p.id}-${r.roomNumber}`,
          status: "mapped",
          channex_title: `חדר ${r.roomNumber} - ${p.name}`,
        });
    return out;
  };
  const mappings = mkMappings(plans4); // titles match the ORIGINAL names

  // no rename → nothing to do (repeated execution performs no update work)
  let combo = sync.buildComboPlan({ plans: plans4, rooms: rooms13, rateMappings: mappings });
  assert.equal(sync.titleMismatches(combo, mappings).length, 0, "all titles match → zero work");

  // rename ONE plan locally (the id is preserved, only the name changes)
  const renamed = plans4.map((p) => (p.id === "plan-0" ? { ...p, name: "ללא החזר" } : p));
  combo = sync.buildComboPlan({ plans: renamed, rooms: rooms13, rateMappings: mappings });
  const mm = sync.titleMismatches(combo, mappings);
  assert.equal(mm.length, rooms13.length, "exactly one mismatch per mapped room of the renamed plan — computed, never hardcoded");
  assert.ok(mm.every((m) => m.localRatePlanId === "plan-0"), "ONLY the renamed plan's mappings are selected");
  assert.equal(
    combo.rows.filter((r) => r.status === "mapped").length - mm.length,
    (plans4.length - 1) * rooms13.length,
    "the other plans' combinations are untouched",
  );
  assert.deepEqual(
    new Set(mm.map((m) => m.channexRatePlanId)),
    new Set(rooms13.map((r) => `ext-plan-0-${r.roomNumber}`)),
    "exactly the EXISTING external ids are targeted — no new UUID, none dropped",
  );
  assert.ok(
    mm.every((m) => m.expectedTitle === `חדר ${m.roomNumber} - ללא החזר`),
    "expected title derives from the CURRENT canonical local name",
  );
  assert.ok(mm.every((m) => m.currentTitle === `חדר ${m.roomNumber} - ללא דמי ביטול`), "old title reported for the audit trail");

  // any other future rename works identically — the mechanism is generic
  const renamed2 = plans4.map((p) => (p.id === "plan-2" ? { ...p, name: "תעריף שבועי מיוחד" } : p));
  combo = sync.buildComboPlan({ plans: renamed2, rooms: rooms13, rateMappings: mappings });
  const mm2 = sync.titleMismatches(combo, mappings);
  assert.equal(mm2.length, rooms13.length);
  assert.ok(mm2.every((m) => m.localRatePlanId === "plan-2" && m.expectedTitle.endsWith("תעריף שבועי מיוחד")));

  // after a successful run the stored titles match again → zero mismatches
  const refreshed = mkMappings(renamed);
  combo = sync.buildComboPlan({ plans: renamed, rooms: rooms13, rateMappings: refreshed });
  assert.equal(sync.titleMismatches(combo, refreshed).length, 0, "re-run after success selects nothing (idempotent)");

  // never selected: unmapped / creating / failed / reconciliation rows, rows
  // without an external id, and combos whose canonical title is invalid
  const edge = [
    { ...mappings[0], status: "creating" },
    { ...mappings[13], status: "failed" },
    { ...mappings[26], channex_rate_plan_id: null },
  ];
  combo = sync.buildComboPlan({ plans: renamed, rooms: rooms13, rateMappings: edge });
  assert.equal(sync.titleMismatches(combo, edge).length, 0, "only live 'mapped' rows with an external id are ever renamed");
  ok("title mismatches: derived per renamed plan, existing UUIDs only, idempotent, generic for any rename");

  // ---- the full-echo update payload: title is the ONE change ----
  const WEEK = (v) => [v, v, v, v, v, v, v];
  const attrs = {
    id: "ext-plan-0-926", // JSON:API id — NEVER part of a rate_plan payload
    inserted_at: "2026-07-09T10:00:00", // upstream bookkeeping — never echoed
    title: "חדר 926 - ללא דמי ביטול",
    property_id: PROP,
    room_type_id: "rt-926",
    parent_rate_plan_id: null,
    currency: "ILS",
    sell_mode: "per_person",
    rate_mode: "manual",
    options: [
      { occupancy: 2, is_primary: true, rate: 0 },
      { occupancy: 1, is_primary: false, rate: 0 },
    ],
    children_fee: "0.00",
    infant_fee: "0.00",
    meal_type: "none",
    tax_set_id: null,
    stop_sell: WEEK(true),
    closed_to_arrival: WEEK(false),
    closed_to_departure: WEEK(false),
    min_stay_arrival: WEEK(1),
    min_stay_through: WEEK(1),
    max_stay: WEEK(0),
    max_sell: null,
    max_availability: null,
    availability_offset: null,
    inherit_rate: false,
    inherit_closed_to_arrival: false,
    inherit_closed_to_departure: false,
    inherit_stop_sell: false,
    inherit_min_stay_arrival: false,
    inherit_min_stay_through: false,
    inherit_max_stay: false,
    inherit_max_sell: false,
    inherit_max_availability: false,
    inherit_availability_offset: false,
    auto_rate_settings: null,
  };
  const payload = sync.buildTitleUpdatePayload({
    attributes: attrs,
    propertyId: PROP,
    roomTypeId: "rt-926",
    title: "חדר 926 - ללא החזר",
  });
  assert.equal(payload.rate_plan.title, "חדר 926 - ללא החזר", "the title IS the change");
  for (const [k, v] of Object.entries(payload.rate_plan))
    if (k !== "title") assert.deepEqual(v, attrs[k], `field ${k} echoed byte-for-byte from the fresh GET`);
  for (const k of ["property_id", "room_type_id", "currency", "sell_mode", "rate_mode", "options",
    "children_fee", "infant_fee", "meal_type", "tax_set_id", "stop_sell", "min_stay_arrival",
    "min_stay_through", "max_stay", "inherit_rate", "auto_rate_settings", "parent_rate_plan_id"])
    assert.ok(k in payload.rate_plan, `documented field ${k} is preserved (no title-only partial body)`);
  assert.ok(!("id" in payload.rate_plan) && !("inserted_at" in payload.rate_plan), "non-payload upstream keys never echoed");
  // JSON:API GETs may carry ids only under relationships — injected, not invented
  const bare = sync.buildTitleUpdatePayload({ attributes: { title: "x" }, propertyId: PROP, roomTypeId: "rt-1", title: "y" });
  assert.equal(bare.rate_plan.property_id, PROP);
  assert.equal(bare.rate_plan.room_type_id, "rt-1");
  assert.deepEqual(Object.keys(bare.rate_plan).sort(), ["property_id", "room_type_id", "title"], "absent upstream fields are omitted, never fabricated");
  ok("update payload: full echo of the fresh GET, only the title changes, nothing fabricated or leaked");
}

// ============================================================
// API CLIENT — pagination, truncation, every error class, no key leak
// ============================================================
const KEY = "SECRET-api-key-value";
const rp = (id, over = {}) => ({
  id,
  attributes: { title: `t-${id}`, sell_mode: "per_person", rate_mode: "manual", currency: "ILS", options: [{ occupancy: 2, is_primary: true, rate: 0 }], ...over },
  relationships: { property: { data: { id: PROP } }, room_type: { data: { id: `rt-${id}` } } },
});

// single short page, meta agrees → complete
let fetches = [];
let fake = async (url, init) => {
  fetches.push({ url, init });
  return mkRes(200, { data: [rp("a"), rp("b")], meta: { page: 1, limit: 100, total: 2 } });
};
let res = await api.listChannexRatePlans({ apiKey: KEY, baseUrl: STAGING, propertyId: PROP, fetchImpl: fake });
assert.equal(res.ok, true);
assert.equal(res.ratePlans.length, 2);
assert.equal(res.truncated, false);
assert.ok(fetches[0].url.includes(`filter[property_id]=${PROP}`) && fetches[0].url.includes("pagination[page]=1") && fetches[0].url.includes("pagination[limit]=100"));
assert.equal(fetches[0].init.headers["user-api-key"], KEY, "auth via user-api-key header");
assert.equal(res.ratePlans[0].propertyId, PROP, "property id read from relationships (JSON:API)");
assert.equal(res.ratePlans[0].roomTypeId, "rt-a", "room type id read from relationships");
ok("list: one page, filter+pagination params, relationships extraction");

// meta.total contradicting a short page → truncated (never silently complete)
fake = async () => mkRes(200, { data: [rp("a")], meta: { total: 50 } });
res = await api.listChannexRatePlans({ apiKey: KEY, baseUrl: STAGING, propertyId: PROP, fetchImpl: fake });
assert.equal(res.truncated, true, "short page but total says more → truncated");
// server ignoring the page param (same full page forever) → truncated
const fullPage = Array.from({ length: 100 }, (_, i) => rp(`p${i}`));
fake = async () => mkRes(200, { data: fullPage, meta: { total: 500 } });
res = await api.listChannexRatePlans({ apiKey: KEY, baseUrl: STAGING, propertyId: PROP, fetchImpl: fake });
assert.equal(res.truncated, true, "a repeating full page can never be reported complete");
// multi-page complete
let page = 0;
fake = async () => {
  page++;
  return mkRes(200, {
    data: page === 1 ? fullPage : [rp("last")],
    meta: { total: 101 },
  });
};
res = await api.listChannexRatePlans({ apiKey: KEY, baseUrl: STAGING, propertyId: PROP, fetchImpl: fake });
assert.equal(res.ok && res.ratePlans.length, 101);
assert.equal(res.truncated, false);
ok("list: three-way truncation detection (meta.total, short page, repeating page)");

// every error status maps to a safe category; the key never leaks
const statuses = [
  [401, "unauthorized"],
  [403, "forbidden"],
  [404, "not_found"],
  [409, "conflict"],
  [422, "validation"],
  [429, "rate_limited"],
  [500, "server_error"],
  [503, "server_error"],
];
for (const [status, category] of statuses) {
  const r = await api.createChannexRatePlan({
    apiKey: KEY,
    baseUrl: STAGING,
    payload: { rate_plan: {} },
    fetchImpl: async () => mkRes(status, { errors: { title: "sensitive upstream detail" } }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.category, category, `${status} → ${category}`);
  assert.ok(!r.message.includes(KEY) && !r.message.includes("sensitive"), "no key, no raw upstream body in the message");
}
// timeout + network + malformed 2xx
let r = await api.createChannexRatePlan({
  apiKey: KEY, baseUrl: STAGING, payload: { rate_plan: {} },
  fetchImpl: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; },
});
assert.equal(r.category, "timeout");
r = await api.createChannexRatePlan({
  apiKey: KEY, baseUrl: STAGING, payload: { rate_plan: {} },
  fetchImpl: async () => { throw new Error(`ECONNREFUSED with ${KEY}`); },
});
assert.equal(r.category, "network_error");
assert.ok(!r.message.includes(KEY), "a thrown error never leaks the key");
r = await api.createChannexRatePlan({
  apiKey: KEY, baseUrl: STAGING, payload: { rate_plan: {} },
  fetchImpl: async () => mkRes(201, "not-json-shaped"),
});
assert.equal(r.category, "bad_response", "an unparseable 2xx is AMBIGUOUS — reconcile, never re-POST");
// 201 happy path
r = await api.createChannexRatePlan({
  apiKey: KEY, baseUrl: STAGING, payload: { rate_plan: {} },
  fetchImpl: async () => mkRes(201, { data: rp("new-1") }),
});
assert.equal(r.ok, true);
assert.equal(r.ratePlan.id, "new-1");
assert.equal(r.ratePlan.options.length, 1);
ok("client: every status class, timeout, network, malformed 2xx; api-key never leaks");

// ambiguity classification drives never-blind-retry
for (const amb of ["timeout", "network_error", "server_error", "bad_response"]) assert.equal(http.isAmbiguous(amb), true);
for (const def of ["unauthorized", "forbidden", "not_found", "conflict", "validation", "rate_limited"]) assert.equal(http.isAmbiguous(def), false);
ok("ambiguity classification: timeout/network/5xx/bad_response reconcile; 4xx retry safely");

// GET one — detail extraction incl. relationships
r = await api.getChannexRatePlan({
  apiKey: KEY, baseUrl: STAGING, id: "abc",
  fetchImpl: async (url) => { assert.ok(url.endsWith("/rate_plans/abc")); return mkRes(200, { data: rp("abc") }); },
});
assert.equal(r.ok && r.ratePlan.roomTypeId, "rt-abc");
assert.ok(r.ok && r.attributes && r.attributes.title === "t-abc", "raw attributes exposed for the full-echo update payload");
ok("get one rate plan: detail + relationships extraction + raw attributes");

// PUT one — the title-update write: /rate_plans/:id, echoed body, 200 parsed
{
  let putSeen = null;
  const echo = { rate_plan: { property_id: PROP, room_type_id: "rt-u1", title: "חדר 926 - ללא החזר", currency: "ILS" } };
  const r2 = await api.updateChannexRatePlan({
    apiKey: KEY, baseUrl: STAGING, id: "u1", payload: echo,
    fetchImpl: async (url, init) => {
      putSeen = { url, init };
      return mkRes(200, { data: rp("u1", { title: "חדר 926 - ללא החזר" }) });
    },
  });
  assert.ok(putSeen.url.endsWith("/rate_plans/u1"), "PUT targets the EXISTING plan id");
  assert.equal(putSeen.init.method, "PUT");
  assert.equal(putSeen.init.headers["user-api-key"], KEY);
  assert.deepEqual(JSON.parse(putSeen.init.body), echo, "the request body is exactly the echoed payload");
  assert.equal(r2.ok && r2.ratePlan.id, "u1", "the external UUID is unchanged in the response");
  assert.equal(r2.ok && r2.ratePlan.title, "חדר 926 - ללא החזר");
  // error statuses map like every other call and never leak the key
  for (const [status, category] of [[401, "unauthorized"], [404, "not_found"], [422, "validation"], [500, "server_error"]]) {
    const rf = await api.updateChannexRatePlan({
      apiKey: KEY, baseUrl: STAGING, id: "u1", payload: echo,
      fetchImpl: async () => mkRes(status, { errors: {} }),
    });
    assert.equal(rf.ok, false);
    assert.equal(rf.category, category);
    assert.ok(!JSON.stringify(rf).includes(KEY), "api-key never in a failure");
  }
  ok("update rate plan: PUT /rate_plans/:id with the echoed body; statuses mapped; no key leak");
}

// ============================================================
// SOURCE-LEVEL SCOPE + DURABILITY GUARDS
// ============================================================
const clientSrc = readFileSync("src/lib/channel/channex-rate-plans.ts", "utf8");
const adminSrc = readFileSync("src/lib/channel/rate-plan-admin.ts", "utf8");
const uiSrc = readFileSync("src/app/(dashboard)/channels/ChannexRatePlansSection.tsx", "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// client: GET+POST+PUT on /rate_plans only — never DELETE/PATCH, no other surface
const clientCode = stripComments(clientSrc);
assert.ok(!/"DELETE"|"PATCH"/.test(clientCode), "client never deletes");
assert.equal((clientCode.match(/method: "PUT"/g) ?? []).length, 1, "exactly one PUT site (the title update)");
assert.equal((clientCode.match(/method: "POST"/g) ?? []).length, 1, "exactly one POST site (creation)");
for (const surface of ["/availability", "/restrictions", "/webhooks", "/bookings", "/properties", "/room_types", "/channels"])
  assert.ok(!clientCode.includes(`"${surface}`) && !clientCode.includes(`\`${surface}`), `client never touches ${surface}`);
ok("client scope: /rate_plans GET+POST+PUT only; DELETE never exists");

// admin: exactly the three intended server actions, all guarded
const exported = [...adminSrc.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
assert.deepEqual(
  exported.sort(),
  ["getChannexRatePlanSyncContextAction", "startChannexRatePlanSyncAction", "startChannexRatePlanTitleSyncAction"],
  "exactly three server actions — read-only context, explicit create sync, explicit title sync",
);
for (const fn of exported) {
  const start = adminSrc.indexOf(`export async function ${fn}`);
  const next = adminSrc.indexOf("export async function", start + 10);
  const body = adminSrc.slice(start, next === -1 ? undefined : next);
  assert.ok(body.includes("requireChannelAdmin()"), `${fn} enforces super_admin server-side`);
}
// creation happens in exactly ONE place, inside the explicit action
assert.equal((adminSrc.match(/createChannexRatePlan\(/g) ?? []).length, 1, "exactly one external-creation call site");
assert.ok(
  adminSrc.indexOf("createChannexRatePlan(") > adminSrc.indexOf("export async function startChannexRatePlanSyncAction"),
  "the only creation call lives inside startChannexRatePlanSyncAction",
);
// the page-load context action never touches the network
const ctxBody = adminSrc.slice(
  adminSrc.indexOf("export async function getChannexRatePlanSyncContextAction"),
  adminSrc.indexOf("function blockReason"),
);
for (const netFn of ["createChannexRatePlan", "listChannexRatePlans", "getChannexRatePlan", "channexRequest"])
  assert.ok(!ctxBody.includes(`${netFn}(`), `page-load context must not call ${netFn}`);
ok("admin: three guarded actions; one creation site; page load is network-free");

// forbidden writes / surfaces in EXECUTABLE admin code
const adminCode = stripComments(adminSrc);
for (const forbidden of ["expedia", "booking.com", "airbnb", "webhook"])
  assert.ok(!adminCode.toLowerCase().includes(forbidden), `admin code never references ${forbidden}`);
assert.ok(!/pushAvailability|pushRates|pushRestrictions|sync_availability|sync_rates"|sync_ari_range|full_sync/.test(adminCode), "no ARI / availability / restriction push is ever enqueued");
assert.ok(!/method:\s*"DELETE"|DELETE FROM/.test(adminCode), "nothing is ever deleted");
assert.ok(!/UPDATE guesthub\.rooms|INSERT INTO guesthub\.rooms/.test(adminCode), "no GuestHub room write");
assert.ok(!/UPDATE guesthub\.pricing_plans|INSERT INTO guesthub\.pricing_plans/.test(adminCode), "the local Rate Plans are NEVER written (no duplication, no rename)");
assert.ok(!/UPDATE guesthub\.cancellation_policies|INSERT INTO guesthub\.cancellation_policies/.test(adminCode), "cancellation policies untouched");
assert.ok(!/INSERT INTO guesthub\.reservations|UPDATE guesthub\.reservations/.test(adminCode), "no reservation write");
assert.ok(!/UPDATE guesthub\.channel_room_mappings|INSERT INTO guesthub\.channel_room_mappings/.test(adminCode), "the D64 room mappings are read-only here");
assert.ok(!/UPDATE guesthub\.channel_connections/.test(adminCode), "the mapped Channex property is never rewritten");
for (const m of adminCode.matchAll(/writeAudit\(actor, \{[\s\S]{0,900}?\}\)/g))
  assert.ok(!/apiKey|api_key|ciphertext|secret/i.test(m[0]), "no credential in an audit payload");
ok("scope guard: no OTA/ARI/webhook surface, no GuestHub rate-plan/room/reservation/policy write");

// durability guards (the D64 lessons, asserted here too)
assert.ok(
  /idempotency_key = \$\{jobKey\}[\s\S]{0,200}status IN \('queued','processing','retry_wait'\)[\s\S]{0,200}COALESCE\(locked_at, created_at\) < now\(\) - make_interval/.test(adminSrc),
  "reserve reaps a stale create_rate_plan item job (no permanently bricked combination)",
);
const catchIdx = adminSrc.indexOf("catch (dbErr)");
assert.ok(catchIdx > 0 && adminSrc.indexOf("run.created++", catchIdx) > catchIdx, "run.created++ happens AFTER the mapping-write catch — a post-commit audit failure never downgrades a mapped combo");
assert.ok(/catch \(auditErr\)/.test(adminSrc), "post-commit audit is best-effort");
assert.ok(/let parentJobId: string \| null = null/.test(adminSrc), "parentJobId hoisted for the top-level catch");
assert.ok(/if \(parentJobId\) \{[\s\S]{0,300}settleJobFailed\(parentJobId/.test(adminSrc), "a mid-run throw settles the parent job");
assert.ok(/provider_task_id = \$\{created\.ratePlan\.id\}/.test(adminSrc), "the external UUID is persisted on the durable job BEFORE the mapping commit");
assert.ok(/FOR UPDATE/.test(adminSrc), "the mapping row is re-checked under lock before enqueue");
// ambiguous-clearing must require a COMPLETE listing and a NULL external id
assert.ok(
  /if \(!listed\.truncated && externalUnmapped\.length === 0\) \{[\s\S]{0,400}channex_rate_plan_id IS NULL[\s\S]{0,200}status IN \('creating','reconciliation_required'\)/.test(adminSrc),
  "ambiguous combos are cleared ONLY by a complete external listing with no unmapped plans, and never rows holding an external id",
);
// zombie-write guard: a client-side timeout may still be applied upstream
// moments later — an ambiguous combo becomes retryable only after the grace
// window, so the "complete listing" proof postdates any late apply
assert.ok(
  /status IN \('creating','reconciliation_required'\)\s*\n\s*AND updated_at < now\(\) - make_interval\(mins => \$\{AMBIGUITY_GRACE_MINUTES\}\)/.test(adminSrc),
  "clearing respects the zombie-write grace window",
);
assert.ok(/blocked = blockReason\(plan, listed\.truncated, externalUnmapped\)/.test(adminSrc), "truncation / external-unmapped / pending-reconciliation block the run BEFORE any POST");
// the run mutex is claimed BEFORE the external listing and the ambiguity
// clearing — a second click can never race an active run's in-flight state
const startBody = adminSrc.slice(adminSrc.indexOf("export async function startChannexRatePlanSyncAction"));
assert.ok(
  startBody.indexOf("pg_advisory_xact_lock") < startBody.indexOf("listChannexRatePlans("),
  "parent mutex precedes the external listing",
);
assert.ok(
  startBody.indexOf("enqueueChannelJob") < startBody.indexOf("status = 'failed', last_error_code = 'not_created'"),
  "ambiguity clearing runs under the claimed run, never on a losing concurrent click",
);
// a zombie run that outlived the stale window must never clobber the mapping a
// newer run re-owned — the success UPDATE is ownership-guarded
assert.ok(
  /AND local_rate_plan_id = \$\{row\.localRatePlanId\}\s*\n\s*AND status = 'creating'`/.test(adminSrc),
  "success UPDATE writes only the row this run reserved (status='creating' ownership guard)",
);
assert.ok(/lost_race/.test(adminSrc), "a lost ownership race is settled honestly, never silently");
// stranded item jobs are reaped connection-wide at claim time — an orphan that
// blocks every run before the loop can no longer freeze a 'processing' job
// forever (which would also starve claimChannelJobs for the connection)
assert.ok(
  /job_type = 'create_rate_plan'\s*\n\s*AND status IN \('queued','processing','retry_wait'\)/.test(adminSrc),
  "claim txn reaps stale create_rate_plan item jobs connection-wide",
);
// the parent job proves liveness while working, so the stale reaper is sound
assert.ok(/SET locked_at = now\(\) WHERE id = \$\{parentJobId\}/.test(adminSrc), "per-combo heartbeat on the parent job");
// the run-summary audit can never reclassify an already-settled run
assert.ok((adminSrc.match(/catch \(auditErr\)/g) ?? []).length >= 2, "run-summary audit is best-effort too");
// remaining counts only resumable work — permanently invalid combos never fake 'partial'
assert.ok(/&& r\.validationError === null,?\s*\n\s*\)\.length/.test(adminSrc), "remaining excludes validation_required combos");
ok("durability guards: item-job reaper, UUID-before-commit, audit-outside-try, parent settled, safe clearing");

// TITLE SYNC (D67) — source-level correctness + scope guards
const titleBody = adminSrc.slice(adminSrc.indexOf("export async function startChannexRatePlanTitleSyncAction"));
assert.ok(titleBody.length > 100, "title-sync action exists");
assert.ok(!titleBody.includes("createChannexRatePlan("), "the title sync NEVER creates (no POST path)");
assert.ok(
  titleBody.indexOf("getChannexRatePlan(") > 0 &&
    titleBody.indexOf("getChannexRatePlan(") < titleBody.indexOf("updateChannexRatePlan("),
  "a fresh GET always precedes the PUT",
);
assert.equal((adminSrc.match(/updateChannexRatePlan\(/g) ?? []).length, 1, "exactly ONE external-update call site");
assert.ok(
  adminSrc.indexOf("updateChannexRatePlan(") > adminSrc.indexOf("export async function startChannexRatePlanTitleSyncAction"),
  "the only update call lives inside the explicit title-sync action",
);
const createActionBody = adminSrc.slice(
  adminSrc.indexOf("export async function startChannexRatePlanSyncAction"),
  adminSrc.indexOf("export async function startChannexRatePlanTitleSyncAction"),
);
assert.ok(!createActionBody.includes("updateChannexRatePlan("), "the creation flow never PUTs");
assert.ok(!titleBody.includes("INSERT INTO guesthub.channel_room_rate_mappings"), "the title sync never creates a mapping");
assert.ok(titleBody.includes("buildTitleUpdatePayload("), "the PUT body is the full echo of the fresh GET");
assert.ok(/mismatches\.length === 0/.test(titleBody), "matching titles → the run performs no PUT");
assert.ok(/wrongProperty|wrongRoomType/.test(titleBody), "external identity (property + room type) verified before any PUT");
assert.ok(/got\.ratePlan\.title === m\.expectedTitle/.test(titleBody), "an upstream title that already matches is refreshed, never re-PUT");
// the local refresh pins the SAME external UUID in the WHERE and never assigns it
const refreshBody = adminSrc.slice(adminSrc.indexOf("async function refreshMappingTitle"), adminSrc.indexOf("async function recordTitleFailure"));
assert.ok(/AND channex_rate_plan_id = \$\{m\.channexRatePlanId\}/.test(refreshBody), "refresh WHERE pins the existing external UUID");
assert.ok(!/SET[\s\S]*?channex_rate_plan_id\s*=/.test(refreshBody.slice(refreshBody.indexOf("SET"), refreshBody.indexOf("WHERE"))), "the external UUID is never rewritten");
assert.ok(/last_verified_at = now\(\)/.test(refreshBody) && /last_error = NULL/.test(refreshBody), "refresh stamps last_verified_at and clears prior errors");
// a failed item keeps its mapping: no status change, error recorded, retried later
const failBody = adminSrc.slice(adminSrc.indexOf("async function recordTitleFailure"), adminSrc.indexOf("export async function startChannexRatePlanTitleSyncAction"));
assert.ok(!/SET[\s\S]*?status\s*=/.test(failBody.slice(failBody.indexOf("SET"), failBody.indexOf("WHERE"))), "a failed title update never changes the mapping status");
assert.ok(/AND status = 'mapped'/.test(failBody), "failure is recorded only on the still-mapped row");
assert.ok(/parentKey = ratePlanTitleSyncJobKey/.test(titleBody) && /pg_advisory_xact_lock/.test(titleBody), "durable run mutex — duplicate submissions rejected");
assert.ok(/unauthorized" \|\| .*forbidden"/.test(titleBody), "a rejected credential stops the run early");
ok("title sync: GET-before-PUT, one update site, echo payload, UUID pinned, failures kept mapped and retryable");

// UI: one compact card — no simulator, no table, no per-room buttons
assert.ok(uiSrc.includes("תוכניות תעריף ב־Channex"), "card title");
assert.ok(uiSrc.includes("יצירת תוכניות התעריף ב־Channex Staging"), "the creation button");
assert.ok(uiSrc.includes("צור תוכניות תעריף") && uiSrc.includes("ביטול"), "create confirm dialog buttons");
assert.ok(uiSrc.includes("עדכון שמות ב־Channex"), "the title-update button");
assert.ok(uiSrc.includes("שמות דורשים עדכון"), "mismatch count indicator");
assert.ok(uiSrc.includes("לעדכן את שמות") && uiSrc.includes("עדכן שמות"), "title confirm dialog + its confirm button");
assert.ok(/view\.titleMismatches > 0 &&/.test(uiSrc), "the title button is hidden when every external title matches");
assert.ok(!/<table/.test(uiSrc), "no per-room preview table");
assert.ok(!/simulator|סימולטור|מחשבון/.test(uiSrc), "no pricing simulator/calculator");
assert.equal((uiSrc.match(/startChannexRatePlanSyncAction\(/g) ?? []).length, 1, "one create wire — no per-room/per-plan buttons");
assert.equal((uiSrc.match(/startChannexRatePlanTitleSyncAction\(/g) ?? []).length, 1, "one title-sync wire");
assert.ok(!/\b65\b|\b13\b/.test(stripComments(uiSrc).replace(/max-w|z-50|h-11|p-\d|gap-\d|grid-cols-\d/g, "")), "no hardcoded combination counts in the UI");
assert.ok(/submitting\) return/.test(uiSrc), "double-submit guarded");
ok("UI: one card, two explicit confirmed actions; rename button only on drift; counts fully dynamic");

console.log(`check-channex-rate-plans: ${n} groups, all assertions passed ✓`);
