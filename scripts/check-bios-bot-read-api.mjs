// ============================================================
// check:bios-bot-read-api — Phase 5 GuestHub Service API, read side.
//
// Tests the SERVICE LAYER directly (src/lib/bios-bot/service/*.ts) — the
// same convention as check-pricing-engine.mjs / check-room-capacity-inherit.mjs:
// the route.ts files are deliberately thin (auth + Zod + JSON only, same
// thinness as the existing /api/public/* routes, which carry no dedicated
// route-level tests either); the actual business logic lives here and is
// compiled+called against the ISOLATED test DB (:5433, NEVER prod).
//
// Usage: node scripts/check-bios-bot-read-api.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);
const TEST_URL = process.env.TEST_DATABASE_URL || "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (TEST_URL.includes(marker)) { console.error(`REFUSED: production marker "${marker}"`); process.exit(1); }
}

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };

// ---- Part 0 (static): guesthub.reservation_cards is never QUERIED under the
// BIOS Bot surface. Comments are allowed (and encouraged) to name the table
// to document the exclusion — only a real FROM/JOIN of it is the defect.
{
  let hits = "";
  try {
    hits = execSync(
      "grep -rnE '(FROM|JOIN)\\s+guesthub\\.reservation_cards' src/lib/bios-bot/ src/app/api/bios-bot/",
      { cwd: ROOT, encoding: "utf8" },
    );
  } catch { /* grep exit 1 = no matches = exactly what we want */ }
  assert.equal(hits.trim(), "", `reservation_cards queried under the BIOS Bot surface:\n${hits}`);
  ok("static: guesthub.reservation_cards is never FROM/JOIN'd anywhere under the BIOS Bot connector surface");
}

console.log("applying migration chain to the test DB…");
const migrations = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
for (const f of migrations) {
  execSync(`psql "${TEST_URL}" -v ON_ERROR_STOP=1 -q < "db/migrations/${f}"`,
    { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" });
}

console.log("compiling src/lib/bios-bot + engine via tsc…");
const tmp = mkdtempSync(join(tmpdir(), "gh-biosbot-read-"));
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
    join(ROOT, "src/lib/bios-bot/service/rooms.ts"),
    join(ROOT, "src/lib/bios-bot/service/availability.ts"),
    join(ROOT, "src/lib/bios-bot/service/quote.ts"),
    join(ROOT, "src/lib/bios-bot/service/reservations.ts"),
    join(ROOT, "src/lib/pricing/engine.ts"),
  ],
}));
execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });

const stub = join(tmp, "server-only-stub.js");
writeFileSync(stub, "module.exports = {};\n");
const nextServerStub = join(tmp, "next-server-stub.js");
writeFileSync(nextServerStub, `
  class FakeResponse { constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; } }
  module.exports = { NextResponse: { json: (body, init) => new FakeResponse(body, init) } };
`);
const req = createRequire(join(ROOT, "package.json"));
const Module = req("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return stub;
  if (request === "next/server") return nextServerStub;
  if (request.startsWith("@/")) return origResolve.call(this, join(out, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};

const { listBiosBotRooms, getBiosBotRoom } = req(join(out, "lib/bios-bot/service/rooms.js"));
const { searchBiosBotAvailability } = req(join(out, "lib/bios-bot/service/availability.js"));
const { getBiosBotQuote } = req(join(out, "lib/bios-bot/service/quote.js"));
const { getBiosBotReservation, lookupBiosBotReservationsByCustomer } = req(join(out, "lib/bios-bot/service/reservations.js"));
const { calculateReservationPrice } = req(join(out, "lib/pricing/engine.js"));

const postgres = req("postgres");
const sql = postgres(TEST_URL, { prepare: false, max: 1, onnotice: () => {} });
class Rollback extends Error {}
const IN = "2027-05-10", OUT = "2027-05-12"; // 2 nights, far-future — availability/quote test window
const RES_IN = "2027-08-01", RES_OUT = "2027-08-03"; // a DIFFERENT window for the reservation-lookup fixture,
// deliberately not overlapping IN/OUT — a reservation on room A here must not make room A "unavailable"
// for the availability search tests, which query the IN/OUT window

async function buildFixture(tx) {
  const uniq = (p) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const mkTenant = async (name) => {
    const [t] = await tx`INSERT INTO guesthub.tenants (name, slug, currency, settings)
      VALUES (${name}, ${uniq("bb")}, 'ILS', ${tx.json({ vat_rate: 18 })}) RETURNING id`;
    return t.id;
  };
  const T = await mkTenant("BIOS Bot Read A");
  const T2 = await mkTenant("BIOS Bot Read B");

  const [rt] = await tx`INSERT INTO guesthub.room_types (tenant_id, name, base_price, max_occupancy, max_adults, max_children, max_infants)
    VALUES (${T}, 'Type', 400, 4, 3, 2, 1) RETURNING id`;

  const mkRoom = async (tenantId, num, extra = {}) => {
    const [r] = await tx`INSERT INTO guesthub.rooms ${tx({
      tenant_id: tenantId, room_type_id: rt.id, room_number: num, name: `Room ${num}`,
      status: "available", is_active: true, show_on_website: true,
      max_occupancy: 4, max_adults: 3, max_children: 2, max_infants: 1,
      included_occupancy: 2, extra_guest_pricing_mode: "inherit",
      ...extra,
    })} RETURNING id`;
    return r.id;
  };
  const asSellable = async (roomId, num) => {
    const [su] = await tx`INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id)
      VALUES (${T}, ${num}, ${`Unit ${num}`}, ${rt.id}) RETURNING id`;
    await tx`INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id) VALUES (${T}, ${su.id}, ${roomId})`;
    const [bp] = await tx`INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base, plan_kind, is_active)
      VALUES (${T}, ${su.id}, ${"base-" + num}, 'Base', true, 'base', true) RETURNING id`;
    await tx`INSERT INTO guesthub.pricing_plan_rates (tenant_id, sellable_unit_id, pricing_plan_id, date, price)
      VALUES (${T}, ${su.id}, ${bp.id}, ${IN}, 500), (${T}, ${su.id}, ${bp.id}, '2027-05-11', 500)`;
    return su.id;
  };

  // A: shown on website, has an image (required by publicWebsiteRooms), normal capacity
  const roomA = await mkRoom(T, "bb-101");
  await tx`INSERT INTO guesthub.room_images (tenant_id, room_id, url, is_main) VALUES (${T}, ${roomA}, 'https://x/a.jpg', true)`;
  await tx`INSERT INTO guesthub.room_translations (tenant_id, room_id, lang, name, description)
    VALUES (${T}, ${roomA}, 'he', 'חדר בדיקה', 'תיאור בדיקה')`;
  await asSellable(roomA, "bb-101");

  // B: NOT shown on website — must never appear in the catalog
  const roomB = await mkRoom(T, "bb-102", { show_on_website: false });
  await tx`INSERT INTO guesthub.room_images (tenant_id, room_id, url, is_main) VALUES (${T}, ${roomB}, 'https://x/b.jpg', true)`;

  // C: shown on website, tiny capacity (max_adults=1, max_occupancy=1) — availability capacity filter target
  const roomC = await mkRoom(T, "bb-103", { max_occupancy: 1, max_adults: 1, max_children: 0, max_infants: 0, included_occupancy: 1 });
  await tx`INSERT INTO guesthub.room_images (tenant_id, room_id, url, is_main) VALUES (${T}, ${roomC}, 'https://x/c.jpg', true)`;
  await asSellable(roomC, "bb-103");

  // guest + reservation + reservation_rooms + a stored card (must NEVER surface)
  const [guest] = await tx`INSERT INTO guesthub.guests (tenant_id, first_name, last_name, full_name, phone, email)
    VALUES (${T}, 'דנה', 'כהן', 'דנה כהן', '0501234567', 'dana@example.com') RETURNING id`;
  const [res] = await tx`INSERT INTO guesthub.reservations
    (tenant_id, reservation_number, primary_guest_id, status, check_in, check_out, total_price, paid_amount, currency)
    VALUES (${T}, ${uniq("RN")}, ${guest.id}, 'confirmed', ${RES_IN}, ${RES_OUT}, 1000, 400, 'ILS') RETURNING id, reservation_number`;
  await tx`INSERT INTO guesthub.reservation_rooms (tenant_id, reservation_id, room_id, check_in, check_out, adults, children, infants, rate_per_night, price_total)
    VALUES (${T}, ${res.id}, ${roomA}, ${RES_IN}, ${RES_OUT}, 2, 0, 0, 500, 1000)`;
  await tx`INSERT INTO guesthub.reservation_cards (tenant_id, reservation_id, holder_name, pan_encrypted, last4, exp_month, exp_year)
    VALUES (${T}, ${res.id}, 'Dana Cohen', 'v1.fake.fake.fake', '4242', 12, 2030)`;

  return { T, T2, rt: rt.id, roomA, roomB, roomC, guest, res };
}

try {
  await sql.begin(async (tx) => {
    const f = await buildFixture(tx);

    // ============================================================
    // Rooms
    // ============================================================
    {
      const rooms = await listBiosBotRooms(tx, f.T);
      const numbers = rooms.map((r) => r.roomNumber);
      assert.ok(numbers.includes("bb-101"), "show_on_website room appears in the catalog");
      assert.ok(!numbers.includes("bb-102"), "a room NOT marked show_on_website never appears");
      ok("listBiosBotRooms: only show_on_website rooms are listed");
    }
    {
      const room = await getBiosBotRoom(tx, f.T, f.roomA, "he");
      assert.ok(room, "the shown room resolves");
      assert.equal(room.title, "חדר בדיקה", "the Hebrew translation is used as the title");
      const hidden = await getBiosBotRoom(tx, f.T, f.roomB);
      assert.equal(hidden, null, "a room not marked show_on_website resolves to null, not an error");
      ok("getBiosBotRoom: returns customer content for a shown room, null for a hidden one");
    }
    {
      const rooms = await listBiosBotRooms(tx, f.T2);
      assert.equal(rooms.length, 0, "tenant B sees none of tenant A's rooms");
      ok("listBiosBotRooms: tenant isolation");
    }

    // ============================================================
    // Availability
    // ============================================================
    {
      const results = await searchBiosBotAvailability(tx, f.T, { checkIn: IN, checkOut: OUT, adults: 2, children: 0, infants: 0 });
      const type = results.find((r) => r.roomTypeId === f.rt);
      assert.ok(type, "the room type is available for a 2-adult party");
      assert.ok(type.availableUnits >= 1, "at least the normal-capacity unit is counted");
      ok("searchBiosBotAvailability: a party that fits sees the room type");
    }
    {
      // room C's SU alone accommodates only 1 adult; asking for 2 must exclude
      // it from the eligible-unit count without erroring
      const results = await searchBiosBotAvailability(tx, f.T, { checkIn: IN, checkOut: OUT, adults: 2, children: 0, infants: 0 });
      const type = results.find((r) => r.roomTypeId === f.rt);
      // roomA (cap 3 adults) + roomC (cap 1 adult) are both units of the same
      // type; a 2-adult party must be offered exactly roomA's unit, not roomC's
      assert.equal(type.availableUnits, 1, "the 1-adult-capacity unit is excluded from a 2-adult search");
      ok("searchBiosBotAvailability: capacity filter excludes a unit too small for the party, keeps the one that fits");
    }
    {
      const results = await searchBiosBotAvailability(tx, f.T, { checkIn: IN, checkOut: OUT, adults: 10, children: 0, infants: 0 });
      const type = results.find((r) => r.roomTypeId === f.rt);
      assert.equal(type, undefined, "a party too large for every unit removes the room type entirely (never a 0-but-listed row)");
      ok("searchBiosBotAvailability: a room type with zero eligible units is omitted, not listed at 0");
    }
    {
      const results = await searchBiosBotAvailability(tx, f.T2, { checkIn: IN, checkOut: OUT, adults: 1, children: 0, infants: 0 });
      assert.equal(results.length, 0, "tenant B sees no availability from tenant A's inventory");
      ok("searchBiosBotAvailability: tenant isolation");
    }

    // ============================================================
    // Quote — must equal the authoritative engine, verbatim
    // ============================================================
    {
      const engineDirect = await calculateReservationPrice(tx, {
        tenantId: f.T, checkIn: IN, checkOut: OUT,
        rooms: [{ roomId: f.roomA, ratePlanId: null, adults: 2, children: 0, infants: 0, manualRatePerNight: null }],
        source: "internal",
      });
      const apiQuote = await getBiosBotQuote(tx, f.T, {
        checkIn: IN, checkOut: OUT,
        rooms: [{ roomId: f.roomA, adults: 2, children: 0, infants: 0 }],
      });
      assert.equal(apiQuote.totalGross, engineDirect.totalGross, "API quote total == direct engine total");
      assert.equal(apiQuote.quoteFingerprint, engineDirect.quoteFingerprint, "API quote fingerprint == direct engine fingerprint");
      assert.equal(apiQuote.rooms[0].subtotal, engineDirect.rooms[0].roomSubtotal);
      ok("getBiosBotQuote: matches calculateReservationPrice exactly (same total, same fingerprint)");
    }
    {
      let threw = null;
      try {
        await getBiosBotQuote(tx, f.T, { checkIn: IN, checkOut: OUT, rooms: [{ roomId: f.roomC, adults: 5, children: 0, infants: 0 }] });
      } catch (e) { threw = e; }
      assert.ok(threw, "over-capacity quote throws");
      assert.equal(threw.code, "CAPACITY_EXCEEDED", "over-capacity maps to the stable CAPACITY_EXCEEDED code");
      ok("getBiosBotQuote: a capacity violation surfaces as CAPACITY_EXCEEDED (BiosBotError), not a raw engine code");
    }
    {
      let threw = null;
      try {
        await getBiosBotQuote(tx, f.T2, { checkIn: IN, checkOut: OUT, rooms: [{ roomId: f.roomA, adults: 2, children: 0, infants: 0 }] });
      } catch (e) { threw = e; }
      assert.ok(threw, "quoting tenant A's room as tenant B throws");
      assert.equal(threw.code, "ROOM_NOT_AVAILABLE", "cross-tenant room resolves as ROOM_NOT_AVAILABLE (never a different tenant's data)");
      ok("getBiosBotQuote: tenant isolation (cross-tenant roomId cannot be priced)");
    }

    // ============================================================
    // Reservation lookup
    // ============================================================
    {
      const reservation = await getBiosBotReservation(tx, f.T, f.res.id);
      assert.equal(reservation.reservationNumber, f.res.reservation_number);
      assert.equal(reservation.totalPrice, 1000);
      assert.equal(reservation.paidAmount, 400);
      assert.equal(reservation.balance, 600, "balance computed via the canonical balanceOf(), not a stored/stale column");
      assert.equal(reservation.rooms.length, 1);
      assert.equal(reservation.rooms[0].roomId, f.roomA);
      const json = JSON.stringify(reservation);
      assert.ok(!/pan|cvv|card/i.test(json), "the returned object contains no card-related field of any kind");
      ok("getBiosBotReservation: correct minimized shape, correct balance, zero card data present");
    }
    {
      let threw = null;
      try { await getBiosBotReservation(tx, f.T, "00000000-0000-0000-0000-000000000000"); } catch (e) { threw = e; }
      assert.ok(threw, "an unknown id throws");
      assert.equal(threw.code, "RESERVATION_NOT_FOUND");
      ok("getBiosBotReservation: RESERVATION_NOT_FOUND for a non-existent id");
    }
    {
      let threw = null;
      try { await getBiosBotReservation(tx, f.T2, f.res.id); } catch (e) { threw = e; }
      assert.ok(threw, "tenant B fetching tenant A's reservation throws");
      assert.equal(threw.code, "RESERVATION_NOT_FOUND", "cross-tenant lookup is indistinguishable from not-found");
      ok("getBiosBotReservation: tenant isolation");
    }

    // ============================================================
    // Customer lookup — exact identifiers only
    // ============================================================
    {
      const byNumber = await lookupBiosBotReservationsByCustomer(tx, f.T, { reservationNumber: f.res.reservation_number });
      assert.equal(byNumber.length, 1);
      assert.equal(byNumber[0].id, f.res.id);
      ok("lookupBiosBotReservationsByCustomer: exact reservation number match");
    }
    {
      const byPhone = await lookupBiosBotReservationsByCustomer(tx, f.T, { phone: "0501234567" });
      assert.equal(byPhone.length, 1);
      const byWrongPhone = await lookupBiosBotReservationsByCustomer(tx, f.T, { phone: "050123456" }); // one digit short
      assert.equal(byWrongPhone.length, 0, "a prefix of a real phone matches nothing — exact equality only");
      ok("lookupBiosBotReservationsByCustomer: exact phone match, no prefix/substring matching");
    }
    {
      const byEmail = await lookupBiosBotReservationsByCustomer(tx, f.T, { email: "DANA@EXAMPLE.COM" });
      assert.equal(byEmail.length, 1, "email match is case-insensitive");
      ok("lookupBiosBotReservationsByCustomer: case-insensitive exact email match");
    }
    {
      const crossTenant = await lookupBiosBotReservationsByCustomer(tx, f.T2, { reservationNumber: f.res.reservation_number });
      assert.equal(crossTenant.length, 0, "tenant B's lookup of tenant A's reservation number returns nothing");
      ok("lookupBiosBotReservationsByCustomer: tenant isolation");
    }

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { console.error(e); await sql.end(); process.exit(1); }
}

await sql.end();
console.log(`\nALL ${n} BIOS-BOT READ-API CHECKS PASSED (nothing committed)`);
