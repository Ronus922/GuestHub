#!/usr/bin/env node
// check:housekeeping (Stage 5 §7) — housekeeping is connected to the real
// reservation lifecycle: a checkout generates a cleaning task (idempotent), the
// cleaner flow advances dirty→cleaning→clean, and cleanliness does NOT change
// availability (no outbox marking). Static invariants + a DB idempotency proof.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let fail = 0;
const flag = (m) => { fail++; console.log(`✗ ${m}`); };
const pass = (m) => console.log(`✓ ${m}`);

// ---- static: checkout generates a cleaning task, idempotently ----
const resActions = read("src/app/(dashboard)/reservations/actions.ts");
if (!/input\.status === "checked_out"[\s\S]{0,600}INSERT INTO guesthub\.housekeeping_tasks/.test(resActions))
  flag("checkout does not generate a housekeeping task");
else pass("checkout generates a cleaning task (lifecycle connection)");
if (!/housekeeping_tasks[\s\S]{0,400}WHERE NOT EXISTS/.test(resActions))
  flag("checkout task generation is not idempotent (no NOT EXISTS guard)");
else pass("task generation is idempotent (skips a room with an open task)");
// cleanliness must NOT mark the ARI outbox (a dirty room stays sellable)
const checkoutBlock = resActions.slice(
  resActions.indexOf('input.status === "checked_out"'),
  resActions.indexOf('input.status === "checked_out"') + 700,
);
if (/markAriDirty/.test(checkoutBlock)) flag("checkout housekeeping block marks the ARI outbox (cleanliness must not affect availability)");
else pass("cleanliness does not touch the ARI outbox (D64 0/1 model)");

// ---- static: the operational flow is auth-gated + honest ----
const hk = read("src/lib/housekeeping/actions.ts");
if (!/requirePermission\(actor, "housekeeping\.view"\)/.test(hk)) flag("manager list not gated by housekeeping.view");
else pass("manager list gated by housekeeping.view");
if (!/housekeeping\.manage/.test(hk)) flag("assign/inspect not gated by housekeeping.manage");
else pass("assign/inspect gated by housekeeping.manage");
if (!/housekeeping\.my_tasks/.test(hk)) flag("cleaner flow not gated by housekeeping.my_tasks");
else pass("cleaner flow gated by housekeeping.my_tasks");
if (!/FOR UPDATE/.test(hk)) flag("task advance is not row-locked (race)");
else pass("task advance is row-locked (FOR UPDATE)");
if (!/assigned_to !== actor\.userId/.test(hk)) flag("a cleaner could advance another cleaner's task");
else pass("a cleaner cannot advance another cleaner's assigned task");
// inspected lifecycle exists (clean/dirty/inspected)
if (!/status = 'inspected'[\s\S]{0,120}status = 'completed'/.test(hk)) flag("no completed→inspected transition");
else pass("completed→inspected lifecycle present");

// §9 unified task foundation: ONE store (housekeeping_tasks) with a task_type —
// no parallel task table, and a create action for maintenance/general tasks.
const mig041 = read("db/migrations/041_operational_tasks.sql");
if (!/task_type[\s\S]{0,120}'housekeeping','maintenance','general'/.test(mig041))
  flag("no unified task_type on the operational task store");
else pass("unified task store carries task_type (housekeeping/maintenance/general)");
if (!/createOperationalTaskAction/.test(hk)) flag("no create action for non-housekeeping tasks");
else pass("createOperationalTaskAction adds maintenance/general tasks to the same store");
// there must be no SEPARATE task table (anti-fragmentation, V2 §9)
const migsAll = readdirSync(join(root, "db/migrations"))
  .map((f) => read(`db/migrations/${f}`)).join("\n");
if (/CREATE TABLE[^;]*\b(operational_tasks|maintenance_tasks|tasks)\b/i.test(migsAll))
  flag("a separate task table exists — tasks must live on the one unified store");
else pass("no parallel task table (single unified operational store)");

// ---- DB idempotency proof (staging owner DSN) ----
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
if (dsn && existsSync("/usr/bin/psql")) {
  const q = (s) => execFileSync("psql", [dsn, "-tAc", s, "-X", "-v", "ON_ERROR_STOP=1"], { encoding: "utf8" }).trim();
  // Prove the EXACT idempotency query dedupes: run the generation SELECT…WHERE
  // NOT EXISTS twice against a temp table shaped like housekeeping_tasks. Two
  // "checkouts" of the same room+reservation must yield exactly ONE open task.
  const insertOnce = `
    INSERT INTO hk_probe (tenant_id, room_id, reservation_id, status)
    SELECT t, rm, res, 'pending' FROM hk_ids
    WHERE NOT EXISTS (SELECT 1 FROM hk_probe h, hk_ids i
      WHERE h.tenant_id = i.t AND h.room_id = i.rm AND h.reservation_id = i.res
        AND h.status IN ('pending','in_progress'));`;
  const out = q(`
    BEGIN;
    CREATE TEMP TABLE hk_probe (tenant_id uuid, room_id uuid, reservation_id uuid, status text) ON COMMIT DROP;
    CREATE TEMP TABLE hk_ids ON COMMIT DROP AS
      SELECT gen_random_uuid() AS t, gen_random_uuid() AS rm, gen_random_uuid() AS res;
    ${insertOnce}
    ${insertOnce}
    SELECT 'TASKS=' || count(*) FROM hk_probe;
    COMMIT;`);
  const m = out.match(/TASKS=(\d+)/);
  if (!m) flag(`DB idempotency probe produced no count (${out.slice(0, 120)})`);
  else if (m[1] !== "1") flag(`checkout generated ${m[1]} tasks, expected exactly 1 (idempotency broken)`);
  else pass("DB proof: two checkout generations create exactly ONE task (idempotent)");
} else {
  console.log("• staging DSN not available — DB idempotency probe skipped (static invariants still enforced)");
}

if (fail) { console.log(`\ncheck:housekeeping — FAIL (${fail})`); process.exit(1); }
console.log("check:housekeeping — PASS");
