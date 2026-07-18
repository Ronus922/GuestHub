#!/usr/bin/env node
// check:channex-certification-evidence (Stage 4, V2 §13, defects H9/H10) —
// the evidence ledger captures Task IDs for EVERY scenario (never discards
// incremental ones), and the certification console is strictly read-only.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let fail = 0;
const flag = (m) => { fail++; console.log(`✗ ${m}`); };
const pass = (m) => console.log(`✓ ${m}`);

// 1) migration present + in manifest
const manifest = read("db/migrations/manifest.txt");
if (!manifest.includes("038_channel_evidence_ledger.sql")) flag("038 not in manifest");
else pass("evidence-ledger migration in manifest");
const mig = read("db/migrations/038_channel_evidence_ledger.sql");
for (const col of ["scenario_key", "task_ids", "firing_file", "firing_function", "request_count", "expected_requests", "outcome"])
  if (!mig.includes(col)) flag(`migration 038 missing column ${col}`);
if (!fail) pass("ledger schema defines scenario/task/traceability/outcome columns");

// 2) evidence.ts is the single writer + a read-only reader
const evidence = read("src/lib/channel/evidence.ts");
if (!/INSERT INTO guesthub\.channel_evidence_ledger/.test(evidence))
  flag("recordAriEvidence does not INSERT into the ledger");
else pass("recordAriEvidence is the ledger writer");
if (/\b(UPDATE|DELETE)\s+.*channel_evidence_ledger/i.test(evidence))
  flag("evidence.ts mutates existing ledger rows (must be append-only)");
else pass("evidence module is append-only (no UPDATE/DELETE)");

// 3) H9/H10 — incremental Task IDs are captured, not discarded
const ari = read("src/lib/channel/ari-sync.ts");
if (!/scenarioKey:\s*"full_sync"/.test(ari)) flag("full sync records no evidence");
else pass("full sync records evidence");
if (!/scenarioKey:\s*"incremental_sync"/.test(ari)) flag("incremental drain records no evidence");
else pass("incremental drain records evidence");
// the incremental path must gather the outcomes' taskIds (previously discarded)
if (!/outcomes\.flatMap\(\(o\) => o\.taskIds\)/.test(ari))
  flag("drainAriDirtyRanges does not capture incremental Task IDs (H9/H10 regression)");
else pass("incremental Task IDs captured from outcomes (H9/H10 fixed)");

// 4) certification console is strictly read-only — no scenario triggers
const cert = read("src/lib/channel/certification.ts");
const forbidden = [
  "pushAri", "runInitialFullSync", "drainAriDirtyRanges", "enqueueChannelJob",
  "requestFullSync", "createChannexProperty", "startChannex", "recordAriEvidence",
];
const leaked = forbidden.filter((s) => cert.includes(s));
if (leaked.length) flag(`certification console imports scenario-triggering symbols: ${leaked.join(", ")}`);
else pass("certification console triggers no scenario");
if (/\b(INSERT|UPDATE|DELETE)\b/i.test(cert.replace(/\/\/[^\n]*/g, "")))
  flag("certification console contains a write statement (must be read-only)");
else pass("certification console is read-only (SELECT via loadEvidenceLedger)");

// 5) staging structural check (optional — runs when the readonly DSN is present)
function loadEnvStaging() {
  try {
    for (const line of read(".env.staging").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* optional */ }
}
loadEnvStaging();
const dsn = process.env.CHECK_DB_URL || process.env.STAGING_READONLY_URL || process.env.STAGING_APP_URL;
if (dsn && existsSync("/usr/bin/psql")) {
  const q = (s) => execFileSync("psql", [dsn, "-tAc", s, "-X"], { encoding: "utf8" }).trim();
  const cols = q(`SELECT string_agg(column_name, ',' ORDER BY column_name)
                  FROM information_schema.columns
                  WHERE table_schema='guesthub' AND table_name='channel_evidence_ledger'`);
  for (const need of ["task_ids", "scenario_key", "outcome", "firing_function"])
    if (!cols.split(",").includes(need)) flag(`staging ledger table missing column ${need}`);
  const idx = q(`SELECT count(*)::int FROM pg_indexes
                 WHERE schemaname='guesthub' AND tablename='channel_evidence_ledger'
                   AND indexname='idx_evidence_has_tasks'`);
  if (idx !== "1") flag("staging ledger missing idx_evidence_has_tasks");
  if (!fail) pass("staging ledger table + task-id index present");
} else {
  console.log("• staging DSN not available — structural check skipped (static assertions still enforced)");
}

if (fail) { console.log(`\ncheck:channex-certification-evidence — FAIL (${fail})`); process.exit(1); }
console.log("check:channex-certification-evidence — PASS");
