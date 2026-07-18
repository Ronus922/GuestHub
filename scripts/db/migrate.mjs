#!/usr/bin/env node
// GuestHub migration runner + ledger (Stage 2, defect H5).
//
// Deterministic replay-from-zero and drift-free tracking of db/migrations/*.sql.
// Order comes from db/migrations/manifest.txt (resolves the duplicate 009 prefix).
// Each applied migration is recorded in guesthub.schema_migrations with a sha256
// checksum, so re-runs are idempotent and tampering is detectable.
//
// SAFETY (V2 §3): the target is taken ONLY from MIGRATE_DATABASE_URL (never the
// app's DATABASE_URL), its identity is printed, and the runner REFUSES to touch
// the shared production database (any host-local :5432). Destructive replay runs
// only against the disposable/staging databases.
//
// Usage:
//   MIGRATE_DATABASE_URL=postgres://user:pw@127.0.0.1:5433/dbname \
//     node scripts/db/migrate.mjs [--status | --baseline | --apply]
//     --status    show applied vs pending (read-only)
//     --baseline  record every manifest migration as applied WITHOUT running it
//                 (for adopting an already-populated DB, e.g. after a data copy)
//     --apply     (default) apply pending migrations in manifest order
//   Add --allow-5432 ONLY for a genuine dedicated cluster that happens to use
//   5432 on a NON-production host (never for this host's shared pooler).
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIG_DIR = join(ROOT, "db", "migrations");
const LEDGER = "guesthub.schema_migrations";

const url = process.env.MIGRATE_DATABASE_URL;
if (!url) { console.error("ABORT: MIGRATE_DATABASE_URL is required (refusing to guess a target)."); process.exit(2); }

const mode = process.argv.includes("--status") ? "status"
  : process.argv.includes("--baseline") ? "baseline" : "apply";
const allow5432 = process.argv.includes("--allow-5432");

// --- resolve + print identity, fail-closed against the shared production DB ---
let u;
try { u = new URL(url); } catch { console.error("ABORT: MIGRATE_DATABASE_URL is not a valid URL"); process.exit(2); }
const host = u.hostname, port = u.port || "5432", db = u.pathname.replace(/^\//, "") || "postgres";
console.log(`Target database: host=${host} port=${port} db=${db} user=${u.username} (password hidden)`);
const isLocal = ["localhost", "127.0.0.1", "::1"].includes(host);
if (isLocal && port === "5432" && !allow5432) {
  console.error("ABORT: refusing to run against a host-local :5432 — that is the SHARED PRODUCTION pooler (V2 §3).");
  console.error("       Use the disposable (:5433) or a dedicated staging DB, or pass --allow-5432 for a verified non-prod cluster.");
  process.exit(2);
}

const psql = (args, input) => execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-X", ...args],
  { input, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
const scalar = (s) => psql(["-tAc", s]).trim();

// --- ordered manifest ---
const manifest = readFileSync(join(MIG_DIR, "manifest.txt"), "utf8")
  .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const onDisk = new Set(readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")));
for (const m of manifest) if (!onDisk.has(m)) { console.error(`ABORT: manifest lists ${m} which is not on disk`); process.exit(2); }
const listed = new Set(manifest);
for (const f of onDisk) if (!listed.has(f)) { console.error(`ABORT: ${f} is on disk but missing from manifest.txt`); process.exit(2); }

const sha = (f) => createHash("sha256").update(readFileSync(join(MIG_DIR, f))).digest("hex");

// --- bootstrap ledger (idempotent; runner infrastructure, safe on fresh + existing DBs) ---
psql(["-c", `CREATE SCHEMA IF NOT EXISTS guesthub;
CREATE TABLE IF NOT EXISTS ${LEDGER} (
  version     text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text NOT NULL DEFAULT current_user
);
COMMENT ON TABLE ${LEDGER} IS 'GuestHub migration ledger (H5): one row per applied db/migrations file, in manifest order, with sha256 checksum.';`]);

const appliedRows = psql(["-tAc", `SELECT version || '\t' || checksum FROM ${LEDGER}`])
  .split("\n").map((l) => l.trim()).filter(Boolean);
const applied = new Map(appliedRows.map((l) => l.split("\t")));

// checksum drift detection
for (const [v, cs] of applied) if (listed.has(v) && cs !== sha(v))
  console.warn(`WARN: checksum drift for ${v} (ledger ${cs.slice(0,12)} != disk ${sha(v).slice(0,12)}) — file changed after apply`);

const pending = manifest.filter((m) => !applied.has(m));

if (mode === "status") {
  console.log(`\nApplied: ${applied.size}/${manifest.length}`);
  for (const m of manifest) console.log(`  ${applied.has(m) ? "✓" : "·"} ${m}`);
  if (pending.length) console.log(`\nPending (${pending.length}): ${pending.join(", ")}`);
  else console.log("\nUp to date.");
  process.exit(0);
}

if (mode === "baseline") {
  for (const m of pending) {
    psql(["-c", `INSERT INTO ${LEDGER}(version, checksum) VALUES ('${m}','${sha(m)}') ON CONFLICT (version) DO NOTHING`]);
    console.log(`baselined ${m}`);
  }
  console.log(`\nBaseline complete: ${manifest.length} migrations recorded as applied (nothing executed).`);
  process.exit(0);
}

// --- apply ---
if (!pending.length) { console.log("Up to date — nothing to apply."); process.exit(0); }
console.log(`\nApplying ${pending.length} migration(s) to ${db}...`);
for (const m of pending) {
  const file = join(MIG_DIR, m);
  // -f and -c run inside ONE --single-transaction: the migration and its ledger
  // row commit together, or neither does.
  psql(["--single-transaction", "-f", file,
        "-c", `INSERT INTO ${LEDGER}(version, checksum) VALUES ('${m}','${sha(m)}')`]);
  console.log(`  ✓ ${m}`);
}
console.log(`\nDone: ${pending.length} applied, ${manifest.length} total.`);
