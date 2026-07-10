-- ============================================================
--  027 · Channex ARI — re-key the dirty-range outbox to the REAL mapping unit
--  Additive + idempotent. DECISIONS D68.
--
--  WHY. The Phase-3 outbox (migration 005) keys every dirty range, watermark and
--  mapping on room_type_id → guesthub.room_types, i.e. the THREE descriptive
--  categories. D64 fixed the Channex inventory unit as the individual PHYSICAL
--  ROOM (13 rooms ⇄ 13 Channex Room Types, count_of_rooms=1) and D65 fixed the
--  commercial unit as (physical room × local Rate Plan) ⇄ one Channex Rate Plan
--  (52 mappings). The room-type-keyed outbox therefore addresses an entity that
--  is not mapped to anything: guesthub.channel_room_type_mappings and
--  guesthub.channel_rate_plan_mappings both hold 0 rows and always will.
--
--  Consequently the room-type-scoped ARI machinery could never emit a single
--  value (src/lib/channel/sync-step.ts resolved no mapping, every time). It is
--  deleted in the same change together with its pooled-availability / lead-SU
--  price projection, which contradicts the one-room-one-room-type model. This
--  migration re-points the outbox at the room, and adds the rate-plan dimension
--  so a Rate Plan edit marks only its own combinations dirty.
--
--  SAFE TO RUN. Verified on production (2026-07-10) BEFORE this migration:
--      channel_dirty_ranges  0 rows
--      channel_sync_state    0 rows
--      channel_room_type_mappings / channel_rate_plan_mappings  0 rows
--  The connection is state='ready', outbound_sync_enabled=false, so markAriDirty
--  has always been a no-op and no backlog can exist. Dropping room_type_id and
--  channel_sync_state therefore destroys no data.
--
--  NO Channex entity is created, updated or contacted. NO room, rate plan,
--  price, policy or reservation is created or modified. No ARI is sent.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/027_channex_ari_room_dimension.sql
--
--  ROLLBACK (schema only):
--    ALTER TABLE guesthub.channel_dirty_ranges
--      DROP COLUMN IF EXISTS room_id, DROP COLUMN IF EXISTS local_rate_plan_id,
--      DROP COLUMN IF EXISTS attempts, DROP COLUMN IF EXISTS next_attempt_at,
--      DROP COLUMN IF EXISTS last_error_code,
--      ADD COLUMN IF NOT EXISTS room_type_id uuid
--        REFERENCES guesthub.room_types(id) ON DELETE CASCADE;
--    DROP TABLE IF EXISTS guesthub.channel_worker_state;
--    (channel_sync_state is recreated by re-running migration 005)
-- ============================================================

SET search_path TO "guesthub", public;

-- ---- 0. fail closed: never re-key an outbox that holds real work ----
-- A pending/queued row keyed on room_type_id cannot be migrated (no room can be
-- derived from a category). If one exists the deployment is not the state this
-- migration was written for — stop rather than silently drop outbound work.
DO $$
DECLARE n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'guesthub' AND table_name = 'channel_dirty_ranges'
               AND column_name = 'room_type_id') THEN
    SELECT count(*) INTO n FROM guesthub.channel_dirty_ranges WHERE status <> 'synced';
    IF n > 0 THEN
      RAISE EXCEPTION
        'REFUSED: % unsynced room-type-keyed dirty range(s) exist; drain or triage before re-keying', n;
    END IF;
  END IF;
END $$;

-- ---- 1. the outbox addresses a physical room, optionally scoped to one plan ----
ALTER TABLE guesthub.channel_dirty_ranges
  ADD COLUMN IF NOT EXISTS room_id uuid REFERENCES guesthub.rooms(id) ON DELETE CASCADE,
  -- NULL = every channel-visible Rate Plan of this room (a base-ARI write from
  -- Bulk Update feeds every derived plan). A plan-scoped edit names its plan.
  ADD COLUMN IF NOT EXISTS local_rate_plan_id uuid
    REFERENCES guesthub.pricing_plans(id) ON DELETE CASCADE,
  -- bounded retry with backoff, per range (§U); a range is never lost on failure
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_error_code text;

-- retire the category dimension (0 rows, guarded above)
DROP INDEX IF EXISTS guesthub.idx_dirty_pending;
ALTER TABLE guesthub.channel_dirty_ranges DROP COLUMN IF EXISTS room_type_id;
ALTER TABLE guesthub.channel_dirty_ranges ALTER COLUMN room_id SET NOT NULL;

-- 'failed' = attempts exhausted; kept for operator review, never silently dropped
ALTER TABLE guesthub.channel_dirty_ranges DROP CONSTRAINT IF EXISTS channel_dirty_ranges_status_check;
ALTER TABLE guesthub.channel_dirty_ranges ADD  CONSTRAINT channel_dirty_ranges_status_check
  CHECK (status IN ('pending','queued','synced','failed'));

-- availability is plan-independent and must never carry a plan scope
ALTER TABLE guesthub.channel_dirty_ranges DROP CONSTRAINT IF EXISTS channel_dirty_ranges_plan_scope_chk;
ALTER TABLE guesthub.channel_dirty_ranges ADD  CONSTRAINT channel_dirty_ranges_plan_scope_chk
  CHECK (kind <> 'availability' OR local_rate_plan_id IS NULL);

CREATE INDEX IF NOT EXISTS idx_dirty_pending
  ON guesthub.channel_dirty_ranges (connection_id, room_id, kind, date_from)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_dirty_runnable
  ON guesthub.channel_dirty_ranges (connection_id, next_attempt_at)
  WHERE status = 'pending';

-- ---- 2. the monotonic watermark is obsolete ----
-- channel_sync_state existed because sync-step.ts could replay a stored payload
-- and had to refuse an out-of-order one. The new drain ALWAYS recomputes the
-- payload from current canonical state at send time, so a late/duplicate drain
-- is naturally idempotent and a watermark can only cause a dropped range.
DROP TABLE IF EXISTS guesthub.channel_sync_state;

-- ---- 3. worker liveness (one row; the worker is a system process, not a tenant) ----
CREATE TABLE IF NOT EXISTS guesthub.channel_worker_state (
  id            text PRIMARY KEY DEFAULT 'singleton' CHECK (id = 'singleton'),
  worker_id     text,
  beat_at       timestamptz,
  last_drain_at timestamptz,   -- last drain that sent at least one value
  last_error    text,          -- safe category message only — never an upstream body
  updated_at    timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_channel_worker_state_updated_at ON guesthub.channel_worker_state;
CREATE TRIGGER trg_channel_worker_state_updated_at BEFORE UPDATE ON guesthub.channel_worker_state
  FOR EACH ROW EXECUTE FUNCTION guesthub.set_updated_at();

-- ---- 4. grants (000 pattern) ----
GRANT ALL ON ALL TABLES IN SCHEMA "guesthub" TO service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA "guesthub" FROM anon, authenticated;
