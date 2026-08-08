-- ============================================================
--  081 — booking_channel_reports: the ACTIVE write gap, closed point-wise
--
--  THE DEFECT (measured in production 2026-08-08, recorded in D144):
--  src/lib/channel/booking-com-reports-core.ts writeLedgerRow() runs
--    INSERT INTO guesthub.booking_channel_reports ...
--  as guesthub_app — on BOTH the success and the reject path of
--  submitBookingComReport — and the table carries no INSERT for that role
--  (owner supabase_admin; 080 granted SELECT only, by its own decree). The
--  table holds 0 rows in production: the write path has never succeeded.
--
--  SCOPE, DELIBERATELY MINIMAL (D144 is still open — this is the point fix
--  its closing note allows, not the general answer):
--    · INSERT on guesthub.booking_channel_reports ONLY. The path performs no
--      UPDATE and no DELETE on it (verified: writeLedgerRow is the single
--      writer), so neither is granted.
--    · No sequence exists (id is uuid gen_random_uuid()) — no USAGE needed.
--    · stampReservation's UPDATE targets guesthub.reservations, which already
--      carries full app grants (postgres-era default ACL) — nothing to add.
--    · schema_migrations stays SELECT-only (080's decree, untouched).
--    · ALTER DEFAULT PRIVILEGES stays as 080 left it — widening it is exactly
--      the D144 decision Ronen has not made yet.
--
--  Idempotent: GRANT re-applies as a no-op. No ownership changes.
--
--  ROLLBACK (manual):
--    REVOKE INSERT ON guesthub.booking_channel_reports FROM guesthub_app;
-- ============================================================

SET search_path TO "guesthub", public;

GRANT INSERT ON guesthub.booking_channel_reports TO guesthub_app;
