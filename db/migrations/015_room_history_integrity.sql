-- ============================================================
--  015 · Room history integrity + provenance correction (D49 closure audit)
--
--  1. Historical reservations must RETAIN room identity. reservation_rooms.room_id
--     was ON DELETE SET NULL — deleting a room silently orphaned its reservation
--     history. Now RESTRICT: the DB refuses to delete any room referenced by any
--     reservation, past or future. The app layer (deleteRoomAction) blocks first
--     with a category breakdown and points to archiving (is_active=false).
--
--  2. Provenance correction (one-shot): show_on_website=true was set by
--     scripts/complete-rooms-data.mjs together with GENERATED marketing content,
--     sizes, beds and amenities — no human ever reviewed or approved the public
--     content (audit_logs confirm zero manual room edits). Unverified generated
--     content must not be flagged as published. Rooms stay fully operational in
--     the PMS (is_active/status untouched); the owner re-enables מוצג באתר per
--     room in the wizard after reviewing the content.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/015_room_history_integrity.sql
--
--  ROLLBACK:
--    ALTER TABLE guesthub.reservation_rooms DROP CONSTRAINT reservation_rooms_room_id_fkey;
--    ALTER TABLE guesthub.reservation_rooms ADD CONSTRAINT reservation_rooms_room_id_fkey
--      FOREIGN KEY (room_id) REFERENCES guesthub.rooms(id) ON DELETE SET NULL;
--    (publication flags are a product decision — re-enable per room in the UI)
-- ============================================================

BEGIN;

-- ---- 1. reservation history keeps its room ----
ALTER TABLE guesthub.reservation_rooms
  DROP CONSTRAINT IF EXISTS reservation_rooms_room_id_fkey;
ALTER TABLE guesthub.reservation_rooms
  ADD CONSTRAINT reservation_rooms_room_id_fkey
  FOREIGN KEY (room_id) REFERENCES guesthub.rooms(id) ON DELETE RESTRICT;

-- ---- 2. unpublish unverified generated content (one-shot, PMS unaffected) ----
UPDATE guesthub.rooms
SET show_on_website = false
WHERE tenant_id = '68139d06-58c4-4043-b256-4691f83e1556'
  AND show_on_website = true;

COMMIT;
