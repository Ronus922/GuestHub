#!/usr/bin/env node
// Stage 2 smoke test: exercise the real GuestHub app + worker data paths against
// the dedicated staging DB as the least-privilege runtime role (guesthub_app).
// Proves the dedicated environment serves the product's actual query shapes and
// that guesthub_app has exactly the privileges the runtime needs (DML + EXECUTE),
// without booting live integrations. All writes run in a rolled-back transaction.
//
// Usage: SMOKE_DATABASE_URL=$STAGING_APP_URL node scripts/db/smoke-staging.mjs
import postgres from "postgres";

const url = process.env.SMOKE_DATABASE_URL;
if (!url) { console.error("need SMOKE_DATABASE_URL (the guesthub_app staging DSN)"); process.exit(2); }
const sql = postgres(url, { prepare: true, max: 2, idle_timeout: 5 });

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m, e) => { failures++; console.log(`  ✗ ${m}: ${e?.message ?? e}`); };

try {
  // 1. Core reads (the shapes dashboards/lists use) --------------------------
  const [{ current_user: who }] = await sql`select current_user`;
  console.log(`connected as ${who}`);
  for (const t of ["tenants", "rooms", "reservations", "reservation_rooms",
                   "pricing_plan_rates", "payments", "guests", "channel_sync_jobs"]) {
    try { const r = await sql.unsafe(`select count(*)::int c from guesthub.${t}`); ok(`read ${t} (${r[0].c})`); }
    catch (e) { bad(`read ${t}`, e); }
  }

  // 2. Reservation list join (real query shape) -----------------------------
  try {
    const r = await sql`
      select r.id, r.status, count(rr.id) rooms
      from guesthub.reservations r
      left join guesthub.reservation_rooms rr on rr.reservation_id = r.id
      group by r.id limit 5`;
    ok(`reservation+rooms join (${r.length} rows)`);
  } catch (e) { bad("reservation join", e); }

  // 3. EXECUTE the canonical availability function ---------------------------
  try {
    const [t] = await sql`select id from guesthub.tenants limit 1`;
    const rooms = await sql`select id from guesthub.rooms limit 3`;
    if (t && rooms.length) {
      const ids = rooms.map((x) => x.id);
      const avail = await sql`select * from guesthub.check_room_availability(
        ${t.id}::uuid, ${ids}::uuid[], current_date, (current_date + 2), ${[]}::uuid[])`;
      ok(`check_room_availability EXECUTE (${avail.length} rows)`);
    } else ok("check_room_availability skipped (no data)");
  } catch (e) { bad("check_room_availability", e); }

  // 4. Worker job-claim query (FOR UPDATE SKIP LOCKED), rolled back ----------
  try {
    await sql.begin(async (tx) => {
      await tx`select c.id from guesthub.channel_sync_jobs c
               order by c.priority, c.created_at for update skip locked limit 1`;
      throw new Error("__rollback__");
    }).catch((e) => { if (e.message !== "__rollback__") throw e; });
    ok("worker claim SELECT ... FOR UPDATE SKIP LOCKED");
  } catch (e) { bad("worker claim", e); }

  // 5. Worker heartbeat upsert + a DML write, all rolled back ----------------
  try {
    await sql.begin(async (tx) => {
      await tx`insert into guesthub.channel_worker_state (id, worker_id, beat_at)
               values ('singleton','smoke-test', now())
               on conflict (id) do update set worker_id=excluded.worker_id, beat_at=excluded.beat_at`;
      throw new Error("__rollback__");
    }).catch((e) => { if (e.message !== "__rollback__") throw e; });
    ok("worker heartbeat upsert (DML, rolled back)");
  } catch (e) { bad("worker heartbeat", e); }

  // 6. app must NOT be able to DDL ------------------------------------------
  try {
    await sql`create table guesthub.zz_smoke_should_fail(id int)`;
    bad("privilege boundary", "DDL unexpectedly SUCCEEDED");
    await sql`drop table if exists guesthub.zz_smoke_should_fail`;
  } catch { ok("DDL correctly denied to guesthub_app"); }

} finally { await sql.end(); }

console.log(failures ? `\nSMOKE FAILED (${failures})` : "\nSMOKE PASSED");
process.exit(failures ? 1 : 0);
