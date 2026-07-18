#!/usr/bin/env node
// check:inventory-integrity (Stage 3) — read-only invariant guard on inventory /
// double-booking data. Complements check:reservation-concurrency (which proves
// the constraint under load); this asserts the live/staging data obeys the
// invariants and that the is_blocking machinery is consistent.
//
// Target: CHECK_DB_URL or STAGING_DATABASE_URL (read-only, SELECT only).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function loadEnvStaging() {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.staging");
    for (const l of readFileSync(p, "utf8").split("\n")) { const m=l.match(/^([A-Z_]+)=(.*)$/); if(m&&!process.env[m[1]])process.env[m[1]]=m[2]; }
  } catch {}
}
loadEnvStaging();
const url = process.env.CHECK_DB_URL || process.env.STAGING_DATABASE_URL;
if (!url) { console.error("need CHECK_DB_URL or STAGING_DATABASE_URL"); process.exit(2); }
const q = (sql) => execFileSync("psql", [url, "-tAc", sql, "-X"], { encoding: "utf8" }).trim();
let fail = 0; const ok=(m)=>console.log(`  ✓ ${m}`); const bad=(m,d)=>{fail++;console.log(`  ✗ ${m}${d?": "+d:""}`);};

// 1. the exclusion constraint exists
const hasCon = q(`select count(*) from pg_constraint where conname='rr_no_double_booking'`);
hasCon==="1" ? ok("rr_no_double_booking exclusion constraint present") : bad("exclusion constraint missing");

// 2. no two BLOCKING stays overlap on the same room (half-open) — data obeys it
const overlaps = q(`
  select count(*) from guesthub.reservation_rooms a
  join guesthub.reservation_rooms b
    on a.room_id = b.room_id and a.id < b.id
   and a.is_blocking and b.is_blocking
   and daterange(a.check_in,a.check_out,'[)') && daterange(b.check_in,b.check_out,'[)')`);
overlaps==="0" ? ok("no overlapping blocking stays in data") : bad("overlapping blocking stays", overlaps);

// 3. is_blocking is consistent with (room_id set AND parent status ∈ blocking set)
const inconsistent = q(`
  select count(*) from guesthub.reservation_rooms rr
  join guesthub.reservations r on r.id = rr.reservation_id
  where rr.is_blocking <> ((rr.room_id is not null) and r.status = any(guesthub.inventory_blocking_statuses()))`);
inconsistent==="0" ? ok("is_blocking flag consistent with parent status") : bad("is_blocking drift", inconsistent);

// 4. no blocking row without a room
const blockingNoRoom = q(`select count(*) from guesthub.reservation_rooms where is_blocking and room_id is null`);
blockingNoRoom==="0" ? ok("no blocking row lacks a room") : bad("blocking rows without room", blockingNoRoom);

// 5. stay ranges are valid (check_out > check_in) — enforced by CHECK, verify data
const badRanges = q(`select count(*) from guesthub.reservation_rooms where check_out <= check_in`);
badRanges==="0" ? ok("all stays have check_out > check_in") : bad("invalid stay ranges", badRanges);

// 6. reservations.status CHECK present (H2)
const hasStatusCheck = q(`select count(*) from pg_constraint where conname='reservations_status_check'`);
hasStatusCheck==="1" ? ok("reservations_status_check present") : bad("status CHECK missing");

console.log(fail ? `\ncheck:inventory-integrity FAILED (${fail})` : "\ncheck:inventory-integrity PASSED");
process.exit(fail?1:0);
