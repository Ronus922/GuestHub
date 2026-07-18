// ============================================================
// Channex outbound circuit breaker (Stage 4 §16, defect M14).
//
// PURE state machine — no DB, no HTTP, no clock (the caller passes `now`), so it
// is unit-testable in isolation (scripts/check-channex-rate-limit-cooldown.mjs).
// The persisted state lives on channel_connections (circuit_open_until,
// consecutive_failures); the worker reads it before a drain and writes the next
// state after. This is CONNECTION-level protection (stop hammering a provider
// that is rate-limiting or down), complementary to the per-range exponential
// backoff already in channel_dirty_ranges.
//
// States (derived, not stored):
//   closed     — normal; requests flow.
//   open       — in cooldown; NO request until openUntil.
//   half_open  — cooldown elapsed; allow ONE trial. Success → closed; failure →
//                open again with a longer cooldown.
// ============================================================

export type CircuitFailureKind = "rate_limited" | "server_error" | "timeout" | "network_error" | "other";

export type CircuitState = {
  /** consecutive counting failures since the last success */
  consecutiveFailures: number;
  /** epoch ms the circuit stays open until, or null when closed */
  openUntil: number | null;
};

export type CircuitConfig = {
  /** consecutive non-rate-limit failures before the breaker trips */
  failureThreshold: number;
  /** base cooldown when the breaker trips or when no Retry-After is given */
  baseCooldownMs: number;
  /** ceiling on the (exponentially growing) cooldown */
  maxCooldownMs: number;
};

export const DEFAULT_CIRCUIT: CircuitConfig = {
  failureThreshold: 5,
  baseCooldownMs: 60_000, // 1 min
  maxCooldownMs: 15 * 60_000, // 15 min
};

export const CLOSED: CircuitState = { consecutiveFailures: 0, openUntil: null };

/** Derived phase for a state at a given moment. */
export function circuitPhase(state: CircuitState, now: number): "closed" | "open" | "half_open" {
  if (state.openUntil == null) return "closed";
  if (now < state.openUntil) return "open";
  return "half_open";
}

/** May a request be attempted right now? Open (still cooling) blocks; half-open allows a trial. */
export function circuitAllowsRequest(state: CircuitState, now: number): boolean {
  return circuitPhase(state, now) !== "open";
}

/** A successful request always fully closes the breaker. */
export function onCircuitSuccess(): CircuitState {
  return CLOSED;
}

// A failure advances the breaker. A 429 opens immediately for its Retry-After
// (or the base cooldown); other counting failures open only once the threshold is
// crossed, with an exponential cooldown bounded by maxCooldownMs.
export function onCircuitFailure(
  state: CircuitState,
  kind: CircuitFailureKind,
  now: number,
  opts?: { retryAfterMs?: number; config?: CircuitConfig },
): CircuitState {
  const cfg = opts?.config ?? DEFAULT_CIRCUIT;
  const consecutiveFailures = state.consecutiveFailures + 1;

  if (kind === "rate_limited") {
    const cooldown = Math.min(
      Math.max(opts?.retryAfterMs ?? cfg.baseCooldownMs, 1_000),
      cfg.maxCooldownMs,
    );
    return { consecutiveFailures, openUntil: now + cooldown };
  }

  if (consecutiveFailures >= cfg.failureThreshold) {
    const over = consecutiveFailures - cfg.failureThreshold; // 0,1,2,…
    const cooldown = Math.min(cfg.baseCooldownMs * 2 ** over, cfg.maxCooldownMs);
    return { consecutiveFailures, openUntil: now + cooldown };
  }

  // below threshold: count it but keep flowing (per-range backoff handles retries)
  return { consecutiveFailures, openUntil: null };
}

/** Map an API error category to the breaker's failure kind. */
export function failureKindOf(category: string): CircuitFailureKind {
  if (category === "rate_limited") return "rate_limited";
  if (category === "server_error") return "server_error";
  if (category === "timeout") return "timeout";
  if (category === "network_error") return "network_error";
  return "other";
}
