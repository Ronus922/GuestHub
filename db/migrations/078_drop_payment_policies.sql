-- ============================================================
--  078 — payment policies are removed
--
--  The payment-policy templates (011 §C) were superseded by direct
--  payment-method management on lookup_items category='payment_methods'
--  (PR #173): the tenant used policies as an ad-hoc method list, and the
--  real collection logic never consumed them. Measured before removal:
--  zero pricing_plans reference a policy, and every stage's `methods`
--  array is empty — nothing live depends on these rows.
--
--  Cancellation policies are a separate structure (011 §B) and stay.
--  audit_logs rows with entity_type='payment_policy' remain as history
--  (no FK).
--
--  Dropping pricing_plans.payment_policy_id also drops its FK and
--  idx_pricing_plans_payment automatically.
--
--  Idempotent. Safe to replay.
-- ============================================================
SET search_path TO "guesthub", public;

ALTER TABLE guesthub.pricing_plans DROP COLUMN IF EXISTS payment_policy_id;
DROP TABLE IF EXISTS guesthub.payment_policy_stages;
DROP TABLE IF EXISTS guesthub.payment_policies;
