-- ============================================================
--  009 · Phase 4A — Sellable Units + canonical commercial ARI
--  Additive + idempotent. NO Channex contact, NO worker, NO network. The
--  local canonical model only (approved decisions §0 of the phase-4 report).
--
--  Introduces the Sellable Unit layer between physical rooms and Channex room
--  types, the canonical rate-plan commercial store (the migrated replacement
--  for guesthub.rates), a per-SU physical projection, the single Effective
--  Sell State read model, a stale-retry watermark, and the manual-rate flag.
--  Existing channel_* mapping/queue infrastructure is PRESERVED (still keyed
--  on room_type_id — an SU carries its room_type_id binding).
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/009_phase4a_sellable_units.sql
--
--  ROLLBACK (reverse order):
--    DROP FUNCTION IF EXISTS guesthub.effective_sell_state(uuid,date,date);
--    DROP FUNCTION IF EXISTS guesthub.sellable_unit_inventory(uuid,date,date);
--    DROP TABLE IF EXISTS guesthub.channel_sync_state;
--    ALTER TABLE guesthub.channel_dirty_ranges DROP COLUMN IF EXISTS revision;
--    DROP SEQUENCE IF EXISTS guesthub.channel_dirty_revision_seq;
--    ALTER TABLE guesthub.reservation_rooms DROP COLUMN IF EXISTS is_manual_rate;
--    DROP TABLE IF EXISTS guesthub.pricing_plan_rates;
--    DROP TABLE IF EXISTS guesthub.pricing_plans;
--    DROP TABLE IF EXISTS guesthub.sellable_unit_rooms;
--    DROP TABLE IF EXISTS guesthub.sellable_units;
--    (rooms.status 'maintenance' is not restored — it was folded into out_of_order.)
-- ============================================================

SET search_path TO "guesthub", public;

-- ---- 1. rooms.status: administrative physical eligibility ONLY (§0.5) ----
-- Allowed set is available | inactive | out_of_order. 'maintenance' becomes a
-- dated physical block (room_closures), never a permanent status. Any existing
-- maintenance room folds into out_of_order — behaviour-preserving, since
-- check_room_availability already treats every status <> 'available' as
-- unsellable and room_type_inventory counts it out of 'sellable'.
ALTER TABLE guesthub.rooms DROP CONSTRAINT IF EXISTS rooms_status_check;
UPDATE guesthub.rooms SET status = 'out_of_order' WHERE status = 'maintenance';
ALTER TABLE guesthub.rooms
  ADD CONSTRAINT rooms_status_check
  CHECK (status IN ('available','inactive','out_of_order'));

-- ---- 2. sellable_units — the canonical external inventory unit (§0.1) ----
-- One physical room (individually-marketed apartment, the default) or several
-- truly-interchangeable rooms sold as a pool (is_pooled). room_type_id is the
-- Channex-room-type binding for the existing mappings/outbox/room_type_inventory
-- — it does NOT define the pool; the SU does. Rooms are never auto-aggregated
-- by internal room-type name.
CREATE TABLE IF NOT EXISTS guesthub.sellable_units (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  code         text NOT NULL,
  name         text NOT NULL,
  room_type_id uuid REFERENCES guesthub.room_types(id) ON DELETE SET NULL,
  is_pooled    boolean NOT NULL DEFAULT false,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_sellable_units_tenant ON guesthub.sellable_units(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sellable_units_type   ON guesthub.sellable_units(room_type_id);

-- ---- 3. sellable_unit_rooms — membership (a room belongs to exactly one SU) ----
CREATE TABLE IF NOT EXISTS guesthub.sellable_unit_rooms (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  sellable_unit_id uuid NOT NULL REFERENCES guesthub.sellable_units(id) ON DELETE CASCADE,
  room_id          uuid NOT NULL REFERENCES guesthub.rooms(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id)
);
CREATE INDEX IF NOT EXISTS idx_su_rooms_unit   ON guesthub.sellable_unit_rooms(sellable_unit_id);
CREATE INDEX IF NOT EXISTS idx_su_rooms_tenant ON guesthub.sellable_unit_rooms(tenant_id);

-- ---- 4. pricing_plans — canonical internal Rate Plan entity (§0.4) ----
-- One active is_base plan per SU in Phase 4A. Future derived plans (non-refundable,
-- breakfast, …) attach here without a schema change; no inheritance engine now.
CREATE TABLE IF NOT EXISTS guesthub.pricing_plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  sellable_unit_id uuid NOT NULL REFERENCES guesthub.sellable_units(id) ON DELETE CASCADE,
  code             text NOT NULL DEFAULT 'base',
  name             text NOT NULL DEFAULT 'מחיר בסיס',
  is_base          boolean NOT NULL DEFAULT false,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sellable_unit_id, code)
);
-- at most one base plan per SU
CREATE UNIQUE INDEX IF NOT EXISTS uq_pricing_plans_base
  ON guesthub.pricing_plans(sellable_unit_id) WHERE is_base;
CREATE INDEX IF NOT EXISTS idx_pricing_plans_tenant ON guesthub.pricing_plans(tenant_id);

-- ---- 5. pricing_plan_rates — CANONICAL commercial ARI (replaces rates) ----
-- Addressable by sellable_unit_id + pricing_plan_id + date (§0.4). Three
-- SEPARATE stay fields (§0.3): min_stay_through / min_stay_arrival / max_stay —
-- never collapsed. The ONLY writable commercial-state store from Phase 4A on;
-- legacy guesthub.rates is migrated in (§10) and retired from all app paths.
CREATE TABLE IF NOT EXISTS guesthub.pricing_plan_rates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  sellable_unit_id    uuid NOT NULL REFERENCES guesthub.sellable_units(id) ON DELETE CASCADE,
  pricing_plan_id     uuid NOT NULL REFERENCES guesthub.pricing_plans(id) ON DELETE CASCADE,
  date                date NOT NULL,
  price               numeric(12,2),
  min_stay_through    integer,
  min_stay_arrival    integer,
  max_stay            integer,
  closed_to_arrival   boolean NOT NULL DEFAULT false,
  closed_to_departure boolean NOT NULL DEFAULT false,
  stop_sell           boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- one canonical commercial row per plan/date → grid upserts are deterministic
  UNIQUE (pricing_plan_id, date)
);
CREATE INDEX IF NOT EXISTS idx_ppr_tenant_date ON guesthub.pricing_plan_rates(tenant_id, date);
CREATE INDEX IF NOT EXISTS idx_ppr_unit_date   ON guesthub.pricing_plan_rates(sellable_unit_id, date);

-- ---- 6. reservation_rooms.is_manual_rate — authorized override survives recompute (§13) ----
ALTER TABLE guesthub.reservation_rooms
  ADD COLUMN IF NOT EXISTS is_manual_rate boolean NOT NULL DEFAULT false;

-- ---- 7. stale-retry watermark (§11) ----
-- Every dirty-mark carries a monotonic revision; applied_revision per
-- (connection, room_type, kind) advances only forward, so an out-of-order older
-- success can never overwrite a newer synced range.
CREATE SEQUENCE IF NOT EXISTS guesthub.channel_dirty_revision_seq;
ALTER TABLE guesthub.channel_dirty_ranges
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL
    DEFAULT nextval('guesthub.channel_dirty_revision_seq');
CREATE TABLE IF NOT EXISTS guesthub.channel_sync_state (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  connection_id    uuid NOT NULL REFERENCES guesthub.channel_connections(id) ON DELETE CASCADE,
  room_type_id     uuid NOT NULL REFERENCES guesthub.room_types(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('availability','rates','restrictions')),
  applied_revision bigint NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, room_type_id, kind)
);

-- ---- 8. sellable_unit_inventory() — per-SU physical projection ----
-- Member rooms free & sellable per day. Mirrors room_type_inventory() but
-- grouped by SU membership; same blocking statuses + half-open overlap; never
-- negative. (channel_inventory_holds are room-type scoped, a 4B inbound concern,
-- and intentionally not projected at SU granularity here.)
CREATE OR REPLACE FUNCTION guesthub.sellable_unit_inventory(
  p_tenant uuid,
  p_from   date,
  p_to     date        -- exclusive
) RETURNS TABLE (
  sellable_unit_id uuid,
  day              date,
  total_rooms      integer,
  sellable_rooms   integer,
  occupied_rooms   integer,
  closed_rooms     integer,
  availability     integer
) LANGUAGE sql STABLE AS $$
WITH days AS (
  SELECT d::date AS day FROM generate_series(p_from, (p_to - 1)::date, interval '1 day') d
),
m AS (
  SELECT sur.sellable_unit_id AS su, r.id AS room_id, r.status, r.is_active
  FROM guesthub.sellable_unit_rooms sur
  JOIN guesthub.rooms r ON r.id = sur.room_id
  WHERE sur.tenant_id = p_tenant
),
base AS (
  SELECT su,
         count(*)::int AS total,
         count(*) FILTER (WHERE status = 'available' AND is_active)::int AS sellable
  FROM m GROUP BY su
),
consumed AS (
  SELECT su, day,
         count(DISTINCT room_id)::int AS unavailable,
         count(DISTINCT room_id) FILTER (WHERE kind = 'occupied')::int AS occupied,
         count(DISTINCT room_id) FILTER (WHERE kind = 'closed')::int   AS closed
  FROM (
    SELECT m.su, d.day, rr.room_id, 'occupied'::text AS kind
    FROM guesthub.reservation_rooms rr
    JOIN guesthub.reservations res ON res.id = rr.reservation_id
    JOIN m ON m.room_id = rr.room_id AND m.status = 'available' AND m.is_active
    JOIN days d ON rr.check_in <= d.day AND rr.check_out > d.day
    WHERE rr.tenant_id = p_tenant
      AND res.status = ANY (guesthub.inventory_blocking_statuses())
    UNION ALL
    SELECT m.su, d.day, c.room_id, 'closed'::text
    FROM guesthub.room_closures c
    JOIN m ON m.room_id = c.room_id AND m.status = 'available' AND m.is_active
    JOIN days d ON c.start_date <= d.day AND c.end_date > d.day
    WHERE c.tenant_id = p_tenant
  ) x
  GROUP BY su, day
)
SELECT b.su, d.day, b.total, b.sellable,
       COALESCE(c.occupied, 0), COALESCE(c.closed, 0),
       GREATEST(0, b.sellable - COALESCE(c.unavailable, 0))
FROM base b CROSS JOIN days d
LEFT JOIN consumed c ON c.su = b.su AND c.day = d.day
ORDER BY b.su, d.day
$$;

-- ---- 9. effective_sell_state() — THE single deterministic read model ----
-- Fuses the SU physical projection (axis 1) with base-plan commercial ARI
-- (axis 2). The two axes stay INDEPENDENT: a physically-blocked day still
-- carries a price; a stop_sell day still has physical rooms free. price falls
-- back to the SU's room-type base_price. Per-day sellable = availability>0 AND
-- NOT stop_sell; per-STAY restrictions (min/max stay, CTA/CTD) are applied by
-- the shared validator, which reads these same fields. Consumed by the grid,
-- the booking engine, reservation pricing, and the (4B) payload builder.
CREATE OR REPLACE FUNCTION guesthub.effective_sell_state(
  p_tenant uuid,
  p_from   date,
  p_to     date        -- exclusive
) RETURNS TABLE (
  sellable_unit_id    uuid,
  room_type_id        uuid,
  pricing_plan_id     uuid,
  day                 date,
  availability        integer,
  price               numeric(12,2),
  min_stay_through    integer,
  min_stay_arrival    integer,
  max_stay            integer,
  closed_to_arrival   boolean,
  closed_to_departure boolean,
  stop_sell           boolean,
  sellable            boolean
) LANGUAGE sql STABLE AS $$
  SELECT su.id, su.room_type_id, bp.id, inv.day, inv.availability,
         COALESCE(ppr.price, rt.base_price),
         ppr.min_stay_through, ppr.min_stay_arrival, ppr.max_stay,
         COALESCE(ppr.closed_to_arrival, false),
         COALESCE(ppr.closed_to_departure, false),
         COALESCE(ppr.stop_sell, false),
         (inv.availability > 0 AND NOT COALESCE(ppr.stop_sell, false))
  FROM guesthub.sellable_units su
  JOIN guesthub.sellable_unit_inventory(p_tenant, p_from, p_to) inv
    ON inv.sellable_unit_id = su.id
  LEFT JOIN guesthub.room_types rt ON rt.id = su.room_type_id
  LEFT JOIN guesthub.pricing_plans bp
    ON bp.sellable_unit_id = su.id AND bp.is_base AND bp.is_active
  LEFT JOIN guesthub.pricing_plan_rates ppr
    ON ppr.pricing_plan_id = bp.id AND ppr.date = inv.day
  WHERE su.tenant_id = p_tenant AND su.is_active
  ORDER BY su.id, inv.day
$$;

-- ---- 10. Backfill (idempotent) — default one SU + base plan per room; ----
-- canonical rates resolved from legacy guesthub.rates (room-level wins over
-- type-level, faithful to the retired resolveRate). The SU code is derived to
-- be UNIQUE per room even when a tenant has duplicate or blank room_numbers —
-- a rank suffix disambiguates them — so a duplicate number can never collapse
-- two physical rooms into one SU. The su_code expression is identical in both
-- statements (deterministic window over ORDER BY id) so the membership join
-- matches. Pooled SUs are configured explicitly, never by this default.
INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id)
SELECT tenant_id, su_code, su_name, room_type_id FROM (
  SELECT r.tenant_id, r.room_type_id,
         COALESCE(NULLIF(r.name, ''), NULLIF(r.room_number, ''), r.id::text) AS su_name,
         CASE
           WHEN count(*) OVER (PARTITION BY r.tenant_id, r.room_number) > 1
                OR COALESCE(r.room_number, '') = ''
           THEN COALESCE(NULLIF(r.room_number, ''), 'unit') || '#'
                || row_number() OVER (PARTITION BY r.tenant_id, r.room_number ORDER BY r.id)
           ELSE r.room_number
         END AS su_code
  FROM guesthub.rooms r
  WHERE NOT EXISTS (SELECT 1 FROM guesthub.sellable_unit_rooms sur WHERE sur.room_id = r.id)
) x
ON CONFLICT (tenant_id, code) DO NOTHING;

INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id)
SELECT x.tenant_id, su.id, x.room_id FROM (
  SELECT r.id AS room_id, r.tenant_id,
         CASE
           WHEN count(*) OVER (PARTITION BY r.tenant_id, r.room_number) > 1
                OR COALESCE(r.room_number, '') = ''
           THEN COALESCE(NULLIF(r.room_number, ''), 'unit') || '#'
                || row_number() OVER (PARTITION BY r.tenant_id, r.room_number ORDER BY r.id)
           ELSE r.room_number
         END AS su_code
  FROM guesthub.rooms r
  WHERE NOT EXISTS (SELECT 1 FROM guesthub.sellable_unit_rooms sur WHERE sur.room_id = r.id)
) x
JOIN guesthub.sellable_units su ON su.tenant_id = x.tenant_id AND su.code = x.su_code
ON CONFLICT (room_id) DO NOTHING;

INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base)
SELECT su.tenant_id, su.id, 'base', 'מחיר בסיס', true
FROM guesthub.sellable_units su
WHERE NOT EXISTS (SELECT 1 FROM guesthub.pricing_plans p
                  WHERE p.sellable_unit_id = su.id AND p.is_base)
ON CONFLICT (sellable_unit_id, code) DO NOTHING;

INSERT INTO guesthub.pricing_plan_rates
  (tenant_id, sellable_unit_id, pricing_plan_id, date, price,
   min_stay_arrival, max_stay, stop_sell, closed_to_arrival, closed_to_departure)
SELECT su.tenant_id, su.id, bp.id, resolved.date, resolved.price,
       resolved.min_nights, resolved.max_nights, resolved.closed,
       resolved.closed_to_arrival, resolved.closed_to_departure
FROM guesthub.sellable_units su
JOIN guesthub.sellable_unit_rooms sur ON sur.sellable_unit_id = su.id
JOIN guesthub.pricing_plans bp ON bp.sellable_unit_id = su.id AND bp.is_base
JOIN LATERAL (
  SELECT DISTINCT ON (rt.date) rt.date, rt.price, rt.min_nights, rt.max_nights,
         rt.closed, rt.closed_to_arrival, rt.closed_to_departure
  FROM guesthub.rates rt
  WHERE rt.tenant_id = su.tenant_id
    AND (rt.room_id = sur.room_id
         OR (rt.room_id IS NULL AND rt.room_type_id = su.room_type_id))
  ORDER BY rt.date, (rt.room_id IS NOT NULL) DESC   -- room-level beats type-level
) resolved ON true
ON CONFLICT (pricing_plan_id, date) DO NOTHING;

-- ---- 11. updated_at triggers for new tables with the column ----
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    WHERE c.table_schema = 'guesthub' AND c.column_name = 'updated_at'
      AND c.table_name IN ('sellable_units','pricing_plans','pricing_plan_rates','channel_sync_state')
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON guesthub.%1$I;
       CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON guesthub.%1$I
         FOR EACH ROW EXECUTE FUNCTION guesthub.set_updated_at();', t);
  END LOOP;
END $$;

-- ---- 12. grants (000 pattern) ----
GRANT ALL ON ALL TABLES    IN SCHEMA guesthub TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA guesthub TO service_role;
REVOKE ALL ON ALL TABLES    IN SCHEMA guesthub FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA guesthub FROM anon, authenticated;
