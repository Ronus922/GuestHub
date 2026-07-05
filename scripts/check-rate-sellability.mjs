// Phase 4A hotfix — sale-state reason codes + physical/commercial separation +
// open/close (Steps 2–5). Two layers:
//   1. classifySellState (src/lib/rates/rules.ts) — PURE, all 11 reason codes.
//   2. SQL twins in the ISOLATED test DB (rolled-back txs) — proves the real
//      read models (effective_sell_state / sellable_unit_inventory) feed the
//      classifier the numbers that yield each reason, incl. the G4 fixture and
//      the false-reopen (never one-way) write semantics.
// Never touches live data; no Channex; no network.
// Usage: node --env-file=.env.test scripts/check-rate-sellability.mjs
import postgres from "postgres";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// ---- compile the pure classifier and require it ----
const out = mkdtempSync(join(tmpdir(), "sellstate-"));
execSync(
  `npx tsc src/lib/rates/rules.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const { classifySellState, collectSellReasons, roomAdminStateOf } = require(join(out, "rules.js"));

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
const DAY = "2027-03-15";
const NEXT = "2027-03-16";
let n = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); n++; };

class Rollback extends Error {}
async function inTx(fn) {
  try { await sql.begin(async (tx) => { await fn(tx); throw new Rollback(); }); }
  catch (e) { if (!(e instanceof Rollback)) throw e; }
}
const [{ id: tenant }] = await sql`SELECT id FROM guesthub.tenants LIMIT 1`;
let seq = 0;
const uniq = (p) => `${p}-${seq++}`;

// A defaulted classifier input for one physically-available, priced, open cell.
const base = {
  hasBasePlan: true, totalRooms: 1, sellableRooms: 1, occupiedRooms: 0,
  closedRooms: 0, inactiveRooms: 0, outOfOrderRooms: 0, availability: 1,
  effectivePrice: 600, stopSell: false,
};
const R = (over) => classifySellState({ ...base, ...over });

try {
  // ============ 1. PURE classifier — all 11 reason codes ============
  assert.equal(R({}), "SELLABLE");
  assert.equal(R({ stopSell: true }), "COMMERCIAL_STOP_SELL");
  assert.equal(R({ totalRooms: 0 }), "MAPPING_ERROR");
  assert.equal(R({ hasBasePlan: false }), "NO_ACTIVE_RATE_PLAN");
  assert.equal(R({ sellableRooms: 0, inactiveRooms: 1, availability: 0 }), "ROOM_INACTIVE");
  assert.equal(R({ sellableRooms: 0, outOfOrderRooms: 1, availability: 0 }), "ROOM_OUT_OF_ORDER");
  assert.equal(R({ occupiedRooms: 1, availability: 0 }), "RESERVED");
  assert.equal(R({ closedRooms: 1, availability: 0 }), "PHYSICAL_BLOCK");
  assert.equal(R({ availability: 0 }), "PHYSICAL_INVENTORY_ZERO");
  assert.equal(R({ effectivePrice: 0 }), "MISSING_EFFECTIVE_PRICE");
  assert.equal(R({ effectivePrice: null }), "MISSING_EFFECTIVE_PRICE");
  assert.equal(R({ effectivePrice: -5 }), "INVALID_EFFECTIVE_PRICE");
  ok("classifySellState returns each of the 11 reason codes for its exact cause");

  // precedence: physical wins over commercial (a stop_sell toggle can't open a
  // physically-absent room — the conflation that made close feel one-way).
  assert.equal(R({ availability: 0, sellableRooms: 0, inactiveRooms: 1, stopSell: true }), "ROOM_INACTIVE");
  // CTA/CTD/min/max are NOT closure reasons — an open, available, priced cell is
  // SELLABLE regardless of them (restrictions only fail a specific stay).
  assert.equal(R({}), "SELLABLE");
  ok("physical precedence over commercial; CTA/CTD/stay restrictions are never a closure reason");

  // ============ SQL twins — helpers (schema-faithful to grid-state.ts) ============
  const scaffold = async (tx, { rooms = 1, basePrice = 600, pooled = false } = {}) => {
    const [rt] = await tx`INSERT INTO guesthub.room_types (tenant_id, name, base_price)
      VALUES (${tenant}, ${uniq("RT")}, ${basePrice}) RETURNING id`;
    const roomIds = [];
    for (let i = 0; i < rooms; i++) {
      const [r] = await tx`INSERT INTO guesthub.rooms (tenant_id, room_number, room_type_id, status, is_active)
        VALUES (${tenant}, ${uniq("RM")}, ${rt.id}, 'available', true) RETURNING id`;
      roomIds.push(r.id);
    }
    const [su] = await tx`INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id, is_pooled, is_active)
      VALUES (${tenant}, ${uniq("SU")}, 'u', ${rt.id}, ${pooled}, true) RETURNING id`;
    for (const rid of roomIds)
      await tx`INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id) VALUES (${tenant}, ${su.id}, ${rid})`;
    const [bp] = await tx`INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base)
      VALUES (${tenant}, ${su.id}, 'base', 'base', true) RETURNING id`;
    return { rtId: rt.id, roomIds, suId: su.id, planId: bp.id, basePrice };
  };
  const putRate = (tx, s, p) => tx`
    INSERT INTO guesthub.pricing_plan_rates ${tx({
      tenant_id: tenant, sellable_unit_id: s.suId, pricing_plan_id: s.planId, date: DAY,
      price: p.price ?? null, stop_sell: p.stopSell ?? false,
      closed_to_arrival: p.cta ?? false, closed_to_departure: p.ctd ?? false,
    }, "tenant_id", "sellable_unit_id", "pricing_plan_id", "date", "price", "stop_sell",
       "closed_to_arrival", "closed_to_departure")}
    ON CONFLICT (pricing_plan_id, date) DO UPDATE SET
      price = EXCLUDED.price, stop_sell = EXCLUDED.stop_sell,
      closed_to_arrival = EXCLUDED.closed_to_arrival, closed_to_departure = EXCLUDED.closed_to_departure`;
  const ess = async (tx, suId) => (await tx`
    SELECT availability, price::float8 AS price, stop_sell, sellable
    FROM guesthub.effective_sell_state(${tenant}, ${DAY}::date, (${DAY}::date + 1))
    WHERE sellable_unit_id = ${suId}`)[0];
  const inv = async (tx, suId) => (await tx`
    SELECT total_rooms, sellable_rooms, occupied_rooms, closed_rooms, availability
    FROM guesthub.sellable_unit_inventory(${tenant}, ${DAY}::date, (${DAY}::date + 1))
    WHERE sellable_unit_id = ${suId}`)[0];
  // Gather the classifier's inputs the SAME way grid-state.ts does.
  const reasonOf = async (tx, s) => {
    const iv = await inv(tx, s.suId);
    const e = await ess(tx, s.suId);
    const [st] = await tx`
      SELECT count(*) FILTER (WHERE r.status='inactive' OR NOT r.is_active)::int AS inactive,
             count(*) FILTER (WHERE r.status='out_of_order')::int AS out_of_order
      FROM guesthub.sellable_unit_rooms sur JOIN guesthub.rooms r ON r.id = sur.room_id
      WHERE sur.sellable_unit_id = ${s.suId}`;
    const [plan] = await tx`SELECT id FROM guesthub.pricing_plans
      WHERE sellable_unit_id = ${s.suId} AND is_base AND is_active`;
    const [row] = await tx`SELECT stop_sell FROM guesthub.pricing_plan_rates
      WHERE sellable_unit_id = ${s.suId} AND date = ${DAY}`;
    return classifySellState({
      hasBasePlan: !!plan,
      totalRooms: iv?.total_rooms ?? 0,
      sellableRooms: iv?.sellable_rooms ?? 0,
      occupiedRooms: iv?.occupied_rooms ?? 0,
      closedRooms: iv?.closed_rooms ?? 0,
      inactiveRooms: st?.inactive ?? 0,
      outOfOrderRooms: st?.out_of_order ?? 0,
      availability: iv?.availability ?? 0,
      effectivePrice: e ? Number(e.price) : null,
      stopSell: row?.stop_sell ?? false,
    });
  };
  const reserve = async (tx, roomId) => {
    const [res] = await tx`INSERT INTO guesthub.reservations (tenant_id, reservation_number, status, check_in, check_out)
      VALUES (${tenant}, ${uniq("RES")}, 'confirmed', ${DAY}, ${NEXT}) RETURNING id`;
    await tx`INSERT INTO guesthub.reservation_rooms (tenant_id, reservation_id, room_id, check_in, check_out)
      VALUES (${tenant}, ${res.id}, ${roomId}, ${DAY}, ${NEXT})`;
  };
  const close = (tx, roomId) => tx`INSERT INTO guesthub.room_closures (tenant_id, room_id, start_date, end_date)
    VALUES (${tenant}, ${roomId}, ${DAY}, ${NEXT})`;

  // ============ 2. G4 FIXTURE — the exact production shape ============
  // one-room SU, valid membership, priced 600, stop_sell=false, room INACTIVE.
  await inTx(async (tx) => {
    const s = await scaffold(tx, { basePrice: 680 });
    await putRate(tx, s, { price: 600, stopSell: false });
    await tx`UPDATE guesthub.rooms SET status='inactive', is_active=false WHERE id = ${s.roomIds[0]}`;
    const iv = await inv(tx, s.suId), e = await ess(tx, s.suId);
    assert.equal(iv.sellable_rooms, 0, "inactive room → 0 sellable rooms (G4 before)");
    assert.equal(iv.availability, 0, "availability 0 despite price + stop_sell=false");
    assert.equal(e.sellable, false, "ESS not sellable");
    assert.equal(await reasonOf(tx, s), "ROOM_INACTIVE", "reason = ROOM_INACTIVE, not a generic hatch (#15 before)");

    // stop_sell=false must NOT open a physically-absent room (#10)
    await putRate(tx, s, { price: 600, stopSell: false });
    assert.equal((await inv(tx, s.suId)).availability, 0, "commercial open does NOT invent physical inventory");
    assert.equal(await reasonOf(tx, s), "ROOM_INACTIVE", "still ROOM_INACTIVE after opening commercial");

    // the fix: reactivate the room (status=available, is_active=true) → SELLABLE
    await tx`UPDATE guesthub.rooms SET status='available', is_active=true WHERE id = ${s.roomIds[0]}`;
    const e2 = await ess(tx, s.suId);
    assert.equal((await inv(tx, s.suId)).availability, 1, "reactivated → availability 1");
    assert.equal(e2.sellable, true, "ESS sellable after reactivation");
    assert.equal(await reasonOf(tx, s), "SELLABLE", "reason = SELLABLE after valid opening (#15/#31)");
  });
  ok("G4 fixture: inactive room → ROOM_INACTIVE (unsellable) → reactivate → SELLABLE");

  // ============ 3. reason per cause (SQL read models → classifier) ============
  await inTx(async (tx) => {
    const s = await scaffold(tx); await putRate(tx, s, { price: 500, stopSell: true });
    assert.equal((await ess(tx, s.suId)).availability, 1, "stop_sell leaves rooms physically free");
    assert.equal(await reasonOf(tx, s), "COMMERCIAL_STOP_SELL", "stop_sell=true → COMMERCIAL_STOP_SELL (#16)");
  });
  await inTx(async (tx) => {
    const s = await scaffold(tx); await putRate(tx, s, { price: 500 }); await reserve(tx, s.roomIds[0]);
    assert.equal(await reasonOf(tx, s), "RESERVED", "an active reservation → RESERVED (#17)");
  });
  await inTx(async (tx) => {
    const s = await scaffold(tx); await putRate(tx, s, { price: 500 }); await close(tx, s.roomIds[0]);
    assert.equal(await reasonOf(tx, s), "PHYSICAL_BLOCK", "a room_closure → PHYSICAL_BLOCK (#17)");
  });
  await inTx(async (tx) => {
    const s = await scaffold(tx); await putRate(tx, s, { price: 500 });
    await tx`UPDATE guesthub.rooms SET status='out_of_order' WHERE id = ${s.roomIds[0]}`;
    assert.equal(await reasonOf(tx, s), "ROOM_OUT_OF_ORDER", "out_of_order room → ROOM_OUT_OF_ORDER");
  });
  await inTx(async (tx) => {
    const s = await scaffold(tx, { basePrice: 0 }); // no explicit price, base 0
    assert.equal(await reasonOf(tx, s), "MISSING_EFFECTIVE_PRICE", "available+open but price 0 → MISSING_EFFECTIVE_PRICE");
  });
  await inTx(async (tx) => {
    const s = await scaffold(tx); await putRate(tx, s, { price: 500 });
    await tx`UPDATE guesthub.pricing_plans SET is_active=false WHERE id = ${s.planId}`;
    assert.equal(await reasonOf(tx, s), "NO_ACTIVE_RATE_PLAN", "no active base plan → NO_ACTIVE_RATE_PLAN");
  });
  await inTx(async (tx) => {
    const [rt] = await tx`INSERT INTO guesthub.room_types (tenant_id, name, base_price)
      VALUES (${tenant}, ${uniq("RT")}, 500) RETURNING id`;
    const [su] = await tx`INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id, is_active)
      VALUES (${tenant}, ${uniq("SU")}, 'u', ${rt.id}, true) RETURNING id`;
    await tx`INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base)
      VALUES (${tenant}, ${su.id}, 'base', 'base', true)`;
    assert.equal(await reasonOf(tx, { suId: su.id }), "MAPPING_ERROR", "SU with no member room → MAPPING_ERROR");
  });
  ok("each cause maps to its distinct reason: stop_sell / reserved / blocked / out_of_order / no-price / no-plan / mapping");

  // ============ 4. open/close is NEVER one-way; commercial ≠ physical ============
  await inTx(async (tx) => {
    const s = await scaffold(tx);
    await putRate(tx, s, { price: 500, stopSell: true });   // close
    assert.equal((await ess(tx, s.suId)).sellable, false, "closed");
    await putRate(tx, s, { price: 500, stopSell: false });  // reopen (explicit false, same upsert writeRateCells emits)
    const [row] = await tx`SELECT stop_sell FROM guesthub.pricing_plan_rates WHERE sellable_unit_id=${s.suId} AND date=${DAY}`;
    assert.equal(row.stop_sell, false, "explicit false persisted — reopen is not dropped (#3, #5)");
    assert.equal((await ess(tx, s.suId)).sellable, true, "commercially reopened → sellable again");
  });
  await inTx(async (tx) => {
    const s = await scaffold(tx); await reserve(tx, s.roomIds[0]);
    await putRate(tx, s, { price: 500, stopSell: false });  // "open" commercially
    const [{ n: resv }] = await tx`SELECT count(*)::int AS n FROM guesthub.reservation_rooms WHERE room_id=${s.roomIds[0]}`;
    assert.equal(resv, 1, "stop_sell=false did NOT delete the reservation (#11)");
    assert.equal((await inv(tx, s.suId)).availability, 0, "still physically unavailable — open didn't invent inventory");
  });
  await inTx(async (tx) => {
    const s = await scaffold(tx); await close(tx, s.roomIds[0]);
    await putRate(tx, s, { price: 500, stopSell: false });
    const [{ n: cl }] = await tx`SELECT count(*)::int AS n FROM guesthub.room_closures WHERE room_id=${s.roomIds[0]}`;
    assert.equal(cl, 1, "stop_sell=false did NOT delete the physical block (#12)");
  });
  await inTx(async (tx) => {
    const s = await scaffold(tx); await putRate(tx, s, { price: 500, cta: true, ctd: true });
    assert.equal((await ess(tx, s.suId)).sellable, true, "CTA/CTD set but the day is still sellable (own indicators, #14)");
    assert.equal(await reasonOf(tx, s), "SELLABLE", "CTA/CTD do not make a cell universally unsellable");
    // false is not dropped for CTA/CTD either
    await putRate(tx, s, { price: 500, cta: false, ctd: false });
    const [row] = await tx`SELECT closed_to_arrival, closed_to_departure FROM guesthub.pricing_plan_rates WHERE sellable_unit_id=${s.suId} AND date=${DAY}`;
    assert.equal(row.closed_to_arrival, false, "CTA false persisted (#8)");
    assert.equal(row.closed_to_departure, false, "CTD false persisted (#9)");
  });
  ok("reopen persists explicit false; opening never deletes reservations/blocks or invents inventory; CTA/CTD false not dropped");

  // ============ 5. canonical projection helpers (reason_codes[] + room_admin) ============
  // reason_codes[] lists EVERY applicable reason, primary (== classifySellState) first.
  {
    const physicalMissingPrice = { ...base, availability: 0, sellableRooms: 0, inactiveRooms: 1, effectivePrice: 0 };
    const codes = collectSellReasons(physicalMissingPrice);
    assert.equal(codes[0], "ROOM_INACTIVE", "primary reason = classifySellState");
    assert.equal(codes[0], classifySellState(physicalMissingPrice), "primary matches the single classifier");
    assert.ok(codes.includes("MISSING_EFFECTIVE_PRICE"), "a blocked cell that also lacks a price lists BOTH reasons");
    // an open, available, priced cell → exactly SELLABLE
    assert.deepEqual(collectSellReasons(base), ["SELLABLE"]);
    // stop_sell + missing price (available) → both, commercial first
    const c2 = collectSellReasons({ ...base, stopSell: true, effectivePrice: 0 });
    assert.equal(c2[0], "COMMERCIAL_STOP_SELL");
    assert.ok(c2.includes("MISSING_EFFECTIVE_PRICE"));
    ok("collectSellReasons: primary == classifier, and every applicable reason is listed");
  }
  // room_admin_state is the physical axis, kept separate from commercial.
  {
    assert.equal(roomAdminStateOf(1, 0, 0), "available");
    assert.equal(roomAdminStateOf(1, 1, 0), "inactive");
    assert.equal(roomAdminStateOf(1, 0, 1), "out_of_order");
    assert.equal(roomAdminStateOf(3, 1, 0), "mixed", "pooled SU: 1 of 3 inactive → mixed");
    assert.equal(roomAdminStateOf(2, 1, 1), "mixed");
    assert.equal(roomAdminStateOf(0, 0, 0), "no_member");
    ok("roomAdminStateOf: available / inactive / out_of_order / mixed / no_member");
  }

  console.log(`\n✔ rate sellability: ${n} checks passed`);
} finally {
  await sql.end({ timeout: 5 });
}
