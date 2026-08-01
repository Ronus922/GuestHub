import type { Sql } from "postgres";
import { syncLocks } from "./locks";
import { syncPasscodes, drainTTLockOps } from "./passcodes";

// ============================================================
// The TTLock worker tick (D124) — WORKER-GRAPH-SAFE.
// No "server-only", no next/…, no react. This file is the reason
// tsconfig.worker.json now compiles src/lib/ttlock/ at all: runChannelWorker
// calls runTTLockTick, so the whole ttlock graph (this, passcodes, locks,
// token, http, crypto) must survive a plain CommonJS compile. Rule 12.
//
// WHY IT RIDES THE EXISTING WORKER AND NOT A CRON. The same argument D68 made
// for channels: the database holds the durable work, and exactly one process
// consumes it. A second scheduler would mean two processes racing on the same
// outbox rows, and a cron would mean TTLock traffic continuing after the worker
// was deliberately stopped.
//
// TWO CADENCES, ON PURPOSE:
//
//  · The DRAIN runs every cycle (~20s). It retries deletes that did not land
//    inline — codes still physically on doors that should not be. Nothing about
//    that should wait five minutes.
//  · The SYNC runs every 5 minutes. It is a read of every door's code list, so
//    its cost scales with the lock count (12 doors = 12 upstream calls), and
//    nothing it discovers is urgent: a code changed in the TTLock app is
//    information, not an incident.
//
// The 5-minute gate is held IN MEMORY, deliberately. A restart re-syncs
// immediately, which is the behaviour you want after a deploy; the alternative
// (a persisted last_run) buys nothing and adds a row to lose.
// ============================================================

export const TTLOCK_SYNC_INTERVAL_MS = 5 * 60 * 1000;

export type TTLockTickSummary = {
  tenants: number;
  synced: number;
  locksAdded: number;
  passcodesAdded: number;
  passcodesMissing: number;
  opsDone: number;
  opsFailed: number;
  opsExhausted: number;
};

/** Last successful sync per tenant, this process only. See header. */
const lastSyncAt = new Map<string, number>();

/** Test seam: the tick's 5-minute gate is process state, and a test that cannot
 *  clear it can only ever exercise the first sync. */
export function resetTTLockTickState(): void {
  lastSyncAt.clear();
}

type ConnectedTenant = { tenant_id: string };

/**
 * Tenants with a TTLock credential actually stored. A tenant that never
 * configured the integration must generate no upstream traffic at all — not one
 * token mint, not one probe.
 */
async function loadConnectedTenants(db: Sql): Promise<ConnectedTenant[]> {
  return db<ConnectedTenant[]>`
    -- CROSS-TENANT: the one query in this graph that may not carry a tenant
    -- filter — it exists to DISCOVER the tenants everything else is scoped to.
    -- It returns tenant ids and nothing else, and check-ttlock-secrets rule 3
    -- keeps it that way.
    SELECT tenant_id
    FROM guesthub.ttlock_connections
    WHERE secret_ciphertext IS NOT NULL
    ORDER BY tenant_id`;
}

/**
 * One TTLock cycle for every configured tenant.
 *
 * PER-TENANT ERROR ISOLATION, exactly as runCommunicationTick does it: one
 * tenant's expired credential, offline gateway or rate limit must not stop the
 * next tenant's drain. Nothing here throws to the caller — the channel worker's
 * own loop must keep running whatever TTLock does.
 *
 * NO CODE VALUE IS EVER LOGGED. The log line carries counts and nothing else;
 * failures are logged by error NAME, never by message, because a message can
 * carry an upstream body.
 */
export async function runTTLockTick(db: Sql, log: (msg: string) => void = () => {}): Promise<TTLockTickSummary> {
  const summary: TTLockTickSummary = {
    tenants: 0,
    synced: 0,
    locksAdded: 0,
    passcodesAdded: 0,
    passcodesMissing: 0,
    opsDone: 0,
    opsFailed: 0,
    opsExhausted: 0,
  };

  let tenants: ConnectedTenant[];
  try {
    tenants = await loadConnectedTenants(db);
  } catch (e) {
    log(`ttlock tick could not load connections (${e instanceof Error ? e.name : "error"})`);
    return summary;
  }
  summary.tenants = tenants.length;

  const now = Date.now();

  for (const { tenant_id: tenantId } of tenants) {
    // ---- every cycle: retire the codes a rotation superseded ----
    try {
      const drained = await drainTTLockOps(tenantId, db);
      summary.opsDone += drained.done;
      summary.opsFailed += drained.failed;
      summary.opsExhausted += drained.exhausted;
    } catch (e) {
      log(`ttlock drain failed for one tenant (${e instanceof Error ? e.name : "error"})`);
    }

    // ---- every 5 minutes: refresh what the doors actually hold ----
    const last = lastSyncAt.get(tenantId) ?? 0;
    if (now - last < TTLOCK_SYNC_INTERVAL_MS) continue;

    try {
      // Locks first: a passcode row needs a lock row to hang on, and this is
      // also what keeps battery and alias current on the board.
      const locks = await syncLocks(tenantId, db);
      summary.locksAdded += locks.added;

      const codes = await syncPasscodes(tenantId, db);
      summary.passcodesAdded += codes.added;
      summary.passcodesMissing += codes.missing;

      // Stamped only on success: a failed sync must be retried on the next
      // cycle, not five minutes later.
      lastSyncAt.set(tenantId, Date.now());
      summary.synced += 1;
    } catch (e) {
      log(`ttlock sync failed for one tenant (${e instanceof Error ? e.name : "error"})`);
    }
  }

  if (summary.synced > 0 || summary.opsDone > 0 || summary.opsFailed > 0 || summary.opsExhausted > 0) {
    log(
      `ttlock tick: ${summary.synced}/${summary.tenants} synced · ` +
        `+${summary.locksAdded} locks · +${summary.passcodesAdded} codes · ` +
        `${summary.passcodesMissing} missing · ops ${summary.opsDone} done/${summary.opsFailed} retry/${summary.opsExhausted} exhausted`,
    );
  }

  return summary;
}
