-- ============================================================
--  034 — Reservation cancellation-policy snapshot + expected-arrival source
--  Additive + idempotent. NO existing row is modified (no backfill).
--
--  A. reservations.cancellation_policy_snapshot (jsonb) — the EFFECTIVE
--     cancellation terms captured ONCE at booking time:
--       { source: 'rate_plan' | 'property_default' | 'ota',
--         captured_at, policy?{id,code,name,public_title,guest_description,tiers[]},
--         ota?{ota_name,cancel_penalties[],policies_text} }
--     Canonical model this completes:
--       · Settings (011 cancellation_policies + _tiers) = the ONLY editable
--         template library.
--       · pricing_plans.cancellation_policy_id (012)    = the ONLY assignment —
--         a rate plan REFERENCES one template, it never redefines terms.
--       · reservations.cancellation_policy_snapshot     = an immutable COPY of
--         the terms that applied at booking, so later template edits never
--         rewrite history and reservation views never live-read Settings.
--     Precedence at creation: imported OTA terms → rate-plan template →
--     tenant default template (is_default) → NULL.
--     NULL = created before this migration or no policy existed — nothing is
--     fabricated and old reservations are deliberately NOT backfilled with
--     today's templates (that would be a false history).
--
--  B. reservations.expected_arrival_time_source — provenance of
--     expected_arrival_time (033): 'ota' (channel supplied arrival_hour) |
--     'manual' (operator edit) | NULL (unknown/legacy). Existing rows stay
--     NULL deliberately: their provenance was never recorded and is not
--     guessed.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/034_cancellation_snapshot_arrival_source.sql
--
--  ROLLBACK (safe — drops only what this migration added):
--    ALTER TABLE guesthub.reservations
--      DROP COLUMN IF EXISTS cancellation_policy_snapshot,
--      DROP COLUMN IF EXISTS expected_arrival_time_source;
-- ============================================================

SET search_path TO "guesthub", public;

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS cancellation_policy_snapshot jsonb NULL,
  ADD COLUMN IF NOT EXISTS expected_arrival_time_source text NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'reservations_arrival_time_source_chk') THEN
    ALTER TABLE guesthub.reservations
      ADD CONSTRAINT reservations_arrival_time_source_chk
      CHECK (expected_arrival_time_source IS NULL
             OR expected_arrival_time_source IN ('ota','manual'));
  END IF;
END $$;

-- grants consistent with the schema policy (000 pattern)
GRANT ALL ON ALL TABLES IN SCHEMA "guesthub" TO service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA "guesthub" FROM anon, authenticated;
