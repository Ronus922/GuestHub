import "server-only";
import type { Sql } from "postgres";
import { sql } from "@/lib/db";
import type { ChannelEnvironment } from "./config";

// ============================================================
// Channex certification evidence ledger (Stage 4 §13, defects H9/H10).
//
// APPEND-ONLY. recordAriEvidence() is the ONLY writer; it is called from the ARI
// send path (full sync + incremental drain) and the inbound acknowledgement
// path, so Task IDs are never discarded again. loadEvidenceLedger() is the
// read-only reader the certification console renders. Nothing here triggers a
// scenario — this module carries evidence, not control.
// ============================================================

export type EvidenceOutcome = "success" | "partial" | "failed";

export type AriEvidence = {
  tenantId: string;
  connectionId: string | null;
  environment: ChannelEnvironment;
  scenarioKey: string;
  kind?: string | null;
  uiWorkflow?: string | null;
  firingFile?: string | null;
  firingFunction?: string | null;
  requestCount: number;
  expectedRequests?: number | null;
  requestBytes?: number | null;
  taskIds?: string[];
  dateFrom?: string | null;
  dateTo?: string | null;
  warnings?: unknown[];
  outcome: EvidenceOutcome;
  errorCode?: string | null;
  errorMessage?: string | null;
  jobId?: string | null;
  context?: Record<string, unknown>;
};

// Append one evidence row. Never throws into the caller's critical path — a
// failure to record evidence must not fail an otherwise-successful sync; it is
// logged and swallowed. (ponytail: evidence is observability, not correctness.)
export async function recordAriEvidence(db: Sql, e: AriEvidence): Promise<void> {
  try {
    await db`
      INSERT INTO guesthub.channel_evidence_ledger
        (tenant_id, connection_id, environment, scenario_key, kind,
         ui_workflow, firing_file, firing_function,
         request_count, expected_requests, request_bytes, task_ids,
         date_from, date_to, warnings, outcome, error_code, error_message, job_id, context)
      VALUES (
        ${e.tenantId}, ${e.connectionId}, ${e.environment}, ${e.scenarioKey}, ${e.kind ?? null},
        ${e.uiWorkflow ?? null}, ${e.firingFile ?? null}, ${e.firingFunction ?? null},
        ${e.requestCount}, ${e.expectedRequests ?? null}, ${e.requestBytes ?? null},
        ${db.array(e.taskIds ?? [])}::text[],
        ${e.dateFrom ?? null}, ${e.dateTo ?? null},
        ${db.json((e.warnings ?? []) as never)}, ${e.outcome},
        ${e.errorCode ?? null}, ${e.errorMessage ?? null}, ${e.jobId ?? null},
        ${db.json((e.context ?? {}) as never)})`;
  } catch (err) {
    console.error("[channel-evidence] failed to record evidence", err);
  }
}

export type EvidenceRow = {
  id: string;
  environment: string;
  scenarioKey: string;
  kind: string | null;
  uiWorkflow: string | null;
  firingFile: string | null;
  firingFunction: string | null;
  requestCount: number;
  expectedRequests: number | null;
  requestBytes: number | null;
  taskIds: string[];
  dateFrom: string | null;
  dateTo: string | null;
  warnings: unknown[];
  outcome: string;
  errorCode: string | null;
  errorMessage: string | null;
  jobId: string | null;
  context: Record<string, unknown>;
  createdAt: string;
};

// Read-only ledger view for the certification console. Tenant-scoped, newest
// first, bounded. SELECT only.
export async function loadEvidenceLedger(
  tenantId: string,
  opts?: { limit?: number; scenarioKey?: string },
): Promise<EvidenceRow[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, environment, scenario_key, kind, ui_workflow, firing_file, firing_function,
           request_count, expected_requests, request_bytes, task_ids,
           date_from::text AS date_from, date_to::text AS date_to,
           warnings, outcome, error_code, error_message, job_id, context, created_at
    FROM guesthub.channel_evidence_ledger
    WHERE tenant_id = ${tenantId}
      ${opts?.scenarioKey ? sql`AND scenario_key = ${opts.scenarioKey}` : sql``}
    ORDER BY created_at DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id as string,
    environment: r.environment as string,
    scenarioKey: r.scenario_key as string,
    kind: (r.kind as string) ?? null,
    uiWorkflow: (r.ui_workflow as string) ?? null,
    firingFile: (r.firing_file as string) ?? null,
    firingFunction: (r.firing_function as string) ?? null,
    requestCount: Number(r.request_count ?? 0),
    expectedRequests: r.expected_requests == null ? null : Number(r.expected_requests),
    requestBytes: r.request_bytes == null ? null : Number(r.request_bytes),
    taskIds: (r.task_ids as string[]) ?? [],
    dateFrom: (r.date_from as string) ?? null,
    dateTo: (r.date_to as string) ?? null,
    warnings: (r.warnings as unknown[]) ?? [],
    outcome: r.outcome as string,
    errorCode: (r.error_code as string) ?? null,
    errorMessage: (r.error_message as string) ?? null,
    jobId: (r.job_id as string) ?? null,
    context: (r.context as Record<string, unknown>) ?? {},
    createdAt: new Date(r.created_at as string).toISOString(),
  }));
}
