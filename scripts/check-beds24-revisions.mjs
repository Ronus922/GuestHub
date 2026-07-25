#!/usr/bin/env node
// ============================================================
// check:beds24-revisions — TARGET 2.7, rebuilt to the B2 standard.
//
// WHAT IT USED TO BE. `node --env-file=.env.local` reading DATABASE_URL: three
// assertions about the LIVE inbound feed (last succeeded pull ≤ 30m, zero
// revisions stuck un-imported > 1h, zero imported-but-unacknowledged > 1h).
// Measured 2026-07-25: unrunnable outside the production tree (exit 9), and
// byte-identical output with and without a semantic neutering of
// markRevisionAcknowledged() in src/lib/channel/revisions.ts — the guard
// nominally protecting the acknowledgement gate could not see it break.
//
// WHAT IT IS NOW. Three rules (R1..R3) exercised in BOTH directions against
// STAGING, on values read BACK out of the database, inside one transaction
// that is always rolled back. The ACCEPT arm drives the REAL revision
// lifecycle — persistBookingRevision() → markRevisionImported() →
// markRevisionAcknowledged(), all three shipped from
// src/lib/channel/revisions.ts — and then reads the resulting import_status /
// ack_status back out. Neutering any of the three turns this guard red.
//
// HONEST LIMIT (docs/GUARD_BEDS24_FOUR_B2.md §findings): R1's subject — "the
// production poller ran in the last 30 minutes" — is a LIVE fact no staging
// fixture can establish. What the fixture CAN establish, and now does, is that
// the freshness rule accepts a recent pull and rejects both a stale one and a
// never-pulled history. `--observe` keeps the live reading available, opt-in
// and unscored.
//
// Usage: node scripts/check-beds24-revisions.mjs
//        node scripts/check-beds24-revisions.mjs --observe   (ops probe)
// ============================================================
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { resolveCheckDbUrl, redactDsn } from "./lib/check-db-target.mjs";
import {
  THRESHOLDS,
  rulePullFreshness,
  ruleNoRevisionsStuckUnimported,
  ruleNoImportedButUnacknowledged,
} from "./lib/beds24-health-rules.mjs";
import {
  withRollback,
  countFixtureTables,
  assertNoNetRows,
  seedConnection,
  seedJob,
  seedRevision,
  readLastSucceededPull,
  readStuckRevisions,
  readUnacknowledgedRevisions,
  loadWorkerModules,
} from "./lib/beds24-staging-fixture.mjs";

const CHECK = "check:beds24-revisions";
const OBSERVE = process.argv.includes("--observe");
const GRACE = THRESHOLDS.revisionGraceHours;
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

try {
  if (OBSERVE) {
    console.log(`  · OBSERVE mode against ${redactDsn(url)} — this is a probe, not a guard`);
    const [pull] = await sql`
      SELECT max(j.finished_at) AS last
      FROM guesthub.channel_sync_jobs j
      JOIN guesthub.channel_connections cc ON cc.id = j.connection_id
      WHERE cc.provider = 'beds24' AND j.job_type = 'pull_booking_revisions' AND j.status = 'succeeded'`;
    const [stuck] = await sql`
      SELECT count(*)::int AS c FROM guesthub.channel_booking_revisions
      WHERE import_status <> 'imported' AND created_at < now() - make_interval(hours => ${GRACE})`;
    const [unacked] = await sql`
      SELECT count(*)::int AS c FROM guesthub.channel_booking_revisions
      WHERE import_status = 'imported' AND ack_status IS DISTINCT FROM 'acknowledged'
        AND created_at < now() - make_interval(hours => ${GRACE})`;
    for (const r of [
      rulePullFreshness(pull.last, Date.now()),
      ruleNoRevisionsStuckUnimported(stuck.c),
      ruleNoImportedButUnacknowledged(unacked.c),
    ]) console.log(`  ${r.ok ? "·" : "!"} ${r.detail}`);
    console.log("\nOBSERVE COMPLETE (informational — no assertions were scored)");
  } else {
    const mods = loadWorkerModules(url);
    const before = await countFixtureTables(sql);

    await withRollback(sql, async (tx) => {
      const healthy = await seedConnection(tx, {});

      // ---------- R1 ACCEPT: a pull succeeded 4 minutes ago ----------
      await seedJob(tx, healthy, {
        jobType: "pull_booking_revisions", status: "succeeded", finishedAgoSql: "interval '4 minutes'",
      });
      const last = await readLastSucceededPull(tx, healthy.tenantId);
      expectContract("R0", !!last, "the read-back query really sees the seeded succeeded pull");
      expectAccept("R1", rulePullFreshness(last, Date.now()));

      // ---------- the REAL lifecycle, driven through shipped code ----------
      // persist → import → acknowledge. R2 and R3 then read the resulting
      // import_status / ack_status back out of the database. If any of the
      // three shipped functions stops writing, the ACCEPT arms below fail.
      const { persistBookingRevision, markRevisionImported, markRevisionAcknowledged } = mods.revisions;
      const persisted = await persistBookingRevision(tx, {
        tenantId: healthy.tenantId,
        connectionId: healthy.connectionId,
        providerBookingId: `bk-${randomUUID().slice(0, 8)}`,
        providerRevisionId: `rev-${randomUUID().slice(0, 8)}`,
        revisionKind: "new",
        payload: { fixture: true },
      });
      expectContract("R-lifecycle", persisted.duplicate !== true,
        "the shipped persistBookingRevision() inserted the fixture revision");
      await markRevisionImported(tx, healthy.tenantId, persisted.id, null);
      const acked = await markRevisionAcknowledged(tx, persisted.id);
      expectContract("R-lifecycle", acked === true,
        "the shipped markRevisionAcknowledged() acknowledged the imported revision");
      // Age it past the grace window so R2/R3 actually consider it.
      await tx`
        UPDATE guesthub.channel_booking_revisions
        SET created_at = now() - make_interval(hours => ${GRACE + 2})
        WHERE id = ${persisted.id}`;

      const [state] = await tx`
        SELECT import_status, ack_status FROM guesthub.channel_booking_revisions WHERE id = ${persisted.id}`;
      expectContract("R-lifecycle", state.import_status === "imported" && state.ack_status === "acknowledged",
        `read-back after the shipped lifecycle: import_status=${state.import_status}, ack_status=${state.ack_status}`);

      expectAccept("R2", ruleNoRevisionsStuckUnimported(await readStuckRevisions(tx, healthy.tenantId, GRACE)));
      expectAccept("R3", ruleNoImportedButUnacknowledged(await readUnacknowledgedRevisions(tx, healthy.tenantId, GRACE)));

      // ---------- REJECT arms ----------
      // R1 — the last succeeded pull is well past the threshold.
      const stale = await seedConnection(tx, {});
      await seedJob(tx, stale, {
        jobType: "pull_booking_revisions", status: "succeeded", finishedAgoSql: "interval '3 hours'",
      });
      expectReject("R1", rulePullFreshness(await readLastSucceededPull(tx, stale.tenantId), Date.now()));

      // R1 — ANTI-VACUITY: no pull has EVER succeeded. An empty history is the
      // worst case, not the best; the rule must reject it rather than have
      // nothing to compare against.
      const never = await seedConnection(tx, {});
      const noPull = await readLastSucceededPull(tx, never.tenantId);
      expectContract("R1-vacuity", noPull === null, "the anti-vacuity fixture really does read back a null pull history");
      expectReject("R1-vacuity", rulePullFreshness(noPull, Date.now()));

      // R2 — a revision quarantined by the SHIPPED quarantineRevision() and
      // left un-imported past the grace window.
      const quarantined = await seedConnection(tx, {});
      const qRev = await persistBookingRevision(tx, {
        tenantId: quarantined.tenantId,
        connectionId: quarantined.connectionId,
        providerBookingId: `bk-${randomUUID().slice(0, 8)}`,
        providerRevisionId: `rev-${randomUUID().slice(0, 8)}`,
        revisionKind: "new",
        payload: { fixture: true },
      });
      await mods.revisions.quarantineRevision(tx, qRev.id, "fixture: unmapped room type");
      await tx`
        UPDATE guesthub.channel_booking_revisions
        SET created_at = now() - make_interval(hours => ${GRACE + 2}) WHERE id = ${qRev.id}`;
      expectReject("R2", ruleNoRevisionsStuckUnimported(await readStuckRevisions(tx, quarantined.tenantId, GRACE)));

      // R3 — imported but never acknowledged past the grace window.
      const unacked = await seedConnection(tx, {});
      await seedRevision(tx, unacked, {
        importStatus: "imported", ackStatus: "unacknowledged",
        createdAgoSql: `make_interval(hours => ${GRACE + 2})`,
      });
      expectReject("R3", ruleNoImportedButUnacknowledged(await readUnacknowledgedRevisions(tx, unacked.tenantId, GRACE)));

      // R2/R3 — inside the grace window nothing fires, or the rules would
      // scream at every revision the worker is still processing.
      const fresh = await seedConnection(tx, {});
      await seedRevision(tx, fresh, {
        importStatus: "pending", ackStatus: "unacknowledged", createdAgoSql: "interval '2 minutes'",
      });
      expectAccept("R2-grace", ruleNoRevisionsStuckUnimported(await readStuckRevisions(tx, fresh.tenantId, GRACE)));
    });

    const after = await countFixtureTables(sql);
    ok(`fixture rolled back — ${assertNoNetRows(before, after)}`);
    console.log(`\nBEDS24 REVISIONS CHECK: ${n} PASSED`);
  }
} catch (e) {
  console.error(`BEDS24 REVISIONS CHECK FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
