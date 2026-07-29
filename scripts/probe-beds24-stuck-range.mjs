#!/usr/bin/env node
// ============================================================
// probe-beds24-stuck-range — ONE-OFF DIAGNOSTIC. Not a guard, not wired into
// package.json, not called by the app. Delete it once the question is answered.
//
// WHY IT EXISTS. 28 dirty ranges sat in `failed` with the message
// "הנתונים נדחו (422) — יש להשלים או לתקן שדות חובה" and nothing else: the
// upstream body — the one thing that says WHAT Beds24 objected to — was parsed,
// reduced to a category, and thrown away. This replays exactly ONE of those
// ranges and prints the provider's answer VERBATIM, before any parsing or
// mapping, because the raw body is the ground truth this whole investigation
// lost.
//
// WHAT IT DOES TO PRODUCTION. It issues ONE POST /inventory/rooms/calendar for
// ONE room over that room's stuck window — the same bytes the real drain would
// send (same projection, same builder, same room-ceiling read). Inside the
// published horizon those are values already live upstream; beyond it they are
// the values we are trying to publish and cannot. Cost: 1 credit.
//
// WHAT IT NEVER DOES: no INSERT/UPDATE/DELETE of any kind, no drain, no
// evidence row, no attempts reset, no touch of the other 27 rows, no token in
// the output. It refuses to run unless BEDS24_REPLAY_OK=1, and refuses to mint
// a token (minting is the one path that would write to channel_connections).
//
// Usage:
//   DATABASE_URL=… CHANNEL_SECRETS_KEY=… BEDS24_REPLAY_OK=1 \
//     node scripts/probe-beds24-stuck-range.mjs
// ============================================================
import { createRequire } from "node:module";
import Module from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

if (process.env.BEDS24_REPLAY_OK !== "1") {
  console.error("REFUSED: this script issues a REAL POST to Beds24. Set BEDS24_REPLAY_OK=1 to proceed.");
  process.exit(1);
}
for (const name of ["DATABASE_URL", "CHANNEL_SECRETS_KEY"]) {
  if (!process.env[name]) {
    console.error(`REFUSED: ${name} is not set (this script never hardcodes an environment).`);
    process.exit(1);
  }
}

// ---- the REAL worker graph, required the worker's own way ----
const OUT = join(ROOT, "dist", "worker");
const STUB = join(ROOT, "scripts", "server-only-stub.cjs");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return STUB;
  if (request.startsWith("@/")) return origResolve.call(this, join(OUT, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};
const req = createRequire(import.meta.url);
const { projectBeds24Ari } = req(join(OUT, "lib/channel/beds24-ari-projection.js"));
const { buildBeds24CalendarRequests } = req(join(OUT, "lib/channel/beds24-ari-payloads.js"));
const { loadBeds24RoomCeilings } = req(join(OUT, "lib/channel/beds24-room-ceilings.js"));
const { getBeds24AccessToken } = req(join(OUT, "lib/channel/beds24-token.js"));
const { beds24BaseUrl } = req(join(OUT, "lib/channel/config.js"));

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, onnotice: () => {} });

// ---- 1. pick ONE stuck range, deterministically ----
// Every stuck row shares the same window, so the tie-break has to be explicit
// and printed rather than left to whatever the planner returns first. `rates`
// and `restrictions` build the SAME calendar payload (the builder does not read
// `kind`), so preferring one of them is a choice between equals.
const stuck = await sql`
  SELECT d.id, d.tenant_id, d.connection_id, d.room_id, d.kind,
         d.date_from::text AS date_from, d.date_to::text AS date_to,
         d.attempts, m.beds24_room_id, m.beds24_property_id, m.local_rate_plan_id
  FROM guesthub.channel_dirty_ranges d
  JOIN guesthub.channel_beds24_room_mappings m
    ON m.room_id = d.room_id AND m.connection_id = d.connection_id
   AND m.status = 'mapped' AND m.local_rate_plan_id IS NOT NULL
  WHERE d.status = 'failed'
  ORDER BY d.date_to DESC, (d.kind = 'rates') DESC, m.beds24_room_id ASC`;

if (stuck.length === 0) {
  console.error("nothing to replay: no failed dirty range with a pushable Beds24 mapping");
  await sql.end();
  process.exit(1);
}
const row = stuck[0];
const tied = stuck.filter((r) => r.date_to === row.date_to).length;
console.log(`\nstuck rows with a pushable mapping: ${stuck.length}`);
console.log(`furthest date_to: ${row.date_to} — ${tied} row(s) tied there`);
console.log(`selected: range ${row.id} · room ${row.room_id} · beds24RoomId ${row.beds24_room_id}`
  + ` · kind ${row.kind} · window ${row.date_from} → ${row.date_to} (exclusive) · attempts ${row.attempts}`);
console.log("tie-break: date_to DESC, then kind='rates', then beds24RoomId ASC");

// ---- 2. a token we may NOT mint ----
// getBeds24AccessToken reuses a cached token with no DB write when it is valid
// for more than its reuse margin, and writes a fresh one to channel_connections
// otherwise. Refuse in the second case rather than write.
const [conn] = await sql`
  SELECT id, tenant_id, api_key_ciphertext, access_token_ciphertext,
         access_token_expires_at, environment,
         (access_token_expires_at - now() > interval '10 minutes') AS token_reusable
  FROM guesthub.channel_connections WHERE id = ${row.connection_id}`;
if (!conn?.token_reusable) {
  console.error("REFUSED: the cached access token is not comfortably valid — minting one would WRITE to channel_connections.");
  await sql.end();
  process.exit(1);
}
const access = await getBeds24AccessToken(sql, conn);
if (!access.ok) {
  console.error(`token unavailable: ${access.error}`);
  await sql.end();
  process.exit(1);
}

// ---- 3. rebuild the EXACT payload the drain would send ----
// The room-ceiling read is part of it: without it every local NULL maxStay is
// omitted instead of carrying the room's own ceiling, and the payload silently
// stops being the one that failed.
const creds = { token: access.token, baseUrl: beds24BaseUrl() };
const ceilings = await loadBeds24RoomCeilings(creds, [row.beds24_property_id]);
console.log(`\nroom ceiling read: ${ceilings.size} room(s); this room → ${ceilings.get(row.beds24_room_id) ?? "unknown (maxStay will be omitted)"}`);

const mapping = {
  roomId: row.room_id,
  beds24PropertyId: row.beds24_property_id,
  beds24RoomId: row.beds24_room_id,
  localRatePlanId: row.local_rate_plan_id,
  maxStayCeiling: ceilings.get(row.beds24_room_id) ?? null,
};
const projection = await projectBeds24Ari(sql, {
  tenantId: row.tenant_id,
  connectionId: row.connection_id,
  dateFrom: row.date_from,
  dateTo: row.date_to,
  roomIds: [row.room_id],
});
const built = buildBeds24CalendarRequests(projection, [mapping]);
console.log(`builder: ${built.requests.length} request(s), unmapped=${built.unmapped.length}, invalidRoomIds=${built.invalidRoomIds.length}`);
if (built.requests.length === 0) {
  console.error("nothing to send: the builder produced no request for this range");
  await sql.end();
  process.exit(1);
}
if (built.requests.length > 1) console.log("NOTE: more than one request was built — sending #0 only");

const payload = built.requests[0];
console.log("\n===== PAYLOAD SENT =====");
console.log(JSON.stringify(payload, null, 2));

// ---- 4. ONE POST, raw ----
// Raw fetch, not beds24Request: that helper hands back a PARSED body and the
// verbatim text is exactly what was missing.
const res = await fetch(`${creds.baseUrl}/inventory/rooms/calendar`, {
  method: "POST",
  headers: { token: creds.token, Accept: "application/json", "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const rawBody = await res.text();

console.log("\n===== RAW RESPONSE =====");
console.log(`HTTP ${res.status} ${res.statusText}`);
console.log(`x-request-cost: ${res.headers.get("x-request-cost")}`);
console.log(`x-five-min-limit-remaining: ${res.headers.get("x-five-min-limit-remaining")}`);
console.log("--- body, verbatim, unparsed ---");
console.log(rawBody);
console.log("--- end of body ---");

await sql.end();
