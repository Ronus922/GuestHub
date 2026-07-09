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
// durable job keys, and source-level scope + durability guards.
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
ok("durable job keys: property + local plan + room + operation");

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
ok("get one rate plan: detail + relationships extraction");

// ============================================================
// SOURCE-LEVEL SCOPE + DURABILITY GUARDS
// ============================================================
const clientSrc = readFileSync("src/lib/channel/channex-rate-plans.ts", "utf8");
const adminSrc = readFileSync("src/lib/channel/rate-plan-admin.ts", "utf8");
const uiSrc = readFileSync("src/app/(dashboard)/channels/ChannexRatePlansSection.tsx", "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// client: GET+POST on /rate_plans only — no DELETE, no PUT, no other surface
const clientCode = stripComments(clientSrc);
assert.ok(!/"DELETE"|"PUT"|"PATCH"/.test(clientCode), "client never deletes or updates");
for (const surface of ["/availability", "/restrictions", "/webhooks", "/bookings", "/properties", "/room_types", "/channels"])
  assert.ok(!clientCode.includes(`"${surface}`) && !clientCode.includes(`\`${surface}`), `client never touches ${surface}`);
ok("client scope: /rate_plans GET+POST only");

// admin: exactly the two intended server actions, both guarded
const exported = [...adminSrc.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
assert.deepEqual(
  exported.sort(),
  ["getChannexRatePlanSyncContextAction", "startChannexRatePlanSyncAction"],
  "exactly two server actions — context (read-only) and the explicit sync",
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
ok("admin: two guarded actions; one creation site; page load is network-free");

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
ok("durability guards: item-job reaper, UUID-before-commit, audit-outside-try, parent settled, safe clearing");

// UI: one compact card — no simulator, no table, no per-room buttons
assert.ok(uiSrc.includes("תוכניות תעריף ב־Channex"), "card title");
assert.ok(uiSrc.includes("יצירת תוכניות התעריף ב־Channex Staging"), "the single action button");
assert.ok(uiSrc.includes("צור תוכניות תעריף") && uiSrc.includes("ביטול"), "confirm dialog buttons");
assert.ok(!/<table/.test(uiSrc), "no per-room preview table");
assert.ok(!/simulator|סימולטור|מחשבון/.test(uiSrc), "no pricing simulator/calculator");
assert.equal((uiSrc.match(/startChannexRatePlanSyncAction\(/g) ?? []).length, 1, "one action wire — no per-room/per-plan buttons");
assert.ok(!/\b65\b|\b13\b/.test(stripComments(uiSrc).replace(/max-w|z-50|h-11|p-\d|gap-\d|grid-cols-\d/g, "")), "no hardcoded combination counts in the UI");
assert.ok(/submitting\) return/.test(uiSrc), "double-submit guarded");
ok("UI: one card, one button, one confirmation dialog; counts fully dynamic");

console.log(`check-channex-rate-plans: ${n} groups, all assertions passed ✓`);
