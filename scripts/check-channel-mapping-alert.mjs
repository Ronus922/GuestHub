#!/usr/bin/env node
// check:channel-mapping-alert — a room that reaches no channel must SAY SO.
//
// WHY. Every layer of the Beds24 pipeline is gated on
// `channel_beds24_room_mappings … status = 'mapped'`, and none of them ever
// told anybody when the gate closed:
//   · `runBeds24InboundPull` returns at `mappings.size === 0` before importing
//     a single revision — one broken mapping can stop the whole pull;
//   · `loadBeds24InboundConnections` carries the SAME EXISTS filter ("review
//     W-1"), so a connection with nothing left mapped is not polled at all:
//     ensureInboundPullJobs skips it AND ensureReconcileJobs skips it. No job,
//     no failure, no dead letter, no error row. Silence by construction;
//   · outbound ARI is scoped to mapped rooms, so an unmapped room's
//     availability never leaves the building.
// Measured on production 2026-07-25: 14 of 16 rooms mapped, and room "1318" —
// a genuinely sold room carrying back-office reservations — had no live
// mapping and no surface anywhere in the product said so.
//
// TWO GROUPS, and the difference matters when this goes red.
//
//   GROUP A — BEHAVIOURAL. Read back from the DATABASE after driving the REAL
//   compiled worker modules: which alert rows exist, what they say, whether
//   they self-resolve, whether the operator's own query returns them. A red
//   here means an operator really would not be told that a sold room is
//   invisible to every channel. THIS GROUP DECIDES CORRECTNESS.
//
//   GROUP B — CONTRACT. Read back from the schema or the source shape. These
//   pin the arrangement that makes the behaviour reachable in production (the
//   job type the audit is scheduled under; the connection loader it is
//   scheduled from). A red here can mean the behaviour is still fine and only
//   the arrangement moved — each says so in its own failure message. It is a
//   CONTRACT BREACH, not a behaviour breach. Never weaken one to get green.
//
// NO PROVIDER TRAFFIC. The audit is pure DB — no Beds24 call, no credit. fetch
// is replaced by a throwing stub so that stays true.
//
// Usage: node scripts/check-channel-mapping-alert.mjs
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import Module from "node:module";
import { join } from "node:path";
import postgres from "postgres";

// A DEDICATED database on the test server (the shared `postgres` test DB is
// dropped and rebuilt by other checks mid-run). This one owns its schema,
// creates itself when absent and replays the migrations itself.
const ADMIN_URL =
  process.env.TEST_ADMIN_URL ||
  "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
const TEST_URL =
  process.env.TEST_DATABASE_URL ||
  "postgres://supabase_admin:guesthub_test_local@localhost:5433/guesthub_mapping_check";
for (const url of [ADMIN_URL, TEST_URL]) {
  for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
    if (url.includes(marker)) {
      console.error(`REFUSED: a check URL contains the production marker "${marker}"`);
      process.exit(1);
    }
  }
}
process.env.DATABASE_URL = TEST_URL;
process.env.CHANNEL_SECRETS_KEY = "check-channel-mapping-alert-key-0123456789";

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };
const ROOT = process.cwd();

execSync("pnpm exec tsc -p tsconfig.worker.json", { stdio: "pipe" });
const OUT = join(ROOT, "dist", "worker");
const STUB = join(ROOT, "scripts", "server-only-stub.cjs");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return STUB;
  if (request.startsWith("@/")) return origResolve.call(this, join(OUT, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};
const req = createRequire(import.meta.url);
const { encryptSecret } = req(join(OUT, "lib/channel/crypto.js"));
const { loadBeds24InboundConnections } = req(join(OUT, "lib/channel/beds24-booking-import.js"));

// The module under test may not exist at all on the tree being measured — that
// is precisely the state experiment A puts this guard in. Its absence must
// produce the BEHAVIOURAL red below ("nothing reported the unmapped room"),
// not a require crash that says nothing about the defect.
let audit = null;
let auditLoadError = null;
try {
  audit = req(join(OUT, "lib/channel/mapping-health.js"));
} catch (e) {
  auditLoadError = e.message;
}

globalThis.fetch = async (url) => {
  throw new Error(`the mapping audit must make NO provider call — attempted ${url}`);
};

const admin = postgres(ADMIN_URL, { prepare: false, max: 1, onnotice: () => {} });
const DB_NAME = new URL(TEST_URL).pathname.slice(1);

const T = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CONN = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const R_OK = "cccccccc-3333-4333-8333-cccccccccc01"; // 926   — mapped, healthy
const R_1318 = "cccccccc-3333-4333-8333-cccccccccc02"; // 1318 — sold, NOT mapped
const R_PARK = "cccccccc-3333-4333-8333-cccccccccc03"; // 1000 — חניה זמנית, excluded
const R_QUAR = "cccccccc-3333-4333-8333-cccccccccc04"; // 1130 — mapping quarantined
const R_OFF = "cccccccc-3333-4333-8333-cccccccccc05"; // 9999 — inactive room

let sql;

async function ensureDatabase() {
  const [row] = await admin`SELECT 1 AS x FROM pg_database WHERE datname = ${DB_NAME}`;
  if (!row) await admin.unsafe(`CREATE DATABASE "${DB_NAME}"`);
  await admin.end();
  sql = postgres(TEST_URL, { prepare: false, max: 1, onnotice: () => {} });
  const [{ c }] = await sql`
    SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema = 'guesthub'`;
  if (c > 40) return c;
  const dir = join(ROOT, "db", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await sql.unsafe(readFileSync(join(dir, f), "utf8"));
  }
  const [{ c: after }] = await sql`
    SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema = 'guesthub'`;
  return after;
}

const conn = () => ({ id: CONN, tenant_id: T });

async function sweep() {
  if (!audit) return null;
  return audit.runChannelMappingAudit(sql, conn());
}

/** Exactly the shape getChannelStatusAction reads for the /channels screen. */
const operatorSurface = () => sql`
  SELECT error_code, error_message, context
  FROM guesthub.channel_sync_errors
  WHERE tenant_id = ${T} AND resolved_at IS NULL
  ORDER BY created_at DESC LIMIT 10`;

const openAlerts = () => sql`
  SELECT error_code, error_message, resolved_at, context->>'room_number' AS room_number
  FROM guesthub.channel_sync_errors
  WHERE tenant_id = ${T} AND resolved_at IS NULL
  ORDER BY error_code`;

async function mapRoom(roomId, beds24RoomId, status) {
  await sql`
    INSERT INTO guesthub.channel_beds24_room_mappings
      (tenant_id, connection_id, room_id, beds24_property_id, beds24_room_id, status)
    VALUES (${T}, ${CONN}, ${roomId}, '342449', ${beds24RoomId}, ${status})
    ON CONFLICT (connection_id, room_id)
      DO UPDATE SET status = EXCLUDED.status`;
}

try {
  const tables = await ensureDatabase();
  console.log(`  · isolated schema ready on ${DB_NAME} (${tables} tables)`);
  if (auditLoadError) console.log(`  · mapping-health module NOT PRESENT on this tree`);

  // ---- the schema must be able to express deliberate non-distribution ----
  // Without it, "חניה זמנית" and "1318" are indistinguishable and any alert
  // either cries wolf over the parking pseudo-room or stays silent about a
  // sold one. This is a CONTRACT assertion (schema shape) placed first only
  // because every behavioural assertion below depends on the column existing.
  const [col] = await sql`
    SELECT 1 AS x FROM information_schema.columns
    WHERE table_schema = 'guesthub' AND table_name = 'rooms'
      AND column_name = 'channel_distribution_excluded'`;
  assert.ok(col,
    "CONTRACT BREACH: guesthub.rooms has no channel_distribution_excluded column " +
    "(db/migrations/057). Without an explicit intent flag the audit cannot tell a " +
    "deliberately-undistributed pseudo-room from a silently unmapped sold one, so it " +
    "must either cry wolf or stay quiet. Nothing below can be evaluated.");
  ok("CONTRACT · rooms.channel_distribution_excluded exists — intent is explicit, not inferred");

  // ================= fixture =================
  await sql`DELETE FROM guesthub.channel_sync_errors WHERE tenant_id = ${T}`;
  await sql`DELETE FROM guesthub.channel_sync_jobs WHERE tenant_id = ${T}`;
  await sql`DELETE FROM guesthub.channel_beds24_room_mappings WHERE tenant_id = ${T}`;
  await sql`DELETE FROM guesthub.rooms WHERE tenant_id = ${T}`;
  await sql`DELETE FROM guesthub.channel_connections WHERE tenant_id = ${T}`;
  await sql`DELETE FROM guesthub.tenants WHERE id = ${T}`;

  await sql`INSERT INTO guesthub.tenants (id, name, slug, timezone)
            VALUES (${T}, 'mapping-alert', 'mapping-alert', 'Asia/Jerusalem')`;
  await sql`
    INSERT INTO guesthub.channel_connections
      (id, tenant_id, provider, environment, state, is_active_provider,
       inbound_sync_enabled, outbound_sync_enabled, full_sync_required,
       api_key_ciphertext, access_token_ciphertext, access_token_expires_at)
    VALUES (${CONN}, ${T}, 'beds24', 'production', 'active', true,
            true, true, false,
            ${encryptSecret("refresh-token")}, ${encryptSecret("access-token")},
            now() + interval '20 hours')`;

  const room = (id, number, name, extra = {}) => sql`
    INSERT INTO guesthub.rooms
      (id, tenant_id, room_number, name, status, is_active, channel_distribution_excluded)
    VALUES (${id}, ${T}, ${number}, ${name},
            ${extra.status ?? "available"}, ${extra.isActive ?? true},
            ${extra.excluded ?? false})`;

  await room(R_OK, "926", "Large Studio with Sea View - 926");
  await room(R_1318, "1318", "1318 - One Bedroom Apartment");
  await room(R_PARK, "1000", "חניה זמנית", { excluded: true });
  await room(R_QUAR, "1130", "Studio Delux with Sea View - 1130");
  await room(R_OFF, "9999", "out of service", { isActive: false, status: "inactive" });

  await mapRoom(R_OK, "707100", "mapped");
  await mapRoom(R_QUAR, "707104", "quarantined");
  // 1318, the parking room and the inactive room carry NO mapping row at all —
  // production's exact shape.

  // ================= GROUP A — BEHAVIOURAL =================

  // ---- A1. the sold, unmapped room is reported ----
  const first = await sweep();
  const alerts = await openAlerts();
  const missing = alerts.filter((a) => a.error_code === "room_mapping_missing");

  assert.equal(missing.length, 1,
    `an active room with no Beds24 mapping must raise exactly one room_mapping_missing ` +
    `alert; found ${missing.length}. Nothing on this tree tells an operator that a sold ` +
    `room's availability reaches no channel — it just goes quiet.` +
    (auditLoadError ? ` (no mapping-health module on this tree: ${auditLoadError})` : ""));
  assert.equal(missing[0].room_number, "1318",
    `the alert must name the offending room; it named ${missing[0].room_number}`);
  assert.match(missing[0].error_message, /1318/,
    "the operator-visible message must carry the room number, not just the context json");
  ok(`unmapped sold room → room_mapping_missing naming 1318: "${missing[0].error_message.slice(0, 70)}…"`);

  // ---- A2. the parking pseudo-room does NOT cry wolf ----
  const wolf = alerts.filter((a) => a.room_number === "1000");
  assert.equal(wolf.length, 0,
    `"חניה זמנית" is marked channel_distribution_excluded — a deliberately ` +
    `undistributed room must never raise an alert, or the operator learns to ignore ` +
    `the panel. Raised: ${wolf.map((w) => w.error_code).join(", ")}`);
  ok("deliberately-not-distributed room (חניה זמנית) raises nothing — no wolf");

  // ---- A3. an out-of-service room raises nothing either ----
  const offAlerts = alerts.filter((a) => a.room_number === "9999");
  assert.equal(offAlerts.length, 0,
    `an inactive room is not expected to be distributed; alerting on it is noise. ` +
    `Raised: ${offAlerts.map((o) => o.error_code).join(", ")}`);
  ok("inactive room raises nothing");

  // ---- A4. a mapping row that exists but is not 'mapped' is a DIFFERENT defect ----
  const broken = alerts.filter((a) => a.error_code === "room_mapping_broken");
  assert.equal(broken.length, 1,
    `a mapping row in status 'quarantined' is invisible to loadRoomMappings exactly ` +
    `like a missing one, and must be reported — found ${broken.length}`);
  assert.equal(broken[0].room_number, "1130", "the broken-mapping alert names its room");
  assert.match(broken[0].error_message, /quarantined/,
    "the message must name the ACTUAL mapping status, or the operator cannot tell what to fix");
  ok(`non-'mapped' mapping row → room_mapping_broken naming its status ("quarantined")`);

  // ---- A5. it lands on the SAME surface D93 uses, not a second one ----
  const surface = await operatorSurface();
  assert.ok(surface.some((r) => r.error_code === "room_mapping_missing"),
    "the alert must be readable through the exact channel_sync_errors query " +
    "getChannelStatusAction runs for /channels — the mechanism D93 already established");
  ok(`alert visible on the existing /channels error surface (${surface.length} open rows)`);

  // ---- A6. an hourly sweep must not bury the operator ----
  const second = await sweep();
  const afterSecond = await openAlerts();
  assert.equal(afterSecond.length, alerts.length,
    `a repeat sweep must not duplicate open alerts (${alerts.length} → ${afterSecond.length}); ` +
    `the panel shows ten rows and an hourly append buries every other error within a day`);
  if (second) {
    assert.equal(second.raised, 0, "the second sweep raises nothing new");
  }
  ok(`repeat sweep is idempotent — still ${afterSecond.length} open alerts, 0 newly raised`);

  // ---- A7. the alert clears itself when the mapping is repaired ----
  await mapRoom(R_1318, "707101", "mapped");
  const third = await sweep();
  const afterFix = await openAlerts();
  assert.equal(afterFix.filter((a) => a.error_code === "room_mapping_missing").length, 0,
    "once the room is mapped the alert must be resolved, or the operator cannot tell " +
    "a fixed defect from a live one and stops reading the panel");
  const [resolved] = await sql`
    SELECT resolved_at FROM guesthub.channel_sync_errors
    WHERE tenant_id = ${T} AND error_code = 'room_mapping_missing'`;
  assert.ok(resolved?.resolved_at,
    "the row is resolved in place (resolved_at stamped), not deleted — history is kept");
  if (third) assert.equal(third.resolved, 1, "the sweep reports exactly one resolution");
  ok("repairing the mapping resolves the alert in place (resolved_at stamped, row kept)");

  // ---- A8. THE DARK PIPELINE: zero mapped rooms ----
  // This is the case nothing could report before: with no mapped room the
  // connection drops out of loadBeds24InboundConnections, so no pull job and no
  // reconcile job is ever enqueued for it — the pipeline goes dark in total
  // silence. The audit must reach it anyway.
  await sql`UPDATE guesthub.channel_beds24_room_mappings
            SET status = 'unmapped' WHERE tenant_id = ${T}`;
  await sweep();
  const dark = await openAlerts();

  const inboundVisible = (await loadBeds24InboundConnections(sql)).some((c) => c.id === CONN);
  assert.equal(inboundVisible, false,
    "precondition: with zero mapped rooms the existing inbound loader hides this " +
    "connection — that IS the silence being covered");
  const auditVisible = audit
    ? (await audit.loadChannelAuditConnections(sql)).some((c) => c.id === CONN)
    : false;
  assert.equal(auditVisible, true,
    "the audit's connection loader MUST still return a connection with zero mapped " +
    "rooms. Scheduling the sweep off loadBeds24InboundConnections would make it " +
    "silent in the one case it exists for.");
  ok("zero mapped rooms: hidden from the inbound loader, still visible to the audit loader");

  assert.ok(dark.some((a) => a.error_code === "channel_mappings_empty"),
    "a connection with zero mapped rooms is not 'n unmapped rooms' — it is a dark " +
    "pipeline: no pull job, no reconcile job, no cancellation ever imported. It must " +
    "raise its own alert.");
  const empty = dark.find((a) => a.error_code === "channel_mappings_empty");
  assert.match(empty.error_message, /Beds24/,
    "the dark-pipeline alert must say which connection stopped");
  ok(`zero mapped rooms → channel_mappings_empty: "${empty.error_message.slice(0, 70)}…"`);

  // ================= GROUP B — CONTRACT =================

  // ---- B1. the audit has its own durable job type ----
  const jobId = "dddddddd-4444-4444-8444-dddddddddddd";
  let jobTypeAccepted = true;
  try {
    await sql`
      INSERT INTO guesthub.channel_sync_jobs (id, tenant_id, connection_id, job_type)
      VALUES (${jobId}, ${T}, ${CONN}, 'audit_room_mappings')`;
  } catch {
    jobTypeAccepted = false;
  }
  assert.ok(jobTypeAccepted,
    "CONTRACT BREACH: channel_sync_jobs rejects job_type 'audit_room_mappings' " +
    "(db/migrations/057 widens the CHECK). The audit code may be perfectly correct and " +
    "still never run, because the worker cannot enqueue it.");
  ok("CONTRACT · channel_sync_jobs accepts job_type 'audit_room_mappings'");

  // ---- B2. the worker schedules it off the RIGHT loader ----
  const workerSrc = readFileSync(join(ROOT, "src/lib/channel/worker.ts"), "utf8");
  assert.match(workerSrc, /audit_room_mappings/,
    "CONTRACT BREACH: the worker never enqueues 'audit_room_mappings'. The audit " +
    "would be dead code — behaviour above can still be green while production never " +
    "runs the sweep.");
  assert.match(workerSrc, /loadChannelAuditConnections/,
    "CONTRACT BREACH: the worker does not use loadChannelAuditConnections. If the " +
    "sweep is scheduled from loadBeds24InboundConnections instead, assertion A8 above " +
    "still passes in isolation while the dark-pipeline case is never swept in production.");
  ok("CONTRACT · worker enqueues audit_room_mappings from loadChannelAuditConnections");

  if (first) {
    console.log(
      `  · summary of the first sweep: rooms=${first.rooms} mapped=${first.mapped} ` +
      `missing=${first.missing} broken=${first.broken} excluded=${first.excluded} ` +
      `raised=${first.raised}`,
    );
  }
  console.log(`\nCHANNEL MAPPING ALERT: ${n} PASSED`);
} catch (e) {
  console.error(`\nCHANNEL MAPPING ALERT FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (sql) {
    await sql`DELETE FROM guesthub.channel_sync_jobs WHERE tenant_id = ${T}`.catch(() => {});
    await sql.end();
  }
  await admin.end().catch(() => {});
}
