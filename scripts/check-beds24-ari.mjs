// Beds24 integration guard #4 — outbound ARI freshness (read-only).
// Every commercial write marks channel_dirty_ranges; the worker drains them
// into sync_ari_range pushes. A pending range that survives hours means Beds24
// is selling on stale availability/rates — the exact overbooking recipe.
// Thresholds (scoped to the ACTIVE beds24 connection only — paused legacy
// connections keep inert rows by design): zero non-synced ranges older than 2h;
// at least one succeeded sync_ari_range in the last 24h IF anything was dirty.
// Usage: node --env-file=.env.local scripts/check-beds24-ari.mjs
import postgres from "postgres";
import assert from "node:assert/strict";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

try {
  const [stale] = await sql`
    SELECT count(*)::int AS c, min(dr.created_at) AS oldest
    FROM guesthub.channel_dirty_ranges dr
    JOIN guesthub.channel_connections cc ON cc.id = dr.connection_id
    WHERE cc.provider = 'beds24' AND cc.state = 'active'
      AND dr.status <> 'synced' AND dr.created_at < now() - interval '2 hours'`;
  assert.equal(stale.c, 0,
    `${stale.c} beds24 dirty ranges pending > 2h (oldest ${stale.oldest}) — ARI drain is stuck`);
  ok("zero beds24 dirty ranges pending > 2h");

  const [live] = await sql`
    SELECT count(*)::int AS c FROM guesthub.channel_dirty_ranges dr
    JOIN guesthub.channel_connections cc ON cc.id = dr.connection_id
    WHERE cc.provider = 'beds24' AND cc.state = 'active' AND dr.status <> 'synced'`;
  console.log(`  · beds24 ranges currently in-flight (< 2h, worker will drain): ${live.c}`);

  const [syncs] = await sql`
    SELECT count(*)::int AS c
    FROM guesthub.channel_sync_jobs j
    JOIN guesthub.channel_connections cc ON cc.id = j.connection_id
    WHERE cc.provider = 'beds24' AND j.job_type IN ('sync_ari_range', 'full_sync')
      AND j.status = 'succeeded' AND j.finished_at >= now() - interval '24 hours'`;
  const [dirtied] = await sql`
    SELECT count(*)::int AS c FROM guesthub.channel_dirty_ranges dr
    JOIN guesthub.channel_connections cc ON cc.id = dr.connection_id
    WHERE cc.provider = 'beds24' AND dr.created_at >= now() - interval '24 hours'`;
  if (dirtied.c > 0) {
    assert.ok(syncs.c >= 1, `${dirtied.c} ranges dirtied in 24h but zero succeeded ARI pushes`);
    ok(`ARI pushing: ${syncs.c} succeeded pushes against ${dirtied.c} dirtied ranges in 24h`);
  } else {
    console.log(`  · nothing dirtied in 24h (${syncs.c} pushes ran) — freshness vacuously OK`);
    n++;
  }

  // informational: inert leftovers on paused legacy connections (not a failure)
  const [inert] = await sql`
    SELECT count(*)::int AS c FROM guesthub.channel_dirty_ranges dr
    LEFT JOIN guesthub.channel_connections cc ON cc.id = dr.connection_id
    WHERE dr.status <> 'synced' AND (cc.state IS DISTINCT FROM 'active')`;
  if (inert.c > 0) console.log(`  · note: ${inert.c} inert non-synced ranges on paused legacy connections (cleanup candidate, not an error)`);

  console.log(`\nBEDS24 ARI CHECK: ${n} PASSED`);
} catch (e) {
  console.error(`BEDS24 ARI CHECK FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
