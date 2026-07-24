// Phase 4A — Rate Grid read-model + physical/commercial separation checks.
// Proves the invariants the /rates grid (src/lib/rates/grid-state.ts) depends on,
// against the SAME authoritative SQL read models it consumes:
//   guesthub.effective_sell_state() and guesthub.sellable_unit_inventory().
// Every scenario is built inside a ROLLED-BACK transaction — the live data is
// never modified. No channel network calls. (Outbox/dirty-range same-tx atomicity
// is proven separately by check-rates-sync.mjs.)
//
// Usage: node --env-file=.env.local scripts/check-rate-grid.mjs
import postgres from "postgres";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
const DAY = "2027-03-15"; // far-future, collision-free window
const NEXT = "2027-03-16";
let n = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); n++; };

class Rollback extends Error {}
async function inTx(fn) {
  try {
    await sql.begin(async (tx) => { await fn(tx); throw new Rollback(); });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

const [{ id: tenant }] = await sql`SELECT id FROM guesthub.tenants LIMIT 1`;
let seq = 0;
const uniq = (p) => `${p}-${Date.now?.() ?? ""}-${seq++}`;

// Build an isolated SU (single-room or pooled) with a base plan. Returns ids.
async function scaffold(tx, { pooled = false, rooms = 1, basePrice = 500 } = {}) {
  const [rt] = await tx`
    INSERT INTO guesthub.room_types (tenant_id, name, base_price)
    VALUES (${tenant}, ${uniq("RT")}, ${basePrice}) RETURNING id`;
  const roomIds = [];
  for (let i = 0; i < rooms; i++) {
    const [r] = await tx`
      INSERT INTO guesthub.rooms (tenant_id, room_number, room_type_id, status, is_active)
      VALUES (${tenant}, ${uniq("RM")}, ${rt.id}, 'available', true) RETURNING id`;
    roomIds.push(r.id);
  }
  const [su] = await tx`
    INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id, is_pooled, is_active)
    VALUES (${tenant}, ${uniq("SU")}, 'test unit', ${rt.id}, ${pooled}, true) RETURNING id`;
  for (const rid of roomIds) {
    await tx`INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id)
             VALUES (${tenant}, ${su.id}, ${rid})`;
  }
  const [bp] = await tx`
    INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base)
    VALUES (${tenant}, ${su.id}, 'base', 'base', true) RETURNING id`;
  return { rtId: rt.id, roomIds, suId: su.id, planId: bp.id, basePrice };
}

const putRate = (tx, s, patch) => tx`
  INSERT INTO guesthub.pricing_plan_rates ${tx({
    tenant_id: tenant, sellable_unit_id: s.suId, pricing_plan_id: s.planId, date: DAY,
    price: patch.price ?? null, min_stay_through: patch.minThrough ?? null,
    min_stay_arrival: patch.minArrival ?? null, max_stay: patch.maxStay ?? null,
    stop_sell: patch.stopSell ?? false,
    closed_to_arrival: patch.cta ?? false, closed_to_departure: patch.ctd ?? false,
  }, "tenant_id", "sellable_unit_id", "pricing_plan_id", "date", "price",
     "min_stay_through", "min_stay_arrival", "max_stay", "stop_sell",
     "closed_to_arrival", "closed_to_departure")}`;

const ess = async (tx, suId, day = DAY) => {
  const [r] = await tx`
    SELECT availability, price::float8 AS price, stop_sell, min_stay_through, sellable
    FROM guesthub.effective_sell_state(${tenant}, ${day}::date, (${day}::date + 1))
    WHERE sellable_unit_id = ${suId}`;
  return r;
};
const inv = async (tx, suId, day = DAY) => {
  const [r] = await tx`
    SELECT total_rooms, sellable_rooms, occupied_rooms, closed_rooms, availability
    FROM guesthub.sellable_unit_inventory(${tenant}, ${day}::date, (${day}::date + 1))
    WHERE sellable_unit_id = ${suId}`;
  return r;
};
async function reserve(tx, roomId) {
  const [res] = await tx`
    INSERT INTO guesthub.reservations (tenant_id, reservation_number, status, check_in, check_out)
    VALUES (${tenant}, ${uniq("RES")}, 'confirmed', ${DAY}, ${NEXT}) RETURNING id`;
  await tx`INSERT INTO guesthub.reservation_rooms (tenant_id, reservation_id, room_id, check_in, check_out)
           VALUES (${tenant}, ${res.id}, ${roomId}, ${DAY}, ${NEXT})`;
}
const close = (tx, roomId) => tx`
  INSERT INTO guesthub.room_closures (tenant_id, room_id, start_date, end_date)
  VALUES (${tenant}, ${roomId}, ${DAY}, ${NEXT})`;

try {
  // ---- A. explicit vs inherited vs missing (never invent a value) ----
  await inTx(async (tx) => {
    const s = await scaffold(tx, { basePrice: 500 });
    await putRate(tx, s, { price: 700 });                    // explicit
    const e = await ess(tx, s.suId);
    assert.equal(e.price, 700, "explicit price wins");
    // a row with NULL price → inherited base
    await tx`UPDATE guesthub.pricing_plan_rates SET price = NULL WHERE pricing_plan_id = ${s.planId} AND date = ${DAY}`;
    const inherited = await ess(tx, s.suId);
    assert.equal(inherited.price, 500, "row with null price falls back to base");
    // no row at all → base (missing), and effective still resolves
    await tx`DELETE FROM guesthub.pricing_plan_rates WHERE pricing_plan_id = ${s.planId}`;
    const missing = await ess(tx, s.suId);
    assert.equal(missing.price, 500, "missing row falls back to base");
    const [{ n: rows }] = await tx`SELECT count(*)::int AS n FROM guesthub.pricing_plan_rates WHERE pricing_plan_id = ${s.planId}`;
    assert.equal(rows, 0, "no row persisted for a missing/default cell");
  });
  ok("explicit / inherited / missing resolve distinctly (base fallback, never invented)");

  // ---- B. a reservation reduces PHYSICAL availability; commercial row unchanged ----
  await inTx(async (tx) => {
    const s = await scaffold(tx);
    await putRate(tx, s, { price: 650, minThrough: 3 });
    await reserve(tx, s.roomIds[0]);
    const iv = await inv(tx, s.suId), e = await ess(tx, s.suId);
    assert.equal(iv.availability, 0, "reserved → physical availability 0");
    assert.equal(iv.occupied_rooms, 1, "occupied counted");
    assert.equal(e.sellable, false, "not sellable when no room free");
    assert.equal(e.price, 650, "commercial price unchanged by a reservation");
    assert.equal(e.min_stay_through, 3, "commercial restriction unchanged by a reservation");
    assert.equal(e.stop_sell, false, "a reservation does not set stop_sell");
  });
  ok("reservation reduces physical availability without changing commercial price/restrictions");

  // ---- C. a physical block reduces availability WITHOUT setting stop_sell ----
  await inTx(async (tx) => {
    const s = await scaffold(tx);
    await putRate(tx, s, { price: 500 });
    await close(tx, s.roomIds[0]);
    const iv = await inv(tx, s.suId), e = await ess(tx, s.suId);
    assert.equal(iv.closed_rooms, 1, "closure counted");
    assert.equal(iv.availability, 0, "blocked → availability 0");
    assert.equal(e.sellable, false, "not sellable when physically blocked");
    assert.equal(e.stop_sell, false, "a physical block does NOT set stop_sell");
  });
  ok("physical block reduces availability without setting stop_sell");

  // ---- D. stop_sell closes commercial sale WITHOUT occupancy or a block ----
  await inTx(async (tx) => {
    const s = await scaffold(tx);
    await putRate(tx, s, { stopSell: true });
    const iv = await inv(tx, s.suId), e = await ess(tx, s.suId);
    assert.equal(iv.availability, 1, "physical rooms still free");
    assert.equal(iv.occupied_rooms, 0, "stop_sell creates no occupancy");
    assert.equal(iv.closed_rooms, 0, "stop_sell creates no physical block");
    assert.equal(e.sellable, false, "commercially closed");
    const [{ n: closures }] = await tx`SELECT count(*)::int AS n FROM guesthub.room_closures WHERE room_id = ${s.roomIds[0]}`;
    assert.equal(closures, 0, "no room_closure row created by stop_sell");
  });
  ok("stop_sell closes commercial sale without creating occupancy or a physical block");

  // ---- E. inactive / out_of_order excluded from sellable, reflected by ESS ----
  for (const status of ["inactive", "out_of_order"]) {
    await inTx(async (tx) => {
      const s = await scaffold(tx);
      await tx`UPDATE guesthub.rooms SET status = ${status} WHERE id = ${s.roomIds[0]}`;
      const iv = await inv(tx, s.suId), e = await ess(tx, s.suId);
      assert.equal(iv.sellable_rooms, 0, `${status} → 0 sellable rooms`);
      assert.equal(iv.availability, 0, `${status} → availability 0`);
      assert.equal(e.sellable, false, `${status} → not sellable in Effective Sell State`);
    });
  }
  ok("inactive / out_of_order rooms are excluded and reflected by Effective Sell State");

  // ---- F. pooled AND single-room SUs both render correctly ----
  await inTx(async (tx) => {
    const single = await scaffold(tx, { rooms: 1 });
    const pooled = await scaffold(tx, { pooled: true, rooms: 3 });
    const sInv = await inv(tx, single.suId), pInv = await inv(tx, pooled.suId);
    assert.equal(sInv.total_rooms, 1, "single-room SU: total 1");
    assert.equal(sInv.availability, 1, "single-room SU: availability 1");
    assert.equal(pInv.total_rooms, 3, "pooled SU: total 3");
    assert.equal(pInv.availability, 3, "pooled SU: availability 3");
    // occupy one pooled room → availability 2, still sellable (pool)
    await reserve(tx, pooled.roomIds[0]);
    const pInv2 = await inv(tx, pooled.suId), pEss = await ess(tx, pooled.suId);
    assert.equal(pInv2.availability, 2, "pooled SU: one occupied → availability 2");
    assert.equal(pEss.sellable, true, "pooled SU still sellable with rooms free");
  });
  ok("single-room and pooled Sellable Units both render correctly");

  // ---- G. structural: the grid write path never touches legacy guesthub.rates ----
  {
    const svc = readFileSync("src/lib/rates/service.ts", "utf8");
    const act = readFileSync("src/app/(dashboard)/rates/actions.ts", "utf8");
    const grid = readFileSync("src/lib/rates/grid-state.ts", "utf8");
    for (const [name, src] of [["service", svc], ["actions", act], ["grid-state", grid]]) {
      assert.ok(!/\b(INSERT\s+INTO|UPDATE)\s+guesthub\.rates\b/i.test(src), `${name} never writes guesthub.rates`);
    }
    assert.ok(svc.includes("guesthub.pricing_plan_rates"), "service writes the canonical pricing_plan_rates");
    // canonical keying is enforced by a unique index
    const [{ n: uq }] = await sql`
      SELECT count(*)::int AS n FROM pg_indexes
      WHERE schemaname = 'guesthub' AND tablename = 'pricing_plan_rates' AND indexdef ILIKE '%UNIQUE%(pricing_plan_id, date)%'`;
    assert.ok(uq >= 1, "pricing_plan_rates uniquely keyed by (pricing_plan_id, date)");
  }
  ok("grid write path is canonical only (no legacy guesthub.rates writes; unique keying)");

  // ---- H. ACTIVE connection: axis C runs on the ROOM model (D73 regression) ----
  // THE defect: with an active channel connection the old branch selected the
  // DROPPED channel_dirty_ranges.room_type_id column (re-keyed to room_id in
  // D68) → Postgres 42703 → the whole /rates route hit the error boundary. The
  // branch was dormant until the first Full Sync activated the connection, so
  // no earlier test executed it. This section runs the REAL compiled
  // getRateGridState with an active connection, a mapped room and a live dirty
  // range — on an ISOLATED scaffold tenant inside the rolled-back tx, so the
  // live channel connection row is never read, locked or modified.
  {
    const tmp = mkdtempSync(join(tmpdir(), "gh-grid-"));
    const out = join(tmp, "out");
    writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        module: "commonjs", moduleResolution: "node10", target: "es2022",
        esModuleInterop: true, skipLibCheck: true, strict: true,
        baseUrl: join(process.cwd(), "src"), paths: { "@/*": ["*"] },
        rootDir: join(process.cwd(), "src"), outDir: out,
        typeRoots: [join(process.cwd(), "node_modules/@types")], types: ["node"],
      },
      include: [join(process.cwd(), "src/lib/rates/grid-state.ts")],
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
      return orig.call(this, request, ...rest);
    };
    const { getRateGridState } = req(join(out, "lib/rates/grid-state.js"));

    await inTx(async (tx) => {
      const [t2] = await tx`
        INSERT INTO guesthub.tenants (name, slug) VALUES (${uniq("T")}, ${uniq("t")}) RETURNING id`;
      const [rt] = await tx`
        INSERT INTO guesthub.room_types (tenant_id, name, base_price)
        VALUES (${t2.id}, ${uniq("RT")}, 400) RETURNING id`;
      const roomIds = [];
      for (let i = 0; i < 2; i++) {
        const [r] = await tx`
          INSERT INTO guesthub.rooms (tenant_id, room_number, room_type_id, status, is_active)
          VALUES (${t2.id}, ${uniq("RM")}, ${rt.id}, 'available', true) RETURNING id`;
        roomIds.push(r.id);
      }
      const suIds = [];
      for (const rid of roomIds) {
        const [su] = await tx`
          INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id, is_pooled, is_active)
          VALUES (${t2.id}, ${uniq("SU")}, 'axisC unit', ${rt.id}, false, true) RETURNING id`;
        await tx`INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id)
                 VALUES (${t2.id}, ${su.id}, ${rid})`;
        suIds.push(su.id);
      }
      const [conn] = await tx`
        INSERT INTO guesthub.channel_connections (tenant_id, provider, environment, state)
        VALUES (${t2.id}, 'beds24', 'staging', 'active') RETURNING id`;
      // room 0 mapped; room 1 deliberately unmapped
      await tx`
        INSERT INTO guesthub.channel_room_mappings
          (tenant_id, connection_id, channex_property_id, local_entity_type, room_id, room_number, status, method)
        VALUES (${t2.id}, ${conn.id}, 'prop-test', 'physical_room', ${roomIds[0]}, 'axisC-1', 'mapped', 'created')`;
      // a live (non-synced) dirty range on room 0 for DAY only ([DAY, NEXT))
      await tx`
        INSERT INTO guesthub.channel_dirty_ranges
          (tenant_id, connection_id, room_id, kind, date_from, date_to, status)
        VALUES (${t2.id}, ${conn.id}, ${roomIds[0]}, 'restrictions', ${DAY}, ${NEXT}, 'pending')`;

      // pre-fix this THROWS 42703 (column room_type_id does not exist)
      const grid = await getRateGridState(tx, t2.id, DAY, NEXT);
      const cells = new Map(
        grid.types.flatMap((b) => b.units).map((u) => [u.sellableUnitId, u.cells]),
      );
      const mappedCells = cells.get(suIds[0]), unmappedCells = cells.get(suIds[1]);
      assert.ok(mappedCells && unmappedCells, "both scaffold units render");
      assert.equal(mappedCells[0].syncState, "pending", "dirty (room, day) → pending");
      assert.equal(mappedCells[1].syncState, "clean", "day outside the dirty range → clean");
      assert.equal(mappedCells[0].mappingValid, true, "mapped room → mappingValid");
      assert.equal(unmappedCells[0].mappingValid, false, "unmapped room → not mappingValid");
      assert.equal(unmappedCells[0].syncState, "clean", "no dirty range on the other room");
      assert.equal(mappedCells[0].outboundAvailability, mappedCells[0].availability,
        "outbound availability is the SU's own physical availability (D64: one room = one channel room type)");
    });
    Module._resolveFilename = orig;
    ok("active connection renders axis C from the ROOM model — the 42703 crash path is executed and gone");
  }

  console.log(`\nALL ${n} RATE-GRID CHECKS PASSED`);
} catch (e) {
  console.error("RATE-GRID CHECK FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
