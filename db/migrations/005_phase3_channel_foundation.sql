-- ============================================================
--  005 · Phase 3 — channel-manager (Channex-ready) foundation
--  Structural only. NO connection exists, NO network call is made,
--  NO credentials are stored. Everything is tenant-scoped, additive,
--  idempotent. DECISIONS D35.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/005_phase3_channel_foundation.sql
-- ============================================================

-- ---- 1. connections (§P) ----
-- API keys are NEVER stored in plaintext: api_key_ciphertext is AES-256-GCM
-- encrypted server-side (src/lib/channel/crypto.ts), api_key_hint is a masked
-- suffix for display. Nothing writes these in Phase 3.
CREATE TABLE IF NOT EXISTS guesthub.channel_connections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  provider              text NOT NULL DEFAULT 'channex' CHECK (provider IN ('channex')),
  environment           text NOT NULL DEFAULT 'staging' CHECK (environment IN ('staging','production')),
  state                 text NOT NULL DEFAULT 'disconnected'
                        CHECK (state IN ('disconnected','configured','validating','ready','active','paused','error')),
  channex_property_id   text,
  outbound_sync_enabled boolean NOT NULL DEFAULT false,
  inbound_sync_enabled  boolean NOT NULL DEFAULT false,
  full_sync_required    boolean NOT NULL DEFAULT true,
  api_key_ciphertext    text,
  api_key_hint          text,
  webhook_token_hash    text,      -- sha256 of the future per-connection webhook token
  last_outbound_sync_at timestamptz,
  last_inbound_import_at timestamptz,
  last_reconciliation_at timestamptz,
  last_error            text,
  created_by            uuid REFERENCES guesthub.users(id) ON DELETE SET NULL,
  updated_by            uuid REFERENCES guesthub.users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, environment)
);

-- ---- 2. mappings (§N) — room types and rate plans, never physical rooms ----
CREATE TABLE IF NOT EXISTS guesthub.channel_room_type_mappings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  connection_id        uuid NOT NULL REFERENCES guesthub.channel_connections(id) ON DELETE CASCADE,
  room_type_id         uuid NOT NULL REFERENCES guesthub.room_types(id) ON DELETE RESTRICT,
  channex_room_type_id text,
  is_active            boolean NOT NULL DEFAULT true,
  status               text NOT NULL DEFAULT 'unmapped'
                       CHECK (status IN ('unmapped','mapped','invalid')),
  validation_error     text,
  last_validated_at    timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, room_type_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_crtm_channex_id
  ON guesthub.channel_room_type_mappings (connection_id, channex_room_type_id)
  WHERE channex_room_type_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS guesthub.channel_rate_plan_mappings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  connection_id        uuid NOT NULL REFERENCES guesthub.channel_connections(id) ON DELETE CASCADE,
  room_type_id         uuid NOT NULL REFERENCES guesthub.room_types(id) ON DELETE RESTRICT,
  -- GuestHub has no separate rate-plan entity yet: the local plan is the room
  -- type's default nightly plan ('default'). Column exists so future plans map
  -- without a schema change.
  local_plan_code      text NOT NULL DEFAULT 'default',
  channex_rate_plan_id text,
  currency             text NOT NULL DEFAULT 'ILS',
  is_active            boolean NOT NULL DEFAULT true,
  status               text NOT NULL DEFAULT 'unmapped'
                       CHECK (status IN ('unmapped','mapped','invalid')),
  validation_error     text,
  last_validated_at    timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, room_type_id, local_plan_code)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_crpm_channex_id
  ON guesthub.channel_rate_plan_mappings (connection_id, channex_rate_plan_id)
  WHERE channex_rate_plan_id IS NOT NULL;

-- ---- 3. transactional dirty ranges (§S) ----
-- Written in the SAME transaction as the business write, but ONLY when an
-- active outbound-enabled connection exists (none in Phase 3 → no backlog).
-- Overlapping/adjacent pending ranges for the same connection/room-type/kind
-- are coalesced on insert (src/lib/channel/outbox.ts).
CREATE TABLE IF NOT EXISTS guesthub.channel_dirty_ranges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES guesthub.channel_connections(id) ON DELETE CASCADE,
  room_type_id  uuid NOT NULL REFERENCES guesthub.room_types(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('availability','rates','restrictions')),
  date_from     date NOT NULL,
  date_to       date NOT NULL,   -- exclusive
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','queued','synced')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (date_to > date_from)
);
CREATE INDEX IF NOT EXISTS idx_dirty_pending
  ON guesthub.channel_dirty_ranges (connection_id, room_type_id, kind, date_from)
  WHERE status = 'pending';

-- ---- 4. durable job queue (§T) ----
CREATE TABLE IF NOT EXISTS guesthub.channel_sync_jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  connection_id      uuid NOT NULL REFERENCES guesthub.channel_connections(id) ON DELETE CASCADE,
  room_type_mapping_id uuid REFERENCES guesthub.channel_room_type_mappings(id) ON DELETE SET NULL,
  job_type           text NOT NULL CHECK (job_type IN (
                       'validate_connection','full_sync','sync_availability','sync_rates',
                       'sync_restrictions','sync_ari_range','pull_booking_revisions',
                       'import_booking_revision','acknowledge_booking_revision',
                       'reconcile_inventory','retry_failed_range')),
  status             text NOT NULL DEFAULT 'queued' CHECK (status IN (
                       'queued','processing','succeeded','failed','retry_wait',
                       'dead_letter','cancelled','suppressed')),
  priority           integer NOT NULL DEFAULT 100,
  date_from          date,
  date_to            date,
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_version    integer NOT NULL DEFAULT 1,
  idempotency_key    text,
  correlation_id     uuid NOT NULL DEFAULT gen_random_uuid(),
  attempts           integer NOT NULL DEFAULT 0,
  max_attempts       integer NOT NULL DEFAULT 8,
  next_attempt_at    timestamptz NOT NULL DEFAULT now(),
  locked_at          timestamptz,
  locked_by          text,
  started_at         timestamptz,
  finished_at        timestamptz,
  provider_task_id   text,
  last_error_code    text,
  last_error_message text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- duplicate business events must not create duplicate outbound work
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_idempotency
  ON guesthub.channel_sync_jobs (connection_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND status IN ('queued','processing','retry_wait');
-- claim path: FOR UPDATE SKIP LOCKED over runnable jobs, FIFO per connection
CREATE INDEX IF NOT EXISTS idx_jobs_claim
  ON guesthub.channel_sync_jobs (connection_id, priority, created_at)
  WHERE status IN ('queued','retry_wait');
CREATE INDEX IF NOT EXISTS idx_jobs_tenant_status
  ON guesthub.channel_sync_jobs (tenant_id, status);

-- ---- 5. inbound booking revisions (§X) ----
CREATE TABLE IF NOT EXISTS guesthub.channel_booking_revisions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  connection_id        uuid NOT NULL REFERENCES guesthub.channel_connections(id) ON DELETE CASCADE,
  provider_booking_id  text NOT NULL,
  provider_revision_id text NOT NULL,
  unique_id            text,
  system_id            text,
  ota_reservation_code text,
  ota_name             text,
  revision_kind        text NOT NULL CHECK (revision_kind IN ('new','modified','cancelled')),
  raw_status           text,
  -- payload is REDACTED before persistence (no card/guarantee data — §Z)
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  import_status        text NOT NULL DEFAULT 'pending'
                       CHECK (import_status IN ('pending','imported','quarantined','failed')),
  ack_status           text NOT NULL DEFAULT 'unacknowledged'
                       CHECK (ack_status IN ('unacknowledged','acknowledged')),
  acknowledged_at      timestamptz,
  attempts             integer NOT NULL DEFAULT 0,
  mapping_error        text,
  local_reservation_id uuid REFERENCES guesthub.reservations(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- revision identity is provider+connection scoped — the same revision can
  -- never import twice (an OTA code alone is NOT globally unique)
  UNIQUE (connection_id, provider_revision_id)
);
CREATE INDEX IF NOT EXISTS idx_revisions_booking
  ON guesthub.channel_booking_revisions (connection_id, provider_booking_id);
CREATE INDEX IF NOT EXISTS idx_revisions_import
  ON guesthub.channel_booking_revisions (tenant_id, import_status);

-- ---- 6. inventory holds for unassigned external bookings (§R) ----
-- An imported OTA booking reduces ROOM-TYPE inventory immediately, before a
-- physical room is assigned — without making reservation_rooms.room_id
-- nullable. Included in room_type_inventory() below; the calendar shows an
-- unassigned lane only when active holds exist.
CREATE TABLE IF NOT EXISTS guesthub.channel_inventory_holds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  connection_id       uuid REFERENCES guesthub.channel_connections(id) ON DELETE SET NULL,
  room_type_id        uuid NOT NULL REFERENCES guesthub.room_types(id) ON DELETE CASCADE,
  check_in            date NOT NULL,
  check_out           date NOT NULL,   -- exclusive
  rooms_count         integer NOT NULL DEFAULT 1 CHECK (rooms_count > 0),
  status              text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','released','converted')),
  booking_revision_id uuid REFERENCES guesthub.channel_booking_revisions(id) ON DELETE SET NULL,
  local_reservation_id uuid REFERENCES guesthub.reservations(id) ON DELETE SET NULL,
  guest_name          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (check_out > check_in)
);
CREATE INDEX IF NOT EXISTS idx_holds_active
  ON guesthub.channel_inventory_holds (tenant_id, room_type_id, check_in, check_out)
  WHERE status = 'active';

-- ---- 7. webhook events (§Y) ----
CREATE TABLE IF NOT EXISTS guesthub.channel_webhook_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES guesthub.channel_connections(id) ON DELETE CASCADE,
  event_type    text NOT NULL,
  dedup_key     text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- redacted before insert (§Z)
  status        text NOT NULL DEFAULT 'received'
                CHECK (status IN ('received','enqueued','processed','duplicate','rejected')),
  error         text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_dedup
  ON guesthub.channel_webhook_events (connection_id, dedup_key);

-- ---- 8. structured sync errors / observability (§AA) ----
CREATE TABLE IF NOT EXISTS guesthub.channel_sync_errors (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  connection_id        uuid REFERENCES guesthub.channel_connections(id) ON DELETE CASCADE,
  job_id               uuid REFERENCES guesthub.channel_sync_jobs(id) ON DELETE SET NULL,
  room_type_id         uuid REFERENCES guesthub.room_types(id) ON DELETE SET NULL,
  rate_plan_mapping_id uuid REFERENCES guesthub.channel_rate_plan_mappings(id) ON DELETE SET NULL,
  date_from            date,
  date_to              date,
  provider_task_id     text,
  error_code           text,
  error_message        text NOT NULL,
  context              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at          timestamptz
);
CREATE INDEX IF NOT EXISTS idx_sync_errors_conn
  ON guesthub.channel_sync_errors (connection_id, created_at DESC);

-- ---- 9. room-type inventory projection (§Q) ----
-- THE single projection both the future Channex adapter and diagnostics
-- consume. Uses the same blocking statuses + half-open overlap rule as
-- check_room_availability — the two are asserted to agree by
-- scripts/check-inventory.mjs. Availability is never negative.
CREATE OR REPLACE FUNCTION guesthub.room_type_inventory(
  p_tenant uuid,
  p_from   date,
  p_to     date        -- exclusive
) RETURNS TABLE (
  room_type_id       uuid,
  day                date,
  total_rooms        integer,
  inactive_rooms     integer,
  out_of_order_rooms integer,
  sellable_rooms     integer,
  occupied_rooms     integer,
  closed_rooms       integer,
  hold_rooms         integer,
  availability       integer
) LANGUAGE sql STABLE AS $$
WITH days AS (
  SELECT d::date AS day FROM generate_series(p_from, (p_to - 1)::date, interval '1 day') d
),
r AS (
  SELECT id, rooms.room_type_id AS rt, status, is_active
  FROM guesthub.rooms
  WHERE tenant_id = p_tenant AND rooms.room_type_id IS NOT NULL
),
base AS (
  SELECT rt,
         count(*)::int AS total,
         count(*) FILTER (WHERE status = 'inactive' OR NOT is_active)::int AS inactive_ct,
         count(*) FILTER (WHERE status = 'out_of_order')::int              AS ooo_ct,
         count(*) FILTER (WHERE status = 'available' AND is_active)::int   AS sellable
  FROM r GROUP BY rt
),
-- distinct sellable rooms consumed per day, by occupation and/or closure —
-- a room both occupied and closed on the same day is consumed ONCE
consumed AS (
  SELECT rt, day,
         count(DISTINCT room_id)::int AS unavailable,
         count(DISTINCT room_id) FILTER (WHERE kind = 'occupied')::int AS occupied,
         count(DISTINCT room_id) FILTER (WHERE kind = 'closed')::int   AS closed
  FROM (
    SELECT r.rt, d.day, rr.room_id, 'occupied'::text AS kind
    FROM guesthub.reservation_rooms rr
    JOIN guesthub.reservations res ON res.id = rr.reservation_id
    JOIN r ON r.id = rr.room_id AND r.status = 'available' AND r.is_active
    JOIN days d ON rr.check_in <= d.day AND rr.check_out > d.day
    WHERE rr.tenant_id = p_tenant
      AND res.status = ANY (guesthub.inventory_blocking_statuses())
    UNION ALL
    SELECT r.rt, d.day, c.room_id, 'closed'::text
    FROM guesthub.room_closures c
    JOIN r ON r.id = c.room_id AND r.status = 'available' AND r.is_active
    JOIN days d ON c.start_date <= d.day AND c.end_date > d.day
    WHERE c.tenant_id = p_tenant
  ) x
  GROUP BY rt, day
),
holds AS (
  SELECT h.room_type_id AS rt, d.day, sum(h.rooms_count)::int AS held
  FROM guesthub.channel_inventory_holds h
  JOIN days d ON h.check_in <= d.day AND h.check_out > d.day
  WHERE h.tenant_id = p_tenant AND h.status = 'active'
  GROUP BY 1, 2
)
SELECT b.rt,
       d.day,
       b.total,
       b.inactive_ct,
       b.ooo_ct,
       b.sellable,
       COALESCE(c.occupied, 0),
       COALESCE(c.closed, 0),
       COALESCE(h.held, 0),
       GREATEST(0, b.sellable - COALESCE(c.unavailable, 0) - COALESCE(h.held, 0))
FROM base b
CROSS JOIN days d
LEFT JOIN consumed c ON c.rt = b.rt AND c.day = d.day
LEFT JOIN holds h    ON h.rt = b.rt AND h.day = d.day
ORDER BY b.rt, d.day
$$;

-- ---- 10. updated_at triggers for all new tables with the column ----
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    WHERE c.table_schema = 'guesthub' AND c.column_name = 'updated_at'
      AND c.table_name LIKE 'channel_%'
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON guesthub.%1$I;
       CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON guesthub.%1$I
         FOR EACH ROW EXECUTE FUNCTION guesthub.set_updated_at();', t);
  END LOOP;
END $$;

-- ---- 11. grants (000 pattern) ----
GRANT ALL ON ALL TABLES IN SCHEMA guesthub TO service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA guesthub FROM anon, authenticated;
