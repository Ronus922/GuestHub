-- ============================================================
--  075 · index for the inbound-pull liveness probe (D133)
--
--  The dashboard's connection-health signal asks one question per load:
--    max(finished_at) WHERE connection_id = ? AND job_type = 'pull_booking_revisions'
--                       AND status = 'succeeded'
--
--  channel_sync_jobs has no index that serves it. Measured on production
--  (49,370 rows): Seq Scan, 4,177 matching rows, 11.0 ms. The table grows
--  unbounded — the inbound poll alone adds ~288 rows/day and nothing prunes it —
--  so this is 11 ms today and proportionally worse every week, on the dashboard's
--  critical path.
--
--  Partial on status='succeeded' because that is the only status the probe
--  reads; the index stays a fraction of the table.
--
--  Additive, idempotent, no data change. Safe to apply while the worker runs.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/075_sync_jobs_finished_index.sql
--
--  Rollback:
--    DROP INDEX IF EXISTS guesthub.idx_jobs_pull_liveness;
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_jobs_pull_liveness
  ON guesthub.channel_sync_jobs (connection_id, job_type, finished_at DESC)
  WHERE status = 'succeeded';

COMMENT ON INDEX guesthub.idx_jobs_pull_liveness IS
  'D133 — serves the dashboard connection-health probe: newest succeeded pull_booking_revisions per connection.';
