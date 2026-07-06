-- ============================================================
--  016 · Rate Plans + central pricing engine data model
--  Additive + idempotent. Extends the EXISTING Phase-4A commercial model —
--  no parallel tables, no second nightly-price store, no second VAT model.
--
--  The canonical model after this migration:
--    · guesthub.pricing_plans becomes DUAL-SCOPE:
--        - SU-scoped base plans (sellable_unit_id NOT NULL, is_base) — the
--          Phase-4A base ARI carrier the Rates grid writes. UNCHANGED rows.
--        - Tenant-level Rate Plans (sellable_unit_id IS NULL) — the commercial
--          sale terms this phase manages: base / derived_percentage /
--          derived_fixed / independent, parent chain, validity, booking
--          window, DOW, visibility, refundability, policy links (012).
--    · guesthub.pricing_plan_units — assignment of a tenant-level Rate Plan to
--      a Sellable Unit (the sell-side face of a physical room; 1:1 today).
--      An assignment NEVER creates inventory — availability stays derived from
--      reservations/closures/room status via sellable_unit_inventory().
--    · guesthub.pricing_plan_rates — UNTOUCHED. It remains the ONLY base-layer
--      nightly commercial store (the Rates grid writer keeps its exact
--      ON CONFLICT (pricing_plan_id, date) path; dev and prod share this DB, so
--      the base table's contract cannot change out from under the running app).
--    · guesthub.pricing_plan_unit_rates — the spec-§9 normalized overlay for
--      tenant-level plans: exact (plan, unit, date) rows holding independent
--      nightly prices / exact-date overrides + per-date restrictions. Sparse by
--      design; an override may make a plan unavailable but NEVER creates
--      inventory.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/016_rate_plans.sql
--
--  ROLLBACK (reverse order — drops only what this migration added):
--    DROP TRIGGER IF EXISTS trg_pricing_plans_parent_guard ON guesthub.pricing_plans;
--    DROP FUNCTION IF EXISTS guesthub.pricing_plan_parent_guard();
--    DROP TABLE IF EXISTS guesthub.pricing_plan_unit_rates;
--    DROP TABLE IF EXISTS guesthub.pricing_plan_units;
--    ALTER TABLE guesthub.pricing_plans
--      DROP COLUMN IF EXISTS updated_by, DROP COLUMN IF EXISTS created_by,
--      DROP COLUMN IF EXISTS is_archived, DROP COLUMN IF EXISTS sort_order,
--      DROP COLUMN IF EXISTS is_visible_channels, DROP COLUMN IF EXISTS is_visible_website,
--      DROP COLUMN IF EXISTS default_closed_to_departure, DROP COLUMN IF EXISTS default_closed_to_arrival,
--      DROP COLUMN IF EXISTS default_max_stay, DROP COLUMN IF EXISTS default_min_stay,
--      DROP COLUMN IF EXISTS allowed_checkin_days,
--      DROP COLUMN IF EXISTS max_advance_days, DROP COLUMN IF EXISTS min_advance_days,
--      DROP COLUMN IF EXISTS valid_until, DROP COLUMN IF EXISTS valid_from,
--      DROP COLUMN IF EXISTS meal_plan, DROP COLUMN IF EXISTS is_refundable,
--      DROP COLUMN IF EXISTS public_description, DROP COLUMN IF EXISTS description,
--      DROP COLUMN IF EXISTS public_name, DROP COLUMN IF EXISTS adjustment_value,
--      DROP COLUMN IF EXISTS parent_plan_id, DROP COLUMN IF EXISTS plan_kind;
--    ALTER TABLE guesthub.pricing_plans ALTER COLUMN sellable_unit_id SET NOT NULL;
--    DELETE FROM guesthub.permissions WHERE key IN
--      ('rate_plans.view','rate_plans.create','rate_plans.edit','rate_plans.delete','pricing.simulate');
-- ============================================================

SET search_path TO "guesthub", public;

-- ---- 1. pricing_plans → dual-scope Rate Plan entity ----
ALTER TABLE pricing_plans ALTER COLUMN sellable_unit_id DROP NOT NULL;

ALTER TABLE pricing_plans
  ADD COLUMN IF NOT EXISTS plan_kind          text NOT NULL DEFAULT 'base',
  ADD COLUMN IF NOT EXISTS parent_plan_id     uuid REFERENCES pricing_plans(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS adjustment_value   numeric(12,2),  -- derived_percentage: ±% ; derived_fixed: ±amount/night
  ADD COLUMN IF NOT EXISTS public_name        text,           -- guest-facing; NULL → name
  ADD COLUMN IF NOT EXISTS description        text,           -- internal
  ADD COLUMN IF NOT EXISTS public_description text,
  ADD COLUMN IF NOT EXISTS is_refundable      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS meal_plan          text,           -- included meal/service label; NULL = none
  ADD COLUMN IF NOT EXISTS valid_from         date,           -- stay-date validity; NULL = unbounded
  ADD COLUMN IF NOT EXISTS valid_until        date,
  ADD COLUMN IF NOT EXISTS min_advance_days   integer,        -- booking window (property-local days before arrival); 0 = same-day allowed
  ADD COLUMN IF NOT EXISTS max_advance_days   integer,
  ADD COLUMN IF NOT EXISTS allowed_checkin_days smallint[],   -- arrival DOW 0=Sunday…6; NULL = all days
  ADD COLUMN IF NOT EXISTS default_min_stay   integer,        -- plan-level defaults; per-(plan,unit,date) rows override
  ADD COLUMN IF NOT EXISTS default_max_stay   integer,
  ADD COLUMN IF NOT EXISTS default_closed_to_arrival   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_closed_to_departure boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_visible_website  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_visible_channels boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sort_order         integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_archived        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by         uuid REFERENCES users(id) ON DELETE SET NULL;

-- existing Phase-4A rows are all is_base → plan_kind 'base' (the column default);
-- assert-style backfill for any historical row that predates the default.
UPDATE pricing_plans SET plan_kind = 'base' WHERE is_base AND plan_kind <> 'base';

ALTER TABLE pricing_plans DROP CONSTRAINT IF EXISTS pricing_plans_kind_chk;
ALTER TABLE pricing_plans ADD CONSTRAINT pricing_plans_kind_chk
  CHECK (plan_kind IN ('base','derived_percentage','derived_fixed','independent'));

-- kind ↔ derivation-field consistency (a fixed adjustment is NOT a fixed final price)
ALTER TABLE pricing_plans DROP CONSTRAINT IF EXISTS pricing_plans_derivation_chk;
ALTER TABLE pricing_plans ADD CONSTRAINT pricing_plans_derivation_chk CHECK (
  CASE plan_kind
    WHEN 'derived_percentage' THEN parent_plan_id IS NOT NULL AND adjustment_value IS NOT NULL
                                   AND adjustment_value > -100
    WHEN 'derived_fixed'      THEN parent_plan_id IS NOT NULL AND adjustment_value IS NOT NULL
    ELSE parent_plan_id IS NULL AND adjustment_value IS NULL
  END);

-- SU-scoped rows stay the Phase-4A base ARI layer — never derived/independent
ALTER TABLE pricing_plans DROP CONSTRAINT IF EXISTS pricing_plans_scope_chk;
ALTER TABLE pricing_plans ADD CONSTRAINT pricing_plans_scope_chk
  CHECK (sellable_unit_id IS NULL OR plan_kind = 'base');

ALTER TABLE pricing_plans DROP CONSTRAINT IF EXISTS pricing_plans_self_parent_chk;
ALTER TABLE pricing_plans ADD CONSTRAINT pricing_plans_self_parent_chk
  CHECK (parent_plan_id IS NULL OR parent_plan_id <> id);

ALTER TABLE pricing_plans DROP CONSTRAINT IF EXISTS pricing_plans_validity_chk;
ALTER TABLE pricing_plans ADD CONSTRAINT pricing_plans_validity_chk
  CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until >= valid_from);

ALTER TABLE pricing_plans DROP CONSTRAINT IF EXISTS pricing_plans_advance_chk;
ALTER TABLE pricing_plans ADD CONSTRAINT pricing_plans_advance_chk CHECK (
  (min_advance_days IS NULL OR min_advance_days >= 0) AND
  (max_advance_days IS NULL OR max_advance_days >= 0) AND
  (min_advance_days IS NULL OR max_advance_days IS NULL OR max_advance_days >= min_advance_days));

ALTER TABLE pricing_plans DROP CONSTRAINT IF EXISTS pricing_plans_dow_chk;
ALTER TABLE pricing_plans ADD CONSTRAINT pricing_plans_dow_chk
  CHECK (allowed_checkin_days IS NULL OR
         (cardinality(allowed_checkin_days) >= 1 AND
          allowed_checkin_days <@ ARRAY[0,1,2,3,4,5,6]::smallint[]));

ALTER TABLE pricing_plans DROP CONSTRAINT IF EXISTS pricing_plans_stay_chk;
ALTER TABLE pricing_plans ADD CONSTRAINT pricing_plans_stay_chk CHECK (
  (default_min_stay IS NULL OR default_min_stay >= 1) AND
  (default_max_stay IS NULL OR default_max_stay >= 1) AND
  (default_min_stay IS NULL OR default_max_stay IS NULL OR default_max_stay >= default_min_stay));

-- tenant-level plan code unique per tenant among live plans (SU-scoped rows keep
-- their existing UNIQUE(sellable_unit_id, code))
CREATE UNIQUE INDEX IF NOT EXISTS uq_pricing_plans_tenant_code
  ON pricing_plans(tenant_id, lower(code))
  WHERE sellable_unit_id IS NULL AND NOT is_archived;
CREATE INDEX IF NOT EXISTS idx_pricing_plans_parent ON pricing_plans(parent_plan_id);

-- ---- 2. parent guard: same tenant, tenant-level parent, no cycles, bounded chain ----
-- DB-level enforcement (the server actions validate first for Hebrew errors; this
-- is the safety net the spec requires "at database level where practical").
CREATE OR REPLACE FUNCTION guesthub.pricing_plan_parent_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cur uuid;
  seen uuid[] := ARRAY[NEW.id];
  depth int := 0;
  parent_tenant uuid;
  parent_scope uuid;
BEGIN
  IF NEW.parent_plan_id IS NULL THEN RETURN NEW; END IF;

  SELECT tenant_id, sellable_unit_id INTO parent_tenant, parent_scope
  FROM guesthub.pricing_plans WHERE id = NEW.parent_plan_id;
  IF parent_tenant IS NULL THEN
    RAISE EXCEPTION 'RATE_PLAN_PARENT_NOT_FOUND';
  END IF;
  IF parent_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'MIXED_TENANT_DATA';
  END IF;
  IF parent_scope IS NOT NULL THEN
    RAISE EXCEPTION 'RATE_PLAN_PARENT_NOT_TENANT_LEVEL';
  END IF;

  cur := NEW.parent_plan_id;
  WHILE cur IS NOT NULL LOOP
    IF cur = ANY(seen) THEN
      RAISE EXCEPTION 'RATE_PLAN_CYCLE';
    END IF;
    seen := seen || cur;
    depth := depth + 1;
    IF depth > 5 THEN
      RAISE EXCEPTION 'RATE_PLAN_CHAIN_TOO_DEEP';
    END IF;
    SELECT parent_plan_id INTO cur FROM guesthub.pricing_plans WHERE id = cur;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pricing_plans_parent_guard ON guesthub.pricing_plans;
CREATE TRIGGER trg_pricing_plans_parent_guard
  BEFORE INSERT OR UPDATE OF parent_plan_id ON guesthub.pricing_plans
  FOR EACH ROW EXECUTE FUNCTION guesthub.pricing_plan_parent_guard();

-- ---- 3. pricing_plan_units — Rate Plan ↔ Sellable Unit assignment ----
CREATE TABLE IF NOT EXISTS pricing_plan_units (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pricing_plan_id  uuid NOT NULL REFERENCES pricing_plans(id) ON DELETE CASCADE,
  sellable_unit_id uuid NOT NULL REFERENCES sellable_units(id) ON DELETE CASCADE,
  is_active        boolean NOT NULL DEFAULT true,
  adjustment_value numeric(12,2),  -- per-unit override of the plan adjustment (derived kinds only)
  valid_from       date,
  valid_until      date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (pricing_plan_id, sellable_unit_id),
  CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until >= valid_from)
);
CREATE INDEX IF NOT EXISTS idx_ppu_tenant ON pricing_plan_units(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ppu_unit   ON pricing_plan_units(sellable_unit_id) WHERE is_active;

-- ---- 4. pricing_plan_unit_rates — exact (plan, unit, date) overlay (spec §9) ----
-- Independent-plan nightly prices and exact-date overrides for any tenant-level
-- plan. Only `price` carries a pricing mode here (no per-date adjustment
-- columns), so a row can never hold contradictory pricing modes. Sparse rows
-- only — never materialize a date range.
CREATE TABLE IF NOT EXISTS pricing_plan_unit_rates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pricing_plan_id     uuid NOT NULL REFERENCES pricing_plans(id) ON DELETE CASCADE,
  sellable_unit_id    uuid NOT NULL REFERENCES sellable_units(id) ON DELETE CASCADE,
  date                date NOT NULL,
  price               numeric(12,2) CHECK (price IS NULL OR price >= 0),
  min_stay_through    integer CHECK (min_stay_through IS NULL OR min_stay_through >= 1),
  min_stay_arrival    integer CHECK (min_stay_arrival IS NULL OR min_stay_arrival >= 1),
  max_stay            integer CHECK (max_stay IS NULL OR max_stay >= 1),
  closed_to_arrival   boolean NOT NULL DEFAULT false,
  closed_to_departure boolean NOT NULL DEFAULT false,
  stop_sell           boolean NOT NULL DEFAULT false,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (pricing_plan_id, sellable_unit_id, date)
);
CREATE INDEX IF NOT EXISTS idx_ppur_tenant_date ON pricing_plan_unit_rates(tenant_id, date);
CREATE INDEX IF NOT EXISTS idx_ppur_unit_date   ON pricing_plan_unit_rates(sellable_unit_id, date);

-- ---- 5. permissions — same permission system, new granular keys ----
INSERT INTO permissions (key, description, category) VALUES
  ('rate_plans.view',   'צפייה בתוכניות תמחור',            'rates'),
  ('rate_plans.create', 'יצירת תוכניות תמחור',             'rates'),
  ('rate_plans.edit',   'עריכת תוכניות תמחור',             'rates'),
  ('rate_plans.delete', 'ארכוב ומחיקת תוכניות תמחור',      'rates'),
  ('pricing.simulate',  'שימוש בסימולטור התמחור',          'rates')
ON CONFLICT (key) DO NOTHING;

-- manager inherits the full rate-plans capability set; receptionist views only.
-- (admin / super_admin bypass granular checks — see requirePermission.)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.key IN
  ('rate_plans.view','rate_plans.create','rate_plans.edit','rate_plans.delete','pricing.simulate')
WHERE r.key = 'manager'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.key = 'rate_plans.view'
WHERE r.key = 'receptionist'
ON CONFLICT DO NOTHING;

-- ---- 6. updated_at trigger for the new table (000/009 pattern) ----
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    WHERE c.table_schema = 'guesthub' AND c.column_name = 'updated_at'
      AND c.table_name IN ('pricing_plan_units')
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON guesthub.%1$I;
       CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON guesthub.%1$I
         FOR EACH ROW EXECUTE FUNCTION guesthub.set_updated_at();', t);
  END LOOP;
END $$;

-- ---- 7. grants (000 pattern) ----
GRANT ALL ON ALL TABLES IN SCHEMA "guesthub" TO service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA "guesthub" FROM anon, authenticated;
