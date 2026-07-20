-- GuestHub least-privilege database roles (Stage 2, V2 §9 / ADR-0002).
--
-- Applied per dedicated environment (staging, later production). Passwords are
-- supplied as psql variables at apply time and never committed:
--   psql "$ADMIN_URL" -v owner_pw=... -v app_pw=... -v ro_pw=... -v backup_pw=... \
--        -v dbname=guesthub_staging -f db/roles/roles.sql
--
-- Roles (V2 §9):
--   guesthub_owner    — owns the schema + all objects; runs migrations/DDL.
--   guesthub_app      — runtime DML only; owns NOTHING; cannot DDL.
--   guesthub_readonly — diagnostics; SELECT only.
--   guesthub_backup   — dump/restore; read-all via pg_read_all_data.
-- Idempotent: safe to re-run (roles created if absent; passwords reset; grants re-applied).

\set ON_ERROR_STOP on

-- 1. Roles (create if absent, always (re)set the password) --------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='guesthub_owner')    THEN CREATE ROLE guesthub_owner    LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='guesthub_app')      THEN CREATE ROLE guesthub_app      LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='guesthub_readonly') THEN CREATE ROLE guesthub_readonly LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='guesthub_backup')   THEN CREATE ROLE guesthub_backup   LOGIN; END IF;
END $$;

ALTER ROLE guesthub_owner    WITH PASSWORD :'owner_pw'  NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE guesthub_app      WITH PASSWORD :'app_pw'    NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE guesthub_readonly WITH PASSWORD :'ro_pw'     NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE guesthub_backup   WITH PASSWORD :'backup_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- 2. Ownership: guesthub_owner owns the schema and every object in it ---------
ALTER SCHEMA guesthub OWNER TO guesthub_owner;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT 'ALTER TABLE guesthub.'||quote_ident(tablename)||' OWNER TO guesthub_owner' c
             FROM pg_tables WHERE schemaname='guesthub'
  LOOP EXECUTE r.c; END LOOP;
  FOR r IN SELECT 'ALTER SEQUENCE guesthub.'||quote_ident(sequencename)||' OWNER TO guesthub_owner' c
             FROM pg_sequences WHERE schemaname='guesthub'
  LOOP EXECUTE r.c; END LOOP;
  FOR r IN SELECT 'ALTER VIEW guesthub.'||quote_ident(viewname)||' OWNER TO guesthub_owner' c
             FROM pg_views WHERE schemaname='guesthub'
  LOOP EXECUTE r.c; END LOOP;
  FOR r IN SELECT 'ALTER '||CASE WHEN p.prokind='p' THEN 'PROCEDURE' ELSE 'FUNCTION' END
                  ||' guesthub.'||quote_ident(p.proname)||'('||pg_get_function_identity_arguments(p.oid)||') OWNER TO guesthub_owner' c
             FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='guesthub'
  LOOP EXECUTE r.c; END LOOP;
END $$;

-- 3. Runtime app: DML only, no ownership, no DDL -----------------------------
GRANT USAGE ON SCHEMA guesthub TO guesthub_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA guesthub TO guesthub_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA guesthub TO guesthub_app;
GRANT EXECUTE                        ON ALL ROUTINES  IN SCHEMA guesthub TO guesthub_app;
ALTER DEFAULT PRIVILEGES FOR ROLE guesthub_owner IN SCHEMA guesthub GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO guesthub_app;
ALTER DEFAULT PRIVILEGES FOR ROLE guesthub_owner IN SCHEMA guesthub GRANT USAGE, SELECT ON SEQUENCES TO guesthub_app;
ALTER DEFAULT PRIVILEGES FOR ROLE guesthub_owner IN SCHEMA guesthub GRANT EXECUTE ON ROUTINES TO guesthub_app;

-- 3b. Shared-instance auth read (staff last-sign-in display) ------------------
-- On the shared Supabase instance the app LEFT JOINs auth.users for
-- last_sign_in_at (src/app/(dashboard)/staff/page.tsx). Column-level only:
-- never the password hash or token columns. No-op on a dedicated DB without
-- GoTrue (schema absent) — guarded so the script stays idempotent everywhere.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='auth') THEN
    GRANT USAGE ON SCHEMA auth TO guesthub_app;
    GRANT SELECT (id, last_sign_in_at, created_at) ON auth.users TO guesthub_app;
  END IF;
END $$;

-- 4. Read-only diagnostics ---------------------------------------------------
GRANT USAGE ON SCHEMA guesthub TO guesthub_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA guesthub TO guesthub_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE guesthub_owner IN SCHEMA guesthub GRANT SELECT ON TABLES TO guesthub_readonly;

-- 5. Backup/restore ----------------------------------------------------------
GRANT pg_read_all_data TO guesthub_backup;
GRANT USAGE ON SCHEMA guesthub TO guesthub_backup;

-- 6. Ensure app can neither create objects in the schema nor own new ones -----
REVOKE CREATE ON SCHEMA guesthub FROM guesthub_app, guesthub_readonly, guesthub_backup;
