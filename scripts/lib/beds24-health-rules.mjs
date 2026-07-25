// ============================================================
// THE CENTRAL PREDICATES of the four Beds24 health guards
// (check:beds24-connection / -jobs / -revisions / -ari).
//
// WHY THIS FILE EXISTS
// Before TARGET 2.7 the four guards were 229 lines of inline SQL + inline
// `assert`, importing nothing but `postgres` and `node:assert/strict`. Three
// consequences, all measured on 2026-07-25 against staging:
//   1. They executed ZERO application code, so no defect in src/ could ever
//      turn them red — their stdout was BYTE-IDENTICAL with and without a
//      semantic neutering of circuit-breaker.ts / ranges.ts / revisions.ts.
//   2. Every threshold (30 minutes, 10%, 2 hours, the D91 cutover instant)
//      was a magic number no test touched: widening 30 → 30000 broke nothing.
//   3. check:beds24-ari printed "2 PASSED" against a database containing zero
//      Beds24 rows — a green tick produced by the ABSENCE of the integration.
//
// Extracting the predicates here fixes (2) and (3): each rule is now exercised
// in BOTH directions against state read back from the database — a satisfying
// fixture (the rule must ACCEPT) and a violating fixture (the rule must
// REJECT). Neutering any rule in either direction turns its guard red.
//
// EVERY RULE IS PURE: no DB handle, no clock, no environment. `now` is always
// passed in. That is what makes the negative arm reproducible.
//
// Each rule returns { ok: boolean, detail: string }. `detail` is rendered by
// the guard in both the pass and the fail line, so a green tick always shows
// the number it was green about.
// ============================================================

/** Rule identifiers, in guard order. The guards import these names; the count
 *  is asserted so a silently dropped rule cannot shrink the guard surface. */
export const RULE_IDS = [
  "C1_single_active_beds24_connection",
  "C2_active_connection_is_production",
  "C3_both_sync_directions_enabled",
  "C4_refresh_token_present",
  "C5_circuit_breaker_closed",
  "J1_inbound_feed_alive",
  "J2_failure_share_within_budget",
  "J3_no_foreign_provider_jobs_since_cutover",
  "R1_pull_freshness",
  "R2_no_revisions_stuck_unimported",
  "R3_no_imported_but_unacknowledged",
  "A1_no_stale_dirty_ranges",
  "A2_ari_drain_keeping_up",
];

// ---- thresholds: named, exported, and covered by the negative arms ----
export const THRESHOLDS = {
  /** check:beds24-revisions R1 — inbound pull cadence is ~5m; alarm at 30m. */
  pullFreshnessMaxMinutes: 30,
  /** check:beds24-jobs J2 — tolerated non-succeeded share per job type. */
  failureShareMax: 0.1,
  /** check:beds24-revisions R2/R3 — grace before a revision counts as stuck. */
  revisionGraceHours: 1,
  /** check:beds24-ari A1 — grace before a dirty range counts as un-drained. */
  dirtyRangeGraceHours: 2,
  /** check:beds24-jobs J3 — the D91 Channex/Stripe/Hospitable removal instant. */
  d91CutoverIso: "2026-07-24T18:45:00Z",
};

const yes = (detail) => ({ ok: true, detail });
const no = (detail) => ({ ok: false, detail });

// ---------------------------------------------------------------
// check:beds24-connection
// ---------------------------------------------------------------

/** C1 — exactly one ACTIVE channel connection and it is Beds24 (D91: Beds24 is
 *  the sole provider; a second active row means a decommissioned provider is
 *  live again). */
export function ruleSingleActiveBeds24Connection(activeRows) {
  const rows = activeRows ?? [];
  if (rows.length !== 1) return no(`${rows.length} active connections (exactly 1 expected)`);
  if (rows[0].provider !== "beds24") return no(`active provider is ${rows[0].provider}, not beds24`);
  return yes("1 active connection, provider=beds24");
}

/** C2 — the active connection points at the provider's PRODUCTION environment.
 *  A live property served by a sandbox connection sells rooms that do not
 *  exist. */
export function ruleActiveConnectionIsProduction(conn) {
  if (!conn) return no("no active connection to inspect");
  return conn.environment === "production"
    ? yes("environment=production")
    : no(`environment=${conn.environment}`);
}

/** C3 — both directions armed: inbound (booking pull) AND outbound (ARI push).
 *  One direction off is silent: bookings stop arriving, or rates stop leaving,
 *  with no error anywhere. */
export function ruleBothSyncDirectionsEnabled(conn) {
  if (!conn) return no("no active connection to inspect");
  if (conn.inbound_sync_enabled !== true) return no("inbound_sync_enabled=false (booking pull is off)");
  if (conn.outbound_sync_enabled !== true) return no("outbound_sync_enabled=false (ARI push is off)");
  return yes("inbound + outbound sync enabled");
}

/** C4 — a refresh token is stored, so the token resolver can mint access
 *  tokens. Presence only: this rule never sees, compares or returns the
 *  secret's value. */
export function ruleRefreshTokenPresent(conn) {
  if (!conn) return no("no active connection to inspect");
  return conn.has_refresh_token === true
    ? yes("refresh token present (presence only — value never read)")
    : no("no refresh token configured (api_key_ciphertext IS NULL)");
}

/** C5 — the outbound circuit breaker is not in cooldown. Mirrors
 *  circuitPhase() in src/lib/channel/circuit-breaker.ts: open strictly while
 *  now < openUntil; at/after openUntil the breaker is half-open, which allows
 *  a trial and therefore counts as "not blocking". */
export function ruleCircuitBreakerClosed(conn, nowMs) {
  if (!conn) return no("no active connection to inspect");
  const openUntil = conn.circuit_open_until ? new Date(conn.circuit_open_until).getTime() : null;
  if (openUntil !== null && openUntil > nowMs) {
    return no(`circuit OPEN until ${new Date(openUntil).toISOString()} (consecutive_failures=${conn.consecutive_failures})`);
  }
  return yes(`circuit not blocking (consecutive_failures=${conn.consecutive_failures})`);
}

// ---------------------------------------------------------------
// check:beds24-jobs
// ---------------------------------------------------------------

/** Fold `[{job_type, status, c}]` into `{type: {succeeded, other}}`. Shared by
 *  J1/J2 so both see exactly the same view of the same read-back rows. */
export function foldJobRows(rows) {
  const by = new Map();
  for (const r of rows ?? []) {
    const e = by.get(r.job_type) ?? { succeeded: 0, other: 0 };
    if (r.status === "succeeded") e.succeeded += Number(r.c);
    else e.other += Number(r.c);
    by.set(r.job_type, e);
  }
  return by;
}

/** J1 — at least one succeeded pull_booking_revisions finished in the window.
 *  Zero means the inbound feed is dead and guests are booking into a void. */
export function ruleInboundFeedAlive(byType) {
  const p = byType?.get?.("pull_booking_revisions") ?? { succeeded: 0, other: 0 };
  return p.succeeded >= 1
    ? yes(`${p.succeeded} succeeded pulls in window`)
    : no("no succeeded pull_booking_revisions in window — inbound feed is dead");
}

/** J2 — every Beds24 job type finished within the failure budget.
 *
 *  ANTI-VACUITY (the defect this rule was rewritten to remove): the original
 *  code looped over an empty map and then counted a PASS, so a database with
 *  no jobs at all "proved" the failure share was fine. An empty map is now an
 *  explicit REJECT — a guard must never be green because its subject is
 *  missing. */
export function ruleFailureShareWithinBudget(byType, max = THRESHOLDS.failureShareMax) {
  const entries = [...(byType?.entries?.() ?? [])];
  if (entries.length === 0) return no("no beds24 job types in window — nothing to measure (vacuous pass refused)");
  const bad = [];
  const seen = [];
  for (const [type, e] of entries) {
    const total = e.succeeded + e.other;
    const share = total ? e.other / total : 0;
    seen.push(`${type} ${e.succeeded}ok/${e.other}bad`);
    if (share > max) bad.push(`${type}: ${e.other}/${total} = ${(share * 100).toFixed(1)}%`);
  }
  return bad.length === 0
    ? yes(`${entries.length} job type(s) within ${(max * 100).toFixed(0)}% budget — ${seen.join(", ")}`)
    : no(`over the ${(max * 100).toFixed(0)}% budget — ${bad.join("; ")}`);
}

/** J3 — zero jobs for a non-Beds24 provider finished after the D91 cutover.
 *  Jobs that finished BEFORE it are legitimate history. */
export function ruleNoForeignProviderJobsSinceCutover(count) {
  const c = Number(count);
  return c === 0
    ? yes("zero non-beds24 jobs since the D91 cutover")
    : no(`${c} non-beds24 jobs finished after the D91 cutover — a decommissioned provider is running`);
}

// ---------------------------------------------------------------
// check:beds24-revisions
// ---------------------------------------------------------------

/** R1 — the last succeeded pull is recent. `lastIso` null (never pulled) is a
 *  REJECT, not a pass: an empty history is the worst case, not the best. */
export function rulePullFreshness(lastIso, nowMs, maxMinutes = THRESHOLDS.pullFreshnessMaxMinutes) {
  if (!lastIso) return no("no succeeded pull_booking_revisions ever recorded");
  const ageMin = (nowMs - new Date(lastIso).getTime()) / 60_000;
  return ageMin <= maxMinutes
    ? yes(`last succeeded pull ${ageMin.toFixed(1)} min ago (threshold ${maxMinutes}m)`)
    : no(`last succeeded pull ${ageMin.toFixed(0)} min ago (threshold ${maxMinutes}m)`);
}

/** R2 — no revision has sat un-imported past the grace period. These are the
 *  silent data-loss channel: a quarantined revision is a booking the hotel
 *  does not know about. */
export function ruleNoRevisionsStuckUnimported(count, graceHours = THRESHOLDS.revisionGraceHours) {
  const c = Number(count);
  return c === 0
    ? yes(`zero revisions stuck un-imported > ${graceHours}h`)
    : no(`${c} revisions stuck un-imported > ${graceHours}h (quarantine / mapping errors?)`);
}

/** R3 — every imported revision past the grace period was acknowledged back to
 *  the provider. Unacknowledged imports get re-delivered forever. */
export function ruleNoImportedButUnacknowledged(count, graceHours = THRESHOLDS.revisionGraceHours) {
  const c = Number(count);
  return c === 0
    ? yes(`zero imported-but-unacknowledged revisions > ${graceHours}h`)
    : no(`${c} imported revisions unacknowledged > ${graceHours}h`);
}

// ---------------------------------------------------------------
// check:beds24-ari
// ---------------------------------------------------------------

/** A1 — no dirty range on the ACTIVE Beds24 connection has survived the grace
 *  period un-synced. A pending range means Beds24 is selling on stale
 *  availability — the overbooking recipe. */
export function ruleNoStaleDirtyRanges(count, graceHours = THRESHOLDS.dirtyRangeGraceHours) {
  const c = Number(count);
  return c === 0
    ? yes(`zero beds24 dirty ranges pending > ${graceHours}h`)
    : no(`${c} beds24 dirty ranges pending > ${graceHours}h — the ARI drain is stuck`);
}

/** A2 — if anything was dirtied in the window, at least one ARI push succeeded.
 *
 *  ANTI-VACUITY: the original code treated "nothing was dirtied" as a PASS and
 *  incremented the pass counter, which is how check:beds24-ari reported
 *  "2 PASSED" against a database with no Beds24 integration at all. The
 *  not-applicable case is now its own outcome — `applicable:false` — and the
 *  guard reports it as SKIPPED. A skipped rule is never a pass. */
export function ruleAriDrainKeepingUp(dirtiedCount, succeededPushCount) {
  const dirtied = Number(dirtiedCount);
  const pushes = Number(succeededPushCount);
  if (dirtied === 0) {
    return { ok: false, applicable: false, detail: `nothing dirtied in window (${pushes} pushes ran) — NOT APPLICABLE, not a pass` };
  }
  return pushes >= 1
    ? { ...yes(`${pushes} succeeded pushes against ${dirtied} dirtied ranges`), applicable: true }
    : { ...no(`${dirtied} ranges dirtied but zero succeeded ARI pushes`), applicable: true };
}
