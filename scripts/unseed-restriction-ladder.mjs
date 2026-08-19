#!/usr/bin/env node
// ============================================================
// unseed-restriction-ladder — the exact undo of scripts/seed-restriction-ladder.mjs.
//
// It restores from the JOURNAL the seed wrote, not from a guess: a row that did
// not exist before is DELETED, a row that did exist is written back field by
// field to the values it held. Nothing else in the window is touched.
//
// IT VERIFIES BEFORE IT WRITES. The journal records not only the state BEFORE
// the seed (`prior`) but the state the seed LEFT behind (`seeded`). Every row is
// re-read and compared against `seeded` first, so an operator who edited that
// room-night in the meantime does not have their work silently reverted to a
// snapshot from before the seed: such a row is SKIPPED and named, and the run
// still succeeds for the rows that are untouched. The comparison covers exactly
// the six restriction fields the seed writes — price is neither written nor
// compared, because the seed never touches it.
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
const FIELDS = journal.fields;

console.log(`journal: ${JOURNAL}`);
console.log(`seeded on: ${journal.seeded_at_today}   room: ${journal.room}`);

// ---- re-read the live rows and compare them against what the seed left ----
const dates = journal.rows.map((r) => r.date);
const planIds = [...new Set(journal.rows.map((r) => r.pricing_plan_id))];
const live = await sql`
  SELECT pricing_plan_id, date::text AS date, stop_sell, closed_to_arrival,
         closed_to_departure, min_stay_arrival, min_stay_through, max_stay
  FROM guesthub.pricing_plan_rates
  WHERE tenant_id = ${journal.tenant_id}
    AND pricing_plan_id = ANY(${planIds}::uuid[])
    AND date = ANY(${dates}::date[])`;
const now = new Map(live.map((r) => [`${r.pricing_plan_id}|${r.date}`, r]));

const same = (a, b) => FIELDS.every((f) => (a[f] ?? null) === (b[f] ?? null));
const fmt = (v) => (v === null || v === undefined ? "—" : String(v));

const plan = [];
for (const r of journal.rows) {
  const current = now.get(`${r.pricing_plan_id}|${r.date}`) ?? null;
  if (!current) {
    // the row is gone. If the seed created it, someone already removed it and
    // there is nothing left to undo; if it pre-dated the seed, its disappearance
    // is somebody else's change and not ours to recreate.
    plan.push({ r, action: r.existed ? "SKIP" : "GONE", why: r.existed ? "the row was deleted after the seed" : "already removed" });
  } else if (!same(current, r.seeded)) {
    const drift = FIELDS.filter((f) => (current[f] ?? null) !== (r.seeded[f] ?? null))
      .map((f) => `${f}: ${fmt(r.seeded[f])}→${fmt(current[f])}`);
    plan.push({ r, action: "SKIP", why: `changed since the seed (${drift.join(", ")})` });
  } else {
    plan.push({ r, action: r.existed ? "RESTORE" : "DELETE", why: "" });
  }
}

console.log("\nrows to touch:");
for (const p of plan) {
  const detail =
    p.action === "RESTORE"
      ? FIELDS.map((f) => `${f}→${fmt(p.r.prior[f])}`).join("  ")
      : p.action === "DELETE"
        ? "(the row did not exist before the seed)"
        : p.why;
  console.log(`  ${p.r.date}  ${p.action.padEnd(8)}${detail}`);
}
const count = (a) => plan.filter((p) => p.action === a).length;
console.log(
  `\n${plan.length} rows: ${count("DELETE")} DELETE, ${count("RESTORE")} RESTORE, ` +
  `${count("SKIP")} SKIPPED, ${count("GONE")} already gone`,
);
if (count("SKIP")) {
  console.log("A SKIPPED row is NOT reverted — it no longer holds what the seed left, so writing");
  console.log("the pre-seed values over it would destroy somebody else's edit. Undo those by hand.");
}

if (!ARMED) {
  console.log("\nDRY RUN — nothing was written.");
  console.log("To write, re-run with:  UNSEED_RESTRICTION_LADDER=1 node --env-file=.env.local scripts/unseed-restriction-ladder.mjs");
  await sql.end();
  process.exit(0);
}

await sql.begin(async (tx) => {
  for (const p of plan) {
    const r = p.r;
    if (p.action === "DELETE") {
      await tx`
        DELETE FROM guesthub.pricing_plan_rates
        WHERE tenant_id = ${journal.tenant_id}
          AND pricing_plan_id = ${r.pricing_plan_id} AND date = ${r.date}`;
    } else if (p.action === "RESTORE") {
      const q = r.prior;
      await tx`
        UPDATE guesthub.pricing_plan_rates SET
          stop_sell = ${q.stop_sell},
          closed_to_arrival = ${q.closed_to_arrival},
          closed_to_departure = ${q.closed_to_departure},
          min_stay_arrival = ${q.min_stay_arrival},
          min_stay_through = ${q.min_stay_through},
          max_stay = ${q.max_stay},
          updated_at = now()
        WHERE tenant_id = ${journal.tenant_id}
          AND pricing_plan_id = ${r.pricing_plan_id} AND date = ${r.date}`;
    }
  }
});

console.log(`\n✓ undid ${count("DELETE") + count("RESTORE")} of ${plan.length} rows.`);
if (count("SKIP")) {
  console.log(`${count("SKIP")} row(s) were left alone and the journal is KEPT so they can be`);
  console.log(`inspected: ${JOURNAL}`);
} else {
  unlinkSync(JOURNAL);
  console.log("journal removed.");
}
await sql.end();
