-- ============================================================
--  GuestHub · Phase 3 — Tenant business settings (VAT)
--  tenants.settings jsonb — tenant-level configuration; vat_rate is
--  initialized to 18 ONLY where absent. Display-only: totals stay
--  VAT-inclusive and are never recalculated by a rate change (D41).
--  Idempotent: safe to re-run.
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/007_phase3_tenant_settings.sql
--
--  ROLLBACK:
--    ALTER TABLE guesthub.tenants DROP COLUMN IF EXISTS settings;
-- ============================================================

SET search_path TO "guesthub", public;

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;

-- initialize VAT to 18% only where no value exists yet
UPDATE tenants SET settings = jsonb_set(settings, '{vat_rate}', to_jsonb(18))
WHERE NOT settings ? 'vat_rate';
