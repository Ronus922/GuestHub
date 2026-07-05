// Phase 4A — outbound PROJECTION separation checks (no Channex, no real client,
// no network). Proves the two Channex payload shapes derive from INDEPENDENT
// axes at the correct Channex levels:
//   • availability (ROOM-TYPE level) ← PHYSICAL inventory ONLY
//       - change a RESERVATION  → availability payload CHANGES
//       - change stop_sell       → availability payload UNCHANGED
//   • restrictions+rates (RATE-PLAN level) ← COMMERCIAL ARI ONLY
//       - change price / min_stay_through / CTA → restriction payload CHANGES
//       - change a RESERVATION                  → restriction rate/restr. UNCHANGED
//   • min_stay_through now appears in the restriction payload (the outbound fix).
// Model: pure builders compiled with tsc; DB half in rolled-back txs (live data
// untouched). Usage: node --env-file=.env.test scripts/check-outbound-projection.mjs
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import assert from "node:assert/strict";

// ---------- pure builders (tsc → commonjs) ----------
const out = mkdtempSync(join(tmpdir(), "outbound-proj-"));
execSync(
  `pnpm exec tsc src/lib/channel/payloads.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const payloads = require(join(out, "payloads.js"));

const PROP = "PROP-PROJ";
const CHX_RT = "CHX-RT";
const CHX_RP = "CHX-RP";
// stable, order-independent serialization of a value array
const ser = (vals) =>
  JSON.stringify([...vals].sort((a, b) => (a.date_from < b.date_from ? -1 : 1)));

const sql = postgres(process.env.DATABASE_URL, { prepare: true, max: 1 });
const D = "2027-05-10";
const NEXT = "2027-05-11";

// the SAME projection sync-step.processDirtyRange feeds essToChannexInputs —
// note min_stay_through is now selected (the outbound fix).
const essFor = (tx, tenantId, roomTypeId) => tx`
  SELECT sellable_unit_id, room_type_id, day::text AS day, availability,
         price::float8 AS price, min_stay_arrival, min_stay_through, max_stay,
         closed_to_arrival, closed_to_departure, stop_sell
  FROM guesthub.effective_sell_state(${tenantId}, ${D}, ${NEXT})
  WHERE room_type_id = ${roomTypeId}`;

const availValues = async (tx, tenantId, roomTypeId) => {
  const ess = await essFor(tx, tenantId, roomTypeId);
  const inputs = payloads.essToChannexInputs(ess);
  return payloads
    .buildAvailabilityPayloads(inputs.availability, PROP, new Map([[roomTypeId, CHX_RT]]))
    .batches.flatMap((b) => b.values);
};
const restrValues = async (tx, tenantId, roomTypeId) => {
  const ess = await essFor(tx, tenantId, roomTypeId);
  const inputs = payloads.essToChannexInputs(ess);
  return payloads
    .buildRatePayloads(inputs.rates, PROP, new Map([[roomTypeId, CHX_RP]]))
    .batches.flatMap((b) => b.values);
};

try {
  const [{ id: tenantId }] = await sql`SELECT id FROM guesthub.tenants LIMIT 1`;

  await sql.begin(async (tx) => {
    const [t] = await tx`
      SELECT su.id AS su_id, su.room_type_id, bp.id AS plan_id, sur.room_id
      FROM guesthub.sellable_units su
      JOIN guesthub.sellable_unit_rooms sur ON sur.sellable_unit_id = su.id
      JOIN guesthub.rooms r ON r.id = sur.room_id AND r.status = 'available' AND r.is_active
      JOIN guesthub.pricing_plans bp ON bp.sellable_unit_id = su.id AND bp.is_base
      WHERE su.tenant_id = ${tenantId} AND su.room_type_id IS NOT NULL AND NOT su.is_pooled
      LIMIT 1`;
    assert.ok(t, "a one-room SU with a room_type + base plan exists in the seed");
    const rt = t.room_type_id;

    // Isolate the room type to exactly ONE active SU (this SU), so the room-type
    // projection maps cleanly to our edits: availability = this SU, the lead
    // commercial row = this SU's base plan, and stop_sell (all-SUs-closed) = this
    // SU's stop_sell. Rolled back with the tx — live data untouched.
    await tx`
      UPDATE guesthub.sellable_units SET is_active = false
      WHERE tenant_id = ${tenantId} AND room_type_id = ${rt} AND id <> ${t.su_id}`;

    // ---- baseline (no commercial row, no reservation) ----
    const a0 = await availValues(tx, tenantId, rt);
    const r0 = await restrValues(tx, tenantId, rt);
    assert.ok(a0.length > 0, "baseline availability payload is non-empty");
    assert.ok(r0.length > 0, "baseline restriction payload is non-empty");
    const baseAvail = a0[0].availability;
    assert.ok(baseAvail >= 1, "far-future baseline room-type availability >= 1");

    // ---- LEVELS: availability = room-type; restrictions = rate-plan ----
    assert.ok(
      a0.every((v) => v.room_type_id === CHX_RT && v.rate_plan_id === undefined),
      "availability values are addressed at ROOM-TYPE level (room_type_id, no rate_plan_id)",
    );
    assert.ok(
      r0.every((v) => v.rate_plan_id === CHX_RP && v.room_type_id === undefined),
      "restriction values are addressed at RATE-PLAN level (rate_plan_id)",
    );

    // ---- (1) COMMERCIAL stop_sell: availability UNCHANGED, restriction CHANGED ----
    await tx`
      INSERT INTO guesthub.pricing_plan_rates (tenant_id, sellable_unit_id, pricing_plan_id, date, stop_sell)
      VALUES (${tenantId}, ${t.su_id}, ${t.plan_id}, ${D}, true)
      ON CONFLICT (pricing_plan_id, date) DO UPDATE SET stop_sell = true`;
    const a1 = await availValues(tx, tenantId, rt);
    const r1 = await restrValues(tx, tenantId, rt);
    assert.equal(ser(a1), ser(a0), "stop_sell (commercial) does NOT change the availability payload (physical only)");
    assert.notEqual(ser(r1), ser(r0), "stop_sell changes the restriction payload");
    assert.equal(r1[0].stop_sell, true, "restriction payload carries stop_sell=true");
    await tx`DELETE FROM guesthub.pricing_plan_rates WHERE pricing_plan_id = ${t.plan_id} AND date = ${D}`;

    // ---- (2) COMMERCIAL price / min_stay_through / CTA: restriction CHANGED, availability UNCHANGED ----
    await tx`
      INSERT INTO guesthub.pricing_plan_rates
        (tenant_id, sellable_unit_id, pricing_plan_id, date, price, min_stay_through, closed_to_arrival)
      VALUES (${tenantId}, ${t.su_id}, ${t.plan_id}, ${D}, 1234, 3, true)
      ON CONFLICT (pricing_plan_id, date) DO UPDATE
        SET price = 1234, min_stay_through = 3, closed_to_arrival = true`;
    const a2 = await availValues(tx, tenantId, rt);
    const r2 = await restrValues(tx, tenantId, rt);
    assert.equal(ser(a2), ser(a0), "price/min_stay_through/CTA (commercial) do NOT change availability (physical only)");
    assert.notEqual(ser(r2), ser(r0), "price/min_stay_through/CTA change the restriction payload");
    assert.equal(r2[0].rate, 1234, "restriction payload carries the price as rate");
    assert.equal(r2[0].closed_to_arrival, true, "restriction payload carries closed_to_arrival");
    // THE outbound fix: min_stay_through is now projected, DISTINCT from min_stay_arrival/max_stay
    assert.equal(r2[0].min_stay_through, 3, "restriction payload now includes min_stay_through (the outbound fix)");
    assert.equal(r2[0].min_stay_arrival, undefined, "min_stay_through is DISTINCT from min_stay_arrival (unset here)");
    assert.equal(r2[0].max_stay, undefined, "min_stay_through is DISTINCT from max_stay (unset here)");
    await tx`DELETE FROM guesthub.pricing_plan_rates WHERE pricing_plan_id = ${t.plan_id} AND date = ${D}`;

    // ---- (3) PHYSICAL reservation: availability CHANGED, restriction rate/restr UNCHANGED ----
    // set a commercial row so the restriction payload is substantive and comparable
    await tx`
      INSERT INTO guesthub.pricing_plan_rates
        (tenant_id, sellable_unit_id, pricing_plan_id, date, price, min_stay_through)
      VALUES (${tenantId}, ${t.su_id}, ${t.plan_id}, ${D}, 1234, 3)
      ON CONFLICT (pricing_plan_id, date) DO UPDATE SET price = 1234, min_stay_through = 3`;
    const aBase = await availValues(tx, tenantId, rt);
    const rBase = await restrValues(tx, tenantId, rt);

    const [res] = await tx`
      INSERT INTO guesthub.reservations (tenant_id, reservation_number, status, check_in, check_out)
      VALUES (${tenantId}, ${"RES-PROJ-" + D}, 'confirmed', ${D}, ${NEXT}) RETURNING id`;
    await tx`
      INSERT INTO guesthub.reservation_rooms (tenant_id, reservation_id, room_id, check_in, check_out)
      VALUES (${tenantId}, ${res.id}, ${t.room_id}, ${D}, ${NEXT})`;

    const a3 = await availValues(tx, tenantId, rt);
    const r3 = await restrValues(tx, tenantId, rt);
    assert.notEqual(ser(a3), ser(aBase), "a reservation (physical) CHANGES the availability payload");
    assert.ok(a3[0].availability < aBase[0].availability, "the reservation DECREASES room-type availability by consuming a physical room");
    assert.equal(ser(r3), ser(rBase), "a reservation does NOT change the restriction rate/restrictions (commercial only)");

    throw new Error("ROLLBACK");
  }).catch((e) => { if (e.message !== "ROLLBACK") throw e; });

  console.log("check-outbound-projection: all assertions passed");
} finally {
  await sql.end();
}
