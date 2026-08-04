#!/usr/bin/env node
// ============================================================
// check:ari-horizon — a commercial write stores EVERY date the operator
// entered, and claims outbound work for only the dates a channel can accept.
//
// THE DEFECT. writeRateCells marked exactly the edit window dirty, unclipped,
// while ranges.ts declared the opposite invariant in its own comment ("the
// incremental pass can never address a date the baseline never covered"). A
// Group Update reaching 2029 therefore queued channel work 1,191 days out.
// Beds24 refuses a range that crosses its 24-month limit WHOLESALE — measured
// live 2026-07-28 (commit 57e9bfe): HTTP 201, success:false, warning "invalid
// dates", with `modified` listing every range through 2028-05-31 and silently
// dropping the one that ran 2028-06-01 → 2029-10-31. Production carried 28 such
// ranges, each burned to attempts=10, painting /rates red over dates that had
// published perfectly well.
//
// THE OTHER HALF OF THE RULE, which is why this guard is DB-backed rather than
// a source grep: the stored pricing rows must NOT be clipped. They price the
// direct website, which never speaks to a channel. A fix that "solved" the
// queue by refusing far-future prices would be a data-loss bug wearing a
// green check.
//
// Isolated: a DEDICATED database on the test server, never production. No
// network, no provider — markAriDirty and writeRateCells are the units under
// test and both are pure DB.
//
// Usage: node scripts/check-ari-horizon.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import Module from "node:module";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

const TEST_URL =
  process.env.TEST_DATABASE_URL ||
  "postgres://supabase_admin:guesthub_test_local@localhost:5433/guesthub_horizon_check";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (TEST_URL.includes(marker)) {
    console.error(`REFUSED: TEST_DATABASE_URL contains production marker "${marker}"`);
    process.exit(1);
  }
}
process.env.DATABASE_URL = TEST_URL;

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

// The rates service is NOT part of the channel-worker graph, so tsconfig.worker
// does not emit it. Compile the same way, from the same source, with the entry
// this guard actually tests — tsc pulls the rest of the graph in behind it.
const OUT = join(ROOT, "node_modules", ".cache", "check-ari-horizon");
mkdirSync(OUT, { recursive: true });
const TSCONFIG = join(OUT, "tsconfig.json");
writeFileSync(TSCONFIG, JSON.stringify({
  compilerOptions: {
    module: "commonjs", moduleResolution: "node10", target: "es2022",
    lib: ["es2023"], types: ["node"], esModuleInterop: true, skipLibCheck: true,
    strict: true, noEmitOnError: true,
    baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
    rootDir: join(ROOT, "src"), outDir: OUT,
  },
  include: [join(ROOT, "src/lib/rates/service.ts")],
}));
execSync(`pnpm exec tsc -p ${TSCONFIG}`, { stdio: "inherit" });
const STUB = join(ROOT, "scripts", "server-only-stub.cjs");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return STUB;
  if (request.startsWith("@/")) return origResolve.call(this, join(OUT, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};
const req = createRequire(import.meta.url);
const { writeRateCells } = req(join(OUT, "lib/rates/service.js"));
const { ARI_HORIZON_DAYS } = req(join(OUT, "lib/channel/ranges.js"));
const { todayInTz, addDays } = req(join(OUT, "lib/dates.js"));

const sql = postgres(TEST_URL, { prepare: false, max: 1, onnotice: () => {} });

async function ensureSchema() {
  const [{ c }] = await sql`
    SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema = 'guesthub'`;
  if (c > 40) return c;
  const dir = join(ROOT, "db", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await sql.unsafe(readFileSync(join(dir, f), "utf8"));
  }
  const [{ c: after }] = await sql`
    SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema = 'guesthub'`;
  return after;
}

const T = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CONN = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa";
const ROOM = "aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa";
const SU = "aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa";
const PLAN = "aaaaaaaa-5555-4555-8555-aaaaaaaaaaaa";

const TZ = "Asia/Jerusalem";
const TODAY = todayInTz(TZ);
/** the last date any outbound claim may cover, INCLUSIVE */
const HORIZON_LAST = addDays(TODAY, ARI_HORIZON_DAYS - 1);
const at = (offset) => addDays(TODAY, offset);

/** one edit: write `dates` through the canonical service, in its own transaction */
async function edit(dates) {
  await sql`DELETE FROM guesthub.channel_dirty_ranges WHERE tenant_id = ${T}`;
  await sql.begin(async (tx) => {
    await writeRateCells(tx, T, dates.map((date) => ({
      sellableUnitId: SU, pricingPlanId: PLAN, date, patch: { price: 480, min_stay_arrival: 2 },
    })));
  });
  return {
    stored: await sql`
      SELECT date::text AS date, price::float8 AS price, min_stay_arrival
      FROM guesthub.pricing_plan_rates
      WHERE tenant_id = ${T} AND pricing_plan_id = ${PLAN} AND date = ANY(${dates}::date[])
      ORDER BY date`,
    ranges: await sql`
      SELECT kind, date_from::text AS date_from, date_to::text AS date_to
      FROM guesthub.channel_dirty_ranges WHERE tenant_id = ${T} ORDER BY kind`,
  };
}

try {
  const tables = await ensureSchema();
  ok(`isolated schema ready on the dedicated check database (${tables} tables)`);

  for (const t of ["channel_dirty_ranges", "pricing_plan_rates", "pricing_plan_units",
                   "pricing_plans", "sellable_unit_rooms", "sellable_units", "rooms",
                   "channel_connections"]) {
    await sql.unsafe(`DELETE FROM guesthub.${t} WHERE tenant_id = '${T}'`);
  }
  await sql`DELETE FROM guesthub.tenants WHERE id = ${T}`;

  await sql`INSERT INTO guesthub.tenants (id, name, slug, timezone)
            VALUES (${T}, 'ari-horizon', 'ari-horizon', ${TZ})`;
  // an ACTIVE outbound connection — without one markAriDirty is a no-op and
  // every assertion below would pass vacuously
  await sql`
    INSERT INTO guesthub.channel_connections
      (id, tenant_id, provider, environment, state, is_active_provider,
       outbound_sync_enabled, full_sync_required, api_key_ciphertext,
       access_token_ciphertext, access_token_expires_at, consecutive_failures)
    VALUES (${CONN}, ${T}, 'beds24', 'production', 'active', true, true, false,
            'unused-by-this-guard', 'unused-by-this-guard',
            now() + interval '20 hours', 0)`;
  await sql`INSERT INTO guesthub.rooms (id, tenant_id, room_number, status, is_active)
            VALUES (${ROOM}, ${T}, '801', 'available', true)`;
  await sql`INSERT INTO guesthub.sellable_units (id, tenant_id, code, name, is_active)
            VALUES (${SU}, ${T}, '801', 'unit-801', true)`;
  await sql`INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id)
            VALUES (${T}, ${SU}, ${ROOM})`;
  await sql`
    INSERT INTO guesthub.pricing_plans
      (id, tenant_id, sellable_unit_id, code, name, plan_kind, is_base, is_active,
       is_archived, is_visible_channels)
    VALUES (${PLAN}, ${T}, ${SU}, 'base', 'base', 'base', true, true, false, true)`;
  ok(`fixture: one room, one plan, an ACTIVE outbound connection · horizon ${ARI_HORIZON_DAYS} days (last publishable date ${HORIZON_LAST})`);

  // ---- 1. entirely beyond the horizon: every row stored, ZERO channel work ----
  // The rows price the direct website. Dropping them to keep the queue clean
  // would be data loss; queueing work Beds24 rejects wholesale is what put 28
  // ranges into `failed` and turned the /rates chip red.
  {
    const dates = [at(ARI_HORIZON_DAYS + 40), at(ARI_HORIZON_DAYS + 41), at(ARI_HORIZON_DAYS + 42)];
    const { stored, ranges } = await edit(dates);
    assert.equal(stored.length, dates.length,
      "every rate row beyond the horizon must still be STORED — it prices the direct website");
    assert.deepEqual(stored.map((r) => r.date), dates);
    assert.equal(stored.every((r) => r.price === 480 && r.min_stay_arrival === 2), true,
      "the stored values must be the operator's own, untruncated");
    assert.equal(ranges.length, 0,
      "an edit lying entirely beyond the horizon must enqueue NO channel work at all");
  }
  ok("edit entirely beyond the horizon: all rows stored, zero channel ranges, nothing left to fail");

  // ---- 2. straddling the horizon: all rows stored, the claim stops at it ----
  {
    const dates = [at(ARI_HORIZON_DAYS - 2), at(ARI_HORIZON_DAYS - 1), at(ARI_HORIZON_DAYS),
                   at(ARI_HORIZON_DAYS + 1), at(ARI_HORIZON_DAYS + 2)];
    const { stored, ranges } = await edit(dates);
    assert.equal(stored.length, dates.length, "a straddling edit stores every date it was given");
    assert.equal(ranges.length, 2, "rates + restrictions, one range each");
    for (const r of ranges) {
      assert.equal(r.date_from, at(ARI_HORIZON_DAYS - 2), "the claim starts at the edit's first date");
      assert.equal(r.date_to, addDays(HORIZON_LAST, 1),
        "the claim is clipped to the horizon — exclusive end = last publishable date + 1");
    }
  }
  ok("edit straddling the horizon: all rows stored, channel work clipped exactly at the horizon");

  // ---- 3. fully inside: unchanged by this control (the anti-over-clip case) ----
  {
    const dates = [at(10), at(11), at(12)];
    const { stored, ranges } = await edit(dates);
    assert.equal(stored.length, 3);
    assert.equal(ranges.length, 2);
    for (const r of ranges) {
      assert.equal(r.date_from, at(10), "an in-horizon edit claims exactly its own window");
      assert.equal(r.date_to, at(13), "…and its own exclusive end, untouched by the clip");
    }
  }
  ok("edit fully inside the horizon: claim window byte-identical to before this control existed");

  // ---- 4. the invariant itself, over every shape above ----
  {
    const shapes = [
      [at(0)],
      [at(ARI_HORIZON_DAYS - 1)],
      [at(ARI_HORIZON_DAYS - 1), at(ARI_HORIZON_DAYS)],
      [at(5), at(ARI_HORIZON_DAYS * 2)],
      [at(ARI_HORIZON_DAYS * 3)],
    ];
    const limit = addDays(HORIZON_LAST, 1); // exclusive
    for (const dates of shapes) {
      const { stored, ranges } = await edit(dates);
      assert.equal(stored.length, dates.length, `every date of ${dates.join(",")} must be stored`);
      for (const r of ranges) {
        assert.ok(r.date_to <= limit,
          `a claim may never reach past today+${ARI_HORIZON_DAYS} (saw ${r.date_to} > ${limit})`);
      }
    }
  }
  ok(`no edit of any shape enqueues a claim past today+${ARI_HORIZON_DAYS}, and none loses a stored row`);

  // ---- 5. the inbound pull window is NOT derived from the publishing horizon ----
  // They held the same number and were therefore written as one constant, so
  // raising the publishing horizon to 720 silently widened the inbound booking
  // pull too. D94: widening a pull is not widening coverage, it MOVES RISK
  // BETWEEN PATHS — a pull that returns a new class of record changes which code
  // actually runs and invalidates every status-dependent gate's assumptions,
  // including gates whose own guards still pass. That walk has not been done for
  // 720. Re-coupling them fails here.
  {
    // comments are blanked (line structure preserved) — the constants document
    // their independence by NAMING each other, and that must not trip the rule
    const stripComments = (s) => s
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/^([ \t]*)\/\/.*$/gm, "$1");
    const importSrc = readFileSync(join(ROOT, "src/lib/channel/beds24-booking-import.ts"), "utf8");
    const code = stripComments(importSrc);

    assert.equal(/ARI_HORIZON_DAYS/.test(code), false,
      "the inbound booking pull must not reference the outbound publishing horizon in executable code");
    assert.match(code, /export const BEDS24_INBOUND_FORWARD_DAYS = (\d+)/,
      "the inbound pull must declare its own forward window");
    const declared = Number(code.match(/export const BEDS24_INBOUND_FORWARD_DAYS = (\d+)/)[1]);
    assert.equal(declared, 500,
      "the inbound window stays at its pre-decoupling value until the D94 gate walk is done");
    assert.notEqual(declared, ARI_HORIZON_DAYS,
      "inbound and outbound windows must not be silently reunified by holding the same number");
    // …and the arrival filter is built from THAT constant, not from a literal
    // that would drift away from it unnoticed
    assert.match(code, /arrivalTo=\$\{isoDate\(BEDS24_INBOUND_FORWARD_DAYS \* 86_400_000\)\}/,
      "the first-run arrival window must be built from the inbound constant");

    // the complement: publishing IS one concern, and must stay derived
    const syncSrc = stripComments(
      readFileSync(join(ROOT, "src/lib/channel/beds24-ari-sync.ts"), "utf8"));
    assert.match(syncSrc, /BEDS24_FULL_SYNC_DAYS = ARI_HORIZON_DAYS/,
      "the full-sync horizon must stay derived from ARI_HORIZON_DAYS — it is the same concern");
  }
  ok("the inbound pull window is independent of the publishing horizon, and full sync stays derived from it");

  console.log(`\nARI HORIZON: ${n} PASSED`);
} finally {
  await sql.end();
}
