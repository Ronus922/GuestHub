// Runnable checks for the Channex property-mapping logic (D60), same pattern as
// check-channex-connection.mjs: compile the PURE modules with tsc, import them,
// assert. Covers profile resolution (canonical reuse, no fabrication), readiness,
// the create payload (§6 incl. min_stay_type=both), numeric room-preview sort,
// the properties client's response mapping + status categories, no-key-leak,
// staging/production isolation, and a source-level scope guard (the client only
// touches /properties — never room_types/rate_plans/webhooks/bookings/ARI).
// Usage: node scripts/check-channex-properties.mjs
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const out = mkdtempSync(join(tmpdir(), "channex-prop-"));
execSync(
  `pnpm exec tsc src/lib/channel/channex-properties.ts src/lib/channel/property-profile.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const api = require(join(out, "channex-properties.js"));
const prof = require(join(out, "property-profile.js"));

const STAGING = "https://staging.channex.io/api/v1";
const PROD = "https://app.channex.io/api/v1";
const mkRes = (status, body) => ({ status, json: async () => body });

// ============================================================
// property-profile — canonical reuse, no fabrication
// ============================================================
const tenant = { tenantId: "t1", name: "מגדל הים", currency: "ILS", timezone: "Asia/Jerusalem" };

// D80 §1: tenants.name is NEVER a title source. With no canonical Business
// Profile name and no explicit override the title is null and creation is
// blocked (canCreate=false + MISSING_PROPERTY_NAME_MSG in the action).
const p0 = prof.resolveChannexProfile(tenant, null);
assert.equal(p0.currency, "ILS", "currency reused from canonical tenant");
assert.equal(p0.timezone, "Asia/Jerusalem", "timezone reused from canonical tenant");
assert.equal(p0.title, null, "no canonical name → title null, tenants.name NEVER used");
assert.equal(p0.country, null, "missing country is NOT fabricated");
assert.equal(p0.city, null, "missing city is NOT fabricated");
assert.equal(p0.propertyType, "apartment", "property_type defaults to apartment");
assert.equal(prof.computeReadiness(p0).canCreate, false, "no canonical name → property creation blocked");
assert.ok(
  typeof prof.MISSING_PROPERTY_NAME_MSG === "string" &&
    prof.MISSING_PROPERTY_NAME_MSG.includes("שם הנכס או שם העסק"),
  "blocking message names the missing Business Profile fields",
);

const pCanon = prof.resolveChannexProfile(tenant, null, "מלון הדקל");
assert.equal(pCanon.title, "מלון הדקל (Staging)", "canonical Business Profile propertyName/businessName drives the title");
assert.ok(!pCanon.title.includes(tenant.name), "internal tenants.name label never leaks into the title");
const pBlank = prof.resolveChannexProfile(tenant, null, "   ");
assert.equal(pBlank.title, null, "blank canonical name is treated as missing, never replaced by tenants.name");

const p1 = prof.resolveChannexProfile(tenant, {
  title: "Sea Tower - GuestHub Staging",
  country: "il",
  city: "Tel Aviv",
  latitude: 32.08,
  longitude: 34.78,
  email: "  ",
});
assert.equal(p1.title, "Sea Tower - GuestHub Staging", "override title honored");
assert.equal(p1.city, "Tel Aviv", "override city honored");
assert.equal(p1.latitude, 32.08, "override latitude honored");
assert.equal(p1.email, null, "blank override is treated as missing, not empty string");
// canonical values can NEVER be overwritten by overrides
const p2 = prof.resolveChannexProfile(tenant, { currency: "USD", timezone: "UTC" });
assert.equal(p2.currency, "ILS", "override cannot overwrite canonical currency");
assert.equal(p2.timezone, "Asia/Jerusalem", "override cannot overwrite canonical timezone");

// ============================================================
// readiness
// ============================================================
const r0 = prof.computeReadiness(pCanon);
assert.equal(r0.canCreate, true, "canonical title+currency present → can create");
assert.equal(r0.liveReady, false, "missing contact/address → not live-ready");
const rFull = prof.computeReadiness(
  prof.resolveChannexProfile(tenant, {
    country: "IL", city: "Tel Aviv", address: "Rothschild 1", zipCode: "6688101",
    email: "info@example.com", phone: "+972500000000", latitude: 32, longitude: 34,
  }, "מלון הדקל"),
);
assert.equal(rFull.liveReady, true, "all live fields present → live-ready");
assert.equal(prof.computeReadiness({ ...pCanon, title: "", currency: "" }).canCreate, false, "no title/currency → cannot create");

// ============================================================
// create payload (§6)
// ============================================================
const payload = prof.buildCreatePropertyPayload(p1).property;
assert.equal(payload.title, "Sea Tower - GuestHub Staging");
assert.equal(payload.currency, "ILS");
assert.equal(payload.property_type, "apartment");
assert.equal(payload.min_stay_type, "both", "min_stay_type=both (GuestHub stores arrival AND through independently)");
assert.equal(payload.state_length, 500);
assert.equal(payload.cut_off_days, 0);
assert.equal(payload.cut_off_time, "00:00:00");
assert.equal(payload.max_day_advance, null);
assert.equal(payload.allow_availability_autoupdate_on_modification, false);
assert.equal(payload.allow_availability_autoupdate_on_cancellation, false);
assert.equal(payload.country, "il");
assert.equal(payload.latitude, "32.08", "latitude serialized as string");
assert.ok(!("email" in payload), "blank/absent optional field is omitted, not sent empty");
const payloadMin = prof.buildCreatePropertyPayload(pCanon).property;
assert.equal(payloadMin.title, "מלון הדקל (Staging)", "minimal payload titled from the canonical name only");
assert.ok(!("country" in payloadMin) && !("city" in payloadMin), "absent optional fields omitted from minimal payload");

// ============================================================
// room preview — numeric-first ordering
// ============================================================
const rooms = [
  { room_number: "10" }, { room_number: "2" }, { room_number: "10A" },
  { room_number: "b" }, { room_number: "1" },
];
const sorted = prof.sortRoomsForPreview(rooms).map((r) => r.room_number);
assert.deepEqual(sorted, ["1", "2", "10", "10A", "b"], "rooms sort numerically then lexically");
assert.equal(rooms[0].room_number, "10", "sort does not mutate the input array");

// ============================================================
// channex-properties client — pure extractors
// ============================================================
assert.deepEqual(
  api.extractPropertyOptions({ data: [{ id: "a", title: "A", currency: "ILS" }, { id: "b" }] }),
  [{ id: "a", title: "A", currency: "ILS" }, { id: "b", title: null, currency: null }],
);
assert.deepEqual(api.extractPropertyOptions({ nope: 1 }), [], "non-array data → empty list, no throw");
assert.deepEqual(api.extractPropertyOptions([{ id: "x", attributes: { title: "X", currency: "USD" } }]), [{ id: "x", title: "X", currency: "USD" }]);
const det = api.extractPropertyDetail({ data: { id: "p1", attributes: { title: "T", currency: "ILS", country: "IL", is_active: true, room_types_count: 0 } } });
assert.equal(det.id, "p1");
assert.equal(det.isActive, true);
assert.equal(det.roomTypeCount, 0);
assert.equal(api.extractPropertyDetail({ data: {} }), null, "no id → null");

assert.equal(api.mapErrorStatus(401), "unauthorized");
assert.equal(api.mapErrorStatus(403), "forbidden");
assert.equal(api.mapErrorStatus(404), "not_found");
assert.equal(api.mapErrorStatus(409), "conflict");
assert.equal(api.mapErrorStatus(422), "validation");
assert.equal(api.mapErrorStatus(429), "rate_limited");
assert.equal(api.mapErrorStatus(500), "server_error");
assert.equal(api.mapErrorStatus(418), "bad_response");

// ============================================================
// client operations with an injected fetch (no live socket)
// ============================================================
const cap = {};
const fetchList = async (url, init) => { cap.url = url; cap.headers = init.headers; return mkRes(200, { data: [{ id: "p1", title: "A", currency: "ILS" }] }); };
let res = await api.listChannexProperties({ apiKey: "SECRET-123", baseUrl: STAGING, fetchImpl: fetchList });
assert.equal(res.ok, true);
assert.equal(res.properties.length, 1);
assert.equal(cap.url, `${STAGING}/properties/options`, "list hits the staging options endpoint");
assert.equal(cap.headers["user-api-key"], "SECRET-123");

// staging/production isolation
await api.listChannexProperties({ apiKey: "x", baseUrl: PROD, fetchImpl: fetchList });
assert.equal(cap.url, `${PROD}/properties/options`, "production baseUrl → production URL");
assert.notEqual(STAGING, PROD, "staging and production base URLs are distinct");

// get
res = await api.getChannexProperty({ apiKey: "x", baseUrl: STAGING, id: "p1", fetchImpl: async (u) => { cap.url = u; return mkRes(200, { data: { id: "p1", attributes: { title: "T", currency: "ILS" } } }); } });
assert.equal(res.ok, true);
assert.equal(cap.url, `${STAGING}/properties/p1`, "get hits /properties/:id");

// create — captures method, content-type, body
const capCreate = {};
res = await api.createChannexProperty({
  apiKey: "x", baseUrl: STAGING, payload: prof.buildCreatePropertyPayload(p1),
  fetchImpl: async (u, init) => { capCreate.method = init.method; capCreate.ct = init.headers["Content-Type"]; capCreate.body = init.body; return mkRes(201, { data: { id: "new-1", attributes: { title: "Sea Tower - GuestHub Staging", currency: "ILS" } } }); },
});
assert.equal(res.ok, true);
assert.equal(res.property.id, "new-1", "created property id surfaced");
assert.equal(capCreate.method, "POST");
assert.equal(capCreate.ct, "application/json", "writes send JSON content-type");
assert.equal(JSON.parse(capCreate.body).property.min_stay_type, "both", "create body carries the built payload");

// error status mapping through the client
res = await api.createChannexProperty({ apiKey: "x", baseUrl: STAGING, payload: {}, fetchImpl: async () => mkRes(422, { errors: { title: ["blank"] } }) });
assert.equal(res.ok, false);
assert.equal(res.category, "validation", "422 → validation");
res = await api.getChannexProperty({ apiKey: "x", baseUrl: STAGING, id: "z", fetchImpl: async () => mkRes(404, {}) });
assert.equal(res.category, "not_found", "404 → not_found");

// timeout + network
res = await api.listChannexProperties({ apiKey: "x", baseUrl: STAGING, fetchImpl: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; } });
assert.equal(res.category, "timeout", "abort → timeout");
res = await api.listChannexProperties({ apiKey: "x", baseUrl: STAGING, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
assert.equal(res.category, "network_error", "throw → network_error");

// ============================================================
// detail extractor surfaces address/contact/geo (for the PUT preview diff)
// ============================================================
const detFull = api.extractPropertyDetail({
  data: { id: "p9", attributes: { title: "T", currency: "ILS", country: "IL", city: "TLV",
    address: "Rothschild 1", zip_code: "6688101", email: "a@b.co", phone: "+972500000000",
    website: "https://x.co", latitude: 32.06, longitude: 34.77, property_type: "apartment" } },
});
assert.equal(detFull.address, "Rothschild 1", "address extracted");
assert.equal(detFull.zipCode, "6688101", "zip extracted");
assert.equal(detFull.email, "a@b.co", "email extracted");
assert.equal(detFull.phone, "+972500000000", "phone extracted");
assert.equal(detFull.website, "https://x.co", "website extracted");
assert.equal(detFull.latitude, "32.06", "numeric latitude → string");
assert.equal(detFull.longitude, "34.77", "numeric longitude → string");

// ============================================================
// updateChannexProperty — PUT to the SAME id, never POST/create
// ============================================================
const capPut = {};
res = await api.updateChannexProperty({
  apiKey: "x", baseUrl: STAGING, id: "keep-me-123",
  payload: { property: { title: "נכס (Staging)", currency: "ILS" } },
  fetchImpl: async (u, init) => { capPut.url = u; capPut.method = init.method; capPut.body = init.body; return mkRes(200, { data: { id: "keep-me-123", attributes: { title: "נכס (Staging)", currency: "ILS" } } }); },
});
assert.equal(res.ok, true, "PUT ok");
assert.equal(capPut.method, "PUT", "update uses PUT, not POST");
assert.equal(capPut.url, `${STAGING}/properties/keep-me-123`, "PUT targets the SAME property id");
assert.equal(res.property.id, "keep-me-123", "same id preserved in result");
assert.equal(JSON.parse(capPut.body).property.title, "נכס (Staging)", "PUT body carries the derived title");
res = await api.updateChannexProperty({ apiKey: "x", baseUrl: STAGING, id: "z", payload: {}, fetchImpl: async () => mkRes(422, { errors: {} }) });
assert.equal(res.category, "validation", "422 on update → validation");

// ============================================================
// the api-key / upstream body NEVER leaks into a returned result
// ============================================================
const LEAK = "kx_live_SUPERSECRET_9f8a7b6c";
for (const impl of [
  async () => mkRes(401, { message: "invalid", key: LEAK }),
  async () => mkRes(422, { errors: { debug: LEAK } }),
  async () => { throw new Error(LEAK); },
]) {
  const r = await api.createChannexProperty({ apiKey: LEAK, baseUrl: STAGING, payload: {}, fetchImpl: impl });
  assert.ok(!JSON.stringify(r).includes(LEAK), "api-key / upstream body never leaks into the returned result");
}

// ============================================================
// scope guard — the properties client only touches /properties. It must never
// call room_types / rate_plans / webhooks / bookings / availability / restrictions.
// ============================================================
const src = readFileSync("src/lib/channel/channex-properties.ts", "utf8");
for (const forbidden of ["/room_types", "/rate_plans", "/webhooks", "/bookings", "/availability", "/restrictions", "/ari"]) {
  assert.ok(!src.includes(forbidden), `properties client must not reference ${forbidden}`);
}
assert.ok(src.includes("/properties"), "properties client targets /properties");

// D80 §1 source guard — the profile's title expression must never read the
// internal tenants.name label (only the canonical name / explicit override).
const profileSrc = readFileSync("src/lib/channel/property-profile.ts", "utf8");
assert.ok(!/title:.*tenant\.name/.test(profileSrc), "resolved title never derives from tenant.name");

console.log("check-channex-properties: all assertions passed ✓");
