-- ============================================================
--  086 — channel_sync_errors gets a LIFECYCLE: occurrence + closure
--
--  WHY. The row in channel_sync_errors is written once per (connection,
--  error_code) and then never touched again: alertOnce (D112,
--  beds24-ari-readback.ts) deliberately suppresses a repeat so a drift that
--  persists for a week does not fill the 10-row /channels list with one
--  repeating message. The suppression works, and it costs the operator two
--  facts the alarm should have carried all along:
--
--    · HOW OFTEN. A row created three weeks ago reads identically whether the
--      condition fired once and vanished or has fired every 20 minutes since.
--      created_at is the FIRST sighting; nothing recorded the last one.
--    · WHETHER IT IS STILL TRUE. resolved_at was only ever set by hand. A
--      read-back drift that the operator fixed with a Full Sync left its alert
--      standing until somebody remembered to close it, so the list showed
--      problems that no longer existed — and an operator who learns the list
--      is stale stops reading the list.
--
--  This migration adds the two columns those facts need. It does NOT decide
--  who writes them: the read-back refreshes its own row each cycle and closes
--  it on a clean cycle (see the module header there). Every other producer is
--  unchanged and keeps the defaults.
--
--  WHAT THIS DOES NOT DO. It backfills nothing. The 300 existing rows keep
--  occurrence_count = 1 and last_seen_at = NULL, which is the honest reading:
--  nobody counted their sightings, and inventing a count from created_at would
--  be fabrication. The three open ari_readback_* rows self-close on the first
--  clean cycle after this deploys — by the closer, from real evidence, not by
--  an UPDATE in a migration.
--
--  RETENTION. purge_channel_sync_errors (043) deletes resolved rows after 30
--  days and unresolved ones after 180. Closing a row therefore MOVES it onto
--  the shorter clock — intended: a closed alert is history, and the evidence
--  ledger, not this table, is the durable trail. The purge is a function, not
--  a schedule; nothing calls it on a timer today.
--
--  Idempotent. Safe to replay.
-- ============================================================
SET search_path TO "guesthub", public;

ALTER TABLE guesthub.channel_sync_errors
  ADD COLUMN IF NOT EXISTS occurrence_count integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_seen_at     timestamptz;

-- The shape EVERY suppression query and the read-back closer filter on:
--   WHERE tenant_id = ? AND connection_id = ? AND error_code = ? AND resolved_at IS NULL
-- Partial on resolved_at IS NULL because that is the only half ever probed —
-- the resolved half is read by the purge, which scans by date anyway.
CREATE INDEX IF NOT EXISTS idx_sync_errors_open_conn_code
  ON guesthub.channel_sync_errors (connection_id, error_code)
  WHERE resolved_at IS NULL;
