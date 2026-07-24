// Beds24 integration guard #3 — inbound revision freshness + hygiene (read-only).
// The pull runs every ~5 minutes; a stale last-success means guests are booking
// on Beds24 and nothing is arriving. Quarantined/unresolved revisions are the
// silent data-loss channel — they must be zero or explicitly known.
// Thresholds: last succeeded pull ≤ 30 minutes ago; zero revisions stuck
// un-imported for more than 1 hour; zero unacknowledged imports older than 1 hour.
// Usage: node --env-file=.env.local scripts/check-beds24-revisions.mjs
import postgres from "postgres";
import assert from "node:assert/strict";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

try {
  const [pull] = await sql`
    SELECT max(j.finished_at) AS last
    FROM guesthub.channel_sync_jobs j
    JOIN guesthub.channel_connections cc ON cc.id = j.connection_id
    WHERE cc.provider = 'beds24' AND j.job_type = 'pull_booking_revisions'
      AND j.status = 'succeeded'`;
  assert.ok(pull.last, "no succeeded pull_booking_revisions ever recorded");
  const ageMin = (Date.now() - new Date(pull.last).getTime()) / 60_000;
  assert.ok(ageMin <= 30, `last succeeded pull is ${ageMin.toFixed(0)} minutes old (cadence is ~5m, threshold 30m)`);
  ok(`last succeeded pull ${ageMin.toFixed(1)} minutes ago`);

  const dist = await sql`
    SELECT import_status, COALESCE(ack_status, '-') AS ack_status, count(*)::int AS c
    FROM guesthub.channel_booking_revisions
    GROUP BY import_status, ack_status ORDER BY 1, 2`;
  for (const d of dist) console.log(`  · revisions ${d.import_status}/${d.ack_status}: ${d.c}`);

  const [stuck] = await sql`
    SELECT count(*)::int AS c FROM guesthub.channel_booking_revisions
    WHERE import_status <> 'imported' AND created_at < now() - interval '1 hour'`;
  assert.equal(stuck.c, 0, `${stuck.c} revisions stuck un-imported for over 1h (quarantine/mapping errors?)`);
  ok("zero revisions stuck un-imported > 1h");

  const [unacked] = await sql`
    SELECT count(*)::int AS c FROM guesthub.channel_booking_revisions
    WHERE import_status = 'imported' AND ack_status IS DISTINCT FROM 'acknowledged'
      AND created_at < now() - interval '1 hour'`;
  assert.equal(unacked.c, 0, `${unacked.c} imported revisions unacknowledged > 1h`);
  ok("zero imported-but-unacknowledged revisions > 1h");

  console.log(`\nBEDS24 REVISIONS CHECK: ${n} PASSED`);
} catch (e) {
  console.error(`BEDS24 REVISIONS CHECK FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
