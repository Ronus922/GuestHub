-- ============================================================
--  026 · Sellable-unit lifecycle integrity (D66)
--  Additive + idempotent. Two production defects repaired, three guards added.
--
--  Forensics (production, 2026-07-09):
--    · Physical rooms "302"/"303" were removed by direct SQL (no audit rows —
--      and deleteRoomAction would have refused): the ON DELETE CASCADE took
--      their sellable_unit_rooms memberships but LEFT their sellable_units
--      active, so "יחידה 302"/"יחידה 303" stayed selectable in Rate Plan
--      assignment (395 base-ARI rows + 4 plan assignments each) while
--      representing no physical room.
--    · Rooms created through the app never received a sellable unit — SUs were
--      only ever born in the 009 backfill — so room 1424 (created 2026-07-08)
--      was absent from Rate Plan selection and the Rates grid, and priced as
--      RATE_PLAN_NOT_ASSIGNED ("לחדר אין יחידת מכירה מוגדרת").
--
--  This migration:
--    1. deletes orphaned, reference-free sellable units (today: exactly
--       302/303) — guarded so a unit with operator-authored overlay rates or
--       any reservation/channel reference is archived, never deleted;
--    2. re-runs the canonical one-SU-per-room backfill for rooms lacking a
--       membership (today: exactly 1424) and assigns ONLY those repaired units
--       to the live tenant-level Rate Plans — matching how every other room
--       participates and the plan×room Channex mappings that already exist;
--    3. adds lifecycle guards: tenant-consistency composite FKs on the
--       membership table, and a trigger that archives a sellable unit the
--       moment its last member room disappears — even via direct SQL.
--
--  The app-side lifecycle (SU born with the room, deleted with a never-used
--  room) ships in the same change; the trigger is the DB backstop for paths
--  that bypass the app. No Channex table is touched; no network is involved.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/026_sellable_unit_lifecycle.sql
--
--  ROLLBACK (schema only — the data repair is intentionally one-way):
--    DROP TRIGGER IF EXISTS trg_su_rooms_orphan_archive ON guesthub.sellable_unit_rooms;
--    DROP FUNCTION IF EXISTS guesthub.archive_orphan_sellable_unit();
--    ALTER TABLE guesthub.sellable_unit_rooms DROP CONSTRAINT IF EXISTS su_rooms_unit_tenant_fkey;
--    ALTER TABLE guesthub.sellable_unit_rooms DROP CONSTRAINT IF EXISTS su_rooms_room_tenant_fkey;
--    DROP INDEX IF EXISTS guesthub.uq_sellable_units_tenant_id;
--    DROP INDEX IF EXISTS guesthub.uq_rooms_tenant_id;
-- ============================================================

SET search_path TO "guesthub", public;

-- ---- 1. delete orphaned, reference-free sellable units ----
-- An SU with no member room sells nothing and prices nothing. It is DELETED
-- (cascading its own base plan, base-ARI rows and plan assignments — pure
-- technical substrate) only when nothing of business value points at it:
--   · no per-unit overlay rates (operator-authored plan prices),
--   · no reservation priced on one of its plans,
--   · no channel mapping bound to one of its plans.
-- Anything short of that is archived by §2 instead.
DO $$
DECLARE removed integer;
BEGIN
  DELETE FROM guesthub.sellable_units su
  WHERE NOT EXISTS (SELECT 1 FROM guesthub.sellable_unit_rooms sur
                    WHERE sur.sellable_unit_id = su.id)
    AND NOT EXISTS (SELECT 1 FROM guesthub.pricing_plan_unit_rates ppur
                    WHERE ppur.sellable_unit_id = su.id)
    AND NOT EXISTS (SELECT 1 FROM guesthub.reservation_rooms rr
                    JOIN guesthub.pricing_plans p ON p.id = rr.rate_plan_id
                    WHERE p.sellable_unit_id = su.id)
    AND NOT EXISTS (SELECT 1 FROM guesthub.channel_room_rate_mappings crm
                    JOIN guesthub.pricing_plans cp ON cp.id = crm.local_rate_plan_id
                    WHERE cp.sellable_unit_id = su.id);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE '026: deleted % orphaned sellable unit(s)', removed;
END $$;

-- ---- 2. archive any orphan that survived the guards ----
-- (today: none — belt for units carrying operator data that must be retained)
UPDATE guesthub.sellable_units su SET is_active = false
WHERE su.is_active
  AND NOT EXISTS (SELECT 1 FROM guesthub.sellable_unit_rooms sur
                  WHERE sur.sellable_unit_id = su.id);

-- ---- 3. one-SU-per-room backfill for rooms missing a membership ----
-- Same canonical shape as the 009 backfill (identical su_code expression in
-- both statements — deterministic window over ORDER BY id — so the membership
-- join matches even with duplicate/blank room numbers). Captured first, so §4
-- can assign ONLY the repaired rooms' units to the live tenant plans.
CREATE TEMP TABLE _repaired_rooms AS
SELECT r.id AS room_id, r.tenant_id
FROM guesthub.rooms r
WHERE NOT EXISTS (SELECT 1 FROM guesthub.sellable_unit_rooms sur WHERE sur.room_id = r.id);

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
  WHERE r.id IN (SELECT room_id FROM _repaired_rooms)
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
  WHERE r.id IN (SELECT room_id FROM _repaired_rooms)
) x
JOIN guesthub.sellable_units su ON su.tenant_id = x.tenant_id AND su.code = x.su_code
ON CONFLICT (room_id) DO NOTHING;

INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base)
SELECT su.tenant_id, su.id, 'base', 'מחיר בסיס', true
FROM guesthub.sellable_units su
JOIN guesthub.sellable_unit_rooms sur ON sur.sellable_unit_id = su.id
WHERE sur.room_id IN (SELECT room_id FROM _repaired_rooms)
  AND NOT EXISTS (SELECT 1 FROM guesthub.pricing_plans p
                  WHERE p.sellable_unit_id = su.id AND p.is_base)
ON CONFLICT (sellable_unit_id, code) DO NOTHING;

-- No base-ARI rows are invented: with zero pricing_plan_rates rows the unit
-- prices through the canonical room-type base_price fallback exactly like
-- every other unit without a dated row (effective_sell_state COALESCE).

-- ---- 4. repaired units join the live tenant-level Rate Plans ----
-- Only rooms repaired above — never re-adds assignments an operator removed.
INSERT INTO guesthub.pricing_plan_units (tenant_id, pricing_plan_id, sellable_unit_id)
SELECT p.tenant_id, p.id, sur.sellable_unit_id
FROM _repaired_rooms rr
JOIN guesthub.sellable_unit_rooms sur ON sur.room_id = rr.room_id
JOIN guesthub.pricing_plans p
  ON p.tenant_id = sur.tenant_id AND p.sellable_unit_id IS NULL
 AND p.is_active AND NOT p.is_archived
ON CONFLICT (pricing_plan_id, sellable_unit_id) DO NOTHING;

DROP TABLE _repaired_rooms;

-- ---- 5. tenant-consistency guards ----
-- A membership row can no longer pair a room and a unit from different
-- tenants. (One active SU per room is already UNIQUE (room_id) from 009.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_sellable_units_tenant_id
  ON guesthub.sellable_units(tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rooms_tenant_id
  ON guesthub.rooms(tenant_id, id);
ALTER TABLE guesthub.sellable_unit_rooms DROP CONSTRAINT IF EXISTS su_rooms_unit_tenant_fkey;
ALTER TABLE guesthub.sellable_unit_rooms ADD CONSTRAINT su_rooms_unit_tenant_fkey
  FOREIGN KEY (tenant_id, sellable_unit_id)
  REFERENCES guesthub.sellable_units(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE guesthub.sellable_unit_rooms DROP CONSTRAINT IF EXISTS su_rooms_room_tenant_fkey;
ALTER TABLE guesthub.sellable_unit_rooms ADD CONSTRAINT su_rooms_room_tenant_fkey
  FOREIGN KEY (tenant_id, room_id)
  REFERENCES guesthub.rooms(tenant_id, id) ON DELETE CASCADE;

-- ---- 6. orphan-archive trigger — the DB-level backstop ----
-- Whatever deletes the last membership row of a unit (app flow, direct SQL,
-- room-delete cascade), the unit stops being sellable immediately. The app
-- flow deletes the unit itself for a never-used room; this catches the rest.
CREATE OR REPLACE FUNCTION guesthub.archive_orphan_sellable_unit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE guesthub.sellable_units su SET is_active = false
  WHERE su.id = OLD.sellable_unit_id AND su.is_active
    AND NOT EXISTS (SELECT 1 FROM guesthub.sellable_unit_rooms sur
                    WHERE sur.sellable_unit_id = su.id);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_su_rooms_orphan_archive ON guesthub.sellable_unit_rooms;
CREATE TRIGGER trg_su_rooms_orphan_archive
  AFTER DELETE ON guesthub.sellable_unit_rooms
  FOR EACH ROW EXECUTE FUNCTION guesthub.archive_orphan_sellable_unit();
