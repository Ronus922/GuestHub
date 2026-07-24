// ============================================================
// Beds24 credit window (P0-4) — the pacing brain. PURE: no DB, no HTTP, no
// clock, no `server-only` (the /channels diagnostics imports the constants).
//
// Beds24 meters by CREDITS, not by requests: 100 credits per rolling 5-minute
// window per ACCOUNT, with a DYNAMIC per-request cost. Every metered response
// carries the meter in three headers:
//
//   x-five-min-limit-remaining : 97.6   credits left in this window (FRACTIONAL)
//   x-five-min-limit-resets-in : 155    seconds until the window resets
//   x-request-cost             : 1.2    what THIS call cost
//
// HEADER NAMES ARE MEASURED, NOT GUESSED. Captured live from api.beds24.com on
// 2026-07-24 with the production token (GET /bookings, the poll's own filter
// shape). The name this file used to read — `x-fivemincreditlimit-remaining` —
// does not exist on the wire, which is why every persisted creditsRemaining in
// the evidence ledger was NULL (192 incremental_sync rows + 9 full_sync rows,
// 100% null). Note also that /authentication/details returns NO credit headers
// at all: a missing meter is normal and must never be read as "no credits".
//
// ---- THE ARITHMETIC (production, tenant 68139d06, 24h to 2026-07-24 21:42) --
//   ceiling                    C = 100 credits / rolling 5 min
//   measured cost per call     k = 1.2                (live probe, GET /bookings)
//   calls the window affords     = floor(100 / 1.2) = 83
//   inbound poll                 = 287 jobs / 24h ≈ 12/h ≈ 1 call per 5-min window
//   busiest observed window      = 43 ARI requests (evidence ledger) + 1 poll
//                                = 44 calls = 52.8 credits = 52.8% of C
//   median window                = 1 call = 1.2 credits = 1.2% of C
//   ARI drain's own ceiling      = MAX_REQUESTS_PER_RUN (120) × 1.2 = 144 credits
//                                → ONE drain run can overrun the window by 44%.
//
// ---- THRESHOLD DERIVATION ---------------------------------------------------
// What must never be starved is the INBOUND work: the 5-minute poll (1 call)
// and the 20-minute cancellation reconciliation (1 call per open OTA
// reservation — 4 today), because that pair IS the OTA-cancellation safety net
// (D93). Outbound ARI is deferrable: a dirty range that waits is re-sent intact.
//
//   reserve = poll(1) + reconcile(4) + 2 in-flight = 7 calls
//   7 × k   = 8.4 credits
//   rounded up to 10 calls of headroom, because Beds24 documents the cost as
//   DYNAMIC and 1.2 is one sample of one endpoint:
//
//   BEDS24_LOW_CREDIT_THRESHOLD = 10 × 1.2 = 12 credits = 12% of the ceiling.
//
// Below it, the deferrable outbound work yields until the window resets — the
// wait comes from the provider's own `resets-in`, never from a blind retry.
// ============================================================

/** Documented account ceiling: credits per rolling 5-minute window. */
export const BEDS24_CREDIT_CEILING = 100;
/** Live-measured cost of one production call (GET /bookings, 2026-07-24). */
export const BEDS24_MEASURED_CALL_COST = 1.2;
/** Below this many remaining credits the outbound work yields (see derivation). */
export const BEDS24_LOW_CREDIT_THRESHOLD = 12;
/** The window itself — also the hard ceiling on any credit wait. */
export const BEDS24_CREDIT_WINDOW_MS = 5 * 60_000;
/** Never pause for less than this (a 0-second wait is a blind retry). */
export const BEDS24_MIN_PAUSE_MS = 1_000;

/** The wire names, measured live. One place, so a rename is a one-line fix. */
export const BEDS24_CREDIT_HEADERS = {
  remaining: "x-five-min-limit-remaining",
  resetsIn: "x-five-min-limit-resets-in",
  cost: "x-request-cost",
} as const;

/** What one response said about the credit window. All three may be absent. */
export type Beds24CreditSnapshot = {
  /** credits left in the current 5-minute window (fractional) */
  remaining: number | null;
  /** seconds until the window resets */
  resetsInSec: number | null;
  /** what the call that produced this snapshot cost */
  cost: number | null;
};

export const EMPTY_BEDS24_CREDITS: Beds24CreditSnapshot = {
  remaining: null,
  resetsInSec: null,
  cost: null,
};

export type Beds24CreditPause = {
  /** low_credits = we stopped BEFORE the wall; rate_limited = HTTP 429, we hit it */
  reason: "low_credits" | "rate_limited";
  /** how long the caller must hold off, derived from the provider's own numbers */
  waitMs: number;
  remaining: number | null;
  resetsInSec: number | null;
};

function num(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? n : null;
}

/** Read the meter off one response. `get` is any case-insensitive header getter. */
export function readBeds24Credits(
  get: (name: string) => string | null | undefined,
): Beds24CreditSnapshot {
  return {
    remaining: num(get(BEDS24_CREDIT_HEADERS.remaining)),
    resetsInSec: num(get(BEDS24_CREDIT_HEADERS.resetsIn)),
    cost: num(get(BEDS24_CREDIT_HEADERS.cost)),
  };
}

/** How long until the credit window resets. Absent/absurd → one full window. */
export function beds24ResetWaitMs(resetsInSec: number | null): number {
  if (resetsInSec === null || !Number.isFinite(resetsInSec) || resetsInSec <= 0) {
    return BEDS24_CREDIT_WINDOW_MS;
  }
  return Math.min(
    Math.max(Math.ceil(resetsInSec * 1000), BEDS24_MIN_PAUSE_MS),
    BEDS24_CREDIT_WINDOW_MS,
  );
}

/**
 * The decision for ONE response. Returns null while the window has room.
 *
 * Two distinct paths, deliberately kept apart:
 *  (b) HTTP 429 — the provider has already refused. Its own path, because the
 *      cooldown source differs: Retry-After when Beds24 sends one, otherwise the
 *      credit window's `resets-in`. Never an immediate re-attempt.
 *  (a) remaining < threshold — we are still allowed to call, but the next call
 *      would eat the reserve the inbound safety net needs. Yield until reset.
 */
export function evaluateBeds24Credits(
  snapshot: Beds24CreditSnapshot | null | undefined,
  opts?: { httpStatus?: number; retryAfterMs?: number },
): Beds24CreditPause | null {
  const snap = snapshot ?? EMPTY_BEDS24_CREDITS;
  if (opts?.httpStatus === 429) {
    const fromRetryAfter =
      opts.retryAfterMs !== undefined && opts.retryAfterMs > 0
        ? Math.min(
            Math.max(opts.retryAfterMs, BEDS24_MIN_PAUSE_MS),
            BEDS24_CREDIT_WINDOW_MS,
          )
        : null;
    return {
      reason: "rate_limited",
      waitMs: fromRetryAfter ?? beds24ResetWaitMs(snap.resetsInSec),
      remaining: snap.remaining,
      resetsInSec: snap.resetsInSec,
    };
  }
  if (snap.remaining !== null && snap.remaining < BEDS24_LOW_CREDIT_THRESHOLD) {
    return {
      reason: "low_credits",
      waitMs: beds24ResetWaitMs(snap.resetsInSec),
      remaining: snap.remaining,
      resetsInSec: snap.resetsInSec,
    };
  }
  return null;
}

/**
 * The gate one run holds. Both call loops that can burst — the outbound
 * calendar sender and the inbound page walker — observe every response through
 * it and stop as soon as `pause` is set. ONE implementation, so the two paths
 * can never drift (DRY).
 */
export type Beds24CreditGate = {
  /** the pause in force for the rest of this run, or null while there is room */
  readonly pause: Beds24CreditPause | null;
  /** the newest meter reading seen (for evidence + the /channels diagnostics) */
  readonly last: Beds24CreditSnapshot | null;
  /** feed one response; returns the pause it caused, or null */
  observe(
    snapshot: Beds24CreditSnapshot | null | undefined,
    opts?: { httpStatus?: number; retryAfterMs?: number },
  ): Beds24CreditPause | null;
};

export function createBeds24CreditGate(): Beds24CreditGate {
  let pause: Beds24CreditPause | null = null;
  let last: Beds24CreditSnapshot | null = null;
  return {
    get pause() {
      return pause;
    },
    get last() {
      return last;
    },
    observe(snapshot, opts) {
      if (snapshot && (snapshot.remaining !== null || snapshot.resetsInSec !== null)) {
        last = snapshot;
      }
      const next = evaluateBeds24Credits(snapshot, opts);
      // the LONGEST wait wins — a 429 mid-run must not be shortened by a later
      // low-credit reading that happens to carry a smaller resets-in
      if (next && (pause === null || next.waitMs > pause.waitMs)) pause = next;
      return next;
    },
  };
}

/** Fixed-vocabulary Hebrew reason for the operator surfaces. Never a body echo. */
export function beds24CreditPauseMessage(pause: Beds24CreditPause): string {
  const secs = Math.ceil(pause.waitMs / 1000);
  return pause.reason === "rate_limited"
    ? `Beds24 החזיר 429 — מכסת הקרדיטים מוצתה; המתנה ${secs} שניות עד איפוס החלון`
    : `מכסת הקרדיטים של Beds24 קרובה למיצוי (${pause.remaining ?? "?"}/${BEDS24_CREDIT_CEILING}) — האטה ל-${secs} שניות עד איפוס החלון`;
}
