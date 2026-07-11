-- ============================================================
-- 033 — Expected arrival time (additive, idempotent)
--
-- WHY: Channex booking revisions supply `arrival_hour` ("13:00"). Until now it
-- was dropped on import. It becomes a DEDICATED reservation field ("שעת הגעה
-- משוערת") — never appended to guest notes, editable in the booking panel,
-- updated by OTA modifications, and never erased just because a later revision
-- omits the value (import COALESCEs).
--
-- NULL = the guest never stated an arrival time (nothing is fabricated).
-- The pre-existing check_in_time column is the property's policy check-in hour
-- (NOT NULL default 15:00) — a different meaning; it stays untouched.
-- ============================================================

ALTER TABLE guesthub.reservations
  ADD COLUMN IF NOT EXISTS expected_arrival_time time NULL;
