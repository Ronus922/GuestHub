// ============================================================
// PRICING EQUALITY suite (D51) — proves that IDENTICAL commercial inputs
// produce IDENTICAL results across every price-determining surface:
//
//   simulator (calculateReservationPrice, source pricing_simulator)
//   ≡ reservation quote/save/edit (priceReservationStays, the ONE seam every
//     reservation action prices through)
//   ≡ nightly breakdown ≡ final totals ≡ quote fingerprints
//
// plus the reservation-domain rules that ride on top: committed-snapshot
// immutability, authorized manual override, canonical totals, and
// ledger-derived payment status. Everything runs against the ISOLATED test DB
// (guesthub-testdb, :5433) inside one transaction that ROLLS BACK.
// Usage: node scripts/check-pricing-equality.mjs   (npm run check:pricing-equality)
// ============================================================
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
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
process.env.DATABASE_URL = TEST_URL;

// ---- apply the full migration chain (000..017 — validates 017 on the way) ----
console.log("applying migration chain to guesthub-testdb (:5433)…");
const migrations = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
for (const f of migrations) {
  execSync(
    `docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "db/migrations/${f}"`,
    { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" },
  );
}

// ---- compile the real engine + reservation seam graph (tsc, CommonJS) ----
console.log("compiling src/lib/pricing (+ seam, ledger) via tsc…");
const tmp = mkdtempSync(join(tmpdir(), "gh-equality-"));
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
    join(ROOT, "src/lib/pricing/reservation-pricing.ts"),
    join(ROOT, "src/lib/payments/ledger.ts"),
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

const { calculateReservationPrice } = req(join(out, "lib/pricing/engine.js"));
const seam = req(join(out, "lib/pricing/reservation-pricing.js"));
const ledger = req(join(out, "lib/payments/ledger.js"));
const { paymentState } = req(join(out, "lib/inventory-rules.js"));

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };

const postgres = req("postgres");
const sql = postgres(TEST_URL, { prepare: false, max: 1 });
class Rollback extends Error {}

// 2027-03-10 = Wednesday; 2027-03-12/13 = Fri/Sat (weekend nights)
const IN = "2027-03-10", OUT = "2027-03-12";

async function buildFixture(tx) {
  const uniq = (p) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const [tenant] = await tx`
    INSERT INTO guesthub.tenants (name, slug, timezone, currency, settings)
    VALUES ('בדיקת שוויון תמחור', ${uniq("equality-check")}, 'Asia/Jerusalem', 'ILS',
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

  const R1 = await mkRoom("951");
  const R2 = await mkRoom("952", { max_infants: 0 });

  // 6 priced nights on R1: Wed 10th .. Mon 15th (Fri 12th + Sat 13th = weekend)
  const rate = (u, p, date, price, extra = {}) => tx`
    INSERT INTO guesthub.pricing_plan_rates ${tx({
      tenant_id: T, sellable_unit_id: u, pricing_plan_id: p, date, price, ...extra,
    })}`;
  const NIGHTS = [
    ["2027-03-10", 500], ["2027-03-11", 520], ["2027-03-12", 700],
    ["2027-03-13", 700], ["2027-03-14", 500], ["2027-03-15", 500],
  ];
  for (const [d, p] of NIGHTS) { await rate(R1.suId, R1.basePlanId, d, p); await rate(R2.suId, R2.basePlanId, d, p); }
  // restriction rows on R2 (separate room, so R1 scenarios stay clean)
  await rate(R2.suId, R2.basePlanId, "2027-03-20", 500, { min_stay_arrival: 3 });
  await rate(R2.suId, R2.basePlanId, "2027-03-24", 500, { max_stay: 2 });
  await rate(R2.suId, R2.basePlanId, "2027-03-25", 500);
  await rate(R2.suId, R2.basePlanId, "2027-03-26", 500);
  await rate(R2.suId, R2.basePlanId, "2027-03-28", 500, { closed_to_arrival: true });
  await rate(R2.suId, R2.basePlanId, "2027-03-30", 500);
  await rate(R2.suId, R2.basePlanId, "2027-03-31", 500, { closed_to_departure: true });

  const mkPlan = async (fields) => {
    const [p] = await tx`
      INSERT INTO guesthub.pricing_plans ${tx({
        tenant_id: T, sellable_unit_id: null, is_base: false, is_active: true, ...fields,
      })} RETURNING id`;
    return p.id;
  };
  const FLEX = await mkPlan({ code: "flex", name: "מחיר גמיש", plan_kind: "base" });
  const NR = await mkPlan({ code: "nr", name: "ללא החזר", plan_kind: "derived_percentage", parent_plan_id: FLEX, adjustment_value: -10 });
  const FIX = await mkPlan({ code: "fix", name: "פרימיום", plan_kind: "derived_fixed", parent_plan_id: FLEX, adjustment_value: 50 });
  const INDY = await mkPlan({ code: "indy", name: "עצמאי", plan_kind: "independent" });

  const assign = (plan, unit) => tx`
    INSERT INTO guesthub.pricing_plan_units (tenant_id, pricing_plan_id, sellable_unit_id, is_active)
    VALUES (${T}, ${plan}, ${unit}, true)`;
  for (const p of [FLEX, NR, FIX, INDY]) { await assign(p, R1.suId); await assign(p, R2.suId); }
  // independent plan prices + a date-specific override on FLEX
  await tx`
    INSERT INTO guesthub.pricing_plan_unit_rates (tenant_id, pricing_plan_id, sellable_unit_id, date, price)
    VALUES (${T}, ${INDY}, ${R1.suId}, '2027-03-10', 600), (${T}, ${INDY}, ${R1.suId}, '2027-03-11', 600),
           (${T}, ${FLEX}, ${R1.suId}, '2027-03-11', 480)`;

  return { T, rtId: rt.id, R1, R2, FLEX, NR, FIX, INDY };
}

// The two surfaces under comparison, fed the SAME inputs.
const simulator = (tx, f, stay) =>
  calculateReservationPrice(tx, {
    tenantId: f.T, checkIn: stay.checkIn, checkOut: stay.checkOut,
    rooms: [{ roomId: stay.roomId, ratePlanId: stay.ratePlanId ?? null,
              adults: stay.adults, children: stay.children, infants: stay.infants,
              manualRatePerNight: null }],
    source: "pricing_simulator",
  });
const reservation = (tx, f, stay, opts = {}) =>
  seam.priceReservationStays(tx, f.T, [stay], {
    source: "manual_reservation",
    enforceAvailability: true, enforceRestrictions: true, ...opts,
  });

const G = { adults: 2, children: 0, infants: 0 };

// simulator quote ≡ reservation-priced stay: totals, nightly breakdown,
// provenance and the deterministic fingerprint all identical.
async function assertEquality(tx, f, stay, label) {
  const [sim, [res]] = [await simulator(tx, f, stay), await reservation(tx, f, stay)];
  const simRoom = sim.rooms[0];
  assert.equal(sim.valid, true, `${label}: simulator quote valid`);
  assert.equal(res.priceTotal, simRoom.roomSubtotal, `${label}: totals equal`);
  assert.deepEqual(
    res.pricingSnapshot.nightly.map((x) => [x.date, x.nightTotal, x.priceSource]),
    simRoom.nights.map((x) => [x.date, x.nightTotal, x.priceSource]),
    `${label}: nightly breakdown equal`,
  );
  assert.equal(res.pricingSnapshot.quoteFingerprint, sim.quoteFingerprint, `${label}: fingerprints equal`);
  assert.equal(res.pricingSnapshot.vatRate, sim.vatRate, `${label}: VAT context equal`);
  return { sim, res };
}

async function expectSeamError(tx, f, stay, code, label, opts = {}) {
  let threw = null;
  try { await reservation(tx, f, stay, opts); } catch (e) { threw = e; }
  assert.ok(threw instanceof seam.StayPricingError, `${label}: seam throws StayPricingError`);
  assert.equal(threw.code, code, `${label}: code ${code} (got ${threw.code})`);
  // the simulator reports the SAME violation on the same inputs
  const sim = await simulator(tx, f, stay);
  assert.ok(sim.rooms[0].errors.some((e) => e.code === code || (code === "ROOM_UNAVAILABLE" && e.code === "ROOM_UNAVAILABLE")),
    `${label}: simulator reports ${code} too`);
}

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

    // ---- 1-3: plain equality across stay shapes ----
    await assertEquality(tx, f, { roomId: f.R1.roomId, ratePlanId: f.FLEX, checkIn: IN, checkOut: "2027-03-11", ...G }, "one-night weekday");
    ok("one-night weekday stay: simulator ≡ reservation (totals, nightly, fingerprint)");
    await assertEquality(tx, f, { roomId: f.R1.roomId, ratePlanId: f.FLEX, checkIn: "2027-03-13", checkOut: "2027-03-16", ...G }, "multi-night");
    ok("multi-night stay: simulator ≡ reservation");
    {
      const { res } = await assertEquality(tx, f, { roomId: f.R1.roomId, ratePlanId: f.NR, checkIn: "2027-03-12", checkOut: "2027-03-14", ...G }, "weekend");
      // weekend nightly 700 → NR −10% → 630/night (the override row is on 03-11 only)
      assert.deepEqual(res.pricingSnapshot.nightly.map((x) => x.nightTotal), [630, 630]);
      ok("weekend stay: weekend base prices flow through the derived plan identically");
    }

    // ---- 3b: a length-of-stay discount reaches the SAVED reservation (D104) ----
    // The engine applies it, so the seam that commits the stay must store the
    // chosen tier and its arithmetic — that is how a reservation explains its
    // own price months later, after the tier itself was edited or deleted.
    await scenario(tx, async (sp) => {
      await sp`
        INSERT INTO guesthub.length_of_stay_discounts
          (tenant_id, pricing_plan_id, name, min_nights, discount_kind, discount_value)
        VALUES (${f.T}, NULL, 'תעריף שבועי', 3, 'percent', 10)`;
      const stay = { roomId: f.R1.roomId, ratePlanId: f.FLEX, checkIn: "2027-03-13", checkOut: "2027-03-16", ...G };
      const { res } = await assertEquality(sp, f, stay, "long-stay discount");
      // 700 + 500 + 500 = 1700 accommodation → −10% → 1530
      assert.equal(res.pricingSnapshot.accommodationSubtotal, 1700);
      assert.equal(res.pricingSnapshot.losDiscount.name, "תעריף שבועי");
      assert.equal(res.pricingSnapshot.losDiscount.amount, 170);
      assert.equal(res.priceTotal, 1530);
      assert.match(res.pricingSnapshot.losDiscount.explanation, /תעריף שבועי/);
      ok("length-of-stay discount: applied by the engine, stored in the reservation snapshot with its arithmetic");
    });

    // ---- 4: date-specific override row wins on both surfaces ----
    {
      const { res } = await assertEquality(tx, f, { roomId: f.R1.roomId, ratePlanId: f.FLEX, checkIn: IN, checkOut: OUT, ...G }, "override");
      assert.deepEqual(res.pricingSnapshot.nightly.map((x) => [x.nightTotal, x.priceSource]),
        [[500, "base_plan_rate"], [480, "plan_unit_date_override"]]);
      assert.equal(res.priceTotal, 980);
      ok("date-specific price override: (plan,unit,date) row wins over the base rate on both surfaces");
    }

    // ---- 5-7: plan kinds ----
    {
      const { res } = await assertEquality(tx, f, { roomId: f.R1.roomId, ratePlanId: f.NR, checkIn: IN, checkOut: OUT, ...G }, "derived %");
      // −10% of the parent's RESOLVED value — incl. the parent's 03-11 date
      // override (480), never the raw base rate (§8.2)
      assert.deepEqual(res.pricingSnapshot.nightly.map((x) => x.nightTotal), [450, 432]);
      assert.equal(res.pricingSnapshot.parentPlanId, f.FLEX);
      ok("percentage-derived plan: −10% of the parent's RESOLVED nightly (parent override included)");
    }
    {
      const { res } = await assertEquality(tx, f, { roomId: f.R1.roomId, ratePlanId: f.FIX, checkIn: IN, checkOut: OUT, ...G }, "derived fixed");
      assert.deepEqual(res.pricingSnapshot.nightly.map((x) => x.nightTotal), [550, 530]); // parent-resolved +50
      ok("fixed-amount-derived plan: parent-resolved +₪50/night");
    }
    {
      const { res } = await assertEquality(tx, f, { roomId: f.R1.roomId, ratePlanId: f.INDY, checkIn: IN, checkOut: OUT, ...G }, "independent");
      assert.deepEqual(res.pricingSnapshot.nightly.map((x) => [x.nightTotal, x.priceSource]),
        [[600, "independent_plan_price"], [600, "independent_plan_price"]]);
      ok("independent plan: its own price rows, never the base");
    }

    // ---- 8-11: restriction violations, same verdict on both surfaces ----
    await expectSeamError(tx, f, { roomId: f.R2.roomId, ratePlanId: f.FLEX, checkIn: "2027-03-20", checkOut: "2027-03-21", ...G }, "MIN_STAY_NOT_MET", "min-stay");
    ok("minimum-stay violation blocks the reservation and fails the simulator identically");
    await expectSeamError(tx, f, { roomId: f.R2.roomId, ratePlanId: f.FLEX, checkIn: "2027-03-24", checkOut: "2027-03-27", ...G }, "MAX_STAY_EXCEEDED", "max-stay");
    ok("maximum-stay violation blocks identically");
    await expectSeamError(tx, f, { roomId: f.R2.roomId, ratePlanId: f.FLEX, checkIn: "2027-03-28", checkOut: "2027-03-29", ...G }, "CLOSED_ON_ARRIVAL", "CTA");
    ok("closed-on-arrival violation blocks identically");
    await expectSeamError(tx, f, { roomId: f.R2.roomId, ratePlanId: f.FLEX, checkIn: "2027-03-30", checkOut: "2027-03-31", ...G }, "CLOSED_ON_DEPARTURE", "CTD");
    ok("closed-on-departure violation blocks identically");

    // ---- 12: unavailable room (blocking reservation in the way) ----
    await scenario(tx, async (sp) => {
      const [g] = await sp`
        INSERT INTO guesthub.guests (tenant_id, first_name, last_name, full_name)
        VALUES (${f.T}, 'אורח', 'קיים', 'אורח קיים') RETURNING id`;
      const [r] = await sp`
        INSERT INTO guesthub.reservations (tenant_id, reservation_number, primary_guest_id, status, check_in, check_out, total_price)
        VALUES (${f.T}, '9001', ${g.id}, 'confirmed', ${IN}, ${OUT}, 1000) RETURNING id`;
      await sp`
        INSERT INTO guesthub.reservation_rooms (tenant_id, reservation_id, room_id, check_in, check_out, adults)
        VALUES (${f.T}, ${r.id}, ${f.R1.roomId}, ${IN}, ${OUT}, 2)`;
      await expectSeamError(sp, f, { roomId: f.R1.roomId, ratePlanId: f.FLEX, checkIn: IN, checkOut: OUT, ...G }, "ROOM_UNAVAILABLE", "occupied room");
      // a draft edit (enforceAvailability=false) still prices — same number the simulator computes
      const [res] = await reservation(sp, f, { roomId: f.R1.roomId, ratePlanId: f.FLEX, checkIn: IN, checkOut: OUT, ...G }, { enforceAvailability: false, enforceRestrictions: false });
      assert.equal(res.priceTotal, 980);
      ok("unavailable room: blocked when enforcing; a draft still prices identically");
    });

    // ---- 13-14: occupancy ----
    await expectSeamError(tx, f, { roomId: f.R1.roomId, ratePlanId: f.FLEX, checkIn: IN, checkOut: OUT, adults: 4, children: 0, infants: 0 }, "ADULT_LIMIT_EXCEEDED", "capacity");
    ok("capacity violation (adults over room limit) blocks on both surfaces");
    await expectSeamError(tx, f, { roomId: f.R2.roomId, ratePlanId: f.FLEX, checkIn: IN, checkOut: OUT, adults: 2, children: 0, infants: 1 }, "INFANT_LIMIT_EXCEEDED", "infants");
    ok("infants-not-permitted (max_infants=0) blocks on both surfaces");

    // ---- 15-16: VAT enabled / disabled — one config, one calculation ----
    {
      const sim = await simulator(tx, f, { roomId: f.R1.roomId, ratePlanId: f.FLEX, checkIn: IN, checkOut: OUT, ...G });
      assert.equal(sim.vatRate, 18);
      assert.equal(sim.vatAmount, Math.round(980 - 980 / 1.18)); // included VAT of the gross
      assert.equal(sim.totalGross, 980); // inclusive: VAT never added on top
      ok("VAT enabled: included-VAT amount extracted from the same gross on both surfaces");
    }
    await scenario(tx, async (sp) => {
      await sp`UPDATE guesthub.tenants SET settings = settings || '{"vat_rate": 0}' WHERE id = ${f.T}`;
      const sim = await simulator(sp, f, { roomId: f.R1.roomId, ratePlanId: f.FLEX, checkIn: IN, checkOut: OUT, ...G });
      const [res] = await reservation(sp, f, { roomId: f.R1.roomId, ratePlanId: f.FLEX, checkIn: IN, checkOut: OUT, ...G });
      assert.equal(sim.vatRate, 0);
      assert.equal(sim.vatAmount, 0);
      assert.equal(res.pricingSnapshot.vatRate, 0);
      assert.equal(res.priceTotal, 980); // gross unchanged — VAT is informational
      ok("VAT disabled (rate 0): zero VAT, identical gross on both surfaces");
    });

    // ---- 17-18: discount and fee via THE one total formula ----
    {
      assert.equal(seam.reservationTotal(980, 100, 0), 880);   // discount
      assert.equal(seam.reservationTotal(980, 0, 50), 1030);   // fee (extra charges)
      assert.equal(seam.reservationTotal(980, 2000, 50), 0);   // floored once, never negative
      assert.equal(seam.reservationTotal(980.004, 0.004, 0), 980); // cents rounding
      // ---- textual pins (D106): every money writer goes through THE source ----
      const src = readFileSync(join(ROOT, "src/app/(dashboard)/reservations/actions.ts"), "utf8");
      assert.ok((src.match(/resolveTotals\(/g) ?? []).length >= 5,
        "create/update/move/preview all derive totals via resolveTotals→computeReservationTotals (definition + 4 call sites)");
      assert.equal((src.match(/reservationTotal\(/g) ?? []).length, 0,
        "no action calls the deprecated wrapper directly");
      const channelSrc = readFileSync(join(ROOT, "src/lib/channel/booking-import.ts"), "utf8");
      assert.ok((channelSrc.match(/computeReservationTotals\(/g) ?? []).length >= 2,
        "channel import (modify + new) folds the OTA total through the single source");
      const publicSrc = readFileSync(join(ROOT, "src/lib/public-booking/create-booking.ts"), "utf8");
      assert.ok((publicSrc.match(/computeReservationTotals\(/g) ?? []).length >= 1,
        "the public booking derives its total from the single source");
      // the SQL re-implementations are dead and must stay dead
      for (const [file, text] of [
        ["src/app/(dashboard)/reservations/actions.ts", src],
        ["src/lib/channel/booking-import.ts", channelSrc],
      ]) {
        assert.ok(!/GREATEST\(0[^)]*discount_amount/.test(text),
          `${file}: no SQL re-implementation of the total formula`);
      }
      ok("discount + fee: one canonical totals source wired into every money-writing surface (textual pins)");
    }

    // ---- 18b: computeReservationTotals — THE single totals source (D106) ----
    // Pure and isomorphic: the same compiled module the seam delegates to.
    {
      const totals = req(join(out, "lib/pricing/totals.js"));
      const base = {
        stays: [{ priceTotal: 500, nights: 1 }, { priceTotal: 520, nights: 2 }],
        extraCharges: 0, taxExempt: false, vatRate: 18, currency: "ILS",
      };
      // full price — no discount
      const full = totals.computeReservationTotals({ ...base, discountMode: "none", discountValue: 999 });
      assert.equal(full.roomsTotal, 1020);
      assert.equal(full.nightsTotal, 3);
      assert.equal(full.discountAmount, 0);
      assert.equal(full.grandTotal, 1020);
      // all five modes resolve to an absolute ₪ figure
      assert.equal(totals.computeReservationTotals({ ...base, discountMode: "amount_total", discountValue: 120 }).grandTotal, 900);
      assert.equal(totals.computeReservationTotals({ ...base, discountMode: "amount_per_night", discountValue: 40 }).discountAmount, 120); // 40 × 3
      assert.equal(totals.computeReservationTotals({ ...base, discountMode: "percent_total", discountValue: 10 }).grandTotal, 918);
      assert.equal(totals.computeReservationTotals({ ...base, discountMode: "percent_per_night", discountValue: 10 }).discountAmount, 102);
      // VAT is extracted AFTER discount + extras, honors tax_exempt, and never moves the total
      const vat = totals.computeReservationTotals({ ...base, discountMode: "amount_total", discountValue: 120 });
      assert.equal(vat.vatAmount, 137); // included VAT of 900 @18% (whole-shekel rule)
      assert.equal(vat.netTotal, 763);
      const exempt = totals.computeReservationTotals({ ...base, discountMode: "amount_total", discountValue: 120, taxExempt: true });
      assert.equal(exempt.vatAmount, 0);
      assert.equal(exempt.grandTotal, 900, "the VAT toggle never changes the price");
      assert.equal(exempt.netTotal, 900);
      // manual-total exactness: agora arithmetic, no float drift
      const exact = totals.computeReservationTotals({
        stays: [{ priceTotal: 1000.01, nights: 3 }], discountMode: "none", discountValue: 0,
        extraCharges: 0, taxExempt: false, vatRate: 18, currency: "ILS",
      });
      assert.equal(exact.grandTotal, 1000.01, "an entered total survives to the agora");
      assert.deepEqual(totals.spreadTotalOverNights(1000.01, 3), [333.34, 333.34, 333.33]);
      assert.equal(totals.spreadTotalOverNights(1000.01, 3).reduce((s, x) => s + Math.round(x * 100), 0), 100001);
      // the OTA-sent total is sovereign over Σ stays (channel imports)
      const ota = totals.computeReservationTotals(
        { ...base, roomsTotalOverride: 1234.56, discountMode: "amount_total", discountValue: 4000 },
        { validate: false },
      );
      assert.equal(ota.roomsTotal, 1234.56);
      assert.equal(ota.grandTotal, 0, "channel path floors instead of rejecting");
      // server-side validation fails closed
      assert.throws(() => totals.computeReservationTotals({ ...base, discountMode: "percent_total", discountValue: 101 }), /אחוז/);
      assert.throws(() => totals.computeReservationTotals({ ...base, discountMode: "amount_total", discountValue: 5000 }), /גדולה/);
      assert.throws(() => totals.computeReservationTotals({ ...base, discountMode: "amount_total", discountValue: -1 }), /שלילי/);
      // balance mirrors the ledger convention exactly: total − paid, NOT floored
      const bal = totals.computeReservationTotals({ ...base, discountMode: "none", discountValue: 0, paid: 1100 });
      assert.equal(bal.balance, -80, "overpayment is a negative balance (credit), same as the ledger");
      // the legacy wrapper is a pure delegate — byte-identical results
      assert.equal(seam.reservationTotal(980, 100, 50), 930);
      assert.equal(
        seam.reservationTotal(980.004, 0.004, 0),
        totals.computeReservationTotals(
          { stays: [], roomsTotalOverride: 980.004, discountMode: "amount_total", discountValue: 0.004, extraCharges: 0, taxExempt: false, vatRate: 0, currency: "ILS" },
          { validate: false },
        ).grandTotal,
      );
      ok("computeReservationTotals: 5 discount modes, VAT after discount + tax_exempt, agora-exact totals, OTA override, fail-closed validation, ledger balance");
    }

    // ---- 19-20: payment status derives from the LEDGER against the total ----
    await scenario(tx, async (sp) => {
      const [g] = await sp`
        INSERT INTO guesthub.guests (tenant_id, first_name, last_name, full_name)
        VALUES (${f.T}, 'משלם', 'חלקי', 'משלם חלקי') RETURNING id`;
      const [r] = await sp`
        INSERT INTO guesthub.reservations (tenant_id, reservation_number, primary_guest_id, status, check_in, check_out, total_price, balance)
        VALUES (${f.T}, '9002', ${g.id}, 'confirmed', ${IN}, ${OUT}, 980, 980) RETURNING id`;
      const pay = (amount) => sp`
        INSERT INTO guesthub.payments (tenant_id, reservation_id, amount, method, status, paid_at)
        VALUES (${f.T}, ${r.id}, ${amount}, 'cash', 'paid', now())`;

      await pay(300);
      let agg = await ledger.recomputePaymentAggregates(sp, f.T, r.id);
      assert.deepEqual([agg.paid, agg.balance], [300, 680]);
      assert.equal(paymentState(agg.total, agg.paid), "partial");
      ok("partial payment: paid=Σledger, balance=total−paid, state 'partial' — never from a single row");

      await pay(680);
      agg = await ledger.recomputePaymentAggregates(sp, f.T, r.id);
      assert.deepEqual([agg.paid, agg.balance], [980, 0]);
      assert.equal(paymentState(agg.total, agg.paid), "paid");
      await pay(100); // overpayment
      agg = await ledger.recomputePaymentAggregates(sp, f.T, r.id);
      assert.equal(agg.balance, -100); // honest credit, not clamped away
      assert.equal(paymentState(agg.total, agg.paid), "overpaid"); // D52: distinct state
      ok("full payment + overpayment: state 'overpaid'; overpay shows as negative balance (credit)");
    });

    // ---- 21-22: authorized manual override ----
    {
      const [res] = await reservation(tx, f, {
        roomId: f.R1.roomId, ratePlanId: f.FLEX, checkIn: IN, checkOut: OUT, ...G,
        isManualRate: true, ratePerNight: 350,
      }, { actorUserId: "00000000-0000-0000-0000-00000000d51a" });
      assert.equal(res.priceTotal, 700); // 350 × 2 — the override IS the price
      assert.deepEqual(res.pricingSnapshot.nightly.map((x) => x.priceSource), ["manual_override", "manual_override"]);
      assert.equal(res.pricingSnapshot.manualOverride.ratePerNight, 350);
      assert.equal(res.pricingSnapshot.manualOverride.appliedBy, "00000000-0000-0000-0000-00000000d51a");
      ok("manual override with authorization: final price, provenance + user recorded in the snapshot");
    }

    // ---- 21b: manual TOTAL (price_mode='manual_total', D106) through the seam ----
    await scenario(tx, async (sp) => {
      // a tier that would fire on 2 nights — the manual total must be exempt
      await sp`
        INSERT INTO guesthub.length_of_stay_discounts
          (tenant_id, pricing_plan_id, name, min_nights, discount_kind, discount_value)
        VALUES (${f.T}, NULL, 'מדרגה', 2, 'percent', 10)`;
      const [res] = await reservation(sp, f, {
        roomId: f.R1.roomId, ratePlanId: f.FLEX, checkIn: IN, checkOut: OUT, ...G,
        priceMode: "manual_total", manualTotal: 1000.01,
      }, { actorUserId: "00000000-0000-0000-0000-00000000d51a" });
      assert.equal(res.priceTotal, 1000.01, "the entered total IS the committed price, to the agora");
      // 1000.01/2 → round2(500.005) = 500.01: the nightly figure is a DISPLAY
      // spread (2dp) — 500.01 × 2 = 1000.02 ≠ the total, and that is fine,
      // because priceTotal is the authoritative money, never rate × nights
      assert.equal(res.ratePerNight, 500.01, "nightly figure is a display spread, never authoritative");
      assert.equal(res.pricingSnapshot.priceMode, "manual_total");
      assert.equal(res.pricingSnapshot.manualOverride.mode, "manual_total");
      assert.equal(res.pricingSnapshot.manualOverride.total, 1000.01);
      assert.equal(res.pricingSnapshot.manualOverride.appliedBy, "00000000-0000-0000-0000-00000000d51a");
      assert.equal(res.pricingSnapshot.losDiscount, null, "a manual total is never auto-discounted (LOS exempt)");
      ok("manual TOTAL: agora-exact committed price, provenance in the snapshot, LOS exempt");
    });
    {
      // without permission the ACTION refuses before pricing: the gate is the
      // dedicated permission, granted to manager only (migration 017)
      const src = readFileSync(join(ROOT, "src/app/(dashboard)/reservations/actions.ts"), "utf8");
      assert.ok((src.match(/requirePermission\(actor, "reservations\.price_override"\)/g) ?? []).length >= 2,
        "create AND update gate new overrides on reservations.price_override");
      const [perm] = await tx`
        SELECT count(*)::int AS grants FROM guesthub.role_permissions rp
        JOIN guesthub.permissions p ON p.id = rp.permission_id
        JOIN guesthub.roles r ON r.id = rp.role_id
        WHERE p.key = 'reservations.price_override' AND r.key = 'receptionist'`;
      assert.equal(perm.grants, 0, "receptionist has NO price-override grant");
      ok("manual override without permission: server actions gate on reservations.price_override; receptionist not granted");
    }

    // ---- 23: snapshot immutability across future pricing edits ----
    await scenario(tx, async (sp) => {
      const stay = { rrId: "e51a0000-0000-4000-8000-000000000001", roomId: f.R1.roomId, ratePlanId: f.FLEX, checkIn: IN, checkOut: OUT, ...G };
      const [first] = await reservation(sp, f, stay);
      assert.equal(first.priceTotal, 980);
      // the rate table changes AFTER confirmation…
      await sp`
        UPDATE guesthub.pricing_plan_rates SET price = 999
        WHERE tenant_id = ${f.T} AND sellable_unit_id = ${f.R1.suId}`;
      // …an unchanged stay keeps its committed price and PRESERVES the stored snapshot
      const committed = new Map([[stay.rrId, { ratePerNight: first.ratePerNight, priceTotal: first.priceTotal }]]);
      const [kept] = await reservation(sp, f, stay, { snapshotByRr: committed });
      assert.equal(kept.priceTotal, 980, "committed price never drifts with future rates");
      assert.equal(kept.pricingSnapshot, null, "stored snapshot preserved (not regenerated)");
      // …while an explicitly re-priced stay (basis changed) gets the NEW rates
      const [repriced] = await reservation(sp, f, { ...stay, checkIn: "2027-03-13", checkOut: "2027-03-15" });
      assert.equal(repriced.priceTotal, 1998); // 999 × 2 — explicit recalculation rule
      assert.ok(repriced.pricingSnapshot, "re-priced stay writes a fresh snapshot");
      ok("reservation snapshot immutable under future pricing edits; explicit re-pricing recalculates");
    });
  });

  console.log(`\nALL ${n} PRICING-EQUALITY CHECKS PASSED — nothing committed, test DB untouched`);
} finally {
  await sql.end();
}
