#!/usr/bin/env node
// ============================================================
// seed-restriction-ladder — MANUAL test data for the calendar's day-cell
// priority ladder (src/lib/rates/cell-mark.ts). NOT a guard, NOT a migration:
// nothing calls this, and nothing should. It exists so a human can open the
// calendar and SEE the rungs the live data cannot currently show.
//
// THE ONE RULE THIS SCRIPT OBEYS: IT NEVER TURNS A RESTRICTION OFF.
// The previous revision switched the STRONGER flags off on the dates it seeded,
// so that the weaker rung it wanted to demonstrate would win. That is a script
// that lifts real commercial closures off real room-nights to make a screenshot
// look right — the room becomes sellable, and the only trace is a journal in
// /tmp. It is gone. This revision instead SEARCHES for dates that are already
// clean and writes only there, so every write it makes is purely additive:
//
//   a date qualifies only when ALL SIX restriction fields are free —
//     stop_sell = false, closed_to_arrival = false, closed_to_departure = false,
//     min_stay_arrival ∈ {NULL, 1}, min_stay_through ∈ {NULL, 1},
//     max_stay ∈ {NULL, 0}
//   (NULL/0/1 are the "no limit" readings, D104 — see stayLimit in
//   src/lib/rates/rules.ts. A date with a row is judged on its stored values; a
//   date with NO row at all is clean by definition and gets one inserted.)
//
// Anything else is SKIPPED and named in the output. If four clean dates cannot
// be found, the script writes nothing at all rather than settle for a date it
// would have to clear first.
//
// WHAT IT SEEDS — one room, four separate clean dates, one reading each:
//   cell 1  min_stay_arrival = 3               → 🌙 3      (a floor)
//   cell 2  max_stay = 7                       → 🌙 1–7    (a ceiling)
//   cell 3  min_stay_arrival = 3 + max_stay = 7 → 🌙 3–7    (a window — the case
//           that used to show the ceiling only, with the floor invisible)
//   cell 4  closed_to_arrival = true           → the corner lock
//
// The writes land on the room's SU BASE plan (pricing_plans.is_base), because
// that is the only plan the calendar strip reads (calendar/data.ts).
//
// TWO THINGS TO KNOW BEFORE RUNNING IT ON THE LIVE DB
//   1. These are REAL commercial restrictions on REAL room-nights. A
//      closed-to-arrival room-night cannot be sold to an arriving guest without
//      the 084 override, and a minimum of 3 turns away a two-night booking.
//      Undo it with scripts/unseed-restriction-ladder.mjs as soon as you have
//      looked. Nothing here is un-restricted by the seed, so the undo only ever
//      has to REMOVE what the seed added.
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
// Optional: LADDER_ROOM (room number), LADDER_HORIZON (days to search, default 60),
//           LADDER_JOURNAL (path)
// ============================================================
import postgres from "postgres";
import { parseDbTarget, PROD_MARKERS } from "./lib/e2e-write-guard.mjs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
const ARMED = process.env.SEED_RESTRICTION_LADDER === "1";
const JOURNAL = process.env.LADDER_JOURNAL || join(tmpdir(), "guesthub-restriction-ladder-seed.json");
const HORIZON = Number(process.env.LADDER_HORIZON || 60);

// The six fields that decide "is this date clean", and the ONLY six the seed
// and the undo ever read or write. Kept in one list so the qualifier, the
// journal and the undo cannot drift apart.
const FIELDS = [
  "stop_sell",
  "closed_to_arrival",
  "closed_to_departure",
  "min_stay_arrival",
  "min_stay_through",
  "max_stay",
];

// The four cells, in ladder order of what they demonstrate. Every value here is
// a restriction being switched ON; there is deliberately no way to express
// "off" in this table, which is what makes the no-clearing rule structural
// rather than a promise in a comment.
const CELLS = [
  { label: "floor  — 🌙 3", patch: { min_stay_arrival: 3 } },
  { label: "ceiling— 🌙 1–7", patch: { max_stay: 7 } },
  { label: "window — 🌙 3–7", patch: { min_stay_arrival: 3, max_stay: 7 } },
  { label: "lock   — CTA", patch: { closed_to_arrival: true } },
];
for (const c of CELLS) {
  for (const [col, v] of Object.entries(c.patch)) {
    if (v === false || v === null || v === 0) throw new Error(`patch ${col} would CLEAR a restriction`);
  }
}

// Say out loud WHICH database this is about to touch. The seed is deliberately
// allowed to run against production (that is the whole point — the live
// calendar is where the ladder is looked at), so unlike scripts/seed.mjs it
// does not refuse; it names the target instead. parseDbTarget never returns
// the password.
const TARGET = parseDbTarget(process.env.DATABASE_URL);
const IS_PROD = PROD_MARKERS.some((m) => (process.env.DATABASE_URL || "").includes(m));
console.log(`database: ${TARGET.user}@${TARGET.host}:${TARGET.port}/${TARGET.db}${IS_PROD ? "   ** PRODUCTION **" : ""}`);

const [tenant] = await sql`
  SELECT id, name, COALESCE(timezone, 'Asia/Jerusalem') AS timezone
  FROM guesthub.tenants ORDER BY created_at LIMIT 1`;
if (!tenant) throw new Error("no tenant");

const [{ today }] = await sql`SELECT (now() AT TIME ZONE ${tenant.timezone})::date::text AS today`;
const dates = Array.from({ length: HORIZON }, (_, i) => {
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

const wanted = process.env.LADDER_ROOM;
const room = wanted
  ? candidates.find((c) => String(c.room_number) === String(wanted))
  : candidates[0];
if (!room) {
  throw new Error(
    wanted
      ? `room ${wanted} is not an active room with a base plan`
      : "no active room with a base plan — pass LADDER_ROOM",
  );
}

console.log(`tenant:  ${tenant.name} (${tenant.timezone})`);
console.log(`room:    ${room.room_number}`);
console.log(`today:   ${today}   searching ${dates[0]} … ${dates[dates.length - 1]}  (${HORIZON} days)`);
console.log(`journal: ${JOURNAL}\n`);

// ---- read every existing row in the horizon, then judge each date ----
const existing = await sql`
  SELECT date::text AS date, stop_sell, closed_to_arrival, closed_to_departure,
         min_stay_arrival, min_stay_through, max_stay
  FROM guesthub.pricing_plan_rates
  WHERE tenant_id = ${tenant.id}
    AND pricing_plan_id = ${room.plan_id}
    AND date = ANY(${dates}::date[])`;
const rows = new Map(existing.map((r) => [r.date, r]));

// WHY a date is not clean — reported, so a run that finds too few dates says
// what is in the way instead of just refusing.
const dirtyReasons = (r) => {
  if (!r) return []; // no row at all: nothing is set, so nothing is dirty
  const why = [];
  if (r.stop_sell) why.push("stop_sell");
  if (r.closed_to_arrival) why.push("CTA");
  if (r.closed_to_departure) why.push("CTD");
  // NULL and 1 are both "no minimum"; anything else is a real floor (D104)
  if (r.min_stay_arrival != null && r.min_stay_arrival > 1) why.push(`min_arrival=${r.min_stay_arrival}`);
  if (r.min_stay_through != null && r.min_stay_through > 1) why.push(`min_through=${r.min_stay_through}`);
  // NULL and 0 are both "no maximum"
  if (r.max_stay != null && r.max_stay > 0) why.push(`max_stay=${r.max_stay}`);
  return why;
};

const clean = [];
const skipped = [];
for (const date of dates) {
  const why = dirtyReasons(rows.get(date));
  if (why.length === 0) clean.push(date);
  else skipped.push({ date, why });
  if (clean.length === CELLS.length) break;
}

if (skipped.length) {
  console.log(`skipped ${skipped.length} date(s) that already carry a restriction — the seed never clears one:`);
  for (const s of skipped) console.log(`  ${s.date}  ${s.why.join(", ")}`);
  console.log("");
}

if (clean.length < CELLS.length) {
  console.error(
    `only ${clean.length} clean date(s) in the next ${HORIZON} days, ${CELLS.length} needed.`,
  );
  console.error("NOTHING WAS WRITTEN. Widen the search with LADDER_HORIZON=<days>, or pass");
  console.error("LADDER_ROOM=<room> to try a room whose calendar is emptier. The seed will not");
  console.error("clear an existing restriction to make room for itself.");
  await sql.end();
  process.exit(1);
}

function defaultOf(field) {
  // matches migration 009: the three booleans are NOT NULL DEFAULT false, the
  // three integers are nullable with no default
  return field === "stop_sell" || field === "closed_to_arrival" || field === "closed_to_departure"
    ? false
    : null;
}

const targets = clean.map((date, i) => {
  const prior = rows.get(date) ?? null;
  const cell = CELLS[i];
  // the state the row will hold AFTER the write — the clean baseline with the
  // patch applied. The undo compares the live row against exactly this.
  const seeded = Object.fromEntries(
    FIELDS.map((f) => [f, f in cell.patch ? cell.patch[f] : (prior ? prior[f] : defaultOf(f))]),
  );
  return { date, cell, prior, seeded };
});

// ---- print EXACTLY what will be touched, before touching anything ----
const fmt = (v) => (v === null || v === undefined ? "—" : String(v));
console.log("rows to touch:");
console.log("  date        action  demonstrates      change");
for (const t of targets) {
  const change = Object.entries(t.cell.patch)
    .map(([col, v]) => `${col}: ${fmt(t.prior ? t.prior[col] : null)} → ${fmt(v)}`)
    .join(", ");
  console.log(`  ${t.date}  ${(t.prior ? "UPDATE" : "INSERT").padEnd(6)}  ${t.cell.label.padEnd(16)}  ${change}`);
}
const inserts = targets.filter((t) => !t.prior).length;
console.log(`\n${targets.length} rows: ${inserts} INSERT, ${targets.length - inserts} UPDATE`);
console.log("Only the columns listed under `change` are written. price and every restriction");
console.log("field not named there keep their current values; a new row gets a NULL price and");
console.log("the cell falls back to the room type's base price, as it does today.");

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
      room: room.room_number,
      fields: FIELDS,
      rows: targets.map((t) => ({
        pricing_plan_id: room.plan_id,
        sellable_unit_id: room.su_id,
        date: t.date,
        existed: t.prior != null,
        prior: t.prior && Object.fromEntries(FIELDS.map((f) => [f, t.prior[f]])),
        seeded: t.seeded, // what the row must still hold for the undo to touch it
      })),
    },
    null,
    2,
  ),
);
console.log(`\njournal written: ${JOURNAL}`);

await sql.begin(async (tx) => {
  for (const t of targets) {
    // The write names the seeded state of all six fields, but every value that
    // is not in the patch is the row's OWN current value (or the column
    // default on an insert) — so no field is cleared, only the patch is added.
    const s = t.seeded;
    await tx`
      INSERT INTO guesthub.pricing_plan_rates
        (tenant_id, sellable_unit_id, pricing_plan_id, date,
         stop_sell, closed_to_arrival, closed_to_departure,
         min_stay_arrival, min_stay_through, max_stay)
      VALUES (${tenant.id}, ${room.su_id}, ${room.plan_id}, ${t.date},
              ${s.stop_sell}, ${s.closed_to_arrival}, ${s.closed_to_departure},
              ${s.min_stay_arrival}, ${s.min_stay_through}, ${s.max_stay})
      ON CONFLICT (pricing_plan_id, date) DO UPDATE SET
        stop_sell = EXCLUDED.stop_sell,
        closed_to_arrival = EXCLUDED.closed_to_arrival,
        closed_to_departure = EXCLUDED.closed_to_departure,
        min_stay_arrival = EXCLUDED.min_stay_arrival,
        min_stay_through = EXCLUDED.min_stay_through,
        max_stay = EXCLUDED.max_stay,
        updated_at = now()`;
  }
});

console.log(`\n✓ seeded ${targets.length} rows on room ${room.room_number}.`);
console.log(`undo:  LADDER_JOURNAL=${JOURNAL} node --env-file=.env.local scripts/unseed-restriction-ladder.mjs`);
await sql.end();
