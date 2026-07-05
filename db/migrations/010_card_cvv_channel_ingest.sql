-- ============================================================
--  GuestHub · D43 correction pass — encrypted CVV persistence + operational
--  channel-card staging.
--
--  Reverses the D42 "CVV never stored" rule (per approved product requirement):
--  CVV is now stored ENCRYPTED at rest using the SAME AES-256-GCM vault as the
--  PAN (src/lib/card-vault.ts, key from env CARD_VAULT_KEY). Still NEVER stored
--  plaintext, never in normal reads, never in logs/audits — only the dedicated
--  reveal action decrypts it.
--
--  Channel ingestion (§Z reconciliation): the extracted card is captured
--  ENCRYPTED on the booking-revision row at the earliest trusted point
--  (persistBookingRevision), before the payload is redacted, and moved into
--  reservation_cards when the revision is imported. The revision `payload`
--  column stays redacted — raw card data never lands in it.
--  Idempotent: safe to re-run.
--
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/010_card_cvv_channel_ingest.sql
--
--  ROLLBACK:
--    ALTER TABLE guesthub.reservation_cards DROP COLUMN IF EXISTS cvv_encrypted;
--    ALTER TABLE guesthub.channel_booking_revisions
--      DROP COLUMN IF EXISTS card_pan_encrypted,
--      DROP COLUMN IF EXISTS card_cvv_encrypted,
--      DROP COLUMN IF EXISTS card_meta;
-- ============================================================

SET search_path TO "guesthub", public;

-- CVV encrypted at rest (same "v1.<iv>.<tag>.<data>" envelope as the PAN)
ALTER TABLE reservation_cards
  ADD COLUMN IF NOT EXISTS cvv_encrypted text;

-- Encrypted card staged on the inbound revision before payload redaction.
-- card_meta holds masked/non-sensitive metadata only (brand, last4, expiry,
-- is_virtual, source_channel, availability window) — NEVER a plaintext PAN/CVV.
ALTER TABLE channel_booking_revisions
  ADD COLUMN IF NOT EXISTS card_pan_encrypted text,
  ADD COLUMN IF NOT EXISTS card_cvv_encrypted text,
  ADD COLUMN IF NOT EXISTS card_meta          jsonb;
