-- ============================================================
--  022 · Channex Staging — connection-test result columns
--  Additive + idempotent. Extends the EXISTING channel_connections table
--  (created in 005) so a real "Test connection" can record its outcome.
--  NO new table, NO credential column (api_key_ciphertext/api_key_hint
--  already exist in 005). NO property/room-type/rate-plan/webhook/booking
--  is created. DECISIONS D59.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/022_channex_connection_test.sql
-- ============================================================

ALTER TABLE guesthub.channel_connections
  -- last time a connection test returned HTTP 200 (credential verified)
  ADD COLUMN IF NOT EXISTS last_test_ok_at      timestamptz,
  -- last time a connection test failed (credential kept, not cleared)
  ADD COLUMN IF NOT EXISTS last_test_failed_at  timestamptz,
  -- safe, enumerated failure category (never a raw upstream body/header):
  -- unauthorized|forbidden|not_found|rate_limited|server_error|timeout|
  -- network_error|bad_response
  ADD COLUMN IF NOT EXISTS last_test_error_code text;
