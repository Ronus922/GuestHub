-- ============================================================
--  025 · Channex Staging — (PHYSICAL ROOM × LOCAL RATE PLAN) → Channex Rate Plan
--  Additive + idempotent. DECISIONS D65.
--
--  MODEL: the local GuestHub Rate Plan (guesthub.pricing_plans, tenant-scoped,
--  e.g. "ללא דמי ביטול") is defined ONCE and is never duplicated locally. Each
--  Channex Rate Plan belongs to exactly one Channex Room Type, and D64 fixed the
--  inventory unit as the individual physical room — so one local Rate Plan fans
--  out to one external Rate Plan PER mapped physical room:
--      1 local Rate Plan × 13 mapped rooms = 13 Channex Rate Plans.
--
--  WHY A NEW TABLE (and not the 005 channel_rate_plan_mappings):
--    guesthub.channel_rate_plan_mappings keys on room_type_id NOT NULL
--    (descriptive category) + a free-text local_plan_code. It structurally
--    CANNOT identify a physical-room × pricing_plans-row combination, and it is
--    referenced by channel_sync_errors / the room-type-scoped ARI machinery.
--    It stays untouched (0 rows). This is the minimal canonical table for the
--    real mapping unit: (physical room, local rate plan) ⇄ one Channex Rate Plan.
--
--  The connection row is UNIQUE (tenant_id, provider, environment), so
--  connection_id encodes tenant+provider+environment. Uniqueness therefore reads:
--  one active mapping per tenant+provider+environment+room+rate-plan, and one
--  external Channex Rate Plan UUID per ONE local combination.
--
--  NO Channex entity is created by this migration. NO GuestHub room, rate plan,
--  price, policy or reservation is created or modified.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/025_channex_rate_plan_mappings.sql
--
--  ROLLBACK:
--    DROP TABLE IF EXISTS guesthub.channel_room_rate_mappings;
--    (the channel_sync_jobs job_type CHECK below is a superset — harmless to keep)
-- ============================================================

SET search_path TO "guesthub", public;

-- ---- 1. canonical (room × local rate plan) → Channex Rate Plan mapping ----
CREATE TABLE IF NOT EXISTS guesthub.channel_room_rate_mappings (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  connection_id           uuid NOT NULL REFERENCES guesthub.channel_connections(id) ON DELETE CASCADE,
  -- external property snapshot, so a later property remap can never silently
  -- re-point existing rate-plan mappings
  channex_property_id     text NOT NULL,

  local_rate_plan_id      uuid NOT NULL REFERENCES guesthub.pricing_plans(id) ON DELETE RESTRICT,
  room_id                 uuid NOT NULL REFERENCES guesthub.rooms(id) ON DELETE RESTRICT,
  -- the D64 room mapping this rate plan hangs off (its Channex Room Type)
  channel_room_mapping_id uuid REFERENCES guesthub.channel_room_mappings(id) ON DELETE RESTRICT,
  -- display/audit snapshots at mapping time (never a source of truth)
  room_number             text NOT NULL,
  channex_room_type_id    text,

  channex_rate_plan_id    text,
  channex_title           text,
  sell_mode               text CHECK (sell_mode IS NULL OR sell_mode IN ('per_room','per_person')),
  rate_mode               text CHECK (rate_mode IS NULL OR rate_mode IN ('manual','derived','auto','cascade')),
  currency                text NOT NULL DEFAULT 'ILS',

  --  creating                = a POST was started; the outcome is not yet known
  --  mapped                  = external rate plan exists and is bound to this combination
  --  failed                  = a DEFINITE, combination-scoped failure (422/409/…) — retryable
  --  reconciliation_required = the external result is AMBIGUOUS (timeout / local write
  --                            lost the race). NEVER blindly re-POST such a combination.
  status                  text NOT NULL DEFAULT 'creating'
                          CHECK (status IN ('creating','mapped','failed','reconciliation_required')),
  method                  text CHECK (method IS NULL OR method IN ('created','adopted')),
  external_state          text CHECK (external_state IS NULL OR external_state IN ('ok','inaccessible')),

  -- last SAFE external snapshot (title, sell_mode, options, stop-sell state).
  -- Never an api-key, never headers, never a raw upstream body.
  snapshot                jsonb,
  last_verified_at        timestamptz,
  last_error_code         text,   -- safe category only ('timeout','validation',…)
  last_error              text,   -- fixed, safe Hebrew message — never an upstream body

  created_by              uuid REFERENCES guesthub.users(id) ON DELETE SET NULL,
  updated_by              uuid REFERENCES guesthub.users(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- one active mapping per tenant+provider+environment+room+local rate plan
  CONSTRAINT channel_room_rate_mappings_combo_uq UNIQUE (connection_id, room_id, local_rate_plan_id)
);

-- one external Channex Rate Plan UUID may map to only ONE local combination
CREATE UNIQUE INDEX IF NOT EXISTS uq_crrm_channex_rate_plan
  ON guesthub.channel_room_rate_mappings (connection_id, channex_rate_plan_id)
  WHERE channex_rate_plan_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crrm_tenant_status
  ON guesthub.channel_room_rate_mappings (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_crrm_plan
  ON guesthub.channel_room_rate_mappings (local_rate_plan_id);

-- ---- 2. durable job types for the sync (additive CHECK widening) ----
-- 'sync_rate_plans'  = the parent operation (one per property per run)
-- 'create_rate_plan' = one deduplicated durable item per (room × rate plan)
ALTER TABLE guesthub.channel_sync_jobs DROP CONSTRAINT IF EXISTS channel_sync_jobs_job_type_check;
ALTER TABLE guesthub.channel_sync_jobs ADD  CONSTRAINT channel_sync_jobs_job_type_check
  CHECK (job_type IN (
    'validate_connection','full_sync','sync_availability','sync_rates',
    'sync_restrictions','sync_ari_range','pull_booking_revisions',
    'import_booking_revision','acknowledge_booking_revision',
    'reconcile_inventory','retry_failed_range',
    'sync_room_types','create_room_type',
    'sync_rate_plans','create_rate_plan'));

-- ---- 3. updated_at trigger (005 pattern) ----
DROP TRIGGER IF EXISTS trg_channel_room_rate_mappings_updated_at ON guesthub.channel_room_rate_mappings;
CREATE TRIGGER trg_channel_room_rate_mappings_updated_at BEFORE UPDATE ON guesthub.channel_room_rate_mappings
  FOR EACH ROW EXECUTE FUNCTION guesthub.set_updated_at();

-- ---- 4. grants (000 pattern) ----
GRANT ALL ON ALL TABLES IN SCHEMA "guesthub" TO service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA "guesthub" FROM anon, authenticated;
