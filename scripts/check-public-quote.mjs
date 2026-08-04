#!/usr/bin/env node
// ============================================================
// check:public-quote — the price the PUBLIC site reads to a guest is THE
// engine's price (D106; audit §ז' #2 closed).
//
// Before V2 the public quote came from effective_sell_state sums while the
// booking committed engine prices — two calculations for one transaction.
// This guard proves, against the isolated test DB and the REAL compiled
// modules, that:
//   1. publicAvailability's quoted totalPrice equals calculateReservationPrice
//      for the same unit/occupancy — including money ESS cannot see
//      (extra-guest surcharge), which pins that the engine number WON;
//   2. the quote equals what priceReservationStays (the booking seam) would
//      commit — quote ≡ charge;
//   3. a tenant-default LOS tier shows up identically in both.
//
// Nothing committed: one transaction, always rolled back.
// ============================================================
import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (TEST_URL.includes(marker)) {
    console.error(`REFUSED: TEST_DATABASE_URL contains production marker "${marker}"`);
    process.exit(1);
  }
}
process.env.DATABASE_URL = TEST_URL;

const psql = (sqlText) =>
  execSync(`psql "${TEST_URL}" -tA -v ON_ERROR_STOP=1`,
    { input: sqlText, cwd: ROOT, shell: "/bin/bash" }).toString().trim();

// schema bootstrap: full chain only when the schema is absent (a restored copy
// is used as-is — this guard never mutates outside its rolled-back tx)
if (psql(`SELECT to_regclass('guesthub.reservations') IS NULL`) === "t") {
  console.log("applying migration chain to the test DB…");
  for (const f of readdirSync(join(ROOT, "db/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
    execSync(
      `psql "${TEST_URL}" -q -v ON_ERROR_STOP=1 < "db/migrations/${f}"`,
      { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" },
    );
  }
}

// ---- compile the real modules (tsc → CJS) ----
console.log("compiling public-booking availability + pricing seam via tsc…");
const tmp = mkdtempSync(join(tmpdir(), "gh-pubquote-"));
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
    join(ROOT, "src/lib/public-booking/availability.ts"),
    join(ROOT, "src/lib/pricing/engine.ts"),
    join(ROOT, "src/lib/pricing/reservation-pricing.ts"),
  ],
}));
execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });
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

const FIXED_TENANT = "0b00c0de-0000-4000-8000-00000000d106";
process.env.PUBLIC_BOOKING_TENANT_ID = FIXED_TENANT; // read by config.ts at require time

const { publicAvailability } = req(join(out, "lib/public-booking/availability.js"));
const { calculateReservationPrice } = req(join(out, "lib/pricing/engine.js"));
const seam = req(join(out, "lib/pricing/reservation-pricing.js"));

const postgres = req("postgres");
const sql = postgres(TEST_URL, { prepare: false, max: 1 });
class Rollback extends Error {}

const IN = "2027-04-10", MID = "2027-04-11", OUT = "2027-04-12";
let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };

try {
  await sql.begin(async (tx) => {
    // ---- fixture: one public tenant, one type, two units, base rates ----
    await tx`
      INSERT INTO guesthub.tenants (id, name, slug, timezone, currency, settings)
      VALUES (${FIXED_TENANT}, 'ציטוט ציבורי', ${"pubquote-" + Date.now()}, 'Asia/Jerusalem', 'ILS',
        ${tx.json({
          vat_rate: 18,
          extra_guest: {
            configured: true, extra_adult: 100, extra_child: 50, extra_infant: 0,
            charge_frequency: "per_night", infant_max_age: 2, child_max_age: 12,
            infants_count_occupancy: false, infants_use_included: false,
            tax_mode: "inclusive", rounding_mode: "none", rounding_increment: 1,
          },
        })})`;
    const [rt] = await tx`
      INSERT INTO guesthub.room_types (tenant_id, name, base_price, max_occupancy)
      VALUES (${FIXED_TENANT}, 'סוג ציבורי', 400, 4) RETURNING id`;
    const mkUnit = async (num, rates) => {
      const [r] = await tx`
        INSERT INTO guesthub.rooms ${tx({
          tenant_id: FIXED_TENANT, room_type_id: rt.id, room_number: num, name: `חדר ${num}`,
          status: "available", is_active: true,
          max_occupancy: 4, max_adults: 3, max_children: 2, max_infants: 1,
          min_occupancy: 1, included_occupancy: 1, default_occupancy: 2,
          extra_guest_pricing_mode: "inherit",
        })} RETURNING id`;
      const [su] = await tx`
        INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id)
        VALUES (${FIXED_TENANT}, ${num}, ${`יחידה ${num}`}, ${rt.id}) RETURNING id`;
      await tx`
        INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id)
        VALUES (${FIXED_TENANT}, ${su.id}, ${r.id})`;
      const [bp] = await tx`
        INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base, plan_kind)
        VALUES (${FIXED_TENANT}, ${su.id}, 'base', 'מחיר בסיס', true, 'base') RETURNING id`;
      for (const [date, price] of rates) {
        await tx`
          INSERT INTO guesthub.pricing_plan_rates (tenant_id, sellable_unit_id, pricing_plan_id, date, price)
          VALUES (${FIXED_TENANT}, ${su.id}, ${bp.id}, ${date}, ${price})`;
      }
      return { roomId: r.id, suId: su.id };
    };
    const cheap = await mkUnit("801", [[IN, 500], [MID, 520]]);   // 1020 accommodation
    const dear = await mkUnit("802", [[IN, 700], [MID, 700]]);    // 1400 — never the "from" price

    // ---- 1. the quoted number is the ENGINE's, not the ESS sum ----
    // included_occupancy=1 + 2 adults ⇒ the engine adds ₪100 × 2 nights that
    // effective_sell_state can never see. The quote MUST carry it.
    const types = await publicAvailability(tx, IN, OUT);
    assert.equal(types.length, 1, "one room type visible");
    const t = types[0];
    assert.equal(t.availableUnits, 2, "both units pass availability");
    const engine = await calculateReservationPrice(tx, {
      tenantId: FIXED_TENANT, checkIn: IN, checkOut: OUT,
      rooms: [{ roomId: cheap.roomId, ratePlanId: null, adults: 2, children: 0, infants: 0, manualRatePerNight: null }],
      source: "website",
    });
    const rq = engine.rooms[0];
    assert.equal(rq.roomSubtotal, 1220, "engine: 1020 accommodation + 200 extra-guest");
    assert.equal(t.totalPrice, rq.roomSubtotal,
      `the public quote (${t.totalPrice}) IS the engine total (${rq.roomSubtotal})`);
    assert.notEqual(t.totalPrice, 1020, "…and NOT the raw ESS sum (1020)");
    ok("public quote = engine total, including extra-guest money ESS cannot see");

    // ---- 2. quote ≡ charge: the booking seam commits the same number ----
    const priced = await seam.priceReservationStays(tx, FIXED_TENANT, [{
      roomId: cheap.roomId, ratePlanId: null,
      checkIn: IN, checkOut: OUT, adults: 2, children: 0, infants: 0,
    }], { source: "website", enforceAvailability: true, enforceRestrictions: true });
    assert.equal(priced[0].priceTotal, t.totalPrice,
      "priceReservationStays (the booking write path) commits exactly the quoted price");
    ok("quote ≡ charge — the booking seam commits the quoted number");

    // ---- 3. automatic plan selection flows into both, identically ----
    // The LOS tier layer is gone (migration 063). A cheaper eligible plan
    // assigned to the unit is now what a long stay wins — and the public quote
    // must surface exactly the engine's selection, or the site quotes one
    // number and the booking charges another.
    const [flexPlan] = await tx`
      INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, plan_kind, is_active)
      VALUES (${FIXED_TENANT}, NULL, 'pq-flex', 'גמיש', 'base', true) RETURNING id`;
    const [nrPlan] = await tx`
      INSERT INTO guesthub.pricing_plans
        (tenant_id, sellable_unit_id, code, name, plan_kind, parent_plan_id, adjustment_value, is_active)
      VALUES (${FIXED_TENANT}, NULL, 'pq-nr', 'ללא החזר', 'derived_percentage', ${flexPlan.id}, -10, true)
      RETURNING id`;
    for (const u of [cheap, dear]) {
      for (const plan of [flexPlan, nrPlan]) {
        await tx`
          INSERT INTO guesthub.pricing_plan_units (tenant_id, pricing_plan_id, sellable_unit_id, is_active)
          VALUES (${FIXED_TENANT}, ${plan.id}, ${u.suId}, true)`;
      }
    }
    const typesSel = await publicAvailability(tx, IN, OUT);
    const engineSel = await calculateReservationPrice(tx, {
      tenantId: FIXED_TENANT, checkIn: IN, checkOut: OUT,
      rooms: [{ roomId: cheap.roomId, ratePlanId: null, adults: 2, children: 0, infants: 0, manualRatePerNight: null }],
      source: "website",
    });
    assert.equal(engineSel.rooms[0].planSelection?.selectedPlanId, nrPlan.id,
      "engine selects the cheaper eligible plan for the stay");
    assert.ok(engineSel.rooms[0].roomSubtotal < 1220, "the selected plan actually saves the guest money");
    assert.equal(typesSel[0].totalPrice, engineSel.rooms[0].roomSubtotal,
      "quote and engine agree with plan selection applied");
    const pricedSel = await seam.priceReservationStays(tx, FIXED_TENANT, [{
      roomId: cheap.roomId, ratePlanId: null,
      checkIn: IN, checkOut: OUT, adults: 2, children: 0, infants: 0,
    }], { source: "website", enforceAvailability: true, enforceRestrictions: true });
    assert.equal(pricedSel[0].priceTotal, typesSel[0].totalPrice,
      "the booking seam commits exactly the selected-plan price");
    ok("plan selection: one selection, one number — public quote, engine and booking seam agree");

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { await sql.end(); throw e; }
}
await sql.end();
console.log(`\nALL ${n} PUBLIC-QUOTE CHECKS PASSED — nothing committed`);
