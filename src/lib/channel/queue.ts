import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { sql } from "@/lib/db";
import { backoffMs, isPermanentError } from "./ranges";

// ============================================================
// Database-backed channel job queue (§T). Foundation only in Phase 3:
// jobs can be enqueued (idempotently) and claimed (FOR UPDATE SKIP LOCKED,
// FIFO per connection), but NO worker process is scheduled — nothing runs,
// nothing talks to a provider.
// ============================================================

export type ChannelJobType =
  | "validate_connection" | "full_sync" | "sync_availability" | "sync_rates"
  | "sync_restrictions" | "sync_ari_range" | "pull_booking_revisions"
  | "import_booking_revision" | "acknowledge_booking_revision"
  | "reconcile_inventory" | "retry_failed_range"
  // D64 — physical room → Channex Room Type sync: one parent operation plus one
  // deduplicated durable item per physical room (db/migrations/024).
  | "sync_room_types" | "create_room_type"
  // D65 — (room × local rate plan) → Channex Rate Plan sync (db/migrations/025).
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
  return rows[0] ?? { duplicate: true };
}

// Claim runnable jobs. FIFO per connection: a connection with a job already
// processing is skipped entirely, so two workers can never publish
// conflicting ARI ranges for the same connection concurrently.
export async function claimChannelJobs(workerId: string, limit = 5) {
  return sql.begin(async (tx) => {
    const jobs = await tx<{ id: string; job_type: ChannelJobType; connection_id: string; payload: unknown }[]>`
      UPDATE guesthub.channel_sync_jobs j SET
        status = 'processing', locked_at = now(), locked_by = ${workerId},
        started_at = COALESCE(j.started_at, now()), attempts = j.attempts + 1
      WHERE j.id IN (
        SELECT c.id FROM guesthub.channel_sync_jobs c
        WHERE c.status IN ('queued', 'retry_wait')
          AND c.next_attempt_at <= now()
          AND NOT EXISTS (
            SELECT 1 FROM guesthub.channel_sync_jobs p
            WHERE p.connection_id = c.connection_id AND p.status = 'processing')
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
