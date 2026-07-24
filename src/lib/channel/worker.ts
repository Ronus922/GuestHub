import "server-only";
import { sql } from "@/lib/db";
import {
  claimChannelJobs, completeChannelJob, enqueueChannelJob, failChannelJob,
  type ChannelJobType,
} from "./queue";
import {
  drainBeds24AriDirtyRanges, runBeds24FullSync, loadDrainableBeds24Connections,
} from "./beds24-ari-sync";
import {
  loadBeds24InboundConnections, runBeds24InboundPull, runBeds24BookingReconciliation,
} from "./beds24-booking-import";
import type { Beds24CreditSnapshot } from "./beds24-credits";
import { JOBS_WAKE_CHANNEL } from "@/lib/realtime/events";
import { runCommunicationTick } from "@/lib/communications/worker";

// ============================================================
// The GuestHub channel worker (D68) — a long-running PM2 process
// ("guesthub-channel-worker"), separate from the Next.js app.
//
// WHY A PROCESS AND NOT A REQUEST HOOK. Channel synchronisation must continue
// when nobody is using the app: a reservation made at 02:00 must reach the channel
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

// The loaded connection row. `provider` is read from the DB and may carry a
// historical value on dormant rows — runJob accepts ONLY "beds24" (D91).
type WorkerConnection = {
  id: string;
  tenant_id: string;
  provider: string;
  is_active_provider: boolean;
  api_key_ciphertext: string;
  environment: "staging" | "production";
  // beds24 24h access-token cache
  access_token_ciphertext: string | null;
  access_token_expires_at: Date | string | null;
  // §16 circuit-breaker state, persisted between drains.
  circuit_open_until: string | null;
  consecutive_failures: number;
};

async function loadConnection(connectionId: string): Promise<WorkerConnection | null> {
  const [row] = await sql<WorkerConnection[]>`
    SELECT id, tenant_id, provider, is_active_provider,
           api_key_ciphertext, environment,
           access_token_ciphertext, access_token_expires_at,
           circuit_open_until::text AS circuit_open_until, consecutive_failures
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

// P0-4 — park the Beds24 credit meter on the job row that measured it. The
// /channels diagnostics reads the newest one: the inbound poll runs every 5
// minutes and the reconciliation every 20, so the panel is never more than one
// poll cycle stale. Payload-merge (never an overwrite) — job payloads also
// carry the caller's own keys.
async function recordJobCredits(
  jobId: string,
  credits: Beds24CreditSnapshot | null,
  pausedReason: string | null,
): Promise<void> {
  if (!credits || (credits.remaining === null && credits.resetsInSec === null)) return;
  await sql`
    UPDATE guesthub.channel_sync_jobs
    SET payload = COALESCE(payload, '{}'::jsonb) || ${sql.json({
      credits: {
        remaining: credits.remaining,
        resets_in_sec: credits.resetsInSec,
        cost: credits.cost,
        paused: pausedReason,
        measured_at: new Date().toISOString(),
      },
    } as never)}
    WHERE id = ${jobId}`;
}

// A job whose connection is no longer drainable is not an error — it is a
// baseline that has not been established (or was invalidated by warnings).
async function isBeds24Drainable(connectionId: string): Promise<boolean> {
  const drainable = await loadDrainableBeds24Connections(sql);
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

  // D79 — ONE working provider at a time. A dormant (backup) provider's job
  // must neither push nor import: full_sync dead-letters loudly (it is
  // operator-triggered — the operator picked the wrong provider), while
  // pull/drain no-op quietly (a stale webhook or pre-switch job is expected).
  if (!conn.is_active_provider) {
    if (jobType === "full_sync") {
      throw Object.assign(new Error("הספק אינו הספק הפעיל — בחר אותו במסך הערוצים תחילה"), {
        code: "validation_error",
      });
    }
    return { sentValues: 0 };
  }

  // ---- Beds24 dispatch (D78) — the ONE supported provider (D91) ----
  if (conn.provider === "beds24") {
    if (jobType === "pull_booking_revisions") {
      const [inbound] = (await loadBeds24InboundConnections(sql)).filter((c) => c.id === connectionId);
      if (!inbound) {
        throw Object.assign(new Error("inbound sync is not enabled for this connection"), {
          code: "validation_error",
        });
      }
      const bookingId =
        payload && typeof payload === "object" && "booking_id" in payload
          ? String((payload as Record<string, unknown>).booking_id ?? "") || undefined
          : undefined;
      const summary = await runBeds24InboundPull(sql, inbound, bookingId ? { bookingId } : undefined);
      await recordJobCredits(jobId, summary.credits, summary.creditPause?.reason ?? null);
      if (summary.errors.length > 0 && summary.fetched === 0 && summary.imported === 0 && summary.inserted === 0) {
        throw Object.assign(new Error(summary.errors[0]), { code: "network_error" });
      }
      return { sentValues: summary.imported };
    }
    if (jobType === "full_sync") {
      const result = await runBeds24FullSync(sql, conn, jobId);
      if (!result.ok) {
        throw Object.assign(new Error(result.error ?? "full sync incomplete"), {
          code: "validation_error",
        });
      }
      return { sentValues: result.outcome.sentRanges };
    }
    if (jobType === "sync_ari_range") {
      if (!(await isBeds24Drainable(connectionId))) return { sentValues: 0 };
      const summary = await drainBeds24AriDirtyRanges(sql, conn);
      return { sentValues: summary.sentValues };
    }
    if (jobType === "reconcile_inventory") {
      const [inbound] = (await loadBeds24InboundConnections(sql)).filter((c) => c.id === connectionId);
      if (!inbound) return { sentValues: 0 }; // not inbound-enabled → nothing to reconcile
      const summary = await runBeds24BookingReconciliation(sql, inbound);
      await recordJobCredits(jobId, summary.credits, summary.creditPause?.reason ?? null);
      if (summary.errors.length > 0 && summary.checked === 0) {
        throw Object.assign(new Error(summary.errors[0]), { code: "network_error" });
      }
      return { sentValues: summary.released };
    }
    throw Object.assign(new Error(`unsupported job type: ${jobType}`), { code: "validation_error" });
  }

  // Any non-Beds24 provider is decommissioned (D91): its paused rows may still
  // hold historical jobs — dead-letter them loudly instead of retrying forever.
  throw Object.assign(new Error("הספק הוסר מהמערכת — רק Beds24 נתמך"), {
    code: "validation_error",
  });
}

// A drain job is normally enqueued by the canonical save that dirtied a range.
// But a range that FAILED transiently is left pending with a backoff, and its
// job has already completed — nothing would ever pick it up again until the next
// operator save. So each tick also enqueues a drain for any drainable connection
// holding work that is due. The idempotency key collapses this to at most one
// job per connection, and next_attempt_at enforces the backoff.
async function ensureDrainJobs(): Promise<void> {
  const drainable = await loadDrainableBeds24Connections(sql);
  for (const conn of drainable) {
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
  const inbound = await loadBeds24InboundConnections(sql);
  for (const conn of inbound) {
    const [recent] = await sql<{ x: number }[]>`
      SELECT 1 AS x FROM guesthub.channel_sync_jobs
      WHERE connection_id = ${conn.id} AND job_type = 'pull_booking_revisions'
        AND NOT (payload ? 'reservation_uuid')
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

// Booking reconciliation cadence (safety net over the status-filter fix): the
// same durable jobs-table pattern as the inbound poll — no cron, no timer, at
// most one live reconcile job per connection, a new one only when none ran
// (or was enqueued) within the window.
export const RECONCILE_MINUTES = 20;

async function ensureReconcileJobs(): Promise<void> {
  const inbound = await loadBeds24InboundConnections(sql);
  for (const conn of inbound) {
    const [recent] = await sql<{ x: number }[]>`
      SELECT 1 AS x FROM guesthub.channel_sync_jobs
      WHERE connection_id = ${conn.id} AND job_type = 'reconcile_inventory'
        AND (status IN ('queued', 'processing', 'retry_wait')
             OR created_at > now() - make_interval(mins => ${RECONCILE_MINUTES}))
      LIMIT 1`;
    if (recent) continue;
    await enqueueChannelJob(sql, {
      tenantId: conn.tenant_id,
      connectionId: conn.id,
      jobType: "reconcile_inventory",
      priority: 60,
      idempotencyKey: `booking_reconcile:${conn.id}`,
    });
  }
}

export async function runTick(workerId: string, log: (m: string) => void): Promise<TickSummary> {
  const summary: TickSummary = { claimed: 0, succeeded: 0, failed: 0, sentValues: 0 };
  // Guest communication shares this existing durable worker process. It runs
  // before channel work so an immediate confirmation is not delayed by ARI
  // traffic; failures remain isolated to its own event/delivery rows.
  try {
    await runCommunicationTick(workerId, log);
  } catch (e) {
    log(`communications tick failed: ${e instanceof Error ? e.name : "error"}`);
  }
  await ensureDrainJobs();
  await ensureInboundPullJobs();
  await ensureReconcileJobs();
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

/** Interruptible sleep — SIGTERM (or a queue wake) does not wait out the poll
 *  interval. `arm` hands the caller a wake function bound to THIS sleep. */
function sleep(ms: number, signal: AbortSignal, arm?: (wake: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
    arm?.(done);
  });
}

export async function runChannelWorker(opts: WorkerOptions): Promise<void> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = opts.log ?? (() => {});
  log(`channel worker ${opts.workerId} started (interval ${intervalMs}ms)`);

  // Immediate wake (D77 §4): every durable enqueue NOTIFYs on commit; this
  // dedicated LISTEN connection (postgres.js — outside the pool, auto-
  // reconnect + re-subscribe) interrupts the sleep so a webhook-enqueued job
  // is claimed within ~a tick's overhead, not the poll interval. The interval
  // poll below KEEPS running as the missed-NOTIFY watchdog; a failed LISTEN
  // degrades to poll-only — never a dead worker.
  let wakeFlag = false;
  let wakeSleep: (() => void) | null = null;
  const onWake = () => {
    wakeFlag = true;
    wakeSleep?.();
  };
  try {
    await sql.listen(JOBS_WAKE_CHANNEL, onWake);
    log(`listening on ${JOBS_WAKE_CHANNEL} — instant wake enabled`);
  } catch (e) {
    log(`wake listener unavailable (${e instanceof Error ? e.message : "error"}) — poll-only mode`);
  }

  while (!opts.signal.aborted) {
    wakeFlag = false;
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
    // a wake that landed DURING the tick means runnable work already exists —
    // re-tick immediately; otherwise sleep until interval / abort / wake.
    if (!wakeFlag) {
      await sleep(intervalMs, opts.signal, (wake) => {
        wakeSleep = wake;
      });
      wakeSleep = null;
    }
  }
  log(`channel worker ${opts.workerId} stopped`);
}
