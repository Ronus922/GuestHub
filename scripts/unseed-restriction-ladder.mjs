#!/usr/bin/env node
// ============================================================
// unseed-restriction-ladder — the exact undo of scripts/seed-restriction-ladder.mjs.
//
// It restores from the JOURNAL the seed wrote, not from a guess: a row that did
// not exist before is DELETED, a row that did exist is written back field by
// field to the values it held. Nothing else in the window is touched, so a rate
// someone edited by hand in the meantime is only reverted if the seed had
// overwritten it — which is precisely what the journal recorded.
//
// If the journal is gone there is nothing to restore from and the script
// refuses. It will not "clean up" by blanking a date range, because that would
// silently destroy real commercial data that was never part of the seed.
//
// Like the seed, it prints every row it would touch and writes NOTHING unless
// UNSEED_RESTRICTION_LADDER=1 is set.
//
// Usage:
//   node --env-file=.env.local scripts/unseed-restriction-ladder.mjs           # dry run
//   UNSEED_RESTRICTION_LADDER=1 node --env-file=.env.local scripts/unseed-restriction-ladder.mjs
// Optional: LADDER_JOURNAL (path — must match the seed's)
// ============================================================
import postgres from "postgres";
import { parseDbTarget, PROD_MARKERS } from "./lib/e2e-write-guard.mjs";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
const ARMED = process.env.UNSEED_RESTRICTION_LADDER === "1";
const JOURNAL = process.env.LADDER_JOURNAL || join(tmpdir(), "guesthub-restriction-ladder-seed.json");

// Say out loud WHICH database this is about to touch. The seed is deliberately
// allowed to run against production (that is the whole point — the live
// calendar is where the ladder is looked at), so unlike scripts/seed.mjs it
// does not refuse; it names the target instead. parseDbTarget never returns
// the password.
const TARGET = parseDbTarget(process.env.DATABASE_URL);
const IS_PROD = PROD_MARKERS.some((m) => (process.env.DATABASE_URL || "").includes(m));
console.log(`database: ${TARGET.user}@${TARGET.host}:${TARGET.port}/${TARGET.db}${IS_PROD ? "   ** PRODUCTION **" : ""}`);

if (!existsSync(JOURNAL)) {
  console.error(`no journal at ${JOURNAL} — nothing to restore from.`);
  console.error("Pass LADDER_JOURNAL=<path> if the seed wrote it somewhere else.");
  await sql.end();
  process.exit(1);
}
const journal = JSON.parse(readFileSync(JOURNAL, "utf8"));

console.log(`journal: ${JOURNAL}`);
console.log(`seeded on: ${journal.seeded_at_today}   rooms: ${journal.rooms.a}, ${journal.rooms.b}`);

const deletes = journal.rows.filter((r) => !r.prior);
const restores = journal.rows.filter((r) => r.prior);

console.log("\nrows to touch:");
for (const r of journal.rows) {
  const p = r.prior;
  console.log(
    `  ${r.date}  ${(p ? "RESTORE" : "DELETE ").padEnd(8)}` +
    (p
      ? `max_stay→${p.max_stay ?? "—"}  stop_sell→${p.stop_sell}  CTA→${p.closed_to_arrival}  CTD→${p.closed_to_departure}`
      : "(the row did not exist before the seed)"),
  );
}
console.log(`\n${journal.rows.length} rows: ${deletes.length} DELETE, ${restores.length} RESTORE`);

if (!ARMED) {
  console.log("\nDRY RUN — nothing was written.");
  console.log("To write, re-run with:  UNSEED_RESTRICTION_LADDER=1 node --env-file=.env.local scripts/unseed-restriction-ladder.mjs");
  await sql.end();
  process.exit(0);
}

await sql.begin(async (tx) => {
  for (const r of deletes) {
    await tx`
      DELETE FROM guesthub.pricing_plan_rates
      WHERE tenant_id = ${journal.tenant_id}
        AND pricing_plan_id = ${r.pricing_plan_id} AND date = ${r.date}`;
  }
  for (const r of restores) {
    const p = r.prior;
    await tx`
      UPDATE guesthub.pricing_plan_rates SET
        price = ${p.price}, min_stay_through = ${p.min_stay_through},
        min_stay_arrival = ${p.min_stay_arrival}, max_stay = ${p.max_stay},
        closed_to_arrival = ${p.closed_to_arrival},
        closed_to_departure = ${p.closed_to_departure},
        stop_sell = ${p.stop_sell}, updated_at = now()
      WHERE tenant_id = ${journal.tenant_id}
        AND pricing_plan_id = ${r.pricing_plan_id} AND date = ${r.date}`;
  }
});

unlinkSync(JOURNAL);
console.log(`\n✓ restored ${journal.rows.length} rows; journal removed.`);
await sql.end();
