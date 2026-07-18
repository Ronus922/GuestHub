// Phase 4A — Effective Sell State + canonical commercial model checks.
//  Pure half (compiled with tsc): the single validator/pricer + price modes
//  (src/lib/rates/rules.ts). DB half (rolled-back txs, live data untouched):
//   - effective_sell_state AGREES with sellable_unit_inventory (physical) and
//     pricing_plan_rates (commercial) — the single read model (req 7)
//   - the reservation engine, the calendar strip, and the grid all resolve to
//     the SAME pricing_plan_rates; legacy guesthub.rates has zero effect — they
//     cannot become competing sources of truth (req 8/9/12)
//   - a physical block and a commercial stop_sell move INDEPENDENTLY (req 13)
//   - one-room and pooled Sellable Units both project correctly (req 14)
// Usage: node --env-file=.env.local scripts/check-effective-state.mjs
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import assert from "node:assert/strict";

// ---------- pure module (tsc → commonjs, imported directly) ----------
const out = mkdtempSync(join(tmpdir(), "ess-"));
execSync(
  `pnpm exec tsc src/lib/rates/rules.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const rules = require(join(out, "rules.js"));

const idx = (rows) => rules.indexByDate(rows);
const row = (o) => ({
  date: o.date, price: o.price ?? null,
  min_stay_through: o.mst ?? null, min_stay_arrival: o.msa ?? null, max_stay: o.max ?? null,
  closed_to_arrival: !!o.cta, closed_to_departure: !!o.ctd, stop_sell: !!o.ss,
});

// planNightlyPrice: explicit price, else base fallback
assert.equal(rules.planNightlyPrice(idx([row({ date: "2026-07-10", price: 500 })]), "2026-07-10", 300), 500, "explicit price");
assert.equal(rules.planNightlyPrice(idx([]), "2026-07-10", 300), 300, "base_price fallback");
assert.equal(rules.planNightlyPrice(idx([row({ date: "2026-07-10", price: null })]), "2026-07-10", 300), 300, "null price → base");

// stayRestrictionViolation — the three separate stay fields (§0.3)
const stay = (ci, co, nights) => ({ checkIn: ci, checkOut: co, nights });
// min_stay_arrival: on the arrival date only
assert.ok(
  rules.stayRestrictionViolation(idx([row({ date: "2026-07-10", msa: 3 })]), stay("2026-07-10", "2026-07-11", ["2026-07-10"])),
  "min_stay_arrival enforced on arrival",
);
assert.equal(
  rules.stayRestrictionViolation(idx([row({ date: "2026-07-10", msa: 2 })]), stay("2026-07-10", "2026-07-12", ["2026-07-10", "2026-07-11"])),
  null,
  "min_stay_arrival satisfied",
);
// min_stay_through: the MAX applicable across all stay dates
const throughRows = idx([row({ date: "2026-07-10", mst: 2 }), row({ date: "2026-07-11", mst: 3 })]);
assert.ok(
  rules.stayRestrictionViolation(throughRows, stay("2026-07-10", "2026-07-12", ["2026-07-10", "2026-07-11"]))?.includes("3"),
  "min_stay_through takes the MAX across nights (needs 3, got 2)",
);
assert.equal(
  rules.stayRestrictionViolation(throughRows, stay("2026-07-10", "2026-07-13", ["2026-07-10", "2026-07-11", "2026-07-12"])),
  null,
  "min_stay_through satisfied at 3 nights",
);
// max_stay on arrival
assert.ok(
  rules.stayRestrictionViolation(idx([row({ date: "2026-07-10", max: 2 })]), stay("2026-07-10", "2026-07-13", ["2026-07-10", "2026-07-11", "2026-07-12"])),
  "max_stay enforced",
);
// CTA / CTD / stop_sell
assert.ok(rules.stayRestrictionViolation(idx([row({ date: "2026-07-10", cta: true })]), stay("2026-07-10", "2026-07-11", ["2026-07-10"])), "CTA blocks arrival");
assert.ok(rules.stayRestrictionViolation(idx([row({ date: "2026-07-11", ctd: true })]), stay("2026-07-10", "2026-07-11", ["2026-07-10"])), "CTD blocks departure");
assert.ok(rules.stayRestrictionViolation(idx([row({ date: "2026-07-10", ss: true })]), stay("2026-07-10", "2026-07-11", ["2026-07-10"]))?.includes("סגור"), "stop_sell blocks the night");
assert.equal(rules.stayRestrictionViolation(idx([row({ date: "2026-07-10", price: 500 })]), stay("2026-07-10", "2026-07-11", ["2026-07-10"])), null, "unrestricted stay passes");

// nightsRuleViolation — the calendar's manual-create gate: min/max NIGHTS only,
// and deliberately NOT cta/ctd/stop_sell (front-desk staff may still place a
// manual booking on a closed date). Same evaluation order + Hebrew messages.
const nstay = (ci, nights) => ({ checkIn: ci, nights });
assert.equal(
  rules.nightsRuleViolation(idx([row({ date: "2026-07-10", msa: 4 })]), nstay("2026-07-10", ["2026-07-10", "2026-07-11"]))?.code,
  "MIN_STAY_NOT_MET", "nights gate: 2 nights < arrival-min 4 is blocked");
// the through-min case = the Group Update's primary "מינימום לילות" — THE reported bug
assert.equal(
  rules.nightsRuleViolation(idx([row({ date: "2026-07-10", mst: 4 })]), nstay("2026-07-10", ["2026-07-10", "2026-07-11"]))?.required,
  4, "nights gate: through-min 4 is enforced at selection (the reported 2-vs-min-4 bug)");
assert.equal(
  rules.stayViolationMessage(rules.nightsRuleViolation(idx([row({ date: "2026-07-10", mst: 4 })]), nstay("2026-07-10", ["2026-07-10", "2026-07-11"]))),
  "מינימום 4 לילות בטווח זה", "nights gate: the Hebrew message names the required minimum");
assert.equal(
  rules.nightsRuleViolation(idx([row({ date: "2026-07-10", max: 2 })]), nstay("2026-07-10", ["2026-07-10", "2026-07-11", "2026-07-12"]))?.code,
  "MAX_STAY_EXCEEDED", "nights gate: 3 nights > max 2 is blocked");
assert.equal(
  rules.nightsRuleViolation(idx([row({ date: "2026-07-10", msa: 2, mst: 2, max: 5 })]), nstay("2026-07-10", ["2026-07-10", "2026-07-11"])),
  null, "nights gate: a length within [min,max] passes");
assert.equal(
  rules.nightsRuleViolation(idx([row({ date: "2026-07-10", cta: true, ss: true })]), nstay("2026-07-10", ["2026-07-10"])),
  null, "nights gate: CTA/stop_sell do NOT block a manual calendar create — only illegal length does");

// applyPriceMode — the Group Update modes, clamped + rounded
assert.equal(rules.applyPriceMode(100, "replace", 250, 300), 250);
assert.equal(rules.applyPriceMode(100, "add", 50, 300), 150);
assert.equal(rules.applyPriceMode(100, "subtract", 250, 300), 0, "clamps at 0");
assert.equal(rules.applyPriceMode(100, "percent_add", 10, 300), 110);
assert.equal(rules.applyPriceMode(200, "percent_subtract", 25, 300), 150);
assert.equal(rules.applyPriceMode(null, "add", 50, 300), 350, "null current → base then add");

console.log("check-effective-state: pure rules passed");

// ---------- DB half ----------
const sql = postgres(process.env.DATABASE_URL, { prepare: true, max: 1 });
const FROM = "2026-08-01";
const TO = "2026-08-15"; // exclusive

try {
  const [{ id: tenantId }] = await sql`SELECT id FROM guesthub.tenants LIMIT 1`;

  // ---- req 7: effective_sell_state is the single read model ----
  const [{ n: total }] = await sql`
    SELECT count(*)::int AS n FROM guesthub.effective_sell_state(${tenantId}, ${FROM}, ${TO})`;
  assert.ok(total > 0, "effective_sell_state returns rows");

  const [{ n: availMismatch }] = await sql`
    SELECT count(*)::int AS n
    FROM guesthub.effective_sell_state(${tenantId}, ${FROM}, ${TO}) e
    JOIN guesthub.sellable_unit_inventory(${tenantId}, ${FROM}, ${TO}) i
      ON i.sellable_unit_id = e.sellable_unit_id AND i.day = e.day
    WHERE e.availability <> i.availability`;
  assert.equal(availMismatch, 0, "ESS availability === sellable_unit_inventory (physical axis)");

  const [{ n: priceMismatch }] = await sql`
    SELECT count(*)::int AS n
    FROM guesthub.effective_sell_state(${tenantId}, ${FROM}, ${TO}) e
    JOIN guesthub.sellable_units su ON su.id = e.sellable_unit_id
    LEFT JOIN guesthub.room_types rt ON rt.id = su.room_type_id
    LEFT JOIN guesthub.pricing_plans bp ON bp.sellable_unit_id = su.id AND bp.is_base
    LEFT JOIN guesthub.pricing_plan_rates ppr ON ppr.pricing_plan_id = bp.id AND ppr.date = e.day
    WHERE e.price IS DISTINCT FROM COALESCE(ppr.price, rt.base_price)`;
  assert.equal(priceMismatch, 0, "ESS price === COALESCE(plan rate, room-type base) (commercial axis)");

  // derive `sellable` from INDEPENDENT sources (physical projection + commercial
  // table), not from ESS's own output columns, so this can actually fail.
  const [{ n: sellMismatch }] = await sql`
    SELECT count(*)::int AS n
    FROM guesthub.effective_sell_state(${tenantId}, ${FROM}, ${TO}) e
    JOIN guesthub.sellable_unit_inventory(${tenantId}, ${FROM}, ${TO}) i
      ON i.sellable_unit_id = e.sellable_unit_id AND i.day = e.day
    JOIN guesthub.sellable_units su ON su.id = e.sellable_unit_id
    LEFT JOIN guesthub.pricing_plans bp ON bp.sellable_unit_id = su.id AND bp.is_base
    LEFT JOIN guesthub.pricing_plan_rates ppr ON ppr.pricing_plan_id = bp.id AND ppr.date = e.day
    WHERE e.sellable <> (i.availability > 0 AND NOT COALESCE(ppr.stop_sell, false))`;
  assert.equal(sellMismatch, 0, "sellable === (physical availability>0) AND NOT (commercial stop_sell), from independent sources");

  // ---- req 14: one-room SUs project as {0,1}; pooled SU counts its members ----
  const [{ n: badOneRoom }] = await sql`
    SELECT count(*)::int AS n
    FROM guesthub.sellable_unit_inventory(${tenantId}, ${FROM}, ${TO}) i
    JOIN guesthub.sellable_units su ON su.id = i.sellable_unit_id AND NOT su.is_pooled
    WHERE i.total_rooms <> 1 OR i.availability > 1`;
  assert.equal(badOneRoom, 0, "one-room SUs have total_rooms=1 and availability in {0,1}");

  await sql.begin(async (tx) => {
    // build a pooled SU from two currently-default one-room SUs
    const members = await tx`
      SELECT sur.id AS sur_id, sur.room_id, su.room_type_id
      FROM guesthub.sellable_unit_rooms sur
      JOIN guesthub.sellable_units su ON su.id = sur.sellable_unit_id AND NOT su.is_pooled
      JOIN guesthub.rooms r ON r.id = sur.room_id AND r.status = 'available' AND r.is_active
      WHERE sur.tenant_id = ${tenantId} LIMIT 2`;
    assert.equal(members.length, 2, "two available member rooms found");
    const [pooled] = await tx`
      INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id, is_pooled)
      VALUES (${tenantId}, 'POOL-TEST', 'מאגר בדיקה', ${members[0].room_type_id}, true)
      RETURNING id`;
    await tx`
      UPDATE guesthub.sellable_unit_rooms
      SET sellable_unit_id = ${pooled.id}
      WHERE id = ANY(${members.map((m) => m.sur_id)}::uuid[])`;
    const D = "2027-06-01"; // far future, nothing booked
    const [inv0] = await tx`
      SELECT total_rooms, availability
      FROM guesthub.sellable_unit_inventory(${tenantId}, ${D}, (${D}::date + 1)::date)
      WHERE sellable_unit_id = ${pooled.id}`;
    assert.equal(inv0.total_rooms, 2, "pooled SU total_rooms = 2");
    assert.equal(inv0.availability, 2, "pooled SU availability = 2 when both free");
    // occupy one member room → pooled availability drops by exactly one
    await tx`
      INSERT INTO guesthub.room_closures (tenant_id, room_id, start_date, end_date, reason)
      VALUES (${tenantId}, ${members[0].room_id}, ${D}, (${D}::date + 1)::date, 'pool test')`;
    const [inv1] = await tx`
      SELECT availability
      FROM guesthub.sellable_unit_inventory(${tenantId}, ${D}, (${D}::date + 1)::date)
      WHERE sellable_unit_id = ${pooled.id}`;
    assert.equal(inv1.availability, 1, "pooled SU availability = 1 after one member closed (pooled buffer)");
    throw new Error("ROLLBACK");
  }).catch((e) => { if (e.message !== "ROLLBACK") throw e; });

  // ---- req 13: physical_block and stop_sell are DISTINCT axes ----
  await sql.begin(async (tx) => {
    const [t] = await tx`
      SELECT su.id AS su_id, bp.id AS plan_id, sur.room_id
      FROM guesthub.sellable_units su
      JOIN guesthub.sellable_unit_rooms sur ON sur.sellable_unit_id = su.id
      JOIN guesthub.rooms r ON r.id = sur.room_id AND r.status = 'available' AND r.is_active
      JOIN guesthub.pricing_plans bp ON bp.sellable_unit_id = su.id AND bp.is_base
      WHERE su.tenant_id = ${tenantId} AND NOT su.is_pooled LIMIT 1`;
    const D = "2027-06-02";
    const base = async () => (await tx`
      SELECT availability, stop_sell, sellable
      FROM guesthub.effective_sell_state(${tenantId}, ${D}, (${D}::date + 1)::date)
      WHERE sellable_unit_id = ${t.su_id}`)[0];
    const b0 = await base();
    assert.equal(b0.availability, 1, "baseline availability 1");
    assert.equal(b0.stop_sell, false, "baseline stop_sell false");

    // commercial stop_sell: closes sale, physical availability UNCHANGED
    await tx`
      INSERT INTO guesthub.pricing_plan_rates (tenant_id, sellable_unit_id, pricing_plan_id, date, stop_sell)
      VALUES (${tenantId}, ${t.su_id}, ${t.plan_id}, ${D}, true)
      ON CONFLICT (pricing_plan_id, date) DO UPDATE SET stop_sell = true`;
    const b1 = await base();
    assert.equal(b1.availability, 1, "stop_sell does NOT change physical availability");
    assert.equal(b1.stop_sell, true, "stop_sell reflected");
    assert.equal(b1.sellable, false, "stop_sell makes it not sellable");
    // stop_sell created no physical block
    const [{ n: blocks }] = await tx`
      SELECT count(*)::int AS n FROM guesthub.room_closures
      WHERE room_id = ${t.room_id} AND start_date <= ${D} AND end_date > ${D}`;
    assert.equal(blocks, 0, "commercial stop_sell never creates a physical block");

    // reset commercial; apply a physical block: availability drops, commercial UNCHANGED
    await tx`DELETE FROM guesthub.pricing_plan_rates WHERE pricing_plan_id = ${t.plan_id} AND date = ${D}`;
    await tx`
      INSERT INTO guesthub.room_closures (tenant_id, room_id, start_date, end_date, reason)
      VALUES (${tenantId}, ${t.room_id}, ${D}, (${D}::date + 1)::date, 'block test')`;
    const b2 = await base();
    assert.equal(b2.availability, 0, "physical block reduces availability");
    assert.equal(b2.stop_sell, false, "physical block does NOT set commercial stop_sell");
    throw new Error("ROLLBACK");
  }).catch((e) => { if (e.message !== "ROLLBACK") throw e; });

  // ---- req 8/9/12: engine, grid, calendar all read pricing_plan_rates; ----
  //       legacy guesthub.rates has zero effect (no competing source) ----
  await sql.begin(async (tx) => {
    const [t] = await tx`
      SELECT su.id AS su_id, bp.id AS plan_id, sur.room_id, su.room_type_id
      FROM guesthub.sellable_units su
      JOIN guesthub.sellable_unit_rooms sur ON sur.sellable_unit_id = su.id
      JOIN guesthub.pricing_plans bp ON bp.sellable_unit_id = su.id AND bp.is_base
      WHERE su.tenant_id = ${tenantId} AND NOT su.is_pooled LIMIT 1`;
    const D = "2027-06-03";
    // grid writes the canonical row (mirrors src/lib/rates/service.writeRateCells upsert)
    await tx`
      INSERT INTO guesthub.pricing_plan_rates (tenant_id, sellable_unit_id, pricing_plan_id, date, price)
      VALUES (${tenantId}, ${t.su_id}, ${t.plan_id}, ${D}, 1234)
      ON CONFLICT (pricing_plan_id, date) DO UPDATE SET price = 1234`;

    // 1) the reservation engine loader (room → SU → base plan → pricing_plan_rates)
    const [eng] = await tx`
      SELECT ppr.price::float8 AS price
      FROM guesthub.rooms r
      JOIN guesthub.sellable_unit_rooms sur ON sur.room_id = r.id
      JOIN guesthub.pricing_plans bp ON bp.sellable_unit_id = sur.sellable_unit_id AND bp.is_base AND bp.is_active
      JOIN guesthub.pricing_plan_rates ppr ON ppr.pricing_plan_id = bp.id AND ppr.date = ${D}
      WHERE r.id = ${t.room_id} AND r.tenant_id = ${tenantId}`;
    assert.equal(eng.price, 1234, "reservation engine reads the grid-written canonical row");

    // 2) the calendar strip projection (SU → member room → pricing_plan_rates)
    const [cal] = await tx`
      SELECT ppr.price::float8 AS price
      FROM guesthub.pricing_plan_rates ppr
      JOIN guesthub.pricing_plans bp ON bp.id = ppr.pricing_plan_id AND bp.is_base
      JOIN guesthub.sellable_unit_rooms sur ON sur.sellable_unit_id = ppr.sellable_unit_id
      WHERE sur.room_id = ${t.room_id} AND ppr.date = ${D} AND ppr.tenant_id = ${tenantId}`;
    assert.equal(cal.price, 1234, "calendar strip reads the same canonical row");

    // 3) effective_sell_state exposes the same price
    const [ess] = await tx`
      SELECT price::float8 AS price FROM guesthub.effective_sell_state(${tenantId}, ${D}, (${D}::date + 1)::date)
      WHERE sellable_unit_id = ${t.su_id}`;
    assert.equal(ess.price, 1234, "effective_sell_state exposes the same canonical price");

    // 4) a legacy guesthub.rates row for the SAME room/date has ZERO effect
    await tx`
      INSERT INTO guesthub.rates (tenant_id, room_id, room_type_id, date, price)
      VALUES (${tenantId}, ${t.room_id}, NULL, ${D}, 999999)`;
    const [essAfter] = await tx`
      SELECT price::float8 AS price FROM guesthub.effective_sell_state(${tenantId}, ${D}, (${D}::date + 1)::date)
      WHERE sellable_unit_id = ${t.su_id}`;
    assert.equal(essAfter.price, 1234, "legacy guesthub.rates is retired — it cannot compete with the canonical source");
    throw new Error("ROLLBACK");
  }).catch((e) => { if (e.message !== "ROLLBACK") throw e; });

  console.log("check-effective-state: all DB assertions passed");
} finally {
  await sql.end();
}
