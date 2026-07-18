-- ============================================================
--  GuestHub · Stage 3 — database-level double-booking prevention (defects H1, H2, M3).
--
--  Until now, overbooking was prevented ONLY in application code (lockRooms()
--  FOR UPDATE + check_room_availability() inside the reservation transaction).
--  Two historical direct-SQL bypass incidents are on record (026/028). This
--  migration adds the last line of defense at the database level per ADR-0003:
--  a PostgreSQL exclusion constraint that makes two overlapping BLOCKING stays
--  on the same physical room impossible, no matter what code path writes.
--
--  Because reservation status lives on the parent `reservations` row (an
--  exclusion constraint can only see columns of its own table), we maintain a
--  denormalized `is_blocking` flag on reservation_rooms via triggers, and scope
--  the exclusion to blocking rows only. Stay ranges are half-open [check_in,
--  check_out) so same-day checkout+checkin on one room does NOT collide.
--
--  Idempotent. Safe to replay from zero. No data is deleted.
-- ============================================================
SET search_path TO "guesthub", public;

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 1. H2 — constrain reservations.status to the canonical set (mirror of the TS
--    CALENDAR_VISIBLE_STATUSES + cancelled). A typo'd status previously could
--    silently free a room; now it is rejected at write time.
ALTER TABLE guesthub.reservations DROP CONSTRAINT IF EXISTS reservations_status_check;
ALTER TABLE guesthub.reservations
  ADD CONSTRAINT reservations_status_check
  CHECK (status IN ('draft','confirmed','checked_in','checked_out','no_show','blocked','cancelled'));

-- 2. denormalized blocking flag on reservation_rooms ------------------------
ALTER TABLE guesthub.reservation_rooms
  ADD COLUMN IF NOT EXISTS is_blocking boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN guesthub.reservation_rooms.is_blocking IS
  'Trigger-maintained mirror of (room_id IS NOT NULL AND parent reservation.status ∈ inventory_blocking_statuses()). Scopes the double-booking exclusion constraint. Never set by hand.';

-- keep is_blocking correct when the reservation_rooms row itself changes
CREATE OR REPLACE FUNCTION guesthub.rr_set_blocking() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.is_blocking := (NEW.room_id IS NOT NULL) AND EXISTS (
    SELECT 1 FROM guesthub.reservations r
    WHERE r.id = NEW.reservation_id
      AND r.status = ANY (guesthub.inventory_blocking_statuses()));
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_rr_set_blocking ON guesthub.reservation_rooms;
CREATE TRIGGER trg_rr_set_blocking
  BEFORE INSERT OR UPDATE OF room_id, reservation_id, check_in, check_out
  ON guesthub.reservation_rooms
  FOR EACH ROW EXECUTE FUNCTION guesthub.rr_set_blocking();

-- propagate a parent status change down to its rooms (this is the moment a
-- draft→confirmed transition is checked against the exclusion constraint)
CREATE OR REPLACE FUNCTION guesthub.res_propagate_blocking() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE guesthub.reservation_rooms rr
       SET is_blocking = (rr.room_id IS NOT NULL)
                         AND (NEW.status = ANY (guesthub.inventory_blocking_statuses()))
     WHERE rr.reservation_id = NEW.id
       AND rr.is_blocking <> ((rr.room_id IS NOT NULL)
                         AND (NEW.status = ANY (guesthub.inventory_blocking_statuses())));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_res_propagate_blocking ON guesthub.reservations;
CREATE TRIGGER trg_res_propagate_blocking
  AFTER UPDATE OF status ON guesthub.reservations
  FOR EACH ROW EXECUTE FUNCTION guesthub.res_propagate_blocking();

-- 3. backfill the flag for existing rows -----------------------------------
UPDATE guesthub.reservation_rooms rr
   SET is_blocking = (rr.room_id IS NOT NULL) AND EXISTS (
     SELECT 1 FROM guesthub.reservations r
     WHERE r.id = rr.reservation_id
       AND r.status = ANY (guesthub.inventory_blocking_statuses()))
 WHERE rr.is_blocking IS DISTINCT FROM ((rr.room_id IS NOT NULL) AND EXISTS (
     SELECT 1 FROM guesthub.reservations r
     WHERE r.id = rr.reservation_id
       AND r.status = ANY (guesthub.inventory_blocking_statuses())));

-- 4. H1/M3 — the exclusion constraint: no two blocking stays overlap on a room.
--    (EXCLUDE constraints cannot be NOT VALID; added directly. The backfill above
--    plus the Stage-1 audit both confirmed zero existing overlaps, so ADD is safe.)
ALTER TABLE guesthub.reservation_rooms DROP CONSTRAINT IF EXISTS rr_no_double_booking;
ALTER TABLE guesthub.reservation_rooms
  ADD CONSTRAINT rr_no_double_booking
  EXCLUDE USING gist (
    room_id WITH =,
    daterange(check_in, check_out, '[)') WITH &&
  ) WHERE (is_blocking);

COMMENT ON CONSTRAINT rr_no_double_booking ON guesthub.reservation_rooms IS
  'H1/ADR-0003: last-line-of-defense against double booking — two blocking (confirmed/checked_in/blocked) stays cannot overlap on the same room. Half-open [check_in,check_out). App still holds lockRooms()+check_room_availability() for friendly errors.';
