-- ============================================================
--  GuestHub · D54 — Room inventory cleanup (canonical options + drop test types).
--
--  Commit 44ac035 ("canonical building/floor/room-type options") corrected the
--  building and room-type OPTION rows as LIVE data operations, not code:
--    - buildings (guesthub.areas)  renamed  בניין ראשי → צפוני, אגף הבריכה → דרומי
--    - room types renamed          דירת חדר שינה → חדר שינה וסלון, סוויטה משפחתית → סוויטה
--    - 3 extra room types were INSERTED live (never seeded).
--  Because those were live-only, a fresh env / re-seed would not match this DB.
--  This migration captures the renames reproducibly AND reverses the 3 inserts:
--  the owner confirmed those 3 types are unrecognised test cruft (0 rooms use
--  them) and will build real inventory from scratch in the UI.
--
--  What it does (all idempotent — safe to re-run, no-op on a freshly seeded env):
--    1. Rename the legacy building / room-type option names to canonical, only
--       when the canonical name does not already exist (never creates a dupe).
--    2. DELETE the 3 orphan room types
--         ('2 חדרי שינה וסלון', 'יחידה משפחתית', 'פנטהאוז')
--       GUARDED: a type is removed only if NO room references it. A type that is
--       in use is left untouched (so this can never orphan a live room).
--
--  Rooms, reservations, the 3 real room types (סטודיו / חדר שינה וסלון / סוויטה)
--  and the 2 buildings are PRESERVED. Only aggregate counts are logged.
--
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/021_room_inventory_cleanup.sql
--
--  ROLLBACK: the renames are reversible by name; the 3 deleted test types are
--  not restored (they were test data — rebuild via the Rooms UI if ever needed).
-- ============================================================

SET search_path TO "guesthub", public;

-- 1. Canonical option names (rename in place; skip if the canonical name exists) --
UPDATE guesthub.areas a SET name = 'צפוני'
 WHERE a.name = 'בניין ראשי'
   AND NOT EXISTS (SELECT 1 FROM guesthub.areas a2 WHERE a2.tenant_id=a.tenant_id AND a2.name='צפוני');

UPDATE guesthub.areas a SET name = 'דרומי'
 WHERE a.name = 'אגף הבריכה'
   AND NOT EXISTS (SELECT 1 FROM guesthub.areas a2 WHERE a2.tenant_id=a.tenant_id AND a2.name='דרומי');

UPDATE guesthub.room_types rt SET name = 'חדר שינה וסלון'
 WHERE rt.name = 'דירת חדר שינה'
   AND NOT EXISTS (SELECT 1 FROM guesthub.room_types t2 WHERE t2.tenant_id=rt.tenant_id AND t2.name='חדר שינה וסלון');

UPDATE guesthub.room_types rt SET name = 'סוויטה'
 WHERE rt.name = 'סוויטה משפחתית'
   AND NOT EXISTS (SELECT 1 FROM guesthub.room_types t2 WHERE t2.tenant_id=rt.tenant_id AND t2.name='סוויטה');

-- 2. Drop the 3 orphan test room types — only those with no rooms attached --
DO $$
DECLARE
  removed bigint := 0;
BEGIN
  WITH del AS (
    DELETE FROM guesthub.room_types rt
     WHERE rt.name IN ('2 חדרי שינה וסלון', 'יחידה משפחתית', 'פנטהאוז')
       AND NOT EXISTS (SELECT 1 FROM guesthub.rooms r WHERE r.room_type_id = rt.id)
    RETURNING 1)
  SELECT count(*) INTO removed FROM del;
  RAISE NOTICE 'D54 room inventory cleanup — orphan test room types removed: %', removed;
END $$;
