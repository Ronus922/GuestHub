// D74 — Canonical room identity for the Rate Grid + Group Update.
// Proves migration 028 + the rooms-joined grid read model against the ISOLATED
// disposable test DB (guesthub-testdb, :5433) — NEVER production. It
//   1. applies the full migration chain 000..028, then seeds the EXACT
//      production before-state: 13 canonical rooms (926..1424) whose sellable
//      units still carry the frozen 009-backfill identities (101..G5) and, for
//      9 of 13, the WRONG room type;
//   2. re-applies 028 and asserts the reconciliation: every sole-member unit's
//      code/name/room_type_id equals its room's, the backup table holds the
//      old rows, and pricing_plan_rates is preserved bit-for-bit;
//   3. compiles the REAL src/lib/rates/grid-state.ts + service.ts (tsc) and
//      runs them: the grid shows exactly the 13 canonical numbers (numeric
//      order, stale aliases absent, room UUIDs exposed), a poisoned copied
//      label cannot surface, a rename propagates with no second label, a new
//      room appears unmapped, inactive/closure/delete behave, and a rate write
//      creates dirty ranges keyed to the exact physical room_id.
// Usage: node scripts/check-room-identity.mjs
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import postgres from "postgres";
import assert from "node:assert/strict";

// Disposable local test DB only. Refuse anything that smells of production.
const URL = process.env.TEST_DATABASE_URL || "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (URL.includes(marker)) { console.error(`✗ refusing: production marker "${marker}" in TEST_DATABASE_URL`); process.exit(1); }
}

const applyChain = () => execSync(
  'for f in $(ls db/migrations/*.sql | sort); do docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$f" >/dev/null; done',
  { stdio: "inherit", shell: "/bin/bash" },
);
const apply028 = () => execSync(
  'docker exec -i guesthub-testdb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < db/migrations/028_canonical_room_identity.sql >/dev/null 2>&1',
  { stdio: "inherit", shell: "/bin/bash" },
);

console.log("→ applying migration chain 000..028 to guesthub-testdb…");
applyChain();

const sql = postgres(URL, { prepare: false, max: 1, onnotice: () => {} });
let n = 0;
const ok = (name) => { n++; console.log(`  ✓ ${n}. ${name}`); };
const uniq = (p) => `${p}-${randomUUID().slice(0, 8)}`;

// ---- compile the REAL grid/service TS once (same harness as check-rate-grid) ----
const tmp = mkdtempSync(join(tmpdir(), "gh-identity-"));
const out = join(tmp, "out");
writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    module: "commonjs", moduleResolution: "node10", target: "es2022",
    esModuleInterop: true, skipLibCheck: true, strict: true,
    baseUrl: join(process.cwd(), "src"), paths: { "@/*": ["*"] },
    rootDir: join(process.cwd(), "src"), outDir: out,
    typeRoots: [join(process.cwd(), "node_modules/@types")], types: ["node"],
  },
  include: [
    join(process.cwd(), "src/lib/rates/grid-state.ts"),
    join(process.cwd(), "src/lib/rates/service.ts"),
  ],
}));
execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { stdio: "inherit" });
const stub = join(tmp, "server-only-stub.js");
writeFileSync(stub, "module.exports = {};\n");
const req = createRequire(join(process.cwd(), "package.json"));
const Module = req("node:module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return stub;
  if (request.startsWith("@/")) return orig.call(this, join(out, request.slice(2)), ...rest);
  // bare package imports (postgres, …) resolve from the PROJECT's node_modules,
  // not from the tmp compile dir the requiring module lives in
  if (!request.startsWith(".") && !request.startsWith("/") && !request.startsWith("node:")) {
    try { return req.resolve(request); } catch { /* fall through */ }
  }
  return orig.call(this, request, ...rest);
};
const { getRateGridState } = req(join(out, "lib/rates/grid-state.js"));
const { writeRateCells } = req(join(out, "lib/rates/service.js"));

const DAY = "2027-03-15";
const DAY2 = "2027-03-16";
const WEEK_END = "2027-03-21";

// ---- production before-state: room number/type → stale SU identity ----
const CANONICAL = [
  // [room_number, type, room_name, stale_su_code, stale_su_type]
  ["926",  "studio",  "Large Studio with Sea View - 926",                 "G1",   "onebed"],
  ["1006", "suite",   "1006 - Two Bedroom Apartment",                     "102",  "onebed"],
  ["1102", "suite",   "1102 - One Bedroom Apartment Sea",                 "203",  "suite"],
  ["1130", "studio",  "Studio Delux with Sea View - 1130",                "202",  "onebed"],
  ["1131", "studio",  "Studio 1131",                                      "301",  "studio"],
  ["1142", "onebed",  "1142 - One Bedroom Apartment Sea",                 "G3",   "studio"],
  ["1235", "onebed",  "1235 - One Bedroom Primum Apartment Sea View",     "103",  "suite"],
  ["1237", "onebed",  "1237 - One Bedroom Apartment Sea View",            "G5",   "suite"],
  ["1238", "studio",  "1238 - Studio Delux",                              "G2",   "suite"],
  ["1242", "onebed",  "1242 - One Bedroom Apartment Sea View",            "G4",   "onebed"],
  ["1245", "onebed",  "1245 - One Bedroom Apartment Sea View",            "201",  "studio"],
  ["1329", "suite",   "Two Bedroom Apartment Sea View - 1329",            "101",  "studio"],
  ["1424", "suite",   "Premium One Bedroom Suite with Sea View - 1424",   "1424", "suite"],
];
const EXPECTED_NUMBERS = CANONICAL.map(([num]) => num); // already numerically ascending
const STALE = ["101", "102", "103", "201", "202", "203", "301", "G1", "G2", "G3", "G4", "G5"];

let tenantId;
let exitCode = 0;
try {
  [{ id: tenantId }] = await sql`
    INSERT INTO guesthub.tenants (name, slug) VALUES ('room identity', ${uniq("room-identity")}) RETURNING id`;
  const types = {};
  for (const [key, name, price] of [["studio", "סטודיו", 450], ["onebed", "חדר שינה וסלון", 680], ["suite", "סוויטה", 980]]) {
    [{ id: types[key] }] = await sql`
      INSERT INTO guesthub.room_types (tenant_id, name, base_price)
      VALUES (${tenantId}, ${name}, ${price}) RETURNING id`;
  }
  const roomByNumber = {}, suByCode = {}, planBySu = {};
  for (const [num, typeKey, roomName, staleCode, staleTypeKey] of CANONICAL) {
    const [room] = await sql`
      INSERT INTO guesthub.rooms (tenant_id, room_number, name, room_type_id, status, is_active, max_occupancy, max_adults)
      VALUES (${tenantId}, ${num}, ${roomName}, ${types[typeKey]}, 'available', true, 4, 4) RETURNING id`;
    roomByNumber[num] = room.id;
    const staleName = staleCode === "1424" ? roomName : `יחידה ${staleCode}`;
    const [su] = await sql`
      INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id, is_pooled, is_active)
      VALUES (${tenantId}, ${staleCode}, ${staleName}, ${types[staleTypeKey]}, false, true) RETURNING id`;
    suByCode[staleCode] = su.id;
    await sql`INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id)
              VALUES (${tenantId}, ${su.id}, ${room.id})`;
    const [bp] = await sql`
      INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base)
      VALUES (${tenantId}, ${su.id}, 'base', 'מחיר בסיס', true) RETURNING id`;
    planBySu[su.id] = bp.id;
  }
  // explicit rate rows that MUST survive reconciliation bit-for-bit
  await sql`
    INSERT INTO guesthub.pricing_plan_rates (tenant_id, sellable_unit_id, pricing_plan_id, date, price, min_stay_through, stop_sell)
    VALUES (${tenantId}, ${suByCode["101"]}, ${planBySu[suByCode["101"]]}, ${DAY}, 1234.56, 2, false),
           (${tenantId}, ${suByCode["G1"]},  ${planBySu[suByCode["G1"]]},  ${DAY}, 777.00, NULL, true)`;
  const checksum = async () => (await sql`
    SELECT md5(string_agg(ppr.pricing_plan_id::text || ppr.date || COALESCE(ppr.price::text,'∅')
      || COALESCE(ppr.min_stay_through::text,'∅') || ppr.stop_sell::text, ',' ORDER BY ppr.pricing_plan_id, ppr.date)) AS sum,
      count(*)::int AS n
    FROM guesthub.pricing_plan_rates ppr WHERE ppr.tenant_id = ${tenantId}`)[0];
  const before = await checksum();

  // ---- reconcile: re-apply 028 over the seeded stale state ----
  console.log("→ re-applying 028_canonical_room_identity.sql over the seeded production before-state…");
  apply028();
  apply028(); // idempotency: second run must change nothing further

  // 1+3. every sole-member unit now carries its room's identity; stale codes gone
  const su = await sql`
    SELECT s.code, s.name, s.room_type_id, r.room_number, r.name AS room_name, r.room_type_id AS rt
    FROM guesthub.sellable_units s
    JOIN guesthub.sellable_unit_rooms sur ON sur.sellable_unit_id = s.id
    JOIN guesthub.rooms r ON r.id = sur.room_id
    WHERE s.tenant_id = ${tenantId}`;
  assert.equal(su.length, 13);
  for (const row of su) {
    assert.equal(row.code, row.room_number, `unit code ${row.code} = room number`);
    assert.equal(row.name, row.room_name, "unit name mirrors room name");
    assert.equal(row.room_type_id, row.rt, "unit room_type mirrors the room's REAL type");
  }
  const staleLeft = await sql`
    SELECT code FROM guesthub.sellable_units WHERE tenant_id = ${tenantId} AND code = ANY(${STALE})`;
  assert.equal(staleLeft.length, 0, "no stale 009-backfill code survives");
  ok("028 reconciles all 13 units to their room's number/name/type (stale 101..G5 gone, idempotent)");

  // backup captured the changed rows with the old→new map
  const backup = await sql`
    SELECT code, new_code, room_number FROM guesthub.sellable_units_backup_028 WHERE tenant_id = ${tenantId}`;
  assert.equal(backup.length, 12, "exactly the 12 stale units were backed up (1424 was already canonical)");
  const b101 = backup.find((b) => b.code === "101");
  assert.equal(b101.room_number, "1329", "backup records 101 → 1329");
  ok("backup table holds the 12 old identities with their old→new map");

  // 14. prices/restrictions preserved bit-for-bit
  const after = await checksum();
  assert.deepEqual(after, before, "pricing_plan_rates unchanged by reconciliation");
  ok("prices and restrictions survive reconciliation unchanged (row-set checksum)");

  // ---- grid: the REAL compiled read model ----
  const grid = async () => getRateGridState(sql, tenantId, DAY, WEEK_END);
  const flat = (g) => g.types.flatMap((t) => t.units);
  let g = await grid();
  let units = flat(g);

  // 1+2. exactly the 13 canonical numbers, same list for grid + Group Update
  assert.equal(g.unitCount, 13);
  assert.deepEqual([...units.map((u) => u.code)].sort((a, b) => Number(a) - Number(b)), EXPECTED_NUMBERS);
  ok("/rates grid state lists exactly the 13 canonical room numbers");
  // Group Update reads the SAME state (structural: cards are built from types[].units)
  const gup = readFileSync("src/app/(dashboard)/rates/GroupUpdatePanel.tsx", "utf8");
  assert.ok(/t\.units\.map/.test(gup) && /u\.sellableUnitId/.test(gup),
    "GroupUpdatePanel derives its cards from the same grid types[].units state");
  ok("Bulk Update room selection is the same canonical room list (single source)");

  // 3. stale identifiers absent from every displayed field
  for (const u of units) {
    assert.ok(!STALE.includes(u.code), `stale code ${u.code} must not surface`);
    assert.ok(!/יחידה (10|20|30|G)/.test(u.name), `stale name ${u.name} must not surface`);
  }
  ok("stale identifiers 101/102/…/G5 appear nowhere in the grid");

  // 4. room 1329 displays as 1329 and carries its real room UUID
  const u1329 = units.find((u) => u.code === "1329");
  assert.ok(u1329, "room 1329 present");
  assert.equal(u1329.roomId, roomByNumber["1329"], "unit exposes the REAL room UUID");
  assert.equal(u1329.roomTypeName, "סוויטה", "1329 shows its real type (suite), not the stale studio");
  ok("the unit D73 called 'sellable unit 101 / physical room 1329' is now simply room 1329 (real UUID, real type)");

  // numeric ordering inside each type band
  for (const t of g.types) {
    const nums = t.units.map((u) => Number(u.code));
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b), `band ${t.roomTypeName} numerically sorted`);
  }
  ok("room numbers sort numerically inside each type band");

  // 5. rooms 302/303 absent from every active path
  const dead = await sql`
    SELECT 'rooms' AS t FROM guesthub.rooms WHERE tenant_id = ${tenantId} AND room_number IN ('302','303')
    UNION ALL SELECT 'sus' FROM guesthub.sellable_units WHERE tenant_id = ${tenantId} AND code IN ('302','303')`;
  assert.equal(dead.length, 0);
  assert.ok(!units.some((u) => u.code === "302" || u.code === "303"));
  ok("rooms 302 and 303 exist nowhere (tables or grid)");

  // 6+7. strict one-to-one: every room exactly one unit, every live unit exactly one room
  const [{ rooms13, sus13, links13, multi, zero }] = await sql`
    SELECT (SELECT count(*)::int FROM guesthub.rooms WHERE tenant_id = ${tenantId}) AS rooms13,
           (SELECT count(*)::int FROM guesthub.sellable_units WHERE tenant_id = ${tenantId} AND is_active) AS sus13,
           (SELECT count(*)::int FROM guesthub.sellable_unit_rooms WHERE tenant_id = ${tenantId}) AS links13,
           (SELECT count(*)::int FROM (SELECT sellable_unit_id FROM guesthub.sellable_unit_rooms
             WHERE tenant_id = ${tenantId} GROUP BY 1 HAVING count(*) > 1) m) AS multi,
           (SELECT count(*)::int FROM guesthub.sellable_units s WHERE s.tenant_id = ${tenantId} AND s.is_active
             AND NOT EXISTS (SELECT 1 FROM guesthub.sellable_unit_rooms sur WHERE sur.sellable_unit_id = s.id)) AS zero`;
  assert.deepEqual({ rooms13, sus13, links13, multi, zero }, { rooms13: 13, sus13: 13, links13: 13, multi: 0, zero: 0 });
  const roomIds = units.map((u) => u.roomId);
  assert.equal(new Set(roomIds).size, 13, "13 distinct room UUIDs in the grid");
  ok("strict one-to-one room ⇄ sellable-unit (no zero-room, no multi-room live units)");

  // poisoned copy cannot surface: corrupt the stored label directly (bypasses
  // the trigger) — the grid must STILL display the room's identity (join wins)
  await sql`UPDATE guesthub.sellable_units SET code = '101', name = 'יחידה 101'
            WHERE id = ${suByCode["101"]}`;
  units = flat(await grid());
  const poisoned = units.find((u) => u.roomId === roomByNumber["1329"]);
  assert.equal(poisoned.code, "1329", "display joins from rooms — a copied label cannot override");
  // the next room write self-heals the copy (UPDATE OF fires on column mention)
  await sql`UPDATE guesthub.rooms SET room_number = room_number WHERE id = ${roomByNumber["1329"]}`;
  const [healed] = await sql`SELECT code FROM guesthub.sellable_units WHERE id = ${suByCode["101"]}`;
  assert.equal(healed.code, "1329", "mirror trigger self-heals the copy on the next room write");
  ok("a stale copied label can neither surface (rooms join) nor persist (mirror trigger)");

  // 9. rename: rooms.room_number is the ONLY label to change
  await sql`UPDATE guesthub.rooms SET room_number = '927' WHERE id = ${roomByNumber["926"]}`;
  units = flat(await grid());
  assert.ok(units.some((u) => u.code === "927"), "grid reflects the rename immediately");
  assert.ok(!units.some((u) => u.code === "926"), "old number gone");
  const [renamedSu] = await sql`SELECT code FROM guesthub.sellable_units WHERE id = ${suByCode["G1"]}`;
  assert.equal(renamedSu.code, "927", "unit label mirrored by trigger — no second editable label");
  await sql`UPDATE guesthub.rooms SET room_number = '926' WHERE id = ${roomByNumber["926"]}`;
  ok("room rename propagates from rooms alone (grid + mirrored unit), reversibly");

  // 8. a rate write creates dirty ranges keyed to the exact physical room_id
  await sql`INSERT INTO guesthub.channel_connections (tenant_id, state, outbound_sync_enabled)
            VALUES (${tenantId}, 'active', true)`;
  await sql.begin(async (tx) => {
    await writeRateCells(tx, tenantId, [{
      sellableUnitId: suByCode["101"], pricingPlanId: planBySu[suByCode["101"]],
      date: DAY2, patch: { min_stay_through: 3 },
    }]);
  });
  const dirty = await sql`
    SELECT DISTINCT room_id, kind FROM guesthub.channel_dirty_ranges
    WHERE tenant_id = ${tenantId} AND date_from <= ${DAY2} AND date_to > ${DAY2}`;
  assert.ok(dirty.length >= 1, "dirty range written");
  for (const d of dirty) assert.equal(d.room_id, roomByNumber["1329"], "dirty range keyed to the exact physical room");
  assert.deepEqual([...new Set(dirty.map((d) => d.kind))].sort(), ["rates", "restrictions"]);
  ok("saving a rate for the visible room 1329 dirties exactly room 1329 (rates + restrictions)");

  // 10. a new room (lifecycle path) appears automatically, unmapped for the channel
  const [newRoom] = await sql`
    INSERT INTO guesthub.rooms (tenant_id, room_number, name, room_type_id, status, is_active, max_occupancy, max_adults)
    VALUES (${tenantId}, '555', 'חדר 555', ${types.studio}, 'available', true, 2, 2) RETURNING id`;
  const [newSu] = await sql`
    INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id)
    VALUES (${tenantId}, '555', 'חדר 555', ${types.studio}) RETURNING id`;
  await sql`INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id)
            VALUES (${tenantId}, ${newSu.id}, ${newRoom.id})`;
  await sql`INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base)
            VALUES (${tenantId}, ${newSu.id}, 'base', 'מחיר בסיס', true)`;
  units = flat(await grid());
  const u555 = units.find((u) => u.code === "555");
  assert.ok(u555, "new room appears in the grid with no extra catalog entry");
  assert.equal(u555.roomId, newRoom.id);
  assert.equal(u555.cells[0].mappingValid, false, "new room is honestly UNMAPPED for the channel until mapped");
  assert.equal(units.length, 14);
  ok("a new room appears automatically in grid + Group Update, unmapped until a channel mapping exists");

  // 11. inactive / out-of-order room resolves availability to 0 (still visible)
  await sql`UPDATE guesthub.rooms SET status = 'out_of_order', is_active = false WHERE id = ${newRoom.id}`;
  units = flat(await grid());
  const uOoo = units.find((u) => u.code === "555");
  assert.ok(uOoo, "out-of-order room remains visible in the grid");
  assert.equal(uOoo.cells[0].availability, 0, "availability resolves to 0");
  // the app's status toggle couples is_active to status, which the classifier
  // reads as blocked-on-both-axes — anything but "available" is the point here
  assert.notEqual(uOoo.cells[0].roomAdminState, "available");
  assert.equal(uOoo.cells[0].sellable, false, "not accidentally price-editable as sellable");
  await sql`UPDATE guesthub.rooms SET status = 'available', is_active = true WHERE id = ${newRoom.id}`;
  ok("inactive/out-of-order room: availability 0, clear admin state, identity intact");

  // 12. a dated closure affects only the requested dates
  await sql`INSERT INTO guesthub.room_closures (tenant_id, room_id, start_date, end_date, reason)
            VALUES (${tenantId}, ${newRoom.id}, ${DAY}, ${DAY2}, 'בדיקה')`;
  units = flat(await grid());
  const uClosed = units.find((u) => u.code === "555");
  assert.equal(uClosed.cells.find((c) => c.date === DAY).availability, 0, "closed on the closure date");
  assert.equal(uClosed.cells.find((c) => c.date === DAY2).availability, 1, "open right after the closure");
  await sql`DELETE FROM guesthub.room_closures WHERE tenant_id = ${tenantId} AND room_id = ${newRoom.id}`;
  ok("a room closure zeroes availability for exactly the requested dates");

  // 13. a deleted room disappears with no orphan active unit or mapping
  await sql`DELETE FROM guesthub.rooms WHERE id = ${newRoom.id}`;
  const [orphan] = await sql`SELECT is_active FROM guesthub.sellable_units WHERE id = ${newSu.id}`;
  assert.ok(!orphan || orphan.is_active === false, "orphan unit archived/removed by the D66 trigger");
  units = flat(await grid());
  assert.ok(!units.some((u) => u.code === "555"), "deleted room gone from the grid");
  assert.equal(units.length, 13);
  const [{ maps }] = await sql`
    SELECT count(*)::int AS maps FROM guesthub.channel_room_mappings WHERE tenant_id = ${tenantId}`;
  assert.equal(maps, 0, "no orphan active channel mapping");
  ok("a deleted room disappears everywhere; no orphan unit or active mapping remains");

  // final guard: prices unchanged across the whole suite except the one test write
  const end = await checksum();
  assert.equal(end.n, before.n + 1, "exactly the one test write was added");
  ok("no test mutated existing prices (row count accounted)");

  console.log(`\n✓ room-identity: all ${n} checks passed`);
} catch (e) {
  exitCode = 1;
  console.error(`\n✗ room-identity failed after ${n} passing checks:`);
  console.error(e);
} finally {
  if (tenantId) await sql`DELETE FROM guesthub.tenants WHERE id = ${tenantId}`.catch(() => {});
  if (tenantId) await sql`DELETE FROM guesthub.sellable_units_backup_028 WHERE tenant_id = ${tenantId}`.catch(() => {});
  await sql.end();
}
process.exit(exitCode);
