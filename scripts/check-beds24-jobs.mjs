// Beds24 integration guard #2 — job health over the last 24h (read-only).
// The worker's two live job types must both be flowing and near-perfect:
//  · pull_booking_revisions — the inbound feed (~5-minute cadence)
//  · sync_ari_range — the outbound ARI drain (fires whenever ranges dirty)
// Thresholds: at least one succeeded pull; failure share per job type ≤ 10%;
// and zero jobs stuck for a non-beds24 provider (D91: nothing else may run).
// Usage: node --env-file=.env.local scripts/check-beds24-jobs.mjs
import postgres from "postgres";
import assert from "node:assert/strict";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

try {
  const rows = await sql`
    SELECT j.job_type, j.status, count(*)::int AS c
    FROM guesthub.channel_sync_jobs j
    JOIN guesthub.channel_connections cc ON cc.id = j.connection_id
    WHERE cc.provider = 'beds24' AND j.finished_at >= now() - interval '24 hours'
    GROUP BY j.job_type, j.status`;

  const by = new Map();
  for (const r of rows) {
    const e = by.get(r.job_type) ?? { succeeded: 0, other: 0 };
    if (r.status === "succeeded") e.succeeded += r.c; else e.other += r.c;
    by.set(r.job_type, e);
  }

  const pulls = by.get("pull_booking_revisions") ?? { succeeded: 0, other: 0 };
  assert.ok(pulls.succeeded >= 1, "no succeeded pull_booking_revisions in the last 24h — inbound feed is dead");
  ok(`inbound feed alive: ${pulls.succeeded} succeeded pulls in 24h`);

  for (const [type, e] of by) {
    const total = e.succeeded + e.other;
    const share = total ? e.other / total : 0;
    assert.ok(share <= 0.1,
      `${type}: ${e.other}/${total} non-succeeded finishes in 24h (>10%)`);
    console.log(`  · ${type}: ${e.succeeded} ok, ${e.other} not-ok (${(share * 100).toFixed(1)}%)`);
  }
  ok("failure share ≤ 10% for every beds24 job type");

  // D91 cutover: the Channex/Stripe/Hospitable removal reached production at
  // 2026-07-24 18:45 UTC. Jobs that finished BEFORE it are legitimate history;
  // a single non-beds24 job finishing after it means a dead provider came back.
  const D91_CUTOVER = "2026-07-24T18:45:00Z";
  const [foreign] = await sql`
    SELECT count(*)::int AS c
    FROM guesthub.channel_sync_jobs j
    JOIN guesthub.channel_connections cc ON cc.id = j.connection_id
    WHERE cc.provider <> 'beds24' AND j.finished_at >= ${D91_CUTOVER}`;
  assert.equal(foreign.c, 0, `${foreign.c} non-beds24 jobs finished after the D91 cutover — a dead provider is running`);
  ok("zero non-beds24 jobs since the D91 cutover (2026-07-24 18:45 UTC)");

  console.log(`\nBEDS24 JOBS CHECK: ${n} PASSED`);
} catch (e) {
  console.error(`BEDS24 JOBS CHECK FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
