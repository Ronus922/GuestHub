-- ============================================================
--  028 · Canonical room identity (D74)
--  Additive + idempotent. The rooms table becomes the single source of truth
--  for the identity (code / name / room type) of every sole-member sellable
--  unit — the Rate Grid and Group Update stop showing stale copied labels.
--
--  Forensics (production, 2026-07-10):
--    · The 009 backfill copied the THEN-current room numbers (101/102/103/
--      201/202/203/301/G1..G5) and room types into sellable_units.code/name/
--      room_type_id. The rooms were later renamed to the canonical hotel
--      numbers (926..1424, D54) and re-typed, but the copies stayed frozen —
--      so /rates and Group Update displayed "101" for the room that is
--      physically 1329, and 9 of 13 units carried the WRONG room type,
--      inheriting the wrong base price on dates with no explicit rate row
--      (the booking engine reads the room's type — effective-state.ts — so
--      grid and engine disagreed on inherited prices).
--    · The one-to-one relationship itself was already correct: 13 units,
--      13 rooms, sellable_unit_rooms UNIQUE(room_id), no orphans (D66).
--
--  This migration:
--    1. backs up every sellable_units row it is about to change into
--       guesthub.sellable_units_backup_028 (with the old→new map);
--    2. reconciles each sole-member unit to its room: code ← room_number,
--       name ← room name, room_type_id ← the room's type. A code collision
--       with another historical unit gets a '#<room-id-8>' suffix, same as
--       ensureSellableUnit;
--    3. adds trg_rooms_mirror_identity: any future room rename / room-type
--       change mirrors into the sole-member unit at the DB level — even via
--       direct SQL, the path that caused D66. Pooled units (>1 member room)
--       keep their own identity and are never touched.
--
--  No Channex table is touched; no pricing_plan_rates row is touched; no
--  network is involved. Prices and restrictions are preserved bit-for-bit.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/028_canonical_room_identity.sql
--
--  ROLLBACK:
--    UPDATE guesthub.sellable_units su
--    SET code = b.code, name = b.name, room_type_id = b.room_type_id
--    FROM guesthub.sellable_units_backup_028 b WHERE b.id = su.id;
--    DROP TRIGGER IF EXISTS trg_rooms_mirror_identity ON guesthub.rooms;
--    DROP FUNCTION IF EXISTS guesthub.mirror_room_identity_to_unit();
-- ============================================================

SET search_path TO "guesthub", public;

-- ---- 1. backup the rows about to be reconciled (idempotent: only rows that
--         still differ from their room are captured, so a re-run adds nothing) ----
CREATE TABLE IF NOT EXISTS guesthub.sellable_units_backup_028 (
  LIKE guesthub.sellable_units,
  backed_up_at timestamptz NOT NULL DEFAULT now(),
  new_code text,
  room_id uuid,
  room_number text
);

INSERT INTO guesthub.sellable_units_backup_028
SELECT su.*, now(), r.room_number, r.id, r.room_number
FROM guesthub.sellable_units su
JOIN guesthub.sellable_unit_rooms sur ON sur.sellable_unit_id = su.id
JOIN guesthub.rooms r ON r.id = sur.room_id
WHERE NOT EXISTS (SELECT 1 FROM guesthub.sellable_unit_rooms s2
                  WHERE s2.sellable_unit_id = su.id AND s2.room_id <> r.id)
  AND (su.code IS DISTINCT FROM r.room_number
       OR su.name IS DISTINCT FROM COALESCE(NULLIF(r.name, ''), r.room_number)
       OR su.room_type_id IS DISTINCT FROM r.room_type_id)
  AND NOT EXISTS (SELECT 1 FROM guesthub.sellable_units_backup_028 b WHERE b.id = su.id);

-- ---- 2. reconcile sole-member units to their room's identity ----
DO $$
DECLARE fixed integer;
BEGIN
  WITH sole AS (
    SELECT sur.sellable_unit_id AS su_id, r.id AS room_id, r.tenant_id,
           r.room_number, COALESCE(NULLIF(r.name, ''), r.room_number) AS room_name,
           r.room_type_id
    FROM guesthub.sellable_unit_rooms sur
    JOIN guesthub.rooms r ON r.id = sur.room_id
    WHERE NOT EXISTS (SELECT 1 FROM guesthub.sellable_unit_rooms s2
                      WHERE s2.sellable_unit_id = sur.sellable_unit_id
                        AND s2.room_id <> sur.room_id)
  )
  UPDATE guesthub.sellable_units su
  SET code = CASE
        WHEN EXISTS (SELECT 1 FROM guesthub.sellable_units x
                     WHERE x.tenant_id = s.tenant_id AND x.id <> su.id
                       AND x.code = s.room_number)
        THEN s.room_number || '#' || left(s.room_id::text, 8)
        ELSE s.room_number
      END,
      name = s.room_name,
      room_type_id = s.room_type_id
  FROM sole s
  WHERE su.id = s.su_id
    AND (su.code IS DISTINCT FROM s.room_number
         OR su.name IS DISTINCT FROM s.room_name
         OR su.room_type_id IS DISTINCT FROM s.room_type_id);
  GET DIAGNOSTICS fixed = ROW_COUNT;
  RAISE NOTICE '028: reconciled % sellable unit(s) to their room identity', fixed;
END $$;

-- ---- 3. mirror future room identity changes into the sole-member unit ----
CREATE OR REPLACE FUNCTION guesthub.mirror_room_identity_to_unit()
RETURNS trigger AS $$
DECLARE
  v_su_id uuid;
  v_code text;
  v_name text;
BEGIN
  -- only a sole-member unit mirrors the room; a pooled unit is its own identity
  SELECT sur.sellable_unit_id INTO v_su_id
  FROM guesthub.sellable_unit_rooms sur
  WHERE sur.room_id = NEW.id
    AND NOT EXISTS (SELECT 1 FROM guesthub.sellable_unit_rooms s2
                    WHERE s2.sellable_unit_id = sur.sellable_unit_id
                      AND s2.room_id <> NEW.id)
  LIMIT 1;
  IF v_su_id IS NULL THEN RETURN NEW; END IF;

  v_code := COALESCE(NULLIF(NEW.room_number, ''), 'unit-' || left(NEW.id::text, 8));
  IF EXISTS (SELECT 1 FROM guesthub.sellable_units x
             WHERE x.tenant_id = NEW.tenant_id AND x.id <> v_su_id AND x.code = v_code) THEN
    v_code := v_code || '#' || left(NEW.id::text, 8);
  END IF;
  v_name := COALESCE(NULLIF(NEW.name, ''), v_code);

  UPDATE guesthub.sellable_units
  SET code = v_code, name = v_name, room_type_id = NEW.room_type_id
  WHERE id = v_su_id
    AND (code IS DISTINCT FROM v_code
         OR name IS DISTINCT FROM v_name
         OR room_type_id IS DISTINCT FROM NEW.room_type_id);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rooms_mirror_identity ON guesthub.rooms;
CREATE TRIGGER trg_rooms_mirror_identity
AFTER UPDATE OF room_number, name, room_type_id ON guesthub.rooms
FOR EACH ROW EXECUTE FUNCTION guesthub.mirror_room_identity_to_unit();
