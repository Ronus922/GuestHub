#!/usr/bin/env node
// ============================================================
// seed-restriction-ladder — MANUAL test data for the calendar's day-cell
// priority ladder (src/lib/rates/cell-mark.ts). NOT a guard, NOT a migration:
// nothing calls this, and nothing should. It exists so a human can open the
// calendar and SEE the two rungs the live data cannot currently show.
//
// WHAT IT SEEDS, and why exactly this:
//   room A → max_stay = 3      the FOURTH rung. Not one row in the whole
//                              system carries a max_stay today, so the lock
//                              that rung draws has never been seen on a real
//                              cell. Expect: the corner lock, no other mark.
//   room B → closed_to_arrival = true AND stop_sell = true
//                              rungs 2 and 1 on the same cell. Expect: the
//                              "סגור" flag with the struck price and NOTHING
//                              else — the CTA is silent on the cell (it is
//                              still listed in the hover card). This is the
//                              whole point of the ladder, in one cell.
//
// Both writes land on the SU's BASE plan (pricing_plans.is_base), because that
// is the only plan the calendar strip reads (calendar/data.ts).
//
// TWO THINGS TO KNOW BEFORE RUNNING IT ON THE LIVE DB
//   1. These are REAL commercial restrictions on REAL room-nights in the next
//      seven days. A stop-sold, closed-to-arrival room-night cannot be sold by
//      the front desk without the 084 override. Undo it with
//      scripts/unseed-restriction-ladder.mjs as soon as you have looked.
//   2. It writes SQL directly, so it does NOT mark a channel dirty range the
//      way the app's own rate save does (lib/channel/outbox.ts is application
//      code, not a DB trigger). The restrictions therefore stay local and are
//      NOT pushed to Beds24 — but a later legitimate edit covering the same
//      dates WOULD push whatever it finds there. Another reason to clean up.
//
// It prints every row it would touch and writes NOTHING unless
// SEED_RESTRICTION_LADDER=1 is set. Without it: a dry run.
//
// Usage:
//   node --env-file=.env.local scripts/seed-restriction-ladder.mjs           # dry run
//   SEED_RESTRICTION_LADDER=1 node --env-file=.env.local scripts/seed-restriction-ladder.mjs
// Optional: LADDER_ROOM_A / LADDER_ROOM_B (room numbers), LADDER_JOURNAL (path)
// ============================================================
import postgres from "postgres";
import { parseDbTarget, PROD_MARKERS } from "./lib/e2e-write-guard.mjs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
const ARMED = process.env.SEED_RESTRICTION_LADDER === "1";
const JOURNAL = process.env.LADDER_JOURNAL || join(tmpdir(), "guesthub-restriction-ladder-seed.json");
const DAYS = 7;

// Say out loud WHICH database this is about to touch. The seed is deliberately
// allowed to run against production (that is the whole point — the live
// calendar is where the ladder is looked at), so unlike scripts/seed.mjs it
// does not refuse; it names the target instead. parseDbTarget never returns
// the password.
const TARGET = parseDbTarget(process.env.DATABASE_URL);
const IS_PROD = PROD_MARKERS.some((m) => (process.env.DATABASE_URL || "").includes(m));
console.log(`database: ${TARGET.user}@${TARGET.host}:${TARGET.port}/${TARGET.db}${IS_PROD ? "   ** PRODUCTION **" : ""}`);

// the two patches, exactly as documented in the header
const PATCH_A = { max_stay: 3, stop_sell: false, closed_to_arrival: false, closed_to_departure: false };
const PATCH_B = { stop_sell: true, closed_to_arrival: true, closed_to_departure: false, max_stay: null };
// NOTE both patches also switch the STRONGER rungs off (A) / set them (B)
// explicitly. A patch that only set max_stay would be invisible on any date
// that already carried a stop-sell, and the point of the seed is to see the
// rung it names.

const [tenant] = await sql`
  SELECT id, name, COALESCE(timezone, 'Asia/Jerusalem') AS timezone
  FROM guesthub.tenants ORDER BY created_at LIMIT 1`;
if (!tenant) throw new Error("no tenant");

const [{ today }] = await sql`SELECT (now() AT TIME ZONE ${tenant.timezone})::date::text AS today`;
const dates = Array.from({ length: DAYS }, (_, i) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
});

// Candidate rooms: active, sellable, member of an SU that HAS a base plan —
// anything else has no row for the calendar strip to read.
const candidates = await sql`
  SELECT r.id AS room_id, r.room_number, su.id AS su_id, bp.id AS plan_id
  FROM guesthub.rooms r
  JOIN guesthub.sellable_unit_rooms sur ON sur.room_id = r.id
  JOIN guesthub.sellable_units su ON su.id = sur.sellable_unit_id
  JOIN guesthub.pricing_plans bp ON bp.sellable_unit_id = su.id AND bp.is_base
  WHERE r.tenant_id = ${tenant.id} AND r.is_active AND r.status = 'available'
  ORDER BY r.room_number`;

const pick = (wanted, fallbackIdx) => {
  if (wanted) {
    const hit = candidates.find((c) => String(c.room_number) === String(wanted));
    if (!hit) throw new Error(`room ${wanted} is not an active room with a base plan`);
    return hit;
  }
  const hit = candidates[fallbackIdx];
  if (!hit) throw new Error(`fewer than ${fallbackIdx + 1} eligible rooms — pass LADDER_ROOM_A/B`);
  return hit;
};
const roomA = pick(process.env.LADDER_ROOM_A, 0);
const roomB = pick(process.env.LADDER_ROOM_B, 1);
if (roomA.room_id === roomB.room_id) throw new Error("room A and room B must differ");

console.log(`tenant:  ${tenant.name} (${tenant.timezone})`);
console.log(`today:   ${today}   window: ${dates[0]} … ${dates[dates.length - 1]}  (${DAYS} days)`);
console.log(`room A:  ${roomA.room_number}  → max_stay=3            (rung 4: expect the corner lock)`);
console.log(`room B:  ${roomB.room_number}  → stop_sell + CTA       (rungs 1+2: expect ONLY "סגור")`);
console.log(`journal: ${JOURNAL}\n`);

// ---- read the CURRENT state of every row we are about to touch ----
const planIds = [roomA.plan_id, roomB.plan_id];
const existing = await sql`
  SELECT pricing_plan_id, date::text AS date, price::text AS price,
         min_stay_through, min_stay_arrival, max_stay,
         closed_to_arrival, closed_to_departure, stop_sell
  FROM guesthub.pricing_plan_rates
  WHERE tenant_id = ${tenant.id}
    AND pricing_plan_id = ANY(${planIds}::uuid[])
    AND date = ANY(${dates}::date[])`;
const before = new Map(existing.map((r) => [`${r.pricing_plan_id}|${r.date}`, r]));

const targets = [];
for (const [room, patch] of [[roomA, PATCH_A], [roomB, PATCH_B]]) {
  for (const date of dates) {
    const key = `${room.plan_id}|${date}`;
    targets.push({ room, date, key, patch, prior: before.get(key) ?? null });
  }
}

// ---- print EXACTLY what will be touched, before touching anything ----
const fmt = (v) => (v === null || v === undefined ? "—" : String(v));
console.log("rows to touch:");
console.log("  room  date        action  max_stay      stop_sell     CTA           CTD");
for (const t of targets) {
  const p = t.prior;
  const cell = (col, next) => `${fmt(p?.[col])}→${fmt(next)}`.padEnd(13);
  console.log(
    `  ${String(t.room.room_number).padEnd(5)} ${t.date}  ${(p ? "UPDATE" : "INSERT").padEnd(6)}  ` +
    cell("max_stay", t.patch.max_stay) + cell("stop_sell", t.patch.stop_sell) +
    cell("closed_to_arrival", t.patch.closed_to_arrival) + cell("closed_to_departure", t.patch.closed_to_departure),
  );
}
const inserts = targets.filter((t) => !t.prior).length;
console.log(`\n${targets.length} rows: ${inserts} INSERT, ${targets.length - inserts} UPDATE`);
console.log("price and the min-stay fields are left exactly as they are (a new row gets a NULL");
console.log("price and the cell falls back to the room type's base price, as it does today).");

if (!ARMED) {
  console.log("\nDRY RUN — nothing was written.");
  console.log("To write, re-run with:  SEED_RESTRICTION_LADDER=1 node --env-file=.env.local scripts/seed-restriction-ladder.mjs");
  await sql.end();
  process.exit(0);
}

// ---- journal FIRST, so the undo exists before the change does ----
writeFileSync(
  JOURNAL,
  JSON.stringify(
    {
      tenant_id: tenant.id,
      seeded_at_today: today,
      rooms: { a: roomA.room_number, b: roomB.room_number },
      rows: targets.map((t) => ({
        pricing_plan_id: t.room.plan_id,
        sellable_unit_id: t.room.su_id,
        date: t.date,
        prior: t.prior, // null = the row did not exist → the undo deletes it
      })),
    },
    null,
    2,
  ),
);
console.log(`\njournal written: ${JOURNAL}`);

await sql.begin(async (tx) => {
  for (const t of targets) {
    await tx`
      INSERT INTO guesthub.pricing_plan_rates
        (tenant_id, sellable_unit_id, pricing_plan_id, date,
         max_stay, stop_sell, closed_to_arrival, closed_to_departure)
      VALUES (${tenant.id}, ${t.room.su_id}, ${t.room.plan_id}, ${t.date},
              ${t.patch.max_stay}, ${t.patch.stop_sell},
              ${t.patch.closed_to_arrival}, ${t.patch.closed_to_departure})
      ON CONFLICT (pricing_plan_id, date) DO UPDATE SET
        max_stay = EXCLUDED.max_stay,
        stop_sell = EXCLUDED.stop_sell,
        closed_to_arrival = EXCLUDED.closed_to_arrival,
        closed_to_departure = EXCLUDED.closed_to_departure,
        updated_at = now()`;
  }
});

console.log(`\n✓ seeded ${targets.length} rows.`);
console.log(`undo:  LADDER_JOURNAL=${JOURNAL} node --env-file=.env.local scripts/unseed-restriction-ladder.mjs`);
await sql.end();
