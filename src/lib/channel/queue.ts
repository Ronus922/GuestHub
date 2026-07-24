import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { sql } from "@/lib/db";
import { backoffMs, isPermanentError } from "./ranges";
import { JOBS_WAKE_CHANNEL } from "@/lib/realtime/events";

// ============================================================
// Database-backed channel job queue (§T) — the durable work list the channel
// worker actually runs on. This is LIVE, not a foundation: `guesthub-channel-worker`
// (the PM2 process introduced by D68) claims from here every tick — 20s, or
// immediately on the NOTIFY below — and dispatches each claimed job to Beds24,
// the one supported provider (D78/D91). Reservations, rate saves and the worker's
// own sweeps all reach the channel exclusively through rows in this table.
//
// Jobs enqueue idempotently (partial unique index on the idempotency key),
// claim with FOR UPDATE SKIP LOCKED and FIFO per connection, retry with
// exponential backoff, and dead-letter when permanently invalid or out of
// attempts. A crashed worker's claim expires after JOB_LEASE_MINUTES, so a job
// is never stuck.
//
// The queue stays provider-neutral: it only moves rows between states and knows
// nothing about ARI, bookings or HTTP. worker.ts#runJob is the single dispatch
// seam where a job type becomes a provider call.
// ============================================================

// The full set the DB CHECK constraint accepts (migrations 005/024/025). Only
// FOUR are enqueued and dispatched today (D91): `pull_booking_revisions`,
// `full_sync`, `sync_ari_range`, and `reconcile_inventory` — the last wired by
// D93 to the 20-minute booking-reconciliation cycle, so it is no longer dormant.
// The others are inherited from the Channex era and are unreachable: nothing
// enqueues them, and worker.ts#runJob answers an unsupported type with a
// permanent validation error, so a stray historical row dead-letters loudly
// instead of retrying forever. Narrowing this union means narrowing the CHECK
// constraint too — i.e. a migration, not an edit here.
export type ChannelJobType =
  | "validate_connection" | "full_sync" | "sync_availability" | "sync_rates"
  | "sync_restrictions" | "sync_ari_range" | "pull_booking_revisions"
  | "import_booking_revision" | "acknowledge_booking_revision"
  | "reconcile_inventory" | "retry_failed_range"
  // Legacy Channex structure sync (D64, db/migrations/024) — physical room →
  // channel room type. Never enqueued since D91 removed the provider; retained
  // only because migration 024's CHECK constraint still lists them.
  | "sync_room_types" | "create_room_type"
  // Legacy Channex (room × local rate plan) → channel rate plan sync
  // (D65, db/migrations/025). Same: unreachable, constraint-only.
  | "sync_rate_plans" | "create_rate_plan";

export async function enqueueChannelJob(
  db: Sql | TransactionSql,
  job: {
    tenantId: string;
    connectionId: string;
    jobType: ChannelJobType;
    priority?: number;
    dateFrom?: string;
    dateTo?: string;
    payload?: unknown;
    idempotencyKey?: string;
    roomTypeMappingId?: string;
    // suppressed = recorded but not runnable (e.g. requested while the
    // connection is not active) — prevents a dead backlog (§S)
    suppressed?: boolean;
  },
): Promise<{ id: string } | { duplicate: true }> {
  const rows = await db<{ id: string }[]>`
    INSERT INTO guesthub.channel_sync_jobs
      (tenant_id, connection_id, room_type_mapping_id, job_type, status, priority,
       date_from, date_to, payload, idempotency_key)
    VALUES
      (${job.tenantId}, ${job.connectionId}, ${job.roomTypeMappingId ?? null},
       ${job.jobType}, ${job.suppressed ? "suppressed" : "queued"}, ${job.priority ?? 100},
       ${job.dateFrom ?? null}, ${job.dateTo ?? null},
       ${db.json((job.payload ?? {}) as never)}, ${job.idempotencyKey ?? null})
    ON CONFLICT (connection_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL AND status IN ('queued','processing','retry_wait')
      DO NOTHING
    RETURNING id`;
  // Durable-then-wake (D77 §4): the job row is the truth; the NOTIFY only
  // wakes the worker's sleep. Inside a transaction PostgreSQL delivers it on
  // COMMIT, so the worker can never be woken for an uncommitted job. A
  // duplicate needs no wake — its live twin already produced one.
  if (rows[0] && !job.suppressed) {
    await db`SELECT pg_notify(${JOBS_WAKE_CHANNEL}, ${job.jobType})`;
  }
  return rows[0] ?? { duplicate: true };
}

// How long a claim stays valid. A worker that crashes mid-job leaves its row in
// 'processing' forever; without a lease the FIFO guard below would then wedge
// that connection permanently. After the lease expires the job is reclaimable by
// any worker (PM2 will have restarted the dead one), so no job is ever stuck.
// Sized well above the slowest run: a full sync paces ~6.5s between requests.
export const JOB_LEASE_MINUTES = 10;

// Claim runnable jobs. FIFO per connection: a connection with a LIVE processing
// job is skipped entirely, so two workers can never publish conflicting ARI
// ranges for the same connection concurrently. `FOR UPDATE SKIP LOCKED` makes the
// claim itself atomic — two workers starting at once never take the same row.
export async function claimChannelJobs(workerId: string, limit = 5) {
  return sql.begin(async (tx) => {
    const jobs = await tx<{ id: string; job_type: ChannelJobType; connection_id: string; payload: unknown }[]>`
      UPDATE guesthub.channel_sync_jobs j SET
        status = 'processing', locked_at = now(), locked_by = ${workerId},
        started_at = COALESCE(j.started_at, now()), attempts = j.attempts + 1
      WHERE j.id IN (
        SELECT c.id FROM guesthub.channel_sync_jobs c
        WHERE (
            (c.status IN ('queued', 'retry_wait') AND c.next_attempt_at <= now())
            -- expired lease: the previous worker died holding this job
            OR (c.status = 'processing'
                AND c.locked_at < now() - make_interval(mins => ${JOB_LEASE_MINUTES}))
          )
          AND NOT EXISTS (
            SELECT 1 FROM guesthub.channel_sync_jobs p
            WHERE p.connection_id = c.connection_id AND p.status = 'processing'
              AND p.id <> c.id
              AND p.locked_at >= now() - make_interval(mins => ${JOB_LEASE_MINUTES}))
        ORDER BY c.priority, c.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit})
      RETURNING j.id, j.job_type, j.connection_id, j.payload`;
    return jobs;
  });
}

export async function completeChannelJob(id: string, providerTaskId?: string) {
  await sql`
    UPDATE guesthub.channel_sync_jobs SET
      status = 'succeeded', finished_at = now(), locked_at = NULL, locked_by = NULL,
      provider_task_id = COALESCE(${providerTaskId ?? null}, provider_task_id)
    WHERE id = ${id}`;
}

// Transient failures retry with exponential backoff + jitter; permanent
// validation/mapping errors and exhausted attempts move to dead_letter (§U).
export async function failChannelJob(
  id: string,
  err: { code?: string; message: string },
) {
  const [job] = await sql<{ attempts: number; max_attempts: number }[]>`
    SELECT attempts, max_attempts FROM guesthub.channel_sync_jobs WHERE id = ${id}`;
  if (!job) return;
  const dead = isPermanentError(err.code) || job.attempts >= job.max_attempts;
  const delay = backoffMs(job.attempts);
  await sql`
    UPDATE guesthub.channel_sync_jobs SET
      status = ${dead ? "dead_letter" : "retry_wait"},
      next_attempt_at = now() + make_interval(secs => ${Math.ceil(delay / 1000)}),
      finished_at = ${dead ? sql`now()` : null},
      locked_at = NULL, locked_by = NULL,
      last_error_code = ${err.code ?? null}, last_error_message = ${err.message}
    WHERE id = ${id}`;
}

// Structured, grouped error record (§AA) — never rely on text logs alone.
export async function logChannelError(
  db: Sql | TransactionSql,
  e: {
    tenantId: string;
    connectionId?: string;
    jobId?: string;
    roomTypeId?: string;
    ratePlanMappingId?: string;
    dateFrom?: string;
    dateTo?: string;
    providerTaskId?: string;
    code?: string;
    message: string;
    context?: unknown;
  },
) {
  await db`
    INSERT INTO guesthub.channel_sync_errors
      (tenant_id, connection_id, job_id, room_type_id, rate_plan_mapping_id,
       date_from, date_to, provider_task_id, error_code, error_message, context)
    VALUES
      (${e.tenantId}, ${e.connectionId ?? null}, ${e.jobId ?? null},
       ${e.roomTypeId ?? null}, ${e.ratePlanMappingId ?? null},
       ${e.dateFrom ?? null}, ${e.dateTo ?? null}, ${e.providerTaskId ?? null},
       ${e.code ?? null}, ${e.message}, ${db.json((e.context ?? {}) as never)})`;
}
