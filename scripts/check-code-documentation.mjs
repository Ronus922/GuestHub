#!/usr/bin/env node
// check:code-documentation (Stage 7, V2 §22) — the canonical modules, seams and
// migrations carry a purpose comment explaining WHAT they own and WHY, so the
// architecture is legible without reverse-engineering. This checks presence +
// substance of documentation on the load-bearing files, not every line.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };
let fail = 0;
const flag = (m) => { fail++; console.log(`✗ ${m}`); };
const pass = (m) => console.log(`✓ ${m}`);

// a "documented header" = a comment block in the first ~40 lines totaling ≥120
// chars of prose (not just a one-word banner).
function hasHeaderDoc(src) {
  // window covers a doc block that follows the import section (common pattern)
  const head = src.split("\n").slice(0, 70).join("\n");
  const comments = (head.match(/\/\/[^\n]*/g) || []).join(" ") + (head.match(/\/\*[\s\S]*?\*\//g) || []).join(" ");
  return comments.replace(/[/*]/g, "").trim().length >= 120;
}

// canonical / load-bearing modules that MUST explain themselves
const CRITICAL = [
  "src/lib/channel/config.ts",
  "src/lib/channel/production-guard.ts",
  "src/lib/channel/circuit-breaker.ts",
  "src/lib/channel/evidence.ts",
  "src/lib/channel/ari-sync.ts",
  "src/lib/channel/ari-payloads.ts",
  "src/lib/channel/booking-import.ts",
  "src/lib/rates/service.ts",
  "src/lib/payments/ledger.ts",
  "src/lib/payments/mutations.ts",
  "src/lib/housekeeping/actions.ts",
  "src/lib/israel-market/actions.ts",
  "src/lib/israel-market/invoice.ts",
  "src/lib/reports/queries.ts",
  "src/lib/reports/csv.ts",
  "src/lib/inventory-rules.ts",
  "src/lib/dates.ts",
];
let undoc = [];
for (const f of CRITICAL) {
  if (!existsSync(join(root, f))) { flag(`critical module missing: ${f}`); continue; }
  if (!hasHeaderDoc(read(f))) undoc.push(f);
}
if (undoc.length) flag(`critical modules lack a substantive header doc: ${undoc.join(", ")}`);
else pass(`all ${CRITICAL.length} canonical modules carry a substantive purpose header`);

// every migration must have a header comment explaining its intent
const migs = readdirSync(join(root, "db/migrations")).filter((f) => /^\d+_.*\.sql$/.test(f));
const undocMigs = migs.filter((f) => {
  const head = read(`db/migrations/${f}`).split("\n").slice(0, 15).join("\n");
  return (head.match(/^--/gm) || []).length < 3; // at least a few comment lines
});
if (undocMigs.length) flag(`migrations lacking a header comment: ${undocMigs.join(", ")}`);
else pass(`all ${migs.length} migrations carry a header comment`);

// the agent-guidance + decision docs exist and are non-trivial
for (const doc of ["CLAUDE.md", "docs/program/STATE.md"]) {
  if (read(doc).length < 400) flag(`${doc} missing or too thin`);
}
if (!fail) pass("agent-guidance + program-state docs present");

// the Stage-7 canonical docs exist
for (const doc of ["docs/architecture/TARGET_ARCHITECTURE.md", "docs/security/THREAT_MODEL.md",
  "docs/channex/CERTIFICATION_SCENARIO_MATRIX.md", "docs/audit/PMS_CAPABILITY_MATRIX.md"]) {
  if (!existsSync(join(root, doc))) flag(`canonical doc missing: ${doc}`);
}
if (!fail) pass("canonical architecture/security/channex/capability docs present");

if (fail) { console.log(`\ncheck:code-documentation — FAIL (${fail})`); process.exit(1); }
console.log("check:code-documentation — PASS");
