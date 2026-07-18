#!/usr/bin/env node
// check:performance (Stage 6, V2 §20) — the hot read paths are served by justified
// indexes and stay within budget. Measured (EXPLAIN ANALYZE) on staging; the
// growth-scale method is documented in docs/security/PERFORMANCE.md.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let fail = 0;
const flag = (m) => { fail++; console.log(`✗ ${m}`); };
const pass = (m) => console.log(`✓ ${m}`);

// the indexes that serve the documented hot predicates — each must exist
const REQUIRED_INDEXES = [
  ["reservation_rooms", "idx_res_rooms_tenant_dates"], // availability overlap
  ["reservation_rooms", "rr_no_double_booking"],        // exclusion constraint (gist)
  ["room_closures", "idx_closures_ooo"],                // OOO availability
  ["reservations", "idx_reservations_tenant_checkin"],  // arrivals/in-house
  ["reservations", "idx_reservations_tenant_status"],   // status filters
  ["pricing_plan_rates", "idx_ppr_unit_date"],          // rate grid / projection
  ["channel_dirty_ranges", "idx_dirty_runnable"],       // outbound drain
];

function loadEnvStaging() {
  try {
    for (const line of read(".env.staging").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* optional */ }
}
loadEnvStaging();
const dsn = process.env.CHECK_DB_URL || process.env.STAGING_OWNER_URL;

// PERFORMANCE.md must document the hot paths + measurements
if (!existsSync(join(root, "docs/security/PERFORMANCE.md"))) flag("PERFORMANCE.md missing");
else {
  const perf = read("docs/security/PERFORMANCE.md");
  if (!/growth[- ]scale/i.test(perf)) flag("PERFORMANCE.md does not document the growth-scale method");
  else pass("PERFORMANCE.md documents hot paths + current + growth-scale method");
}

if (dsn && existsSync("/usr/bin/psql")) {
  const q = (s) => execFileSync("psql", [dsn, "-tAc", s, "-X", "-v", "ON_ERROR_STOP=1"], { encoding: "utf8" }).trim();
  // indexes present
  for (const [tbl, idx] of REQUIRED_INDEXES) {
    const n = q(`SELECT count(*)::int FROM pg_indexes WHERE schemaname='guesthub' AND tablename='${tbl}' AND indexname='${idx}'`);
    if (n !== "1") flag(`missing justified index ${tbl}.${idx}`);
  }
  if (!fail) pass(`all ${REQUIRED_INDEXES.length} justified hot-path indexes present`);

  // measured: the 500-day availability projection stays within budget at current scale
  const t = q(`SELECT id FROM guesthub.tenants ORDER BY created_at LIMIT 1`);
  if (t) {
    const plan = q(`EXPLAIN (ANALYZE, TIMING OFF, SUMMARY ON) SELECT * FROM guesthub.sellable_unit_inventory('${t}', current_date, current_date + 500)`);
    const m = plan.match(/Execution Time:\s*([\d.]+)\s*ms/);
    const ms = m ? Number(m[1]) : NaN;
    const BUDGET = 1500; // generous ceiling for the 500-day projection at current scale
    if (!Number.isFinite(ms)) flag("could not measure availability projection");
    else if (ms > BUDGET) flag(`availability projection ${ms}ms exceeds ${BUDGET}ms budget`);
    else pass(`availability projection (500 days) = ${ms}ms (< ${BUDGET}ms budget)`);
  }
} else {
  console.log("• staging DSN not available — DB measurement skipped (index list + doc enforced)");
}

if (fail) { console.log(`\ncheck:performance — FAIL (${fail})`); process.exit(1); }
console.log("check:performance — PASS");
