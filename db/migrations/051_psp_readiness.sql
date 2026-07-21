-- ============================================================
--  GuestHub · PSP readiness (שלב 1) — open reservation_payment_methods to
--  Israeli PSPs ahead of direct-API clearing (Cardcom / Tranzila).
--
--  Owner decision (Ronen): NO Stripe. The table was born with a
--  CHECK (provider IN ('stripe')) for the dormant Channex-Stripe tokenization
--  experiment (030); the table is empty, so 'stripe' is dropped outright —
--  the legacy Channex tokenization admin flow will now be rejected by the DB,
--  which is the intended fail-closed behavior.
--
--  Also adds token lifecycle status: without it an expired/PSP-revoked token
--  is indistinguishable from a live one at charge time (PAYMENTS_AUDIT H-5).
--
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/051_psp_readiness.sql
--
--  ROLLBACK:
--    ALTER TABLE guesthub.reservation_payment_methods
--      DROP CONSTRAINT IF EXISTS reservation_payment_methods_provider_check;
--    ALTER TABLE guesthub.reservation_payment_methods
--      ADD CONSTRAINT reservation_payment_methods_provider_check
--      CHECK (provider IN ('stripe'));
--    ALTER TABLE guesthub.reservation_payment_methods
--      DROP COLUMN IF EXISTS status;
-- ============================================================

SET search_path TO "guesthub", public;

-- ---- 1. providers: stripe-only → cardcom / tranzila ----
ALTER TABLE reservation_payment_methods
  DROP CONSTRAINT IF EXISTS reservation_payment_methods_provider_check;
ALTER TABLE reservation_payment_methods
  ADD CONSTRAINT reservation_payment_methods_provider_check
  CHECK (provider IN ('cardcom', 'tranzila'));

-- ---- 2. token lifecycle ----
ALTER TABLE reservation_payment_methods
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'expired', 'revoked'));

-- keep the per-project app role able to read/write (same pattern as 047)
GRANT SELECT, INSERT, UPDATE ON reservation_payment_methods TO guesthub_app;
