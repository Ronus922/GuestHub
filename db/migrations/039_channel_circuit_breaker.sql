-- ============================================================
--  GuestHub · Stage 4 — Channex outbound circuit-breaker state (§16, defect M14).
--
--  Connection-level protection against a rate-limiting or failing provider: the
--  worker opens a cooldown after a 429 (honouring Retry-After) or after N
--  consecutive server/transport failures, and skips draining that connection
--  until the cooldown elapses. This is DISTINCT from the per-range exponential
--  backoff already on channel_dirty_ranges — that retries individual ranges;
--  this stops hammering the whole connection.
--
--  The breaker logic is a pure state machine (src/lib/channel/circuit-breaker.ts);
--  these columns are only where the worker persists that state between drains so
--  it survives a worker restart.
--
--  Idempotent. Safe to replay from zero. No data deleted.
-- ============================================================
SET search_path TO "guesthub", public;

ALTER TABLE guesthub.channel_connections
  ADD COLUMN IF NOT EXISTS circuit_open_until    timestamptz,
  ADD COLUMN IF NOT EXISTS consecutive_failures  int NOT NULL DEFAULT 0;

COMMENT ON COLUMN guesthub.channel_connections.circuit_open_until IS
  '§16 circuit breaker: no outbound drain until this time (NULL = closed).';
COMMENT ON COLUMN guesthub.channel_connections.consecutive_failures IS
  '§16 circuit breaker: counting failures since the last success.';
