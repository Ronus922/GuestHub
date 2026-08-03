-- ============================================================
--  073 — D126: הזמנה בכל סטטוס תופסת מלאי, עד שהיא מבוטלת
--
--  WHAT THIS CHANGES. guesthub.inventory_blocking_statuses() — THE single
--  source of truth for "does this reservation consume a room" — grows from
--  ('confirmed','checked_in','blocked') to every status except 'cancelled'.
--  Nothing else in the schema changes: every availability path already calls
--  this function, so replacing it moves the whole system at once.
--
--  WHY. Until now a 'draft' reservation was drawn on the calendar but consumed
--  nothing. The room read "פנוי" while a stay sat on it, guesthub.
--  check_room_availability() reported it free, the rr_no_double_booking
--  exclusion constraint did not cover it, and room_type_inventory() /
--  sellable_unit_inventory() kept publishing it to Beds24 as available. A
--  draft was therefore a direct path to a double booking — measured live on
--  2026-08-03: room 1424 showed "פנוי" with reservation 1077 (draft) on it.
--  Owner decision (D126): a reservation is a reservation in every status; only
--  cancelling it releases the nights.
--
--  WHY 'checked_out' AND 'no_show' TOO. They are not cancellations. The stay
--  ranges are half-open [check_in, check_out), so a checked-out stay only ever
--  holds the nights it actually consumed — the departure date itself stays
--  sellable. A no-show keeps its night until a human cancels or shortens the
--  reservation, which is the action that records WHY the room was released.
--
--  THE BLAST RADIUS OF THIS ONE FUNCTION (all pre-existing callers):
--    004 check_room_availability()   — the write-path availability check
--    005 room_type_inventory()       — ARI availability pushed to Beds24
--    006 unknown-room availability
--    009 sellable_unit_inventory()   — ARI availability per Sellable Unit
--    037 rr_set_blocking() / res_propagate_blocking() — the is_blocking mirror
--        that scopes the rr_no_double_booking EXCLUDE constraint
--    040 typed room closures
--
--  SAFETY. Widening the blocking set widens the exclusion constraint, so the
--  backfill below can only succeed if no two now-blocking stays already
--  overlap on one room. Step 2 proves that FIRST and aborts with a readable
--  list instead of letting Postgres raise a bare exclusion_violation. Verified
--  zero overlaps on production data before writing this migration.
--
--  Idempotent. Safe to replay from zero. No data is deleted.
--
--  ROLLBACK (manual):
--    CREATE OR REPLACE FUNCTION guesthub.inventory_blocking_statuses()
--    RETURNS text[] LANGUAGE sql IMMUTABLE AS
--    $$ SELECT ARRAY['confirmed','checked_in','blocked'] $$;
--    -- then re-run step 3's backfill to shrink is_blocking again.
-- ============================================================
SET search_path TO "guesthub", public;

-- 1. the single source of truth -------------------------------------------
CREATE OR REPLACE FUNCTION guesthub.inventory_blocking_statuses()
RETURNS text[] LANGUAGE sql IMMUTABLE AS
$$ SELECT ARRAY['draft','confirmed','checked_in','checked_out','no_show','blocked'] $$;

COMMENT ON FUNCTION guesthub.inventory_blocking_statuses() IS
  'D126: every reservation status except cancelled consumes inventory. THE source of truth — mirrored in TS by INVENTORY_BLOCKING_STATUSES (src/lib/inventory-rules.ts), asserted equal by scripts/check-inventory.mjs.';

-- 2. prove the widened rule does not collide with existing data ------------
--    (a pair that overlaps today would make step 3 violate rr_no_double_booking)
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(
           format('room %s: %s (%s) %s→%s vs %s (%s) %s→%s',
                  rm.room_number,
                  ra.reservation_number, ra.status, a.check_in, a.check_out,
                  rb.reservation_number, rb.status, b.check_in, b.check_out),
           E'\n')
    INTO offenders
    FROM guesthub.reservation_rooms a
    JOIN guesthub.reservation_rooms b
      ON b.room_id = a.room_id AND b.id > a.id
     AND daterange(a.check_in, a.check_out, '[)') && daterange(b.check_in, b.check_out, '[)')
    JOIN guesthub.reservations ra ON ra.id = a.reservation_id
    JOIN guesthub.reservations rb ON rb.id = b.reservation_id
    JOIN guesthub.rooms rm ON rm.id = a.room_id
   WHERE a.room_id IS NOT NULL
     AND ra.status = ANY (guesthub.inventory_blocking_statuses())
     AND rb.status = ANY (guesthub.inventory_blocking_statuses());

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'D126 blocked: % overlapping stay pair(s) would violate rr_no_double_booking. Cancel or re-date one side of each pair, then re-run.%',
      (length(offenders) - length(replace(offenders, E'\n', ''))) + 1,
      E'\n' || offenders;
  END IF;
END $$;

-- 3. re-derive the denormalized flag under the new rule --------------------
--    The 037 triggers only fire on write; existing rows need this backfill.
--    Every flipped row is validated against rr_no_double_booking as it updates.
UPDATE guesthub.reservation_rooms rr
   SET is_blocking = (rr.room_id IS NOT NULL) AND EXISTS (
     SELECT 1 FROM guesthub.reservations r
     WHERE r.id = rr.reservation_id
       AND r.status = ANY (guesthub.inventory_blocking_statuses()))
 WHERE rr.is_blocking IS DISTINCT FROM ((rr.room_id IS NOT NULL) AND EXISTS (
     SELECT 1 FROM guesthub.reservations r
     WHERE r.id = rr.reservation_id
       AND r.status = ANY (guesthub.inventory_blocking_statuses())));

-- 4. re-publish the affected nights to the channels ------------------------
--    Widening the rule silently changes what room_type_inventory() /
--    sellable_unit_inventory() return, but Beds24 only learns of it when a
--    dirty range exists. Without this step a stay that now blocks locally would
--    STILL be sold as available on the OTAs — the exact double booking D126
--    exists to prevent. One 'availability' range per (connection, room) over
--    the nights of every stay that was not blocking before this migration.
--
--    No job is enqueued here: worker.ts ensureDrainJobs() enqueues one per
--    connection as soon as any pending range is due, so the insert is enough.
--    Ranges are clipped to [today, today + 720) — the ARI horizon of
--    src/lib/channel/ranges.ts. Beds24 rejects a whole batch that straddles it.
INSERT INTO guesthub.channel_dirty_ranges
  (tenant_id, connection_id, room_id, local_rate_plan_id, kind, date_from, date_to)
SELECT DISTINCT
       rr.tenant_id, cc.id, rr.room_id, NULL::uuid, 'availability',
       GREATEST(rr.check_in, CURRENT_DATE),
       LEAST(rr.check_out, CURRENT_DATE + 720)
  FROM guesthub.reservation_rooms rr
  JOIN guesthub.reservations res ON res.id = rr.reservation_id
  JOIN guesthub.channel_connections cc
    ON cc.tenant_id = rr.tenant_id AND cc.state = 'active' AND cc.outbound_sync_enabled
 WHERE rr.room_id IS NOT NULL
   AND rr.check_out > CURRENT_DATE
   AND rr.check_in < CURRENT_DATE + 720
   -- statuses that block ONLY because of this migration
   AND res.status IN ('draft', 'checked_out', 'no_show')
   -- replay-safe: a pending range already covering these nights is enough
   AND NOT EXISTS (
     SELECT 1 FROM guesthub.channel_dirty_ranges d
      WHERE d.connection_id = cc.id AND d.room_id = rr.room_id
        AND d.kind = 'availability' AND d.local_rate_plan_id IS NULL
        AND d.status = 'pending'
        AND d.date_from <= GREATEST(rr.check_in, CURRENT_DATE)
        AND d.date_to   >= LEAST(rr.check_out, CURRENT_DATE + 720));

-- 5. the constraint itself is unchanged; only what it now covers is ---------
COMMENT ON CONSTRAINT rr_no_double_booking ON guesthub.reservation_rooms IS
  'H1/ADR-0003 + D126: two stays that consume inventory cannot overlap on the same room. Since D126 that is every status except cancelled. Half-open [check_in,check_out). App still holds lockRooms()+check_room_availability() for friendly errors.';
