-- ============================================================
--  029 · Channex inbound bookings — external reservation identity (D76)
--  Additive + idempotent. NO data is modified, NO reservation is created.
--
--  WHY. D76 activates the dormant inbound path (webhook → pull job →
--  channel_booking_revisions → canonical reservation). A revision row already
--  can never import twice — UNIQUE (connection_id, provider_revision_id),
--  migration 005 — but the RESERVATION needs its own stable external identity
--  so a modification/cancellation revision updates the SAME reservation, and so
--  a repeated webhook, feed pull, worker retry or manual "pull now" can never
--  create a duplicate. Identity is (channel_connection_id, external_booking_id):
--  the Channex booking UUID, scoped by connection (an OTA code alone is NOT
--  globally unique). Enforced by a partial unique index, not application code.
--
--  Manual reservations keep every new column NULL — nothing changes for them.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/029_inbound_booking_identity.sql
--
--  ROLLBACK:
--    DROP INDEX IF EXISTS guesthub.uq_reservations_external_booking;
--    ALTER TABLE guesthub.reservations
--      DROP COLUMN IF EXISTS channel_connection_id,
--      DROP COLUMN IF EXISTS external_booking_id,
--      DROP COLUMN IF EXISTS external_revision_id,
--      DROP COLUMN IF EXISTS external_unique_id,
--      DROP COLUMN IF EXISTS ota_reservation_code,
--      DROP COLUMN IF EXISTS ota_name,
--      DROP COLUMN IF EXISTS external_booked_at;
--    DROP INDEX IF EXISTS guesthub.idx_revisions_unacked;
-- ============================================================

SET search_path TO "guesthub", public;

-- ---- 1. external identity on the canonical reservation ----
ALTER TABLE guesthub.reservations
  ADD COLUMN IF NOT EXISTS channel_connection_id uuid
    REFERENCES guesthub.channel_connections(id) ON DELETE SET NULL,
  -- the Channex booking UUID — the ONE stable identity of the OTA booking
  ADD COLUMN IF NOT EXISTS external_booking_id  text,
  -- the LAST revision applied to this reservation (audit/drift diagnosis)
  ADD COLUMN IF NOT EXISTS external_revision_id text,
  -- e.g. "BDC-6940045162"
  ADD COLUMN IF NOT EXISTS external_unique_id   text,
  -- e.g. "6940045162"
  ADD COLUMN IF NOT EXISTS ota_reservation_code text,
  -- e.g. "BookingCom" (verbatim from the channel; source_id holds the local lookup)
  ADD COLUMN IF NOT EXISTS ota_name             text,
  -- the channel's inserted_at of the FIRST revision (when the OTA booked)
  ADD COLUMN IF NOT EXISTS external_booked_at   timestamptz;

-- one reservation per (connection, external booking) — the duplicate gate
CREATE UNIQUE INDEX IF NOT EXISTS uq_reservations_external_booking
  ON guesthub.reservations (channel_connection_id, external_booking_id)
  WHERE channel_connection_id IS NOT NULL AND external_booking_id IS NOT NULL;

-- ---- 2. fast scan of revisions still owed an acknowledgement ----
CREATE INDEX IF NOT EXISTS idx_revisions_unacked
  ON guesthub.channel_booking_revisions (connection_id, created_at)
  WHERE ack_status = 'unacknowledged';

-- ---- 3. grants (000 pattern) ----
GRANT ALL ON ALL TABLES IN SCHEMA "guesthub" TO service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA "guesthub" FROM anon, authenticated;
