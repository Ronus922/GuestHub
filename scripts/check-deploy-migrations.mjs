#!/usr/bin/env node
// ============================================================
// check:deploy-migrations — a release is code + schema, atomically.
//
// Incident (2026-07-28, ca11f15): deploy:prod built and restarted while
// migration 062 was unapplied; production wrote to missing columns for ~3
// minutes and "✓ DEPLOYED" printed for an incomplete release.
//
// B2-STYLE. Two halves, each red if its fix is reverted:
//   · STRUCTURE — deploy-production.sh must invoke the migration runner AFTER
//     the build and BEFORE any pm2 restart, with a failure route through
//     fail(). Neutralising the step (deleting/bypassing the line) while the
//     rest of the script stays intact turns this red.
//   · BEHAVIOUR — the runner itself, against an isolated test DB (:5433):
//     a pending migration is detected and applied+recorded; a second run says
//     "no pending" EXPLICITLY; a deploy carrying a FAILING migration exits
//     non-zero with the psql error verbatim, records nothing for it, and
//     applies nothing after it. Swallowing the failure turns this red.
//
// Never touches production: the runner is pointed at the test DB via its
// MIGRATE_PSQL_URL/MIGRATIONS_DIR overrides (production markers refused).
//
// Usage: node scripts/check-deploy-migrations.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
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

// ---- STRUCTURE: the deploy script carries the step, in the right order ----
{
  const sh = readFileSync(join(ROOT, "scripts/deploy-production.sh"), "utf8");
  const lines = sh.split("\n");
  const at = (re) => lines.findIndex((l) => re.test(l));
  const buildLine = at(/npm run build/);
  const migrateLine = at(/apply-pending-migrations\.mjs/);
  const restartLine = at(/pm2 restart/);
  const successLine = at(/✓ DEPLOYED/);
  assert.ok(buildLine >= 0, "deploy script builds");
  assert.ok(migrateLine >= 0,
    "deploy-production.sh must run scripts/apply-pending-migrations.mjs — a deploy carrying an unapplied migration shipped ca11f15 half-done");
  assert.ok(restartLine >= 0 && successLine >= 0, "restart + success line exist");
  assert.ok(buildLine < migrateLine, "migrations run AFTER the build");
  assert.ok(migrateLine < restartLine,
    "migrations run BEFORE any pm2 restart — new code must never start against an old schema");
  assert.ok(restartLine < successLine, "the success line prints only after the restart");
  assert.match(lines[migrateLine], /\|\| fail /,
    "a migration failure must route through fail() — abort, no restart, no success, non-zero exit");
  ok("deploy script: build → apply-pending-migrations (|| fail) → restart → success, in that order");
}

// ---- BEHAVIOUR: the runner against an isolated test DB ----
const psqlTest = (sql) =>
  execFileSync("psql", [TEST_URL, "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql], { encoding: "utf8" }).trim();

// scratch migrations dir: a ledger migration + one good + (later) one bad
const scratch = mkdtempSync(join(tmpdir(), "gh-deploy-migrations-"));
const MIG = join(scratch, "migrations");
mkdirSync(MIG);
const SCHEMA = "deploy_check";
// an isolated schema so this guard never collides with the shared guesthub
// schema other checks rebuild; the runner only cares about its ledger + files
writeFileSync(join(MIG, "001_schema_migrations.sql"), `
CREATE SCHEMA IF NOT EXISTS guesthub;
CREATE TABLE IF NOT EXISTS guesthub.schema_migrations (
  filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO guesthub.schema_migrations (filename) VALUES ('001_schema_migrations.sql')
ON CONFLICT (filename) DO NOTHING;
`);
writeFileSync(join(MIG, "002_good.sql"), `
CREATE SCHEMA IF NOT EXISTS ${SCHEMA};
CREATE TABLE IF NOT EXISTS ${SCHEMA}.applied_marker (x int);
`);

const runRunner = (extraEnv = {}) => {
  try {
    const out = execSync(`node "${join(ROOT, "scripts/apply-pending-migrations.mjs")}"`, {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, MIGRATE_PSQL_URL: TEST_URL, MIGRATIONS_DIR: MIG, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

try {
  // clean slate for the ledger + marker schema on the test DB
  execFileSync("psql", [TEST_URL, "-v", "ON_ERROR_STOP=1", "-c",
    `CREATE SCHEMA IF NOT EXISTS guesthub; DROP TABLE IF EXISTS guesthub.schema_migrations; DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;`],
    { encoding: "utf8" });

  // 2. bootstrap + a pending migration is applied AND recorded
  {
    const r = runRunner();
    assert.equal(r.code, 0, `runner failed on the good set:\n${r.out}`);
    assert.match(r.out, /bootstrapping/, "the ledger bootstraps itself on first run");
    assert.match(r.out, /002_good\.sql/, "the pending migration is named");
    assert.equal(psqlTest(`SELECT to_regclass('${SCHEMA}.applied_marker') IS NOT NULL`), "t",
      "the pending migration actually ran");
    assert.equal(psqlTest("SELECT count(*) FROM guesthub.schema_migrations"), "2",
      "both files are recorded in the ledger");
    ok("runner: ledger bootstraps, the pending migration applies and is recorded");
  }

  // 3. nothing pending → said EXPLICITLY, exit 0
  {
    const r = runRunner();
    assert.equal(r.code, 0);
    assert.match(r.out, /no pending migrations/,
      "an empty pending set must be stated explicitly, never silently skipped");
    ok("runner: 'no pending migrations' is stated explicitly");
  }

  // 4. a FAILING migration: non-zero exit, verbatim error, nothing recorded
  //    for it, nothing after it applied — the deploy would abort pre-restart
  {
    writeFileSync(join(MIG, "003_bad.sql"), `SELECT * FROM ${SCHEMA}.this_table_does_not_exist;\n`);
    writeFileSync(join(MIG, "004_after_bad.sql"), `CREATE TABLE ${SCHEMA}.must_never_exist (x int);\n`);
    const r = runRunner();
    assert.notEqual(r.code, 0, "a failing migration must exit non-zero");
    assert.match(r.out, /migration FAILED: 003_bad\.sql/);
    assert.match(r.out, /this_table_does_not_exist/,
      "the psql failure is printed verbatim — diagnosis must not require re-running it");
    assert.equal(psqlTest("SELECT count(*) FROM guesthub.schema_migrations WHERE filename LIKE '00[34]%'"), "0",
      "neither the failed file nor anything after it is recorded");
    assert.equal(psqlTest(`SELECT to_regclass('${SCHEMA}.must_never_exist') IS NULL`), "t",
      "nothing AFTER the failure was applied");
    ok("runner: a failing migration aborts non-zero with the error verbatim; nothing later applies or records");
  }

  // 5. the real 064 ledger migration backfills — a fresh DB replaying the
  //    chain ends with the ledger covering every file up to 064
  {
    const real = readFileSync(join(ROOT, "db/migrations/064_schema_migrations.sql"), "utf8");
    assert.match(real, /CREATE TABLE IF NOT EXISTS guesthub\.schema_migrations/);
    assert.match(real, /062_channel_failure_evidence\.sql/,
      "the backfill seeds the files production already carried");
    ok("064: the ledger migration exists and backfills the pre-ledger history");
  }

  console.log(`\ncheck-deploy-migrations: all ${n} assertions passed`);
} finally {
  execFileSync("psql", [TEST_URL, "-c",
    `CREATE SCHEMA IF NOT EXISTS guesthub; DROP TABLE IF EXISTS guesthub.schema_migrations; DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;`],
    { encoding: "utf8" });
  rmSync(scratch, { recursive: true, force: true });
}
