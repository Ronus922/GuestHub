-- ============================================================
--  GuestHub · D52 — Permanent removal of stored CVV/CVC.
--
--  Reverses the D43 "CVV stored ENCRYPTED" rule (migration 010). As of D52 the
--  system MUST NOT retain a CVV/CVC after authorization — not even encrypted.
--  This migration:
--    1. Records ONLY aggregate remediation counts (never any value) to the
--       server log via RAISE NOTICE.
--    2. Permanently DROPS the CVV columns, destroying every stored value:
--         guesthub.reservation_cards.cvv_encrypted
--         guesthub.channel_booking_revisions.card_cvv_encrypted
--    3. Leaves NO future write path (the application code that wrote these
--       columns was removed in the same change — card-actions.ts, card-vault.ts,
--       channel/{card-ingest,revisions,payloads}.ts).
--
--  Legitimate payment and reservation records are PRESERVED — only the CVV
--  columns are removed. No PAN, no last4, no payment, no card metadata is touched.
--  Sensitive values are NEVER printed. Idempotent: safe to re-run (the counts
--  read 0 once the columns are gone).
--
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/018_remove_stored_cvv.sql
--
--  ROLLBACK (re-adds the EMPTY columns only — the values are gone forever and
--  must never be repopulated):
--    ALTER TABLE guesthub.reservation_cards ADD COLUMN IF NOT EXISTS cvv_encrypted text;
--    ALTER TABLE guesthub.channel_booking_revisions ADD COLUMN IF NOT EXISTS card_cvv_encrypted text;
-- ============================================================

SET search_path TO "guesthub", public;

DO $$
DECLARE
  card_cvv_count    bigint := 0;
  channel_cvv_count bigint := 0;
BEGIN
  -- count-only remediation audit (NO values are ever selected or printed)
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='guesthub' AND table_name='reservation_cards'
               AND column_name='cvv_encrypted') THEN
    EXECUTE 'SELECT count(cvv_encrypted) FROM guesthub.reservation_cards'
      INTO card_cvv_count;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='guesthub' AND table_name='channel_booking_revisions'
               AND column_name='card_cvv_encrypted') THEN
    EXECUTE 'SELECT count(card_cvv_encrypted) FROM guesthub.channel_booking_revisions'
      INTO channel_cvv_count;
  END IF;

  RAISE NOTICE 'D52 CVV remediation — reservation_cards CVV-bearing rows removed: %', card_cvv_count;
  RAISE NOTICE 'D52 CVV remediation — channel_booking_revisions CVV-bearing rows removed: %', channel_cvv_count;
END $$;

-- Permanently destroy the stored CVV values by dropping the columns.
ALTER TABLE reservation_cards
  DROP COLUMN IF EXISTS cvv_encrypted;

ALTER TABLE channel_booking_revisions
  DROP COLUMN IF EXISTS card_cvv_encrypted;
