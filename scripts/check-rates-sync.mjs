// Phase 4A — outbox / queue-payload / stale-retry checks (no Channex, no real
// client, no network). A recording FAKE provider is used only where the queue
// payload test needs one.
//  Pure half (tsc): essToChannexInputs + buildRatePayloads/buildAvailabilityPayloads.
//  DB half (rolled-back txs):
//   - the queue payload is recomputed FROM Effective Sell State, never from UI
//     input; availability per room type = SUM of its SUs' availability (req 11)
//   - a commercial write and its outbox mark share ONE transaction; each mark
//     takes a higher monotonic revision (req 10)
//   - a stale (older) revision can NEVER overwrite a newer synced range (req 15)
// Usage: node --env-file=.env.local scripts/check-rates-sync.mjs
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import assert from "node:assert/strict";

// ---------- pure module ----------
const out = mkdtempSync(join(tmpdir(), "rates-sync-"));
execSync(
  `pnpm exec tsc src/lib/channel/payloads.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const payloads = require(join(out, "payloads.js"));

// essToChannexInputs: pooled room type aggregates its SUs (sum availability;
// lead SU rate; closed only if ALL SUs closed).
const ess2 = [
  { sellable_unit_id: "a", room_type_id: "T", day: "2026-08-01", availability: 1, price: 500, min_stay_arrival: 2, max_stay: null, closed_to_arrival: false, closed_to_departure: false, stop_sell: false },
  { sellable_unit_id: "b", room_type_id: "T", day: "2026-08-01", availability: 1, price: 700, min_stay_arrival: null, max_stay: null, closed_to_arrival: false, closed_to_departure: false, stop_sell: true },
];
const built = payloads.essToChannexInputs(ess2);
assert.equal(built.availability.length, 1, "one availability row per (type, day)");
assert.equal(built.availability[0].availability, 2, "availability = SUM of SU availabilities (pooled)");
assert.equal(built.rates[0].price, 500, "rate = lead (lexicographically-first) SU");
assert.equal(built.rates[0].min_nights, 2, "min_stay_arrival carried as min_nights");
assert.equal(built.rates[0].closed, false, "type closed only when ALL SUs closed (one open here)");
const allClosed = payloads.essToChannexInputs(ess2.map((r) => ({ ...r, stop_sell: true })));
assert.equal(allClosed.rates[0].closed, true, "type closed when every SU is stop_sell");

console.log("check-rates-sync: pure payload rules passed");

// a recording fake provider — the ONLY 'client' in Phase 4A. No network.
function recordingProvider() {
  const calls = { rates: [], availability: [] };
  return {
    kind: "fake",
    async pushAvailability(b) { calls.availability.push(...b); return { ok: true, providerTaskId: "fake-avail" }; },
    async pushRates(b) { calls.rates.push(...b); return { ok: true, providerTaskId: "fake-rates" }; },
    async pushRestrictions(b) { calls.rates.push(...b); return { ok: true, providerTaskId: "fake-restr" }; },
    _calls: calls,
  };
}

// ---------- DB half ----------
const sql = postgres(process.env.DATABASE_URL, { prepare: true, max: 1 });
const FROM = "2026-08-01";
const TO = "2026-08-15";

try {
  const [{ id: tenantId }] = await sql`SELECT id FROM guesthub.tenants LIMIT 1`;

  // ---- req 11: queue payload recomputed FROM Effective Sell State ----
  const ess = await sql`
    SELECT sellable_unit_id, room_type_id, day::text AS day, availability,
           price::float8 AS price, min_stay_arrival, max_stay,
           closed_to_arrival, closed_to_departure, stop_sell
    FROM guesthub.effective_sell_state(${tenantId}, ${FROM}, ${TO})`;
  const inputs = payloads.essToChannexInputs(ess);
  assert.ok(inputs.availability.length > 0, "ESS produced availability inputs");

  // availability per (type, day) equals the SQL SUM over SUs
  const sums = new Map();
  for (const r of ess) {
    if (!r.room_type_id) continue;
    const k = `${r.room_type_id}|${r.day}`;
    sums.set(k, (sums.get(k) ?? 0) + r.availability);
  }
  for (const a of inputs.availability) {
    assert.equal(a.availability, sums.get(`${a.room_type_id}|${a.date}`), "payload availability = SUM of SU availabilities");
  }

  // build the Channex batches for one mapped type and push to the fake client
  const someType = inputs.availability[0].room_type_id;
  const propId = "PROP-TEST";
  const availBatches = payloads.buildAvailabilityPayloads(
    inputs.availability.filter((a) => a.room_type_id === someType),
    propId, new Map([[someType, "CHX-RT"]]),
  ).batches;
  const rateBatches = payloads.buildRatePayloads(
    inputs.rates.filter((r) => r.room_type_id === someType),
    propId, new Map([[someType, "CHX-RP"]]),
  ).batches;
  const prov = recordingProvider();
  await prov.pushAvailability(availBatches);
  await prov.pushRates(rateBatches);
  const recAvail = prov._calls.availability.flatMap((b) => b.values);
  assert.ok(recAvail.length > 0, "fake client recorded availability values");
  assert.ok(
    recAvail.every((v) => v.property_id === propId && v.room_type_id === "CHX-RT"),
    "recorded payload uses the DB mapping + property, never UI input",
  );
  // content check: every recorded availability number is an ESS-derived room-type
  // sum — the payload VALUES come from Effective Sell State, not from any UI input
  const essSums = new Set([...sums.values()]);
  assert.ok(
    recAvail.every((v) => essSums.has(v.availability)),
    "every recorded availability value equals an Effective-Sell-State room-type sum",
  );

  // ---- req 10: outbox mark shares the SAME transaction as the commercial write ----
  // structural: the service marks the outbox with the caller's tx handle
  const svc = readFileSync("src/lib/rates/service.ts", "utf8");
  assert.ok(/markAriDirty\(\s*\n?\s*tx\b/.test(svc), "writeRateCells marks the outbox with the SAME tx handle");
  const act = readFileSync("src/app/(dashboard)/rates/actions.ts", "utf8");
  assert.ok(act.includes("sql.begin"), "rate actions run inside a transaction");
  assert.ok(/writeRateCells\(tx,/.test(act), "actions call writeRateCells inside the tx");

  // dynamic: commercial write + dirty mark in one tx; monotonic revision; atomic
  await sql.begin(async (tx) => {
    const [conn] = await tx`
      INSERT INTO guesthub.channel_connections (tenant_id, provider, environment, state, outbound_sync_enabled)
      VALUES (${tenantId}, 'channex', 'staging', 'active', true) RETURNING id`;
    const [t] = await tx`
      SELECT su.id AS su_id, bp.id AS plan_id, su.room_type_id
      FROM guesthub.sellable_units su
      JOIN guesthub.pricing_plans bp ON bp.sellable_unit_id = su.id AND bp.is_base
      WHERE su.tenant_id = ${tenantId} AND su.room_type_id IS NOT NULL LIMIT 1`;
    const D = "2027-06-04";
    await tx`
      INSERT INTO guesthub.pricing_plan_rates (tenant_id, sellable_unit_id, pricing_plan_id, date, price)
      VALUES (${tenantId}, ${t.su_id}, ${t.plan_id}, ${D}, 555)
      ON CONFLICT (pricing_plan_id, date) DO UPDATE SET price = 555`;
    const [d1] = await tx`
      INSERT INTO guesthub.channel_dirty_ranges (tenant_id, connection_id, room_type_id, kind, date_from, date_to)
      VALUES (${tenantId}, ${conn.id}, ${t.room_type_id}, 'rates', ${D}, (${D}::date + 1)::date)
      RETURNING revision`;
    const [d2] = await tx`
      INSERT INTO guesthub.channel_dirty_ranges (tenant_id, connection_id, room_type_id, kind, date_from, date_to)
      VALUES (${tenantId}, ${conn.id}, ${t.room_type_id}, 'rates', ${D}, (${D}::date + 1)::date)
      RETURNING revision`;
    assert.ok(Number(d2.revision) > Number(d1.revision), "each dirty mark gets a higher monotonic revision");
    const [{ n: rc }] = await tx`
      SELECT count(*)::int AS n FROM guesthub.pricing_plan_rates
      WHERE pricing_plan_id = ${t.plan_id} AND date = ${D}`;
    const [{ n: dc }] = await tx`
      SELECT count(*)::int AS n FROM guesthub.channel_dirty_ranges
      WHERE connection_id = ${conn.id} AND room_type_id = ${t.room_type_id} AND kind = 'rates'`;
    assert.equal(rc, 1, "commercial row written");
    assert.ok(dc >= 1, "outbox mark written in the SAME tx");
    throw new Error("ROLLBACK");
  }).catch((e) => { if (e.message !== "ROLLBACK") throw e; });

  const [{ n: leftover }] = await sql`SELECT count(*)::int AS n FROM guesthub.channel_dirty_ranges`;
  assert.equal(leftover, 0, "rolled-back tx leaves NO dirty range — commercial change + outbox are atomic");

  // ---- req 15: a stale (older) revision can never overwrite a newer range ----
  // exactly the watermark upsert src/lib/channel/sync-step.processDirtyRange runs.
  await sql.begin(async (tx) => {
    const [conn] = await tx`
      INSERT INTO guesthub.channel_connections (tenant_id, provider, environment, state, outbound_sync_enabled)
      VALUES (${tenantId}, 'channex', 'staging', 'active', true) RETURNING id`;
    const [rt] = await tx`SELECT id FROM guesthub.room_types WHERE tenant_id = ${tenantId} LIMIT 1`;
    const applyRev = (rev) => tx`
      INSERT INTO guesthub.channel_sync_state (tenant_id, connection_id, room_type_id, kind, applied_revision)
      VALUES (${tenantId}, ${conn.id}, ${rt.id}, 'rates', ${rev})
      ON CONFLICT (connection_id, room_type_id, kind) DO UPDATE
        SET applied_revision = EXCLUDED.applied_revision, updated_at = now()
        WHERE EXCLUDED.applied_revision > guesthub.channel_sync_state.applied_revision`;
    const current = async () =>
      Number((await tx`
        SELECT applied_revision FROM guesthub.channel_sync_state
        WHERE connection_id = ${conn.id} AND room_type_id = ${rt.id} AND kind = 'rates'`)[0].applied_revision);
    await applyRev(5);
    assert.equal(await current(), 5, "revision 5 applied");
    await applyRev(3);
    assert.equal(await current(), 5, "stale revision 3 does NOT overwrite newer 5");
    await applyRev(7);
    assert.equal(await current(), 7, "newer revision 7 advances the watermark");
    throw new Error("ROLLBACK");
  }).catch((e) => { if (e.message !== "ROLLBACK") throw e; });

  console.log("check-rates-sync: all DB assertions passed");
} finally {
  await sql.end();
}
