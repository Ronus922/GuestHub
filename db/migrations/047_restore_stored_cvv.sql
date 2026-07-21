-- ============================================================
--  GuestHub · D87 — Restore stored CVV on reservation_cards (manual entry).
--
--  Business decision by the owner (Ronen), made with full knowledge of the
--  trade-off: the front desk keys card details (incl. CVV) into an EXTERNAL
--  terminal, and needs to re-open a reservation later and read the CVV back.
--  This reverses the D52 removal (migration 018) for the MANUAL-ENTRY card only.
--
--  ⚠️ COMPLIANCE CEILING: storing CVV/CVC after authorization is a PCI-DSS
--  Req. 3.2 violation. This is retained ONLY because there is no integrated PSP
--  (no authorization happens inside GuestHub) and the owner accepts the
--  liability. The value is still encrypted at rest (AES-256-GCM, CARD_VAULT_KEY)
--  — encryption limits blast radius on a DB leak; it does NOT make storage
--  compliant. If a real gateway is ever wired, DROP this column again (migration
--  018 is the template) and collect the CVV transiently per-authorization only.
--
--  Scope: reservation_cards ONLY. The channel-ingest CVV column
--  (channel_booking_revisions.card_cvv_encrypted) stays dropped — OTA guarantees
--  never carry a usable CVV and that path is not reopened.
--
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/047_restore_stored_cvv.sql
--
--  ROLLBACK (destroys every stored CVV — see migration 018):
--    ALTER TABLE guesthub.reservation_cards DROP COLUMN IF EXISTS cvv_encrypted;
-- ============================================================

SET search_path TO "guesthub", public;

ALTER TABLE reservation_cards
  ADD COLUMN IF NOT EXISTS cvv_encrypted text;

-- keep the per-project app role able to read/write it (same grants as the table)
GRANT SELECT, INSERT, UPDATE ON reservation_cards TO guesthub_app;
