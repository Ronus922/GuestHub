#!/usr/bin/env node
// check:db-isolation (Stage 2, V2 §9) — assert a GuestHub database is DEDICATED:
// it must contain only GuestHub data (the guesthub schema) plus Supabase
// infrastructure schemas, and NONE of the unrelated applications that share the
// legacy database (e.g. marketpilot, sea_tower, and foreign tables in public).
//
// Target resolution (read-only, SELECT only):
//   CHECK_DB_URL  explicit DSN, else
//   STAGING_DATABASE_URL (from env / .env.staging)
//
// Run against the dedicated staging (and, after cutover, production) DB. Running
// it against the legacy shared DB is EXPECTED to fail — that is defect C1.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// allow .env.staging to provide STAGING_DATABASE_URL when not already in env
function loadEnvStaging() {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.staging");
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* optional */ }
}
loadEnvStaging();

const url = process.env.CHECK_DB_URL || process.env.STAGING_DATABASE_URL;
if (!url) { console.error("check:db-isolation — need CHECK_DB_URL or STAGING_DATABASE_URL"); process.exit(2); }

// Supabase infrastructure + Postgres system schemas that are legitimately present.
const ALLOWED = new Set([
  "guesthub", "public", "auth", "storage", "realtime", "_realtime", "net",
  "supabase_functions", "supabase_migrations", "extensions", "graphql",
  "graphql_public", "pgbouncer", "vault", "cron", "pgsodium", "pgsodium_masks",
]);
const isSystem = (s) => s.startsWith("pg_") || s === "information_schema";

const q = (sql) => execFileSync("psql", [url, "-tAc", sql, "-X"], { encoding: "utf8" }).trim();

let fail = 0;
const schemas = q(`select nspname from pg_namespace order by 1`).split("\n").map((s) => s.trim()).filter(Boolean);
const foreign = schemas.filter((s) => !isSystem(s) && !ALLOWED.has(s));
if (foreign.length) { fail++; console.log(`✗ foreign application schema(s) present: ${foreign.join(", ")}`); }
else console.log("✓ no foreign application schemas");

// public must not host foreign application tables (GuestHub keeps everything in guesthub)
const publicTables = parseInt(q(`select count(*) from pg_tables where schemaname='public'`) || "0", 10);
if (publicTables > 0) {
  const names = q(`select string_agg(tablename, ', ') from pg_tables where schemaname='public'`);
  fail++; console.log(`✗ public schema has ${publicTables} table(s) (foreign to GuestHub): ${names}`);
} else console.log("✓ public schema has no foreign tables");

// guesthub schema must be present and complete
const ghTables = parseInt(q(`select count(*) from pg_tables where schemaname='guesthub'`) || "0", 10);
if (ghTables < 60) { fail++; console.log(`✗ guesthub schema has only ${ghTables} tables (expected >= 60)`); }
else console.log(`✓ guesthub schema present (${ghTables} tables)`);

// the migration ledger must exist (H5)
const hasLedger = q(`select count(*) from pg_tables where schemaname='guesthub' and tablename='schema_migrations'`);
if (hasLedger !== "1") { fail++; console.log("✗ guesthub.schema_migrations ledger missing"); }
else console.log("✓ migration ledger present");

console.log(fail ? `\ncheck:db-isolation FAILED (${fail})` : "\ncheck:db-isolation PASSED — database is dedicated to GuestHub");
process.exit(fail ? 1 : 0);
