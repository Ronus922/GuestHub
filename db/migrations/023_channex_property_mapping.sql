-- ============================================================
--  023 · Channex Staging — property mapping (existing tenant → one Channex Property)
--  Additive + idempotent. Extends the EXISTING channel_connections table
--  (created in 005, already 1:1 per tenant+provider+environment and already
--  holding channex_property_id). This IS the canonical mapping — NO parallel
--  property/mapping table is introduced.
--
--  The local property entity is ALWAYS the tenant (guesthub.tenants). Its
--  "local entity type" (=tenant) and "local entity id" (=channel_connections.
--  tenant_id) are constants of the row, so no columns store them (ponytail: a
--  column for a value that never varies is dead weight). created_by/updated_by
--  already exist on the connection.
--
--  NO local property/room/room-type/rate-plan is created or modified here.
--  NO Channex property/room-type/rate-plan/channel/webhook/ARI/booking is
--  created — this milestone only records the mapping of an EXTERNAL property
--  the operator creates or adopts from the deployed UI. DECISIONS D60.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/023_channex_property_mapping.sql
-- ============================================================

ALTER TABLE guesthub.channel_connections
  -- external Channex property title (display only; never a credential)
  ADD COLUMN IF NOT EXISTS channex_property_title      text,
  -- how the mapping was established: the operator created a fresh Channex
  -- property, or adopted one that already existed under the api-key.
  ADD COLUMN IF NOT EXISTS channex_property_method      text,
  -- last safe external snapshot from GET /properties/:id (currency, country,
  -- city, timezone, property_type, is_active, room_type_count, …). Never holds
  -- the api-key, headers or a raw upstream body.
  ADD COLUMN IF NOT EXISTS channex_property_snapshot    jsonb,
  -- last time the mapping was verified against Channex (GET succeeded)
  ADD COLUMN IF NOT EXISTS channex_property_verified_at timestamptz,
  -- safe reconciliation health: NULL (not applicable / never verified),
  -- 'ok' (accessible), 'inaccessible' (mapped id not reachable via the key).
  ADD COLUMN IF NOT EXISTS channex_reconcile_state      text;

ALTER TABLE guesthub.channel_connections
  DROP CONSTRAINT IF EXISTS channel_connections_property_method_chk;
ALTER TABLE guesthub.channel_connections
  ADD  CONSTRAINT channel_connections_property_method_chk
  CHECK (channex_property_method IS NULL
         OR channex_property_method IN ('created','adopted'));

ALTER TABLE guesthub.channel_connections
  DROP CONSTRAINT IF EXISTS channel_connections_reconcile_state_chk;
ALTER TABLE guesthub.channel_connections
  ADD  CONSTRAINT channel_connections_reconcile_state_chk
  CHECK (channex_reconcile_state IS NULL
         OR channex_reconcile_state IN ('ok','inaccessible'));
