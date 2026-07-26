-- ============================================================
--  057 · D104 — length-of-stay discounts (הנחות אורך שהייה)
--
--  A long stay is priced night by night, so a "week rate" or "month rate" had
--  nowhere to live: the operator could only discount by hand, per reservation,
--  and the website / channel quotes never saw it at all. This table is the
--  commercial rule, read by THE central pricing engine (lib/pricing/engine.ts)
--  and therefore applied identically on every surface that asks it to price:
--  manual reservations, the rate-plan simulator, the website booking engine and
--  channel processing.
--
--  Scope resolution (deliberately shallow, so a quote is explainable):
--    pricing_plan_id = <plan>  → tiers of THAT rate plan; used whenever the
--                               quote resolves to it. A plan with tiers of its
--                               own never inherits the tenant defaults.
--    pricing_plan_id = NULL    → tenant defaults; used for base pricing
--                               (מחיר בסיס) and for any plan with no tiers.
--  Parent plans in a derivation chain do NOT donate tiers — the discount is a
--  property of the plan being sold, not of the price it derives from.
--  Tenant defaults do NOT apply to derived_percentage plans (D105): a weekly
--  or monthly rate is itself a length-of-stay price, and stacking the default
--  tier on top would double-discount. Only a tier defined explicitly ON such a
--  plan applies to it.
--
--  A stay matches the tier with the HIGHEST min_nights it satisfies (the most
--  specific one wins: 30+ beats 7+ beats 4+). max_nights is optional and closes
--  a band. The engine computes the discount on the ACCOMMODATION subtotal only
--  (the resolved nightly prices) — extra-guest charges are a separate line and
--  are never discounted.
--
--  Idempotent.
-- ============================================================
SET search_path TO "guesthub", public;

CREATE TABLE IF NOT EXISTS guesthub.length_of_stay_discounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  -- NULL = tenant default (base pricing + any plan without its own tiers)
  pricing_plan_id  uuid REFERENCES guesthub.pricing_plans(id) ON DELETE CASCADE,
  name             text NOT NULL,
  min_nights       integer NOT NULL,
  max_nights       integer,
  discount_kind    text NOT NULL,
  discount_value   numeric(12,2) NOT NULL,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'los_discounts_min_nights_check') THEN
    ALTER TABLE guesthub.length_of_stay_discounts
      ADD CONSTRAINT los_discounts_min_nights_check CHECK (min_nights >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'los_discounts_max_nights_check') THEN
    ALTER TABLE guesthub.length_of_stay_discounts
      ADD CONSTRAINT los_discounts_max_nights_check
      CHECK (max_nights IS NULL OR max_nights >= min_nights);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'los_discounts_kind_check') THEN
    ALTER TABLE guesthub.length_of_stay_discounts
      ADD CONSTRAINT los_discounts_kind_check
      CHECK (discount_kind IN ('percent', 'amount_per_night', 'amount_per_stay'));
  END IF;
  -- a percentage above 100 would invert the price; a non-positive discount is
  -- not a discount. Fail closed at the storage layer, not only in the form.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'los_discounts_value_check') THEN
    ALTER TABLE guesthub.length_of_stay_discounts
      ADD CONSTRAINT los_discounts_value_check
      CHECK (discount_value > 0 AND (discount_kind <> 'percent' OR discount_value <= 100));
  END IF;
END $$;

-- one tier per threshold, per scope (NULL plan needs its own partial index —
-- NULLs never collide in a plain unique index)
CREATE UNIQUE INDEX IF NOT EXISTS ux_los_discounts_plan_threshold
  ON guesthub.length_of_stay_discounts (tenant_id, pricing_plan_id, min_nights)
  WHERE pricing_plan_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_los_discounts_default_threshold
  ON guesthub.length_of_stay_discounts (tenant_id, min_nights)
  WHERE pricing_plan_id IS NULL;

-- the engine's hot read: every active tier of one tenant, one query per quote
CREATE INDEX IF NOT EXISTS idx_los_discounts_tenant_active
  ON guesthub.length_of_stay_discounts (tenant_id)
  WHERE is_active;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guesthub_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON guesthub.length_of_stay_discounts TO guesthub_app';
  END IF;
END $$;

-- ============================================================
--  Owner-approved default tiers (D104): 7+ nights → 15%, 30+ nights → 30%,
--  matching the existing Weekly (−15) / Monthly (−30) derived plans. Seeded as
--  TENANT DEFAULTS for every tenant, editable/deletable in the LOS panel
--  (rate-plans screen). Idempotent: the partial unique index on
--  (tenant_id, min_nights) WHERE pricing_plan_id IS NULL makes the INSERT a
--  no-op when a tier at that threshold already exists — including one the
--  operator edited or deactivated; a re-run never resurrects or overwrites.
-- ============================================================
INSERT INTO guesthub.length_of_stay_discounts
  (tenant_id, pricing_plan_id, name, min_nights, max_nights, discount_kind, discount_value)
SELECT t.id, NULL, 'הנחת שבוע (7+ לילות)', 7, NULL, 'percent', 15
FROM guesthub.tenants t
ON CONFLICT (tenant_id, min_nights) WHERE pricing_plan_id IS NULL DO NOTHING;

INSERT INTO guesthub.length_of_stay_discounts
  (tenant_id, pricing_plan_id, name, min_nights, max_nights, discount_kind, discount_value)
SELECT t.id, NULL, 'הנחת חודש (30+ לילות)', 30, NULL, 'percent', 30
FROM guesthub.tenants t
ON CONFLICT (tenant_id, min_nights) WHERE pricing_plan_id IS NULL DO NOTHING;
