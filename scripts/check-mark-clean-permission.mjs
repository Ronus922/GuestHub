// check:mark-clean-permission — migration 074 and the branch it exists for.
//
// THE CLAIM: the front desk can press "סמן כנקי" and still cannot run the
// housekeeping board. Granting receptionist/staff housekeeping.manage would
// have made the button work AND handed them task creation, assignment and
// reordering — four capabilities more than the button needs (audit §6, q6).
//
// Two halves, each red if its half is reverted:
//   · BEHAVIOUR (isolated DB, :5433 — never production): after 074, a
//     receptionist role holds mark_clean and does NOT hold manage, while the
//     roles that had manage keep it. The migration replays idempotently.
//   · STRUCTURE: setTaskStatusAction accepts EITHER key for 'completed' and
//     manage for everything else; the board-editing actions still require
//     manage alone. Widening any of them turns this red.
//
// Usage: CHECK_MARK_CLEAN_DB_URL=postgres://…:5433/… node scripts/check-mark-clean-permission.mjs
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
import { readFileSync } from "node:fs";
import postgres from "postgres";

const url = process.env.CHECK_MARK_CLEAN_DB_URL || process.env.CHECK_DB_URL;
if (!url) { console.error("need CHECK_MARK_CLEAN_DB_URL (a disposable DB)"); process.exit(2); }
try {
  const u = new URL(url);
  if (["localhost", "127.0.0.1", "::1"].includes(u.hostname) && (u.port || "5432") === "5432") {
    console.error("ABORT: refusing :5432 (shared production)"); process.exit(2);
  }
} catch { /* non-URL DSN — the marker check below still applies */ }
for (const marker of ["bios-vps", "guesthub.bios.co.il"]) {
  if (url.includes(marker)) { console.error(`REFUSED: production marker "${marker}"`); process.exit(2); }
}

const ok = (m) => console.log(`  ✓ ${m}`);
const MIGRATION = "db/migrations/074_housekeeping_mark_clean_permission.sql";

// ---- STRUCTURE --------------------------------------------------------------
{
  const src = readFileSync("src/lib/housekeeping/actions.ts", "utf8");
  const body = (name) => {
    const i = src.indexOf(`export async function ${name}(`);
    assert.ok(i > 0, `${name} exists`);
    return src.slice(i, i + 1400);
  };

  const setStatus = body("setTaskStatusAction");
  assert.match(setStatus, /status === "completed"/, "setTaskStatusAction branches on the completed status");
  assert.match(setStatus, /hasPermission\(actor, "housekeeping\.manage"\)/, "…accepts manage");
  assert.match(setStatus, /hasPermission\(actor, "housekeeping\.mark_clean"\)/, "…and accepts mark_clean");
  assert.match(setStatus, /else \{\s*requirePermission\(actor, "housekeeping\.manage"\)/,
    "every OTHER transition still requires manage alone");

  const bulk = body("markTasksCleanAction");
  assert.match(bulk, /hasPermission\(actor, "housekeeping\.mark_clean"\)/, "the bulk path uses the same pair");
  assert.match(bulk, /status IN \('pending', 'in_progress'\)/, "…and only completes OPEN tasks");
  assert.match(bulk, /id = ANY\(/, "…in ONE statement, not N round-trips");

  // the board-editing capabilities must NOT have been widened
  for (const name of ["createOperationalTaskAction", "assignTaskAction", "reorderTasksAction", "updateTaskAction"]) {
    const b = body(name);
    assert.match(b, /requirePermission\(actor, "housekeeping\.manage"\)/, `${name} still requires manage`);
    assert.doesNotMatch(b, /mark_clean/, `${name} does NOT accept mark_clean`);
  }
  ok("structure: mark_clean widens exactly one transition; board editing is untouched");
}

// ---- the migration is additive ---------------------------------------------
{
  const sqlText = readFileSync(MIGRATION, "utf8");
  // the header documents a rollback, which necessarily names DELETE — assert on
  // the EXECUTABLE statements only, with `--` comment lines stripped
  const executable = sqlText
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
  assert.doesNotMatch(executable, /\bDELETE\b|\bDROP\b|\bUPDATE\b/i,
    "074 only INSERTs — it alters no existing grant");
  assert.match(executable, /ON CONFLICT/, "…and is replay-safe");
  ok("migration 074 is additive and idempotent by construction");
}

// ---- BEHAVIOUR --------------------------------------------------------------
const sql = postgres(url, { prepare: false, max: 1 });
let tenant;
try {
  const slug = "mark-clean-check";
  await sql`DELETE FROM guesthub.tenants WHERE slug = ${slug}`;
  [{ id: tenant }] = await sql`
    INSERT INTO guesthub.tenants (name, slug) VALUES ('mark-clean-check', ${slug}) RETURNING id`;
  await sql`
    INSERT INTO guesthub.roles (tenant_id, name, key)
    SELECT ${tenant}, k, k FROM unnest(ARRAY['admin','manager','super_admin','receptionist','staff','cleaner']) k`;
  // production's shape BEFORE 074: manage on the three authority roles only.
  // The base housekeeping keys are provisioned outside the migration chain, so
  // a migrations-only DB has no `housekeeping.manage` row — construct it, the
  // same way the grants below are constructed, or the baseline is not production's.
  await sql`
    INSERT INTO guesthub.permissions (key, description, category)
    VALUES ('housekeeping.manage', 'ניהול משימות ניקיון', 'housekeeping')
    ON CONFLICT (key) DO NOTHING`;
  await sql`
    INSERT INTO guesthub.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM guesthub.roles r
    JOIN guesthub.permissions p ON p.key = 'housekeeping.manage'
    WHERE r.tenant_id = ${tenant} AND r.key IN ('admin','manager','super_admin')
    ON CONFLICT DO NOTHING`;

  const held = async (roleKey, permKey) => {
    const [row] = await sql`
      SELECT 1 AS x FROM guesthub.roles r
      JOIN guesthub.role_permissions rp ON rp.role_id = r.id
      JOIN guesthub.permissions p ON p.id = rp.permission_id
      WHERE r.tenant_id = ${tenant} AND r.key = ${roleKey} AND p.key = ${permKey}`;
    return Boolean(row);
  };

  assert.equal(await held("receptionist", "housekeeping.manage"), false, "baseline: reception has no manage");

  // apply the migration exactly as the runner would, twice
  const migration = readFileSync(MIGRATION, "utf8");
  await sql.unsafe(migration);
  await sql.unsafe(migration);
  ok("074 applied twice against the isolated DB — replays without error");

  assert.equal(await held("receptionist", "housekeeping.mark_clean"), true,
    "a receptionist CAN mark clean");
  assert.equal(await held("receptionist", "housekeeping.manage"), false,
    "…and is still refused task creation / assignment / board editing");
  assert.equal(await held("staff", "housekeeping.mark_clean"), true, "so can staff");
  assert.equal(await held("staff", "housekeeping.manage"), false, "…equally refused the board");
  assert.equal(await held("cleaner", "housekeeping.mark_clean"), false,
    "the cleaner is NOT granted it — they advance their own tasks (housekeeping.my_tasks)");
  for (const r of ["admin", "manager", "super_admin"]) {
    assert.equal(await held(r, "housekeeping.manage"), true, `${r} keeps manage — no grant was altered`);
    assert.equal(await held(r, "housekeeping.mark_clean"), true, `${r} also gets the new key`);
  }
  ok("behaviour: reception marks clean, reception cannot run the board, nobody lost anything");
} finally {
  if (tenant) await sql`DELETE FROM guesthub.tenants WHERE id = ${tenant}`.catch(() => {});
  await sql.end();
}

console.log("\ncheck-mark-clean-permission: all assertions passed");
