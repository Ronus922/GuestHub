#!/usr/bin/env node
// check:calendar-departure-edge (D92) — the calendar read model uses the DRAW
// boundary, not the inventory boundary: a stay/closure/hold whose end date
// EQUALS the window start still owns the departure half-slot of day 1, so all
// three getCalendarData queries must fetch it (check_out >= from). Inventory
// math everywhere else stays half-open [check_in, check_out).
//
// Runs the REAL getCalendarData against the ISOLATED test DB (:5433) inside a
// transaction that is ALWAYS ROLLED BACK, plus the barGeometry contract for
// the fetched edge rows. Fails closed on any production marker.
//
// Usage: node scripts/check-calendar-departure-edge.mjs
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import postgres from "postgres";

const TEST_URL =
  process.env.TEST_DATABASE_URL ||
  "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (TEST_URL.includes(marker)) {
    console.error(`REFUSED: TEST_DATABASE_URL contains production marker "${marker}"`);
    process.exit(1);
  }
}

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };

// ---- static guard: the three DRAW-boundary predicates stay `>=` ----
const dataSrc = readFileSync(join(process.cwd(), "src/app/(dashboard)/calendar/data.ts"), "utf8");
assert.match(dataSrc, /rr\.check_in < \$\{to\} AND rr\.check_out >= \$\{from\}/, "stays query uses check_out >= from");
assert.match(dataSrc, /start_date < \$\{to\} AND end_date >= \$\{from\}/, "closures query uses end_date >= from");
assert.match(dataSrc, /h\.check_in < \$\{to\} AND h\.check_out >= \$\{from\}/, "holds query uses check_out >= from");
ok("static: stays/closures/holds all use the DRAW boundary (>= from)");

// ---- compile the real modules (server-only stripped, @/lib/db swapped) ----
mkdirSync(join(process.cwd(), "node_modules/.cache"), { recursive: true });
const out = mkdtempSync(join(process.cwd(), "node_modules/.cache/check-cal-edge-"));
const tsconfig = join(out, "tsconfig.json");
writeFileSync(tsconfig, JSON.stringify({
  compilerOptions: {
    module: "commonjs", target: "es2022", moduleResolution: "node10",
    esModuleInterop: true, skipLibCheck: true,
    baseUrl: process.cwd(), paths: { "@/*": ["src/*"] },
    rootDir: process.cwd(), outDir: out,
  },
  files: [
    join(process.cwd(), "src/app/(dashboard)/calendar/data.ts"),
    join(process.cwd(), "src/lib/calendar-interactions.ts"),
  ],
}));
execSync(`pnpm exec tsc --project ${tsconfig}`, { stdio: "inherit" });

// tsc keeps the original specifiers — point them at the compiled files and at
// the live-bound test-db seam (the check binds the rollback tx before calling)
const dataPath = join(out, "src/app/(dashboard)/calendar/data.js");
writeFileSync(dataPath, readFileSync(dataPath, "utf8")
  .replace('"@/lib/db"', JSON.stringify(join(out, "test-db.js")))
  .replace('"@/lib/dates"', JSON.stringify(join(out, "src/lib/dates.js")))
  .replace('"@/lib/inventory-rules"', JSON.stringify(join(out, "src/lib/inventory-rules.js")))
  .replace('"@/lib/rooms/sort"', JSON.stringify(join(out, "src/lib/rooms/sort.js"))));
writeFileSync(join(out, "test-db.js"),
  "exports.sql = null;\nexports._bind = (tx) => { exports.sql = tx; };\n");
mkdirSync(join(out, "node_modules/server-only"), { recursive: true });
writeFileSync(join(out, "node_modules/server-only/package.json"), '{"name":"server-only","main":"index.js"}');
writeFileSync(join(out, "node_modules/server-only/index.js"), "");

const require2 = createRequire(join(out, "package.json"));
const { getCalendarData } = require2(dataPath);
const db = require2(join(out, "test-db.js"));
const ix = require2(join(out, "src/lib/calendar-interactions.js"));

const sql = postgres(TEST_URL, { max: 1, prepare: false, onnotice: () => {} });
const FROM = "2026-08-10"; // window [08-10, 08-31), 21 days
const DAYS = 21;
const ROLLBACK = new Error("rollback-by-design");

try {
  await sql.begin(async (tx) => {
    db._bind(tx);
    const [tenant] = await tx`
      INSERT INTO guesthub.tenants (name, slug)
      VALUES ('Calendar Edge', ${"cal-edge-" + Date.now()}) RETURNING id`;
    const [rt] = await tx`
      INSERT INTO guesthub.room_types (tenant_id, name, base_price)
      VALUES (${tenant.id}, 'Edge Type', 400) RETURNING id`;
    const mkRoom = async (num) => (await tx`
      INSERT INTO guesthub.rooms (tenant_id, room_number, room_type_id, status, is_active)
      VALUES (${tenant.id}, ${num}, ${rt.id}, 'available', true) RETURNING id`)[0].id;
    const r1 = await mkRoom("E-101");
    const r2 = await mkRoom("E-102");
    const r3 = await mkRoom("E-103");
    const r4 = await mkRoom("E-104");
    const mkStay = async (room, num, ci, co, status = "confirmed") => {
      const [res] = await tx`
        INSERT INTO guesthub.reservations
          (tenant_id, reservation_number, status, check_in, check_out, booking_origin)
        VALUES (${tenant.id}, ${num}, ${status}, ${ci}, ${co}, 'back_office') RETURNING id`;
      await tx`
        INSERT INTO guesthub.reservation_rooms (tenant_id, reservation_id, room_id, check_in, check_out)
        VALUES (${tenant.id}, ${res.id}, ${room}, ${ci}, ${co})`;
    };
    // the bug case + its turnover partner, in the SAME room
    await mkStay(r1, "DEPART-ON-FROM", "2026-08-08", "2026-08-10");
    await mkStay(r1, "ARRIVE-ON-FROM", "2026-08-10", "2026-08-12");
    // exclusions: ends before the window; cancelled on the edge
    // (separate rooms — the rr_no_double_booking exclusion constraint is real)
    await mkStay(r2, "ENDS-BEFORE", "2026-08-05", "2026-08-09");
    await mkStay(r4, "CANCELLED-EDGE", "2026-08-08", "2026-08-10", "cancelled");
    // regressions: crosses the whole window; ordinary mid-range
    await mkStay(r3, "CROSS-RANGE", "2026-08-01", "2026-09-15");
    await mkStay(r2, "MID-RANGE", "2026-08-15", "2026-08-18");
    // closures: ending ON the window start (drawn) vs before it (not fetched)
    await tx`INSERT INTO guesthub.room_closures (tenant_id, room_id, start_date, end_date, reason)
             VALUES (${tenant.id}, ${r2}, '2026-08-07', '2026-08-10', 'edge-closure')`;
    await tx`INSERT INTO guesthub.room_closures (tenant_id, room_id, start_date, end_date, reason)
             VALUES (${tenant.id}, ${r2}, '2026-08-05', '2026-08-09', 'gone-closure')`;
    // hold ending ON the window start
    await tx`INSERT INTO guesthub.channel_inventory_holds
               (tenant_id, room_type_id, check_in, check_out, rooms_count, status, guest_name)
             VALUES (${tenant.id}, ${rt.id}, '2026-08-08', '2026-08-10', 1, 'active', 'edge-hold')`;

    const data = await getCalendarData({ tenantId: tenant.id }, FROM, DAYS);
    const nums = data.stays.map((s) => s.reservation_number);

    assert.ok(nums.includes("DEPART-ON-FROM"), "departing-on-from stay is fetched");
    ok("a stay departing ON the first visible day is fetched (the 1020 bug case)");
    assert.ok(nums.includes("ARRIVE-ON-FROM"), "arriving-on-from stay is fetched");
    const sameRoom = data.stays.filter((s) =>
      ["DEPART-ON-FROM", "ARRIVE-ON-FROM"].includes(s.reservation_number));
    assert.equal(new Set(sameRoom.map((s) => s.room_id)).size, 1, "turnover pair shares one room");
    ok("turnover: departing + arriving stays of the SAME room are both fetched");
    assert.ok(!nums.includes("ENDS-BEFORE"), "a stay ending before the window stays out");
    assert.ok(!nums.includes("CANCELLED-EDGE"), "a cancelled stay stays out");
    ok("exclusions hold: ends-before-window and cancelled are not fetched");
    assert.ok(nums.includes("CROSS-RANGE") && nums.includes("MID-RANGE"), "regression rows fetched");
    ok("regressions hold: cross-range and mid-range stays are fetched");

    assert.deepEqual(data.closures.map((c) => c.reason), ["edge-closure"],
      "exactly the closure ending on day 1 is fetched");
    ok("a closure ending ON the first visible day is fetched; an earlier one is not");
    assert.equal(data.holds.length, 1, "the hold ending on day 1 is fetched");
    ok("a hold ending ON the first visible day is fetched");

    // ---- the visual contract for the fetched edge rows ----
    const dep = sameRoom.find((s) => s.reservation_number === "DEPART-ON-FROM");
    const arr = sameRoom.find((s) => s.reservation_number === "ARRIVE-ON-FROM");
    const gDep = ix.barGeometry(FROM, DAYS, dep.check_in, dep.check_out);
    const gArr = ix.barGeometry(FROM, DAYS, arr.check_in, arr.check_out);
    assert.equal(gDep.clippedStart, true, "departing bar is start-clipped");
    assert.equal(gDep.start, 0, "departing bar starts at the window edge");
    assert.ok(Math.abs(gDep.width - 0.5 / DAYS) < 1e-9, "departing bar is exactly the half-slot");
    assert.equal(gArr.clippedStart, false, "arriving bar is not clipped");
    assert.ok(Math.abs(gArr.start - 0.5 / DAYS) < 1e-9, "arriving bar starts at the mid-cell");
    assert.ok(gDep.start + gDep.width <= gArr.start + 1e-9, "the two bars do not overlap");
    ok("turnover geometry: departure half-slot [0, 0.5/days) meets arrival at mid-cell — no overlap");

    // occupied/free indicator predicate (RoomRow): a departure-today row must
    // NOT count as occupying tonight — the night predicate excludes it.
    const today = FROM; // treat the window start as "today" for the predicate
    const occupiedNow = [dep].some((s) => s.check_in <= today && s.check_out > today);
    assert.equal(occupiedNow, false, "a departing-today stay never marks the room occupied");
    ok("the occupied/free predicate stays night-based: departure-today reads free");

    throw ROLLBACK;
  });
} catch (e) {
  if (e !== ROLLBACK) throw e;
}
await sql.end();
rmSync(out, { recursive: true, force: true });
console.log(`\ncheck-calendar-departure-edge: all ${n} assertions passed (test DB rolled back)`);
