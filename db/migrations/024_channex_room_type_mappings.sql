-- ============================================================
--  024 · Channex Staging — PHYSICAL ROOM → Channex Room Type mapping
--  Additive + idempotent. DECISIONS D64.
--
--  WHY A NEW TABLE (and not an extension of channel_room_type_mappings):
--    guesthub.channel_room_type_mappings (migration 005) keys on room_type_id
--    NOT NULL → guesthub.room_types. It structurally CANNOT hold a physical-room
--    mapping, and it is still the key of the room-type-scoped ARI machinery
--    (channel_dirty_ranges.room_type_id, channel_sync_state, channel_sync_jobs.
--    room_type_mapping_id, sync-step.ts). Widening it with a nullable room_id +
--    a discriminator would give one table two mutually exclusive meanings and
--    would silently break its UNIQUE (connection_id, room_type_id). No generic
--    "local entity mapping" table exists. So this is the minimal canonical table
--    for the chosen inventory unit: ONE physical room ⇄ ONE Channex Room Type.
--
--  The 3 GuestHub room_types stay DESCRIPTIVE metadata inside GuestHub. They are
--  NOT the Channex inventory mapping unit and are neither created, modified nor
--  mapped as inventory here.
--
--  The connection row is already UNIQUE (tenant_id, provider, environment), so
--  connection_id alone encodes tenant+provider+environment. Uniqueness therefore
--  reads: one active mapping per tenant+provider+environment+room_id, and one
--  external Channex Room Type UUID per local physical room.
--
--  NO Channex entity is created by this migration. NO GuestHub room, room type,
--  area, floor, capacity, rate or reservation is created or modified.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/024_channex_room_type_mappings.sql
--
--  ROLLBACK:
--    DROP TABLE IF EXISTS guesthub.channel_room_mappings;
--    (the channel_sync_jobs job_type CHECK below is a superset — harmless to keep)
-- ============================================================

SET search_path TO "guesthub", public;

-- ---- 1. canonical physical-room → Channex Room Type mapping ----
CREATE TABLE IF NOT EXISTS guesthub.channel_room_mappings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  connection_id        uuid NOT NULL REFERENCES guesthub.channel_connections(id) ON DELETE CASCADE,
  -- the external property the room type belongs to, snapshotted so a later
  -- property remap can never silently re-point existing room-type mappings
  channex_property_id  text NOT NULL,
  -- the LOCAL entity kind. Constant today; named so a future kind is a CHECK
  -- widening rather than a table redesign.
  local_entity_type    text NOT NULL DEFAULT 'physical_room',
  room_id              uuid NOT NULL REFERENCES guesthub.rooms(id) ON DELETE RESTRICT,
  -- display/audit snapshot of the room number at mapping time (never a source of truth)
  room_number          text NOT NULL,

  channex_room_type_id text,
  channex_title        text,

  --  creating               = a POST was started; the outcome is not yet known
  --  mapped                 = external room type exists and is bound to this room
  --  failed                 = a DEFINITE, room-scoped failure (422/409/…) — retryable
  --  reconciliation_required= the external result is AMBIGUOUS (timeout / local write
  --                           lost the race). NEVER blindly re-POST such a room.
  status               text NOT NULL DEFAULT 'creating'
                       CHECK (status IN ('creating','mapped','failed','reconciliation_required')),
  method               text CHECK (method IS NULL OR method IN ('created','adopted')),
  -- external health, refreshed by an explicit operator "refresh" only
  external_state       text CHECK (external_state IS NULL OR external_state IN ('ok','inaccessible')),

  -- last SAFE external snapshot (title, count_of_rooms, occ_*). Never an api-key,
  -- never headers, never a raw upstream body.
  snapshot             jsonb,
  last_verified_at     timestamptz,
  last_error_code      text,   -- safe category only ('timeout','validation',…)
  last_error           text,   -- fixed, safe Hebrew message — never an upstream body

  created_by           uuid REFERENCES guesthub.users(id) ON DELETE SET NULL,
  updated_by           uuid REFERENCES guesthub.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT channel_room_mappings_entity_chk CHECK (local_entity_type = 'physical_room'),
  -- one active mapping per tenant+provider+environment+local room
  CONSTRAINT channel_room_mappings_room_uq UNIQUE (connection_id, room_id)
);

-- one external Channex Room Type UUID may map to only ONE local physical room
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_channex_room_type
  ON guesthub.channel_room_mappings (connection_id, channex_room_type_id)
  WHERE channex_room_type_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_tenant_status
  ON guesthub.channel_room_mappings (tenant_id, status);

-- ---- 2. durable job types for the sync (additive CHECK widening) ----
-- 'sync_room_types'   = the parent operation (one per property per run)
-- 'create_room_type'  = one deduplicated durable item per physical room
ALTER TABLE guesthub.channel_sync_jobs DROP CONSTRAINT IF EXISTS channel_sync_jobs_job_type_check;
ALTER TABLE guesthub.channel_sync_jobs ADD  CONSTRAINT channel_sync_jobs_job_type_check
  CHECK (job_type IN (
    'validate_connection','full_sync','sync_availability','sync_rates',
    'sync_restrictions','sync_ari_range','pull_booking_revisions',
    'import_booking_revision','acknowledge_booking_revision',
    'reconcile_inventory','retry_failed_range',
    'sync_room_types','create_room_type'));

-- ---- 3. updated_at trigger (005 pattern) ----
DROP TRIGGER IF EXISTS trg_channel_room_mappings_updated_at ON guesthub.channel_room_mappings;
CREATE TRIGGER trg_channel_room_mappings_updated_at BEFORE UPDATE ON guesthub.channel_room_mappings
  FOR EACH ROW EXECUTE FUNCTION guesthub.set_updated_at();

-- ---- 4. grants (000 pattern) ----
GRANT ALL ON ALL TABLES IN SCHEMA "guesthub" TO service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA "guesthub" FROM anon, authenticated;
