import "server-only";
import type { Sql } from "postgres";
import { sql } from "@/lib/db";
import { addDays, todayInTz, type DateOnly } from "@/lib/dates";
import { CHANNEX_BASE_URLS } from "./config";
import { decryptSecret, channelSecretsConfigured } from "./crypto";
import { projectAri, type AriProjection } from "./ari-projection";
import {
  buildAvailabilityValues, buildRestrictionValues,
  type AvailabilityInput, type RestrictionInput,
} from "./ari-payloads";
import { pushAri, summarizeWarnings, type AriPushResult, type SafeAriWarning } from "./channex-ari";
import { logChannelError } from "./queue";
import { ARI_HORIZON_DAYS, backoffMs } from "./ranges";

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
};

export type SendOutcome = {
  requests: number;
  taskIds: string[];
  warnings: SafeAriWarning[];
  /** a transport/auth/validation failure — the range stays retryable */
  failure: { code: string; message: string } | null;
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

export type DrainSummary = {
  claimed: number;
  synced: number;
  retried: number;
  failed: number;
  requests: number;
  sentValues: number;
};

// The one seam a check may substitute: the same `fetchImpl` channex-http already
// accepts. Absent everywhere in production — the worker never passes it — so a
// test can assert "exactly these two requests, with exactly these values" without
// any network, and no test-only branch exists in the send path itself.
export type AriSyncDeps = { fetchImpl?: typeof fetch };

// ---- credentials (never returned, never logged) ----
type Creds = { apiKey: string; baseUrl: string; propertyId: string; fetchImpl?: typeof fetch };

function credentialsFor(conn: AriConnection, deps?: AriSyncDeps): Creds | { error: string } {
  if (!channelSecretsConfigured()) return { error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת" };
  if (!conn.channex_property_id) return { error: "לא קיים נכס Channex ממופה" };
  if (!conn.api_key_ciphertext) return { error: "מפתח API לא הוגדר" };
  try {
    return {
      apiKey: decryptSecret(conn.api_key_ciphertext),
      baseUrl: CHANNEX_BASE_URLS.staging,
      propertyId: conn.channex_property_id,
      fetchImpl: deps?.fetchImpl,
    };
  } catch {
    return { error: "פענוח המפתח נכשל — ייתכן שמפתח ההצפנה בשרת השתנה" };
  }
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
      outcome.failure = { code: res.category, message: res.message };
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
  const [tenant] = await db<{ timezone: string | null }[]>`
    SELECT timezone FROM guesthub.tenants WHERE id = ${conn.tenant_id}`;
  const today = todayInTz(tenant?.timezone || "Asia/Jerusalem");
  const dateToExclusive = addDays(today, FULL_SYNC_DAYS);
  const dateToInclusive = addDays(today, FULL_SYNC_DAYS - 1);

  const empty: SendOutcome = { requests: 0, taskIds: [], warnings: [], failure: null, deferredBatches: 0 };
  const bail = (error: string): FullSyncResult => ({
    ok: false, dateFrom: today, dateTo: dateToInclusive,
    availability: empty, restrictions: empty, blocked: 0, error,
  });

  const ready = await validateFullSyncReadiness(db, conn);
  if (!ready.ok) return bail(ready.error);

  const creds = credentialsFor(conn, deps);
  if ("error" in creds) return bail(creds.error);

  const projection = await projectAri(db, {
    tenantId: conn.tenant_id,
    connectionId: conn.id,
    dateFrom: today,
    dateTo: dateToExclusive,
  });
  if (projection.availability.length === 0) return bail("לא נמצאו חדרים ממופים לסנכרון");
  const sellable = projection.commercial.filter((c) => c.rates !== null).length;
  if (sellable === 0) return bail("לא ניתן לחשב מחיר לאף שילוב חדר×תוכנית — בדוק תמחור לפני סנכרון");

  const { roomTypeByRoomId, ratePlanByCombo } = await loadMappings(db, conn.id);
  const inputs = toInputs(projection);
  const avail = buildAvailabilityValues(inputs.availability, creds.propertyId, roomTypeByRoomId);
  const restr = buildRestrictionValues(inputs.restrictions, creds.propertyId, ratePlanByCombo);

  // §3.3 — availability first, then rates/restrictions. Separate requests.
  const availabilityOutcome = await sendBatches(creds, "availability", avail.batches);
  const restrictionsOutcome = availabilityOutcome.failure
    ? empty
    : await sendBatches(creds, "restrictions", restr.batches);

  const failure = availabilityOutcome.failure ?? restrictionsOutcome.failure;
  const warnings = [...availabilityOutcome.warnings, ...restrictionsOutcome.warnings];
  const deferred = availabilityOutcome.deferredBatches + restrictionsOutcome.deferredBatches;
  const clean = !failure && warnings.length === 0 && deferred === 0;

  // §3.5 — record range, timestamp, safe task references and safe warnings.
  if (jobId) {
    await db`
      UPDATE guesthub.channel_sync_jobs SET
        date_from = ${today}, date_to = ${dateToInclusive},
        provider_task_id = ${availabilityOutcome.taskIds[0] ?? restrictionsOutcome.taskIds[0] ?? null},
        payload = ${db.json({
          task_ids: [...availabilityOutcome.taskIds, ...restrictionsOutcome.taskIds],
          warnings,
          blocked: projection.blocked.length,
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

  // §11 — a 200 carrying warnings is NOT a fully successful synchronisation.
  // Incremental delivery is enabled only from a clean baseline; anything else
  // leaves full_sync_required=true so the operator re-runs after fixing.
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
        last_error = ${failure ? failure.message : summarizeWarnings(warnings)}
      WHERE id = ${conn.id}`;
  }

  return {
    ok: clean,
    dateFrom: today,
    dateTo: dateToInclusive,
    availability: availabilityOutcome,
    restrictions: restrictionsOutcome,
    blocked: projection.blocked.length,
    error: failure ? failure.message : warnings.length ? summarizeWarnings(warnings) : null,
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
    return summary;
  }

  await db`
    UPDATE guesthub.channel_dirty_ranges SET status = 'synced', updated_at = now()
    WHERE id = ANY(${rows.map((r) => r.id)}::uuid[])`;
  await db`
    UPDATE guesthub.channel_connections SET last_outbound_sync_at = now(), last_error = NULL
    WHERE id = ${conn.id}`;
  summary.synced = rows.length;
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
    SELECT id, tenant_id, channex_property_id, api_key_ciphertext
    FROM guesthub.channel_connections
    WHERE state = 'active' AND outbound_sync_enabled = true AND full_sync_required = false
      AND channex_property_id IS NOT NULL AND api_key_ciphertext IS NOT NULL`;
}
