// ============================================================
// Phase 2.4/2.5 — what a DERIVED rate plan would publish to Beds24, measured
// without touching production and without a single HTTP call.
//
// The question this answers: "ללא החזר" is the base; weekly −15% / monthly −30%
// / flexible +5% inherit from it and publish NOTHING today. If one of them were
// the designated plan of a mapping, WOULD the correct number reach the wire?
//
// Method — no simulation of our own code, ever:
//   · the REAL projectBeds24Ari (src/lib/channel/beds24-ari-projection.ts) and
//     the REAL buildBeds24CalendarRequests (beds24-ari-payloads.ts) are compiled
//     from THIS tree with tsc and executed;
//   · against the ISOLATED disposable test DB (:5433), seeded with production's
//     measured shape (three rooms at 610 / 750 / 700, 1:1 sellable units, a
//     tenant-level base plan + three derived_percentage children, all
//     channel-visible and assigned) — inside ONE transaction that ROLLS BACK;
//   · the sender (beds24-ari-sync.ts) is never imported. NOTHING is pushed.
//
// The 2.5 gate compares three independently-derived numbers per (room, date):
//   local    — what the projection resolved (our engine's answer)
//   sent     — the price1 that the payload builder actually emitted
//   expected — base × (1 + adjustment/100), computed here in plain arithmetic
// A scenario passes only when all three agree on every cell.
//
// Usage: node scripts/check-beds24-derived-plan-dryrun.mjs
// ============================================================

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import postgres from "postgres";

// A guard tests the tree it lives in (D101) — never a hardcoded checkout.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

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

// ---- migration chain onto the disposable DB ----
// The chain replays from ZERO but is NOT idempotent on an already-migrated
// schema: 005 builds a partial index on channex_room_type_id, which 054 renamed
// to external_room_type_id, so a second pass dies on a column that no longer
// exists. Dropping first is therefore mandatory, not hygiene — and safe, because
// the production-marker check above has already refused anything but :5433.
console.log("dropping + replaying the migration chain on the test DB…");
// NOTICE chatter is expected on a replay; only a real failure is printed.
const psqlQuiet = (arg) => {
  try {
    execSync(`psql "${TEST_URL}" -v ON_ERROR_STOP=1 -q ${arg}`, {
      cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], shell: "/bin/bash",
    });
  } catch (e) {
    console.error(String(e.stderr ?? "").split("\n").filter((l) => !l.includes("NOTICE:")).join("\n"));
    process.exit(1);
  }
};
psqlQuiet(`-c "DROP SCHEMA IF EXISTS guesthub CASCADE;"`);
for (const f of readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort()) {
  psqlQuiet(`-f "db/migrations/${f}"`);
}

// ---- compile the REAL projection + payload modules from this tree ----
console.log("compiling src/lib/channel/beds24-ari-{projection,payloads} via tsc…");
const tmp = mkdtempSync(join(tmpdir(), "gh-b24-dryrun-"));
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
    join(ROOT, "src/lib/channel/beds24-ari-projection.ts"),
    join(ROOT, "src/lib/channel/beds24-ari-payloads.ts"),
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

const { projectBeds24Ari } = req(join(out, "lib/channel/beds24-ari-projection.js"));
const { buildBeds24CalendarRequests, validateBeds24CalendarRequest } =
  req(join(out, "lib/channel/beds24-ari-payloads.js"));

const sql = postgres(TEST_URL, { prepare: false, max: 1, onnotice: () => {} });

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };
class Rollback extends Error {}

// production's measured shape (ref/proof/p22-plan-set.txt §E)
const ROOMS = [
  { number: "1238", price: 610 },
  { number: "1318", price: 750 },
  { number: "1102", price: 700 },
];
const FROM = "2026-09-01";
const TO = "2026-09-08"; // exclusive → 7 nights
const NIGHTS = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04",
                "2026-09-05", "2026-09-06", "2026-09-07"];
const round2 = (x) => Math.round(x * 100) / 100;

// the payload's price1 for a given room+date: find the compressed range covering it
function sentPriceFor(requests, beds24RoomId, date) {
  for (const request of requests) {
    for (const entry of request) {
      if (entry.roomId !== beds24RoomId) continue;
      for (const r of entry.calendar) {
        if (r.from <= date && date <= r.to) return { price1: r.price1, numAvail: r.numAvail };
      }
    }
  }
  return null;
}

const report = [];
const say = (line) => { report.push(line); console.log(line); };

try {
  await sql.begin(async (tx) => {
    // ================= fixtures: production's shape, not production's data ====
    const [tenant] = await tx`
      INSERT INTO guesthub.tenants (name, slug) VALUES ('DryRun', 'b24-derived-dryrun') RETURNING id`;
    const T = tenant.id;
    const [rt] = await tx`
      INSERT INTO guesthub.room_types (tenant_id, name, base_price)
      VALUES (${T}, 'דירה', 0) RETURNING id`;

    const rooms = [];
    for (const [i, spec] of ROOMS.entries()) {
      const [room] = await tx`
        INSERT INTO guesthub.rooms (tenant_id, room_type_id, room_number, status, is_active)
        VALUES (${T}, ${rt.id}, ${spec.number}, 'available', true) RETURNING id`;
      // 1:1 sellable unit — the projection refuses to price a pooled unit
      const [su] = await tx`
        INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id, is_pooled, is_active)
        VALUES (${T}, ${`SU-${spec.number}`}, ${`יחידה ${spec.number}`}, ${rt.id}, false, true) RETURNING id`;
      await tx`INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id)
               VALUES (${T}, ${su.id}, ${room.id})`;
      // the unit's OWN is_base plan — where production's 17,984 priced rows live
      const [unitBase] = await tx`
        INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base, is_active, plan_kind)
        VALUES (${T}, ${su.id}, 'base', 'מחיר בסיס', true, true, 'base') RETURNING id`;
      for (const d of NIGHTS) {
        await tx`INSERT INTO guesthub.pricing_plan_rates
                   (tenant_id, sellable_unit_id, pricing_plan_id, date, price)
                 VALUES (${T}, ${su.id}, ${unitBase.id}, ${d}, ${spec.price})`;
      }
      rooms.push({ ...spec, id: room.id, suId: su.id, beds24RoomId: 707480 + i });
    }

    // a room deliberately left WITHOUT a mapping, so the second unique
    // constraint can be provoked in isolation (a mapped room would trip the
    // (connection_id, room_id) one first and prove nothing about this one).
    const [spare] = await tx`
      INSERT INTO guesthub.rooms (tenant_id, room_type_id, room_number, status, is_active)
      VALUES (${T}, ${rt.id}, '9999', 'available', true) RETURNING id`;

    // tenant-level plans: the base + the three derived children (production's set)
    const [nr] = await tx`
      INSERT INTO guesthub.pricing_plans
        (tenant_id, code, name, plan_kind, is_active, is_archived, is_visible_channels, is_refundable)
      VALUES (${T}, 'No_Refuneble', 'ללא החזר', 'base', true, false, true, false) RETURNING id`;
    const derived = {};
    for (const [code, name, adj] of [
      ["Weekly-rate", "תעריף שבועי", -15],
      ["Monthly-rate", "תעריף חודשי", -30],
      ["BG", "ביטול גמיש", 5],
    ]) {
      const [p] = await tx`
        INSERT INTO guesthub.pricing_plans
          (tenant_id, code, name, plan_kind, parent_plan_id, adjustment_value,
           is_active, is_archived, is_visible_channels)
        VALUES (${T}, ${code}, ${name}, 'derived_percentage', ${nr.id}, ${adj}, true, false, true)
        RETURNING id`;
      derived[code] = { id: p.id, adj, name };
    }
    // every tenant plan assigned & active on every unit — production's state
    for (const planId of [nr.id, ...Object.values(derived).map((d) => d.id)]) {
      for (const room of rooms) {
        await tx`INSERT INTO guesthub.pricing_plan_units (tenant_id, pricing_plan_id, sellable_unit_id, is_active)
                 VALUES (${T}, ${planId}, ${room.suId}, true)`;
      }
    }

    const [conn] = await tx`
      INSERT INTO guesthub.channel_connections (tenant_id, provider, environment, state)
      VALUES (${T}, 'beds24', 'production', 'active') RETURNING id`;

    // ================= 2.4a — the structural limit, proved by the DB =========
    for (const room of rooms) {
      await tx`INSERT INTO guesthub.channel_beds24_room_mappings
                 (tenant_id, connection_id, room_id, beds24_property_id, beds24_room_id,
                  local_rate_plan_id, status)
               VALUES (${T}, ${conn.id}, ${room.id}, '287191', ${String(room.beds24RoomId)},
                       ${nr.id}, 'mapped')`;
    }
    {
      // "give each room an additional mapping, one per plan" — attempted for real
      let threw = null;
      try {
        await tx.savepoint(async (sp) => {
          await sp`INSERT INTO guesthub.channel_beds24_room_mappings
                     (tenant_id, connection_id, room_id, beds24_property_id, beds24_room_id,
                      local_rate_plan_id, status)
                   VALUES (${T}, ${conn.id}, ${rooms[0].id}, '287191', '999001',
                           ${derived["Monthly-rate"].id}, 'mapped')`;
        });
      } catch (e) { threw = e; }
      assert.ok(threw, "a second mapping row for the same room was accepted — it must not be");
      assert.equal(threw.code, "23505", `expected unique violation, got ${threw.code}`);
      // name the constraint: the two UNIQUEs are different claims and a check
      // that cannot tell them apart proves neither.
      assert.equal(threw.constraint_name, "channel_beds24_room_mappings_connection_id_room_id_key",
        `wrong constraint fired: ${threw.constraint_name}`);
      say(`  · a 2nd mapping for one room ⇒ SQLSTATE 23505 on ${threw.constraint_name}`);
      ok("a room CANNOT hold a second designated plan: UNIQUE (connection_id, room_id) refuses it");
    }
    {
      // …and an as-yet-unmapped room cannot be pointed at an already-used Beds24
      // room either. The spare room keeps (connection_id, room_id) free, so the
      // OTHER unique constraint is the one under test here.
      let threw = null;
      try {
        await tx.savepoint(async (sp) => {
          await sp`INSERT INTO guesthub.channel_beds24_room_mappings
                     (tenant_id, connection_id, room_id, beds24_property_id, beds24_room_id,
                      local_rate_plan_id, status)
                   VALUES (${T}, ${conn.id}, ${spare.id}, '287191', ${String(rooms[0].beds24RoomId)},
                           ${derived["Monthly-rate"].id}, 'mapped')`;
        });
      } catch (e) { threw = e; }
      assert.ok(threw, "two mappings onto one Beds24 room were accepted — they must not be");
      assert.equal(threw.code, "23505", `expected unique violation, got ${threw.code}`);
      assert.equal(threw.constraint_name, "channel_beds24_room_mappings_connection_id_beds24_property__key",
        `wrong constraint fired: ${threw.constraint_name}`);
      say(`  · a 2nd mapping onto one Beds24 room ⇒ SQLSTATE 23505 on ${threw.constraint_name}`);
      ok("one Beds24 room CANNOT carry two plans: UNIQUE (connection_id, property, room) refuses it");
    }

    // ================= 2.4b/2.5 — one scenario per plan ======================
    const scenarios = [
      { key: "base", label: "ללא החזר (base, today's mapping)", planId: nr.id, adj: 0 },
      { key: "Weekly-rate", label: "תעריף שבועי −15%", planId: derived["Weekly-rate"].id, adj: -15 },
      { key: "Monthly-rate", label: "תעריף חודשי −30%", planId: derived["Monthly-rate"].id, adj: -30 },
      { key: "BG", label: "ביטול גמיש +5%", planId: derived["BG"].id, adj: 5 },
    ];

    for (const s of scenarios) {
      await tx`UPDATE guesthub.channel_beds24_room_mappings
               SET local_rate_plan_id = ${s.planId} WHERE connection_id = ${conn.id}`;

      const projection = await projectBeds24Ari(tx, {
        tenantId: T, connectionId: conn.id, dateFrom: FROM, dateTo: TO,
      });
      const mappings = rooms.map((r) => ({
        roomId: r.id, beds24PropertyId: "287191", beds24RoomId: String(r.beds24RoomId),
        localRatePlanId: s.planId,
        // the provider ceiling is a live read; a dry-run has none ⇒ omit the field
        maxStayCeiling: null,
      }));
      const built = buildBeds24CalendarRequests(projection, mappings);

      assert.equal(built.unmapped.length, 0, `${s.key}: unexpected unmapped rooms`);
      assert.equal(built.invalidRoomIds.length, 0, `${s.key}: unexpected invalid room ids`);
      assert.equal(projection.blocked.length, 0, `${s.key}: cells blocked — ${JSON.stringify(projection.blocked.slice(0, 3))}`);
      for (const r of built.requests) {
        assert.equal(validateBeds24CalendarRequest(r), null, `${s.key}: payload failed its own validator`);
      }

      say(`\n── ${s.label} ──`);
      say("| room | base | expected | local (projection) | sent (price1) | numAvail |");
      say("|---|---|---|---|---|---|");
      for (const room of rooms) {
        const expected = s.adj === 0 ? room.price : round2(room.price * (1 + s.adj / 100));
        for (const date of NIGHTS) {
          const cRow = projection.commercial.find(
            (c) => c.roomId === room.id && c.planId === s.planId && c.date === date);
          assert.ok(cRow, `${s.key}/${room.number}/${date}: no commercial row`);
          assert.ok(cRow.rates && cRow.rates.length === 1,
            `${s.key}/${room.number}/${date}: expected exactly one occupancy entry`);
          const local = cRow.rates[0].rate;
          const wire = sentPriceFor(built.requests, room.beds24RoomId, date);
          assert.ok(wire, `${s.key}/${room.number}/${date}: no calendar range covers this date`);

          // ---- THE 2.5 GATE: three independently-derived numbers must agree ----
          assert.equal(local, expected,
            `${s.key}/${room.number}/${date}: local ${local} ≠ expected ${expected}`);
          assert.equal(wire.price1, expected,
            `${s.key}/${room.number}/${date}: sent ${wire.price1} ≠ expected ${expected}`);
          assert.equal(wire.numAvail, 1,
            `${s.key}/${room.number}/${date}: expected an available night`);
        }
        const wire = sentPriceFor(built.requests, room.beds24RoomId, NIGHTS[0]);
        say(`| ${room.number} | ${room.price} | ${expected} | ${expected} | ${wire.price1} | ${wire.numAvail} |`);
      }
      const ranges = built.requests.reduce((a, r) => a + r.reduce((b, e) => b + e.calendar.length, 0), 0);
      say(`payload: ${built.requests.length} request(s), ${ranges} compressed range(s) for ${rooms.length} rooms × ${NIGHTS.length} nights`);
      ok(`${s.label}: local = sent = expected on all ${rooms.length * NIGHTS.length} cells`);
    }

    // ================= negative control — a base with no price ==============
    {
      await tx`UPDATE guesthub.channel_beds24_room_mappings
               SET local_rate_plan_id = ${derived["Monthly-rate"].id} WHERE connection_id = ${conn.id}`;
      await tx.savepoint(async (sp) => {
        await sp`DELETE FROM guesthub.pricing_plan_rates
                 WHERE tenant_id = ${T} AND sellable_unit_id = ${rooms[0].suId}`;
        const projection = await projectBeds24Ari(sp, {
          tenantId: T, connectionId: conn.id, dateFrom: FROM, dateTo: TO,
        });
        const built = buildBeds24CalendarRequests(projection, rooms.map((r) => ({
          roomId: r.id, beds24PropertyId: "287191", beds24RoomId: String(r.beds24RoomId),
          localRatePlanId: derived["Monthly-rate"].id, maxStayCeiling: null,
        })));
        const blocked = projection.blocked.filter((b) => b.roomId === rooms[0].id);
        assert.equal(blocked.length, NIGHTS.length, "every night of the priceless room must block");
        assert.equal(blocked[0].reason, "NO_PRICE_FOR_DATE");
        for (const date of NIGHTS) {
          const wire = sentPriceFor(built.requests, rooms[0].beds24RoomId, date);
          assert.ok(wire, "the blocked room must still be stated on the wire");
          assert.equal(wire.numAvail, 0, "a priceless night must publish numAvail 0");
          assert.equal(wire.price1, undefined, "a priceless night must carry NO price1");
        }
        // the OTHER rooms are untouched — a derived plan does not fail as a block
        const other = sentPriceFor(built.requests, rooms[1].beds24RoomId, NIGHTS[0]);
        assert.equal(other.price1, round2(rooms[1].price * 0.7));
        ok("no unit base price ⇒ the derived plan resolves to nothing: numAvail 0, NO price1 (fail-closed)");
      });
    }

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error(`\n✗ ${e.message}`);
    await sql.end();
    process.exit(1);
  }
} finally {
  await sql.end().catch(() => {});
}

// ref/ is gitignored (D87 — the repo is public), so this transcript is a local
// convenience only. It must never be the ONLY place the numbers live, and its
// absence must never break the guard on a fresh clone.
mkdirSync(join(ROOT, "ref/proof"), { recursive: true });
writeFileSync(join(ROOT, "ref/proof/p24-derived-dryrun.txt"), `${report.join("\n")}\n`);
console.log(`\nALL ${n} PASSED — nothing was written to production, no HTTP call was made.`);
