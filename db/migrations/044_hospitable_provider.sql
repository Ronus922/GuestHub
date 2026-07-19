-- ============================================================
--  044 · Hospitable provider — second channel provider alongside Channex
--  Additive + idempotent. DECISIONS D77.
--
--  1. Widens channel_connections.provider CHECK to allow 'hospitable'.
--     Hospitable has NO staging environment — hospitable rows are always
--     environment='production' (enforced in the admin action, not here,
--     because the existing environment CHECK already allows both values
--     and Channex still uses staging).
--  2. api_key_expires_at — Hospitable PATs are JWTs that expire after one
--     year; the exp claim is decoded at save time so the UI can warn the
--     operator ≥30 days before expiry. NULL for Channex rows (their keys
--     do not expire).
--  3. channel_hospitable_property_mappings — Hospitable has no room-type/
--     rate-plan axes: one GuestHub physical room maps to one Hospitable
--     property UUID, plus ONE designated local pricing plan whose
--     base-occupancy rate is the pushed price. channex_property_id on the
--     connection stays NULL for hospitable rows.
--
--  Inbound reuses channel_booking_revisions unchanged: Hospitable has no
--  revisions feed, so provider_revision_id gets a synthetic content-hash id
--  "{reservation_uuid}:{sha256(payload)[:16]}" — the existing
--  UNIQUE (connection_id, provider_revision_id) gives idempotency for free.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/044_hospitable_provider.sql
-- ============================================================

-- 1 · widen provider (constraint name verified against live DB)
ALTER TABLE guesthub.channel_connections
  DROP CONSTRAINT IF EXISTS channel_connections_provider_check;
ALTER TABLE guesthub.channel_connections
  ADD  CONSTRAINT channel_connections_provider_check
  CHECK (provider IN ('channex','hospitable'));

-- 2 · PAT expiry surfacing
ALTER TABLE guesthub.channel_connections
  ADD COLUMN IF NOT EXISTS api_key_expires_at timestamptz;

-- 3 · room ↔ Hospitable property mapping
CREATE TABLE IF NOT EXISTS guesthub.channel_hospitable_property_mappings (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid        NOT NULL REFERENCES guesthub.tenants(id),
  connection_id           uuid        NOT NULL REFERENCES guesthub.channel_connections(id) ON DELETE CASCADE,
  room_id                 uuid        NOT NULL REFERENCES guesthub.rooms(id),
  -- Hospitable property UUID (external id; never a credential)
  hospitable_property_id  text        NOT NULL,
  -- the ONE local plan whose base-occupancy rate is pushed as the price
  local_rate_plan_id      uuid        REFERENCES guesthub.pricing_plans(id),
  -- from the property payload; must match the plan currency before mapping
  currency                text,
  -- Hospitable flag: calendar pushes are rejected upstream while true
  calendar_restricted     boolean     NOT NULL DEFAULT false,
  status                  text        NOT NULL DEFAULT 'mapped'
                          CHECK (status IN ('mapped','unmapped','quarantined')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, room_id),
  UNIQUE (connection_id, hospitable_property_id)
);

CREATE INDEX IF NOT EXISTS idx_hospitable_property_mappings_tenant
  ON guesthub.channel_hospitable_property_mappings (tenant_id);

-- display-only snapshot of the property name at map time (never a credential;
-- refreshed on every re-map) — lets the mapping table read like the Channex
-- one without an HTTP call per page load
ALTER TABLE guesthub.channel_hospitable_property_mappings
  ADD COLUMN IF NOT EXISTS hospitable_property_name text;

-- app + service roles (guesthub_app is the per-project app role; new tables do
-- not inherit its grants automatically)
GRANT SELECT, INSERT, UPDATE, DELETE
  ON guesthub.channel_hospitable_property_mappings TO guesthub_app;
GRANT ALL ON guesthub.channel_hospitable_property_mappings TO service_role;
