import type { Sql } from "postgres";
import { drainTTLockOps } from "./passcodes";
import { TTLockError } from "./http";

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
// ONE JOB ONLY: the DRAIN, every cycle (~20s). It retries the deletes that did
// not land inline — codes still physically on doors that should not be — and it
// reaches TTLock only when such an op is actually queued.
//
// The periodic SYNC was REMOVED on purpose, not slowed. The screen is used
// weekly; every read of the doors' code lists is operator-initiated from /locks
// ("סנכרון מנעולים", the selection-bar sync, or the post-rotate refresh). The
// old 5-minute poll cost ~3,700 upstream calls/day and exhausted TTLock's
// MONTHLY API quota (errcode 30007) in eight days; the idle profile now is
// ~0 calls/day. A quota circuit breaker (columns on ttlock_connections, pure
// logic from src/lib/channel/circuit-breaker.ts) gates the drain so an
// exhausted quota is probed about once an hour, not hammered every cycle.
// ============================================================

export type TTLockTickSummary = {
  tenants: number;
  opsDone: number;
  opsFailed: number;
  opsExhausted: number;
  opsSkippedCircuit: number;
};

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
 * failures are logged by error NAME plus the numeric errcode, never by message,
 * because a message can carry an upstream body.
 */
export async function runTTLockTick(db: Sql, log: (msg: string) => void = () => {}): Promise<TTLockTickSummary> {
  const summary: TTLockTickSummary = {
    tenants: 0,
    opsDone: 0,
    opsFailed: 0,
    opsExhausted: 0,
    opsSkippedCircuit: 0,
  };

  let tenants: ConnectedTenant[];
  try {
    tenants = await loadConnectedTenants(db);
  } catch (e) {
    log(`ttlock tick could not load connections (${e instanceof Error ? e.name : "error"})`);
    return summary;
  }
  summary.tenants = tenants.length;

  for (const { tenant_id: tenantId } of tenants) {
    // ---- every cycle: retire the codes a rotation superseded ----
    try {
      const drained = await drainTTLockOps(tenantId, db);
      summary.opsDone += drained.done;
      summary.opsFailed += drained.failed;
      summary.opsExhausted += drained.exhausted;
      if (drained.skippedCircuitOpen) summary.opsSkippedCircuit += 1;
    } catch (e) {
      // The NUMERIC errcode only — policy-compliant (rule 11 bans code VALUES
      // in logs, and the message/errmsg may carry an upstream body).
      const errcodeSuffix = e instanceof TTLockError ? ` errcode ${e.errcode}` : "";
      log(`ttlock drain failed for one tenant (${e instanceof Error ? e.name : "error"}${errcodeSuffix})`);
    }
  }

  if (summary.opsDone > 0 || summary.opsFailed > 0 || summary.opsExhausted > 0) {
    log(
      `ttlock tick: ops ${summary.opsDone} done/${summary.opsFailed} retry/${summary.opsExhausted} exhausted`,
    );
  }
  if (summary.opsSkippedCircuit > 0) {
    // Exactly one line per cycle, however many ops are waiting behind the
    // breaker — the whole point is to stop the noise, not to relocate it.
    log(`ttlock drain skipped (circuit open)`);
  }

  return summary;
}
