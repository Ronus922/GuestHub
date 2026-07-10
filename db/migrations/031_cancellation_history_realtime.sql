-- ============================================================
--  031 · D77 — canonical cancellation history on reservations
--  Additive + idempotent. Existing rows are modified ONLY by the
--  cancellation BACKFILL (fills previously NULL columns on rows that are
--  already status='cancelled', from their own audit trail).
--
--  WHY COLUMNS (not audit-only): D77 §7 — the reservations page filters and
--  displays who/when/why a booking was cancelled; audit_logs stay the full
--  history but are not a queryable row state.
--
--  Deliberately NOT added (already canonically represented):
--   · cancellation_requested_at        = external_cancellation_requested_at (030)
--   · cancellation_pending_external    = DERIVED:
--        external_cancellation_requested_at IS NOT NULL AND status <> 'cancelled'
--     (a stored boolean would duplicate state — §12 one-domain rule)
--
--  NOTE ON REALTIME (D77 §3-§6): the realtime layer is pg_notify-based and
--  needs NO schema — NOTIFY inside the business transaction is delivered by
--  PostgreSQL only on COMMIT (verified through the Supavisor session pooler).
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/031_cancellation_history_realtime.sql
--
--  ROLLBACK:
--    ALTER TABLE guesthub.reservations
--      DROP COLUMN IF EXISTS cancelled_at,
--      DROP COLUMN IF EXISTS cancelled_by_type,
--      DROP COLUMN IF EXISTS cancelled_by_user_id,
--      DROP COLUMN IF EXISTS cancellation_origin,
--      DROP COLUMN IF EXISTS cancellation_reason,
--      DROP COLUMN IF EXISTS external_cancellation_confirmed_at;
--    DROP INDEX IF EXISTS guesthub.idx_reservations_tenant_status;
--    DROP INDEX IF EXISTS guesthub.idx_reservations_tenant_checkin;
-- ============================================================

SET search_path TO "guesthub", public;

-- ---- 1. cancellation history columns ----
ALTER TABLE guesthub.reservations
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by_type text
    CHECK (cancelled_by_type IS NULL
           OR cancelled_by_type IN ('guest', 'operator', 'ota', 'system', 'unknown')),
  ADD COLUMN IF NOT EXISTS cancelled_by_user_id uuid
    REFERENCES guesthub.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancellation_origin text
    CHECK (cancellation_origin IS NULL
           OR cancellation_origin IN ('guest_booking_page', 'operator_direct_booking',
                                      'ota_revision', 'booking_com', 'expedia',
                                      'invalid_card', 'no_show', 'external', 'system')),
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  -- the moment the CHANNEL's own cancelled revision landed (distinct from
  -- external_cancellation_requested_at = when WE asked the channel to cancel)
  ADD COLUMN IF NOT EXISTS external_cancellation_confirmed_at timestamptz;

-- ---- 2. indexes for the /reservations list (tab counts + date filters) ----
CREATE INDEX IF NOT EXISTS idx_reservations_tenant_status
  ON guesthub.reservations (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_reservations_tenant_checkin
  ON guesthub.reservations (tenant_id, check_in);

-- ---- 3. backfill for already-cancelled rows, from their own audit trail ----
-- Latest 'cancel' (operator) / 'channel_import_cancel' (OTA) audit row per
-- reservation. A row with NO audit trail keeps cancelled_at NULL — the time
-- is genuinely unknown and displaying a fabricated one (e.g. updated_at,
-- which migration 030's workflow backfill just bumped) would be dishonest.
-- Idempotent: only rows not yet classified (cancelled_by_type IS NULL) are
-- touched, and re-runs produce identical values.
WITH latest_cancel_audit AS (
  SELECT DISTINCT ON (a.entity_id)
         a.entity_id, a.action, a.user_id, a.created_at,
         a.after_data->>'reason' AS reason
  FROM guesthub.audit_logs a
  WHERE a.entity_type = 'reservation'
    AND a.action IN ('cancel', 'channel_import_cancel')
  ORDER BY a.entity_id, a.created_at DESC
)
UPDATE guesthub.reservations r
SET cancelled_at         = la.created_at,
    cancelled_by_type    = CASE
                             WHEN la.action = 'channel_import_cancel' THEN 'ota'
                             WHEN la.user_id IS NOT NULL THEN 'operator'
                             ELSE 'unknown'
                           END,
    cancelled_by_user_id = la.user_id,
    cancellation_origin  = CASE
                             WHEN la.action = 'channel_import_cancel' THEN 'ota_revision'
                             WHEN la.user_id IS NOT NULL THEN 'operator_direct_booking'
                             ELSE NULL
                           END,
    cancellation_reason  = la.reason
FROM (SELECT r2.id FROM guesthub.reservations r2
      WHERE r2.status = 'cancelled' AND r2.cancelled_by_type IS NULL) todo
LEFT JOIN latest_cancel_audit la ON la.entity_id = todo.id
WHERE r.id = todo.id;

-- ---- 4. grants (000 pattern) ----
GRANT ALL ON ALL TABLES IN SCHEMA "guesthub" TO service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA "guesthub" FROM anon, authenticated;
