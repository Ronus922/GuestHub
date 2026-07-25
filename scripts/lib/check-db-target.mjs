// ============================================================
// Shared STAGING target resolver for DB-backed check:* guards.
//
// WHY THIS EXISTS
// Nine guards were wired as `node --env-file=.env.local scripts/…` and read
// `process.env.DATABASE_URL` — i.e. they ran against PRODUCTION. Four of them
// (inventory, effective-state, rate-grid, sellability) are pure code+schema
// integrity guards whose every write happens inside a rolled-back transaction:
// they need A database with the GuestHub schema, never the live one. Pointing
// an automated guard at production data is forbidden (program charter §safety),
// and it also made the guards unrunnable in any worktree/CI without a
// production .env.local — the guard exited 9 (`node: .env.local: not found`)
// before reaching a single assertion, so it was RED whether the system was
// healthy or broken. A guard with the same output in both states carries zero
// signal.
//
// TARGET RESOLUTION (same idiom as scripts/check-db-isolation.mjs and
// scripts/check-pms-domain-invariants.mjs, which already did this correctly):
//   CHECK_DB_URL          explicit DSN, else
//   STAGING_DATABASE_URL  from the environment or from .env.staging
//
// `DATABASE_URL` is DELIBERATELY NOT CONSULTED. That is the whole point: a
// stray `--env-file=.env.local` can no longer aim one of these guards at the
// production database — the production DSN arrives in DATABASE_URL and is
// ignored. Do not "helpfully" add it as a fallback.
// ============================================================
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// .env.staging is gitignored and holds STAGING_DATABASE_URL. Real environment
// variables always win; this only fills gaps.
export function loadEnvStaging() {
  try {
    for (const line of readFileSync(join(REPO_ROOT, ".env.staging"), "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* optional — CHECK_DB_URL / STAGING_DATABASE_URL may come from the environment */
  }
}

// host:port/database only — credentials are never printed (secrets policy).
export function redactDsn(dsn) {
  try {
    const u = new URL(dsn);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "<unparseable DSN>";
  }
}

// Resolve the DSN a DB-backed guard must run against, or exit 2 (= "cannot
// run") with an actionable message. Prints the redacted target so every run is
// auditable: you can always see which database a green tick came from.
export function resolveCheckDbUrl(checkName) {
  loadEnvStaging();
  const url = process.env.CHECK_DB_URL || process.env.STAGING_DATABASE_URL;
  if (!url) {
    console.error(
      `${checkName}: no target database.\n` +
        `  set CHECK_DB_URL=<dsn>, or provide STAGING_DATABASE_URL (env or .env.staging).\n` +
        `  DATABASE_URL is intentionally ignored — these guards never run against production.`,
    );
    process.exit(2);
  }
  console.log(`${checkName}: target ${redactDsn(url)}`);
  return url;
}
