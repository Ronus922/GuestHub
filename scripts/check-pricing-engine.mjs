// ============================================================
// Central pricing engine checks (Rate Plans phase).
//
// Part A — PURE: compiles the ACTUAL app modules (src/lib/pricing/resolve.ts,
// src/lib/rates/rules.ts via the engine graph) with tsc and asserts the
// resolution rules, so the checks prove the code the app runs.
// Part B — DB: runs calculateQuote end-to-end against the ISOLATED test DB
// (:5433 guesthub-testdb) with throwaway fixtures inside one rolled-back
// transaction (savepoints isolate mutating scenarios). NOTHING is committed.
//
// Usage: node scripts/check-pricing-engine.mjs
// ============================================================

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const ROOT = "/var/www/guesthub";
const TEST_URL =
  process.env.TEST_DATABASE_URL ||
  "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";

// fail-closed: this script must never run against production
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (TEST_URL.includes(marker)) {
    console.error(`REFUSED: TEST_DATABASE_URL contains production marker "${marker}"`);
    process.exit(1);
  }
}
process.env.DATABASE_URL = TEST_URL; // any transitively-created client points at the test DB

// ---- apply the full migration chain (idempotent; validates 016 on the way) ----
console.log("applying migration chain to guesthub-testdb (:5433)…");
const migrations = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
for (const f of migrations) {
  execSync(
    `docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "db/migrations/${f}"`,
    { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" },
  );
}

// ---- compile the real engine graph (tsc, CommonJS) ----
console.log("compiling src/lib/pricing via tsc…");
const tmp = mkdtempSync(join(tmpdir(), "gh-pricing-"));
const out = join(tmp, "out");
writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    module: "commonjs", moduleResolution: "node10", target: "es2022",
    esModuleInterop: true, skipLibCheck: true, strict: true,
    baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
    rootDir: join(ROOT, "src"), outDir: out,
    typeRoots: [join(ROOT, "node_modules/@types")], types: ["node"],
  },
  include: [
    join(ROOT, "src/lib/pricing/engine.ts"),
    join(ROOT, "src/lib/pricing/resolve.ts"),
  ],
}));
execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });

// module hook: "@/x" → compiled tree; "server-only" → empty stub
const stub = join(tmp, "server-only-stub.js");
writeFileSync(stub, "module.exports = {};\n");
const req = createRequire(join(ROOT, "package.json"));
const Module = req("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return stub;
  if (request.startsWith("@/")) return origResolve.call(this, join(out, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};

const { calculateQuote } = req(join(out, "lib/pricing/engine.js"));
const resolve = req(join(out, "lib/pricing/resolve.js"));
const rules = req(join(out, "lib/rates/rules.js"));

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };

// ============================================================
// Part A — pure resolution rules
// ============================================================
{
  assert.equal(resolve.applyPlanAdjustment("derived_percentage", 500, -10), 450);
  assert.equal(resolve.applyPlanAdjustment("derived_percentage", 500, 15), 575);
  assert.equal(resolve.applyPlanAdjustment("derived_fixed", 500, -50), 450);
  assert.equal(resolve.applyPlanAdjustment("derived_fixed", 500, 100), 600);
  assert.equal(resolve.applyPlanAdjustment("derived_percentage", 333.33, -10), 300); // 299.997 → cents
  ok("applyPlanAdjustment: percentage ±, fixed ±, cents rounding");
}
{
  const r1 = resolve.resolveNightPrice({ kind: "derived_percentage", overridePrice: 480, parentResolved: 500, planAdjustment: -10, assignmentAdjustment: null, basePrice: 500, basePriceSource: "base_plan_rate" });
  assert.equal(r1.price, 480);
  assert.equal(r1.source, "plan_unit_date_override");
  const r2 = resolve.resolveNightPrice({ kind: "independent", overridePrice: null, parentResolved: null, planAdjustment: null, assignmentAdjustment: null, basePrice: 500, basePriceSource: "base_plan_rate" });
  assert.equal(r2.price, null); // no hidden fallback to base
  const r3 = resolve.resolveNightPrice({ kind: "base", overridePrice: null, parentResolved: null, planAdjustment: null, assignmentAdjustment: null, basePrice: 400, basePriceSource: "room_type_base_price" });
  assert.equal(r3.price, 400);
  assert.equal(r3.source, "room_type_base_price");
  const r4 = resolve.resolveNightPrice({ kind: "derived_fixed", overridePrice: null, parentResolved: 500, planAdjustment: -10, assignmentAdjustment: -20, basePrice: 500, basePriceSource: "base_plan_rate" });
  assert.equal(r4.price, 480);
  assert.equal(r4.adjustmentSource, "assignment_adjustment");
  ok("resolveNightPrice: override > assignment adj > plan adj; independent never falls back");
}
{
  const mk = (id, parent) => [id, { id, parentPlanId: parent, planKind: parent ? "derived_fixed" : "base", isActive: true, isArchived: false }];
  const cyc = new Map([mk("a", "b"), mk("b", "a")]);
  assert.equal(resolve.resolveParentChain(cyc, "a").error, "RATE_PLAN_CYCLE");
  assert.equal(resolve.resolveParentChain(new Map(), "x").error, "RATE_PLAN_NOT_FOUND");
  const lin = new Map([mk("a", "b"), mk("b", null)]);
  const { chain, error } = resolve.resolveParentChain(lin, "a");
  assert.equal(error, null);
  assert.deepEqual(chain.map((p) => p.id), ["a", "b"]);
  ok("resolveParentChain: linear chain, cycle and missing-plan detection");
}
{
  const base = new Map([["2027-03-10", { date: "2027-03-10", price: null, min_stay_through: 2, min_stay_arrival: null, max_stay: 10, closed_to_arrival: false, closed_to_departure: false, stop_sell: true }]]);
  const overlay = new Map([["2027-03-10", { date: "2027-03-10", price: null, min_stay_through: 3, min_stay_arrival: 2, max_stay: 5, closed_to_arrival: false, closed_to_departure: false, stop_sell: false }]]);
  const plan = { defaultClosedToArrival: true, defaultClosedToDeparture: false };
  const m = resolve.mergeRestrictionRows(["2027-03-10", "2027-03-11"], base, overlay, plan);
  const d0 = m.get("2027-03-10");
  assert.equal(d0.min_stay_through, 3); // strictest of layers
  assert.equal(d0.max_stay, 5);
  assert.equal(d0.stop_sell, true); // base stop_sell can never be opened by a plan
  assert.equal(d0.closed_to_arrival, false); // explicit overlay row overrides the plan default
  const d1 = m.get("2027-03-11"); // no rows → plan defaults apply
  assert.equal(d1.closed_to_arrival, true);
  ok("mergeRestrictionRows: strictest-wins merge; plan can tighten but never open the base");
}
{
  const plan = {
    id: "p", validFrom: null, validUntil: "2027-03-10", minAdvanceDays: null, maxAdvanceDays: null,
    allowedCheckinDays: null, defaultMinStay: null, defaultMaxStay: null,
  };
  const stay = { checkIn: "2027-03-10", checkOut: "2027-03-12", nights: ["2027-03-10", "2027-03-11"] };
  assert.equal(resolve.planStayRuleViolation(plan, stay, "2026-07-06").code, "RATE_PLAN_OUTSIDE_VALIDITY");
  assert.equal(resolve.planStayRuleViolation({ ...plan, validUntil: null, minAdvanceDays: 9999 }, stay, "2026-07-06").code, "ADVANCE_BOOKING_RULE_FAILED");
  const dow = resolve.planStayRuleViolation({ ...plan, validUntil: null, allowedCheckinDays: [5] }, stay, "2026-07-06");
  assert.equal(dow === null ? null : dow.code, "ARRIVAL_DAY_NOT_ALLOWED"); // 2027-03-10 is a Wednesday (dow 3)
  assert.equal(resolve.planStayRuleViolation({ ...plan, validUntil: null, defaultMinStay: 3 }, stay, "2026-07-06").code, "MIN_STAY_NOT_MET");
  assert.equal(resolve.planStayRuleViolation({ ...plan, validUntil: null, defaultMaxStay: 1 }, stay, "2026-07-06").code, "MAX_STAY_EXCEEDED");
  assert.equal(resolve.planStayRuleViolation({ ...plan, validUntil: null }, stay, "2026-07-06"), null);
  ok("planStayRuleViolation: validity, booking window, arrival DOW, plan min/max stay");
}
{
  const byDate = rules.indexByDate([
    { date: "2027-03-10", price: null, min_stay_through: null, min_stay_arrival: 3, max_stay: null, closed_to_arrival: false, closed_to_departure: false, stop_sell: false },
  ]);
  const stay = { checkIn: "2027-03-10", checkOut: "2027-03-12", nights: ["2027-03-10", "2027-03-11"] };
  const v = rules.stayRestrictionViolationStructured(byDate, stay);
  assert.equal(v.code, "MIN_STAY_NOT_MET");
  assert.equal(v.scope, "arrival");
  // the message face must equal the historical grid wording
  assert.equal(rules.stayViolationMessage(v), "מינימום 3 לילות בהגעה בתאריך זה");
  assert.equal(rules.stayRestrictionViolation(byDate, stay), "מינימום 3 לילות בהגעה בתאריך זה");
  ok("structured stay validator and the Hebrew wrapper stay equivalent");
}
{
  assert.equal(resolve.planFormulaLabel({ planKind: "base", adjustmentValue: null }, null), "מחיר בסיס");
  assert.equal(resolve.planFormulaLabel({ planKind: "independent", adjustmentValue: null }, null), "מחיר עצמאי");
  assert.equal(resolve.planFormulaLabel({ planKind: "derived_percentage", adjustmentValue: -10 }, "גמיש"), "10%- מגמיש");
  assert.equal(resolve.planFormulaLabel({ planKind: "derived_fixed", adjustmentValue: 50 }, "בסיס"), "₪50+ ללילה מבסיס");
  ok("planFormulaLabel explains every kind in Hebrew (never raw enums)");
}

// ============================================================
// Part B — end-to-end quotes on the test DB (rolled back)
// ============================================================
const postgres = req("postgres");
const sql = postgres(TEST_URL, { prepare: false, max: 1 });

class Rollback extends Error {}
const IN = "2027-03-10", OUT = "2027-03-12"; // 2 nights, far-future

async function buildFixture(tx) {
  const uniq = (p) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const [tenant] = await tx`
    INSERT INTO guesthub.tenants (name, slug, timezone, currency, settings)
    VALUES ('בדיקת מנוע תמחור', ${uniq("pricing-check")}, 'Asia/Jerusalem', 'ILS',
      ${tx.json({
        vat_rate: 18,
        extra_guest: {
          configured: true, extra_adult: 100, extra_child: 50, extra_infant: 0,
          charge_frequency: "per_night", infant_max_age: 2, child_max_age: 12,
          infants_count_occupancy: false, infants_use_included: false,
          tax_mode: "inclusive", rounding_mode: "none", rounding_increment: 1,
        },
      })})
    RETURNING id`;
  const T = tenant.id;
  const [rt] = await tx`
    INSERT INTO guesthub.room_types (tenant_id, name, base_price)
    VALUES (${T}, 'סוג בדיקה', 400) RETURNING id`;

  const mkRoom = async (num, extra = {}) => {
    const [r] = await tx`
      INSERT INTO guesthub.rooms ${tx({
        tenant_id: T, room_type_id: rt.id, room_number: num, name: `חדר ${num}`,
        status: "available", is_active: true,
        max_occupancy: 4, max_adults: 3, max_children: 2, max_infants: 1,
        min_occupancy: 1, included_occupancy: 2, default_occupancy: 4,
        extra_guest_pricing_mode: "inherit",
        ...extra,
      })} RETURNING id`;
    const [su] = await tx`
      INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id)
      VALUES (${T}, ${num}, ${`יחידה ${num}`}, ${rt.id}) RETURNING id`;
    await tx`
      INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id)
      VALUES (${T}, ${su.id}, ${r.id})`;
    const [bp] = await tx`
      INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base, plan_kind)
      VALUES (${T}, ${su.id}, 'base', 'מחיר בסיס', true, 'base') RETURNING id`;
    return { roomId: r.id, suId: su.id, basePlanId: bp.id };
  };

  const R1 = await mkRoom("901");
  const R2 = await mkRoom("902");
  const R3 = await mkRoom("903", { max_infants: 0 });
  const R4 = await mkRoom("904", { included_occupancy: null });

  const rate = (unit, plan, date, price) => tx`
    INSERT INTO guesthub.pricing_plan_rates (tenant_id, sellable_unit_id, pricing_plan_id, date, price)
    VALUES (${T}, ${unit}, ${plan}, ${date}, ${price})`;
  await rate(R1.suId, R1.basePlanId, IN, 500);
  await rate(R1.suId, R1.basePlanId, "2027-03-11", 520);
  await rate(R2.suId, R2.basePlanId, IN, 500); // 03-11 intentionally missing → rt fallback 400
  await rate(R3.suId, R3.basePlanId, IN, 500);
  await rate(R3.suId, R3.basePlanId, "2027-03-11", 520);
  await rate(R4.suId, R4.basePlanId, IN, 500);
  await rate(R4.suId, R4.basePlanId, "2027-03-11", 520);

  const mkPlan = async (fields) => {
    const [p] = await tx`
      INSERT INTO guesthub.pricing_plans ${tx({
        tenant_id: T, sellable_unit_id: null, is_base: false, is_active: true, ...fields,
      })} RETURNING id`;
    return p.id;
  };
  const FLEX = await mkPlan({ code: "flex", name: "גמיש", plan_kind: "base" });
  const NR = await mkPlan({ code: "nr", name: "ללא החזר", plan_kind: "derived_percentage", parent_plan_id: FLEX, adjustment_value: -10 });
  const FIX50 = await mkPlan({ code: "fix50", name: "פרימיום", plan_kind: "derived_fixed", parent_plan_id: FLEX, adjustment_value: 50 });
  const INDY = await mkPlan({ code: "indy", name: "עצמאי", plan_kind: "independent" });

  const assign = (plan, unit, extra = {}) => tx`
    INSERT INTO guesthub.pricing_plan_units ${tx({
      tenant_id: T, pricing_plan_id: plan, sellable_unit_id: unit, is_active: true, ...extra,
    })}`;
  for (const u of [R1, R2, R3, R4]) await assign(FLEX, u.suId);
  await assign(NR, R1.suId);
  await assign(NR, R2.suId);
  await assign(FIX50, R1.suId);
  await assign(INDY, R1.suId);
  await tx`
    INSERT INTO guesthub.pricing_plan_unit_rates (tenant_id, pricing_plan_id, sellable_unit_id, date, price)
    VALUES (${T}, ${INDY}, ${R1.suId}, ${IN}, 600), (${T}, ${INDY}, ${R1.suId}, '2027-03-11', 600)`;

  return { T, rt: rt.id, R1, R2, R3, R4, FLEX, NR, FIX50, INDY };
}

const quoteFor = (tx, f, rooms, extra = {}) =>
  calculateQuote(tx, { tenantId: f.T, checkIn: IN, checkOut: OUT, rooms, source: "internal", ...extra });
const guests = { adults: 2, children: 0, infants: 0 };
const codes = (rq) => rq.errors.map((e) => e.code);

// scenario isolation: mutations run inside a savepoint that always rolls back
async function scenario(tx, fn) {
  try {
    await tx.savepoint(async (sp) => { await fn(sp); throw new Rollback(); });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

try {
  await sql.begin(async (tx) => {
    const f = await buildFixture(tx);

    // 8. base plan: explicit nightly prices, checkout excluded
    {
      const q = await quoteFor(tx, f, [{ roomId: f.R1.roomId, ratePlanId: f.FLEX, ...guests }]);
      assert.equal(q.valid, true);
      assert.equal(q.numberOfNights, 2);
      const r = q.rooms[0];
      assert.deepEqual(r.nights.map((x) => x.resolvedPlanPrice), [500, 520]);
      assert.deepEqual(r.nights.map((x) => x.priceSource), ["base_plan_rate", "base_plan_rate"]);
      assert.equal(r.roomSubtotal, 1020);
      assert.equal(q.totalGross, 1020);
      ok("engine: base plan resolves explicit nightly prices; checkout night not charged");
    }
    // 9. room_type base_price fallback carries its source
    {
      const q = await quoteFor(tx, f, [{ roomId: f.R2.roomId, ratePlanId: f.FLEX, ...guests }]);
      const r = q.rooms[0];
      assert.equal(r.nights[1].resolvedPlanPrice, 400);
      assert.equal(r.nights[1].priceSource, "room_type_base_price");
      assert.equal(r.roomSubtotal, 900);
      ok("engine: missing base row falls back to room_types.base_price with the honest source");
    }
    // 10. derived percentage −10% + VAT-inclusive extraction
    {
      const q = await quoteFor(tx, f, [{ roomId: f.R1.roomId, ratePlanId: f.NR, ...guests }]);
      const r = q.rooms[0];
      assert.equal(q.valid, true);
      assert.deepEqual(r.nights.map((x) => x.resolvedPlanPrice), [450, 468]);
      assert.deepEqual(r.nights.map((x) => x.parentResolvedPrice), [500, 520]);
      assert.equal(r.nights[0].priceSource, "derived_from_parent_plan");
      assert.equal(r.nights[0].adjustmentValue, -10);
      assert.equal(r.nights[0].adjustmentSource, "plan_adjustment");
      assert.equal(q.totalGross, 918);
      assert.equal(q.vatRate, 18);
      assert.equal(q.vatAmount, 140); // included VAT, whole-currency (lib/vat.ts rule)
      assert.equal(q.subtotalNet, 778);
      assert.equal(q.priceIncludesVat, true);
      ok("engine: derived_percentage resolves from parent; VAT extracted from gross");
    }
    // 11. derived fixed +50
    {
      const q = await quoteFor(tx, f, [{ roomId: f.R1.roomId, ratePlanId: f.FIX50, ...guests }]);
      assert.deepEqual(q.rooms[0].nights.map((x) => x.resolvedPlanPrice), [550, 570]);
      ok("engine: derived_fixed adds the nightly amount (adjustment, not a fixed final price)");
    }
    // 12. independent uses its own rows; a missing date makes it unavailable
    {
      const q = await quoteFor(tx, f, [{ roomId: f.R1.roomId, ratePlanId: f.INDY, ...guests }]);
      assert.equal(q.valid, true);
      assert.deepEqual(q.rooms[0].nights.map((x) => x.priceSource), ["independent_plan_price", "independent_plan_price"]);
      assert.equal(q.rooms[0].roomSubtotal, 1200);
      await scenario(tx, async (sp) => {
        await sp`DELETE FROM guesthub.pricing_plan_unit_rates
                 WHERE pricing_plan_id = ${f.INDY} AND date = '2027-03-11'`;
        const q2 = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.INDY, ...guests }]);
        assert.equal(q2.valid, false);
        assert.ok(codes(q2.rooms[0]).includes("NO_PRICE_FOR_DATE"));
        assert.ok(q2.rooms[0].errors.some((e) => e.date === "2027-03-11"));
      });
      ok("engine: independent plan prices from its own rows; missing date → NO_PRICE_FOR_DATE, no silent fallback");
    }
    // 13. exact-date override beats derivation
    await scenario(tx, async (sp) => {
      await sp`INSERT INTO guesthub.pricing_plan_unit_rates
        (tenant_id, pricing_plan_id, sellable_unit_id, date, price)
        VALUES (${f.T}, ${f.NR}, ${f.R1.suId}, ${IN}, 480)`;
      const q = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.NR, ...guests }]);
      assert.equal(q.rooms[0].nights[0].resolvedPlanPrice, 480);
      assert.equal(q.rooms[0].nights[0].priceSource, "plan_unit_date_override");
      assert.equal(q.rooms[0].nights[1].resolvedPlanPrice, 468); // other night still derived
      ok("engine: exact (plan, unit, date) override wins over the derivation formula");
    });
    // 14. per-unit assignment adjustment beats the plan adjustment
    await scenario(tx, async (sp) => {
      await sp`UPDATE guesthub.pricing_plan_units SET adjustment_value = -20
               WHERE pricing_plan_id = ${f.NR} AND sellable_unit_id = ${f.R1.suId}`;
      const q = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.NR, ...guests }]);
      assert.deepEqual(q.rooms[0].nights.map((x) => x.resolvedPlanPrice), [400, 416]);
      assert.equal(q.rooms[0].nights[0].adjustmentSource, "assignment_adjustment");
      ok("engine: room-assignment adjustment overrides the plan default adjustment");
    });
    // 15. disabled parent blocks derived quotes — no hidden fallback
    await scenario(tx, async (sp) => {
      await sp`UPDATE guesthub.pricing_plans SET is_active = false WHERE id = ${f.FLEX}`;
      const q = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.NR, ...guests }]);
      assert.equal(q.valid, false);
      assert.ok(codes(q.rooms[0]).includes("RATE_PLAN_PARENT_INACTIVE"));
      ok("engine: a disabled parent makes dependent plans unavailable");
    });
    // 16. assignment rules
    {
      const q = await quoteFor(tx, f, [{ roomId: f.R3.roomId, ratePlanId: f.NR, ...guests }]);
      assert.ok(codes(q.rooms[0]).includes("RATE_PLAN_NOT_ASSIGNED"));
      await scenario(tx, async (sp) => {
        await sp`UPDATE guesthub.pricing_plan_units SET is_active = false
                 WHERE pricing_plan_id = ${f.NR} AND sellable_unit_id = ${f.R1.suId}`;
        const q2 = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.NR, ...guests }]);
        assert.ok(codes(q2.rooms[0]).includes("RATE_PLAN_NOT_ASSIGNED"));
      });
      await scenario(tx, async (sp) => {
        await sp`UPDATE guesthub.pricing_plan_units SET valid_until = '2027-01-01'
                 WHERE pricing_plan_id = ${f.NR} AND sellable_unit_id = ${f.R1.suId}`;
        const q3 = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.NR, ...guests }]);
        assert.ok(codes(q3.rooms[0]).includes("RATE_PLAN_NOT_ASSIGNED"));
      });
      ok("engine: unassigned / inactive / out-of-validity assignments cannot be quoted");
    }
    // 17-19. plan-level rules
    await scenario(tx, async (sp) => {
      await sp`UPDATE guesthub.pricing_plans SET valid_until = '2027-01-01' WHERE id = ${f.NR}`;
      const q = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.NR, ...guests }]);
      assert.ok(codes(q.rooms[0]).includes("RATE_PLAN_OUTSIDE_VALIDITY"));
      ok("engine: expired plan validity rejects the stay");
    });
    await scenario(tx, async (sp) => {
      await sp`UPDATE guesthub.pricing_plans SET min_advance_days = 9999 WHERE id = ${f.NR}`;
      const q = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.NR, ...guests }]);
      assert.ok(codes(q.rooms[0]).includes("ADVANCE_BOOKING_RULE_FAILED"));
      ok("engine: booking-window rule enforced");
    });
    await scenario(tx, async (sp) => {
      // 2027-03-10 is a Wednesday (dow 3) — allow only Friday arrivals
      await sp`UPDATE guesthub.pricing_plans SET allowed_checkin_days = '{5}' WHERE id = ${f.NR}`;
      const q = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.NR, ...guests }]);
      assert.ok(codes(q.rooms[0]).includes("ARRIVAL_DAY_NOT_ALLOWED"));
      ok("engine: arrival day-of-week rule enforced");
    });
    // 20. date-level restrictions through the shared validator
    await scenario(tx, async (sp) => {
      await sp`UPDATE guesthub.pricing_plan_rates SET min_stay_arrival = 3
               WHERE pricing_plan_id = ${f.R1.basePlanId} AND date = ${IN}`;
      const q = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.FLEX, ...guests }]);
      assert.ok(codes(q.rooms[0]).includes("MIN_STAY_NOT_MET"));
      ok("engine: base-layer min-stay applies to every plan on the room");
    });
    await scenario(tx, async (sp) => {
      await sp`INSERT INTO guesthub.pricing_plan_unit_rates
        (tenant_id, pricing_plan_id, sellable_unit_id, date, stop_sell)
        VALUES (${f.T}, ${f.NR}, ${f.R1.suId}, ${IN}, true)`;
      const q = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.NR, ...guests }]);
      assert.ok(codes(q.rooms[0]).includes("ROOM_CLOSED"));
      const qFlex = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.FLEX, ...guests }]);
      assert.equal(qFlex.valid, true); // the overlay closed only THAT plan
      ok("engine: plan-level stop_sell closes only that plan; others stay sellable");
    });
    await scenario(tx, async (sp) => {
      await sp`UPDATE guesthub.pricing_plan_rates SET closed_to_arrival = true
               WHERE pricing_plan_id = ${f.R1.basePlanId} AND date = ${IN}`;
      const q = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.FLEX, ...guests }]);
      assert.ok(codes(q.rooms[0]).includes("CLOSED_ON_ARRIVAL"));
      ok("engine: closed-to-arrival on the check-in date rejects the stay");
    });
    await scenario(tx, async (sp) => {
      await sp`INSERT INTO guesthub.pricing_plan_rates
        (tenant_id, sellable_unit_id, pricing_plan_id, date, closed_to_departure)
        VALUES (${f.T}, ${f.R1.suId}, ${f.R1.basePlanId}, ${OUT}, true)`;
      const q = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.FLEX, ...guests }]);
      assert.ok(codes(q.rooms[0]).includes("CLOSED_ON_DEPARTURE"));
      ok("engine: closed-to-departure evaluated on the check-out date");
    });
    // 21. occupancy limits
    {
      const q1 = await quoteFor(tx, f, [{ roomId: f.R1.roomId, ratePlanId: f.FLEX, adults: 5, children: 0, infants: 0 }]);
      assert.ok(codes(q1.rooms[0]).includes("ADULT_LIMIT_EXCEEDED"));
      assert.ok(codes(q1.rooms[0]).includes("OCCUPANCY_EXCEEDED"));
      const q2 = await quoteFor(tx, f, [{ roomId: f.R3.roomId, ratePlanId: f.FLEX, adults: 2, children: 0, infants: 1 }]);
      assert.ok(codes(q2.rooms[0]).includes("INFANT_LIMIT_EXCEEDED"));
      await scenario(tx, async (sp) => {
        await sp`UPDATE guesthub.rooms SET min_occupancy = 3 WHERE id = ${f.R1.roomId}`;
        const q3 = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.FLEX, adults: 2, children: 0, infants: 0 }]);
        assert.ok(codes(q3.rooms[0]).includes("OCCUPANCY_BELOW_MINIMUM"));
      });
      ok("engine: occupancy caps per category + zero-infant rooms + minimum occupancy");
    }
    // 22. extra guests — canonical mechanism, included_occupancy is the threshold
    {
      const q = await quoteFor(tx, f, [{ roomId: f.R1.roomId, ratePlanId: f.FLEX, adults: 3, children: 0, infants: 0 }]);
      const r = q.rooms[0];
      assert.equal(q.valid, true);
      assert.equal(r.extraAdults, 1); // included_occupancy=2, NOT default_occupancy=4
      assert.equal(r.extraGuestPerNight, 100);
      assert.equal(r.extraGuestSource, "property_default");
      assert.equal(r.extraGuestTotal, 200);
      assert.equal(r.roomSubtotal, 1220); // (500+100)+(520+100)
      await scenario(tx, async (sp) => {
        await sp`UPDATE guesthub.rooms SET extra_guest_pricing_mode = 'override', extra_adult_override = 80
                 WHERE id = ${f.R1.roomId}`;
        const q2 = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.FLEX, adults: 3, children: 0, infants: 0 }]);
        assert.equal(q2.rooms[0].extraGuestPerNight, 80);
        assert.equal(q2.rooms[0].extraGuestSource, "room_override");
      });
      ok("engine: extra guests charged above included_occupancy via the canonical resolver (room override honored)");
    }
    // 23. extra-guest fail-closed
    {
      const q = await quoteFor(tx, f, [{ roomId: f.R4.roomId, ratePlanId: f.FLEX, ...guests }]);
      assert.ok(codes(q.rooms[0]).includes("EXTRA_GUEST_PRICING_INCOMPLETE")); // included_occupancy NULL
      await scenario(tx, async (sp) => {
        await sp`UPDATE guesthub.tenants SET settings = settings - 'extra_guest' WHERE id = ${f.T}`;
        const q2 = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.FLEX, adults: 3, children: 0, infants: 0 }]);
        assert.equal(q2.valid, false);
        assert.ok(codes(q2.rooms[0]).includes("EXTRA_GUEST_PRICING_INCOMPLETE"));
      });
      ok("engine: incomplete extra-guest configuration fails closed, never a silent ₪0");
    }
    // 24. physical availability — plans never multiply inventory
    await scenario(tx, async (sp) => {
      const [res] = await sp`
        INSERT INTO guesthub.reservations (tenant_id, reservation_number, status, check_in, check_out)
        VALUES (${f.T}, 'CHK-ENGINE-1', 'confirmed', ${IN}, ${OUT}) RETURNING id`;
      await sp`
        INSERT INTO guesthub.reservation_rooms (tenant_id, reservation_id, room_id, check_in, check_out)
        VALUES (${f.T}, ${res.id}, ${f.R1.roomId}, ${IN}, ${OUT})`;
      for (const plan of [f.FLEX, f.NR]) {
        const q = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: plan, ...guests }]);
        assert.equal(q.valid, false);
        assert.ok(codes(q.rooms[0]).includes("ROOM_UNAVAILABLE"));
        assert.equal(q.rooms[0].available, false);
      }
      // back-to-back stay (checkout = existing check-in) does NOT conflict
      const q2 = await calculateQuote(sp, {
        tenantId: f.T, checkIn: "2027-03-08", checkOut: IN,
        rooms: [{ roomId: f.R1.roomId, ratePlanId: f.FLEX, ...guests }], source: "internal",
      });
      assert.equal(q2.rooms[0].available, true);
      ok("engine: one reservation blocks the room under EVERY plan (no inventory multiplication); half-open overlap honored");
    });
    await scenario(tx, async (sp) => {
      await sp`INSERT INTO guesthub.room_closures (tenant_id, room_id, start_date, end_date, reason)
               VALUES (${f.T}, ${f.R1.roomId}, ${IN}, ${OUT}, 'בדיקה')`;
      const q = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.FLEX, ...guests }]);
      assert.ok(codes(q.rooms[0]).includes("ROOM_CLOSED"));
      ok("engine: a physical closure blocks the quote");
    });
    await scenario(tx, async (sp) => {
      await sp`UPDATE guesthub.rooms SET status = 'out_of_order' WHERE id = ${f.R1.roomId}`;
      const q = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.FLEX, ...guests }]);
      assert.ok(codes(q.rooms[0]).includes("ROOM_OUT_OF_ORDER"));
      await sp`UPDATE guesthub.rooms SET status = 'inactive' WHERE id = ${f.R1.roomId}`;
      const q2 = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.FLEX, ...guests }]);
      assert.ok(codes(q2.rooms[0]).includes("ROOM_INACTIVE"));
      ok("engine: out-of-order / inactive rooms cannot be sold under any plan");
    });
    // 25. duplicate room selection
    {
      const q = await quoteFor(tx, f, [
        { roomId: f.R1.roomId, ratePlanId: f.FLEX, ...guests },
        { roomId: f.R1.roomId, ratePlanId: f.NR, ...guests },
      ]);
      assert.equal(q.valid, false);
      assert.ok(codes(q.rooms[1]).includes("ROOM_DUPLICATED"));
      ok("engine: the same physical room cannot appear twice in one quote");
    }
    // 26. multi-room: separate totals, combined = exact sum, never averaged
    {
      const q = await quoteFor(tx, f, [
        { roomId: f.R1.roomId, ratePlanId: f.NR, ...guests },
        { roomId: f.R2.roomId, ratePlanId: f.FLEX, ...guests },
      ]);
      assert.equal(q.valid, true);
      assert.equal(q.rooms[0].roomSubtotal, 918);
      assert.equal(q.rooms[1].roomSubtotal, 900);
      assert.equal(q.totalGross, 1818);
      ok("engine: multi-room quote keeps per-room totals and sums exactly");
    }
    // 27. VAT modes from tenant settings
    await scenario(tx, async (sp) => {
      await sp`UPDATE guesthub.tenants
               SET settings = jsonb_set(settings, '{vat_rate}', '0') WHERE id = ${f.T}`;
      const q = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.FLEX, ...guests }]);
      assert.equal(q.vatAmount, 0);
      assert.equal(q.subtotalNet, q.totalGross);
      await sp`UPDATE guesthub.tenants
               SET settings = jsonb_set(settings, '{vat_rate}', '17') WHERE id = ${f.T}`;
      const q2 = await quoteFor(sp, f, [{ roomId: f.R1.roomId, ratePlanId: f.FLEX, ...guests }]);
      assert.equal(q2.vatRate, 17);
      assert.equal(q2.vatAmount, Math.round(1020 - 1020 / 1.17));
      ok("engine: VAT rate (incl. zero/exempt) comes from tenant settings, one implementation");
    });
    // 28. fingerprint determinism
    {
      const req1 = [{ roomId: f.R1.roomId, ratePlanId: f.NR, ...guests }];
      const a = await quoteFor(tx, f, req1);
      const b = await quoteFor(tx, f, req1);
      assert.equal(a.quoteFingerprint, b.quoteFingerprint);
      assert.ok(/^[0-9a-f]{64}$/.test(a.quoteFingerprint));
      await scenario(tx, async (sp) => {
        await sp`UPDATE guesthub.pricing_plan_rates SET price = 999
                 WHERE pricing_plan_id = ${f.R1.basePlanId} AND date = ${IN}`;
        const c = await quoteFor(sp, f, req1);
        assert.notEqual(c.quoteFingerprint, a.quoteFingerprint);
      });
      ok("engine: fingerprint stable for identical inputs, changes when a price source changes");
    }
    // 29. tenant isolation
    {
      const [t2] = await tx`
        INSERT INTO guesthub.tenants (name, slug) VALUES ('נכס אחר', ${"iso-" + Date.now()}) RETURNING id`;
      const [foreignRoom] = await tx`
        INSERT INTO guesthub.rooms (tenant_id, room_number, max_occupancy, max_adults)
        VALUES (${t2.id}, '999', 2, 2) RETURNING id`;
      const q = await quoteFor(tx, f, [{ roomId: foreignRoom.id, ratePlanId: f.FLEX, ...guests }]);
      assert.ok(codes(q.rooms[0]).includes("ROOM_NOT_FOUND"));
      const [foreignPlan] = await tx`
        INSERT INTO guesthub.pricing_plans (tenant_id, code, name, plan_kind)
        VALUES (${t2.id}, 'other', 'זר', 'base') RETURNING id`;
      const q2 = await quoteFor(tx, f, [{ roomId: f.R1.roomId, ratePlanId: foreignPlan.id, ...guests }]);
      assert.ok(codes(q2.rooms[0]).includes("RATE_PLAN_NOT_FOUND"));
      ok("engine: cross-tenant rooms and plans are invisible (NOT_FOUND, never priced)");
    }
    // 30-31. request-level guards
    {
      const q = await quoteFor(tx, f, [{ roomId: f.R1.roomId, ratePlanId: f.FLEX, ...guests }], { requestedCurrency: "USD" });
      assert.equal(q.valid, false);
      assert.equal(q.errors[0].code, "CURRENCY_MISMATCH");
      const q2 = await calculateQuote(tx, {
        tenantId: f.T, checkIn: IN, checkOut: IN,
        rooms: [{ roomId: f.R1.roomId, ratePlanId: f.FLEX, ...guests }], source: "internal",
      });
      assert.equal(q2.errors[0].code, "INVALID_DATE_RANGE");
      const q3 = await calculateQuote(tx, {
        tenantId: f.T, checkIn: "2027-01-01", checkOut: "2027-06-01",
        rooms: [{ roomId: f.R1.roomId, ratePlanId: f.FLEX, ...guests }], source: "internal",
      });
      assert.equal(q3.errors[0].code, "QUOTE_WINDOW_EXCEEDED");
      ok("engine: currency mismatch, invalid range and quote-window guards are structured errors");
    }

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
} finally {
  await sql.end();
}

console.log(`\nALL ${n} PRICING-ENGINE CHECKS PASSED (nothing committed)`);
