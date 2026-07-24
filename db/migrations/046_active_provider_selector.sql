-- ============================================================
--  046 · Active-provider selector (D79)
--  Additive + idempotent. One channel provider WORKS at a time per tenant;
--  the others stay fully configured as dormant backups. The operator picks
--  the active one in /channels; default = beds24.
--
--  Enforcement is layered: this partial-unique index guarantees at most ONE
--  active provider per tenant at the DB level; every worker loader and the
--  webhook route filter on is_active_provider, so a backup provider can
--  neither push ARI nor import bookings while dormant.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/046_active_provider_selector.sql
-- ============================================================

ALTER TABLE guesthub.channel_connections
  ADD COLUMN IF NOT EXISTS is_active_provider boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_provider_per_tenant
  ON guesthub.channel_connections (tenant_id)
  WHERE is_active_provider;

-- default: beds24 is the working provider wherever it exists
UPDATE guesthub.channel_connections c
SET is_active_provider = true
WHERE c.provider = 'beds24'
  AND NOT EXISTS (
    SELECT 1 FROM guesthub.channel_connections x
    WHERE x.tenant_id = c.tenant_id AND x.is_active_provider);
