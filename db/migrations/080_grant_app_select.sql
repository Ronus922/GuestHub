-- ============================================================
--  080 — guesthub_app read access: the two unreadable tables, the replay
--        gap, and the DEFAULT PRIVILEGES root cause
--
--  MEASURED IN PRODUCTION (2026-08-08, via supabase_admin): exactly two
--  tables in schema guesthub carry no SELECT for guesthub_app —
--    schema_migrations        {supabase_admin=arwdDxt,service_role=arwdDxt}
--    booking_channel_reports  {supabase_admin=arwdDxt,service_role=arwdDxt}
--  Both owned by supabase_admin. Every other table is readable.
--
--  MEASURED ON REPLAY-FROM-ZERO (testdb :5433, same date): 58 of 71 tables
--  lack guesthub_app SELECT. Production's broad coverage is HISTORY, not
--  migrations: this cluster's guesthub DEFAULT PRIVILEGES auto-grant
--  guesthub_app only for tables created by the *postgres* role (pg_default_acl,
--  first measured in 077's header), and production's early tables were born
--  under it. The migration runner executes as supabase_admin, whose default
--  ACL grants service_role ONLY — so a rebuilt-from-source schema silently
--  loses read access the live one has. That divergence is exactly the D136
--  failure class, and check:grants (added with this migration) measures a
--  replayed clone — the blanket grant below is what makes replay converge to
--  the production truth.
--
--  THE RECURRING DEFECT (076→077 was the third occurrence): a migration
--  creates a table as supabase_admin, forgets the explicit per-table grant,
--  and the app/worker role hits "permission denied" on the first live tick.
--  The per-table convention treats the symptom; the DEFAULT PRIVILEGES fix
--  below removes the cause: tables supabase_admin creates in guesthub from
--  now on are born with guesthub_app SELECT. Write access stays deliberate
--  and per-table, in the creating migration (045/047/077 style).
--
--  DECIDED, NOT NEGOTIABLE (hardening 2026-08-08):
--    · schema_migrations gets SELECT ONLY — never INSERT/UPDATE/DELETE. The
--      ledger is written by the migration runner in its privileged role;
--      app-side write access would open a path to corrupting the record of
--      what ran (the exact record D136 exists to keep truthful).
--    · SELECT and nothing wider anywhere here. No ownership changes.
--
--  Idempotent: GRANT and ALTER DEFAULT PRIVILEGES re-apply as no-ops.
--
--  ROLLBACK (manual):
--    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA guesthub
--      REVOKE SELECT ON TABLES FROM guesthub_app;
--    REVOKE SELECT ON guesthub.schema_migrations,
--      guesthub.booking_channel_reports FROM guesthub_app;
--    (the blanket grant is a no-op to roll back in production — every other
--     table already carried SELECT before this migration)
-- ============================================================

SET search_path TO "guesthub", public;

-- 0. schema USAGE — production carries it (nspacl: guesthub_app=U/postgres,
--    granted historically OUTSIDE migrations; no migration grants it), and
--    without it a replayed schema refuses guesthub_app at the door
--    ("permission denied for schema guesthub", measured on testdb) before any
--    table ACL is even consulted. USAGE opens no data by itself.
GRANT USAGE ON SCHEMA guesthub TO guesthub_app;

-- 1. the two tables production measured as unreadable — named explicitly so
--    the intent survives even where the blanket below is someday narrowed
GRANT SELECT ON guesthub.schema_migrations       TO guesthub_app;
GRANT SELECT ON guesthub.booking_channel_reports TO guesthub_app;

-- 2. replay convergence: on a rebuilt-from-source schema this is what closes
--    the 58-table gap; in production it re-applies existing SELECTs as no-ops
GRANT SELECT ON ALL TABLES IN SCHEMA guesthub TO guesthub_app;

-- 3. the root cause: a table supabase_admin creates in guesthub is born
--    readable — no more "permission denied on the first live tick" (076→077)
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA guesthub
  GRANT SELECT ON TABLES TO guesthub_app;
