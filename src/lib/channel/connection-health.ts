// ============================================================
// Channel connection health — the SIX honest signals (D133).
//
// PURE: no imports, no DB, no HTTP, no clock (the caller passes `nowMs`), so
// the guard compiles this file and asserts the verdict directly. The rule and
// the query that feeds it are separable on purpose — check:connection-health
// can neutralise the rule and watch the guard die (B2).
//
// WHAT THIS REPLACES, AND WHY IT WAS WRONG.
// The Phase 2 dashboard alert keyed on
//     access_token_expires_at <= now() + interval '24 hours'
// A Beds24 access token LIVES 24 hours and is re-minted under 5 minutes from
// expiry (beds24-token.ts: TOKEN_REUSE_MARGIN_MS). Its expiry is therefore
// ALWAYS inside the next 24 hours. The predicate was true 100% of the time —
// not an alert, a constant, and it inflated every alert count on every load.
// check-beds24-connection.mjs already knew this and prints the token expiry as
// "informational only — an expired cache is not a failure".
//
// TOKEN TTL IS NOT A HEALTH SIGNAL AT ANY THRESHOLD, and no condition below
// reads access_token_expires_at. What breaks a connection is the REFRESH token
// going missing, the provider erroring, the breaker tripping, or nothing
// pulling — which is exactly the list below.
//
// NOT READ, DELIBERATELY: api_key_expires_at. It is HOSPITABLE-ONLY (their PAT
// is a JWT that expires — migration 044); on a Beds24 row it is NULL forever.
// Wiring it here would rebuild the same class of lie with a different column.
//
// ZERO IS THE NORMAL STATE. A connection with none of the six reports an empty
// array, and that is what the live production connection reports today.
// ============================================================

/** Which condition fired. Stable — the alert row id and the guard both key on it. */
export type ConnectionHealthCode =
  | "state_error"
  | "circuit_open"
  | "outbound_failures"
  | "refresh_token_missing"
  | "pull_stale"
  | "worker_down";

export type ConnectionHealthFinding = {
  code: ConnectionHealthCode;
  severity: "red" | "amber";
  /** the operator-facing Hebrew line; each condition says its OWN thing */
  detail: string;
};

/** Everything the verdict needs, already loaded. This module issues no query. */
export type ConnectionHealthInput = {
  /** channel_connections.state */
  state: string;
  /** api_key_ciphertext IS NOT NULL — for Beds24 that column holds the long-life
   *  REFRESH token (migration 045 §2), not an API key. */
  hasRefreshToken: boolean;
  /** channel_connections.consecutive_failures */
  consecutiveFailures: number;
  /** channel_connections.circuit_open_until, epoch ms, or null when closed */
  circuitOpenUntilMs: number | null;
  /** channel_connections.inbound_sync_enabled — gates the pull condition only */
  inboundSyncEnabled: boolean;
  /** max(finished_at) over SUCCEEDED pull_booking_revisions jobs, epoch ms.
   *  null = this connection has never completed a pull. */
  lastSuccessfulPullMs: number | null;
  /** channel_worker_state.beat_at, epoch ms. null = the worker never started. */
  workerBeatMs: number | null;
};

// ---- thresholds, both DERIVED from a cadence in the code -------------------

/**
 * A pull is stale after 3 missed cycles.
 *
 * worker.ts:253-258 — "Low-frequency durable fallback poll (D76 §3) … Runs
 * inside the EXISTING worker loop — no second process, no cron."
 * `export const INBOUND_POLL_MINUTES = 5;`
 *
 * 3 × 5 = 15. One missed cycle is ordinary jitter (a long pull, a retry_wait);
 * three consecutive misses are a pattern.
 */
export const PULL_STALE_MINUTES = 15;

/**
 * The worker heartbeat is stale after 90 seconds — the EXISTING figure, not a
 * new one: rates-sync.ts:23 `const WORKER_STALE_SECONDS = 90`, i.e. 4.5 × the
 * worker's own 20-second tick (worker.ts:43 DEFAULT_INTERVAL_MS). The /rates
 * panel has called the worker offline at this threshold since Stage 4; a second
 * definition of "the worker is down" on the dashboard would be a bug waiting to
 * disagree with it.
 */
export const WORKER_STALE_SECONDS = 90;

/**
 * States that mean the connection FAILED.
 *
 * 'paused' is deliberately absent (D133): pausing is an operator decision, and
 * alerting on a state the operator chose is nagging, not signalling.
 *
 * Note that recordProbeVerdict (beds24-admin.ts:445) writes
 * `state = CASE WHEN state = 'active' THEN 'active' ELSE 'error' END`, so a
 * connection that is already live never falls to 'error' from a failed probe.
 * This condition is therefore a correct BACKSTOP that rarely fires in
 * production — the failure of a live connection surfaces through the breaker
 * and the pull conditions below.
 */
export const FAILED_STATES: readonly string[] = ["error"];

const MINUTE_MS = 60_000;

const heMinutes = (ms: number): string => {
  const m = Math.floor(ms / MINUTE_MS);
  if (m < 60) return `${m} דקות`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} שעות` : `${Math.floor(h / 24)} ימים`;
};

/**
 * The six conditions, each independently reportable.
 *
 * TWO SUPPRESSIONS, both of the same shape — a root cause must never be
 * reported twice under two names:
 *
 *  · worker_down suppresses pull_stale. A dead worker is WHY nothing pulled;
 *    two rows would send the operator to fix a symptom.
 *  · circuit_open suppresses outbound_failures. The breaker only ever opens by
 *    counting those same failures (circuit-breaker.ts onCircuitFailure always
 *    increments consecutiveFailures), so the pair is structurally guaranteed —
 *    the severe row wins and the count it caused stays in its detail line.
 */
export function connectionHealth(
  input: ConnectionHealthInput,
  nowMs: number,
): ConnectionHealthFinding[] {
  const out: ConnectionHealthFinding[] = [];

  if (FAILED_STATES.includes(input.state)) {
    out.push({
      code: "state_error",
      severity: "red",
      detail: "החיבור במצב שגיאה — הסנכרון מושבת",
    });
  }

  if (!input.hasRefreshToken) {
    out.push({
      code: "refresh_token_missing",
      severity: "red",
      detail: "אין הרשאת גישה שמורה — יש להזין קוד הזמנה (invite code) מחדש",
    });
  }

  const circuitOpen =
    input.circuitOpenUntilMs !== null && input.circuitOpenUntilMs > nowMs;
  if (circuitOpen) {
    const left = heMinutes((input.circuitOpenUntilMs as number) - nowMs);
    out.push({
      code: "circuit_open",
      severity: "red",
      detail: `הסנכרון היוצא מושהה אוטומטית לאחר ${input.consecutiveFailures} כשלונות — יחודש בעוד ${left}`,
    });
  } else if (input.consecutiveFailures > 0) {
    // ONLY persistCircuit (beds24-ari-sync.ts:178-183) writes this counter, and
    // it runs on the outbound ARI drain. An inbound pull failure never touches
    // it — so the label says "היוצא" and nothing wider.
    out.push({
      code: "outbound_failures",
      severity: "amber",
      detail: `הסנכרון היוצא נכשל ${input.consecutiveFailures} פעמים ברציפות`,
    });
  }

  const workerDown =
    input.workerBeatMs === null || nowMs - input.workerBeatMs > WORKER_STALE_SECONDS * 1000;
  if (workerDown) {
    out.push({
      code: "worker_down",
      severity: "red",
      detail:
        input.workerBeatMs === null
          ? "תהליך הסנכרון אינו פעיל — לא נרשמה אף פעימה"
          : `תהליך הסנכרון אינו פעיל — הפעימה האחרונה לפני ${heMinutes(nowMs - input.workerBeatMs)}`,
    });
  } else if (input.inboundSyncEnabled) {
    // Gated on inbound_sync_enabled: a connection that deliberately does not
    // pull must not be told forever that it has not pulled.
    const stale =
      input.lastSuccessfulPullMs === null ||
      nowMs - input.lastSuccessfulPullMs > PULL_STALE_MINUTES * MINUTE_MS;
    if (stale) {
      out.push({
        code: "pull_stale",
        severity: "amber",
        detail:
          input.lastSuccessfulPullMs === null
            ? "לא הושלמה אף משיכת הזמנות מהערוץ"
            : `לא נמשכו הזמנות מהערוץ מזה ${heMinutes(nowMs - input.lastSuccessfulPullMs)}`,
      });
    }
  }

  return out;
}
