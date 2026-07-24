import "server-only";
import type { Sql } from "postgres";
import { sql } from "@/lib/db";
import { addDays, todayInTz, type DateOnly } from "@/lib/dates";
import { channexBaseUrl } from "./config";
import { decryptSecret, channelSecretsConfigured } from "./crypto";
import { runChannexConnectionTest } from "./connection-test";
import { projectAri, type AriProjection } from "./ari-projection";
import {
  buildAvailabilityValues, buildRestrictionValues, payloadByteSize,
  type AvailabilityInput, type RestrictionInput,
} from "./ari-payloads";
import { pushAri, summarizeWarnings, type AriPushResult, type SafeAriWarning } from "./channex-ari";
import { recordAriEvidence, type EvidenceOutcome } from "./evidence";
import {
  circuitAllowsRequest, onCircuitFailure, onCircuitSuccess, failureKindOf,
  type CircuitState,
} from "./circuit-breaker";
import { logChannelError } from "./queue";
import { ARI_HORIZON_DAYS, backoffMs } from "./ranges";
import {
  PHASE_LABELS, initialProgress, isTerminalPhase, phaseFloor, phasePercent,
  type FullSyncProgress,
} from "./ari-progress";

// ============================================================
// Channex ARI synchronisation (D68). Two entry points, ONE projection:
//
//   runInitialFullSync  — the operator-triggered baseline. Exactly 500
//                         property-local dates, one availability request and one
//                         rates/restrictions request (Channex: "a full sync
//                         would be 2 API calls"). Enables incremental sync only
//                         on a clean, warning-free result.
//   drainAriDirtyRanges — the incremental pass. Reads the durable dirty ranges
//                         the canonical saves committed, sends ONLY the affected
//                         rooms/plans/dates, and never falls back to a full sync.
//
// Both are invoked by the PM2 channel worker (src/lib/channel/worker.ts) through
// the durable job queue. Neither is ever called from a save transaction, a page
// render, a migration or a test.
// ============================================================

/** §3.2 — the initial synchronisation horizon, in property-local dates. */
export const FULL_SYNC_DAYS = ARI_HORIZON_DAYS;

/** Channex: 10 restriction + 10 availability requests per minute per property. */
const REQUESTS_PER_MINUTE = 10;
const PACE_MS = Math.ceil(60_000 / REQUESTS_PER_MINUTE) + 500; // ~6.5s between calls
/** Hard ceiling per drain so one connection can never monopolise the worker. */
const MAX_REQUESTS_PER_KIND_PER_RUN = 6;
/** How many dirty ranges one drain claims. */
const MAX_RANGES_PER_RUN = 500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type AriConnection = {
  id: string;
  tenant_id: string;
  channex_property_id: string;
  api_key_ciphertext: string;
  // §11: the connection's environment is the ONLY source of the Channex base URL.
  environment: "staging" | "production";
  // §16 circuit-breaker state, persisted between drains.
  circuit_open_until: string | null;
  consecutive_failures: number;
};

export type SendOutcome = {
  requests: number;
  taskIds: string[];
  warnings: SafeAriWarning[];
  /** a transport/auth/validation failure — the range stays retryable */
  failure: { code: string; message: string; retryAfterMs?: number } | null;
  /** batches left unsent because the per-run request ceiling was reached */
  deferredBatches: number;
};

export type FullSyncResult = {
  ok: boolean;
  dateFrom: DateOnly;
  dateTo: DateOnly; // inclusive, = dateFrom + 499
  availability: SendOutcome;
  restrictions: SendOutcome;
  blocked: number;
  error: string | null;
};

import type { DrainSummary } from "./ari-projection";
export type { DrainSummary };

// §16 — read/write the persisted breaker state on the connection row.
function circuitStateOf(conn: AriConnection): CircuitState {
  return {
    consecutiveFailures: conn.consecutive_failures ?? 0,
    openUntil: conn.circuit_open_until ? Date.parse(conn.circuit_open_until) : null,
  };
}
async function persistCircuit(db: Sql, connId: string, next: CircuitState): Promise<void> {
  await db`
    UPDATE guesthub.channel_connections
    SET circuit_open_until = ${next.openUntil ? new Date(next.openUntil).toISOString() : null},
        consecutive_failures = ${next.consecutiveFailures}
    WHERE id = ${connId}`;
}

// The one seam a check may substitute: the same `fetchImpl` channex-http already
// accepts. Absent everywhere in production — the worker never passes it — so a
// test can assert "exactly these two requests, with exactly these values" without
// any network, and no test-only branch exists in the send path itself.
export type AriSyncDeps = {
  fetchImpl?: typeof fetch;
  /** injectable clock for the progress throttle + timestamps ONLY — never the percentage */
  now?: () => number;
};

// ---- credentials (never returned, never logged) ----
type Creds = { apiKey: string; baseUrl: string; propertyId: string; fetchImpl?: typeof fetch };

function credentialsFor(conn: AriConnection, deps?: AriSyncDeps): Creds | { error: string } {
  if (!channelSecretsConfigured()) return { error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת" };
  if (!conn.channex_property_id) return { error: "לא קיים נכס Channex ממופה" };
  if (!conn.api_key_ciphertext) return { error: "מפתח API לא הוגדר" };
  try {
    return {
      apiKey: decryptSecret(conn.api_key_ciphertext),
      // §11 canonical routing: resolve the base URL from the connection's own
      // environment — never a hardcoded staging constant (was defect CHX G6).
      baseUrl: channexBaseUrl(conn.environment),
      propertyId: conn.channex_property_id,
      fetchImpl: deps?.fetchImpl,
    };
  } catch {
    return { error: "פענוח המפתח נכשל — ייתכן שמפתח ההצפנה בשרת השתנה" };
  }
}

// ============================================================
// Persisted progress (D69). THE single writer: only runInitialFullSync — which
// only ever runs inside the PM2 channel worker — writes it. The web process
// reads it. There is no second progress writer anywhere.
//
// Storage is the EXISTING job row: guesthub.channel_sync_jobs.payload.progress,
// merged with jsonb `||` so the task_ids/warnings the run records separately are
// never clobbered. The job id IS the run id, and status/started_at/finished_at
// already live on the row — no new table, no new column, no migration.
//
// Writes are throttled: a phase change or a terminal state always flushes, and
// otherwise at most one write per PROGRESS_WRITE_MS. Over a 500-day sync that is
// a few dozen updates, never one per date.
// ============================================================
const PROGRESS_WRITE_MS = 900;

type ProgressPatch = Partial<Omit<FullSyncProgress, "runId" | "startedAt">>;

type ProgressReporter = {
  set: (patch: ProgressPatch) => Promise<void>;
  /** current in-memory record (already merged) */
  current: () => FullSyncProgress;
};

function makeProgressReporter(
  db: Sql,
  jobId: string | null,
  startedAt: string,
  now: () => number,
): ProgressReporter {
  let state = initialProgress(jobId ?? "", startedAt);
  let lastWrite = 0;

  const flush = async () => {
    if (!jobId) return;
    lastWrite = now();
    await db`
      UPDATE guesthub.channel_sync_jobs
      SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('progress', ${db.json(state as never)})
      WHERE id = ${jobId}`;
  };

  return {
    current: () => state,
    async set(patch) {
      const phaseChanged = patch.phase !== undefined && patch.phase !== state.phase;
      state = { ...state, ...patch, updatedAt: new Date(now()).toISOString() };
      const terminal = isTerminalPhase(state.phase);
      if (phaseChanged || terminal || now() - lastWrite >= PROGRESS_WRITE_MS) await flush();
    },
  };
}

// ---- mapping lookups ----
async function loadMappings(db: Sql, connectionId: string) {
  const rooms = await db<{ room_id: string; channex_room_type_id: string }[]>`
    SELECT room_id, channex_room_type_id FROM guesthub.channel_room_mappings
    WHERE connection_id = ${connectionId} AND status = 'mapped' AND channex_room_type_id IS NOT NULL`;
  const combos = await db<{ room_id: string; local_rate_plan_id: string; channex_rate_plan_id: string }[]>`
    SELECT room_id, local_rate_plan_id, channex_rate_plan_id
    FROM guesthub.channel_room_rate_mappings
    WHERE connection_id = ${connectionId} AND status = 'mapped' AND channex_rate_plan_id IS NOT NULL`;
  return {
    roomTypeByRoomId: new Map(rooms.map((r) => [r.room_id, r.channex_room_type_id])),
    ratePlanByCombo: new Map(combos.map((c) => [`${c.room_id}|${c.local_rate_plan_id}`, c.channex_rate_plan_id])),
  };
}

// ---- send one kind, paced, bounded ----
async function sendBatches(
  creds: Creds,
  kind: "availability" | "restrictions",
  batches: { values: unknown[] }[],
): Promise<SendOutcome> {
  const outcome: SendOutcome = { requests: 0, taskIds: [], warnings: [], failure: null, deferredBatches: 0 };
  const sendable = batches.slice(0, MAX_REQUESTS_PER_KIND_PER_RUN);
  outcome.deferredBatches = batches.length - sendable.length;

  for (let i = 0; i < sendable.length; i++) {
    // stay inside the per-minute provider budget (a substituted fetch needs no pacing)
    if (i > 0 && !creds.fetchImpl) await sleep(PACE_MS);
    const res: AriPushResult = await pushAri({
      apiKey: creds.apiKey, baseUrl: creds.baseUrl, kind,
      batch: sendable[i] as { values: unknown[] },
      ...(creds.fetchImpl ? { fetchImpl: creds.fetchImpl } : {}),
    });
    outcome.requests += 1;
    if (!res.ok) {
      outcome.failure = {
        code: res.category, message: res.message,
        ...(res.retryAfterMs !== undefined ? { retryAfterMs: res.retryAfterMs } : {}),
      };
      return outcome; // stop this kind — the caller keeps the ranges retryable
    }
    outcome.taskIds.push(...res.taskIds);
    if (res.partial) outcome.warnings.push(...res.warnings);
  }
  return outcome;
}

function toInputs(projection: AriProjection): { availability: AvailabilityInput[]; restrictions: RestrictionInput[] } {
  return {
    availability: projection.availability.map((a) => ({
      roomId: a.roomId, date: a.date, availability: a.availability,
    })),
    restrictions: projection.commercial.map((c) => ({
      roomId: c.roomId, planId: c.planId, date: c.date,
      rates: c.rates,
      minStayArrival: c.minStayArrival, minStayThrough: c.minStayThrough, maxStay: c.maxStay,
      stopSell: c.stopSell, closedToArrival: c.closedToArrival, closedToDeparture: c.closedToDeparture,
    })),
  };
}

// ============================================================
// Initial Full Sync (§3)
// ============================================================

/** Structural readiness — never a commercial judgement. */
export async function validateFullSyncReadiness(
  db: Sql,
  conn: AriConnection,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!conn.channex_property_id) return { ok: false, error: "לא קיים מיפוי נכס Channex" };

  const [rooms] = await db<{ total: number; mapped: number }[]>`
    SELECT count(*)::int AS total,
           count(*) FILTER (
             WHERE m.status = 'mapped' AND m.channex_room_type_id IS NOT NULL)::int AS mapped
    FROM guesthub.rooms r
    LEFT JOIN guesthub.channel_room_mappings m
      ON m.room_id = r.id AND m.connection_id = ${conn.id}
    WHERE r.tenant_id = ${conn.tenant_id}`;
  if (!rooms || rooms.total === 0) return { ok: false, error: "אין חדרים לסנכרון" };
  if (rooms.mapped !== rooms.total)
    return { ok: false, error: `רק ${rooms.mapped} מתוך ${rooms.total} חדרים ממופים ל-Channex` };

  const [combos] = await db<{ required: number; mapped: number; broken: number }[]>`
    WITH plans AS (
      SELECT id FROM guesthub.pricing_plans
      WHERE tenant_id = ${conn.tenant_id} AND sellable_unit_id IS NULL
        AND is_active AND NOT is_archived AND is_visible_channels),
    rooms AS (
      SELECT room_id FROM guesthub.channel_room_mappings
      WHERE connection_id = ${conn.id} AND status = 'mapped')
    SELECT (SELECT count(*) FROM plans) * (SELECT count(*) FROM rooms) AS required,
           (SELECT count(*) FROM guesthub.channel_room_rate_mappings
             WHERE connection_id = ${conn.id} AND status = 'mapped'
               AND channex_rate_plan_id IS NOT NULL)::int AS mapped,
           (SELECT count(*) FROM guesthub.channel_room_rate_mappings
             WHERE connection_id = ${conn.id}
               AND status IN ('failed','reconciliation_required'))::int AS broken`;
  if (!combos || combos.required === 0) return { ok: false, error: "אין תוכניות תעריף גלויות לערוצים" };
  if (combos.broken > 0)
    return { ok: false, error: `קיימות ${combos.broken} התאמות תעריף שדורשות טיפול לפני סנכרון` };
  if (combos.mapped < combos.required)
    return { ok: false, error: `רק ${combos.mapped} מתוך ${combos.required} שילובי חדר×תוכנית ממופים` };

  const [brokenRooms] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM guesthub.channel_room_mappings
    WHERE connection_id = ${conn.id} AND status IN ('failed','reconciliation_required')`;
  if ((brokenRooms?.n ?? 0) > 0)
    return { ok: false, error: `קיימות ${brokenRooms.n} התאמות חדר שדורשות טיפול לפני סנכרון` };

  return { ok: true };
}

export async function runInitialFullSync(
  db: Sql,
  conn: AriConnection,
  jobId: string | null,
  deps?: AriSyncDeps,
): Promise<FullSyncResult> {
  // injectable clock: the throttle and the timestamps are the only time inputs,
  // and NEITHER feeds the percentage (§3 — progress is milestone-based).
  const now = deps?.now ?? (() => Date.now());
  const startedAt = new Date(now()).toISOString();
  const progress = makeProgressReporter(db, jobId, startedAt, now);

  const [tenant] = await db<{ timezone: string | null }[]>`
    SELECT timezone FROM guesthub.tenants WHERE id = ${conn.tenant_id}`;
  const today = todayInTz(tenant?.timezone || "Asia/Jerusalem");
  const dateToExclusive = addDays(today, FULL_SYNC_DAYS);
  const dateToInclusive = addDays(today, FULL_SYNC_DAYS - 1);

  const empty: SendOutcome = { requests: 0, taskIds: [], warnings: [], failure: null, deferredBatches: 0 };

  // A failed run FREEZES the bar at the phase it actually reached — never 100%,
  // and never a phase it did not enter.
  const fail = async (error: string, category: string): Promise<FullSyncResult> => {
    await progress.set({
      phase: "failed",
      percent: progress.current().percent,
      message: error,
      errorCategory: category,
      failedAt: new Date(now()).toISOString(),
    });
    return {
      ok: false, dateFrom: today, dateTo: dateToInclusive,
      availability: empty, restrictions: empty, blocked: 0, error,
    };
  };

  // ---- phase: validating (0–10%) ----
  await progress.set({
    phase: "validating", percent: phaseFloor("validating"), message: PHASE_LABELS.validating,
    dateFrom: today, dateTo: dateToInclusive, days: FULL_SYNC_DAYS,
  });

  const ready = await validateFullSyncReadiness(db, conn);
  if (!ready.ok) return fail(ready.error, "validation");

  const creds = credentialsFor(conn, deps);
  if ("error" in creds) return fail(creds.error, "configuration");

  // D70 §7 — authenticate the STORED key before anything is projected or sent.
  // A job enqueued before the credential rotated (or was revoked) must fail here,
  // during `validating`, and never reach an ARI request. This is a GET, not ARI.
  const auth = await runChannexConnectionTest({
    apiKey: creds.apiKey,
    baseUrl: creds.baseUrl,
    ...(creds.fetchImpl ? { fetchImpl: creds.fetchImpl } : {}),
  });
  if (!auth.ok) return fail(auth.message, auth.category);

  const { roomTypeByRoomId, ratePlanByCombo } = await loadMappings(db, conn.id);
  await progress.set({
    percent: phasePercent("validating", 1, 1),
    roomsTotal: roomTypeByRoomId.size,
    ratePlansTotal: ratePlanByCombo.size,
  });

  const projectArgs = {
    tenantId: conn.tenant_id, connectionId: conn.id,
    dateFrom: today, dateTo: dateToExclusive,
  };

  // ---- phase: projecting availability (10–30%) ----
  await progress.set({
    phase: "projecting_availability", percent: phaseFloor("projecting_availability"),
    message: PHASE_LABELS.projecting_availability,
  });
  const availProjection = await projectAri(
    db, { ...projectArgs, include: { availability: true, commercial: false } },
    async (p) => {
      if (p.kind !== "availability") return;
      await progress.set({
        percent: phasePercent("projecting_availability", p.done, p.total),
        roomsProjected: p.done, roomsTotal: p.total,
      });
    },
  );
  if (availProjection.availability.length === 0) {
    return fail("לא נמצאו חדרים ממופים לסנכרון", "validation");
  }
  const avail = buildAvailabilityValues(
    toInputs(availProjection).availability, creds.propertyId, roomTypeByRoomId,
  );
  const availabilityValues = avail.batches.reduce((n, b) => n + b.values.length, 0);

  // ---- phase: submitting availability (30–45%) ----
  await progress.set({
    phase: "submitting_availability", percent: phaseFloor("submitting_availability"),
    message: PHASE_LABELS.submitting_availability, availabilityValues,
  });
  const availabilityOutcome = await sendBatches(creds, "availability", avail.batches);
  if (availabilityOutcome.failure) {
    return fail(availabilityOutcome.failure.message, availabilityOutcome.failure.code);
  }
  await progress.set({
    percent: phasePercent("submitting_availability", 1, 1),
    availabilitySubmitted: true,
    taskIds: [...availabilityOutcome.taskIds],
  });

  // ---- phase: projecting rates + restrictions (45–75%) ----
  await progress.set({
    phase: "projecting_rates", percent: phaseFloor("projecting_rates"),
    message: PHASE_LABELS.projecting_rates,
  });
  const rateProjection = await projectAri(
    db, { ...projectArgs, include: { availability: false, commercial: true } },
    async (p) => {
      if (p.kind !== "commercial") return;
      await progress.set({
        percent: phasePercent("projecting_rates", p.done, p.total),
        ratePlansProjected: p.done, ratePlansTotal: p.total,
      });
    },
  );
  const sellable = rateProjection.commercial.filter((c) => c.rates !== null).length;
  if (sellable === 0) {
    return fail("לא ניתן לחשב מחיר לאף שילוב חדר×תוכנית — בדוק תמחור לפני סנכרון", "validation");
  }
  const restr = buildRestrictionValues(
    toInputs(rateProjection).restrictions, creds.propertyId, ratePlanByCombo,
  );
  const restrictionValues = restr.batches.reduce((n, b) => n + b.values.length, 0);

  // ---- phase: submitting rates + restrictions (75–90%) ----
  await progress.set({
    phase: "submitting_rates", percent: phaseFloor("submitting_rates"),
    message: PHASE_LABELS.submitting_rates,
    blocked: rateProjection.blocked.length, restrictionValues,
  });
  const restrictionsOutcome = await sendBatches(creds, "restrictions", restr.batches);

  const failure = restrictionsOutcome.failure;
  const warnings = [...availabilityOutcome.warnings, ...restrictionsOutcome.warnings];
  const deferred = availabilityOutcome.deferredBatches + restrictionsOutcome.deferredBatches;
  const clean = !failure && warnings.length === 0 && deferred === 0;
  const projectionBlocked = rateProjection.blocked.length;

  if (!failure) {
    await progress.set({
      percent: phasePercent("submitting_rates", 1, 1),
      restrictionsSubmitted: true,
      taskIds: [...availabilityOutcome.taskIds, ...restrictionsOutcome.taskIds],
    });
  }

  // §3.5 — record range, timestamp, safe task references and safe warnings.
  // `payload || …` MERGES, so the progress record written above survives.
  if (jobId) {
    await db`
      UPDATE guesthub.channel_sync_jobs SET
        date_from = ${today}, date_to = ${dateToInclusive},
        provider_task_id = ${availabilityOutcome.taskIds[0] ?? restrictionsOutcome.taskIds[0] ?? null},
        payload = COALESCE(payload, '{}'::jsonb) || ${db.json({
          task_ids: [...availabilityOutcome.taskIds, ...restrictionsOutcome.taskIds],
          warnings,
          blocked: projectionBlocked,
          deferred_batches: deferred,
        } as never)}
      WHERE id = ${jobId}`;
  }

  if (failure) {
    await logChannelError(db, {
      tenantId: conn.tenant_id, connectionId: conn.id, jobId: jobId ?? undefined,
      dateFrom: today, dateTo: dateToInclusive,
      code: failure.code, message: failure.message,
    });
  } else if (warnings.length > 0) {
    await logChannelError(db, {
      tenantId: conn.tenant_id, connectionId: conn.id, jobId: jobId ?? undefined,
      dateFrom: today, dateTo: dateToInclusive,
      code: "partial_warnings", message: summarizeWarnings(warnings),
      context: { warnings },
    });
  }

  // ---- phase: checking warnings + results (90–97%) ----
  // Reached even on failure: the run genuinely got this far, and the bar must
  // stop where the work stopped.
  await progress.set({
    phase: "checking_warnings", percent: phaseFloor("checking_warnings"),
    message: PHASE_LABELS.checking_warnings, warnings: warnings.length,
  });

  const errorMessage = failure ? failure.message : warnings.length ? summarizeWarnings(warnings) : null;

  // §11 — a 200 carrying warnings is NOT a fully successful synchronisation.
  // Incremental delivery is enabled only from a clean baseline; anything else
  // leaves full_sync_required=true so the operator re-runs after fixing.
  if (clean) {
    await progress.set({ percent: phasePercent("checking_warnings", 1, 1) });

    // ---- phase: activating incremental sync (97–100%) ----
    await progress.set({
      phase: "activating_incremental_sync", percent: phaseFloor("activating_incremental_sync"),
      message: PHASE_LABELS.activating_incremental_sync,
    });
    await db`
      UPDATE guesthub.channel_connections SET
        state = 'active', outbound_sync_enabled = true, full_sync_required = false,
        last_outbound_sync_at = now(), last_error = NULL
      WHERE id = ${conn.id}`;

    // ---- phase: completed (100%) — reachable ONLY from a clean run ----
    await progress.set({
      phase: "completed", percent: 100, message: PHASE_LABELS.completed,
      completedAt: new Date(now()).toISOString(),
    });
  } else {
    await db`
      UPDATE guesthub.channel_connections SET
        full_sync_required = true,
        last_error = ${errorMessage}
      WHERE id = ${conn.id}`;

    // Warnings, a deferred batch or a rates failure all end the run WITHOUT
    // 100% and WITHOUT activating incremental sync. availabilitySubmitted /
    // restrictionsSubmitted already record how far the external state got, so
    // the UI can say "זמינות נשלחה, מחירים והגבלות נכשלו" truthfully.
    await progress.set({
      phase: "failed",
      percent: progress.current().percent,
      message: errorMessage ?? PHASE_LABELS.failed,
      errorCategory: failure ? failure.code : warnings.length ? "partial_warnings" : "deferred_batches",
      warnings: warnings.length,
      failedAt: new Date(now()).toISOString(),
    });
  }

  // §13 — durable certification evidence. A Full Sync is expected to be exactly
  // two Channex requests (one availability, one rates/restrictions); record the
  // actual counts + all Task IDs so the console can prove it against the official
  // expectation. Never discards Task IDs (H9/H10).
  const fullSyncOutcome: EvidenceOutcome = clean ? "success" : failure ? "failed" : "partial";
  const availabilityBytes = avail.batches.reduce((n, b) => n + payloadByteSize(b), 0);
  const restrictionBytes = restr.batches.reduce((n, b) => n + payloadByteSize(b), 0);
  await recordAriEvidence(db, {
    tenantId: conn.tenant_id,
    connectionId: conn.id,
    environment: conn.environment,
    scenarioKey: "full_sync",
    kind: "availability+restrictions",
    uiWorkflow: "Channels → Full Sync",
    firingFile: "src/lib/channel/ari-sync.ts",
    firingFunction: "runInitialFullSync",
    requestCount: availabilityOutcome.requests + restrictionsOutcome.requests,
    expectedRequests: 2,
    requestBytes: availabilityBytes + restrictionBytes,
    taskIds: [...availabilityOutcome.taskIds, ...restrictionsOutcome.taskIds],
    dateFrom: today,
    dateTo: dateToInclusive,
    warnings,
    outcome: fullSyncOutcome,
    errorCode: failure ? failure.code : warnings.length ? "partial_warnings" : null,
    errorMessage,
    jobId,
    context: {
      availabilityRequests: availabilityOutcome.requests,
      restrictionRequests: restrictionsOutcome.requests,
      availabilityValues,
      restrictionValues,
      availabilityBytes,
      restrictionBytes,
      deferredBatches: deferred,
      blocked: projectionBlocked,
    },
  });

  return {
    ok: clean,
    dateFrom: today,
    dateTo: dateToInclusive,
    availability: availabilityOutcome,
    restrictions: restrictionsOutcome,
    blocked: projectionBlocked,
    error: errorMessage,
  };
}

// ============================================================
// Incremental drain (§10)
// ============================================================

type DirtyRow = {
  id: string;
  room_id: string;
  local_rate_plan_id: string | null;
  kind: "availability" | "rates" | "restrictions";
  date_from: string;
  date_to: string; // exclusive
  attempts: number;
  max_attempts: number;
};

/** rates + restrictions share ONE Channex endpoint and one canonical value. */
const isCommercial = (k: DirtyRow["kind"]) => k === "rates" || k === "restrictions";

export async function drainAriDirtyRanges(
  db: Sql,
  conn: AriConnection,
  deps?: AriSyncDeps,
): Promise<DrainSummary> {
  const summary: DrainSummary = { claimed: 0, synced: 0, retried: 0, failed: 0, requests: 0, sentValues: 0 };
  const now = deps?.now ?? (() => Date.now());

  // §16 — if the circuit is open (cooling after a 429 or repeated failures), skip
  // this connection entirely. The dirty ranges stay pending and drain once the
  // cooldown elapses; we never hammer a provider that just told us to back off.
  const circuit = circuitStateOf(conn);
  if (!circuitAllowsRequest(circuit, now())) {
    summary.circuitOpen = true;
    return summary;
  }

  // The worker holds this connection's job lease (FIFO per connection), so a
  // plain SELECT is enough — no second claim protocol, no 'queued' limbo.
  const rows = await db<DirtyRow[]>`
    SELECT id, room_id, local_rate_plan_id, kind,
           date_from::text AS date_from, date_to::text AS date_to,
           attempts, max_attempts
    FROM guesthub.channel_dirty_ranges
    WHERE connection_id = ${conn.id} AND status = 'pending' AND next_attempt_at <= now()
    ORDER BY revision
    LIMIT ${MAX_RANGES_PER_RUN}`;
  if (rows.length === 0) return summary;
  summary.claimed = rows.length;

  const creds = credentialsFor(conn, deps);
  if ("error" in creds) {
    await failRanges(db, conn, rows, { code: "configuration", message: creds.error });
    summary.retried = rows.length;
    return summary;
  }

  // ---- merge (§10): union the claimed ranges into the smallest projection
  // window per dimension, so overlapping/adjacent edits become one request. ----
  const availRows = rows.filter((r) => r.kind === "availability");
  const commRows = rows.filter((r) => isCommercial(r.kind));

  const span = (rs: DirtyRow[]) => ({
    from: rs.reduce((a, r) => (r.date_from < a ? r.date_from : a), rs[0].date_from),
    to: rs.reduce((a, r) => (r.date_to > a ? r.date_to : a), rs[0].date_to),
  });

  const { roomTypeByRoomId, ratePlanByCombo } = await loadMappings(db, conn.id);
  const outcomes: SendOutcome[] = [];

  // --- availability: only the affected rooms, only the affected dates ---
  if (availRows.length > 0) {
    const { from, to } = span(availRows);
    const roomIds = [...new Set(availRows.map((r) => r.room_id))];
    const projection = await projectAri(db, {
      tenantId: conn.tenant_id, connectionId: conn.id, dateFrom: from, dateTo: to, roomIds,
      include: { availability: true, commercial: false }, // rates were not dirtied
    });
    const wanted = new Set(availRows.map((r) => r.room_id));
    const inputs = projection.availability
      .filter((a) => wanted.has(a.roomId) && coveredBy(availRows, a.roomId, null, a.date))
      .map((a) => ({ roomId: a.roomId, date: a.date, availability: a.availability }));
    if (inputs.length > 0) {
      const built = buildAvailabilityValues(inputs, creds.propertyId, roomTypeByRoomId);
      const outcome = await sendBatches(creds, "availability", built.batches);
      outcomes.push(outcome);
      summary.requests += outcome.requests;
      summary.sentValues += built.batches.reduce((n, b) => n + b.values.length, 0);
    }
  }

  // --- rates + restrictions: only the affected (room, plan, date) combinations ---
  if (commRows.length > 0) {
    const { from, to } = span(commRows);
    const roomIds = [...new Set(commRows.map((r) => r.room_id))];
    // a NULL plan scope means "every channel-visible plan of this room": leave
    // planIds unset so the projection derives the full eligible set.
    const scoped = commRows.every((r) => r.local_rate_plan_id != null);
    const planIds = scoped
      ? [...new Set(commRows.map((r) => r.local_rate_plan_id as string))]
      : undefined;
    const projection = await projectAri(db, {
      tenantId: conn.tenant_id, connectionId: conn.id, dateFrom: from, dateTo: to, roomIds, planIds,
      include: { availability: false, commercial: true }, // availability was not dirtied
    });
    const inputs = projection.commercial
      .filter((c) => coveredBy(commRows, c.roomId, c.planId, c.date))
      .map((c) => ({
        roomId: c.roomId, planId: c.planId, date: c.date, rates: c.rates,
        minStayArrival: c.minStayArrival, minStayThrough: c.minStayThrough, maxStay: c.maxStay,
        stopSell: c.stopSell, closedToArrival: c.closedToArrival, closedToDeparture: c.closedToDeparture,
      }));
    if (inputs.length > 0) {
      const built = buildRestrictionValues(inputs, creds.propertyId, ratePlanByCombo);
      const outcome = await sendBatches(creds, "restrictions", built.batches);
      outcomes.push(outcome);
      summary.requests += outcome.requests;
      summary.sentValues += built.batches.reduce((n, b) => n + b.values.length, 0);
    }
  }

  const failure = outcomes.find((o) => o.failure)?.failure ?? null;
  const warnings = outcomes.flatMap((o) => o.warnings);
  const deferred = outcomes.reduce((n, o) => n + o.deferredBatches, 0);
  // H9/H10 — incremental Task IDs were previously discarded here. Capture them.
  const taskIds = outcomes.flatMap((o) => o.taskIds);

  // §13 — record incremental-sync evidence with the Task IDs Channex returned.
  const recordIncrementalEvidence = (outcome: EvidenceOutcome, code: string | null, msg: string | null) =>
    recordAriEvidence(db, {
      tenantId: conn.tenant_id,
      connectionId: conn.id,
      environment: conn.environment,
      scenarioKey: "incremental_sync",
      kind: "availability+restrictions",
      uiWorkflow: "canonical save → dirty-range drain",
      firingFile: "src/lib/channel/ari-sync.ts",
      firingFunction: "drainAriDirtyRanges",
      requestCount: summary.requests,
      taskIds,
      warnings,
      outcome,
      errorCode: code,
      errorMessage: msg,
      context: { claimed: summary.claimed, sentValues: summary.sentValues, deferredBatches: deferred },
    });

  if (failure || warnings.length > 0 || deferred > 0) {
    const err = failure ?? { code: "partial_warnings", message: summarizeWarnings(warnings) };
    if (warnings.length > 0) {
      await logChannelError(db, {
        tenantId: conn.tenant_id, connectionId: conn.id,
        code: "partial_warnings", message: summarizeWarnings(warnings), context: { warnings },
      });
    }
    const outcome = await failRanges(db, conn, rows, err);
    summary.retried = outcome.retried;
    summary.failed = outcome.failed;
    // §16 — advance the breaker. A 429 opens it for the provider's Retry-After;
    // repeated server/transport failures open it once the threshold is crossed.
    await persistCircuit(db, conn.id,
      onCircuitFailure(circuit, failureKindOf(err.code), now(), { retryAfterMs: failure?.retryAfterMs }));
    await recordIncrementalEvidence(failure ? "failed" : "partial", err.code, err.message);
    return summary;
  }

  await db`
    UPDATE guesthub.channel_dirty_ranges SET status = 'synced', updated_at = now()
    WHERE id = ANY(${rows.map((r) => r.id)}::uuid[])`;
  await db`
    UPDATE guesthub.channel_connections SET last_outbound_sync_at = now(), last_error = NULL
    WHERE id = ${conn.id}`;
  summary.synced = rows.length;
  // §16 — a clean drain fully closes the breaker.
  if (circuit.consecutiveFailures > 0 || circuit.openUntil !== null) {
    await persistCircuit(db, conn.id, onCircuitSuccess());
  }
  await recordIncrementalEvidence("success", null, null);
  return summary;
}

/** A projected cell belongs to this drain only if a claimed range covers it. */
function coveredBy(rows: DirtyRow[], roomId: string, planId: string | null, date: string): boolean {
  for (const r of rows) {
    if (r.room_id !== roomId) continue;
    if (planId !== null && r.local_rate_plan_id !== null && r.local_rate_plan_id !== planId) continue;
    if (date >= r.date_from && date < r.date_to) return true;
  }
  return false;
}

/** §10 — preserve failed ranges for retry with bounded exponential backoff. */
async function failRanges(
  db: Sql,
  conn: AriConnection,
  rows: DirtyRow[],
  err: { code: string; message: string },
): Promise<{ retried: number; failed: number }> {
  let retried = 0;
  let failed = 0;
  for (const r of rows) {
    const attempts = r.attempts + 1;
    const dead = attempts >= r.max_attempts;
    if (dead) failed += 1;
    else retried += 1;
    await db`
      UPDATE guesthub.channel_dirty_ranges SET
        attempts = ${attempts},
        status = ${dead ? "failed" : "pending"},
        next_attempt_at = now() + make_interval(secs => ${Math.ceil(backoffMs(attempts) / 1000)}),
        last_error_code = ${err.code},
        updated_at = now()
      WHERE id = ${r.id}`;
  }
  await db`
    UPDATE guesthub.channel_connections SET last_error = ${err.message} WHERE id = ${conn.id}`;
  return { retried, failed };
}

/** Connections whose baseline is established — the ONLY ones a drain may touch. */
export async function loadDrainableConnections(db: Sql = sql): Promise<AriConnection[]> {
  return db<AriConnection[]>`
    SELECT id, tenant_id, channex_property_id, api_key_ciphertext, environment,
           circuit_open_until::text AS circuit_open_until, consecutive_failures
    FROM guesthub.channel_connections
    WHERE provider = 'channex' AND is_active_provider = true
      AND state = 'active' AND outbound_sync_enabled = true AND full_sync_required = false
      AND channex_property_id IS NOT NULL AND api_key_ciphertext IS NOT NULL`;
}
