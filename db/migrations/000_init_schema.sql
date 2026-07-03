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
--  ⚠️ אבטחה: הסכימה הזו נגישה אך ורק דרך porsager postgres (תפקיד owner),
--     ולא דרך PostgREST. אין לחשוף אותה ל-PGRST_DB_SCHEMAS ואין להעניק
--     הרשאות ל-anon/authenticated — אחרת ה-anon key הציבורי יוכל לקרוא/לכתוב
--     את כל נתוני הדיירים ולעקוף את בידוד ה-tenant בשרת. הבידוד נאכף בשרת בלבד
--     (actor.tenantId). אם אי-פעם נדרש PostgREST — חובה RLS + policies לכל טבלה.
--
--  מחיקת הפרויקט כולו (הרסני!):
--    DROP SCHEMA "guesthub" CASCADE;
-- ============================================================

CREATE SCHEMA IF NOT EXISTS "guesthub";

-- הסכימה בבעלות postgres (התפקיד ש-porsager מתחבר בו דרך ה-pooler) → גישה מלאה
-- ללא צורך ב-GRANT. service_role נשמר לכלי-אדמין עתידיים בלבד.
GRANT USAGE ON SCHEMA "guesthub" TO service_role;
GRANT ALL ON ALL TABLES    IN SCHEMA "guesthub" TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA "guesthub" TO service_role;
GRANT ALL ON ALL ROUTINES  IN SCHEMA "guesthub" TO service_role;

-- קשיחות: לוודא ש-anon/authenticated (מפתחות ציבוריים/משתמש) לא נוגעים בסכימה.
REVOKE ALL ON SCHEMA "guesthub"           FROM anon, authenticated;
REVOKE ALL ON ALL TABLES    IN SCHEMA "guesthub" FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "guesthub" FROM anon, authenticated;
REVOKE ALL ON ALL ROUTINES  IN SCHEMA "guesthub" FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA "guesthub"
  GRANT ALL ON TABLES    TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA "guesthub"
  GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA "guesthub"
  REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA "guesthub"
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- ============================================================
--  טבלאות הפרויקט (Phase 1) — כל הסכימה במיגרציה אחת.
--  multi-tenant: לכל טבלה עסקית tenant_id + אינדקס. הבידוד נאכף
--  בשרת (actor.tenantId) דרך porsager postgres, לא דרך PostgREST/RLS.
-- ============================================================

SET search_path TO "guesthub", public;

-- ---- 6.1 tenants ----
CREATE TABLE IF NOT EXISTS tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  timezone   text NOT NULL DEFAULT 'Asia/Jerusalem',
  currency   text NOT NULL DEFAULT 'ILS',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---- 6.3 roles ----
CREATE TABLE IF NOT EXISTS roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  key         text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

-- ---- 6.4 permissions (global catalog) ----
CREATE TABLE IF NOT EXISTS permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  description text,
  category    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---- 6.5 role_permissions ----
CREATE TABLE IF NOT EXISTS role_permissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_id, permission_id)
);

-- ---- 6.2 users ----
CREATE TABLE IF NOT EXISTS users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  auth_user_id     uuid UNIQUE,
  username         text NOT NULL,
  full_name        text,
  email            text,
  phone            text,
  role_id          uuid REFERENCES roles(id) ON DELETE SET NULL,
  allow_google_auth boolean NOT NULL DEFAULT false,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, username)
);

-- ---- 6.6 areas ----
CREATE TABLE IF NOT EXISTS areas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  sort_order  integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---- 6.7 room_types ----
CREATE TABLE IF NOT EXISTS room_types (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  base_price    numeric(12,2) NOT NULL DEFAULT 0,
  max_occupancy integer NOT NULL DEFAULT 2,
  max_adults    integer NOT NULL DEFAULT 2,
  max_children  integer NOT NULL DEFAULT 0,
  max_infants   integer NOT NULL DEFAULT 0,
  single_beds   integer NOT NULL DEFAULT 0,
  double_beds   integer NOT NULL DEFAULT 0,
  queen_beds    integer NOT NULL DEFAULT 0,
  sofa_beds     integer NOT NULL DEFAULT 0,
  cribs         integer NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---- 6.8 rooms ----
CREATE TABLE IF NOT EXISTS rooms (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  area_id       uuid REFERENCES areas(id) ON DELETE SET NULL,
  room_type_id  uuid REFERENCES room_types(id) ON DELETE SET NULL,
  room_number   text NOT NULL,
  floor         text,
  name          text,
  status        text NOT NULL DEFAULT 'available'
                CHECK (status IN ('available','inactive','out_of_order','maintenance')),
  is_active     boolean NOT NULL DEFAULT true,
  max_occupancy integer NOT NULL DEFAULT 2,
  max_adults    integer NOT NULL DEFAULT 2,
  max_children  integer NOT NULL DEFAULT 0,
  max_infants   integer NOT NULL DEFAULT 0,
  single_beds   integer NOT NULL DEFAULT 0,
  double_beds   integer NOT NULL DEFAULT 0,
  queen_beds    integer NOT NULL DEFAULT 0,
  sofa_beds     integer NOT NULL DEFAULT 0,
  cribs         integer NOT NULL DEFAULT 0,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---- 6.9 guests ----
CREATE TABLE IF NOT EXISTS guests (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  first_name text,
  last_name  text,
  full_name  text NOT NULL,
  phone      text,
  email      text,
  id_number  text,
  country    text,
  city       text,
  address    text,
  company    text,
  language   text,
  is_vip     boolean NOT NULL DEFAULT false,
  is_blocked boolean NOT NULL DEFAULT false,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---- 6.10 lookup_items ----
CREATE TABLE IF NOT EXISTS lookup_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category   text NOT NULL,
  key        text NOT NULL,
  label      text NOT NULL,
  color      text,
  icon       text,
  sort_order integer NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, category, key)
);

-- ---- 6.11 reservations ----
CREATE TABLE IF NOT EXISTS reservations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reservation_number text NOT NULL,
  primary_guest_id   uuid REFERENCES guests(id) ON DELETE SET NULL,
  source_id          uuid REFERENCES lookup_items(id) ON DELETE SET NULL,
  status             text NOT NULL DEFAULT 'draft',
  check_in           date NOT NULL,
  check_out          date NOT NULL,
  check_in_time      time NOT NULL DEFAULT '15:00',
  check_out_time     time NOT NULL DEFAULT '11:00',
  adults             integer NOT NULL DEFAULT 1,
  children           integer NOT NULL DEFAULT 0,
  infants            integer NOT NULL DEFAULT 0,
  accessible         boolean NOT NULL DEFAULT false,
  early_check_in     boolean NOT NULL DEFAULT false,
  late_check_out     boolean NOT NULL DEFAULT false,
  special_requests   text,
  discount_amount    numeric(12,2) NOT NULL DEFAULT 0,
  discount_percent   numeric(5,2)  NOT NULL DEFAULT 0,
  extra_charges      numeric(12,2) NOT NULL DEFAULT 0,
  tax_exempt         boolean NOT NULL DEFAULT false,
  deposit            numeric(12,2) NOT NULL DEFAULT 0,
  total_price        numeric(12,2) NOT NULL DEFAULT 0,
  paid_amount        numeric(12,2) NOT NULL DEFAULT 0,
  balance            numeric(12,2) NOT NULL DEFAULT 0,
  currency           text NOT NULL DEFAULT 'ILS',
  is_vip             boolean NOT NULL DEFAULT false,
  notes              text,
  internal_notes     text,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reservation_number),
  CHECK (check_out > check_in)
);

-- ---- 6.12 reservation_rooms ----
CREATE TABLE IF NOT EXISTS reservation_rooms (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  room_id        uuid REFERENCES rooms(id) ON DELETE SET NULL,
  check_in       date NOT NULL,
  check_out      date NOT NULL,
  adults         integer NOT NULL DEFAULT 1,
  children       integer NOT NULL DEFAULT 0,
  infants        integer NOT NULL DEFAULT 0,
  rate_per_night numeric(12,2) NOT NULL DEFAULT 0,
  price_total    numeric(12,2) NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (check_out > check_in)
);

-- ---- 6.13 rates ----
CREATE TABLE IF NOT EXISTS rates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  room_id             uuid REFERENCES rooms(id) ON DELETE CASCADE,
  room_type_id        uuid REFERENCES room_types(id) ON DELETE CASCADE,
  date                date NOT NULL,
  price               numeric(12,2),
  min_nights          integer,
  max_nights          integer,
  closed              boolean NOT NULL DEFAULT false,
  closed_to_arrival   boolean NOT NULL DEFAULT false,
  closed_to_departure boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (room_id IS NOT NULL OR room_type_id IS NOT NULL)
);

-- ---- 6.14 payments ----
CREATE TABLE IF NOT EXISTS payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  amount         numeric(12,2) NOT NULL,
  method         text,
  status         text NOT NULL DEFAULT 'paid',
  paid_at        timestamptz,
  reference      text,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---- 6.15 housekeeping_tasks ----
CREATE TABLE IF NOT EXISTS housekeeping_tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  room_id        uuid REFERENCES rooms(id) ON DELETE CASCADE,
  reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
  checkout_time  timestamptz,
  status         text NOT NULL DEFAULT 'pending',
  assigned_to    uuid REFERENCES users(id) ON DELETE SET NULL,
  priority       text NOT NULL DEFAULT 'normal',
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---- 6.16 audit_logs ----
CREATE TABLE IF NOT EXISTS audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  entity_type text,
  entity_id   uuid,
  action      text,
  before_data jsonb,
  after_data  jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---- 6.17 bulk_rate_update_logs / bulk_rate_update_items ----
CREATE TABLE IF NOT EXISTS bulk_rate_update_logs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  date_from  date NOT NULL,
  date_to    date NOT NULL,
  params     jsonb NOT NULL DEFAULT '{}'::jsonb,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bulk_rate_update_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  log_id       uuid NOT NULL REFERENCES bulk_rate_update_logs(id) ON DELETE CASCADE,
  room_id      uuid REFERENCES rooms(id) ON DELETE SET NULL,
  room_type_id uuid REFERENCES room_types(id) ON DELETE SET NULL,
  date         date NOT NULL,
  old_price    numeric(12,2),
  new_price    numeric(12,2),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
--  אינדקסים — כל tenant_id + מפתחות זמינות/חיפוש
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_roles_tenant             ON roles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role    ON role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_users_tenant             ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_areas_tenant             ON areas(tenant_id);
CREATE INDEX IF NOT EXISTS idx_room_types_tenant        ON room_types(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rooms_tenant             ON rooms(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rooms_area               ON rooms(area_id);
CREATE INDEX IF NOT EXISTS idx_guests_tenant            ON guests(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lookup_items_tenant_cat  ON lookup_items(tenant_id, category);
CREATE INDEX IF NOT EXISTS idx_reservations_tenant      ON reservations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_reservations_status      ON reservations(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_reservations_dates       ON reservations(tenant_id, check_in, check_out);
CREATE INDEX IF NOT EXISTS idx_reservations_guest       ON reservations(primary_guest_id);
CREATE INDEX IF NOT EXISTS idx_res_rooms_tenant         ON reservation_rooms(tenant_id);
CREATE INDEX IF NOT EXISTS idx_res_rooms_reservation    ON reservation_rooms(reservation_id);
-- מפתח בדיקת הזמינות (סעיף 8): חדר + טווח תאריכים
CREATE INDEX IF NOT EXISTS idx_res_rooms_availability   ON reservation_rooms(room_id, check_in, check_out);
CREATE INDEX IF NOT EXISTS idx_rates_tenant             ON rates(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rates_room_date          ON rates(room_id, date);
CREATE INDEX IF NOT EXISTS idx_rates_type_date          ON rates(room_type_id, date);
CREATE INDEX IF NOT EXISTS idx_payments_tenant          ON payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_reservation     ON payments(reservation_id);
CREATE INDEX IF NOT EXISTS idx_hk_tenant                ON housekeeping_tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_hk_status                ON housekeeping_tasks(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_hk_assigned              ON housekeeping_tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_audit_tenant             ON audit_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_bulk_logs_tenant         ON bulk_rate_update_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_bulk_items_tenant        ON bulk_rate_update_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_bulk_items_log           ON bulk_rate_update_items(log_id);

-- ============================================================
--  updated_at אוטומטי — פונקציה אחת + טריגר לכל טבלה עם העמודה
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    WHERE c.table_schema = 'guesthub' AND c.column_name = 'updated_at'
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON guesthub.%1$I;
       CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON guesthub.%1$I
         FOR EACH ROW EXECUTE FUNCTION guesthub.set_updated_at();', t);
  END LOOP;
END $$;

-- אחרי יצירת הטבלאות — grants ל-service_role בלבד, ו-REVOKE מ-anon/authenticated.
GRANT ALL ON ALL TABLES    IN SCHEMA "guesthub" TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA "guesthub" TO service_role;
REVOKE ALL ON ALL TABLES    IN SCHEMA "guesthub" FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "guesthub" FROM anon, authenticated;
