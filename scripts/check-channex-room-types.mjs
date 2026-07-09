// Runnable checks for the physical-room → Channex Room Type synchronization
// (D64), same pattern as check-channex-properties.mjs: compile the PURE modules
// with tsc, import them, assert. NO DB, NO live socket, NO Channex entity is ever
// created — every network call is an injected fake fetch.
//
// Covers: the model (physical rooms are the mapping entity, the 3 GuestHub
// categories are not), the deterministic occupancy conversion, the exact title
// format, count_of_rooms === 1, inactive exclusion, numeric sorting, the API
// client (list/get/create + every error status + timeout/network/malformed),
// safety (no title-only adoption, ambiguity classification, no key leak,
// staging/production isolation) and a source-level scope guard.
//
// Usage: node scripts/check-channex-room-types.mjs
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const out = mkdtempSync(join(tmpdir(), "channex-rt-"));
execSync(
  `pnpm exec tsc src/lib/channel/channex-room-types.ts src/lib/channel/room-type-sync.ts src/lib/channel/channex-http.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const api = require(join(out, "channex-room-types.js"));
const sync = require(join(out, "room-type-sync.js"));
const http = require(join(out, "channex-http.js"));

const STAGING = "https://staging.channex.io/api/v1";
const PROD = "https://app.channex.io/api/v1";
const PROP = "10338c65-5b0e-402b-bdaa-f3efe10e9896";
const mkRes = (status, body) => ({ status, json: async () => body });

let n = 0;
const ok = (name) => {
  console.log(`  ✓ ${name}`);
  n++;
};

// The 13 ACTIVE production rooms, exactly as guesthub.rooms holds them. Used as a
// verification expectation only — the application never hardcodes this list.
const PROD_ROOMS = [
  { num: "926", type: "סטודיו", tot: 4, ad: 2, ch: 2, inf: 1, def: 2 },
  { num: "1006", type: "סוויטה", tot: 4, ad: 4, ch: 2, inf: 1, def: 2 },
  { num: "1102", type: "סוויטה", tot: 4, ad: 3, ch: 2, inf: 1, def: 4 },
  { num: "1130", type: "סטודיו", tot: 2, ad: 2, ch: 0, inf: 1, def: 2 },
  { num: "1131", type: "סטודיו", tot: 2, ad: 2, ch: 0, inf: 1, def: 2 },
  { num: "1142", type: "חדר שינה וסלון", tot: 4, ad: 4, ch: 2, inf: 1, def: 2 },
  { num: "1235", type: "חדר שינה וסלון", tot: 3, ad: 2, ch: 1, inf: 1, def: 2 },
  { num: "1237", type: "חדר שינה וסלון", tot: 4, ad: 4, ch: 3, inf: 1, def: 4 },
  { num: "1238", type: "סטודיו", tot: 2, ad: 2, ch: 0, inf: 0, def: 2 },
  { num: "1242", type: "חדר שינה וסלון", tot: 4, ad: 4, ch: 2, inf: 1, def: 2 },
  { num: "1245", type: "חדר שינה וסלון", tot: 4, ad: 2, ch: 2, inf: 1, def: 2 },
  { num: "1329", type: "סוויטה", tot: 6, ad: 6, ch: 4, inf: 1, def: 2 },
  { num: "1424", type: "סוויטה", tot: 2, ad: 2, ch: 0, inf: 0, def: 2 },
];

const mkRoom = (r, over = {}) => ({
  id: `room-${r.num}`,
  room_number: r.num,
  room_type_name: r.type,
  area_name: null,
  floor: null,
  is_active: true,
  status: "available",
  max_occupancy: r.tot,
  max_adults: r.ad,
  max_children: r.ch,
  max_infants: r.inf,
  default_occupancy: r.def,
  ...over,
});

// ============================================================
// MODEL — the physical room is the mapping entity
// ============================================================
const rooms = PROD_ROOMS.map((r) => mkRoom(r));
const plan = sync.buildSyncPlan({ rooms, mappings: [], externalRoomTypes: [], roomCategories: 3 });

assert.equal(plan.rows.length, 13, "13 active rooms → 13 preview rows (not 3 category rows)");
assert.equal(plan.summary.activeRooms, 13);
assert.equal(plan.summary.roomCategories, 3, "the 3 GuestHub categories are reported separately");
assert.equal(plan.summary.validReady, 13, "all 13 rooms are valid and ready");
assert.equal(plan.summary.mappedRooms, 0);
assert.equal(plan.summary.unmappedRooms, 13);
assert.equal(plan.summary.externalRoomTypes, 0, "Channex holds 0 room types before the sync");
ok("13 physical rooms produce 13 preview rows; the 3 categories are never the mapping unit");

// numeric sorting, not lexicographic
assert.deepEqual(
  plan.rows.map((r) => r.roomNumber),
  ["926", "1006", "1102", "1130", "1131", "1142", "1235", "1237", "1238", "1242", "1245", "1329", "1424"],
  "room numbers sort numerically",
);
assert.deepEqual(
  sync.sortByRoomNumber([{ roomNumber: "10" }, { roomNumber: "2" }, { roomNumber: "10A" }, { roomNumber: "b" }]).map((r) => r.roomNumber),
  ["2", "10", "10A", "b"],
);
ok("numeric-first room ordering (2 < 10 < 10A < b)");

// count_of_rooms is ALWAYS 1
assert.equal(sync.COUNT_OF_ROOMS, 1);
assert.ok(plan.rows.every((r) => r.countOfRooms === 1), "every row proposes exactly one physical unit");
ok("count_of_rooms is always 1 — one physical unit per Room Type");

// exact title format
assert.equal(sync.buildRoomTypeTitle("926", "סטודיו").title, "חדר 926 - סטודיו");
assert.equal(sync.buildRoomTypeTitle("1006", "סוויטה").title, "חדר 1006 - סוויטה");
assert.equal(sync.buildRoomTypeTitle("1142", "חדר שינה וסלון").title, "חדר 1142 - חדר שינה וסלון");
assert.equal(sync.buildRoomTypeTitle(" 926 ", " סטודיו ").title, "חדר 926 - סטודיו", "inputs are trimmed");
for (const forbidden of ["GuestHub", "Staging", "10338c65", "room-926"]) {
  assert.ok(
    plan.rows.every((r) => !r.proposedTitle.includes(forbidden)),
    `title never contains ${forbidden}`,
  );
}
assert.equal(sync.buildRoomTypeTitle("926", null).ok, false, "missing room type name blocks the title");
assert.equal(sync.buildRoomTypeTitle("926", null).code, "room_type_missing");
assert.equal(sync.buildRoomTypeTitle("", "סטודיו").code, "room_number_missing");
assert.equal(sync.MAX_TITLE_LENGTH, 255, "Channex documents a 255-symbol title limit");
// "חדר " (4) + "1" (1) + " - " (3) = 8 fixed symbols → a 247-char name is exactly 255
assert.equal(sync.buildRoomTypeTitle("1", "x".repeat(247)).title.length, 255, "exactly 255 is allowed");
const longTitle = sync.buildRoomTypeTitle("1", "x".repeat(248));
assert.equal(longTitle.ok, false);
assert.equal(longTitle.code, "title_too_long", "a title over 255 symbols is blocked, not truncated");
ok("title format is exactly 'חדר <number> - <category>' and is length-validated");

// inactive rooms
const withInactive = sync.buildSyncPlan({
  rooms: [...rooms, mkRoom({ num: "9999", type: "סטודיו", tot: 2, ad: 2, ch: 0, inf: 0, def: 2 }, { is_active: false, id: "room-x" })],
  mappings: [],
  externalRoomTypes: [],
  roomCategories: 3,
});
assert.equal(withInactive.summary.activeRooms, 13, "inactive room is not counted as active");
assert.equal(withInactive.summary.inactiveRooms, 1);
assert.equal(withInactive.summary.validReady, 13, "inactive room is never a creation candidate");
const inactiveRow = withInactive.rows.find((r) => r.roomNumber === "9999");
assert.equal(inactiveRow.status, "excluded_inactive", "inactive room is SHOWN, marked excluded");
assert.equal(inactiveRow.creatable, false);
ok("inactive rooms appear in the preview as excluded and are never created");

// ============================================================
// OCCUPANCY — deterministic conversion, evidence-based semantics
// ============================================================
// occ_children is CHILD-ONLY BED SPACES (Channex), while GuestHub max_children is
// MAXIMUM CHILDREN ALLOWED. Room 1006 proves they differ: adults 4 == total 4, so
// there are ZERO child-only beds even though max_children is 2.
const r1006 = sync.deriveChannexOccupancy(mkRoom(PROD_ROOMS[1])).occ;
assert.equal(r1006.occ_adults, 4);
assert.equal(r1006.occ_children, 0, "max_children=2 is NOT copied when adults already fill total capacity");
assert.equal(r1006.occ_infants, 1);

const r926 = sync.deriveChannexOccupancy(mkRoom(PROD_ROOMS[0])).occ;
assert.equal(r926.occ_adults, 2);
assert.equal(r926.occ_children, 2, "total 4 - adults 2 = 2 child-only beds, capped by max_children 2");

const r1235 = sync.deriveChannexOccupancy(mkRoom(PROD_ROOMS[6])).occ;
assert.equal(r1235.occ_children, 1, "total 3 - adults 2 = 1, capped by max_children 1");

const r1329 = sync.deriveChannexOccupancy(mkRoom(PROD_ROOMS[11])).occ;
assert.equal(r1329.occ_children, 0, "adults 6 == total 6 → no child-only beds despite max_children 4");
ok("occ_children is DERIVED (total - adults, capped by max_children), never blindly copied");

// invariants across every production room
for (const r of PROD_ROOMS) {
  const res = sync.deriveChannexOccupancy(mkRoom(r));
  assert.equal(res.ok, true, `room ${r.num} converts`);
  const o = res.occ;
  assert.ok(o.occ_adults >= 1, `${r.num}: occ_adults >= 1`);
  assert.ok(o.occ_children >= 0 && o.occ_infants >= 0, `${r.num}: no negative capacity`);
  assert.ok(o.occ_adults + o.occ_children <= r.tot, `${r.num}: adults+children never exceed GuestHub total`);
  assert.ok(o.occ_adults <= r.tot, `${r.num}: occ_adults never exceeds GuestHub total`);
  assert.ok(o.default_occupancy >= 1, `${r.num}: default_occupancy positive`);
  assert.ok(o.default_occupancy <= o.occ_adults, `${r.num}: default_occupancy <= occ_adults`);
  assert.ok(o.occ_children <= r.ch, `${r.num}: child-only beds never exceed max_children`);
  assert.equal(o.occ_infants, r.inf, `${r.num}: infants map 1:1 to cot capacity`);
}
ok("all 13 production rooms satisfy every Channex occupancy invariant");

// the ONE capped room: 1102 has default_occupancy 4 > max_adults 3
const r1102 = sync.deriveChannexOccupancy(mkRoom(PROD_ROOMS[2])).occ;
assert.equal(r1102.occ_adults, 3);
assert.equal(r1102.default_occupancy, 3, "default_occupancy capped to occ_adults");
assert.equal(r1102.sourceDefaultOccupancy, 4, "GuestHub's own value is preserved for display");
assert.equal(r1102.defaultOccupancyCapped, true, "the cap is surfaced, never silent");
assert.equal(sync.deriveChannexOccupancy(mkRoom(PROD_ROOMS[0])).occ.defaultOccupancyCapped, false);
ok("default_occupancy > occ_adults is capped and flagged — GuestHub data untouched");

// blocking validation
const bad = (over) => sync.deriveChannexOccupancy({ max_occupancy: 4, max_adults: 2, max_children: 1, max_infants: 0, default_occupancy: 2, ...over });
assert.equal(bad({ default_occupancy: null }).ok, false);
assert.equal(bad({ default_occupancy: null }).code, "default_missing", "unset default_occupancy BLOCKS — never invented");
assert.equal(bad({ default_occupancy: 0 }).code, "default_invalid");
assert.equal(bad({ max_adults: 0 }).code, "adults_invalid");
assert.equal(bad({ max_occupancy: 0, max_adults: 0 }).code, "total_invalid");
assert.equal(bad({ max_adults: 5 }).code, "adults_exceed_total", "adults > total is ambiguous → blocked");
assert.equal(bad({ max_children: -1 }).code, "negative_capacity");
assert.equal(bad({ max_infants: -2 }).code, "negative_capacity");
assert.equal(bad({ max_children: 1.5 }).code, "negative_capacity", "non-integer capacity is rejected");
ok("ambiguous or incomplete rooms emit a blocking validation error");

// a blocked room surfaces as validation_required and is NOT creatable
const blockedPlan = sync.buildSyncPlan({
  rooms: [mkRoom(PROD_ROOMS[0], { default_occupancy: null }), mkRoom(PROD_ROOMS[1], { room_type_name: null })],
  mappings: [],
  externalRoomTypes: [],
  roomCategories: 3,
});
assert.equal(blockedPlan.summary.validationErrors, 2);
assert.equal(blockedPlan.summary.validReady, 0, "no invalid room is ever a creation candidate");
assert.ok(blockedPlan.rows.every((r) => r.status === "validation_required" && !r.creatable));
ok("invalid rooms are blocked from creation and reported as 'validation required'");

// the conversion is PURE — it never mutates its input
const src = mkRoom(PROD_ROOMS[2]);
const snapshot = JSON.stringify(src);
sync.deriveChannexOccupancy(src);
sync.buildRoomTypeTitle(src.room_number, src.room_type_name);
sync.buildSyncPlan({ rooms: [src], mappings: [], externalRoomTypes: [], roomCategories: 3 });
assert.equal(JSON.stringify(src), snapshot, "no GuestHub capacity data is modified");
ok("no GuestHub room/capacity value is modified by the conversion");

// ============================================================
// CREATE PAYLOAD (§6)
// ============================================================
const payload = sync.buildCreateRoomTypePayload(PROP, {
  title: "חדר 926 - סטודיו",
  occ: r926,
}).room_type;
assert.equal(payload.property_id, PROP);
assert.equal(payload.title, "חדר 926 - סטודיו");
assert.equal(payload.count_of_rooms, 1);
assert.equal(payload.occ_adults, 2);
assert.equal(payload.occ_children, 2);
assert.equal(payload.occ_infants, 1);
assert.equal(payload.default_occupancy, 2);
assert.equal(payload.room_kind, "room");
for (const forbidden of ["facilities", "photos", "content", "description", "capacity", "rate_plan", "availability", "restrictions"]) {
  assert.ok(!(forbidden in payload), `create payload must not send ${forbidden}`);
}
assert.deepEqual(
  Object.keys(payload).sort(),
  ["count_of_rooms", "default_occupancy", "occ_adults", "occ_children", "occ_infants", "property_id", "room_kind", "title"],
  "the payload carries ONLY the documented required attributes plus room_kind",
);
ok("create payload sends exactly the required attributes; no facilities/photos/content/rates");

// ============================================================
// API CLIENT — injected fetch, no live socket
// ============================================================
const cap = {};
let res = await api.listChannexRoomTypes({
  apiKey: "SECRET-123",
  baseUrl: STAGING,
  propertyId: PROP,
  fetchImpl: async (url, init) => {
    cap.url = url;
    cap.headers = init.headers;
    cap.method = init.method;
    return mkRes(200, { data: [{ type: "room_type", id: "rt-1", attributes: { id: "rt-1", title: "חדר 926 - סטודיו", count_of_rooms: 1, occ_adults: 2 } }], meta: { page: 1, limit: 100, total: 1 } });
  },
});
assert.equal(res.ok, true);
assert.equal(res.roomTypes.length, 1);
assert.equal(res.roomTypes[0].id, "rt-1", "id read from data.id");
assert.equal(res.roomTypes[0].countOfRooms, 1);
assert.equal(res.truncated, false);
assert.equal(cap.method, "GET");
assert.ok(cap.url.startsWith(`${STAGING}/room_types?filter[property_id]=${PROP}`), "list filters by property_id");
assert.ok(cap.url.includes("pagination[page]=1") && cap.url.includes("pagination[limit]=100"), "documented pagination params");
assert.equal(cap.headers["user-api-key"], "SECRET-123");
ok("list room types: filter[property_id] + pagination[page]/[limit], id from data.id");

// staging/production isolation
await api.listChannexRoomTypes({ apiKey: "x", baseUrl: PROD, propertyId: PROP, fetchImpl: async (u) => { cap.url = u; return mkRes(200, { data: [], meta: { total: 0 } }); } });
assert.ok(cap.url.startsWith(`${PROD}/room_types`), "production baseUrl → production URL");
assert.notEqual(STAGING, PROD);
ok("staging and production base URLs are distinct and never mixed");

// pagination: follows pages, dedupes, and bounds itself
let pages = 0;
res = await api.listChannexRoomTypes({
  apiKey: "x", baseUrl: STAGING, propertyId: PROP,
  fetchImpl: async () => {
    pages++;
    const data = Array.from({ length: pages === 1 ? 100 : 13 }, (_, i) => ({ id: `rt-${pages}-${i}` }));
    return mkRes(200, { data, meta: { page: pages, limit: 100, total: 113 } });
  },
});
assert.equal(res.ok, true);
assert.equal(res.roomTypes.length, 113, "pagination collects every record");
assert.equal(pages, 2);
// a server that ignores the page param must not loop forever, AND must be
// reported as TRUNCATED (meta.total proves records are missing) so the caller's
// anti-duplication guard fires instead of trusting an incomplete list.
let loops = 0;
res = await api.listChannexRoomTypes({
  apiKey: "x", baseUrl: STAGING, propertyId: PROP,
  fetchImpl: async () => { loops++; return mkRes(200, { data: Array.from({ length: 100 }, (_, i) => ({ id: `same-${i}` })), meta: { total: 9999 } }); },
});
assert.equal(res.ok, true);
assert.equal(res.roomTypes.length, 100, "repeated identical pages terminate the loop");
assert.equal(loops, 2, "stops as soon as a page adds nothing new");
assert.equal(res.truncated, true, "a pagination-ignoring server with total>collected is TRUNCATED, never 'complete'");

// a full first page that adds nothing new but total==collected IS complete
res = await api.listChannexRoomTypes({
  apiKey: "x", baseUrl: STAGING, propertyId: PROP,
  fetchImpl: async () => mkRes(200, { data: Array.from({ length: 100 }, (_, i) => ({ id: `r-${i}` })), meta: { total: 100 } }),
});
assert.equal(res.truncated, false, "a full page that equals total is complete");
assert.equal(res.roomTypes.length, 100);

// a short page whose total is NOT yet satisfied is truncated (defends the guard)
res = await api.listChannexRoomTypes({
  apiKey: "x", baseUrl: STAGING, propertyId: PROP,
  fetchImpl: async () => mkRes(200, { data: [{ id: "only-1" }], meta: { total: 50 } }),
});
assert.equal(res.truncated, true, "a short page below meta.total is truncated");

// a short page with no meta.total is trusted as the last page (best effort)
res = await api.listChannexRoomTypes({
  apiKey: "x", baseUrl: STAGING, propertyId: PROP,
  fetchImpl: async () => mkRes(200, { data: [{ id: "a" }, { id: "b" }] }),
});
assert.equal(res.truncated, false, "a short page with no total is treated as complete");
assert.equal(res.roomTypes.length, 2);
ok("pagination is bounded; incompleteness proven by meta.total is reported as truncated");

// get one
res = await api.getChannexRoomType({ apiKey: "x", baseUrl: STAGING, id: "rt-1", fetchImpl: async (u) => { cap.url = u; return mkRes(200, { data: { id: "rt-1", attributes: { title: "T", occ_adults: 2, occ_children: 0, occ_infants: 1, default_occupancy: 2, count_of_rooms: 1, room_kind: "room" }, relationships: { property: { data: { type: "property", id: PROP } } } } }); } });
assert.equal(res.ok, true);
assert.equal(cap.url, `${STAGING}/room_types/rt-1`);
assert.equal(res.roomType.propertyId, PROP, "property id read from relationships when absent from attributes");
ok("get one room type hits /room_types/:id and resolves its property");

// create
const capC = {};
res = await api.createChannexRoomType({
  apiKey: "x", baseUrl: STAGING,
  payload: sync.buildCreateRoomTypePayload(PROP, { title: "חדר 926 - סטודיו", occ: r926 }),
  fetchImpl: async (u, init) => { capC.url = u; capC.method = init.method; capC.ct = init.headers["Content-Type"]; capC.body = init.body; return mkRes(201, { data: { id: "new-rt", attributes: { title: "חדר 926 - סטודיו", count_of_rooms: 1 } } }); },
});
assert.equal(res.ok, true);
assert.equal(res.roomType.id, "new-rt");
assert.equal(capC.method, "POST");
assert.equal(capC.url, `${STAGING}/room_types`);
assert.equal(capC.ct, "application/json");
const sent = JSON.parse(capC.body);
assert.ok("room_type" in sent, "body is wrapped in the documented {room_type:{…}} envelope");
assert.equal(sent.room_type.count_of_rooms, 1);
ok("create posts {room_type:{…}} to /room_types and surfaces the new id");

// every error status
for (const [status, category] of [[401, "unauthorized"], [403, "forbidden"], [404, "not_found"], [409, "conflict"], [422, "validation"], [429, "rate_limited"], [500, "server_error"], [418, "bad_response"]]) {
  const r = await api.createChannexRoomType({ apiKey: "x", baseUrl: STAGING, payload: { room_type: {} }, fetchImpl: async () => mkRes(status, { errors: { code: "validation_error", details: { title: ["can't be blank"] } } }) });
  assert.equal(r.ok, false);
  assert.equal(r.category, category, `${status} → ${category}`);
  assert.equal(r.httpStatus, status);
}
ok("401/403/404/409/422/429/5xx/unknown map to safe categories");

// timeout / network / malformed
res = await api.createChannexRoomType({ apiKey: "x", baseUrl: STAGING, payload: { room_type: {} }, fetchImpl: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; } });
assert.equal(res.category, "timeout");
res = await api.createChannexRoomType({ apiKey: "x", baseUrl: STAGING, payload: { room_type: {} }, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
assert.equal(res.category, "network_error");
res = await api.createChannexRoomType({ apiKey: "x", baseUrl: STAGING, payload: { room_type: {} }, fetchImpl: async () => mkRes(201, { data: { nope: 1 } }) });
assert.equal(res.category, "bad_response", "an unparseable 2xx is a failure, not a fake success");
res = await api.createChannexRoomType({ apiKey: "x", baseUrl: STAGING, payload: { room_type: {} }, fetchImpl: async () => ({ status: 201, json: async () => { throw new Error("not json"); } }) });
assert.equal(res.category, "bad_response");
res = await api.listChannexRoomTypes({ apiKey: "x", baseUrl: STAGING, propertyId: PROP, fetchImpl: async () => mkRes(200, { data: "garbage" }) });
assert.equal(res.ok, true);
assert.deepEqual(res.roomTypes, [], "a malformed list body degrades to empty, never throws");
ok("timeout / network error / malformed response are handled without throwing");

// AMBIGUITY classification drives the never-blindly-retry rule
for (const c of ["timeout", "network_error", "server_error", "bad_response"]) assert.equal(http.isAmbiguous(c), true, `${c} is ambiguous`);
for (const c of ["unauthorized", "forbidden", "not_found", "conflict", "validation", "rate_limited"]) assert.equal(http.isAmbiguous(c), false, `${c} is definite`);
ok("ambiguous vs definite failure classification (ambiguous is never re-POSTed)");

// ============================================================
// SAFETY — key never leaks, adoption never by title
// ============================================================
const LEAK = "kx_live_SUPERSECRET_9f8a7b6c";
for (const impl of [
  async () => mkRes(401, { message: "invalid", key: LEAK }),
  async () => mkRes(422, { errors: { details: { debug: [LEAK] } } }),
  async () => { throw new Error(LEAK); },
]) {
  const r1 = await api.createChannexRoomType({ apiKey: LEAK, baseUrl: STAGING, payload: { room_type: {} }, fetchImpl: impl });
  const r2 = await api.listChannexRoomTypes({ apiKey: LEAK, baseUrl: STAGING, propertyId: PROP, fetchImpl: impl });
  const r3 = await api.getChannexRoomType({ apiKey: LEAK, baseUrl: STAGING, id: "x", fetchImpl: impl });
  for (const r of [r1, r2, r3]) assert.ok(!JSON.stringify(r).includes(LEAK), "api-key / upstream body never leaks into a returned result");
}
ok("the api-key and upstream bodies never reach a returned DTO or error");

// an external room type with a MATCHING TITLE is still 'unmapped' — no auto-adoption
const external = [{ id: "ext-1", title: "חדר 926 - סטודיו", countOfRooms: 1, occAdults: 2, occChildren: 2, occInfants: 1 }];
const withExternal = sync.buildSyncPlan({ rooms, mappings: [], externalRoomTypes: external, roomCategories: 3 });
assert.equal(withExternal.externalUnmapped.length, 1, "an identical title does NOT adopt automatically");
assert.equal(withExternal.summary.externalUnmapped, 1);
assert.equal(withExternal.rows.find((r) => r.roomNumber === "926").status, "ready", "the local room stays unmapped");
assert.equal(withExternal.rows.find((r) => r.roomNumber === "926").channexRoomTypeId, null);
ok("a title-identical external room type is never adopted automatically");

// an existing local mapping removes the room from the creation set
const mapped = sync.buildSyncPlan({
  rooms,
  mappings: [{ room_id: "room-926", channex_room_type_id: "ext-1", channex_title: "חדר 926 - סטודיו", status: "mapped", method: "created", external_state: "ok", last_verified_at: "2026-07-09T00:00:00Z", last_error: null }],
  externalRoomTypes: external,
  roomCategories: 3,
});
assert.equal(mapped.summary.mappedRooms, 1);
assert.equal(mapped.summary.validReady, 12, "a mapped room is never re-created");
assert.equal(mapped.summary.unmappedRooms, 12);
assert.equal(mapped.externalUnmapped.length, 0, "the external room type is now accounted for");
assert.equal(mapped.rows.find((r) => r.roomNumber === "926").creatable, false, "existing mapping blocks the POST");
ok("an existing local mapping blocks re-creation; partial resume targets only the remaining rooms");

// ambiguous / in-flight rooms are NOT retried automatically
for (const st of ["creating", "reconciliation_required"]) {
  const p = sync.buildSyncPlan({
    rooms,
    mappings: [{ room_id: "room-926", channex_room_type_id: null, channex_title: null, status: st, method: null, external_state: null, last_verified_at: null, last_error: null }],
    externalRoomTypes: [],
    roomCategories: 3,
  });
  const row = p.rows.find((r) => r.roomNumber === "926");
  assert.equal(row.creatable, false, `${st} room is never a creation candidate`);
  assert.equal(p.summary.reconciliationRequired >= 1, true);
}
// a DEFINITELY failed room IS retryable
const failedPlan = sync.buildSyncPlan({
  rooms,
  mappings: [{ room_id: "room-926", channex_room_type_id: null, channex_title: null, status: "failed", method: null, external_state: null, last_verified_at: null, last_error: "422" }],
  externalRoomTypes: [],
  roomCategories: 3,
});
assert.equal(failedPlan.rows.find((r) => r.roomNumber === "926").creatable, true, "a definite failure is retryable");
assert.equal(failedPlan.summary.reconciliationRequired, 0);
ok("ambiguous timeouts are never blindly retried; definite failures are resumable");

// adopted + inaccessible statuses
const adoptedPlan = sync.buildSyncPlan({
  rooms,
  mappings: [
    { room_id: "room-926", channex_room_type_id: "e1", channex_title: "t", status: "mapped", method: "adopted", external_state: "ok", last_verified_at: null, last_error: null },
    { room_id: "room-1006", channex_room_type_id: "e2", channex_title: "t", status: "mapped", method: "created", external_state: "inaccessible", last_verified_at: null, last_error: null },
  ],
  externalRoomTypes: [{ id: "e1", title: "t", countOfRooms: 1, occAdults: 2, occChildren: 0, occInfants: 0 }],
  roomCategories: 3,
});
assert.equal(adoptedPlan.rows.find((r) => r.roomNumber === "926").status, "adopted");
assert.equal(adoptedPlan.rows.find((r) => r.roomNumber === "1006").status, "inaccessible");
assert.equal(adoptedPlan.externalUnmapped.length, 0, "a mapped-but-inaccessible id is still 'accounted for'");
// an inaccessible room HOLDS an external id → it counts as MAPPED, not unmapped
assert.equal(adoptedPlan.summary.mappedRooms, 2, "adopted + inaccessible both count as mapped (they hold an external id)");
assert.equal(adoptedPlan.summary.unmappedRooms, 11, "an inaccessible-but-mapped room is not miscounted as unmapped");
ok("adopted / inaccessible / mapped statuses render distinctly and count honestly");

// reconciliation counting survives a room being deactivated after it got stuck
const deactivatedStuck = sync.buildSyncPlan({
  rooms: [mkRoom(PROD_ROOMS[0], { is_active: false }), ...rooms.slice(1)],
  mappings: [{ room_id: "room-926", channex_room_type_id: null, channex_title: null, status: "reconciliation_required", method: null, external_state: null, last_verified_at: null, last_error: null }],
  externalRoomTypes: [],
  roomCategories: 3,
});
assert.equal(deactivatedStuck.summary.reconciliationRequired, 1, "a stuck reconciliation is counted even if its room was deactivated (never a silent 'settled')");
ok("reconciliation counter reads the mapping status, not the display status");

// job dedup keys carry property + room + operation
const k = sync.roomTypeJobKey(PROP, "room-926");
assert.ok(k.includes(PROP) && k.includes("room-926") && k.includes("create"));
assert.notEqual(sync.roomTypeJobKey(PROP, "room-926"), sync.roomTypeJobKey(PROP, "room-1006"));
assert.notEqual(sync.roomTypeJobKey("other-prop", "room-926"), k, "a property remap cannot collide with old job keys");
assert.ok(sync.roomTypeSyncJobKey(PROP).includes(PROP));
ok("per-room deduplication keys include property + room + operation");

// verification drift
const expected = { title: "חדר 926 - סטודיו", occ: r926 };
assert.deepEqual(sync.verifyExternalRoomType(expected, { id: "e", title: "חדר 926 - סטודיו", countOfRooms: 1, occAdults: 2, occChildren: 2, occInfants: 1 }), [], "matching entity → no drift");
const drift = sync.verifyExternalRoomType(expected, { id: "e", title: "Other", countOfRooms: 3, occAdults: 9, occChildren: 2, occInfants: 1 });
assert.deepEqual(drift.map((d) => d.field).sort(), ["count_of_rooms", "occ_adults", "title"]);
assert.deepEqual(sync.verifyExternalRoomType(expected, { id: "e", title: null, countOfRooms: null, occAdults: null, occChildren: null, occInfants: null }), [], "fields the API omits are not reported as drift");
ok("verification reports title / count_of_rooms / occupancy drift without mutating anything");

// ============================================================
// SCOPE GUARD — source level
// ============================================================
const clientSrc = readFileSync("src/lib/channel/channex-room-types.ts", "utf8");
for (const forbidden of ["/rate_plans", "/availability", "/restrictions", "/webhooks", "/bookings", "/ari", "/properties/"]) {
  assert.ok(!clientSrc.includes(forbidden), `room-types client must not reference ${forbidden}`);
}
assert.ok(!/method:\s*"DELETE"/.test(clientSrc), "DELETE /room_types is forbidden in this milestone");
assert.ok(!/method:\s*"PUT"/.test(clientSrc), "PUT /room_types is not used in this milestone");
assert.ok(clientSrc.includes("/room_types"), "the client targets /room_types");

const adminSrc = readFileSync("src/lib/channel/room-type-admin.ts", "utf8");
assert.ok(/requireChannelAdmin\(\)/.test(adminSrc), "actions gate on the channel admin guard");
const exported = [...adminSrc.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
assert.deepEqual(
  exported.sort(),
  ["adoptChannexRoomTypeAction", "getChannexRoomSyncContextAction", "previewChannexRoomTypeSyncAction", "refreshChannexRoomTypesAction", "startChannexRoomTypeSyncAction"],
  "exactly the five intended server actions are exported",
);
for (const fn of exported) {
  const body = adminSrc.slice(adminSrc.indexOf(`export async function ${fn}`), adminSrc.indexOf("export async function", adminSrc.indexOf(`export async function ${fn}`) + 10) || undefined);
  assert.ok(body.includes("requireChannelAdmin()"), `${fn} enforces super_admin server-side`);
}
// creation happens in exactly ONE action
assert.equal((adminSrc.match(/createChannexRoomType\(/g) ?? []).length, 1, "exactly one call site creates an external room type");
const startIdx = adminSrc.indexOf("export async function startChannexRoomTypeSyncAction");
assert.ok(adminSrc.indexOf("createChannexRoomType(") > startIdx, "the only creation call lives inside startChannexRoomTypeSyncAction");
// the read-only context action must never touch the network
const ctxBody = adminSrc.slice(adminSrc.indexOf("export async function getChannexRoomSyncContextAction"), adminSrc.indexOf("async function isRunActive"));
for (const netFn of ["createChannexRoomType", "listChannexRoomTypes", "getChannexRoomType"])
  assert.ok(!ctxBody.includes(`${netFn}(`), `page-load context must not call ${netFn}`);
// Forbidden surfaces in EXECUTABLE code (comments describing what we do not do
// are fine — they are the point). Strip comments, then scan.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const adminCode = stripComments(adminSrc);
for (const forbidden of ["rate_plan", "RatePlan", "availability", "restriction", "webhook", "expedia", "booking.com"])
  assert.ok(!adminCode.toLowerCase().includes(forbidden.toLowerCase()), `admin code must not reference ${forbidden}`);
assert.ok(!/pushAvailability|pushRates|pushRestrictions|sync_availability|sync_rates|sync_ari_range|full_sync/.test(adminCode), "no ARI / full-sync job is ever enqueued here");
assert.ok(!/method:\s*"DELETE"|DELETE FROM/.test(adminCode), "this module never deletes anything");
assert.ok(!/UPDATE guesthub\.rooms|INSERT INTO guesthub\.rooms/.test(adminCode), "no GuestHub room write");
assert.ok(!/UPDATE guesthub\.room_types|INSERT INTO guesthub\.room_types/.test(adminCode), "no GuestHub room-category write");
assert.ok(!/INSERT INTO guesthub\.reservations|UPDATE guesthub\.reservations/.test(adminCode), "no reservation write");
assert.ok(!/room_closures/.test(adminCode), "no room-closure write");
assert.ok(!/UPDATE guesthub\.channel_connections/.test(adminCode), "the mapped Channex property is never rewritten here");
// the api-key never reaches an audit payload
for (const m of adminCode.matchAll(/writeAudit\(actor, \{[\s\S]{0,900}?\}\)/g))
  assert.ok(!/apiKey|api_key|ciphertext|secret/i.test(m[0]), "no credential in an audit payload");
ok("scope guard: only /room_types GET+POST, one creation call site, no ARI/rate/room/reservation/property writes");

// ============================================================
// DURABILITY GUARDS — the concurrency fixes must stay in place (source-level)
// ============================================================
// a stranded item job must be reaped so a crashed room is never permanently locked
assert.ok(
  /idempotency_key = \$\{roomTypeJobKey\([\s\S]{0,400}status IN \('queued','processing','retry_wait'\)[\s\S]{0,200}COALESCE\(locked_at, created_at\) < now\(\) - make_interval/.test(adminSrc),
  "reserve reaps a stale create_room_type item job before enqueue (no permanent room lock)",
);
// the success-path audit must live OUTSIDE the try that guards the mapping write,
// so an audit failure can never downgrade a committed 'mapped' room
const successIdx = adminSrc.indexOf("(c2) the ONE external write");
const catchIdx = adminSrc.indexOf('catch (dbErr)', successIdx);
const createdIncIdx = adminSrc.indexOf("run.created++", catchIdx); // the surviving one
assert.ok(createdIncIdx > catchIdx, "run.created++ / audit happen AFTER the catch, never inside the mapping-write try");
assert.ok(/committed: the room is genuinely mapped/.test(adminSrc), "success is locked in before the best-effort audit");
assert.ok(/catch \(auditErr\)/.test(adminSrc), "a post-commit audit failure is swallowed, never reclassified");
// the parent job is settled on any mid-run throw (no stranded 'processing' parent)
assert.ok(/let parentJobId: string \| null = null/.test(adminSrc), "parentJobId is hoisted for the catch");
assert.ok(/if \(parentJobId\) \{[\s\S]{0,300}settleJobFailed\(parentJobId/.test(adminSrc), "the top-level catch settles the parent job");
// adopt fails CLOSED on an unknown external owner
assert.ok(
  /got\.roomType\.propertyId !== ready\.propertyId\)\s*\n\s*return \{ success: false/.test(adminSrc),
  "adopt rejects a null/mismatched external property_id (fail closed)",
);
assert.ok(!/got\.roomType\.propertyId &&/.test(adminSrc), "the old fail-open '&&' ownership check is gone");
ok("durability guards: item-job reaper, audit-outside-try, parent settled on throw, adopt fails closed");

console.log(`check-channex-room-types: ${n} groups, all assertions passed ✓`);
