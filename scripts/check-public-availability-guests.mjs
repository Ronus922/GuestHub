#!/usr/bin/env node
// ============================================================
// check:public-availability-guests — D195: the public availability quote is
// PARTY-AWARE, and every unit's number is THE engine's (resolveEffectivePricing
// → calculateChargeableGuests → property rounding), never a base-occupancy
// figure the booking then corrects.
//
// Four fixture rooms, one room type:
//   INH   — inherit:          every amount from the property defaults
//   OVR   — full override:    every amount (and the frequency) from the room
//   PART  — partial override: infant from the room, adult/child from the property
//   SMALL — a 2-person unit, so capacity filtering has something to drop
//
// Multi-room (owner, 2026-09-25): a unit is offered when it can host AT LEAST
// ONE requested party, partyPrices[i] is null for every party it cannot host,
// a unit hosting none is not offered, and the booking assigns rooms through
// assign-units.ts (cheapest valid combination; room i ↔ partyPrices[i]) —
// never positionally.
//
// Owner decision (2026-09-25): the inheritance chain room ↓ property IS the
// source of truth, and no price or occupancy is pinned in code or tests.
// Every expected number below is COMPUTED from the rows the guard reads back
// (tenant settings, room columns, the unit's own rates) through the SAME pure
// functions the engine uses. No literal price appears in an assertion.
//
// Nothing committed: one transaction, always rolled back.
// ============================================================
import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

// schema bootstrap: full chain only when the schema is absent (the suite hands
// this guard a migrated clone; a bare DB replays the chain)
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
console.log("compiling public-booking availability + guests + pricing seam + commercial resolvers via tsc…");
const tmp = mkdtempSync(join(tmpdir(), "gh-pubguests-"));
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
    join(ROOT, "src/lib/public-booking/guests.ts"),
    join(ROOT, "src/lib/public-booking/assign-units.ts"),
    join(ROOT, "src/lib/pricing/engine.ts"),
    join(ROOT, "src/lib/pricing/reservation-pricing.ts"),
    join(ROOT, "src/lib/commercial/extra-guest.ts"),
    join(ROOT, "src/lib/commercial/room-pricing.ts"),
    join(ROOT, "src/lib/inventory.ts"),
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

const FIXED_TENANT = "0b00c0de-0000-4000-8000-00000000d195";
process.env.PUBLIC_BOOKING_TENANT_ID = FIXED_TENANT; // read by config.ts at require time

const { publicAvailability } = req(join(out, "lib/public-booking/availability.js"));
const { parseGuestsParam, formatGuestsParam } = req(join(out, "lib/public-booking/guests.js"));
const { assignUnitsToRooms } = req(join(out, "lib/public-booking/assign-units.js"));
const { calculateReservationPrice } = req(join(out, "lib/pricing/engine.js"));
const seam = req(join(out, "lib/pricing/reservation-pricing.js"));
const { normalizeExtraGuestDefaults, roundMoney } = req(join(out, "lib/commercial/extra-guest.js"));
const { resolveEffectivePricing, calculateChargeableGuests } = req(join(out, "lib/commercial/room-pricing.js"));
const { getRoomCapacities } = req(join(out, "lib/inventory.js"));

const postgres = req("postgres");
const sql = postgres(TEST_URL, { prepare: false, max: 1 });
class Rollback extends Error {}

const IN = "2027-04-10", MID = "2027-04-11", OUT = "2027-04-12";
const NIGHTS = 2;
const round2 = (n) => Math.round(n * 100) / 100;
let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };
const P = (adults, children = 0, infants = 0) => ({ adults, children, infants });
const unitOf = (types, suId) => types.flatMap((t) => t.units).find((u) => u.suId === suId) ?? null;

// ---- THE expected number, from the rows as they are RIGHT NOW ----
// Reads tenant settings + the room's own columns + the unit's rates back from
// the DB and runs the same pure resolvers the engine runs. Re-read on every
// call on purpose: a settings/room change inside the transaction must move
// the expectation exactly as it moves the quote.
async function expectedFor(tx, unit, party) {
  const [t] = await tx`SELECT settings->'extra_guest' AS eg FROM guesthub.tenants WHERE id = ${FIXED_TENANT}`;
  const property = normalizeExtraGuestDefaults(t.eg);
  const [room] = await tx`
    SELECT included_occupancy, extra_guest_pricing_mode,
           extra_adult_override::float8  AS extra_adult_override,
           extra_child_override::float8  AS extra_child_override,
           extra_infant_override::float8 AS extra_infant_override,
           charge_frequency_override
    FROM guesthub.rooms WHERE id = ${unit.roomId}`;
  const cap = (await getRoomCapacities(tx, FIXED_TENANT, [unit.roomId])).get(unit.roomId);
  const effective = resolveEffectivePricing({
    mode: room.extra_guest_pricing_mode,
    extra_adult: room.extra_adult_override,
    extra_child: room.extra_child_override,
    extra_infant: room.extra_infant_override,
    charge_frequency: room.charge_frequency_override,
  }, property);
  const chargeable = calculateChargeableGuests({
    adults: party.adults, children: party.children, infants: party.infants,
    includedOccupancy: room.included_occupancy,
    maxAdults: cap.max_adults, maxChildren: cap.max_children, maxInfants: cap.max_infants,
    maxOccupancy: cap.max_occupancy,
    infantsCountOccupancy: property.infants_count_occupancy,
    infantsUseIncluded: property.infants_use_included,
    pricing: {
      adult: effective.extra_adult.value ?? 0,
      child: effective.extra_child.value ?? 0,
      infant: effective.extra_infant.value ?? 0,
      frequency: effective.charge_frequency.value,
    },
  });
  const [{ accommodation }] = await tx`
    SELECT COALESCE(SUM(price), 0)::float8 AS accommodation
    FROM guesthub.pricing_plan_rates
    WHERE tenant_id = ${FIXED_TENANT} AND sellable_unit_id = ${unit.suId}
      AND date >= ${IN} AND date < ${OUT}`;
  const extra = roundMoney(chargeable.totalExtra, property.rounding_mode, property.rounding_increment);
  const total = round2(accommodation + (effective.charge_frequency.value === "per_night" ? extra * NIGHTS : extra));
  return { valid: chargeable.valid, total, accommodation, extra, effective, chargeable, property };
}

// the three price-determining surfaces for one unit + party, side by side
async function engineAndSeam(tx, unit, party) {
  const engine = await calculateReservationPrice(tx, {
    tenantId: FIXED_TENANT, checkIn: IN, checkOut: OUT,
    rooms: [{ roomId: unit.roomId, ratePlanId: null, ...party, manualRatePerNight: null }],
    source: "website",
  });
  const stays = await seam.priceReservationStays(tx, FIXED_TENANT, [{
    roomId: unit.roomId, ratePlanId: null, checkIn: IN, checkOut: OUT, ...party,
  }], { source: "website", enforceAvailability: true, enforceRestrictions: true });
  return { engine: engine.rooms[0].roomSubtotal, seam: stays[0].priceTotal };
}

// ---- 0. the parser (pure) ----
assert.deepEqual(parseGuestsParam("2-0"), [P(2)], "single room");
assert.deepEqual(parseGuestsParam("2-0,3-1"), [P(2), P(3, 1)], "two rooms, site format");
assert.deepEqual(parseGuestsParam(" 1-4 , 6-0 "), [P(1, 4), P(6)], "whitespace tolerated, limits inclusive");
for (const bad of ["", "0-0", "7-0", "2-5", "2", "2-0,", "a-b", "2-0;3-1", "2-0,2-0,2-0,2-0,2-0,2-0"]) {
  assert.equal(parseGuestsParam(bad), null, `rejected: "${bad}"`);
}
assert.equal(formatGuestsParam([P(2), P(3, 1)]), "2-0,3-1", "canonical echo");
ok("guests parser: the site's format in, a party list out; anything else is null (400), never a guessed party");

try {
  await sql.begin(async (tx) => {
    // ---- fixture: one tenant with NON-round property amounts + unit rounding,
    //      one type, four units — three pricing modes + one small unit ----
    await tx`
      INSERT INTO guesthub.tenants (id, name, slug, timezone, currency, settings)
      VALUES (${FIXED_TENANT}, 'זמינות לפי הרכב', ${"pubguests-" + Date.now()}, 'Asia/Jerusalem', 'ILS',
        ${tx.json({
          vat_rate: 18,
          extra_guest: {
            configured: true, extra_adult: 133.33, extra_child: 66.66, extra_infant: 40,
            charge_frequency: "per_night", infant_max_age: 2, child_max_age: 12,
            infants_count_occupancy: false, infants_use_included: false,
            tax_mode: "inclusive", rounding_mode: "unit", rounding_increment: 1,
          },
        })})`;
    const [rt] = await tx`
      INSERT INTO guesthub.room_types (tenant_id, name, base_price, max_occupancy, max_adults, max_children, max_infants)
      VALUES (${FIXED_TENANT}, 'משפחתי', 400, 6, 6, 4, 2) RETURNING id`;
    const mkUnit = async (num, rates, roomFields) => {
      const [r] = await tx`
        INSERT INTO guesthub.rooms ${tx({
          tenant_id: FIXED_TENANT, room_type_id: rt.id, room_number: num, name: `חדר ${num}`,
          status: "available", is_active: true,
          max_occupancy: 6, max_adults: 6, max_children: 4, max_infants: 2,
          min_occupancy: 1, default_occupancy: 2,
          ...roomFields,
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
      return { roomId: r.id, suId: su.id, code: num };
    };
    const INH = await mkUnit("901", [[IN, 300], [MID, 300]], {
      included_occupancy: 2, extra_guest_pricing_mode: "inherit",
    });
    const OVR = await mkUnit("902", [[IN, 320], [MID, 320]], {
      included_occupancy: 2, extra_guest_pricing_mode: "override",
      extra_adult_override: 80, extra_child_override: 40, extra_infant_override: 20,
      charge_frequency_override: "per_stay",
    });
    const PART = await mkUnit("903", [[IN, 310], [MID, 310]], {
      included_occupancy: 2, extra_guest_pricing_mode: "override",
      extra_infant_override: 25, // adult/child left NULL → property default
    });
    // dearer than INH on purpose: in the browse it is NOT the engine-priced
    // cheapest unit, so its ESS sum vs. its included-occupancy price is visible
    const SMALL = await mkUnit("904", [[IN, 330], [MID, 330]], {
      included_occupancy: 1, extra_guest_pricing_mode: "inherit",
      max_occupancy: 2, max_adults: 2, max_children: 1, max_infants: 1,
    });
    const ALL = [INH, OVR, PART, SMALL];

    // the fixture really is the three modes it claims to be — read back, not assumed
    const modes = {};
    for (const u of ALL) modes[u.code] = (await expectedFor(tx, u, P(3, 1, 1))).effective;
    const src = (e) => [e.extra_adult.source, e.extra_child.source, e.extra_infant.source].join("/");
    assert.equal(src(modes["901"]), "property_default/property_default/property_default", "INH resolves every amount from the property");
    assert.equal(src(modes["902"]), "room_override/room_override/room_override", "OVR resolves every amount from the room");
    assert.equal(modes["902"].charge_frequency.value, "per_stay", "OVR's frequency comes from the room");
    assert.equal(src(modes["903"]), "property_default/property_default/room_override", "PART: adult/child fall through to the property, infant from the room");
    assert.equal(modes["903"].charge_frequency.value, "per_night", "PART inherits the property frequency");
    ok("fixture verified through resolveEffectivePricing: inherit / full override / partial override are what they claim");

    // ---- 1. backward compatibility: no party → exactly the pre-D195 browse ----
    const browse = await publicAvailability(tx, IN, OUT);
    assert.equal(browse.length, 1, "one room type");
    assert.equal(browse[0].availableUnits, 4, "all four units bookable for a browse");
    for (const u of browse[0].units) assert.equal(u.partyPrices, undefined, `no party → no partyPrices (${u.code})`);
    const browseCheapest = browse[0].units[0];
    const twoAdults = await engineAndSeam(tx, browseCheapest, P(2));
    assert.equal(browseCheapest.totalPrice, twoAdults.engine, "browse: the cheapest unit is the engine's 2-adult price (as before)");
    for (const u of browse[0].units.slice(1)) {
      const exp = await expectedFor(tx, u, P(2));
      assert.equal(u.totalPrice, exp.accommodation, `browse: the other units carry their ESS sum (as before) — ${u.code}`);
    }
    const asTwo = await publicAvailability(tx, IN, OUT, { parties: [P(2)] });
    let essSumMoved = 0;
    for (const u of asTwo[0].units) {
      const exp = await expectedFor(tx, u, P(2));
      const b = unitOf(browse, u.suId);
      assert.equal(u.totalPrice, exp.total, `guests=2-0 is the computed 2-adult price (${u.code})`);
      if (u.suId === browseCheapest.suId) {
        assert.equal(u.totalPrice, b.totalPrice, `guests=2-0 equals the browse for the engine-priced cheapest unit (${u.code})`);
      } else if (exp.chargeable.extraAdults === 0) {
        assert.equal(u.totalPrice, b.totalPrice, `guests=2-0 equals the browse ESS sum where 2 adults are included (${u.code})`);
      } else {
        essSumMoved++;
        assert.ok(u.totalPrice > b.totalPrice, `guests=2-0 is MORE than the browse ESS sum where only 1 guest is included (${u.code})`);
      }
    }
    assert.equal(essSumMoved, 1, "exactly one unit (SMALL, included 1, not the cheapest) shows the browse's blind spot");
    ok("backward compatible: without guests the response is the historical browse; with guests=2-0 every unit is engine-priced, and only the unit whose included occupancy is below 2 moves");

    // ---- 2. same unit, 2 vs 4 guests: different prices, by exactly the computed extra ----
    const asFour = await publicAvailability(tx, IN, OUT, { parties: [P(4)] });
    const inh2 = unitOf(asTwo, INH.suId), inh4 = unitOf(asFour, INH.suId);
    const exp4 = await expectedFor(tx, INH, P(4));
    assert.ok(inh4.totalPrice > inh2.totalPrice, "4 guests cost more than 2 on the same unit");
    assert.equal(inh4.totalPrice, exp4.total, "4 guests = accommodation + (rounded extra × nights), from the rows");
    assert.equal(round2(inh4.totalPrice - inh2.totalPrice), round2(exp4.extra * NIGHTS),
      "the difference is exactly the extra-guest money the property configured, per night, rounded per the property rule");
    assert.notEqual(exp4.extra, exp4.chargeable.totalExtra, "the property's rounding rule actually changed the amount (unit rounding of a non-round default)");
    ok("2 vs 4 guests on one unit differ by the configured extra-guest amount — rounding included");

    // ---- 3. the three pricing modes: quote = computed = engine = booking seam ----
    for (const party of [P(2, 2), P(3, 1, 1), P(1, 0, 1)]) {
      const types = await publicAvailability(tx, IN, OUT, { parties: [party] });
      for (const u of [INH, OVR, PART]) {
        const q = unitOf(types, u.suId);
        const exp = await expectedFor(tx, u, party);
        assert.ok(exp.valid, `${u.code} can host ${formatGuestsParam([party])}+${party.infants}i`);
        assert.ok(q, `${u.code} offered for ${formatGuestsParam([party])}+${party.infants}i`);
        const ref = await engineAndSeam(tx, u, party);
        assert.equal(q.totalPrice, exp.total, `${u.code} ${formatGuestsParam([party])}+${party.infants}i: quote = computed from rows`);
        assert.equal(q.totalPrice, ref.engine, `${u.code} ${formatGuestsParam([party])}+${party.infants}i: quote = calculateReservationPrice`);
        assert.equal(q.totalPrice, ref.seam, `${u.code} ${formatGuestsParam([party])}+${party.infants}i: quote = priceReservationStays (what the booking commits)`);
        assert.deepEqual(q.partyPrices, [q.totalPrice], "single party: partyPrices is [totalPrice]");
        if (party.infants > 0) {
          assert.ok(exp.chargeable.extraInfants > 0, `${u.code}: the infant is chargeable under this property's infant policy`);
        }
      }
      // per-stay vs per-night: OVR's extra is charged once, the others per night
      const expOvr = await expectedFor(tx, OVR, party), expInh = await expectedFor(tx, INH, party);
      assert.equal(expOvr.total - expOvr.accommodation, expOvr.extra, "OVR (per_stay): extra charged once for the stay");
      assert.equal(round2(expInh.total - expInh.accommodation), round2(expInh.extra * NIGHTS), "INH (per_night): extra charged every night");
    }
    ok("inherit / full override / partial override: quote = computed-from-rows = engine = booking seam, for adults, children and infants");

    // ---- 4. capacity: a unit that cannot host the party is not offered ----
    const asThree = await publicAvailability(tx, IN, OUT, { parties: [P(3)] });
    assert.ok(unitOf(asTwo, SMALL.suId), "SMALL is offered to 2 adults");
    assert.equal(unitOf(asThree, SMALL.suId), null, "SMALL is NOT offered to 3 adults (max_adults 2)");
    assert.equal(asThree[0].availableUnits, asTwo[0].availableUnits - 1, "availableUnits counts only units that fit");
    const asTwoTwo = await publicAvailability(tx, IN, OUT, { parties: [P(2, 2)] });
    assert.equal(unitOf(asTwoTwo, SMALL.suId), null, "SMALL is NOT offered to 2+2 (max_children 1)");
    assert.equal((await expectedFor(tx, SMALL, P(2, 2))).valid, false, "…and the shared capacity rule agrees");
    assert.equal(asTwoTwo[0].units.length, 3, "the other three still are");
    ok("capacity filter per unit: what the site would show is exactly what the engine will accept");

    // ---- 5. multi-room: a price per unit per party, aligned with the request ----
    const parties = [P(2), P(3)];
    const multi = await publicAvailability(tx, IN, OUT, { parties });
    for (const u of multi[0].units) {
      assert.equal(u.partyPrices.length, parties.length, `${u.code}: one price per requested room`);
      assert.equal(u.partyPrices[0], u.totalPrice, `${u.code}: index 0 is the unit's totalPrice`);
      for (let i = 0; i < parties.length; i++) {
        const exp = await expectedFor(tx, u, parties[i]);
        assert.equal(u.partyPrices[i], exp.valid ? exp.total : null,
          `${u.code} room ${i + 1} (${formatGuestsParam([parties[i]])}): ${exp.valid ? "computed price" : "null — cannot host"}`);
      }
    }
    assert.ok(unitOf(multi, SMALL.suId), "SMALL is offered (it hosts the first party)");
    assert.equal(unitOf(multi, SMALL.suId).partyPrices[1], null, "…but is null for the second room's party of 3");
    const prices = multi[0].units.map((u) => u.totalPrice);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b), "units sorted by totalPrice, ascending");
    assert.equal(multi[0].totalPrice, prices[0], "the type's from-price is the cheapest offered unit");
    assert.equal(multi[0].pricePerNight, round2(prices[0] / NIGHTS), "…and pricePerNight follows it");
    ok("multi-room: partyPrices per unit aligned with the guests list; null marks a room the unit cannot host");

    // ---- 5b. multi-room, the owner's case: room 1 = 2+2, room 2 = 2+0 — the
    //      small unit fits ONLY the second room and must still be offered ----
    const mixed = [P(2, 2), P(2)];
    const asMixed = await publicAvailability(tx, IN, OUT, { parties: mixed });
    assert.equal(asMixed[0].availableUnits, 4, "all four units are offered: each hosts at least one of the two parties");
    const smallMixed = unitOf(asMixed, SMALL.suId);
    assert.ok(smallMixed, "SMALL is offered although it cannot host the FIRST party");
    assert.equal(smallMixed.partyPrices[0], null, "SMALL: null at index 0 (2+2 exceeds max_children 1)");
    const expSmall2 = await expectedFor(tx, SMALL, P(2));
    assert.ok(expSmall2.valid, "…while the shared capacity rule accepts SMALL for 2 adults");
    assert.equal(smallMixed.partyPrices[1], expSmall2.total, "SMALL: index 1 is the computed 2-adult price (1 included + 1 extra adult × nights, rounded)");
    assert.equal(smallMixed.totalPrice, smallMixed.partyPrices[1], "SMALL: totalPrice is the price for the first room it CAN host");
    assert.equal(smallMixed.totalPrice, (await engineAndSeam(tx, SMALL, P(2))).seam, "…and it is what the booking would commit for that room");
    for (const u of [INH, OVR, PART]) {
      const q = unitOf(asMixed, u.suId);
      for (let i = 0; i < mixed.length; i++) {
        const exp = await expectedFor(tx, u, mixed[i]);
        assert.ok(exp.valid, `${u.code} can host room ${i + 1}`);
        assert.equal(q.partyPrices[i], exp.total, `${u.code} room ${i + 1} (${formatGuestsParam([mixed[i]])}): computed price`);
      }
      assert.equal(q.totalPrice, q.partyPrices[0], `${u.code}: totalPrice is the first room's price when it hosts it`);
    }
    // a unit that fits NEITHER party is not offered
    const asNeither = await publicAvailability(tx, IN, OUT, { parties: [P(3), P(2, 2)] });
    assert.equal(unitOf(asNeither, SMALL.suId), null, "SMALL is not offered when it can host neither 3+0 nor 2+2");
    assert.equal(asNeither[0].availableUnits, 3, "…and availableUnits counts the other three");
    ok("multi-room, different parties: a unit that fits only the second room is offered with null at index 0 and its engine price at index 1; a unit fitting no room is not offered");

    // ---- 5c. room assignment (assign-units.ts): room i ↔ partyPrices[i], cheapest valid combination ----
    // independent brute force over the availability result — every ordered pair of distinct units
    const bruteBest = (units, rooms, fixedFirst = null) => {
      let best = null;
      const rec = (i, chosen, total) => {
        if (i === rooms) { if (!best || total < best.total) best = { units: [...chosen], total }; return; }
        for (const u of units) {
          if (chosen.includes(u) || u.partyPrices[i] == null) continue;
          if (i === 0 && fixedFirst && u.suId !== fixedFirst) continue;
          rec(i + 1, [...chosen, u], total + u.partyPrices[i]);
        }
      };
      rec(0, [], 0);
      return best;
    };
    const sumOf = (units) => round2(units.reduce((s, u, i) => s + u.partyPrices[i], 0));
    const a1 = assignUnitsToRooms(asMixed[0].units, 2, null);
    assert.ok(a1.ok, "2+2 / 2+0 without a preferred unit: a combination exists");
    assert.equal(a1.units.length, 2, "one unit per room");
    assert.notEqual(a1.units[0].suId, a1.units[1].suId, "two different units");
    assert.ok(a1.units[0].partyPrices[0] != null && a1.units[1].partyPrices[1] != null, "each unit hosts the party of ITS room");
    assert.equal(sumOf(a1.units), round2(bruteBest(asMixed[0].units, 2).total), "…and the total is the cheapest valid combination (brute force agrees)");
    const a2 = assignUnitsToRooms(asMixed[0].units, 2, SMALL.suId);
    assert.deepEqual(a2, { ok: false, reason: "preferred_mismatch" }, "SMALL chosen for room 1 (2+2): explicit mismatch, never a silent swap");
    const asFlipped = await publicAvailability(tx, IN, OUT, { parties: [P(2), P(2, 2)] });
    const a3 = assignUnitsToRooms(asFlipped[0].units, 2, SMALL.suId);
    assert.ok(a3.ok && a3.units[0].suId === SMALL.suId, "SMALL chosen for room 1 (2+0): honoured");
    assert.equal(sumOf(a3.units), round2(bruteBest(asFlipped[0].units, 2, SMALL.suId).total), "…room 2 gets the cheapest unit that hosts 2+2");
    // the trap a greedy pick falls into: INH is cheaper than SMALL for 2+0, but
    // it is the only one of the two that can host 2+2 — the combination must
    // put SMALL on room 1 and INH on room 2 (real units, real engine prices)
    const pair = asFlipped[0].units.filter((u) => u.suId === INH.suId || u.suId === SMALL.suId);
    assert.ok(unitOf([{ units: pair }], INH.suId).partyPrices[0] < unitOf([{ units: pair }], SMALL.suId).partyPrices[0], "precondition: INH is the cheaper unit for 2+0");
    const a4 = assignUnitsToRooms(pair, 2, null);
    assert.ok(a4.ok, "a valid combination is found although the cheapest unit for room 1 must be left for room 2");
    assert.deepEqual(a4.units.map((u) => u.suId), [SMALL.suId, INH.suId], "SMALL → room 1 (2+0), INH → room 2 (2+2)");
    assert.deepEqual(assignUnitsToRooms(pair, 2, INH.suId), { ok: false, reason: "no_combination" }, "INH forced on room 1: no unit is left for 2+2 — explicit, not a mismatched booking");
    assert.deepEqual(assignUnitsToRooms(asMixed[0].units, 2, "00000000-0000-4000-8000-000000000000"), { ok: false, reason: "preferred_unavailable" }, "a unit that is not offered: explicit");
    assert.deepEqual(assignUnitsToRooms(browse[0].units, 1, null), { ok: false, reason: "no_combination" }, "units priced without parties (no partyPrices) host nothing — the booking must ask for the real parties");
    // the booking really goes through this rule and refuses a mismatch by name (textual pins, D106 style)
    const bookingSrc = readFileSync(join(ROOT, "src/lib/public-booking/create-booking.ts"), "utf8");
    assert.ok(/assignUnitsToRooms\(type\.units, input\.rooms\.length, input\.preferredUnitId\)/.test(bookingSrc), "createPublicBooking assigns rooms through assignUnitsToRooms");
    assert.ok(/partyPrices\?\.\[i\] == null[\s\S]{0,200}"unit_party_mismatch"/.test(bookingSrc), "createPublicBooking checks room i ↔ partyPrices[i] explicitly and throws unit_party_mismatch");
    assert.ok(!/ordered\.slice\(0, input\.rooms\.length\)/.test(bookingSrc), "the positional slice is gone");
    ok("room assignment: preferred unit → room 1 or an explicit mismatch; the rest is the cheapest valid combination (brute force agrees); no positional pick anywhere");

    // ---- 6. live: a change in the property settings or in /rooms moves the quote at once ----
    const before = unitOf(await publicAvailability(tx, IN, OUT, { parties: [P(4)] }), INH.suId).totalPrice;
    await tx`
      UPDATE guesthub.tenants
      SET settings = jsonb_set(settings, '{extra_guest,extra_adult}', to_jsonb(
        ((settings->'extra_guest'->>'extra_adult')::numeric + 17.5)))
      WHERE id = ${FIXED_TENANT}`;
    const afterProp = unitOf(await publicAvailability(tx, IN, OUT, { parties: [P(4)] }), INH.suId).totalPrice;
    const expProp = await expectedFor(tx, INH, P(4));
    assert.notEqual(afterProp, before, "property default changed → INH's quote moved");
    assert.equal(afterProp, expProp.total, "…to exactly the recomputed number");
    assert.equal(afterProp, (await engineAndSeam(tx, INH, P(4))).seam, "…which is what the booking would commit");
    await tx`
      UPDATE guesthub.rooms
      SET extra_guest_pricing_mode = 'override', extra_adult_override = 1
      WHERE id = ${INH.roomId}`;
    const afterRoom = unitOf(await publicAvailability(tx, IN, OUT, { parties: [P(4)] }), INH.suId).totalPrice;
    const expRoom = await expectedFor(tx, INH, P(4));
    assert.equal(expRoom.effective.extra_adult.source, "room_override", "the room now overrides the adult amount");
    assert.notEqual(afterRoom, afterProp, "room override saved → quote moved again");
    assert.equal(afterRoom, expRoom.total, "…to exactly the recomputed number");
    assert.equal(afterRoom, (await engineAndSeam(tx, INH, P(4))).seam, "…which is what the booking would commit");
    ok("no caching, no copies: a settings or /rooms change is in the next availability response");

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { await sql.end(); throw e; }
}
await sql.end();
console.log(`\nALL ${n} PUBLIC-AVAILABILITY-GUESTS CHECKS PASSED — nothing committed`);
