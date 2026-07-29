-- ============================================================
--  061 · Communication triggers — beyond reservation.confirmed
--
--  The automation engine gains 4 new triggers (cancelled, pre_arrival,
--  check_in_day, post_checkout) and WhatsApp delivery. Structurally the D36
--  schema already fits (trigger_type is text, timing_config is jsonb, the
--  outbound channel CHECK includes whatsapp). Three additions:
--
--  1. outbound_messages.eligible_statuses — the reservation statuses a QUEUED
--     delivery stays valid for. The pre-send eligibility pass used to hardcode
--     status='confirmed', which would wrongly cancel queued CANCELLATION
--     messages (status='cancelled') and post-checkout messages. The default
--     {confirmed} reproduces the old behavior exactly for legacy rows.
--
--  2. A CHECK constraint closing trigger_type to the 5 known ids (all existing
--     rows are 'reservation.confirmed').
--
--  3. Partial indexes for the scheduler's daily scan over reservations by
--     check_in / check_out.
--
--  NO seeds, NO status changes, NO backfill — nothing sends on migrate.
-- ============================================================

SET search_path TO "guesthub", public;

ALTER TABLE outbound_messages
  ADD COLUMN IF NOT EXISTS eligible_statuses text[] NOT NULL DEFAULT ARRAY['confirmed'];

ALTER TABLE communication_automations DROP CONSTRAINT IF EXISTS communication_automations_trigger_type_check;
DO $$ BEGIN
  ALTER TABLE communication_automations ADD CONSTRAINT communication_automations_trigger_type_check
    CHECK (trigger_type IN ('reservation.confirmed','reservation.cancelled',
                            'reservation.pre_arrival','reservation.check_in_day',
                            'reservation.post_checkout'));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- Scheduler scan: "confirmed, non-test reservations whose check_in/check_out
-- equals <date>" — one probe per active scheduled automation per tick.
CREATE INDEX IF NOT EXISTS reservations_comm_checkin_idx
  ON reservations (tenant_id, check_in)
  WHERE status = 'confirmed' AND NOT is_test;
CREATE INDEX IF NOT EXISTS reservations_comm_checkout_idx
  ON reservations (tenant_id, check_out)
  WHERE status IN ('checked_out','confirmed','checked_in') AND NOT is_test;
