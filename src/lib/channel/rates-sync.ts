import "server-only";
import type { Sql } from "postgres";
import { enqueueChannelJob } from "./queue";
import { deriveRatesSyncState, type RatesSyncStatus, type SyncNowResult } from "./sync-state";

// ============================================================
// /rates channel-sync surface (D75). Two operations only:
//
//   getRatesSyncStatus       — READ the persisted sync state (dirty ranges,
//                              worker heartbeat, last successful drain) for the
//                              status chip next to "סנכרן ערוצים".
//   requestIncrementalSyncNow — the manual button. Re-queues FAILED ranges for
//                              one more attempt, drops the backoff on PENDING
//                              ranges, and enqueues the SAME deduplicated
//                              ari_drain job every canonical save enqueues.
//
// NEITHER creates a Full Sync, a new range scope, a worker, or an HTTP call —
// the PM2 channel worker remains the single consumer. The job type here is
// hard-coded 'sync_ari_range'; there is no path from /rates to 'full_sync'.
// ============================================================

/** A heartbeat older than this means the PM2 worker is not running (as /channels). */
const WORKER_STALE_SECONDS = 90;

// Server-side timestamp formatting — same discipline as /channels (D71): fixed
// locale AND timezone, so the string is identical wherever it is computed, and
// the client never formats time.
const PROPERTY_TIME_ZONE = "Asia/Jerusalem";
const HE_DATE_TIME = new Intl.DateTimeFormat("he-IL", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: PROPERTY_TIME_ZONE,
});

type DrainableConn = { id: string };

// The connections whose pending work the worker will actually drain — the same
// predicate as loadDrainableBeds24Connections (beds24-ari-sync.ts), scoped to
// the tenant. A connection still awaiting its Full Sync is NOT "connected" for
// /rates: its ranges would sit forever and "מסנכרן…" would be a lie.
// The active provider's connection qualifies once its baseline is established;
// the per-provider mapping-existence checks live in the drain loader.
async function drainableConnections(db: Sql, tenantId: string): Promise<DrainableConn[]> {
  return db<DrainableConn[]>`
    SELECT id FROM guesthub.channel_connections
    WHERE tenant_id = ${tenantId}
      AND is_active_provider = true
      AND state = 'active' AND outbound_sync_enabled = true AND full_sync_required = false
      AND api_key_ciphertext IS NOT NULL`;
}

export async function getRatesSyncStatus(db: Sql, tenantId: string): Promise<RatesSyncStatus> {
  const conns = await drainableConnections(db, tenantId);
  if (conns.length === 0) {
    return {
      connected: false,
      state: "not_connected",
      pendingRanges: 0,
      failedRanges: 0,
      workerOnline: false,
      lastSyncAt: "—",
    };
  }
  const ids = conns.map((c) => c.id);

  const [ranges] = await db<{ pending: number; failed: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
           count(*) FILTER (WHERE status = 'failed')::int  AS failed
    FROM guesthub.channel_dirty_ranges WHERE connection_id = ANY(${ids}::uuid[])`;

  const [sync] = await db<{ last: Date | null }[]>`
    SELECT max(last_outbound_sync_at) AS last
    FROM guesthub.channel_connections WHERE id = ANY(${ids}::uuid[])`;

  const [w] = await db<{ fresh: boolean }[]>`
    SELECT (beat_at > now() - make_interval(secs => ${WORKER_STALE_SECONDS})) AS fresh
    FROM guesthub.channel_worker_state WHERE id = 'singleton'`;

  const pending = ranges?.pending ?? 0;
  const failed = ranges?.failed ?? 0;
  return {
    connected: true,
    state: deriveRatesSyncState(true, pending, failed),
    pendingRanges: pending,
    failedRanges: failed,
    workerOnline: !!w?.fresh,
    lastSyncAt: sync?.last ? HE_DATE_TIME.format(sync.last) : "—",
  };
}

/**
 * The manual "סנכרן ערוצים" action. Everything runs in one transaction against
 * the EXISTING rows — no new range scope is ever created here:
 *
 *  · failed ranges     → status='pending', next_attempt_at=now(). attempts are
 *    NOT reset, so failRanges' `attempts >= max_attempts` dead-letters them
 *    again after exactly ONE more failed try — a retry, never a loop. Their
 *    last_error_code and the channel_sync_errors history are untouched.
 *  · pending ranges    → next_attempt_at=now() (drop any backoff wait).
 *  · one ari_drain job → the SAME idempotency key every canonical save uses;
 *    the partial unique index collapses repeat clicks and open tabs to one job.
 */
export async function requestIncrementalSyncNow(
  db: Sql,
  tenantId: string,
): Promise<SyncNowResult & { connectionIds: string[] } | { error: string }> {
  const conns = await drainableConnections(db, tenantId);
  if (conns.length === 0) return { error: "אין חיבור ערוצים פעיל" };

  let retriedFailed = 0;
  let pendingRanges = 0;
  await db.begin(async (tx) => {
    for (const conn of conns) {
      const retried = await tx`
        UPDATE guesthub.channel_dirty_ranges
        SET status = 'pending', next_attempt_at = now(), updated_at = now()
        WHERE connection_id = ${conn.id} AND status = 'failed'`;
      retriedFailed += retried.count;

      await tx`
        UPDATE guesthub.channel_dirty_ranges
        SET next_attempt_at = now(), updated_at = now()
        WHERE connection_id = ${conn.id} AND status = 'pending' AND next_attempt_at > now()`;

      const [{ n }] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM guesthub.channel_dirty_ranges
        WHERE connection_id = ${conn.id} AND status = 'pending'`;
      pendingRanges += n;

      if (n > 0) {
        await enqueueChannelJob(tx, {
          tenantId,
          connectionId: conn.id,
          jobType: "sync_ari_range",
          priority: 50,
          idempotencyKey: `ari_drain:${conn.id}`,
        });
      }
    }
  });

  return {
    retriedFailed,
    pendingRanges,
    nothingToSync: pendingRanges === 0,
    connectionIds: conns.map((c) => c.id),
  };
}
