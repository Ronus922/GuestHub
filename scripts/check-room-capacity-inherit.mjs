// ============================================================
// check:room-capacity-inherit — migration 091 (Phase 5 owner decision).
//
// THE RULE: a room's effective max_occupancy / max_adults / max_children /
// max_infants is COALESCE(room.field, room_type.field) — independently per
// column. ZERO IS A REAL VALUE (e.g. max_infants=0 really means "no
// infants") and must NEVER fall back to the room type. Only NULL inherits.
//
// getRoomCapacities() (src/lib/inventory.ts) is the ONE implementation of
// this rule — the pricing engine and the dashboard room picker both call it
// (never read the raw columns themselves), so they cannot disagree. This
// guard compiles and calls that real function directly (Part A), then
// asserts the DB-level contract migration 091 introduced (Part B: nullable
// columns + CHECK constraints, on the ISOLATED test DB — :5433, NEVER prod).
//
// Usage: node scripts/check-room-capacity-inherit.mjs
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

// fail-closed: this script must never run against production
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (TEST_URL.includes(marker)) {
    console.error(`REFUSED: TEST_DATABASE_URL contains production marker "${marker}"`);
    process.exit(1);
  }
}

console.log("applying migration chain to the test DB…");
const migrations = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
for (const f of migrations) {
  execSync(`psql "${TEST_URL}" -v ON_ERROR_STOP=1 -q < "db/migrations/${f}"`,
    { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" });
}

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };

// ============================================================
// Part A — the real getRoomCapacities() implementation, compiled from source
// ============================================================
console.log("compiling src/lib/inventory.ts via tsc…");
const tmp = mkdtempSync(join(tmpdir(), "gh-capacity-"));
const out = join(tmp, "out");
writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    module: "commonjs", moduleResolution: "node10", target: "es2022",
    esModuleInterop: true, skipLibCheck: true, strict: true,
    baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
    rootDir: join(ROOT, "src"), outDir: out,
    typeRoots: [join(ROOT, "node_modules/@types")], types: ["node"],
  },
  include: [join(ROOT, "src/lib/inventory.ts")],
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
const { getRoomCapacities } = req(join(out, "lib/inventory.js"));

const postgres = req("postgres");
const sql = postgres(TEST_URL, { prepare: false, max: 1, onnotice: () => {} });
class Rollback extends Error {}

try {
  await sql.begin(async (tx) => {
    const [t] = await tx`INSERT INTO guesthub.tenants (name, slug) VALUES ('CapTest', ${"cap-check-" + Date.now()}) RETURNING id`;
    const [rt] = await tx`
      INSERT INTO guesthub.room_types (tenant_id, name, max_occupancy, max_adults, max_children, max_infants)
      VALUES (${t.id}, 'Type', 6, 5, 3, 2) RETURNING id`;

    const mkRoom = (fields) => tx`INSERT INTO guesthub.rooms ${tx({
      tenant_id: t.id, room_type_id: rt.id, room_number: `cap-${Math.random()}`, status: "available", is_active: true,
      ...fields,
    })} RETURNING id`;

    const [rExplicit] = await mkRoom({ max_occupancy: 4, max_adults: 3, max_children: 2, max_infants: 1 });
    const [rNull] = await mkRoom({ max_occupancy: null, max_adults: null, max_children: null, max_infants: null });
    const [rZeroInfant] = await mkRoom({ max_occupancy: 4, max_adults: 3, max_children: 2, max_infants: 0 });
    const [rNoType] = await tx`INSERT INTO guesthub.rooms
      (tenant_id, room_type_id, room_number, status, is_active, max_occupancy, max_adults, max_children, max_infants)
      VALUES (${t.id}, NULL, ${"cap-no-type-" + Math.random()}, 'available', true, NULL, NULL, NULL, NULL)
      RETURNING id`;

    const caps = await getRoomCapacities(tx, t.id, [rExplicit.id, rNull.id, rZeroInfant.id, rNoType.id]);

    const capFields = (c) => ({ max_occupancy: c.max_occupancy, max_adults: c.max_adults, max_children: c.max_children, max_infants: c.max_infants });

    assert.deepEqual(capFields(caps.get(rExplicit.id)), { max_occupancy: 4, max_adults: 3, max_children: 2, max_infants: 1 },
      "room value present → room value wins verbatim, room type ignored");
    ok("getRoomCapacities: explicit room value overrides the room type");

    assert.deepEqual(capFields(caps.get(rNull.id)), { max_occupancy: 6, max_adults: 5, max_children: 3, max_infants: 2 },
      "all four columns NULL → every column inherits the room type");
    ok("getRoomCapacities: NULL room capacity inherits the room type, per column");

    assert.equal(caps.get(rZeroInfant.id).max_infants, 0,
      "room max_infants=0 stays 0 — it must NOT inherit the room type's max_infants=2");
    ok("getRoomCapacities: zero is a real value and never inherits");

    assert.deepEqual(capFields(caps.get(rNoType.id)), { max_occupancy: 2, max_adults: 2, max_children: 0, max_infants: 0 },
      "no room value AND no room type → the hardcoded last-resort default");
    ok("getRoomCapacities: hardcoded default when neither the room nor a room type has a value");

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { console.error(e); await sql.end(); process.exit(1); }
}

// ============================================================
// Part B — DB-level contract: nullable + CHECK constraints (migration 091)
// ============================================================
async function expectViolation(tx, code, label, fn) {
  let threw = null;
  try { await tx.savepoint(fn); } catch (e) { threw = e; }
  assert.ok(threw, `${label}: expected DB error`);
  assert.equal(threw.code, code, `${label}: expected ${code}, got ${threw?.code}`);
}

try {
  await sql.begin(async (tx) => {
    const [t] = await tx`INSERT INTO guesthub.tenants (name, slug) VALUES ('CapDB', ${"cap-db-" + Date.now()}) RETURNING id`;
    const [r] = await tx`INSERT INTO guesthub.rooms (tenant_id, room_number, max_occupancy, max_adults, max_children, max_infants)
      VALUES (${t.id}, 'cdb-1', 4, 3, 2, 1) RETURNING id`;

    // NULL is legal and round-trips distinctly from 0
    await tx`UPDATE guesthub.rooms SET max_occupancy=NULL, max_adults=NULL, max_children=NULL, max_infants=NULL WHERE id=${r.id}`;
    const [nulled] = await tx`SELECT max_occupancy, max_adults, max_children, max_infants FROM guesthub.rooms WHERE id=${r.id}`;
    assert.deepEqual(nulled, { max_occupancy: null, max_adults: null, max_children: null, max_infants: null },
      "all four capacity columns accept and persist NULL");
    await tx`UPDATE guesthub.rooms SET max_adults=0, max_children=0, max_infants=0 WHERE id=${r.id}`;
    const [zeroed] = await tx`SELECT max_adults, max_children, max_infants FROM guesthub.rooms WHERE id=${r.id}`;
    assert.deepEqual(zeroed, { max_adults: 0, max_children: 0, max_infants: 0 }, "explicit 0 persists distinctly from NULL");
    ok("rooms.max_* columns: NULL and 0 both persist, and stay distinct from each other");

    // CHECK constraints: NULL is fine, but an out-of-range NUMBER is rejected
    await expectViolation(tx, "23514", "max_occupancy=0", (sp) => sp`UPDATE guesthub.rooms SET max_occupancy=0 WHERE id=${r.id}`);
    await expectViolation(tx, "23514", "max_adults=-1", (sp) => sp`UPDATE guesthub.rooms SET max_adults=-1 WHERE id=${r.id}`);
    await expectViolation(tx, "23514", "max_children=-1", (sp) => sp`UPDATE guesthub.rooms SET max_children=-1 WHERE id=${r.id}`);
    await expectViolation(tx, "23514", "max_infants=-1", (sp) => sp`UPDATE guesthub.rooms SET max_infants=-1 WHERE id=${r.id}`);
    await tx`UPDATE guesthub.rooms SET max_occupancy=NULL WHERE id=${r.id}`; // NULL must NOT trip the CHECK
    ok("rooms_max_*_chk: rejects an out-of-range explicit number, never rejects NULL");

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { console.error(e); await sql.end(); process.exit(1); }
}

await sql.end();
console.log(`\nALL ${n} ROOM-CAPACITY-INHERIT CHECKS PASSED (nothing committed)`);
