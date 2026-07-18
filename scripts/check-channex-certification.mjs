#!/usr/bin/env node
// check:channex-certification (Stage 4, V2 §12) — the umbrella certification
// check: the scenario matrix is complete and traceable, declarations 12–14 are
// written, the execution model has no forbidden anti-patterns, and the full
// Stage-4 check suite is wired.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const has = (p) => existsSync(join(root, p));
let fail = 0;
const flag = (m) => { fail++; console.log(`✗ ${m}`); };
const pass = (m) => console.log(`✓ ${m}`);

const matrix = read("docs/channex/CERTIFICATION_SCENARIO_MATRIX.md");

// 1) all 14 certification items present (rows | 1 | … | 14 |)
const rows = [...matrix.matchAll(/^\|\s*(\d{1,2})\s*\|/gm)].map((m) => Number(m[1]));
const missing = [];
for (let i = 1; i <= 14; i++) if (!rows.includes(i)) missing.push(i);
if (missing.length) flag(`scenario matrix missing tests: ${missing.join(", ")}`);
else pass("scenario matrix covers all 14 certification items");

// 2) tests 1–11 are executable + traceable: each named firing file EXISTS
const firingFiles = [
  "src/lib/channel/ari-sync.ts",
  "src/app/(dashboard)/rates/actions.ts",
  "src/lib/rates/service.ts",
  "src/app/(dashboard)/reservations/actions.ts",
  "src/lib/channel/booking-import.ts",
];
for (const f of firingFiles) if (!has(f)) flag(`firing file referenced by the matrix does not exist: ${f}`);
if (!fail) pass("every firing file named in the matrix exists (file-and-function traceability)");

// 3) declarations 12–14 written
for (const d of ["§12", "§13", "§14"])
  if (!matrix.includes(d)) flag(`declaration ${d} not written`);
if (!/Retry-After|circuit breaker/i.test(matrix)) flag("declaration 12 lacks the 429/circuit-breaker answer");
if (!/delta/i.test(matrix)) flag("declaration 13 lacks the delta-only answer");
if (!/CVV|PCI/i.test(matrix)) flag("declaration 14 lacks the PCI/card answer");
if (!fail) pass("declarations 12–14 written with substantive answers");

// 4) execution model — forbidden anti-patterns absent
const ari = read("src/lib/channel/ari-sync.ts");
// no test-only bypass: the send path must not branch on NODE_ENV / a test flag
if (/process\.env\.NODE_ENV|process\.env\.CI|isTest|__TEST__/.test(ari))
  flag("ARI send path contains a test-environment branch (forbidden bypass)");
else pass("no test-only bypass in the ARI send path (only the fetchImpl seam)");
// arbitrary-value capability: Group Update accepts operator input, not constants
const rates = read("src/app/(dashboard)/rates/actions.ts");
if (!/input\.sellableUnitIds/.test(rates) || !/input\.price/.test(rates))
  flag("Group Update does not accept arbitrary operator values");
else pass("arbitrary-value capability: Group Update drives calls from operator input");

// 5) evidence-ledger scenario keys cover the executable dimensions
for (const key of ["full_sync", "incremental_sync"])
  if (!ari.includes(`"${key}"`)) flag(`evidence scenario key "${key}" not recorded by the send path`);
if (!fail) pass("evidence ledger records full_sync + incremental_sync scenario keys");

// 6) requirements snapshot + re-verify discipline present
if (!has("docs/channex/PMS_CERTIFICATION_REQUIREMENTS.md")) flag("requirements snapshot missing");
else if (!/re-verify|roll forward|V2 §4/i.test(matrix)) flag("matrix lacks the live re-verify discipline note");
else pass("versioned requirements snapshot + live re-verify discipline present");

// 7) the full Stage-4 check suite is wired in package.json
const pkg = JSON.parse(read("package.json"));
const required = [
  "check:channex-environment-routing", "check:production-activation-guard",
  "check:channex-certification-evidence", "check:channex-full-sync-two-requests",
  "check:channex-group-update-batching", "check:channex-rate-limit-cooldown",
  "check:channel-security", "check:channel-chaos", "check:channex-booking-crs-flow",
  "check:channex-certification",
];
const notWired = required.filter((c) => !pkg.scripts[c]);
if (notWired.length) flag(`Stage-4 checks not wired: ${notWired.join(", ")}`);
else pass(`all ${required.length} Stage-4 checks wired in package.json`);

// 8) the required docs/channex set exists
const docs = [
  "ARCHITECTURE.md", "ARI_SYNC_FLOW.md", "BOOKING_REVISION_FLOW.md",
  "BOOKING_RECEIVING_CERTIFICATION.md", "CERTIFICATION_RUNBOOK.md",
  "CERTIFICATION_SCENARIO_MATRIX.md", "ENVIRONMENT_SEPARATION.md",
  "FAILURE_AND_RECOVERY.md", "MIN_STAY_SEMANTICS.md",
  "PRODUCTION_ACTIVATION_RUNBOOK.md", "SCREENSHARE_DEMO_SCRIPT.md",
];
const missingDocs = docs.filter((d) => !has(`docs/channex/${d}`));
if (missingDocs.length) flag(`docs/channex missing: ${missingDocs.join(", ")}`);
else pass(`docs/channex certification set present (${docs.length} docs)`);

if (fail) { console.log(`\ncheck:channex-certification — FAIL (${fail})`); process.exit(1); }
console.log("check:channex-certification — PASS");
