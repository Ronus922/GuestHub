-- 057 — a room that reaches no channel must SAY SO (B5.2).
--
-- WHY. `loadRoomMappings` (beds24-booking-import.ts) builds the pull's
-- mapping snapshot from `channel_beds24_room_mappings … status = 'mapped'`,
-- and `runBeds24InboundPull` returns at `mappings.size === 0` before importing
-- a single revision. Worse, `loadBeds24InboundConnections` itself carries
--   AND EXISTS (SELECT 1 FROM channel_beds24_room_mappings m
--               WHERE m.connection_id = … AND m.status = 'mapped')
-- (comment "review W-1"), so a connection whose every room got unmapped is not
-- even POLLED: ensureInboundPullJobs skips it AND ensureReconcileJobs skips it.
-- No job, no dead letter, no error row — total silence. That filter traded
-- retry noise for blindness, and nothing was ever put in its place.
--
-- Measured on production 2026-07-25: 14 of 16 rooms carry a live mapping (all
-- to Beds24 property 342449). Room "1318" — a genuinely sold room with
-- back-office reservations — has none, so its availability reaches no OTA and
-- nobody is told. Room "חניה זמנית" (room_number 1000) also has none, but that
-- one is CORRECT: it is a parking pseudo-room and was never meant to be
-- distributed.
--
-- The alert therefore needs one thing the schema could not express: the
-- difference between "deliberately not distributed" and "silently missing".
-- Absence of a mapping is not evidence of intent (the same rule D93 applies to
-- a booking missing from a provider response), so intent gets its own explicit
-- column instead of being inferred.

-- ---- 1. explicit distribution intent, per room ----
-- FALSE (the default) = this room is expected to reach the channel manager; a
-- missing or non-'mapped' mapping row is a DEFECT and raises an alert.
-- TRUE  = the operator has declared this room is not distributed; the audit
-- stays quiet about it. It changes NOTHING about sellability, availability,
-- occupancy, the calendar or the website — it is an alerting policy flag only.
ALTER TABLE guesthub.rooms
  ADD COLUMN IF NOT EXISTS channel_distribution_excluded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS channel_distribution_excluded_reason text;

COMMENT ON COLUMN guesthub.rooms.channel_distribution_excluded IS
  'Alerting policy only: TRUE = deliberately not distributed to the channel manager, so the mapping audit stays silent about it. Never affects sellability or inventory.';

-- ---- 2. the audit''s own durable job type (additive CHECK widening) ----
-- 'audit_room_mappings' — a pure-DB, no-network sweep. It MUST be its own job
-- type and not a passenger on 'reconcile_inventory': reconcile jobs are
-- enqueued from loadBeds24InboundConnections, which is exactly the loader that
-- goes empty in the failure this alert exists to catch.
ALTER TABLE guesthub.channel_sync_jobs DROP CONSTRAINT IF EXISTS channel_sync_jobs_job_type_check;
ALTER TABLE guesthub.channel_sync_jobs ADD  CONSTRAINT channel_sync_jobs_job_type_check
  CHECK (job_type IN (
    'validate_connection','full_sync','sync_availability','sync_rates',
    'sync_restrictions','sync_ari_range','pull_booking_revisions',
    'import_booking_revision','acknowledge_booking_revision',
    'reconcile_inventory','retry_failed_range',
    'sync_room_types','create_room_type',
    'sync_rate_plans','create_rate_plan',
    'audit_room_mappings'));

-- ---- 3. the one room the owner has ruled is deliberately not distributed ----
-- Owner ruling (Ronen, 2026-07-25): "1318 is to be mapped; חניה זמנית is to be
-- marked deliberately-not-distributed." Marking it here is what stops the new
-- alert from crying wolf on its very first run. Room 1318 is deliberately NOT
-- touched — its mapping is being restored on a separate branch, and silencing
-- it here would hide the defect this whole change exists to surface.
--
-- Narrow and self-limiting on purpose:
--   · keyed on the exact room name, never on a uuid or a tenant;
--   · refuses to fire for a room that HAS a live mapping, so it can never
--     silence a room that is actually distributed;
--   · idempotent — re-running changes nothing, and an operator who clears the
--     flag by hand does not get it silently set again by a replay, because a
--     replay only ever touches rows still at the default.
UPDATE guesthub.rooms r
   SET channel_distribution_excluded = true,
       channel_distribution_excluded_reason =
         'חניית שירות — פסאודו-חדר תפעולי, לא מופץ לערוצים (החלטת בעלים 25/07/2026)'
 WHERE r.name = 'חניה זמנית'
   AND r.channel_distribution_excluded = false
   AND r.channel_distribution_excluded_reason IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM guesthub.channel_beds24_room_mappings m
      WHERE m.room_id = r.id AND m.status = 'mapped');
