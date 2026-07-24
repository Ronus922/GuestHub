import "server-only";
import type { Sql } from "postgres";
import { sql } from "@/lib/db";
import { addDays, todayInTz, type DateOnly } from "@/lib/dates";
import { beds24BaseUrl } from "./config";
import { channelSecretsConfigured } from "./crypto";
import { getBeds24AccessToken } from "./beds24-token";
import { projectBeds24Ari } from "./beds24-ari-projection";
import type { AriProjection } from "./ari-projection";
import {
  buildBeds24CalendarRequests, beds24PayloadByteSize,
  type Beds24CalendarMapping, type Beds24CalendarRequest,
} from "./beds24-ari-payloads";
import {
  pushBeds24Calendar, summarizeBeds24Warnings,
  type Beds24CalendarPushResult, type SafeBeds24Warning,
} from "./beds24-ari";
import { recordAriEvidence, type EvidenceOutcome } from "./evidence";
import {
  circuitAllowsRequest, onCircuitFailure, onCircuitSuccess, failureKindOf,
  type CircuitState,
} from "./circuit-breaker";
import { logChannelError } from "./queue";
import { ARI_HORIZON_DAYS, backoffMs } from "./ranges";
import type { DrainSummary } from "./ari-sync";

// ============================================================
// Beds24 ARI synchronisation (D78/D79) — sibling of ari-sync.ts and
// hospitable-ari-sync.ts. Two entry points, ONE projection (projectBeds24Ari):
//
//   runBeds24FullSync          — the operator-triggered baseline. The same 500
//                                property-local dates as Channex/Hospitable,
//                                pushed as compressed calendar ranges (price +
//                                availability + restrictions in ONE endpoint).
//                                Enables incremental sync only on a clean
//                                result.
//   drainBeds24AriDirtyRanges  — the incremental pass. Consumes the SAME
//                                guesthub.channel_dirty_ranges rows the
//                                transactional outbox (outbox.ts) writes for
//                                EVERY active connection — the outbox fan-out
//                                is provider-neutral, so a beds24 connection
//                                accumulates ranges with no outbox change.
//
// Both are invoked by the PM2 channel worker through the durable job queue.
// Neither is ever called from a save transaction, a page render or a test.
//
// CREDENTIALS: unlike the PAT providers, the sendable credential is a 24h
// ACCESS token minted from the stored refresh token — resolved through
// beds24-token.ts (cached, single-flight, re-persisted) so parallel jobs never
// each burn a token-mint credit.
//
// PACING: Beds24 is CREDIT-metered per request (X-FiveMinCreditLimit), not
// simple requests/min — so this sibling paces harder than Hospitable (500ms
// between calls) and caps a run at 120 requests. Range compression in the
// payload builder is the real credit saver; the remaining-credits header is
// surfaced into the evidence context on every run.
// ============================================================

/** Same horizon as the Channex full sync (ari-sync.ts::FULL_SYNC_DAYS). */
export const BEDS24_FULL_SYNC_DAYS = ARI_HORIZON_DAYS;

const PACE_MS = 500;
/** Hard ceiling per run so one connection can never monopolise the worker and
 *  never exhausts the 5-minute credit window (~1 min of paced requests, well
 *  inside the 10-min job lease). */
const MAX_REQUESTS_PER_RUN = 120;
/** How many dirty ranges one drain claims (same as ari-sync.ts). */
const MAX_RANGES_PER_RUN = 500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type Beds24AriConnection = {
  id: string;
  tenant_id: string;
  /** the encrypted REFRESH token (long-life credential) */
  api_key_ciphertext: string;
  /** 24h access-token cache — read by beds24-token.ts, may be stale/NULL */
  access_token_ciphertext: string | null;
  access_token_expires_at: Date | string | null;
  /** always 'production' for beds24 rows (no sandbox; admin-enforced) */
  environment: "staging" | "production";
  // §16 circuit-breaker state, persisted between drains.
  circuit_open_until: string | null;
  consecutive_failures: number;
};

export type Beds24SendOutcome = {
  requests: number;
  /** compressed calendar RANGES delivered (the payload's unit of work) */
  sentRanges: number;
  warnings: SafeBeds24Warning[];
  /** a transport/auth/validation failure — the range stays retryable */
  failure: { code: string; message: string; retryAfterMs?: number } | null;
  /** request bodies left unsent because the per-run ceiling was reached */
  deferredBatches: number;
  /** last-seen X-FiveMinCreditLimit-Remaining — observability, never control */
  creditsRemaining: number | null;
};

export type Beds24FullSyncResult = {
  ok: boolean;
  dateFrom: DateOnly;
  dateTo: DateOnly; // inclusive, = dateFrom + BEDS24_FULL_SYNC_DAYS - 1
  rooms: number;
  outcome: Beds24SendOutcome;
  blocked: number;
  error: string | null;
};

export type Beds24AriSyncDeps = {
  fetchImpl?: typeof fetch;
  /** injectable clock for timestamps ONLY */
  now?: () => number;
};

// §16 — read/write the persisted breaker state on the connection row
// (identical to ari-sync.ts).
function circuitStateOf(conn: Beds24AriConnection): CircuitState {
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
// The plaintext is a freshly-resolved 24h ACCESS token (beds24-token.ts:
// cached, single-flight, re-persisted) — never the refresh token.
type Creds = { token: string; baseUrl: string; fetchImpl?: typeof fetch };

async function credentialsFor(
  db: Sql,
  conn: Beds24AriConnection,
  deps?: Beds24AriSyncDeps,
): Promise<Creds | { error: string; code: string }> {
  if (!channelSecretsConfigured())
    return { error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת", code: "configuration" };
  const access = await getBeds24AccessToken(db, conn, {
    ...(deps?.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps?.now ? { now: deps.now } : {}),
  });
  if (!access.ok) {
    const code =
      access.category === "not_configured" || access.category === "undecryptable"
        ? "configuration"
        : access.category;
    return { error: access.error, code };
  }
  return {
    token: access.token,
    // §11 canonical routing: ONE production base URL — Beds24 has no
    // staging — resolved through config.ts, never a literal here.
    baseUrl: beds24BaseUrl(),
    ...(deps?.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  };
}

// ---- mapping lookups ----
type Beds24MappingRow = {
  room_id: string;
  beds24_property_id: string;
  beds24_room_id: string;
  local_rate_plan_id: string | null;
};

async function loadBeds24Mappings(db: Sql, connectionId: string): Promise<Beds24MappingRow[]> {
  return db<Beds24MappingRow[]>`
    SELECT room_id, beds24_property_id, beds24_room_id, local_rate_plan_id
    FROM guesthub.channel_beds24_room_mappings
    WHERE connection_id = ${connectionId} AND status = 'mapped'`;
}

const pushable = (m: Beds24MappingRow) => m.local_rate_plan_id !== null;

const toBuilderMappings = (rows: Beds24MappingRow[]): Beds24CalendarMapping[] =>
  rows.filter(pushable).map((m) => ({
    roomId: m.room_id,
    beds24PropertyId: m.beds24_property_id,
    beds24RoomId: m.beds24_room_id,
    localRatePlanId: m.local_rate_plan_id,
  }));

// ---- send every request body, paced, bounded (mirror of
// ari-sync.ts::sendBatches: stop this run on the first failure — the caller
// keeps the ranges retryable) ----
async function sendCalendarRequests(
  creds: Creds,
  requests: Beds24CalendarRequest[],
): Promise<Beds24SendOutcome> {
  const outcome: Beds24SendOutcome = {
    requests: 0, sentRanges: 0, warnings: [], failure: null,
    deferredBatches: 0, creditsRemaining: null,
  };
  const sendable = requests.slice(0, MAX_REQUESTS_PER_RUN);
  outcome.deferredBatches = requests.length - sendable.length;

  for (let i = 0; i < sendable.length; i++) {
    // credit-conscious inter-call spacing (a substituted fetch needs no pacing)
    if (i > 0 && !creds.fetchImpl) await sleep(PACE_MS);
    const res: Beds24CalendarPushResult = await pushBeds24Calendar(
      { ...(creds.fetchImpl ? { fetchImpl: creds.fetchImpl } : {}) },
      { token: creds.token, baseUrl: creds.baseUrl, entries: sendable[i] },
    );
    outcome.requests += 1;
    if (res.creditsRemaining !== undefined && res.creditsRemaining !== null) {
      outcome.creditsRemaining = res.creditsRemaining;
    }
    if (!res.ok) {
      outcome.failure = {
        code: res.category, message: res.message,
        ...(res.retryAfterMs !== undefined ? { retryAfterMs: res.retryAfterMs } : {}),
      };
      return outcome; // stop — the caller keeps the ranges retryable
    }
    outcome.sentRanges += sendable[i].reduce((n, e) => n + e.calendar.length, 0);
    if (res.partial) outcome.warnings.push(...res.warnings);
  }
  return outcome;
}

// ============================================================
// Initial Full Sync
// ============================================================

export async function runBeds24FullSync(
  db: Sql,
  conn: Beds24AriConnection,
  jobId: string | null,
  deps?: Beds24AriSyncDeps,
): Promise<Beds24FullSyncResult> {
  const [tenant] = await db<{ timezone: string | null }[]>`
    SELECT timezone FROM guesthub.tenants WHERE id = ${conn.tenant_id}`;
  const today = todayInTz(tenant?.timezone || "Asia/Jerusalem");
  const dateToExclusive = addDays(today, BEDS24_FULL_SYNC_DAYS);
  const dateToInclusive = addDays(today, BEDS24_FULL_SYNC_DAYS - 1);

  const emptyOutcome: Beds24SendOutcome = {
    requests: 0, sentRanges: 0, warnings: [], failure: null,
    deferredBatches: 0, creditsRemaining: null,
  };

  // A failed run leaves full_sync_required=true so the operator re-runs after
  // fixing — identical policy to ari-sync.ts.
  const fail = async (error: string, category: string, extra?: {
    outcome?: Beds24SendOutcome; rooms?: number; blocked?: number; requestBytes?: number;
  }): Promise<Beds24FullSyncResult> => {
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
      uiWorkflow: "Channels → Full Sync (Beds24)",
      firingFile: "src/lib/channel/beds24-ari-sync.ts",
      firingFunction: "runBeds24FullSync",
      requestCount: extra?.outcome?.requests ?? 0,
      requestBytes: extra?.requestBytes ?? null,
      dateFrom: today,
      dateTo: dateToInclusive,
      warnings: extra?.outcome?.warnings ?? [],
      outcome: extra?.outcome?.requests ? "partial" : "failed",
      errorCode: category,
      errorMessage: error,
      jobId,
      context: {
        rooms: extra?.rooms ?? 0,
        blocked: extra?.blocked ?? 0,
        creditsRemaining: extra?.outcome?.creditsRemaining ?? null,
      },
    });
    return {
      ok: false, dateFrom: today, dateTo: dateToInclusive,
      rooms: extra?.rooms ?? 0,
      outcome: extra?.outcome ?? emptyOutcome,
      blocked: extra?.blocked ?? 0,
      error,
    };
  };

  const mappings = await loadBeds24Mappings(db, conn.id);
  const builderMappings = toBuilderMappings(mappings);
  if (builderMappings.length === 0) {
    return fail("אין חדרי Beds24 ממופים עם תוכנית תעריף מיועדת", "validation");
  }

  const creds = await credentialsFor(db, conn, deps);
  if ("error" in creds) return fail(creds.error, creds.code);

  // ---- ONE projection over the whole horizon, restricted to mapped rooms ----
  const projection = await projectBeds24Ari(db, {
    tenantId: conn.tenant_id, connectionId: conn.id,
    dateFrom: today, dateTo: dateToExclusive,
    roomIds: builderMappings.map((m) => m.roomId),
  });
  const sellable = projection.commercial.filter((c) => c.rates !== null).length;
  if (sellable === 0) {
    return fail("לא ניתן לחשב מחיר לאף חדר ממופה — בדוק תמחור לפני סנכרון", "validation", {
      blocked: projection.blocked.length,
    });
  }

  const built = buildBeds24CalendarRequests(projection, builderMappings);
  const requestBytes = built.requests.reduce((n, r) => n + beds24PayloadByteSize(r), 0);
  const expectedRequests = built.requests.length;

  const outcome = await sendCalendarRequests(creds, built.requests);

  const failure = outcome.failure;
  const warnings = outcome.warnings;
  const clean = !failure && warnings.length === 0 && outcome.deferredBatches === 0
    && built.invalidRoomIds.length === 0;
  const projectionBlocked = projection.blocked.length;
  const errorMessage = failure ? failure.message
    : warnings.length ? summarizeBeds24Warnings(warnings)
    : built.invalidRoomIds.length ? "מזהה חדר Beds24 שאינו מספרי — מפה מחדש את החדר" : null;

  // record range + safe warnings on the job row (mirror of ari-sync.ts §3.5)
  if (jobId) {
    await db`
      UPDATE guesthub.channel_sync_jobs SET
        date_from = ${today}, date_to = ${dateToInclusive},
        payload = COALESCE(payload, '{}'::jsonb) || ${db.json({
          warnings,
          blocked: projectionBlocked,
          deferred_batches: outcome.deferredBatches,
          sent_ranges: outcome.sentRanges,
          credits_remaining: outcome.creditsRemaining,
          invalid_room_ids: built.invalidRoomIds,
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
      code: "partial_warnings", message: summarizeBeds24Warnings(warnings),
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
  // Beds24 has no task ids; request counts + bytes + credits carry the proof.
  const fullSyncOutcome: EvidenceOutcome = clean ? "success" : failure ? "failed" : "partial";
  await recordAriEvidence(db, {
    tenantId: conn.tenant_id,
    connectionId: conn.id,
    environment: conn.environment,
    scenarioKey: "full_sync",
    kind: "calendar",
    uiWorkflow: "Channels → Full Sync (Beds24)",
    firingFile: "src/lib/channel/beds24-ari-sync.ts",
    firingFunction: "runBeds24FullSync",
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
      rooms: builderMappings.length,
      sentRanges: outcome.sentRanges,
      deferredBatches: outcome.deferredBatches,
      blocked: projectionBlocked,
      unmappedRooms: built.unmapped.length,
      invalidRoomIds: built.invalidRoomIds.length,
      creditsRemaining: outcome.creditsRemaining,
    },
  });

  return {
    ok: clean,
    dateFrom: today,
    dateTo: dateToInclusive,
    rooms: builderMappings.length,
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

export async function drainBeds24AriDirtyRanges(
  db: Sql,
  conn: Beds24AriConnection,
  deps?: Beds24AriSyncDeps,
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

  const creds = await credentialsFor(db, conn, deps);
  if ("error" in creds) {
    const outcome = await failRanges(db, conn, rows, { code: creds.code, message: creds.error });
    summary.retried = outcome.retried;
    summary.failed = outcome.failed;
    return summary;
  }

  // ---- merge: Beds24's ONE endpoint carries price + availability +
  // restrictions together, so every dirty kind collapses into one full-range
  // push. The union window is projected for BOTH halves, and a date is sent
  // when ANY claimed range covers it — kind- and plan-insensitive, because an
  // emitted range is always a complete statement about its dates. ----
  const from = rows.reduce((a, r) => (r.date_from < a ? r.date_from : a), rows[0].date_from);
  const to = rows.reduce((a, r) => (r.date_to > a ? r.date_to : a), rows[0].date_to);
  const roomIds = [...new Set(rows.map((r) => r.room_id))];

  const mappings = await loadBeds24Mappings(db, conn.id);
  const builderMappings = toBuilderMappings(mappings).filter((m) => roomIds.includes(m.roomId));

  let outcome: Beds24SendOutcome = {
    requests: 0, sentRanges: 0, warnings: [], failure: null,
    deferredBatches: 0, creditsRemaining: null,
  };
  if (builderMappings.length > 0) {
    const projection = await projectBeds24Ari(db, {
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
    const built = buildBeds24CalendarRequests(scoped, builderMappings);
    if (built.requests.length > 0) {
      outcome = await sendCalendarRequests(creds, built.requests);
      summary.requests = outcome.requests;
      summary.sentValues = outcome.sentRanges;
    }
  }
  // NOTE: rows for rooms with no pushable mapping produce nothing to send and
  // are marked synced below — same policy as ari-sync.ts (projectAri simply
  // returns nothing for unmapped rooms and the claimed rows complete).

  const failure = outcome.failure;
  const warnings = outcome.warnings;
  const deferred = outcome.deferredBatches;

  // §13 — record incremental-sync evidence (no task ids exist at Beds24; the
  // remaining-credits header rides along in the context).
  const recordIncrementalEvidence = (result: EvidenceOutcome, code: string | null, msg: string | null) =>
    recordAriEvidence(db, {
      tenantId: conn.tenant_id,
      connectionId: conn.id,
      environment: conn.environment,
      scenarioKey: "incremental_sync",
      kind: "calendar",
      uiWorkflow: "canonical save → dirty-range drain",
      firingFile: "src/lib/channel/beds24-ari-sync.ts",
      firingFunction: "drainBeds24AriDirtyRanges",
      requestCount: summary.requests,
      warnings,
      outcome: result,
      errorCode: code,
      errorMessage: msg,
      context: {
        claimed: summary.claimed,
        sentValues: summary.sentValues,
        deferredBatches: deferred,
        creditsRemaining: outcome.creditsRemaining,
      },
    });

  if (failure || warnings.length > 0 || deferred > 0) {
    const err = failure ?? { code: "partial_warnings", message: summarizeBeds24Warnings(warnings) };
    if (warnings.length > 0) {
      await logChannelError(db, {
        tenantId: conn.tenant_id, connectionId: conn.id,
        code: "partial_warnings", message: summarizeBeds24Warnings(warnings), context: { warnings },
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
  conn: Beds24AriConnection,
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

/** Beds24 connections whose baseline is established — the ONLY ones a drain
 *  may touch. Sibling of ari-sync.ts::loadDrainableConnections (which requires
 *  channex_property_id and therefore never returns these rows). The row also
 *  carries the access-token cache columns beds24-token.ts reads. */
export async function loadDrainableBeds24Connections(db: Sql = sql): Promise<Beds24AriConnection[]> {
  return db<Beds24AriConnection[]>`
    SELECT c.id, c.tenant_id, c.api_key_ciphertext,
           c.access_token_ciphertext, c.access_token_expires_at,
           c.environment,
           c.circuit_open_until::text AS circuit_open_until, c.consecutive_failures
    FROM guesthub.channel_connections c
    WHERE c.provider = 'beds24' AND c.is_active_provider = true
      AND c.state = 'active' AND c.outbound_sync_enabled = true AND c.full_sync_required = false
      AND c.api_key_ciphertext IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM guesthub.channel_beds24_room_mappings m
        WHERE m.connection_id = c.id AND m.status = 'mapped')`;
}
