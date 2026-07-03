-- ============================================================
--  GuestHub · יצירת schema מבודד: guesthub
-- ============================================================
--  מריצים פעם אחת מול ה-Postgres של Supabase (self-hosted).
--  כל הטבלאות של הפרויקט חיות בתוך ה-schema הזה בלבד.
--
--  הרצה:
--    docker exec -i supabase-db psql -U postgres -d postgres \
--      < db/migrations/000_init_schema.sql
--
--  ⚠️ לא מספיק כדי שה-API יראה טבלאות — צריך גם להוסיף "guesthub"
--     ל-PGRST_DB_SCHEMAS ואז: docker compose up -d rest  (לא restart!)
--
--  מחיקת הפרויקט כולו (הרסני!):
--    DROP SCHEMA "guesthub" CASCADE;
-- ============================================================

CREATE SCHEMA IF NOT EXISTS "guesthub";

GRANT USAGE ON SCHEMA "guesthub"
  TO anon, authenticated, service_role;

GRANT ALL ON ALL TABLES    IN SCHEMA "guesthub"
  TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA "guesthub"
  TO anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES  IN SCHEMA "guesthub"
  TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA "guesthub"
  GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA "guesthub"
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA "guesthub"
  GRANT ALL ON ROUTINES  TO anon, authenticated, service_role;

-- ============================================================
--  טבלאות הפרויקט — יתווספו כאן. הפעילו RLS על כל טבלה חשופה!
--  (multi-tenant: כל טבלה עם tenant_id + policy לפי החברה של המשתמש)
-- ============================================================
