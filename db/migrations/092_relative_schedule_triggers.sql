-- ============================================================
--  092 · Relative schedule — complete the anchor × when grid (D201)
--
--  A scheduled automation is anchor (check_in | check_out) × when
--  (before | on | after) × offsetDays × sendTime. Three of the six cells
--  already existed as trigger ids (pre_arrival, check_in_day, post_checkout);
--  this migration only widens the closed trigger_type CHECK (061) to admit the
--  other three:
--    reservation.post_check_in   — after check-in  (in stay, by date)
--    reservation.pre_departure   — before check-out (in stay, by date)
--    reservation.check_out_day   — on check-out
--
--  Backward compatible by construction: the CHECK only GROWS, so every
--  existing row stays valid; no column, key format, timing_config shape or
--  occurrence_key changes. NO seeds, NO status changes, NO backfill — nothing
--  sends on migrate.
-- ============================================================

SET search_path TO "guesthub", public;

ALTER TABLE communication_automations DROP CONSTRAINT IF EXISTS communication_automations_trigger_type_check;
DO $$ BEGIN
  ALTER TABLE communication_automations ADD CONSTRAINT communication_automations_trigger_type_check
    CHECK (trigger_type IN ('reservation.confirmed','reservation.cancelled',
                            'reservation.pre_arrival','reservation.check_in_day',
                            'reservation.post_checkout',
                            'reservation.post_check_in','reservation.pre_departure',
                            'reservation.check_out_day'));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
