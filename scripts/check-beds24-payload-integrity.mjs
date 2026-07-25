#!/usr/bin/env node
// check:beds24-payload-integrity — an outbound ARI push that fails must SAY SO.
//
// WHY. `drainBeds24AriDirtyRanges` called logChannelError only when
// `warnings.length > 0`. A HARD failure — a payload the structural gate
// rejected, a 401, a 429, a dropped connection — went back to pending with a
// backoff, the job still finished `succeeded`, and NOTHING was written to
// channel_sync_errors. Production bears this out: the errors table has ever
// held exactly one code, `partial_warnings` (28 rows). Zero hard failures have
// ever been recorded — not because none can happen, but because the path that
// records them did not exist. A push that stops publishing with nothing on the
// operator's error surface is the overbooking shape.
//
// Beds24 has NO staging: `beds24BaseUrl()` returns the production URL
// unconditionally (config.ts) and every beds24 connection row is environment
// 'production'. So "staging" here is the D93 harness: the isolated test DB on
// :5433 plus a stubbed provider, driving the REAL compiled worker modules. No
// ARI ever reaches the live provider from this check.
//
// Behavioural assertions, all read back from the DB after a real drain:
//   1 invalid payload → an error row naming the FIELD, ranges NOT synced, retryable
//   2 valid payload   → sent, sentValues > 0, ranges synced
//   3 invariant       → zero ranges left synced by a drain that sent nothing
//
// Usage: node scripts/check-beds24-payload-integrity.mjs
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import Module from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

// A DEDICATED database on the test server. The shared `postgres` test DB is
// rebuilt from scratch by other checks (its table count moved 63 → 20 mid-run
// while this guard was being written), so a guard that borrows it fails for
// reasons that have nothing to do with the code under test. This one owns its
// schema and replays the migrations itself when they are missing.
const TEST_URL =
  process.env.TEST_DATABASE_URL ||
  "postgres://supabase_admin:guesthub_test_local@localhost:5433/guesthub_payload_check";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (TEST_URL.includes(marker)) {
    console.error(`REFUSED: TEST_DATABASE_URL contains production marker "${marker}"`);
    process.exit(1);
  }
}
process.env.DATABASE_URL = TEST_URL;
process.env.CHANNEL_SECRETS_KEY = "check-beds24-payload-integrity-key-0123456789";

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
const { drainBeds24AriDirtyRanges } = req(join(OUT, "lib/channel/beds24-ari-sync.js"));
const { encryptSecret } = req(join(OUT, "lib/channel/crypto.js"));

// ---- the stubbed provider. Beds24 accepts everything that reaches it; the
// point of the check is what OUR side does, not what the provider decides. ----
let calls = 0;
const paths = [];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  assert.equal(u.host, "api.beds24.com", `unexpected outbound host: ${u.host}`);
  paths.push(u.pathname);
  if (u.pathname.includes("/inventory/rooms/calendar")) calls += 1;
  return new Response(JSON.stringify([{ roomId: 707100, success: true }]), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-five-min-limit-remaining": "97.8",
      "x-request-cost": "1",
    },
  });
};

const sql = postgres(TEST_URL, { prepare: false, max: 1, onnotice: () => {} });

/** Replay db/migrations into this dedicated database when the schema is absent. */
async function ensureSchema() {
  const [{ c }] = await sql`
    SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema = 'guesthub'`;
  if (c > 40) return c;
  const dir = join(ROOT, "db", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) await sql.unsafe(readFileSync(join(dir, f), "utf8"));
  const [{ c: after }] = await sql`
    SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema = 'guesthub'`;
  return after;
}

const T = "11111111-1111-4111-8111-111111111111";
const CONN = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";
const SU = "44444444-4444-4444-8444-444444444444";
const TPLAN = "55555555-5555-4555-8555-555555555555"; // tenant-level, the MAPPED plan
const BPLAN = "66666666-6666-4666-8666-666666666666"; // unit-scoped is_base, holds the rates
const day = (o) => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);

async function seed({ maxStay }) {
  await sql`DELETE FROM guesthub.channel_sync_errors WHERE tenant_id = ${T}`;
  await sql`DELETE FROM guesthub.channel_evidence_ledger WHERE tenant_id = ${T}`;
  await sql`DELETE FROM guesthub.channel_dirty_ranges WHERE tenant_id = ${T}`;
  await sql`
    INSERT INTO guesthub.channel_dirty_ranges
      (tenant_id, connection_id, room_id, local_rate_plan_id, kind, date_from, date_to)
    VALUES (${T}, ${CONN}, ${ROOM}, NULL, 'rates', ${day(1)}, ${day(4)})`;
  await sql`
    UPDATE guesthub.pricing_plan_rates SET max_stay = ${maxStay}
    WHERE tenant_id = ${T} AND pricing_plan_id = ${BPLAN}`;
}

async function drain() {
  const [conn] = await sql`
    SELECT id, tenant_id, api_key_ciphertext, access_token_ciphertext,
           access_token_expires_at, environment,
           circuit_open_until::text AS circuit_open_until, consecutive_failures
    FROM guesthub.channel_connections WHERE id = ${CONN}`;
  return drainBeds24AriDirtyRanges(sql, conn);
}

const state = async () => ({
  errors: await sql`
    SELECT error_code, error_message FROM guesthub.channel_sync_errors
    WHERE tenant_id = ${T} ORDER BY created_at`,
  ranges: await sql`
    SELECT status, attempts FROM guesthub.channel_dirty_ranges WHERE tenant_id = ${T}`,
});

try {
  const tables = await ensureSchema();
  ok(`isolated schema ready on the dedicated check database (${tables} tables)`);

  // ---- fixture ----
  await sql`DELETE FROM guesthub.channel_dirty_ranges WHERE tenant_id = ${T}`;
  await sql`DELETE FROM guesthub.channel_sync_errors WHERE tenant_id = ${T}`;
  await sql`DELETE FROM guesthub.channel_evidence_ledger WHERE tenant_id = ${T}`;
  await sql`DELETE FROM guesthub.channel_beds24_room_mappings WHERE tenant_id = ${T}`;
  await sql`DELETE FROM guesthub.pricing_plan_rates WHERE tenant_id = ${T}`;
  await sql`DELETE FROM guesthub.pricing_plan_units WHERE tenant_id = ${T}`;
  await sql`DELETE FROM guesthub.pricing_plans WHERE tenant_id = ${T}`;
  await sql`DELETE FROM guesthub.sellable_unit_rooms WHERE tenant_id = ${T}`;
  await sql`DELETE FROM guesthub.sellable_units WHERE tenant_id = ${T}`;
  await sql`DELETE FROM guesthub.rooms WHERE tenant_id = ${T}`;
  await sql`DELETE FROM guesthub.channel_connections WHERE tenant_id = ${T}`;
  await sql`DELETE FROM guesthub.tenants WHERE id = ${T}`;

  await sql`INSERT INTO guesthub.tenants (id, name, slug, timezone)
            VALUES (${T}, 'payload-integrity', 'payload-integrity', 'Asia/Jerusalem')`;
  await sql`
    INSERT INTO guesthub.channel_connections
      (id, tenant_id, provider, environment, state, is_active_provider,
       outbound_sync_enabled, full_sync_required, api_key_ciphertext,
       access_token_ciphertext, access_token_expires_at, consecutive_failures)
    VALUES (${CONN}, ${T}, 'beds24', 'production', 'active', true, true, false,
            ${encryptSecret("refresh-token")}, ${encryptSecret("access-token")},
            now() + interval '20 hours', 0)`;
  await sql`INSERT INTO guesthub.rooms (id, tenant_id, room_number, status, is_active)
            VALUES (${ROOM}, ${T}, '707100', 'available', true)`;
  await sql`INSERT INTO guesthub.sellable_units (id, tenant_id, code, name, is_active)
            VALUES (${SU}, ${T}, '707100', 'unit-707100', true)`;
  await sql`INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id)
            VALUES (${T}, ${SU}, ${ROOM})`;
  // production shape: the MAPPED plan is tenant-level (sellable_unit_id IS NULL —
  // projectBeds24Ari loads only those), the priced plan is the unit's is_base one,
  // and pricing_plan_units is the assignment that links them.
  await sql`
    INSERT INTO guesthub.pricing_plans
      (id, tenant_id, sellable_unit_id, code, name, plan_kind, is_base, is_active,
       is_archived, is_visible_channels)
    VALUES (${TPLAN}, ${T}, NULL, 'tenant-base', 'tenant-base', 'base', false, true, false, true)`;
  await sql`
    INSERT INTO guesthub.pricing_plans
      (id, tenant_id, sellable_unit_id, code, name, plan_kind, is_base, is_active,
       is_archived, is_visible_channels)
    VALUES (${BPLAN}, ${T}, ${SU}, 'base', 'base', 'base', true, true, false, true)`;
  await sql`
    INSERT INTO guesthub.pricing_plan_units
      (tenant_id, pricing_plan_id, sellable_unit_id, is_active)
    VALUES (${T}, ${TPLAN}, ${SU}, true)`;
  for (let i = 0; i <= 5; i++) {
    await sql`
      INSERT INTO guesthub.pricing_plan_rates
        (tenant_id, sellable_unit_id, pricing_plan_id, date, price, min_stay_through, stop_sell)
      VALUES (${T}, ${SU}, ${BPLAN}, ${day(i)}, 500, 1, false)`;
  }
  await sql`
    INSERT INTO guesthub.channel_beds24_room_mappings
      (tenant_id, connection_id, room_id, beds24_property_id, beds24_room_id,
       local_rate_plan_id, status)
    VALUES (${T}, ${CONN}, ${ROOM}, '999001', '707100', ${TPLAN}, 'mapped')`;

  // ================= 1. INVALID PAYLOAD =================
  // maxStay 0 passes the Zod layer (stayField is min(0)) and reaches the payload
  // builder, whose structural gate requires >= 1 — so the whole request is
  // rejected before the network. Nothing about that is visible unless the drain
  // records it.
  calls = 0; paths.length = 0;
  await seed({ maxStay: 0 });
  const bad = await drain();
  const afterBad = await state();

  assert.equal(calls, 0,
    `an invalid payload must never reach the calendar endpoint (paths seen: ${paths.join(", ") || "none"})`);
  assert.ok(afterBad.errors.length > 0,
    "a hard failure MUST write a channel_sync_errors row — the drain logged only warnings, so validation/401/429 failures were invisible");
  const msg = afterBad.errors[0].error_message ?? "";
  assert.match(msg, /maxStay/i,
    "the error message must name the offending FIELD — beds24Fail() alone returns a fixed string that identifies nothing");
  assert.equal(afterBad.errors[0].error_code, "validation", "the failure is categorised, not generic");
  ok(`invalid payload → error recorded, field named: "${msg.slice(0, 80)}"`);

  assert.equal(afterBad.ranges.length, 1, "the range still exists");
  assert.notEqual(afterBad.ranges[0].status, "synced",
    "a range whose payload was rejected must NEVER be marked synced");
  assert.equal(afterBad.ranges[0].status, "pending", "it stays pending — retryable");
  assert.equal(afterBad.ranges[0].attempts, 1, "the attempt was counted, so the backoff advances");
  assert.equal(bad.sentValues, 0, "nothing was sent");
  ok(`invalid payload → range stays pending (attempts=1, retryable), sentValues=0`);

  // ================= 2. VALID PAYLOAD =================
  calls = 0; paths.length = 0;
  await seed({ maxStay: 7 });
  const good = await drain();
  const afterGood = await state();

  assert.ok(calls > 0, "a valid payload reaches the provider");
  assert.ok(good.sentValues > 0, `a valid payload sends values (sentValues=${good.sentValues})`);
  assert.equal(afterGood.errors.length, 0, "a clean push records no error");
  assert.equal(afterGood.ranges[0].status, "synced", "a clean push marks the range synced");
  ok(`valid payload → sent (${calls} request), sentValues=${good.sentValues}, range synced, zero errors`);

  // ================= 3. THE INVARIANT =================
  // A drain that sent nothing must not leave a range synced. This is the shape
  // behind the 22 ranges of room 1318 that completed synced having sent nothing.
  assert.ok(
    !(good.sentValues === 0 && afterGood.ranges[0].status === "synced"),
    "a range marked synced by a drain that sent nothing is a false success",
  );
  assert.ok(
    !(bad.sentValues === 0 && afterBad.ranges[0].status === "synced"),
    "invariant: zero ranges may be left synced by a drain that sent nothing",
  );
  ok("invariant holds: no range is synced by a drain that sent nothing");

  console.log(`\nBEDS24 PAYLOAD INTEGRITY: ${n} PASSED`);
} catch (e) {
  console.error(`\nBEDS24 PAYLOAD INTEGRITY FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await sql`DELETE FROM guesthub.channel_dirty_ranges WHERE tenant_id = ${T}`.catch(() => {});
  await sql.end();
}
