#!/usr/bin/env node
// ============================================================
// check:bulk-update-audit — a Group Update records restriction before/after,
// not only price (D187).
//
// WHY. bulk_rate_update_items had old_price/new_price only: the 2026-09-06
// min-stay run audited as 32 rows whose two price columns were equal — "nothing
// happened" — while every night's min_stay_through had changed. D187 adds
// old_restrictions / new_restrictions (the six fields, as stored) and a
// `changed` count (price OR any restriction) on the action's summary.
//
// WHAT IT PROVES, by running the REAL bulkUpdateRatesAction against a fixture
// database (its own scratch DB on :5433, the full migration chain in manifest
// order via scripts/db/migrate.mjs):
//   · a minStayThrough-only run over 3 nights → 3 items whose
//     new_restrictions.min_stay_through differs from old, whose price columns
//     are unchanged, and a summary changed = 3 (the affected nights) — on the
//     action's result AND on the audit_logs after-summary;
//   · the SAME run again → 3 items, changed = 0 (a true no-op is still audited);
//   · a price-only run → changed = 3 and the restrictions are equal before/after;
//   · a night with NO stored row → old_restrictions NULL, old_price NULL, changed.
//   · D188: the action RESULT carries both numbers the Group Update toast shows
//     ("עודכנו N תאים · M שונו") — cells and changed — with changed = 0 for the
//     no-op run and = nights × units for the min-stay run.
//
// B2 (each turns this red; restore → green):
//   · drop the restriction write in actions.ts (both columns stay NULL);
//   · count `changed` by price only (the min-stay run reports 0).
//
// The action runs outside Next: getActor is a stub (the fixture's user),
// next/cache and next/headers are no-ops; everything else is the real code,
// compiled by tsc from src. Usage: node scripts/check-bulk-update-audit.mjs
// ============================================================
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);
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
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// ---- static: the wiring ----------------------------------------------------
{
  const service = read("src/lib/rates/service.ts");
  assert.match(service, /oldRestrictions: RateRestrictions \| null;/, "RateChange carries the old restrictions (null = no row existed)");
  assert.match(service, /newRestrictions: RateRestrictions;/, "…and the new ones");
  const actions = read("src/app/(dashboard)/rates/actions.ts");
  assert.match(actions, /"old_restrictions", "new_restrictions",/, "the items INSERT lists both restriction columns");
  assert.match(actions, /chunkForBind\(items, 9\)/, "the bind-parameter slicing counts 9 columns per row");
  assert.ok(read("db/migrations/manifest.txt").includes("090_bulk_items_restrictions.sql"), "migration 090 is in the manifest");
  ok("wiring: RateChange, the items INSERT, the manifest");
}

// ---- scratch database + the migration chain --------------------------------
const DB_NAME = `gh_bulk_audit_${process.pid}`;
const RUN_URL = TEST_URL.replace(/\/[^/]*$/, `/${DB_NAME}`);
const psqlAdmin = (q) =>
  execFileSync("psql", [TEST_URL, "-qX", "-c", q], { stdio: ["ignore", "ignore", "inherit"] });
psqlAdmin(`DROP DATABASE IF EXISTS ${DB_NAME}`);
psqlAdmin(`CREATE DATABASE ${DB_NAME}`);
console.log(`applying the migration chain to ${DB_NAME} (manifest order)…`);
execFileSync(process.execPath, [join(ROOT, "scripts/db/migrate.mjs"), "--apply"], {
  cwd: ROOT, stdio: ["ignore", "ignore", "inherit"],
  env: { ...process.env, MIGRATE_DATABASE_URL: RUN_URL },
});

// ---- compile the REAL action and its graph; stub only the Next runtime -------
// Under node_modules/.cache so the compiled files resolve `postgres`, `zod`
// etc. from the tree's own node_modules.
const cache = join(ROOT, "node_modules/.cache/gh-bulk-update-audit", String(process.pid));
const out = join(cache, "out");
const stubs = join(cache, "stubs");
mkdirSync(stubs, { recursive: true });
writeFileSync(join(cache, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    module: "commonjs", moduleResolution: "node10", target: "es2022", lib: ["es2023", "dom"],
    esModuleInterop: true, skipLibCheck: true, strict: true, jsx: "react-jsx",
    baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
    rootDir: join(ROOT, "src"), outDir: out,
    typeRoots: [join(ROOT, "node_modules/@types")], types: ["node"],
  },
  include: [join(ROOT, "src/app/(dashboard)/rates/actions.ts")],
}));
execSync(`"${join(ROOT, "node_modules/.bin/tsc")}" -p "${join(cache, "tsconfig.json")}"`, { cwd: ROOT, stdio: "inherit" });
writeFileSync(join(stubs, "server-only.cjs"), "module.exports = {};\n");
writeFileSync(join(stubs, "next-cache.cjs"), "module.exports = { revalidatePath: () => {}, revalidateTag: () => {} };\n");
writeFileSync(join(stubs, "next-headers.cjs"),
  "module.exports = { headers: async () => new Map(), cookies: async () => ({ get: () => undefined }) };\n");
// the actor: the fixture's user; permission checks stay the REAL ones
writeFileSync(join(stubs, "actor.cjs"),
  `const pc = require(${JSON.stringify(join(out, "lib/auth/permission-check.js"))});\n` +
  "module.exports = { ...pc, getActor: async () => globalThis.__gh_actor };\n");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return join(stubs, "server-only.cjs");
  if (request === "next/cache") return join(stubs, "next-cache.cjs");
  if (request === "next/headers") return join(stubs, "next-headers.cjs");
  if (request === "@/lib/auth/actor") return join(stubs, "actor.cjs");
  if (request.startsWith("@/")) return origResolve.call(this, join(out, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};
process.env.DATABASE_URL = RUN_URL;
const req = createRequire(join(ROOT, "package.json"));
const actions = req(join(out, "app/(dashboard)/rates/actions.js"));
const postgres = req("postgres");
const sql = postgres(RUN_URL, { prepare: false, max: 1 });

const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
const day = (o) => { const d = new Date(`${TODAY}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + o); return d.toISOString().slice(0, 10); };

try {
  // ---- fixture: a tenant, a room, its sellable unit + base plan, 3 priced nights
  const uniq = (p) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const [tenant] = await sql`
    INSERT INTO guesthub.tenants (name, slug, timezone, currency)
    VALUES ('בדיקת אודיט עדכון קבוצתי', ${uniq("bulk-audit")}, 'Asia/Jerusalem', 'ILS') RETURNING id`;
  const T = tenant.id;
  const [user] = await sql`
    INSERT INTO guesthub.users (tenant_id, username, full_name) VALUES (${T}, ${uniq("op")}, 'מפעיל') RETURNING id`;
  const [rt] = await sql`
    INSERT INTO guesthub.room_types (tenant_id, name, base_price) VALUES (${T}, 'סוג בדיקה', 400) RETURNING id`;
  const [room] = await sql`
    INSERT INTO guesthub.rooms (tenant_id, room_number, room_type_id, status, is_active)
    VALUES (${T}, 'B-1', ${rt.id}, 'available', true) RETURNING id`;
  const [su] = await sql`
    INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id)
    VALUES (${T}, 'B-1', 'יחידה B-1', ${rt.id}) RETURNING id`;
  await sql`
    INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id) VALUES (${T}, ${su.id}, ${room.id})`;
  const [plan] = await sql`
    INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base, is_active, plan_kind)
    VALUES (${T}, ${su.id}, 'base', 'מחיר בסיס', true, true, 'base') RETURNING id`;
  const NIGHTS = [day(2), day(3), day(4)];
  for (const d of NIGHTS) {
    await sql`
      INSERT INTO guesthub.pricing_plan_rates (tenant_id, sellable_unit_id, pricing_plan_id, date, price, min_stay_through)
      VALUES (${T}, ${su.id}, ${plan.id}, ${d}, 500, 1)`;
  }
  globalThis.__gh_actor = {
    userId: user.id, tenantId: T, roleKey: "super_admin", permissions: new Set(["rates.bulk_update"]),
  };

  const latestLog = async () => (await sql`
    SELECT id FROM guesthub.bulk_rate_update_logs WHERE tenant_id = ${T} ORDER BY created_at DESC, id DESC LIMIT 1`)[0];
  const itemsOf = async (logId) => sql`
    SELECT date::text AS date, old_price::float8 AS old_price, new_price::float8 AS new_price,
           old_restrictions, new_restrictions
    FROM guesthub.bulk_rate_update_items WHERE log_id = ${logId} ORDER BY date`;
  const storedRows = async () => sql`
    SELECT date::text AS date, price::float8 AS price, min_stay_through
    FROM guesthub.pricing_plan_rates WHERE pricing_plan_id = ${plan.id} ORDER BY date`;
  const lastAudit = async () => (await sql`
    SELECT after_data FROM guesthub.audit_logs
    WHERE tenant_id = ${T} AND action = 'bulk_update' ORDER BY created_at DESC, id DESC LIMIT 1`)[0];

  // ============================================================
  // 1. a min-stay-only run over 3 nights: restrictions recorded, prices untouched,
  //    changed = the 3 affected nights
  // ============================================================
  {
    const res = await actions.bulkUpdateRatesAction({
      sellableUnitIds: [su.id], dateFrom: day(2), dateTo: day(5), minStayThrough: 2,
    });
    assert.equal(res.success, true, `the bulk action succeeds (${JSON.stringify(res)})`);
    assert.equal(res.data?.cells, 3, "3 cells were targeted (3 nights × 1 unit)");
    assert.equal(res.data?.changed, 3,
      "changed = 3: every night's min-stay moved 1 → 2 — a restriction change IS a change (06/09 audited as 0)");
    // D188 — the toast reads N and M straight off this result: both must be
    // numbers on it, and M for a min-stay change is nights × units (3 × 1), not
    // the price-only count (0 here)
    assert.equal(typeof res.data?.cells, "number", "D188: the result carries `cells` — N on the toast");
    assert.equal(typeof res.data?.changed, "number", "D188: the result carries `changed` — M on the toast");
    assert.equal(res.data?.changed, 3 * 1, "D188: M = nights × units (3 × 1) for a min-stay change");
    const log = await latestLog();
    const items = await itemsOf(log.id);
    assert.equal(items.length, 3, "one item per affected night");
    for (const it of items) {
      assert.equal(it.old_restrictions?.min_stay_through, 1, `${it.date}: old min_stay_through = 1 as stored`);
      assert.equal(it.new_restrictions?.min_stay_through, 2, `${it.date}: new min_stay_through = 2`);
      assert.equal(it.old_price, 500, `${it.date}: old_price unchanged (500)`);
      assert.equal(it.new_price, 500, `${it.date}: new_price unchanged (500) — a min-stay run never touches price`);
      for (const k of ["min_stay_arrival", "max_stay", "closed_to_arrival", "closed_to_departure", "stop_sell"]) {
        assert.deepEqual(it.new_restrictions?.[k], it.old_restrictions?.[k], `${it.date}: ${k} is carried over unchanged`);
      }
      assert.deepEqual(Object.keys(it.new_restrictions ?? {}).sort(),
        ["closed_to_arrival", "closed_to_departure", "max_stay", "min_stay_arrival", "min_stay_through", "stop_sell"],
        "new_restrictions carries exactly the six restriction fields");
    }
    const stored = await storedRows();
    assert.deepEqual(stored.map((r) => [r.price, r.min_stay_through]), [[500, 2], [500, 2], [500, 2]],
      "the canonical rows: price still 500, min-stay now 2");
    const audit = await lastAudit();
    assert.equal(audit?.after_data?.changed, 3, "the audit_logs after-summary carries changed = 3");
    assert.equal(audit?.after_data?.cells, 3, "…next to the targeted cell count");
    ok("min-stay-only run: 3 items with min_stay_through 1→2, prices untouched, changed = 3 on result + audit");
  }

  // ============================================================
  // 2. the SAME run again is a no-op: still audited, changed = 0
  // ============================================================
  {
    const res = await actions.bulkUpdateRatesAction({
      sellableUnitIds: [su.id], dateFrom: day(2), dateTo: day(5), minStayThrough: 2,
    });
    assert.equal(res.success, true);
    assert.equal(res.data?.cells, 3, "the no-op run still targets 3 cells");
    assert.equal(res.data?.changed, 0, "changed = 0: nothing differs from what was stored");
    assert.equal(res.data?.cells, 3, "D188: the no-op run still reports N = 3 cells next to M = 0 — the sticky danger toast's numbers");
    const items = await itemsOf((await latestLog()).id);
    assert.equal(items.length, 3, "a no-op run is still audited, one item per night");
    for (const it of items) {
      assert.deepEqual(it.new_restrictions, it.old_restrictions, `${it.date}: restrictions equal before/after`);
      assert.equal(it.new_price, it.old_price, `${it.date}: price equal before/after`);
    }
    ok("no-op run: 3 items, everything equal before/after, changed = 0");
  }

  // ============================================================
  // 3. a price-only run: changed = 3, restrictions equal before/after
  // ============================================================
  {
    const res = await actions.bulkUpdateRatesAction({
      sellableUnitIds: [su.id], dateFrom: day(2), dateTo: day(5), price: { mode: "replace", amount: 600 },
    });
    assert.equal(res.success, true);
    assert.equal(res.data?.changed, 3, "changed = 3: every night's price moved 500 → 600");
    const items = await itemsOf((await latestLog()).id);
    assert.equal(items.length, 3);
    for (const it of items) {
      assert.equal(it.old_price, 500, `${it.date}: old_price 500`);
      assert.equal(it.new_price, 600, `${it.date}: new_price 600`);
      assert.deepEqual(it.new_restrictions, it.old_restrictions, `${it.date}: a price run leaves the restrictions equal`);
      assert.equal(it.new_restrictions?.min_stay_through, 2, `${it.date}: …and they are the stored ones (min-stay 2)`);
    }
    ok("price-only run: prices 500→600, restrictions equal before/after, changed = 3");
  }

  // ============================================================
  // 4. a night with NO stored row: old halves NULL, the write is a change
  // ============================================================
  {
    const res = await actions.bulkUpdateRatesAction({
      sellableUnitIds: [su.id], dateFrom: day(5), dateTo: day(6), minStayThrough: 3,
    });
    assert.equal(res.success, true);
    assert.equal(res.data?.cells, 1);
    assert.equal(res.data?.changed, 1, "creating a restricted row where none existed is a change");
    const [it] = await itemsOf((await latestLog()).id);
    assert.equal(it.old_price, null, "old_price NULL — no row existed");
    assert.equal(it.old_restrictions, null, "old_restrictions NULL — the same meaning as old_price NULL");
    assert.equal(it.new_restrictions?.min_stay_through, 3, "new_restrictions carries the written min-stay");
    ok("no prior row: old_price + old_restrictions NULL, new_restrictions written, changed = 1");
  }

  console.log(`\ncheck-bulk-update-audit: all ${n} assertions passed`);
} finally {
  await sql.end();
  // the compiled @/lib/db holds its own pool — close it, then drop the scratch DB
  try { await req(join(out, "lib/db.js")).sql.end({ timeout: 5 }); } catch { /* best effort */ }
  try { psqlAdmin(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`); } catch { /* best effort */ }
  rmSync(cache, { recursive: true, force: true });
}
