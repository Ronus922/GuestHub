#!/usr/bin/env node
// ============================================================
// revert-longterm-closures — undo scripts/migrate-longterm-closures.mjs,
// entry by entry, ONLY where the live database still matches the journal.
//
// WHY IT VERIFIES FIRST. The migration is not the only thing that can touch
// these rows: an operator can re-open dates in /rates, delete the closure from
// the calendar, or extend the lease. Blindly restoring 165 stop_sell flags on
// top of whatever is there now would invent a state nobody chose. So every
// entry is checked against the database BEFORE anything is written, and a room
// whose fingerprint has drifted is REFUSED by name and left exactly as it is —
// the other rooms still revert.
//
// VERIFIED PER ENTRY (all must hold):
//   · the closure row still exists, on that room, with that id, that exact
//     [start, end), kind='ooo' and category='long_term';
//   · the base pricing plan is still the one that was converted;
//   · every rate row in the range currently has stop_sell = false — i.e. the
//     range is still in the state the migration left it in;
//   · the number of rows in the range equals the number the migration cleared.
//
// ORDER, MIRRORED. The migration writes the closure, then clears stop_sell.
// The revert restores stop_sell, then deletes the closure — the hold is never
// released before its replacement exists, in either direction. One transaction
// per entry, so a refusal on one room cannot roll back another's revert.
//
// DRY RUN IS THE DEFAULT, and like the migration it performs the real writes
// inside a transaction it always rolls back.
//
// Usage:
//   node scripts/revert-longterm-closures.mjs                 # dry run
//   LT_REVERT=1 node scripts/revert-longterm-closures.mjs     # commit
//
// Env:
//   DATABASE_URL  required. Printed before any work.
//   LT_REVERT     "1" = commit. Anything else = dry run.
//   LT_JOURNAL    journal written by the migration. Default
//                 backups/longterm-closures.journal.json
//   LT_ROOMS      optional filter — revert only these room numbers.
// ============================================================
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import Module from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = process.env.LT_REVERT === "1";
const JOURNAL = process.env.LT_JOURNAL || join(ROOT, "backups", "longterm-closures.journal.json");
const ONLY = (process.env.LT_ROOMS || "").split(",").map((s) => s.trim()).filter(Boolean);

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("REFUSED: DATABASE_URL is not set. This script has no default target on purpose.");
  process.exit(2);
}
{
  const u = new URL(DB_URL);
  console.log(`# target : ${u.username}@${u.hostname}:${u.port || 5432}${u.pathname}`);
}
console.log(`# mode   : ${WRITE ? "WRITE (commits)" : "DRY RUN (always rolled back)"}`);
console.log(`# journal: ${JOURNAL}`);

let entries;
try {
  entries = JSON.parse(readFileSync(JOURNAL, "utf8"));
} catch (e) {
  console.error(`REFUSED: cannot read the journal (${String(e?.message ?? e)}). ` +
    `There is nothing to verify against, and this script never guesses what the migration did.`);
  process.exit(2);
}
if (!Array.isArray(entries) || entries.length === 0) {
  console.error("REFUSED: the journal is empty.");
  process.exit(2);
}
const todo = ONLY.length ? entries.filter((e) => ONLY.includes(e.roomNumber)) : entries;
console.log(`# entries: ${todo.length} of ${entries.length}`);

// the canonical outbox again — a revert is an ARI change like any other
const OUT = join(ROOT, "node_modules", ".cache", "lt-closures");
mkdirSync(OUT, { recursive: true });
const TSCONFIG = join(OUT, "tsconfig.json");
writeFileSync(TSCONFIG, JSON.stringify({
  compilerOptions: {
    module: "commonjs", moduleResolution: "node10", target: "es2022",
    lib: ["es2023"], types: ["node"], esModuleInterop: true, skipLibCheck: true,
    strict: true, noEmitOnError: true,
    baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
    rootDir: join(ROOT, "src"), outDir: OUT,
  },
  include: [join(ROOT, "src/lib/channel/outbox.ts"), join(ROOT, "src/lib/dates.ts")],
}));
execSync(`pnpm exec tsc -p ${TSCONFIG}`, { stdio: "inherit" });
const STUB = join(ROOT, "scripts", "server-only-stub.cjs");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return STUB;
  if (request.startsWith("@/")) return origResolve.call(this, join(OUT, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};
const req = createRequire(import.meta.url);
const { markAriDirty } = req(join(OUT, "lib/channel/outbox.js"));

const sql = postgres(DB_URL, { prepare: false, max: 1, onnotice: () => {} });

/** Thrown to roll a dry run back — declared before the loop that throws it. */
class DryRun extends Error {}

let ok = 0;
let refused = 0;

for (const e of todo) {
  try {
    await sql.begin(async (tx) => {
      // ---- verify: the closure is still exactly what the migration wrote ----
      const [closure] = await tx`
        SELECT id, room_id, start_date::text AS start_date, end_date::text AS end_date,
               kind, category
        FROM guesthub.room_closures
        WHERE id = ${e.closureId} AND tenant_id = ${e.tenantId}`;
      if (!closure) throw new Error("the closure row is gone — somebody already removed it");
      if (closure.room_id !== e.roomId) throw new Error("the closure moved to another room");
      if (closure.start_date !== e.today || closure.end_date !== e.endExclusive)
        throw new Error(`the closure range drifted: journal ${e.today}→${e.endExclusive}, database ${closure.start_date}→${closure.end_date}`);
      if (closure.kind !== "ooo" || closure.category !== "long_term")
        throw new Error(`the closure was reclassified: kind=${closure.kind}, category=${closure.category}`);

      // ---- verify: the plan and the range are still in the migrated state ----
      const [plan] = await tx`
        SELECT pp.id FROM guesthub.pricing_plans pp
        WHERE pp.id = ${e.planId} AND pp.tenant_id = ${e.tenantId} AND pp.is_base AND pp.is_active`;
      if (!plan) throw new Error("the base pricing plan that was converted is no longer the active base plan");

      const [{ total, still_closed }] = await tx`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE stop_sell)::int AS still_closed
        FROM guesthub.pricing_plan_rates
        WHERE pricing_plan_id = ${e.planId}
          AND date >= ${e.today} AND date < ${e.endExclusive}`;
      if (still_closed > 0)
        throw new Error(`${still_closed} row(s) in the range are stop-sold again — the range is no longer the state the migration left`);
      if (total !== e.stopSellCleared)
        throw new Error(`row count drifted: journal cleared ${e.stopSellCleared}, database now holds ${total} row(s) in the range`);

      // ---- revert, mirroring the migration's order ----
      const restored = await tx`
        UPDATE guesthub.pricing_plan_rates
        SET stop_sell = true
        WHERE pricing_plan_id = ${e.planId}
          AND date >= ${e.today} AND date < ${e.endExclusive}
        RETURNING id`;
      await tx`
        DELETE FROM guesthub.room_closures
        WHERE id = ${e.closureId} AND tenant_id = ${e.tenantId}`;
      await markAriDirty(tx, {
        tenantId: e.tenantId,
        roomIds: [e.roomId],
        dateFrom: e.today,
        dateTo: e.endExclusive,
        kinds: ["availability", "restrictions"],
      });
      await tx`
        INSERT INTO guesthub.audit_logs
          (tenant_id, user_id, entity_type, entity_id, action, before_data, after_data)
        VALUES (${e.tenantId}, NULL, 'room_closure', ${e.closureId}, 'long_term_migration_revert',
                ${tx.json({ closure_id: e.closureId, start: e.today, end: e.endExclusive })},
                ${tx.json({ stop_sell_restored: restored.length })})`;

      console.log(`\n${e.roomNumber}: verified against the journal\n` +
        `  stop_sell  restored on ${restored.length} row(s) ${e.today} → ${e.endExclusive}\n` +
        `  closure    ${e.closureId} deleted\n` +
        `  ari        availability+restrictions marked dirty over the same range`);
      ok++;
      if (!WRITE) throw new DryRun();
    });
  } catch (err) {
    if (err instanceof DryRun || err?.cause instanceof DryRun) continue;
    refused++;
    console.error(`\n${e.roomNumber}: REFUSED — ${String(err?.message ?? err)}`);
  }
}

if (!WRITE) console.log(`\nDRY RUN — nothing was committed. Re-run with LT_REVERT=1 to apply.`);
console.log(`\n${todo.length} entr(ies): ${ok} reverted, ${refused} refused`);
await sql.end();
process.exit(refused > 0 ? 1 : 0);
