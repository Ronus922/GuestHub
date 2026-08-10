-- 083: circuit breaker state for the TTLock connection.
--
-- Mirrors circuit_open_until / consecutive_failures on channel_connections:
-- the breaker state must be shared between two processes — the PM2 channel
-- worker (drain) and the Next.js server actions (manual sync / rotate) — and
-- the /locks amber banner reads it, so it lives on the connection row, not in
-- process memory.
--
-- last_errcode is the NUMERIC TTLock errcode only — never errmsg, which is an
-- upstream body (Chinese) and by policy never persisted or logged.
-- last_failure_at is kept as a forensic trace and is not cleared on success.
--
-- Applied via deploy (apply-pending-migrations.mjs), before the processes
-- restart. Idempotent, no backfill.

SET search_path TO "guesthub", public;

ALTER TABLE guesthub.ttlock_connections
  ADD COLUMN IF NOT EXISTS circuit_open_until timestamptz,
  ADD COLUMN IF NOT EXISTS circuit_failures   int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_errcode       int,
  ADD COLUMN IF NOT EXISTS last_failure_at    timestamptz;

-- ROLLBACK:
--   ALTER TABLE guesthub.ttlock_connections
--     DROP COLUMN IF EXISTS circuit_open_until,
--     DROP COLUMN IF EXISTS circuit_failures,
--     DROP COLUMN IF EXISTS last_errcode,
--     DROP COLUMN IF EXISTS last_failure_at;
