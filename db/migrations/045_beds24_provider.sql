-- ============================================================
--  045 · Beds24 provider — third channel provider (D78)
--  Additive + idempotent. Mirrors 044 (Hospitable).
--
--  Beds24 API v2 auth differs from both existing providers: the operator
--  generates an INVITE CODE in Beds24 (SETTINGS > MARKETPLACE > API), which
--  is exchanged once for a long-life REFRESH TOKEN (stored encrypted in the
--  existing api_key_ciphertext). Access tokens live 24h and cost credits to
--  mint, so the current one is cached encrypted alongside its expiry.
--
--  Mapping model: GuestHub physical room ↔ one Beds24 room (roomId) inside a
--  Beds24 property (propertyId), plus ONE local pricing plan (same price
--  doctrine as Hospitable, D77).
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/045_beds24_provider.sql
-- ============================================================

-- 1 · widen provider
ALTER TABLE guesthub.channel_connections
  DROP CONSTRAINT IF EXISTS channel_connections_provider_check;
ALTER TABLE guesthub.channel_connections
  ADD  CONSTRAINT channel_connections_provider_check
  CHECK (provider IN ('channex','hospitable','beds24'));

-- 2 · 24h access-token cache (beds24 rows only; NULL for other providers)
ALTER TABLE guesthub.channel_connections
  ADD COLUMN IF NOT EXISTS access_token_ciphertext text,
  ADD COLUMN IF NOT EXISTS access_token_expires_at timestamptz;

-- 3 · room ↔ Beds24 room mapping
CREATE TABLE IF NOT EXISTS guesthub.channel_beds24_room_mappings (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL REFERENCES guesthub.tenants(id),
  connection_id        uuid        NOT NULL REFERENCES guesthub.channel_connections(id) ON DELETE CASCADE,
  room_id              uuid        NOT NULL REFERENCES guesthub.rooms(id),
  beds24_property_id   text        NOT NULL,
  beds24_room_id       text        NOT NULL,
  -- display-only snapshots (never credentials)
  beds24_property_name text,
  beds24_room_name     text,
  local_rate_plan_id   uuid        REFERENCES guesthub.pricing_plans(id),
  currency             text,
  status               text        NOT NULL DEFAULT 'mapped'
                       CHECK (status IN ('mapped','unmapped','quarantined')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, room_id),
  UNIQUE (connection_id, beds24_property_id, beds24_room_id)
);

CREATE INDEX IF NOT EXISTS idx_beds24_room_mappings_tenant
  ON guesthub.channel_beds24_room_mappings (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON guesthub.channel_beds24_room_mappings TO guesthub_app;
GRANT ALL ON guesthub.channel_beds24_room_mappings TO service_role;
