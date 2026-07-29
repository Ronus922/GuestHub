#!/usr/bin/env node
// ============================================================
// Apply pending DB migrations — the deploy script's schema step.
//
// Incident (2026-07-28, ca11f15): deploy:prod built and restarted with
// migration 062 unapplied; production wrote to missing columns for ~3 minutes
// and the script printed "✓ DEPLOYED" for an incomplete release. A release is
// code + schema, atomically: this runner executes BEFORE the pm2 restart, and
// any failure aborts the whole deploy.
//
// "Pending" = a file in db/migrations/ with no row in
// guesthub.schema_migrations (the ledger, migration 064 — backfilled with
// everything production already carried). Every migration in this repo is
// individually idempotent, so re-applying one file is always safe; only a
// whole-chain replay over a live schema is not, and this runner never does
// that. A file is RECORDED only after it applied cleanly, so a failure leaves
// it pending and the next deploy retries it.
//
// DB path: the same canonical route db:migrate uses —
//   docker exec -i supabase-db psql -U supabase_admin -d postgres
// (the app role cannot ALTER; supabase_admin owns the schema).
// Overrides, for the guard's isolated runs only:
//   MIGRATE_PSQL_URL       psql connection URL instead of the docker route
//   MIGRATIONS_DIR         directory of *.sql files (default db/migrations)
// MIGRATE_PSQL_URL refuses production markers — the override exists for test
// databases, never as a second route to production.
//
// Exit 0: everything applied (or nothing pending — said explicitly).
// Exit non-zero: a migration failed; its psql output is printed verbatim and
// NOTHING later is applied or recorded.
// ============================================================
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = process.env.MIGRATIONS_DIR || "db/migrations";
const URL = process.env.MIGRATE_PSQL_URL || null;
if (URL) {
  for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
    if (URL.includes(marker)) {
      console.error(`REFUSED: MIGRATE_PSQL_URL contains production marker "${marker}" — production goes through the canonical docker route`);
      process.exit(1);
    }
  }
}

// psql through the canonical route; returns stdout, throws with verbatim
// output on failure. `file` mode streams the .sql via stdin (docker exec -i).
function psql(args, { input } = {}) {
  const cmd = URL
    ? ["psql", [URL, "-v", "ON_ERROR_STOP=1", ...args]]
    : ["docker", ["exec", "-i", "supabase-db", "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", ...args]];
  return execFileSync(cmd[0], cmd[1], { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
}

const LEDGER = "guesthub.schema_migrations";
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
if (files.length === 0) {
  console.error(`✗ no migration files found under ${DIR} — refusing to guess`);
  process.exit(1);
}

// Bootstrap: until the ledger exists, only the ledger migration itself may
// run (it backfills what production already carries). Anything else pending
// is discovered on the SAME run, right after.
const ledgerExists = () =>
  psql(["-tA", "-c", "SELECT to_regclass('guesthub.schema_migrations') IS NOT NULL"]).trim() === "t";

function applyOne(file) {
  const started = Date.now();
  let out;
  try {
    out = psql(["-f", "-"], { input: readFileSync(join(DIR, file), "utf8") });
  } catch (e) {
    // verbatim, then abort — nothing later applies, nothing gets recorded
    console.error(`✗ migration FAILED: ${file}`);
    if (e.stdout) process.stderr.write(String(e.stdout));
    if (e.stderr) process.stderr.write(String(e.stderr));
    process.exit(1);
  }
  if (out.trim()) process.stdout.write(out);
  psql(["-c", `INSERT INTO ${LEDGER} (filename) VALUES ('${file.replaceAll("'", "''")}') ON CONFLICT (filename) DO NOTHING`]);
  console.log(`  ✓ applied ${file} (${Date.now() - started}ms)`);
}

if (!ledgerExists()) {
  const ledgerFile = files.find((f) => /schema_migrations/.test(f));
  if (!ledgerFile) {
    console.error("✗ guesthub.schema_migrations is absent and no *schema_migrations*.sql migration exists to create it");
    process.exit(1);
  }
  console.log(`→ ledger absent — bootstrapping via ${ledgerFile}`);
  applyOne(ledgerFile);
}

const appliedRows = psql(["-tA", "-c", `SELECT filename FROM ${LEDGER}`])
  .split("\n").map((s) => s.trim()).filter(Boolean);
const applied = new Set(appliedRows);
const pending = files.filter((f) => !applied.has(f));

if (pending.length === 0) {
  // explicit, never a silent skip — the operator must see the schema verdict
  console.log(`→ no pending migrations — schema is current (${files.length} files, all recorded)`);
  process.exit(0);
}

console.log(`→ ${pending.length} pending migration(s): ${pending.join(", ")}`);
for (const f of pending) applyOne(f);
console.log(`✓ migrations complete — ${pending.length} applied, schema is current`);
