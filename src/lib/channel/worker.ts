import "server-only";
import { sql } from "@/lib/db";
import {
  claimChannelJobs, completeChannelJob, enqueueChannelJob, failChannelJob,
  type ChannelJobType,
} from "./queue";
import {
  drainAriDirtyRanges, runInitialFullSync, loadDrainableConnections,
  type AriConnection,
} from "./ari-sync";
import { loadInboundConnections, runInboundPull } from "./booking-import";

// ============================================================
// The GuestHub channel worker (D68) — a long-running PM2 process
// ("guesthub-channel-worker"), separate from the Next.js app.
//
// WHY A PROCESS AND NOT A REQUEST HOOK. Channel synchronisation must continue
// when nobody is using the app: a reservation made at 02:00 must reach Channex
// before the next operator save. Draining inside a request (Next `after()`) ties
// outbound delivery to operator traffic and creates competing drains. The
// database is the durable source of truth for pending work; this process is the
// single consumer of it.
//
// SAFETY. It only ever touches connections that are state='active',
// outbound_sync_enabled and full_sync_required=false — i.e. only AFTER the
// operator has run the initial Full Sync from /channels. Before that, no
// incremental ARI can leave the process, in any environment. There is no cron,
// no timer inside Next, and no HTTP trigger.
//
// CONCURRENCY. claimChannelJobs() claims with FOR UPDATE SKIP LOCKED and refuses
// a connection that already has a live processing job, so two workers (a rolling
// restart, a stray start) can never process the same job or publish conflicting
// ranges. A crashed worker's claim expires after JOB_LEASE_MINUTES and is
// reclaimed — no job is stuck.
// ============================================================

export const DEFAULT_INTERVAL_MS = 20_000;
const MIN_INTERVAL_MS = 5_000;
const JOBS_PER_TICK = 5;

export type WorkerOptions = {
  workerId: string;
  intervalMs?: number;
  /** aborted → stop claiming new work and return after the in-flight job */
  signal: AbortSignal;
  log?: (msg: string) => void;
};

export type TickSummary = { claimed: number; succeeded: number; failed: number; sentValues: number };

export function resolveIntervalMs(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.round(n));
}

async function loadConnection(connectionId: string): Promise<AriConnection | null> {
  const [row] = await sql<AriConnection[]>`
    SELECT id, tenant_id, channex_property_id, api_key_ciphertext
    FROM guesthub.channel_connections WHERE id = ${connectionId}`;
  return row ?? null;
}

// Liveness + last successful drain, for the /channels diagnostics area.
async function heartbeat(workerId: string, drained: boolean, lastError: string | null): Promise<void> {
  await sql`
    INSERT INTO guesthub.channel_worker_state (id, worker_id, beat_at, last_drain_at, last_error)
    VALUES ('singleton', ${workerId}, now(), ${drained ? sql`now()` : null}, ${lastError})
    ON CONFLICT (id) DO UPDATE SET
      worker_id = EXCLUDED.worker_id,
      beat_at = EXCLUDED.beat_at,
      last_drain_at = COALESCE(EXCLUDED.last_drain_at, guesthub.channel_worker_state.last_drain_at),
      last_error = EXCLUDED.last_error`;
}

// A job whose connection is no longer drainable is not an error — it is a
// baseline that has not been established (or was invalidated by warnings).
async function isDrainable(connectionId: string): Promise<boolean> {
  const drainable = await loadDrainableConnections(sql);
  return drainable.some((c) => c.id === connectionId);
}

async function runJob(
  jobType: ChannelJobType,
  jobId: string,
  connectionId: string,
  payload: unknown,
): Promise<{ sentValues: number }> {
  const conn = await loadConnection(connectionId);
  if (!conn) throw Object.assign(new Error("connection not found"), { code: "not_found" });

  if (jobType === "pull_booking_revisions") {
    // inbound import (D76): feed → persist → import → ack, per revision. Only
    // an inbound-enabled active connection is ever pulled; anything else is a
    // definite no (the job dead-letters instead of retrying forever).
    const [inbound] = (await loadInboundConnections(sql)).filter((c) => c.id === connectionId);
    if (!inbound) {
      throw Object.assign(new Error("inbound sync is not enabled for this connection"), {
        code: "validation_error",
      });
    }
    const revisionId =
      payload && typeof payload === "object" && "revision_id" in payload
        ? String((payload as Record<string, unknown>).revision_id ?? "") || undefined
        : undefined;
    const summary = await runInboundPull(sql, inbound, revisionId ? { revisionId } : undefined);
    // a feed/network failure with zero progress is a transient job failure —
    // bounded retries + backoff via the queue's existing mechanics
    if (summary.errors.length > 0 && summary.pulled === 0 && summary.acked === 0) {
      throw Object.assign(new Error(summary.errors[0]), { code: "network_error" });
    }
    return { sentValues: summary.imported + summary.alreadyImported };
  }

  if (jobType === "full_sync") {
    const result = await runInitialFullSync(sql, conn, jobId);
    if (!result.ok) {
      // A Full Sync is ALWAYS operator-triggered (§3). An automatic retry would
      // re-send ARI without anyone asking, so a failed one dead-letters straight
      // away (isPermanentError covers 'validation_error') and the operator
      // re-runs it from /channels after reading the recorded error.
      throw Object.assign(new Error(result.error ?? "full sync incomplete"), {
        code: "validation_error",
      });
    }
    return { sentValues: result.availability.requests + result.restrictions.requests };
  }

  if (jobType === "sync_ari_range") {
    // gate: never send incremental ARI before a clean initial Full Sync (§12)
    if (!(await isDrainable(connectionId))) return { sentValues: 0 };
    const summary = await drainAriDirtyRanges(sql, conn);
    return { sentValues: summary.sentValues };
  }

  // Any other job type belongs to an operator-triggered flow (room types, rate
  // plans, connection tests) that runs inside its own server action. The worker
  // must not silently retry it forever.
  throw Object.assign(new Error(`unsupported job type: ${jobType}`), { code: "validation_error" });
}

// A drain job is normally enqueued by the canonical save that dirtied a range.
// But a range that FAILED transiently is left pending with a backoff, and its
// job has already completed — nothing would ever pick it up again until the next
// operator save. So each tick also enqueues a drain for any drainable connection
// holding work that is due. The idempotency key collapses this to at most one
// job per connection, and next_attempt_at enforces the backoff.
async function ensureDrainJobs(): Promise<void> {
  for (const conn of await loadDrainableConnections(sql)) {
    const [due] = await sql<{ x: number }[]>`
      SELECT 1 AS x FROM guesthub.channel_dirty_ranges
      WHERE connection_id = ${conn.id} AND status = 'pending' AND next_attempt_at <= now()
      LIMIT 1`;
    if (!due) continue;
    await enqueueChannelJob(sql, {
      tenantId: conn.tenant_id,
      connectionId: conn.id,
      jobType: "sync_ari_range",
      priority: 50,
      idempotencyKey: `ari_drain:${conn.id}`,
    });
  }
}

// Low-frequency durable fallback poll (D76 §3): a missed webhook can never
// lose a booking. Runs inside the EXISTING worker loop — no second process, no
// cron. At most one pull job per connection exists at a time (idempotency key),
// and a new one is enqueued only when no pull ran (or was enqueued) within the
// window. The webhook enqueues the SAME job, so both paths converge.
export const INBOUND_POLL_MINUTES = 5;

async function ensureInboundPullJobs(): Promise<void> {
  for (const conn of await loadInboundConnections(sql)) {
    const [recent] = await sql<{ x: number }[]>`
      SELECT 1 AS x FROM guesthub.channel_sync_jobs
      WHERE connection_id = ${conn.id} AND job_type = 'pull_booking_revisions'
        AND (status IN ('queued', 'processing', 'retry_wait')
             OR created_at > now() - make_interval(mins => ${INBOUND_POLL_MINUTES}))
      LIMIT 1`;
    if (recent) continue;
    await enqueueChannelJob(sql, {
      tenantId: conn.tenant_id,
      connectionId: conn.id,
      jobType: "pull_booking_revisions",
      priority: 40,
      idempotencyKey: `inbound_pull:${conn.id}`,
    });
  }
}

export async function runTick(workerId: string, log: (m: string) => void): Promise<TickSummary> {
  const summary: TickSummary = { claimed: 0, succeeded: 0, failed: 0, sentValues: 0 };
  await ensureDrainJobs();
  await ensureInboundPullJobs();
  const jobs = await claimChannelJobs(workerId, JOBS_PER_TICK);
  summary.claimed = jobs.length;
  if (jobs.length === 0) return summary;

  for (const job of jobs) {
    try {
      const { sentValues } = await runJob(job.job_type, job.id, job.connection_id, job.payload);
      await completeChannelJob(job.id);
      summary.succeeded += 1;
      summary.sentValues += sentValues;
      log(`job ${job.job_type} ${job.id.slice(0, 8)} ok (${sentValues} values)`);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      // Only a safe category + message is stored; never an upstream body.
      await failChannelJob(job.id, { code: err.code, message: err.message ?? "unknown error" });
      summary.failed += 1;
      log(`job ${job.job_type} ${job.id.slice(0, 8)} failed: ${err.code ?? "error"}`);
    }
  }
  return summary;
}

/** Interruptible sleep — SIGTERM does not wait out the poll interval. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function runChannelWorker(opts: WorkerOptions): Promise<void> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = opts.log ?? (() => {});
  log(`channel worker ${opts.workerId} started (interval ${intervalMs}ms)`);

  while (!opts.signal.aborted) {
    let lastError: string | null = null;
    let summary: TickSummary = { claimed: 0, succeeded: 0, failed: 0, sentValues: 0 };
    try {
      summary = await runTick(opts.workerId, log);
    } catch (e) {
      lastError = e instanceof Error ? e.message : "worker tick failed";
      log(`tick error: ${lastError}`);
    }
    try {
      await heartbeat(opts.workerId, summary.sentValues > 0, lastError);
    } catch {
      // a heartbeat failure must never kill the worker
    }
    if (opts.signal.aborted) break;
    // idle: sleep the full interval — never a busy loop, never a tight poll
    await sleep(intervalMs, opts.signal);
  }
  log(`channel worker ${opts.workerId} stopped`);
}
