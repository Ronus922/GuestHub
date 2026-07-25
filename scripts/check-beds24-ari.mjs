#!/usr/bin/env node
// ============================================================
// check:beds24-ari — TARGET 2.7, rebuilt to the B2 standard.
//
// THIS IS THE ONE THAT WAS GREEN FOR NOTHING. Measured 2026-07-25 against the
// staging database, whose Beds24 integration does not exist (one `channex`
// connection, zero beds24 dirty ranges, zero beds24 jobs), the shipped guard
// printed:
//
//     ✓ zero beds24 dirty ranges pending > 2h
//     · nothing dirtied in 24h (0 pushes ran) — freshness vacuously OK
//     BEDS24 ARI CHECK: 2 PASSED            exit=0
//
// Both "passes" were produced by the ABSENCE of the thing being guarded: a
// count of 0 satisfies "no stale ranges", and the else-branch of the freshness
// test did `n++` and called it a pass. The guard was therefore green on an
// empty database, green on a healthy one, and — since it imported no
// application code — byte-identical green when the ARI predicates in
// src/lib/channel/ranges.ts were semantically neutered.
//
// WHAT IT IS NOW. Two rules (A1, A2) exercised in BOTH directions against
// STAGING, on counts read BACK out of the database, inside one transaction
// that is always rolled back:
//   · the dirty ranges are created by the SHIPPED markAriDirty() from
//     src/lib/channel/outbox.ts, so if that function stops marking, the ACCEPT
//     arm has nothing to read back and the guard goes red;
//   · A2's "nothing was dirtied" case is no longer a pass. It returns
//     applicable:false and is reported as SKIPPED — a skipped rule never
//     increments the pass count.
//
// HONEST LIMIT (docs/GUARD_BEDS24_FOUR_B2.md §findings): the live question
// "is the production ARI drain keeping up right now?" is a fact about
// production that no staging fixture can establish. `--observe` keeps that
// reading available, opt-in and unscored.
//
// Usage: node scripts/check-beds24-ari.mjs
//        node scripts/check-beds24-ari.mjs --observe   (ops probe)
// ============================================================
import assert from "node:assert/strict";
import postgres from "postgres";
import { resolveCheckDbUrl, redactDsn } from "./lib/check-db-target.mjs";
import {
  THRESHOLDS,
  ruleNoStaleDirtyRanges,
  ruleAriDrainKeepingUp,
} from "./lib/beds24-health-rules.mjs";
import {
  withRollback,
  countFixtureTables,
  assertNoNetRows,
  seedConnection,
  seedJob,
  seedDirtyRange,
  readStaleDirtyRanges,
  readDirtiedAndPushed,
  loadWorkerModules,
} from "./lib/beds24-staging-fixture.mjs";

const CHECK = "check:beds24-ari";
const OBSERVE = process.argv.includes("--observe");
const GRACE = THRESHOLDS.dirtyRangeGraceHours;
const url = resolveCheckDbUrl(CHECK);
const sql = postgres(url, { prepare: false, max: 1 });

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };
const skipped = (m) => console.log(`  ⊘ SKIPPED (not a pass) — ${m}`);
const expectAccept = (id, v) => {
  assert.ok(v.ok, `BEHAVIOUR BREACH — ${id} rejected a healthy fixture: ${v.detail}`);
  ok(`${id} accepts a healthy fixture — ${v.detail}`);
};
const expectReject = (id, v) => {
  assert.ok(!v.ok, `BEHAVIOUR BREACH — ${id} ACCEPTED a broken fixture (the rule detects nothing): ${v.detail}`);
  ok(`${id} rejects the matching defect — ${v.detail}`);
};
const expectContract = (id, cond, msg) => {
  assert.ok(cond, `CONTRACT BREACH (not a behaviour breach) — ${id}: ${msg}`);
  ok(`${id} [CONTRACT] ${msg}`);
};

const todayIso = () => new Date().toISOString().slice(0, 10);
const plusDaysIso = (d) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

try {
  if (OBSERVE) {
    console.log(`  · OBSERVE mode against ${redactDsn(url)} — this is a probe, not a guard`);
    const [stale] = await sql`
      SELECT count(*)::int AS c FROM guesthub.channel_dirty_ranges dr
      JOIN guesthub.channel_connections cc ON cc.id = dr.connection_id
      WHERE cc.provider = 'beds24' AND cc.state = 'active' AND dr.status <> 'synced'
        AND dr.created_at < now() - make_interval(hours => ${GRACE})`;
    const [dirtied] = await sql`
      SELECT count(*)::int AS c FROM guesthub.channel_dirty_ranges dr
      JOIN guesthub.channel_connections cc ON cc.id = dr.connection_id
      WHERE cc.provider = 'beds24' AND dr.created_at >= now() - interval '24 hours'`;
    const [pushed] = await sql`
      SELECT count(*)::int AS c FROM guesthub.channel_sync_jobs j
      JOIN guesthub.channel_connections cc ON cc.id = j.connection_id
      WHERE cc.provider = 'beds24' AND j.job_type IN ('sync_ari_range','full_sync')
        AND j.status = 'succeeded' AND j.finished_at >= now() - interval '24 hours'`;
    for (const r of [ruleNoStaleDirtyRanges(stale.c), ruleAriDrainKeepingUp(dirtied.c, pushed.c)]) {
      console.log(`  ${r.applicable === false ? "⊘" : r.ok ? "·" : "!"} ${r.detail}`);
    }
    console.log("\nOBSERVE COMPLETE (informational — no assertions were scored)");
  } else {
    const mods = loadWorkerModules(url);
    const before = await countFixtureTables(sql);

    await withRollback(sql, async (tx) => {
      // ---------- ACCEPT arm, built by the SHIPPED marker ----------
      const healthy = await seedConnection(tx, {});
      const { markAriDirty } = mods.outbox;
      await markAriDirty(tx, {
        tenantId: healthy.tenantId,
        roomIds: [healthy.roomId],
        dateFrom: todayIso(),
        dateTo: plusDaysIso(3),
      });
      const marked = await readDirtiedAndPushed(tx, healthy.tenantId);
      expectContract("A0", marked.dirtied >= 1,
        `the SHIPPED markAriDirty() actually wrote a dirty range (read back: ${marked.dirtied})`);

      // A successful ARI push in the window, then the ranges settle to synced.
      await seedJob(tx, healthy, {
        jobType: "sync_ari_range", status: "succeeded", finishedAgoSql: "interval '10 minutes'",
      });
      await tx`
        UPDATE guesthub.channel_dirty_ranges SET status = 'synced' WHERE tenant_id = ${healthy.tenantId}`;

      expectAccept("A1", ruleNoStaleDirtyRanges(await readStaleDirtyRanges(tx, healthy.tenantId, GRACE)));
      const settled = await readDirtiedAndPushed(tx, healthy.tenantId);
      expectAccept("A2", ruleAriDrainKeepingUp(settled.dirtied, settled.pushed));

      // ---------- REJECT arms ----------
      // A1 — a range marked by the shipped code and never drained, aged past
      // the grace window: Beds24 is now selling on stale availability.
      const stuck = await seedConnection(tx, {});
      await markAriDirty(tx, {
        tenantId: stuck.tenantId,
        roomIds: [stuck.roomId],
        dateFrom: todayIso(),
        dateTo: plusDaysIso(2),
      });
      await tx`
        UPDATE guesthub.channel_dirty_ranges
        SET created_at = now() - make_interval(hours => ${GRACE + 3}) WHERE tenant_id = ${stuck.tenantId}`;
      expectReject("A1", ruleNoStaleDirtyRanges(await readStaleDirtyRanges(tx, stuck.tenantId, GRACE)));

      // A2 — work was dirtied in the window and not one push succeeded.
      const nodrain = await seedConnection(tx, {});
      await markAriDirty(tx, {
        tenantId: nodrain.tenantId,
        roomIds: [nodrain.roomId],
        dateFrom: todayIso(),
        dateTo: plusDaysIso(1),
      });
      const starved = await readDirtiedAndPushed(tx, nodrain.tenantId);
      expectContract("A2-input", starved.dirtied >= 1 && starved.pushed === 0,
        `fixture reads back ${starved.dirtied} dirtied / ${starved.pushed} pushed`);
      expectReject("A2", ruleAriDrainKeepingUp(starved.dirtied, starved.pushed));

      // A2 — ANTI-VACUITY. This is the EXACT input that made the old guard
      // print "2 PASSED" against a database with no Beds24 integration: an
      // empty dirty-range history. It must now be NOT APPLICABLE, never a pass.
      const empty = await seedConnection(tx, {});
      const nothing = await readDirtiedAndPushed(tx, empty.tenantId);
      expectContract("A2-vacuity", nothing.dirtied === 0,
        "the anti-vacuity fixture really does read back zero dirtied ranges");
      const vacuous = ruleAriDrainKeepingUp(nothing.dirtied, nothing.pushed);
      assert.equal(vacuous.applicable, false,
        "BEHAVIOUR BREACH — A2 treated an empty dirty-range history as applicable; that is the vacuous green this guard was rebuilt to remove");
      assert.equal(vacuous.ok, false,
        "BEHAVIOUR BREACH — A2 returned ok for an empty dirty-range history (vacuous pass)");
      ok("A2-vacuity refuses to score an empty dirty-range history as a pass");
      skipped(vacuous.detail);

      // A1 — inside the grace window a pending range is normal work in flight,
      // not a defect; the rule must not fire on it.
      const inflight = await seedConnection(tx, {});
      await seedDirtyRange(tx, inflight, { status: "pending", createdAgoSql: "interval '5 minutes'" });
      expectAccept("A1-grace", ruleNoStaleDirtyRanges(await readStaleDirtyRanges(tx, inflight.tenantId, GRACE)));
    });

    const after = await countFixtureTables(sql);
    ok(`fixture rolled back — ${assertNoNetRows(before, after)}`);
    console.log(`\nBEDS24 ARI CHECK: ${n} PASSED`);
  }
} catch (e) {
  console.error(`BEDS24 ARI CHECK FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
