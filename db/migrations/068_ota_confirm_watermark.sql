-- ============================================================
--  068 — OTA confirm cutover watermark (D119)
--
--  THE RISK THIS CLOSES. From this release the Beds24 import emits a
--  `reservation.confirmed` event when it CREATES a reservation, so Ronen can
--  send his own WhatsApp to guests who book through an OTA. The only thing that
--  has ever stopped a confirm event firing twice is the occurrence key
--    reservation:<id>:confirmed:v1
--  under UNIQUE (tenant_id, event_type, aggregate_type, occurrence_key)
--  (migration 036) — dedupe that lives DOWNSTREAM of the emission, in this very
--  table. It guarantees "never a SECOND event". It is powerless against a FIRST
--  event for a reservation that already exists.
--
--  Measured on production before this migration was written (2026-07-31):
--    · 72 reservations, 50 confirm events, 22 reservations with NO confirm event
--    · all 20 OTA reservations were among the 22 — every one of them
--    · 18 of those 20 sat inside the import's LOOKBACK_DAYS = 7 window, so the
--      next incremental pull re-sees them
--  Without this watermark, that pull would have created first-ever confirm
--  events for 10 already-confirmed OTA reservations — real WhatsApps to guests
--  who booked weeks ago.
--
--  THE WATERMARK. Take the occurrence key of every reservation that exists at
--  cutover and OCCUPY it with an already-processed row. The unique index then
--  does exactly what it is good at: the key is taken forever, so no emitter can
--  ever produce a live event for a pre-existing reservation, whatever path it
--  arrives on. Only reservations created AFTER this migration can emit.
--
--  Why status='processed' and not 'pending': claimCommunicationEvents (outbox.ts)
--  claims rows whose status is 'pending', or 'processing' with an expired lease.
--  A 'processed' row is invisible to the worker by the same rule that makes a
--  finished event invisible — no new state, no special case. processed_at is set
--  so the row is not a lie about its own lifecycle, and the payload names the
--  migration that wrote it, so a watermark row can always be told apart from a
--  real one. Nothing in the app READS communication_events outside the worker's
--  claim (grep: only scheduler.ts writes, outbox.ts claims), so these rows
--  surface on no screen.
--
--  EVERY reservation, not only OTA. The cutover is about time, not origin: the
--  guarantee "no pre-existing reservation can ever emit its first confirmation"
--  must not depend on which path later learns how to emit. The two
--  direct_website rows that also lacked an event are covered by the same sweep.
--
--  IDEMPOTENT twice over: the NOT EXISTS skips keys already taken, and
--  ON CONFLICT DO NOTHING catches a concurrent writer. A second run writes 0
--  rows and still passes both assertions below.
--
--  FAIL-CLOSED: the row count written must EQUAL the number of reservations
--  lacking the key at that moment, and nothing may be left uncovered. A partial
--  watermark is worse than none — it would look like protection while leaving a
--  live reservation able to fire. Either assertion aborts the migration, which
--  aborts the deploy before any pm2 restart (deploy-production.sh runs
--  migrations after the build and BEFORE the restart), so the emitting code
--  never starts against an incomplete watermark.
-- ============================================================

SET search_path TO "guesthub", public;

DO $$
DECLARE
  missing_before int;
  written        int;
  missing_after  int;
BEGIN
  SELECT count(*) INTO missing_before
  FROM reservations r
  WHERE NOT EXISTS (
    SELECT 1 FROM communication_events e
    WHERE e.tenant_id = r.tenant_id
      AND e.event_type = 'reservation.confirmed'
      AND e.aggregate_type = 'reservation'
      AND e.occurrence_key = 'reservation:' || r.id || ':confirmed:v1');

  INSERT INTO communication_events
    (tenant_id, event_type, aggregate_type, reservation_id, source,
     occurrence_key, payload, status, occurred_at, processed_at)
  SELECT r.tenant_id, 'reservation.confirmed', 'reservation', r.id, r.booking_origin,
         'reservation:' || r.id || ':confirmed:v1',
         jsonb_build_object('watermark', 'cutover', 'migration', '068_ota_confirm_watermark'),
         'processed', now(), now()
  FROM reservations r
  WHERE NOT EXISTS (
    SELECT 1 FROM communication_events e
    WHERE e.tenant_id = r.tenant_id
      AND e.event_type = 'reservation.confirmed'
      AND e.aggregate_type = 'reservation'
      AND e.occurrence_key = 'reservation:' || r.id || ':confirmed:v1')
  ON CONFLICT (tenant_id, event_type, aggregate_type, occurrence_key) DO NOTHING;
  GET DIAGNOSTICS written = ROW_COUNT;

  SELECT count(*) INTO missing_after
  FROM reservations r
  WHERE NOT EXISTS (
    SELECT 1 FROM communication_events e
    WHERE e.tenant_id = r.tenant_id
      AND e.event_type = 'reservation.confirmed'
      AND e.aggregate_type = 'reservation'
      AND e.occurrence_key = 'reservation:' || r.id || ':confirmed:v1');

  RAISE NOTICE '068 watermark: % reservation(s) lacked a confirm-event key, % row(s) written, % remaining',
    missing_before, written, missing_after;

  IF written <> missing_before THEN
    RAISE EXCEPTION '068 watermark: wrote % row(s) for % reservation(s) lacking a confirm-event key — the cutover must be exact',
      written, missing_before;
  END IF;
  IF missing_after <> 0 THEN
    RAISE EXCEPTION '068 watermark: % reservation(s) still lack a confirm-event key after the backfill',
      missing_after;
  END IF;
END $$;
