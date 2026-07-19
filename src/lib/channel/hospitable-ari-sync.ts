import "server-only";
import type { Sql } from "postgres";
import { sql } from "@/lib/db";
import { addDays, todayInTz, type DateOnly } from "@/lib/dates";
import { hospitableBaseUrl } from "./config";
import { decryptSecret, channelSecretsConfigured } from "./crypto";
import { projectHospitableAri } from "./hospitable-ari-projection";
import type { AriProjection } from "./ari-projection";
import {
  buildHospitableCalendarBatches, calendarPayloadByteSize,
  type HospitableCalendarMapping, type HospitablePropertyBatch,
} from "./hospitable-ari-payloads";
import {
  pushHospitableCalendar, summarizeHospitableWarnings,
  type HospitableCalendarPushResult, type SafeHospitableWarning,
} from "./hospitable-ari";
import { recordAriEvidence, type EvidenceOutcome } from "./evidence";
import {
  circuitAllowsRequest, onCircuitFailure, onCircuitSuccess, failureKindOf,
  type CircuitState,
} from "./circuit-breaker";
import { logChannelError } from "./queue";
import { ARI_HORIZON_DAYS, backoffMs } from "./ranges";
import type { DrainSummary } from "./ari-sync";

// ============================================================
// Hospitable ARI synchronisation (D77 Phase 4) — sibling of ari-sync.ts. Two
// entry points, ONE projection (projectHospitableAri):
//
//   runHospitableFullSync          — the operator-triggered baseline. The same
//                                    500 property-local dates as Channex,
//                                    pushed as full calendar entries (price +
//                                    availability + restrictions in ONE
//                                    endpoint), 90 dates per PUT. Enables
//                                    incremental sync only on a clean result.
//   drainHospitableAriDirtyRanges  — the incremental pass. Consumes the SAME
//                                    guesthub.channel_dirty_ranges rows the
//                                    transactional outbox (outbox.ts) writes
//                                    for EVERY active connection — the outbox
//                                    fan-out is provider-neutral, so a
//                                    hospitable connection accumulates ranges
//                                    with no outbox change.
//
// Both are invoked by the PM2 channel worker through the durable job queue.
// Neither is ever called from a save transaction, a page render or a test.
//
// PACING: Hospitable allows 1000 requests/min — three orders of magnitude
// above what a drain produces — so there is no Channex-style 6.5s pacing.
// A token inter-call delay keeps bursts polite; the per-run request ceiling
// still bounds how long one connection can hold the worker.
// ============================================================

/** Same horizon as the Channex full sync (ari-sync.ts::FULL_SYNC_DAYS). */
export const HOSPITABLE_FULL_SYNC_DAYS = ARI_HORIZON_DAYS;

const PACE_MS = 250;
/** Hard ceiling per run so one connection can never monopolise the worker
 *  (~1 min of paced requests, well inside the 10-min job lease). */
const MAX_REQUESTS_PER_RUN = 240;
/** How many dirty ranges one drain claims (same as ari-sync.ts). */
const MAX_RANGES_PER_RUN = 500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type HospitableAriConnection = {
  id: string;
  tenant_id: string;
  api_key_ciphertext: string;
  /** always 'production' for hospitable rows (no sandbox; admin-enforced) */
  environment: "staging" | "production";
  // §16 circuit-breaker state, persisted between drains.
  circuit_open_until: string | null;
  consecutive_failures: number;
};

export type HospitableSendOutcome = {
  requests: number;
  sentDates: number;
  warnings: SafeHospitableWarning[];
  /** a transport/auth/validation failure — the range stays retryable */
  failure: { code: string; message: string; retryAfterMs?: number } | null;
  /** chunks left unsent because the per-run request ceiling was reached */
  deferredBatches: number;
};

export type HospitableFullSyncResult = {
  ok: boolean;
  dateFrom: DateOnly;
  dateTo: DateOnly; // inclusive, = dateFrom + HOSPITABLE_FULL_SYNC_DAYS - 1
  properties: number;
  outcome: HospitableSendOutcome;
  blocked: number;
  error: string | null;
};

export type HospitableAriSyncDeps = {
  fetchImpl?: typeof fetch;
  /** injectable clock for timestamps ONLY */
  now?: () => number;
};

// §16 — read/write the persisted breaker state on the connection row
// (identical to ari-sync.ts).
function circuitStateOf(conn: HospitableAriConnection): CircuitState {
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

// ---- credentials (never returned, never logged) ----
type Creds = { token: string; baseUrl: string; fetchImpl?: typeof fetch };

function credentialsFor(conn: HospitableAriConnection, deps?: HospitableAriSyncDeps): Creds | { error: string } {
  if (!channelSecretsConfigured()) return { error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת" };
  if (!conn.api_key_ciphertext) return { error: "טוקן PAT לא הוגדר" };
  try {
    return {
      token: decryptSecret(conn.api_key_ciphertext),
      // §11 canonical routing: ONE production base URL — Hospitable has no
      // staging — resolved through config.ts, never a literal here.
      baseUrl: hospitableBaseUrl(),
      fetchImpl: deps?.fetchImpl,
    };
  } catch {
    return { error: "פענוח הטוקן נכשל — ייתכן שמפתח ההצפנה בשרת השתנה" };
  }
}

// ---- mapping lookups ----
type HospitableMappingRow = {
  room_id: string;
  hospitable_property_id: string;
  local_rate_plan_id: string | null;
  calendar_restricted: boolean;
};

async function loadHospitableMappings(db: Sql, connectionId: string): Promise<HospitableMappingRow[]> {
  return db<HospitableMappingRow[]>`
    SELECT room_id, hospitable_property_id, local_rate_plan_id, calendar_restricted
    FROM guesthub.channel_hospitable_property_mappings
    WHERE connection_id = ${connectionId} AND status = 'mapped'`;
}

// calendar_restricted=true means Hospitable rejects calendar pushes upstream
// for that property — pushing anyway would only burn requests into 4xx.
const pushable = (m: HospitableMappingRow) => m.local_rate_plan_id !== null && !m.calendar_restricted;

const toBuilderMappings = (rows: HospitableMappingRow[]): HospitableCalendarMapping[] =>
  rows.filter(pushable).map((m) => ({
    roomId: m.room_id,
    hospitablePropertyId: m.hospitable_property_id,
    localRatePlanId: m.local_rate_plan_id,
  }));

// ---- send every chunk of every property, paced, bounded (mirror of
// ari-sync.ts::sendBatches: stop this run on the first failure — the caller
// keeps the ranges retryable) ----
async function sendCalendarBatches(
  creds: Creds,
  properties: HospitablePropertyBatch[],
): Promise<HospitableSendOutcome> {
  const outcome: HospitableSendOutcome = { requests: 0, sentDates: 0, warnings: [], failure: null, deferredBatches: 0 };
  const flat: { propertyId: string; dates: HospitablePropertyBatch["chunks"][number]["dates"] }[] = [];
  for (const p of properties) {
    for (const chunk of p.chunks) flat.push({ propertyId: p.hospitablePropertyId, dates: chunk.dates });
  }
  const sendable = flat.slice(0, MAX_REQUESTS_PER_RUN);
  outcome.deferredBatches = flat.length - sendable.length;

  for (let i = 0; i < sendable.length; i++) {
    // polite inter-call spacing (a substituted fetch needs no pacing)
    if (i > 0 && !creds.fetchImpl) await sleep(PACE_MS);
    const res: HospitableCalendarPushResult = await pushHospitableCalendar(
      { ...(creds.fetchImpl ? { fetchImpl: creds.fetchImpl } : {}) },
      { token: creds.token, baseUrl: creds.baseUrl, propertyId: sendable[i].propertyId, dates: sendable[i].dates },
    );
    outcome.requests += 1;
    if (!res.ok) {
      outcome.failure = {
        code: res.category, message: res.message,
        ...(res.retryAfterMs !== undefined ? { retryAfterMs: res.retryAfterMs } : {}),
      };
      return outcome; // stop — the caller keeps the ranges retryable
    }
    outcome.sentDates += sendable[i].dates.length;
    if (res.partial) outcome.warnings.push(...res.warnings);
  }
  return outcome;
}

// ============================================================
// Initial Full Sync
// ============================================================

export async function runHospitableFullSync(
  db: Sql,
  conn: HospitableAriConnection,
  jobId: string | null,
  deps?: HospitableAriSyncDeps,
): Promise<HospitableFullSyncResult> {
  const [tenant] = await db<{ timezone: string | null }[]>`
    SELECT timezone FROM guesthub.tenants WHERE id = ${conn.tenant_id}`;
  const today = todayInTz(tenant?.timezone || "Asia/Jerusalem");
  const dateToExclusive = addDays(today, HOSPITABLE_FULL_SYNC_DAYS);
  const dateToInclusive = addDays(today, HOSPITABLE_FULL_SYNC_DAYS - 1);

  const emptyOutcome: HospitableSendOutcome = { requests: 0, sentDates: 0, warnings: [], failure: null, deferredBatches: 0 };

  // A failed run leaves full_sync_required=true so the operator re-runs after
  // fixing — identical policy to ari-sync.ts.
  const fail = async (error: string, category: string, extra?: {
    outcome?: HospitableSendOutcome; properties?: number; blocked?: number; requestBytes?: number;
  }): Promise<HospitableFullSyncResult> => {
    await db`
      UPDATE guesthub.channel_connections SET
        full_sync_required = true, last_error = ${error}
      WHERE id = ${conn.id}`;
    await logChannelError(db, {
      tenantId: conn.tenant_id, connectionId: conn.id, jobId: jobId ?? undefined,
      dateFrom: today, dateTo: dateToInclusive,
      code: category, message: error,
    });
    await recordAriEvidence(db, {
      tenantId: conn.tenant_id,
      connectionId: conn.id,
      environment: conn.environment,
      scenarioKey: "full_sync",
      kind: "calendar",
      uiWorkflow: "Channels → Full Sync (Hospitable)",
      firingFile: "src/lib/channel/hospitable-ari-sync.ts",
      firingFunction: "runHospitableFullSync",
      requestCount: extra?.outcome?.requests ?? 0,
      requestBytes: extra?.requestBytes ?? null,
      dateFrom: today,
      dateTo: dateToInclusive,
      warnings: extra?.outcome?.warnings ?? [],
      outcome: extra?.outcome?.requests ? "partial" : "failed",
      errorCode: category,
      errorMessage: error,
      jobId,
      context: { properties: extra?.properties ?? 0, blocked: extra?.blocked ?? 0 },
    });
    return {
      ok: false, dateFrom: today, dateTo: dateToInclusive,
      properties: extra?.properties ?? 0,
      outcome: extra?.outcome ?? emptyOutcome,
      blocked: extra?.blocked ?? 0,
      error,
    };
  };

  const mappings = await loadHospitableMappings(db, conn.id);
  const builderMappings = toBuilderMappings(mappings);
  if (builderMappings.length === 0) {
    return fail("אין נכסי Hospitable ממופים עם תוכנית תעריף מיועדת", "validation");
  }

  const creds = credentialsFor(conn, deps);
  if ("error" in creds) return fail(creds.error, "configuration");

  // ---- ONE projection over the whole horizon, restricted to mapped rooms ----
  const projection = await projectHospitableAri(db, {
    tenantId: conn.tenant_id, connectionId: conn.id,
    dateFrom: today, dateTo: dateToExclusive,
    roomIds: builderMappings.map((m) => m.roomId),
  });
  const sellable = projection.commercial.filter((c) => c.rates !== null).length;
  if (sellable === 0) {
    return fail("לא ניתן לחשב מחיר לאף נכס ממופה — בדוק תמחור לפני סנכרון", "validation", {
      blocked: projection.blocked.length,
    });
  }

  const built = buildHospitableCalendarBatches(projection, builderMappings);
  const requestBytes = built.properties.reduce(
    (n, p) => n + p.chunks.reduce((m, c) => m + calendarPayloadByteSize(c), 0), 0);
  const expectedRequests = built.properties.reduce((n, p) => n + p.chunks.length, 0);

  const outcome = await sendCalendarBatches(creds, built.properties);

  const failure = outcome.failure;
  const warnings = outcome.warnings;
  const clean = !failure && warnings.length === 0 && outcome.deferredBatches === 0;
  const projectionBlocked = projection.blocked.length;
  const errorMessage = failure ? failure.message
    : warnings.length ? summarizeHospitableWarnings(warnings) : null;

  // record range + safe warnings on the job row (mirror of ari-sync.ts §3.5)
  if (jobId) {
    await db`
      UPDATE guesthub.channel_sync_jobs SET
        date_from = ${today}, date_to = ${dateToInclusive},
        payload = COALESCE(payload, '{}'::jsonb) || ${db.json({
          warnings,
          blocked: projectionBlocked,
          deferred_batches: outcome.deferredBatches,
          sent_dates: outcome.sentDates,
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
      code: "partial_warnings", message: summarizeHospitableWarnings(warnings),
      context: { warnings },
    });
  }

  // §11 — incremental delivery is enabled only from a clean baseline; anything
  // else leaves full_sync_required=true so the operator re-runs after fixing.
  if (clean) {
    await db`
      UPDATE guesthub.channel_connections SET
        state = 'active', outbound_sync_enabled = true, full_sync_required = false,
        last_outbound_sync_at = now(), last_error = NULL
      WHERE id = ${conn.id}`;
  } else {
    await db`
      UPDATE guesthub.channel_connections SET
        full_sync_required = true,
        last_error = ${errorMessage}
      WHERE id = ${conn.id}`;
  }

  // §13 — durable certification evidence, same ledger and shape as Channex.
  // Hospitable has no task ids; request counts + bytes carry the proof.
  const fullSyncOutcome: EvidenceOutcome = clean ? "success" : failure ? "failed" : "partial";
  await recordAriEvidence(db, {
    tenantId: conn.tenant_id,
    connectionId: conn.id,
    environment: conn.environment,
    scenarioKey: "full_sync",
    kind: "calendar",
    uiWorkflow: "Channels → Full Sync (Hospitable)",
    firingFile: "src/lib/channel/hospitable-ari-sync.ts",
    firingFunction: "runHospitableFullSync",
    requestCount: outcome.requests,
    expectedRequests,
    requestBytes,
    dateFrom: today,
    dateTo: dateToInclusive,
    warnings,
    outcome: fullSyncOutcome,
    errorCode: failure ? failure.code : warnings.length ? "partial_warnings" : null,
    errorMessage,
    jobId,
    context: {
      properties: built.properties.length,
      sentDates: outcome.sentDates,
      deferredBatches: outcome.deferredBatches,
      blocked: projectionBlocked,
      unmappedRooms: built.unmapped.length,
      restrictedRooms: mappings.filter((m) => m.calendar_restricted).length,
    },
  });

  return {
    ok: clean,
    dateFrom: today,
    dateTo: dateToInclusive,
    properties: built.properties.length,
    outcome,
    blocked: projectionBlocked,
    error: errorMessage,
  };
}

// ============================================================
// Incremental drain
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

export async function drainHospitableAriDirtyRanges(
  db: Sql,
  conn: HospitableAriConnection,
  deps?: HospitableAriSyncDeps,
): Promise<DrainSummary> {
  const summary: DrainSummary = { claimed: 0, synced: 0, retried: 0, failed: 0, requests: 0, sentValues: 0 };
  const now = deps?.now ?? (() => Date.now());

  // §16 — if the circuit is open (cooling after a 429 or repeated failures),
  // skip this connection entirely; the dirty ranges stay pending.
  const circuit = circuitStateOf(conn);
  if (!circuitAllowsRequest(circuit, now())) {
    summary.circuitOpen = true;
    return summary;
  }

  // The worker holds this connection's job lease (FIFO per connection), so a
  // plain SELECT is enough — same claiming pattern as ari-sync.ts.
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
    const outcome = await failRanges(db, conn, rows, { code: "configuration", message: creds.error });
    summary.retried = outcome.retried;
    summary.failed = outcome.failed;
    return summary;
  }

  // ---- merge: Hospitable's ONE endpoint carries price + availability +
  // restrictions together, so every dirty kind collapses into one full-entry
  // push. The union window is projected for BOTH halves, and a date is sent
  // when ANY claimed range covers it — kind- and plan-insensitive, because an
  // emitted entry is always a complete statement about its date. ----
  const from = rows.reduce((a, r) => (r.date_from < a ? r.date_from : a), rows[0].date_from);
  const to = rows.reduce((a, r) => (r.date_to > a ? r.date_to : a), rows[0].date_to);
  const roomIds = [...new Set(rows.map((r) => r.room_id))];

  const mappings = await loadHospitableMappings(db, conn.id);
  const builderMappings = toBuilderMappings(mappings).filter((m) => roomIds.includes(m.roomId));

  let outcome: HospitableSendOutcome = { requests: 0, sentDates: 0, warnings: [], failure: null, deferredBatches: 0 };
  if (builderMappings.length > 0) {
    const projection = await projectHospitableAri(db, {
      tenantId: conn.tenant_id, connectionId: conn.id,
      dateFrom: from, dateTo: to,
      roomIds: builderMappings.map((m) => m.roomId),
    });
    // only the cells a claimed range actually covers leave the process
    const scoped: AriProjection = {
      availability: projection.availability.filter((a) => coveredBy(rows, a.roomId, a.date)),
      commercial: projection.commercial.filter((c) => coveredBy(rows, c.roomId, c.date)),
      blocked: projection.blocked,
    };
    const built = buildHospitableCalendarBatches(scoped, builderMappings);
    if (built.properties.length > 0) {
      outcome = await sendCalendarBatches(creds, built.properties);
      summary.requests = outcome.requests;
      summary.sentValues = outcome.sentDates;
    }
  }
  // NOTE: rows for rooms with no pushable mapping produce nothing to send and
  // are marked synced below — same policy as ari-sync.ts (projectAri simply
  // returns nothing for unmapped rooms and the claimed rows complete).

  const failure = outcome.failure;
  const warnings = outcome.warnings;
  const deferred = outcome.deferredBatches;

  // §13 — record incremental-sync evidence (no task ids exist at Hospitable).
  const recordIncrementalEvidence = (result: EvidenceOutcome, code: string | null, msg: string | null) =>
    recordAriEvidence(db, {
      tenantId: conn.tenant_id,
      connectionId: conn.id,
      environment: conn.environment,
      scenarioKey: "incremental_sync",
      kind: "calendar",
      uiWorkflow: "canonical save → dirty-range drain",
      firingFile: "src/lib/channel/hospitable-ari-sync.ts",
      firingFunction: "drainHospitableAriDirtyRanges",
      requestCount: summary.requests,
      warnings,
      outcome: result,
      errorCode: code,
      errorMessage: msg,
      context: { claimed: summary.claimed, sentValues: summary.sentValues, deferredBatches: deferred },
    });

  if (failure || warnings.length > 0 || deferred > 0) {
    const err = failure ?? { code: "partial_warnings", message: summarizeHospitableWarnings(warnings) };
    if (warnings.length > 0) {
      await logChannelError(db, {
        tenantId: conn.tenant_id, connectionId: conn.id,
        code: "partial_warnings", message: summarizeHospitableWarnings(warnings), context: { warnings },
      });
    }
    const failed = await failRanges(db, conn, rows, err);
    summary.retried = failed.retried;
    summary.failed = failed.failed;
    // §16 — advance the breaker exactly as ari-sync.ts does: a 429 opens it
    // for the provider's Retry-After; repeated failures open it at threshold.
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

/** A projected cell belongs to this drain only if a claimed range covers its
 *  room and date. Deliberately kind- and plan-insensitive (see merge note). */
function coveredBy(rows: DirtyRow[], roomId: string, date: string): boolean {
  for (const r of rows) {
    if (r.room_id !== roomId) continue;
    if (date >= r.date_from && date < r.date_to) return true;
  }
  return false;
}

/** §10 — preserve failed ranges for retry with bounded exponential backoff
 *  (identical policy to ari-sync.ts::failRanges, which is module-private). */
async function failRanges(
  db: Sql,
  conn: HospitableAriConnection,
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

/** Hospitable connections whose baseline is established — the ONLY ones a
 *  drain may touch. Sibling of ari-sync.ts::loadDrainableConnections (which
 *  requires channex_property_id and therefore never returns these rows). */
export async function loadDrainableHospitableConnections(db: Sql = sql): Promise<HospitableAriConnection[]> {
  return db<HospitableAriConnection[]>`
    SELECT c.id, c.tenant_id, c.api_key_ciphertext, c.environment,
           c.circuit_open_until::text AS circuit_open_until, c.consecutive_failures
    FROM guesthub.channel_connections c
    WHERE c.provider = 'hospitable' AND c.is_active_provider = true
      AND c.state = 'active' AND c.outbound_sync_enabled = true AND c.full_sync_required = false
      AND c.api_key_ciphertext IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM guesthub.channel_hospitable_property_mappings m
        WHERE m.connection_id = c.id AND m.status = 'mapped')`;
}
