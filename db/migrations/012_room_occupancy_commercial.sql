-- ============================================================
--  012 · Room occupancy + commercial inheritance, rate-plan policy links
--  Additive + idempotent. Extends the EXISTING rooms model (every room stays an
--  independent product; rooms are NOT collapsed into pooled room types). Adds the
--  canonical occupancy fields and the per-room extra-guest override that inherits
--  from the property commercial defaults (§A). Also links rate plans to
--  cancellation / payment policies (nullable, tenant-safe) — no rate-plan UI here.
--
--  Terminology is kept unambiguous (original brief §A):
--    default_occupancy   = תפוסת ברירת מחדל
--    included_occupancy  = אורחים הכלולים במחיר הבסיס  (value 2 → charges start at guest 3)
--    max_occupancy       = תפוסה מקסימלית  (already present)
--    max_adults/children/infants already present.
--  default_occupancy is NEVER repurposed as included_occupancy.
--
--  BACKFILL (§4): existing rooms have NO trustworthy source for included_occupancy
--  (there was no prior default_occupancy column), so included_occupancy is left
--  NULL = "requires completion". Nothing is invented; no capacity/SEO/content/
--  status/calendar data is touched. Reported counts come from check-room-db /
--  the deploy log.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/012_room_occupancy_commercial.sql
--
--  ROLLBACK:
--    ALTER TABLE guesthub.pricing_plans DROP COLUMN IF EXISTS payment_policy_id;
--    ALTER TABLE guesthub.pricing_plans DROP COLUMN IF EXISTS cancellation_policy_id;
--    ALTER TABLE guesthub.rooms
--      DROP COLUMN IF EXISTS charge_frequency_override, DROP COLUMN IF EXISTS extra_infant_override,
--      DROP COLUMN IF EXISTS extra_child_override, DROP COLUMN IF EXISTS extra_adult_override,
--      DROP COLUMN IF EXISTS extra_guest_pricing_mode, DROP COLUMN IF EXISTS included_occupancy,
--      DROP COLUMN IF EXISTS default_occupancy;
-- ============================================================

SET search_path TO "guesthub", public;

-- ---- rooms: canonical occupancy + per-room extra-guest override ----
ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS default_occupancy         integer,        -- תפוסת ברירת מחדל (nullable = unset)
  ADD COLUMN IF NOT EXISTS included_occupancy        integer,        -- אורחים הכלולים במחיר הבסיס (nullable = requires completion)
  ADD COLUMN IF NOT EXISTS extra_guest_pricing_mode  text NOT NULL DEFAULT 'inherit', -- inherit | override
  ADD COLUMN IF NOT EXISTS extra_adult_override      numeric(12,2),  -- nullable override; explicit 0 is a real override
  ADD COLUMN IF NOT EXISTS extra_child_override      numeric(12,2),
  ADD COLUMN IF NOT EXISTS extra_infant_override     numeric(12,2),
  ADD COLUMN IF NOT EXISTS charge_frequency_override text;           -- per_night | per_stay (nullable = inherit)

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_extra_guest_mode_chk;
ALTER TABLE rooms ADD  CONSTRAINT rooms_extra_guest_mode_chk
  CHECK (extra_guest_pricing_mode IN ('inherit','override'));

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_included_occupancy_chk;
ALTER TABLE rooms ADD  CONSTRAINT rooms_included_occupancy_chk
  CHECK (included_occupancy IS NULL OR (included_occupancy >= 1 AND included_occupancy <= max_occupancy));

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_default_occupancy_chk;
ALTER TABLE rooms ADD  CONSTRAINT rooms_default_occupancy_chk
  CHECK (default_occupancy IS NULL OR (default_occupancy >= 1 AND default_occupancy <= max_occupancy));

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_extra_overrides_chk;
ALTER TABLE rooms ADD  CONSTRAINT rooms_extra_overrides_chk CHECK (
  (extra_adult_override  IS NULL OR extra_adult_override  >= 0) AND
  (extra_child_override  IS NULL OR extra_child_override  >= 0) AND
  (extra_infant_override IS NULL OR extra_infant_override >= 0));

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_charge_freq_override_chk;
ALTER TABLE rooms ADD  CONSTRAINT rooms_charge_freq_override_chk
  CHECK (charge_frequency_override IS NULL OR charge_frequency_override IN ('per_night','per_stay'));

-- ---- pricing_plans: nullable, tenant-safe links to policies (§9) ----
-- Keeps the separation intact: rate-plan adjustment / cancellation policy /
-- payment policy are three distinct concerns. ON DELETE SET NULL so archiving a
-- policy never breaks a plan. Same-tenant pairing is enforced in the app layer.
ALTER TABLE pricing_plans
  ADD COLUMN IF NOT EXISTS cancellation_policy_id uuid REFERENCES cancellation_policies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_policy_id      uuid REFERENCES payment_policies(id)      ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pricing_plans_cancellation ON pricing_plans(cancellation_policy_id);
CREATE INDEX IF NOT EXISTS idx_pricing_plans_payment      ON pricing_plans(payment_policy_id);

-- No backfill writes: included_occupancy / default_occupancy stay NULL (unset) for
-- existing rooms — they require explicit completion. mode defaults to 'inherit'.

GRANT ALL ON ALL TABLES IN SCHEMA "guesthub" TO service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA "guesthub" FROM anon, authenticated;
