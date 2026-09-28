#!/usr/bin/env node
// ============================================================
// check:website-visibility — D197: a room is on the public website iff
// show_on_website AND active (is_active AND status <> 'inactive').
//
// The rule has one home, src/lib/public-booking/visibility.ts, in two
// spellings: the SQL fragment publicWebsiteRooms embeds, and the pure
// predicate isWebsiteVisibleRoom. This guard runs the REAL catalog query
// (compiled via tsc) against the isolated test DB on five fixture rooms and
// proves the SQL and the predicate agree on every one:
//
//   A  active + show, NO photo          → visible (photos are not required)
//   B  out_of_order + show, no photo    → visible AND not bookable (engine)
//   C  is_active = false + show, photo  → hidden
//   D  status = 'inactive' + show, photo→ hidden
//   E  show_on_website = false, photo   → hidden
//
// "Not bookable" is the engine's own answer: publicAvailability offers B's
// unit for no date, while A's identical unit IS offered — so the catalog
// listing an out_of_order room never makes it sellable.
//
// Nothing committed: one transaction, always rolled back.
// Usage: node scripts/check-website-visibility.mjs
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

// schema bootstrap: full chain only when the schema is absent (the suite hands
// this guard a migrated clone; a bare DB replays the chain)
if (psql(`SELECT to_regclass('guesthub.rooms') IS NULL`) === "t") {
  console.log("applying migration chain to the test DB…");
  for (const f of readdirSync(join(ROOT, "db/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
    execSync(
      `psql "${TEST_URL}" -q -v ON_ERROR_STOP=1 < "db/migrations/${f}"`,
      { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" },
    );
  }
}

// ---- compile the real modules (tsc → CJS) ----
console.log("compiling public-booking rooms (catalog) + visibility + availability via tsc…");
const tmp = mkdtempSync(join(tmpdir(), "gh-website-visibility-"));
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
    join(ROOT, "src/lib/public-booking/rooms.ts"),
    join(ROOT, "src/lib/public-booking/visibility.ts"),
    join(ROOT, "src/lib/public-booking/availability.ts"),
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

const { publicWebsiteRooms } = req(join(out, "lib/public-booking/rooms.js"));
const { isWebsiteVisibleRoom, isRoomActive } = req(join(out, "lib/public-booking/visibility.js"));
const { publicAvailability } = req(join(out, "lib/public-booking/availability.js"));

const postgres = req("postgres");
const sql = postgres(TEST_URL, { prepare: false, max: 1, onnotice: () => {} });
class Rollback extends Error {}
const IN = "2027-07-10", OUT = "2027-07-12"; // 2 nights, far-future
let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };

async function buildFixture(tx) {
  const [t] = await tx`INSERT INTO guesthub.tenants (name, slug, currency, settings)
    VALUES ('Website Visibility', ${`wv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`}, 'ILS', ${tx.json({ vat_rate: 18 })}) RETURNING id`;
  const T = t.id;
  const [type] = await tx`INSERT INTO guesthub.room_types (tenant_id, name, base_price, max_occupancy, max_adults, max_children, max_infants)
    VALUES (${T}, 'Bedroom', 680, 4, 4, 2, 1) RETURNING id`;

  // every fixture room is a sellable unit with a priced base plan for the stay,
  // so "not bookable" can only come from the engine's status rule
  const room = async (num, flags, { image = false } = {}) => {
    const [r] = await tx`INSERT INTO guesthub.rooms ${tx({
      tenant_id: T, room_type_id: type.id, room_number: num, name: `Room ${num}`,
      status: "available", is_active: true, show_on_website: true,
      max_occupancy: 4, max_adults: 4, max_children: 2, max_infants: 1,
      included_occupancy: 2, extra_guest_pricing_mode: "inherit",
      ...flags,
    })} RETURNING id, status, is_active, show_on_website`;
    if (image) await tx`INSERT INTO guesthub.room_images (tenant_id, room_id, url, is_main) VALUES (${T}, ${r.id}, ${`https://x/${num}.jpg`}, true)`;
    const [su] = await tx`INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id)
      VALUES (${T}, ${num}, ${`Unit ${num}`}, ${type.id}) RETURNING id`;
    await tx`INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id) VALUES (${T}, ${su.id}, ${r.id})`;
    const [bp] = await tx`INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base, plan_kind, is_active)
      VALUES (${T}, ${su.id}, ${"base-" + num}, 'Base', true, 'base', true) RETURNING id`;
    await tx`INSERT INTO guesthub.pricing_plan_rates (tenant_id, sellable_unit_id, pricing_plan_id, date, price)
      VALUES (${T}, ${su.id}, ${bp.id}, ${IN}, 600), (${T}, ${su.id}, ${bp.id}, '2027-07-11', 600)`;
    return { id: r.id, num, su: su.id, row: { status: r.status, is_active: r.is_active, show_on_website: r.show_on_website } };
  };

  return {
    T,
    A: await room("vis-a", {}),
    B: await room("vis-b", { status: "out_of_order" }),
    C: await room("vis-c", { is_active: false }, { image: true }),
    D: await room("vis-d", { status: "inactive" }, { image: true }),
    E: await room("vis-e", { show_on_website: false }, { image: true }),
  };
}

try {
  await sql.begin(async (tx) => {
    const f = await buildFixture(tx);
    const all = [f.A, f.B, f.C, f.D, f.E];
    const catalog = await publicWebsiteRooms(tx, "he", { tenantId: f.T });
    const listed = new Map(catalog.map((r) => [r.id, r]));

    // ---- the five cases, through the REAL catalog query ----------------------
    assert.ok(listed.has(f.A.id), "A: active + show, no photo → visible (photos are not required)");
    assert.ok(listed.has(f.B.id), "B: out_of_order + show → visible");
    assert.ok(!listed.has(f.C.id), "C: is_active = false + show → hidden (regardless of the toggle)");
    assert.ok(!listed.has(f.D.id), "D: status = 'inactive' + show → hidden");
    assert.ok(!listed.has(f.E.id), "E: show_on_website = false → hidden");
    assert.equal(catalog.length, 2, "exactly A and B are in the catalog");
    ok("catalog: active+show visible with or without a photo; inactive (either switch) and hidden rooms are absent");

    // ---- SQL fragment and pure predicate are ONE rule -----------------------
    for (const r of all) {
      assert.equal(listed.has(r.id), isWebsiteVisibleRoom(r.row), `${r.num}: SQL fragment and isWebsiteVisibleRoom agree`);
    }
    assert.ok(isRoomActive(f.A.row) && isRoomActive(f.B.row), "A and B are active (out_of_order is still active)");
    assert.ok(!isRoomActive(f.C.row) && !isRoomActive(f.D.row), "C and D are inactive");
    ok("predicate: isWebsiteVisibleRoom returns exactly what the catalog query returned, row by row");

    // ---- a zero-photo record is well-formed -----------------------------------
    {
      const a = listed.get(f.A.id);
      assert.deepEqual(a.images, [], "A: empty gallery, not a missing field");
      assert.ok(typeof a.title === "string" && a.title.length > 0, "A: still resolves a title");
      assert.equal(a.roomNumber, "vis-a");
      ok("zero-photo room: returned with images: [] and a resolved title — the consumer decides the placeholder");
    }

    // ---- B is listed but NOT bookable — the engine decides, not the catalog ---
    {
      const types = await publicAvailability(tx, IN, OUT, { tenantId: f.T });
      const offered = new Set(types.flatMap((t) => t.units.map((u) => u.roomId)));
      assert.ok(offered.has(f.A.id), "A: the identical available unit IS offered (the fixture is bookable at all)");
      assert.ok(!offered.has(f.B.id), "B: out_of_order is never offered for any date");
      const inv = await tx`
        SELECT min(i.availability)::int AS min_avail
        FROM guesthub.sellable_unit_inventory(${f.T}, ${IN}, ${OUT}) i
        WHERE i.sellable_unit_id = ${f.B.su}`;
      assert.equal(inv[0].min_avail, 0, "B: sellable_unit_inventory reports 0 availability");
      ok("out_of_order + show: in the catalog AND not bookable — publicAvailability never offers it");
    }

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { console.error(e); await sql.end(); process.exit(1); }
}

await sql.end();
console.log(`\nALL ${n} WEBSITE-VISIBILITY CHECKS PASSED (nothing committed)`);
