-- ============================================================
--  011 · Commercial Settings Foundation
--  Additive + idempotent. The central commercial defaults the future Rooms /
--  Rate-Plan / Booking-Engine / Channex phases will consume. NO rooms rebuild,
--  NO rate plans, NO Channex, NO network — the local canonical model only.
--
--  Three concerns:
--    A. Extra-guest pricing defaults  → tenants.settings->'extra_guest' (jsonb,
--       a per-tenant singleton, same store as vat_rate — NOT a new table).
--       Currency stays tenants.currency; tax follows tenants.settings->vat_rate.
--    B. Cancellation policy templates → cancellation_policies + _tiers (unlimited
--       ordered fee rules per policy).
--    C. Payment policy templates      → payment_policies + _stages (ordered
--       collection stages; payment methods reference lookup_items 'payment_methods').
--
--  Authorization reuses the existing settings.edit permission (the same gate the
--  VAT setting and /settings page already enforce) — no new permission keys.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/011_commercial_settings.sql
--
--  ROLLBACK (reverse order — safe, drops only what this migration added):
--    DROP TABLE IF EXISTS guesthub.payment_policy_stages;
--    DROP TABLE IF EXISTS guesthub.payment_policies;
--    DROP TABLE IF EXISTS guesthub.cancellation_policy_tiers;
--    DROP TABLE IF EXISTS guesthub.cancellation_policies;
--    UPDATE guesthub.tenants SET settings = settings - 'extra_guest';
-- ============================================================

SET search_path TO "guesthub", public;

-- ============================================================
--  A. Extra-guest pricing defaults — jsonb singleton on tenants.settings
--     Seeded ONLY where absent (never overwrites an existing value). Amounts are
--     JSON numbers with 2-decimal money semantics; ages are integers.
--       adult_min_age is DERIVED (= child_max_age + 1), never stored.
-- ============================================================
UPDATE tenants
SET settings = jsonb_set(settings, '{extra_guest}', jsonb_build_object(
  'extra_adult',             0,
  'extra_child',             0,
  'extra_infant',            0,
  'charge_frequency',        'per_night',      -- per_night | per_stay
  'infant_max_age',          2,
  'child_max_age',           12,
  'infants_count_occupancy', false,            -- do infants count toward room occupancy
  'infants_use_included',    false,            -- do infants consume a base-price-included guest
  'tax_mode',                'inclusive',      -- inclusive | canonical (follow vat_rate)
  'rounding_mode',           'none',           -- none | unit | increment
  'rounding_increment',      1                 -- used only when rounding_mode = 'increment'
), true)
WHERE NOT settings ? 'extra_guest';

-- ============================================================
--  B. Cancellation policy templates
-- ============================================================
CREATE TABLE IF NOT EXISTS cancellation_policies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name               text NOT NULL,                 -- internal name
  public_title       text NOT NULL,                 -- guest-facing title (primary language)
  code               text NOT NULL,                 -- internal code/key
  is_active          boolean NOT NULL DEFAULT true,
  is_default         boolean NOT NULL DEFAULT false,
  internal_notes     text,
  guest_description  text,                           -- guest-facing description (primary language)
  translations       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { "<locale>": { "public_title": text, "guest_description": text } }
  distribution_scope text NOT NULL DEFAULT 'direct_and_channels'
                       CHECK (distribution_scope IN ('direct_only','direct_and_channels','internal_only')),
  timezone           text,                           -- basis tz; NULL = tenant timezone
  checkin_time_basis time,                           -- arrival/check-in time basis; NULL = tenant check-in default
  is_archived        boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by         uuid REFERENCES users(id) ON DELETE SET NULL
);

-- code unique per tenant among live (non-archived) policies
CREATE UNIQUE INDEX IF NOT EXISTS uq_cancellation_policies_code
  ON cancellation_policies(tenant_id, lower(code)) WHERE NOT is_archived;
-- at most one default per tenant among live policies
CREATE UNIQUE INDEX IF NOT EXISTS uq_cancellation_policies_default
  ON cancellation_policies(tenant_id) WHERE is_default AND NOT is_archived;
CREATE INDEX IF NOT EXISTS idx_cancellation_policies_tenant
  ON cancellation_policies(tenant_id);

CREATE TABLE IF NOT EXISTS cancellation_policy_tiers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  policy_id    uuid NOT NULL REFERENCES cancellation_policies(id) ON DELETE CASCADE,
  sort_order   integer NOT NULL DEFAULT 0,          -- deterministic ordering
  trigger_type text NOT NULL
                 CHECK (trigger_type IN ('before_checkin','no_show','after_checkin','early_departure','partial_cancellation')),
  time_unit    text CHECK (time_unit IN ('hours','days')),   -- NULL for triggers without a time range
  time_from    integer,                             -- nearer-to-arrival bound (>= 0), in time_unit
  time_to      integer,                             -- farther bound; NULL = open-ended
  fee_type     text NOT NULL
                 CHECK (fee_type IN ('free','fixed','percentage','first_night','nights','full',
                                     'percentage_remaining','higher_of','lower_of')),
  fee_amount   numeric(12,2) NOT NULL DEFAULT 0,    -- fixed / higher_of / lower_of
  fee_percent  numeric(5,2)  NOT NULL DEFAULT 0,    -- percentage / *_of / percentage_remaining
  fee_nights   integer       NOT NULL DEFAULT 0,    -- nights
  calc_base    text NOT NULL DEFAULT 'accommodation'
                 CHECK (calc_base IN ('accommodation','accommodation_plus_mandatory','total_incl_tax','unpaid_balance','remaining_nights')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_id, sort_order),
  CHECK (fee_amount >= 0 AND fee_nights >= 0),
  CHECK (fee_percent >= 0 AND fee_percent <= 100),
  CHECK (time_from IS NULL OR time_from >= 0),
  CHECK (time_to  IS NULL OR time_to  >= 0)
);
CREATE INDEX IF NOT EXISTS idx_cancellation_tiers_tenant ON cancellation_policy_tiers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cancellation_tiers_policy ON cancellation_policy_tiers(policy_id, sort_order);

-- ============================================================
--  C. Payment policy templates
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_policies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              text NOT NULL,
  public_title      text NOT NULL,
  code              text NOT NULL,
  is_active         boolean NOT NULL DEFAULT true,
  is_default        boolean NOT NULL DEFAULT false,
  internal_notes    text,
  guest_description text,
  translations      jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_archived       boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by        uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_policies_code
  ON payment_policies(tenant_id, lower(code)) WHERE NOT is_archived;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_policies_default
  ON payment_policies(tenant_id) WHERE is_default AND NOT is_archived;
CREATE INDEX IF NOT EXISTS idx_payment_policies_tenant
  ON payment_policies(tenant_id);

CREATE TABLE IF NOT EXISTS payment_policy_stages (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  policy_id              uuid NOT NULL REFERENCES payment_policies(id) ON DELETE CASCADE,
  sort_order             integer NOT NULL DEFAULT 0,
  trigger_type           text NOT NULL
                           CHECK (trigger_type IN ('booking','before_checkin','checkin','checkout')),
  trigger_offset_unit    text CHECK (trigger_offset_unit IN ('hours','days')),  -- for before_checkin
  trigger_offset_value   integer,                                               -- for before_checkin
  amount_type            text NOT NULL
                           CHECK (amount_type IN ('fixed','percentage','remaining_balance','full_balance')),
  amount_value           numeric(12,2) NOT NULL DEFAULT 0,   -- fixed
  amount_percent         numeric(5,2)  NOT NULL DEFAULT 0,   -- percentage
  methods                jsonb NOT NULL DEFAULT '[]'::jsonb, -- array of lookup_items 'payment_methods' keys
  require_card_guarantee boolean NOT NULL DEFAULT false,
  retry_behavior         text NOT NULL DEFAULT 'manual'
                           CHECK (retry_behavior IN ('manual','retry_then_cancel','retry_then_notify')),
  staff_instructions     text,
  guest_text             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_id, sort_order),
  CHECK (amount_value >= 0),
  CHECK (amount_percent >= 0 AND amount_percent <= 100),
  CHECK (trigger_offset_value IS NULL OR trigger_offset_value >= 0)
);
CREATE INDEX IF NOT EXISTS idx_payment_stages_tenant ON payment_policy_stages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payment_stages_policy ON payment_policy_stages(policy_id, sort_order);

-- ---- updated_at triggers for the new tables (idempotent; mirrors 000/009) ----
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    WHERE c.table_schema = 'guesthub' AND c.column_name = 'updated_at'
      AND c.table_name IN ('cancellation_policies','cancellation_policy_tiers','payment_policies','payment_policy_stages')
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON guesthub.%1$I;
       CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON guesthub.%1$I
         FOR EACH ROW EXECUTE FUNCTION guesthub.set_updated_at();', t);
  END LOOP;
END $$;

-- grants consistent with the schema policy (service_role only; never anon/authenticated)
GRANT ALL ON ALL TABLES IN SCHEMA "guesthub" TO service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA "guesthub" FROM anon, authenticated;
