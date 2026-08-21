#!/usr/bin/env node
// ============================================================
// migrate-longterm-closures — convert the year-let rooms from a COMMERCIAL
// hold (pricing_plan_rates.stop_sell) to a PHYSICAL one (a dated room_closures
// row, kind='ooo', category='long_term').
//
// WHY. Rooms 1006 and 1042 are rented on yearly leases: a person lives in each
// flat. Today they are held out of sale by 165 rows of stop_sell each, which is
// a SALES rule — 084 lists STOP_SELL among OVERRIDABLE_STAY_RULE_CODES, so a
// manager holding reservations.restriction_override is offered "המשך בכל זאת"
// and can book a guest into an occupied home. A closure of kind 'ooo' is the
// physical instrument: it is subtracted by sellable_unit_inventory(), refused
// by check_room_availability() as conflict_kind='closure', and reaches no
// override path anywhere in the codebase.
//
// WHAT IT DOES, per room, in ONE transaction:
//   1. MEASURE the contiguous run of stop_sell days on the room's BASE plan
//      that covers today. Nothing is assumed about its edges — the run is read
//      from the database and printed, because the ranges drift as the operator
//      edits the grid.
//   2. REFUSE the room outright if check_room_availability() reports any
//      conflict over the range being closed. A booking inside the lease window
//      is a contradiction somebody must resolve by hand, not a row to overwrite.
//   3. INSERT the closure FIRST, then clear stop_sell, then mark ARI dirty.
//      Inside one transaction nothing is visible until COMMIT, so the ordering
//      cannot open a window in which a channel sees the room for sale — but it
//      is also the order in which a partial failure is harmless, and it reads
//      the way the invariant is meant: the physical hold exists before the
//      commercial one is released, never the reverse.
//   4. UPDATE, never DELETE, the rate rows: they carry the nightly PRICE, which
//      the direct website still needs the day the lease ends. Only the
//      stop_sell flag is cleared, and only over the converted range.
//
// WHAT IT DOES NOT TOUCH. Rows BEFORE today. A closure starts today (the past
// is not sellable and tenantWritableWindow refuses it), so the stop_sell days
// already behind us stay exactly as they are; the report names how many.
//
// DRY RUN IS THE DEFAULT. Without LT_MIGRATE=1 every statement still runs —
// inside a transaction that is ALWAYS rolled back — so the printed plan is the
// real result of the real writes, not a description of them. Nothing is
// journalled on a dry run.
//
// JOURNAL. A write run appends one entry per room (closure id, measured range,
// exact row count, timestamps) to $LT_JOURNAL. scripts/revert-longterm-closures.mjs
// verifies that journal against the live database before undoing anything.
//
// Usage:
//   node scripts/migrate-longterm-closures.mjs                  # dry run, 1006+1042
//   LT_ROOMS=1006 node scripts/migrate-longterm-closures.mjs    # dry run, one room
//   LT_MIGRATE=1 node scripts/migrate-longterm-closures.mjs     # write + journal
//
// Env:
//   DATABASE_URL  required. The target is printed (host/db/user) before any work.
//   LT_ROOMS      comma-separated room NUMBERS. Default "1006,1042".
//   LT_TENANT     tenant uuid. Required only if a room number is ambiguous.
//   LT_MIGRATE    "1" = commit. Anything else = dry run.
//   LT_JOURNAL    journal path. Default backups/longterm-closures.journal.json
//                 (backups/ is gitignored — a run artifact, never source).
// ============================================================
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import Module from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = process.env.LT_MIGRATE === "1";
const ROOM_NUMBERS = (process.env.LT_ROOMS || "1006,1042").split(",").map((s) => s.trim()).filter(Boolean);
const TENANT = process.env.LT_TENANT || null;
const JOURNAL = process.env.LT_JOURNAL || join(ROOT, "backups", "longterm-closures.journal.json");
const CATEGORY = "long_term";
const REASON = "הוסב מ-stop_sell — שכירות שנתית";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("REFUSED: DATABASE_URL is not set. This script has no default target on purpose.");
  process.exit(2);
}
// Identity is PRINTED, never guessed: this script is meant to run against
// production, so the operator must be able to see what they are about to change.
{
  const u = new URL(DB_URL);
  console.log(`# target: ${u.username}@${u.hostname}:${u.port || 5432}${u.pathname}`);
}
console.log(`# mode  : ${WRITE ? "WRITE (commits)" : "DRY RUN (always rolled back)"}`);
console.log(`# rooms : ${ROOM_NUMBERS.join(", ")}`);

// ---- the canonical outbox, compiled from source and reused, never re-implemented ----
// markAriDirty owns the coalescing of pending ranges; a second copy here would
// be a second set of rules for the same table.
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
const { addDays, todayInTz } = req(join(OUT, "lib/dates.js"));

const sql = postgres(DB_URL, { prepare: false, max: 1, onnotice: () => {} });

/** Thrown to roll a dry run back. A real Error subclass declared BEFORE the
 *  loop that throws it: postgres.js re-throws whatever the callback threw (and
 *  may wrap it as `cause`), and both readings are checked below. */
class DryRun extends Error {}

/** The maximal run of consecutive stop_sell days on `planId` that CONTAINS
 *  `from`. Measured, never assumed: the operator edits this grid daily. */
async function measureRun(tx, planId, from) {
  const rows = await tx`
    SELECT date::text AS date
    FROM guesthub.pricing_plan_rates
    WHERE pricing_plan_id = ${planId} AND stop_sell AND date >= ${from}
    ORDER BY date`;
  if (rows.length === 0 || rows[0].date !== from) return null;
  let last = rows[0].date;
  for (const r of rows.slice(1)) {
    if (r.date !== addDays(last, 1)) break; // a gap ends the run
    last = r.date;
  }
  return { first: rows[0].date, last, nights: rows.findIndex((r) => r.date === last) + 1 };
}

const results = [];

for (const roomNumber of ROOM_NUMBERS) {
  const report = { roomNumber, status: "skipped", detail: null };
  try {
    await sql.begin(async (tx) => {
      const rooms = await tx`
        SELECT r.id, r.tenant_id, r.room_number, r.status, r.is_active, t.timezone
        FROM guesthub.rooms r
        JOIN guesthub.tenants t ON t.id = r.tenant_id
        WHERE r.room_number = ${roomNumber}
          ${TENANT ? tx`AND r.tenant_id = ${TENANT}` : tx``}`;
      if (rooms.length === 0) throw new Error(`room ${roomNumber} not found`);
      if (rooms.length > 1) throw new Error(`room number ${roomNumber} exists in ${rooms.length} tenants — set LT_TENANT`);
      const room = rooms[0];
      const today = todayInTz(room.timezone || "Asia/Jerusalem");

      const [plan] = await tx`
        SELECT pp.id, pp.sellable_unit_id
        FROM guesthub.sellable_unit_rooms sur
        JOIN guesthub.pricing_plans pp
          ON pp.sellable_unit_id = sur.sellable_unit_id
         AND pp.tenant_id = sur.tenant_id AND pp.is_base AND pp.is_active
        WHERE sur.room_id = ${room.id}`;
      if (!plan) throw new Error(`room ${roomNumber} has no active base pricing plan`);

      const run = await measureRun(tx, plan.id, today);
      if (!run) throw new Error(`room ${roomNumber} is not stop-sold on ${today} — nothing to convert`);
      const endExclusive = addDays(run.last, 1);

      // how much of the historical hold is deliberately left alone
      const [{ past }] = await tx`
        SELECT count(*)::int AS past FROM guesthub.pricing_plan_rates
        WHERE pricing_plan_id = ${plan.id} AND stop_sell AND date < ${today}`;

      // 2. a booking inside the lease window is a contradiction, not a row to overwrite
      const conflicts = await tx`
        SELECT conflict_kind, conflict_id, conflict_from::text AS conflict_from,
               conflict_to::text AS conflict_to
        FROM guesthub.check_room_availability(
          ${room.tenant_id}, ARRAY[${room.id}]::uuid[], ${today}, ${endExclusive}, ARRAY[]::uuid[])`;
      if (conflicts.length > 0) {
        throw new Error(
          `room ${roomNumber} has ${conflicts.length} conflict(s) over ${today}…${endExclusive}: ` +
          conflicts.map((c) => `${c.conflict_kind}(${c.conflict_from ?? "-"}→${c.conflict_to ?? "-"})`).join(", "),
        );
      }

      // 3a. the closure FIRST
      const [closure] = await tx`
        INSERT INTO guesthub.room_closures
          (tenant_id, room_id, start_date, end_date, reason, kind, category, created_by)
        VALUES (${room.tenant_id}, ${room.id}, ${today}, ${endExclusive},
                ${REASON}, 'ooo', ${CATEGORY}, NULL)
        RETURNING id`;

      // 3b. …then release the commercial hold over exactly the converted range
      const cleared = await tx`
        UPDATE guesthub.pricing_plan_rates
        SET stop_sell = false
        WHERE pricing_plan_id = ${plan.id}
          AND date >= ${today} AND date < ${endExclusive}
          AND stop_sell
        RETURNING id`;

      // 3c. …and only then claim the outbound work, over the FULL range
      await markAriDirty(tx, {
        tenantId: room.tenant_id,
        roomIds: [room.id],
        dateFrom: today,
        dateTo: endExclusive,
        // availability: the closure subtracts the room from sellable_unit_inventory.
        // restrictions: stop_sell is a restriction field and it just changed.
        // NOT rates: no price was touched — the rows keep every agora of it.
        kinds: ["availability", "restrictions"],
      });

      await tx`
        INSERT INTO guesthub.audit_logs
          (tenant_id, user_id, entity_type, entity_id, action, before_data, after_data)
        VALUES (${room.tenant_id}, NULL, 'room_closure', ${closure.id}, 'long_term_migration',
                ${tx.json({ stop_sell_days: cleared.length, from: today, to: run.last })},
                ${tx.json({ closure_id: closure.id, category: CATEGORY, start: today, end: endExclusive })})`;

      report.status = WRITE ? "converted" : "dry-run-ok";
      report.detail = {
        tenantId: room.tenant_id,
        roomId: room.id,
        roomNumber,
        planId: plan.id,
        sellableUnitId: plan.sellable_unit_id,
        closureId: closure.id,
        today,
        measuredRunFirst: run.first,
        measuredRunLast: run.last,
        endExclusive,
        stopSellCleared: cleared.length,
        stopSellLeftInPast: past,
        at: new Date().toISOString(),
      };

      console.log(
        `\n${roomNumber}: measured stop_sell run ${run.first} … ${run.last} (${run.nights} nights)\n` +
        `  closure    ${today} → ${endExclusive} (exclusive), category=${CATEGORY}, kind=ooo\n` +
        `  stop_sell  cleared on ${cleared.length} row(s); ${past} historical row(s) left untouched\n` +
        `  ari        availability+restrictions marked dirty ${today} → ${endExclusive}`,
      );

      if (!WRITE) throw new DryRun(); // roll the whole thing back
    });
  } catch (e) {
    if (e instanceof DryRun || e?.cause instanceof DryRun) {
      // expected: the dry run proved the writes by performing and discarding them
    } else {
      report.status = "FAILED";
      report.detail = String(e?.message ?? e);
      console.error(`\n${roomNumber}: REFUSED — ${report.detail}`);
    }
  }
  results.push(report);
}


if (WRITE) {
  const converted = results.filter((r) => r.status === "converted").map((r) => r.detail);
  if (converted.length > 0) {
    mkdirSync(dirname(JOURNAL), { recursive: true });
    let prior = [];
    try { prior = JSON.parse(readFileSync(JOURNAL, "utf8")); } catch { prior = []; }
    writeFileSync(JOURNAL, JSON.stringify([...prior, ...converted], null, 2));
    console.log(`\njournal: ${converted.length} entr(ies) appended to ${JOURNAL}`);
  }
} else {
  console.log(`\nDRY RUN — nothing was committed and no journal was written.`);
  console.log(`Re-run with LT_MIGRATE=1 to apply.`);
}

const failed = results.filter((r) => r.status === "FAILED");
console.log(`\n${results.length} room(s): ${results.filter((r) => r.status !== "FAILED").length} ok, ${failed.length} refused`);
await sql.end();
process.exit(failed.length > 0 ? 1 : 0);
