-- ============================================================
--  077 — GRANTs for the 076 ingest tables (hotfix)
--
--  THE DEFECT, MEASURED ON THE FIRST LIVE TICK AFTER THE 306422f DEPLOY:
--  both new jobs landed in retry_wait with
--    "permission denied for table guest_conversations"
--    "permission denied for table channel_reviews"
--
--  WHY. The migration runner executes as supabase_admin, and in this cluster
--  the guesthub-schema DEFAULT PRIVILEGES that auto-grant guesthub_app exist
--  only for tables created by the *postgres* role (pg_default_acl, measured):
--    postgres       → service_role + guesthub_app
--    supabase_admin → service_role ONLY
--  So every table 076 created is invisible to the app/worker role. The house
--  convention is an EXPLICIT per-table grant in the creating migration —
--  045 (channel_beds24_room_mappings) and 047 (reservation_cards) both do it —
--  and 076 omitted it. This migration is that missing block; 076 itself is
--  already applied-and-recorded in production and is never edited after the
--  fact, so the grants ship as their own file.
--
--  WHY THE DEV VERIFICATION MISSED IT. The replay + poller ticks ran as
--  supabase_admin — the table OWNER — so no permission was ever exercised.
--  The fix below is verified the right way: a poller tick executed AS
--  guesthub_app against a replayed schema.
--
--  GRANTS ARE MINIMAL, PER THE WRITE PATHS (write paths in
--  src/lib/messaging/guest-conversations.ts, src/lib/channel/beds24-reviews.ts):
--    guest_conversations — INSERT (upsert), UPDATE (COALESCE link fill +
--                          inbox stamps), SELECT. No DELETE path exists.
--    guest_messages      — INSERT + SELECT only. Append-only BY DOCTRINE:
--                          nothing updates or deletes a message, and the
--                          missing grant enforces that doctrine at the DB.
--    channel_reviews     — INSERT (first ingest), UPDATE (late `reply`
--                          upsert), SELECT. No DELETE path exists.
--  service_role already holds ALL via supabase_admin's default ACL; granted
--  explicitly anyway to match 045's belt-and-braces style.
--
--  No tables, no columns, no data. Idempotent (GRANT re-applies cleanly).
--
--  ROLLBACK (manual):
--    REVOKE ALL ON guesthub.guest_conversations, guesthub.guest_messages,
--      guesthub.channel_reviews FROM guesthub_app;
-- ============================================================

SET search_path TO "guesthub", public;

GRANT SELECT, INSERT, UPDATE ON guesthub.guest_conversations TO guesthub_app;
GRANT SELECT, INSERT         ON guesthub.guest_messages      TO guesthub_app;
GRANT SELECT, INSERT, UPDATE ON guesthub.channel_reviews     TO guesthub_app;

GRANT ALL ON guesthub.guest_conversations TO service_role;
GRANT ALL ON guesthub.guest_messages      TO service_role;
GRANT ALL ON guesthub.channel_reviews     TO service_role;
