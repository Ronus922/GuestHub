#!/usr/bin/env node
// ============================================================
// check:beds24-jobs — TARGET 2.7, rebuilt to the B2 standard.
//
// WHAT IT USED TO BE. `node --env-file=.env.local` reading DATABASE_URL: three
// assertions about the LAST 24 HOURS OF PRODUCTION job history. Measured on
// 2026-07-25 it was unrunnable outside the production tree (exit 9, `.env.local:
// not found`) and, when pointed at a real database, its output did not change
// by a single byte when the application predicates were semantically neutered.
//
// It also carried the vacuous-pass bug that makes a guard worse than nothing:
//   for (const [type, e] of by) { ...assert... }
//   ok("failure share ≤ 10% for every beds24 job type");
// An EMPTY map skipped the loop and then counted a PASS. "Every job type is
// within budget" was reported by a database with no job types at all.
//
// WHAT IT IS NOW. Three rules (J1..J3) exercised in BOTH directions against
// STAGING, on histograms read BACK out of the database, inside one transaction
// that is always rolled back. J2's empty-input case is now an explicit REJECT
// ("vacuous pass refused"). The ACCEPT arm builds its jobs through the SHIPPED
// enqueueChannelJob() from src/lib/channel/queue.ts, so neutering that function
// turns this guard red.
//
// HONEST LIMIT (docs/GUARD_BEDS24_FOUR_B2.md §findings): these are assertions
// about the RULES, not about the live 24h of production. `--observe` keeps the
// operational reading available, opt-in and unscored.
//
// Usage: node scripts/check-beds24-jobs.mjs
//        node scripts/check-beds24-jobs.mjs --observe   (ops probe)
// ============================================================
import assert from "node:assert/strict";
import postgres from "postgres";
import { resolveCheckDbUrl, redactDsn } from "./lib/check-db-target.mjs";
import {
  THRESHOLDS,
  foldJobRows,
  ruleInboundFeedAlive,
  ruleFailureShareWithinBudget,
  ruleNoForeignProviderJobsSinceCutover,
} from "./lib/beds24-health-rules.mjs";
import {
  withRollback,
  countFixtureTables,
  assertNoNetRows,
  seedConnection,
  seedJob,
  readJobHistogram,
  readForeignJobsSinceCutover,
  loadWorkerModules,
} from "./lib/beds24-staging-fixture.mjs";

const CHECK = "check:beds24-jobs";
const OBSERVE = process.argv.includes("--observe");
const url = resolveCheckDbUrl(CHECK);
const sql = postgres(url, { prepare: false, max: 1 });

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };
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

async function observe(db) {
  const rows = await db`
    SELECT j.job_type, j.status, count(*)::int AS c
    FROM guesthub.channel_sync_jobs j
    JOIN guesthub.channel_connections cc ON cc.id = j.connection_id
    WHERE cc.provider = 'beds24' AND j.finished_at >= now() - interval '24 hours'
    GROUP BY j.job_type, j.status`;
  const [foreign] = await db`
    SELECT count(*)::int AS c
    FROM guesthub.channel_sync_jobs j
    JOIN guesthub.channel_connections cc ON cc.id = j.connection_id
    WHERE cc.provider <> 'beds24' AND j.finished_at >= ${THRESHOLDS.d91CutoverIso}`;
  const by = foldJobRows(rows);
  return [ruleInboundFeedAlive(by), ruleFailureShareWithinBudget(by), ruleNoForeignProviderJobsSinceCutover(foreign.c)];
}

try {
  if (OBSERVE) {
    console.log(`  · OBSERVE mode against ${redactDsn(url)} — this is a probe, not a guard`);
    for (const r of await observe(sql)) console.log(`  ${r.ok ? "·" : "!"} ${r.detail}`);
    console.log("\nOBSERVE COMPLETE (informational — no assertions were scored)");
  } else {
    const mods = loadWorkerModules(url);
    const before = await countFixtureTables(sql);

    await withRollback(sql, async (tx) => {
      // ---------- ACCEPT arm ----------
      // The jobs are created through the SHIPPED enqueue, then finished by the
      // fixture. If enqueueChannelJob() stops inserting, the histogram below is
      // empty and every ACCEPT assertion fails.
      const healthy = await seedConnection(tx, {});
      const { enqueueChannelJob } = mods.queue;
      for (let i = 0; i < 9; i++) {
        await enqueueChannelJob(tx, {
          tenantId: healthy.tenantId,
          connectionId: healthy.connectionId,
          jobType: "pull_booking_revisions",
        });
      }
      await enqueueChannelJob(tx, {
        tenantId: healthy.tenantId,
        connectionId: healthy.connectionId,
        jobType: "sync_ari_range",
      });
      // Finish them: 9 succeeded pulls, 1 succeeded drain — 0% failure share.
      await tx`
        UPDATE guesthub.channel_sync_jobs
        SET status = 'succeeded', started_at = now() - interval '2 hours',
            finished_at = now() - interval '2 hours'
        WHERE tenant_id = ${healthy.tenantId}`;

      const by = foldJobRows(await readJobHistogram(tx, healthy.tenantId));
      expectContract("J0", by.size === 2 && by.get("pull_booking_revisions").succeeded === 9,
        "the SHIPPED enqueueChannelJob() produced the rows the histogram reads back");

      expectAccept("J1", ruleInboundFeedAlive(by));
      expectAccept("J2", ruleFailureShareWithinBudget(by));
      expectAccept("J3", ruleNoForeignProviderJobsSinceCutover(
        await readForeignJobsSinceCutover(tx, healthy.tenantId, THRESHOLDS.d91CutoverIso)));

      // ---------- REJECT arms ----------
      // J1 — the inbound feed produced nothing but failures in the window.
      const dead = await seedConnection(tx, {});
      await seedJob(tx, dead, { jobType: "pull_booking_revisions", status: "failed", finishedAgoSql: "interval '30 minutes'" });
      expectReject("J1", ruleInboundFeedAlive(foldJobRows(await readJobHistogram(tx, dead.tenantId))));

      // J2 — over the failure budget: 5 succeeded / 5 failed = 50%.
      const flaky = await seedConnection(tx, {});
      for (let i = 0; i < 5; i++) {
        await seedJob(tx, flaky, { jobType: "pull_booking_revisions", status: "succeeded", finishedAgoSql: "interval '1 hour'" });
        await seedJob(tx, flaky, { jobType: "pull_booking_revisions", status: "failed", finishedAgoSql: "interval '1 hour'" });
      }
      expectReject("J2", ruleFailureShareWithinBudget(foldJobRows(await readJobHistogram(tx, flaky.tenantId))));

      // J2 — ANTI-VACUITY. This is the exact input the original guard turned
      // into a green tick: no beds24 job types at all in the window.
      const silent = await seedConnection(tx, {});
      const emptyHistogram = foldJobRows(await readJobHistogram(tx, silent.tenantId));
      expectContract("J2-vacuity", emptyHistogram.size === 0, "the anti-vacuity fixture really does read back zero job types");
      expectReject("J2-vacuity", ruleFailureShareWithinBudget(emptyHistogram));

      // J3 — a decommissioned provider finished a job after the D91 cutover.
      const revenant = await seedConnection(tx, { provider: "channex", isActiveProvider: false });
      await tx`
        INSERT INTO guesthub.channel_sync_jobs
          (tenant_id, connection_id, job_type, status, started_at, finished_at)
        VALUES (${revenant.tenantId}, ${revenant.connectionId}, 'full_sync', 'succeeded',
                now() - interval '20 minutes', now() - interval '20 minutes')`;
      expectReject("J3", ruleNoForeignProviderJobsSinceCutover(
        await readForeignJobsSinceCutover(tx, revenant.tenantId, THRESHOLDS.d91CutoverIso)));

      // J3 — history BEFORE the cutover is legitimate and must stay accepted,
      // otherwise the rule would fire forever on archived rows.
      const history = await seedConnection(tx, { provider: "hospitable", isActiveProvider: false });
      await tx`
        INSERT INTO guesthub.channel_sync_jobs
          (tenant_id, connection_id, job_type, status, started_at, finished_at)
        VALUES (${history.tenantId}, ${history.connectionId}, 'full_sync', 'succeeded',
                ${THRESHOLDS.d91CutoverIso}::timestamptz - interval '2 days',
                ${THRESHOLDS.d91CutoverIso}::timestamptz - interval '2 days')`;
      expectAccept("J3-history", ruleNoForeignProviderJobsSinceCutover(
        await readForeignJobsSinceCutover(tx, history.tenantId, THRESHOLDS.d91CutoverIso)));
    });

    const after = await countFixtureTables(sql);
    ok(`fixture rolled back — ${assertNoNetRows(before, after)}`);
    console.log(`\nBEDS24 JOBS CHECK: ${n} PASSED`);
  }
} catch (e) {
  console.error(`BEDS24 JOBS CHECK FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
