// ============================================================
// check:bios-bot-booking-inventory — D196: the BIOS Bot availability answer
// carries the BOOKING inventory (availableRooms), not the website catalog.
//
// The service under test (src/lib/bios-bot/service/availability.ts) is
// compiled and called against the ISOLATED test DB (never prod), with a
// fixture that reproduces the real StayMe cases:
//   - a sellable room WITHOUT an image (1238/1242/1245) and one hidden from
//     the website (1042) — sellable, so they are booking inventory;
//   - an inactive room whose sellable unit is still active (1102/1243/2000)
//     and an out_of_order room that still has an image (926) — the engine's
//     own rule (sellable_unit_inventory: status='available' AND is_active)
//     decides, and this guard proves availableRooms follows it exactly;
//   - a max-2 studio (1130) — never offered to 2 adults + 1 child.
// The website catalog (publicWebsiteRooms, via listBiosBotRooms) follows the
// D197 rule: show_on_website AND active (is_active AND status <> 'inactive').
// A photo is NOT a catalog condition any more, and out_of_order is listed —
// the catalog and the booking inventory stay two different questions.
//
// Usage: node scripts/check-bios-bot-booking-inventory.mjs
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

console.log("applying migration chain to the test DB…");
const migrations = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
for (const f of migrations) {
  execSync(`psql "${TEST_URL}" -v ON_ERROR_STOP=1 -q < "db/migrations/${f}"`,
    { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" });
}

console.log("compiling src/lib/bios-bot services via tsc…");
const tmp = mkdtempSync(join(tmpdir(), "gh-biosbot-inventory-"));
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
  ],
}));
execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });

const stub = join(tmp, "server-only-stub.js");
writeFileSync(stub, "module.exports = {};\n");
const nextServerStub = join(tmp, "next-server-stub.js"); // errors.ts imports NextResponse
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

const { listBiosBotRooms } = req(join(out, "lib/bios-bot/service/rooms.js"));
const { searchBiosBotAvailability } = req(join(out, "lib/bios-bot/service/availability.js"));
const { getBiosBotQuote } = req(join(out, "lib/bios-bot/service/quote.js"));

const postgres = req("postgres");
const sql = postgres(TEST_URL, { prepare: false, max: 1, onnotice: () => {} });
class Rollback extends Error {}
const IN = "2027-06-14", OUT = "2027-06-16"; // 2 nights, far-future

async function buildFixture(tx) {
  // extra_guest mirrors the real property (configured, per-night amounts): the
  // engine refuses to quote a chargeable extra guest whose category has no
  // amount (EXTRA_GUEST_PRICING_INCOMPLETE), and since availability is now
  // priced for the requested party, an unpriceable unit is not offered at all.
  // A fixture without this block would therefore be testing the dead-end the
  // module forbids ("the filter must never be MORE permissive than
  // priceReservationStays") — see the unconfigured case asserted below.
  const [t] = await tx`INSERT INTO guesthub.tenants (name, slug, currency, settings)
    VALUES ('BIOS Bot Inventory', ${`bbi-${Date.now()}-${Math.floor(Math.random() * 1e6)}`}, 'ILS',
            ${tx.json({ vat_rate: 18, extra_guest: {
              configured: true, extra_adult: 200, extra_child: 200, extra_infant: 200,
              charge_frequency: "per_night", infant_max_age: 2, child_max_age: 12,
              infants_count_occupancy: false, infants_use_included: false,
              tax_mode: "inclusive", rounding_mode: "unit", rounding_increment: 1,
            } })}) RETURNING id`;
  const T = t.id;
  const [studio] = await tx`INSERT INTO guesthub.room_types (tenant_id, name, base_price, max_occupancy, max_adults, max_children, max_infants)
    VALUES (${T}, 'Studio', 450, 2, 2, 1, 1) RETURNING id`;
  const [bedroom] = await tx`INSERT INTO guesthub.room_types (tenant_id, name, base_price, max_occupancy, max_adults, max_children, max_infants)
    VALUES (${T}, 'Bedroom', 680, 4, 4, 2, 1) RETURNING id`;

  const room = async (num, typeId, extra = {}, { image = false } = {}) => {
    const [r] = await tx`INSERT INTO guesthub.rooms ${tx({
      tenant_id: T, room_type_id: typeId, room_number: num, name: `Room ${num}`,
      status: "available", is_active: true, show_on_website: true,
      max_occupancy: 4, max_adults: 4, max_children: 2, max_infants: 1,
      included_occupancy: 2, extra_guest_pricing_mode: "inherit",
      ...extra,
    })} RETURNING id`;
    if (image) await tx`INSERT INTO guesthub.room_images (tenant_id, room_id, url, is_main) VALUES (${T}, ${r.id}, ${`https://x/${num}.jpg`}, true)`;
    // every room is a sellable unit with a priced base plan for the stay
    const [su] = await tx`INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id)
      VALUES (${T}, ${num}, ${`Unit ${num}`}, ${typeId}) RETURNING id`;
    await tx`INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id) VALUES (${T}, ${su.id}, ${r.id})`;
    const [bp] = await tx`INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base, plan_kind, is_active)
      VALUES (${T}, ${su.id}, ${"base-" + num}, 'Base', true, 'base', true) RETURNING id`;
    await tx`INSERT INTO guesthub.pricing_plan_rates (tenant_id, sellable_unit_id, pricing_plan_id, date, price)
      VALUES (${T}, ${su.id}, ${bp.id}, ${IN}, 600), (${T}, ${su.id}, ${bp.id}, '2027-06-15', 600)`;
    return { id: r.id, num, su: su.id, typeId };
  };

  return {
    T, studio: studio.id, bedroom: bedroom.id,
    // 1130: website + image, room-level max 2 adults / 0 children
    studioMax2: await room("st-1130", studio.id, { max_occupancy: 2, max_adults: 2, max_children: 0, max_infants: 1 }, { image: true }),
    // 1238: sellable studio WITHOUT an image
    studioNoImage: await room("st-1238", studio.id, { max_occupancy: 2, max_adults: 2, max_children: 0, max_infants: 0 }),
    // 1142: website + image, normal
    bedImage: await room("bd-1142", bedroom.id, {}, { image: true }),
    // 1242/1245: website flag on, but no image (D197: still in the catalog)
    bedNoImage: await room("bd-1245", bedroom.id),
    // 1042: hidden from the website, no image, still sellable
    bedHidden: await room("bd-1042", bedroom.id, { show_on_website: false }),
    // 1102/1243/2000: room inactive, sellable unit still active
    bedInactive: await room("bd-1102", bedroom.id, { is_active: false }, { image: true }),
    // 926: out_of_order, shown on the website
    bedOutOfOrder: await room("bd-926", bedroom.id, { status: "out_of_order" }, { image: true }),
  };
}

const ids = (list) => new Set(list.map((r) => r.roomId));

try {
  await sql.begin(async (tx) => {
    const f = await buildFixture(tx);
    const all = [f.studioMax2, f.studioNoImage, f.bedImage, f.bedNoImage, f.bedHidden, f.bedInactive, f.bedOutOfOrder];
    const twoAdults = await searchBiosBotAvailability(tx, f.T, { checkIn: IN, checkOut: OUT, adults: 2, children: 0, infants: 0 });
    const byType = new Map(twoAdults.map((t) => [t.roomTypeId, t]));

    // ---- Room without image / hidden from website: booking inventory --------
    {
      const bed = ids(byType.get(f.bedroom).availableRooms);
      const st = ids(byType.get(f.studio).availableRooms);
      assert.ok(st.has(f.studioNoImage.id), "a sellable studio without an image is booking inventory");
      assert.ok(bed.has(f.bedNoImage.id), "a sellable room with the website flag but no image is booking inventory");
      assert.ok(bed.has(f.bedHidden.id), "a sellable room hidden from the website is booking inventory");
      ok("availableRooms: rooms without an image / hidden from the website are offered (images are not a booking condition)");
    }

    // ---- Website catalog: the D197 rule (show_on_website AND active) ---------
    // Guard classifier updated with D197 (2026-09-28): before it, this block
    // asserted the pre-D197 rule (an image was required). The catalog is still
    // NOT the booking inventory — that separation (D196) is what this guard
    // exists for; only the catalog's own rule moved.
    {
      const catalog = new Set((await listBiosBotRooms(tx, f.T)).map((r) => r.id));
      assert.ok(catalog.has(f.bedImage.id) && catalog.has(f.studioMax2.id), "rooms with website flag + image are in the catalog");
      assert.ok(catalog.has(f.studioNoImage.id) && catalog.has(f.bedNoImage.id), "D197: rooms without an image ARE in the website catalog (photos are not required)");
      assert.ok(!catalog.has(f.bedHidden.id), "a room hidden from the website is NOT in the catalog");
      assert.ok(!catalog.has(f.bedInactive.id), "an inactive room is NOT in the catalog, whatever show_on_website says");
      assert.ok(catalog.has(f.bedOutOfOrder.id), "out_of_order + website flag is listed (active: status <> 'inactive')");
      ok("website catalog (publicWebsiteRooms) = show_on_website AND active — D197; images and bookability are not catalog conditions");
    }

    // ---- Inactive / out_of_order: the engine's own rule ----------------------
    {
      const offered = new Set(twoAdults.flatMap((t) => t.availableRooms.map((r) => r.roomId)));
      assert.ok(!offered.has(f.bedInactive.id), "an inactive room (unit still active) is never offered");
      assert.ok(!offered.has(f.bedOutOfOrder.id), "an out_of_order room is never offered");
      const inv = await tx`
        SELECT sur.room_id, min(i.availability)::int AS min_avail
        FROM guesthub.sellable_unit_inventory(${f.T}, ${IN}, ${OUT}) i
        JOIN guesthub.sellable_unit_rooms sur ON sur.sellable_unit_id = i.sellable_unit_id
        GROUP BY sur.room_id`;
      const engineSellable = new Set(inv.filter((r) => r.min_avail > 0).map((r) => r.room_id));
      for (const r of all) {
        assert.equal(offered.has(r.id), engineSellable.has(r.id), `${r.num}: offered ⇔ sellable_unit_inventory says sellable every night`);
      }
      ok("inactive / out_of_order: availableRooms (2 adults) == exactly the rooms sellable_unit_inventory sells — same rule, not a copy");
    }

    // ---- Capacity -----------------------------------------------------------
    {
      const family = await searchBiosBotAvailability(tx, f.T, { checkIn: IN, checkOut: OUT, adults: 2, children: 1, infants: 0 });
      const offered = new Set(family.flatMap((t) => t.availableRooms.map((r) => r.roomId)));
      assert.ok(!offered.has(f.studioMax2.id), "a max-2 studio (0 children) is not offered to 2 adults + 1 child");
      assert.ok(!family.some((t) => t.roomTypeId === f.studio), "no studio unit fits → the studio type is omitted");
      assert.ok(offered.has(f.bedImage.id) && offered.has(f.bedNoImage.id), "4-guest rooms are offered to the family, image or not");
      for (const t of family) for (const r of t.availableRooms) {
        assert.ok(r.maxOccupancy >= 3 && r.maxAdults >= 2 && r.maxChildren >= 1, `${r.roomNumber}: listed capacity fits 2+1`);
      }
      assert.ok(offered.size > 0);
      ok("capacity: effective room capacity decides — the max-2 studio is never offered to 2 adults + 1 child");
    }

    // ---- Party pricing (2026-09-28) -------------------------------------------
    // The from-price is the engine's price for the REQUESTED party, so a child
    // beyond included_occupancy shows up as money. The old party-blind browse
    // answered 2+1 with the 2-adult figure.
    {
      const two = await searchBiosBotAvailability(tx, f.T, { checkIn: IN, checkOut: OUT, adults: 2, children: 0, infants: 0 });
      const fam = await searchBiosBotAvailability(tx, f.T, { checkIn: IN, checkOut: OUT, adults: 2, children: 1, infants: 0 });
      const bed2 = two.find((t) => t.roomTypeId === f.bedroom);
      const bedFam = fam.find((t) => t.roomTypeId === f.bedroom);
      assert.ok(bed2 && bedFam, "the 4-guest type is offered to both parties");
      assert.equal(bed2.fromPricePerNight, 600, "2 adults: the base rate, no extra guest");
      assert.equal(bedFam.fromPricePerNight, 800, "2 adults + 1 child: base + the child's 200 — NOT the 2-adult 600");
      assert.ok(bedFam.fromPricePerNight > bed2.fromPricePerNight,
        "a party that costs more may never be quoted the cheaper party's price");
      // the "from" price is the cheapest ELIGIBLE unit, and it is a real quote
      assert.equal(bedFam.fromTotalPrice, bedFam.fromPricePerNight * 2, "2 nights");
      ok("party pricing: from-prices are the engine's price for the requested party (2+1 → 800, not 600)");
    }

    // ---- Unpriceable party: not offered, never a dead end ---------------------
    // A property with NO extra-guest amounts cannot price a chargeable extra
    // guest. Offering the unit anyway is the dead-end checkout the module
    // forbids, so the type is omitted for that party — while the same rooms
    // stay on offer for a party that needs no extra guest.
    {
      await tx`UPDATE guesthub.tenants SET settings = ${tx.json({ vat_rate: 18 })} WHERE id = ${f.T}`;
      const fam = await searchBiosBotAvailability(tx, f.T, { checkIn: IN, checkOut: OUT, adults: 2, children: 1, infants: 0 });
      assert.equal(fam.length, 0, "no extra-guest pricing → the family is offered nothing, not an unquotable price");
      const two = await searchBiosBotAvailability(tx, f.T, { checkIn: IN, checkOut: OUT, adults: 2, children: 0, infants: 0 });
      assert.ok(two.some((t) => t.roomTypeId === f.bedroom), "a party needing no extra guest is unaffected");
      ok("unpriceable party: availability is never more permissive than the quote (no dead-end checkouts)");
    }

    // ---- Mapping --------------------------------------------------------------
    {
      const rows = await tx`SELECT id, room_type_id FROM guesthub.rooms WHERE tenant_id = ${f.T}`;
      const typeOf = new Map(rows.map((r) => [r.id, r.room_type_id]));
      for (const t of twoAdults) {
        assert.equal(t.availableUnits, t.availableRooms.length, `${t.name}: availableUnits == availableRooms.length (same eligible set)`);
        for (const r of t.availableRooms) assert.equal(typeOf.get(r.roomId), t.roomTypeId, `${r.roomNumber} belongs to ${t.name}`);
      }
      ok("mapping: every roomId listed under a roomType belongs to that roomType; count matches availableUnits");
    }

    // ---- Quote ------------------------------------------------------------------
    {
      let quoted = 0;
      for (const t of twoAdults) for (const r of t.availableRooms) {
        const q = await getBiosBotQuote(tx, f.T, { checkIn: IN, checkOut: OUT, rooms: [{ roomId: r.roomId, adults: 2, children: 0, infants: 0 }] });
        assert.equal(q.rooms.length, 1);
        assert.equal(q.rooms[0].roomId, r.roomId, "the quote is for exactly the offered room");
        assert.equal(q.rooms[0].roomNumber, r.roomNumber);
        assert.ok(q.totalGross > 0);
        quoted++;
      }
      assert.equal(quoted, 5, "all five sellable rooms (incl. no-image / hidden) are quotable");
      ok("quote: every offered roomId prices through getBiosBotQuote, and the quote belongs to that room");
    }

    // ---- Backward compatibility of the existing fields ---------------------------
    {
      for (const t of twoAdults) {
        for (const k of ["roomTypeId", "name", "availableUnits", "fromTotalPrice", "fromPricePerNight", "currency"]) {
          assert.ok(k in t, `${t.name}: existing field ${k} still present`);
        }
      }
      ok("contract: every pre-D196 field is still returned; availableRooms is additive");
    }

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { console.error(e); await sql.end(); process.exit(1); }
}

await sql.end();
console.log(`\nALL ${n} BIOS-BOT BOOKING-INVENTORY CHECKS PASSED (nothing committed)`);
