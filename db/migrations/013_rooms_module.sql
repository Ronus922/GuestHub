-- 013_rooms_module.sql — full Rooms module (Phase: Rooms).
-- Adds website/content fields to rooms, per-language translations + SEO with
-- unique slugs, image gallery, amenity links (catalog lives in lookup_items,
-- category 'amenities'), and operational areas (lobby/elevator/… — distinct from
-- guesthub.areas, which this installation uses as buildings/wings via
-- rooms.area_id). Purely additive: no existing table/column is altered in a
-- breaking way, so reservations, calendar, housekeeping and commercial settings
-- are untouched.

BEGIN;

-- ---- rooms: website + presentation fields ----
ALTER TABLE guesthub.rooms
  ADD COLUMN IF NOT EXISTS show_on_website boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS size_sqm numeric(6,1);

-- unique room number per tenant (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS rooms_tenant_number_uniq
  ON guesthub.rooms (tenant_id, lower(room_number));

-- ---- per-language content + SEO (he/en/ar). slug unique per tenant+lang = unique URL ----
CREATE TABLE IF NOT EXISTS guesthub.room_translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES guesthub.rooms(id) ON DELETE CASCADE,
  lang text NOT NULL CHECK (lang IN ('he', 'en', 'ar')),
  name text,
  description text,
  summary text,
  slug text,
  seo_title text,
  meta_description text,
  og_title text,
  og_description text,
  noindex boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, lang)
);
CREATE UNIQUE INDEX IF NOT EXISTS room_translations_slug_uniq
  ON guesthub.room_translations (tenant_id, lang, lower(slug)) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_room_translations_room ON guesthub.room_translations (room_id);
DROP TRIGGER IF EXISTS trg_room_translations_updated_at ON guesthub.room_translations;
CREATE TRIGGER trg_room_translations_updated_at
  BEFORE UPDATE ON guesthub.room_translations
  FOR EACH ROW EXECUTE FUNCTION guesthub.set_updated_at();

-- ---- image gallery; at most one main image per room ----
CREATE TABLE IF NOT EXISTS guesthub.room_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES guesthub.rooms(id) ON DELETE CASCADE,
  url text NOT NULL,
  alt_text text,
  is_main boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS room_images_main_uniq
  ON guesthub.room_images (room_id) WHERE is_main;
CREATE INDEX IF NOT EXISTS idx_room_images_room ON guesthub.room_images (room_id, sort_order);

-- ---- room ↔ amenity links (catalog: lookup_items category 'amenities') ----
CREATE TABLE IF NOT EXISTS guesthub.room_amenities (
  tenant_id uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES guesthub.rooms(id) ON DELETE CASCADE,
  amenity_id uuid NOT NULL REFERENCES guesthub.lookup_items(id) ON DELETE CASCADE,
  PRIMARY KEY (room_id, amenity_id)
);
CREATE INDEX IF NOT EXISTS idx_room_amenities_tenant ON guesthub.room_amenities (tenant_id);

-- ---- operational areas (lobby, elevator, corridor, gym, pool, parking, storage) ----
CREATE TABLE IF NOT EXISTS guesthub.operational_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text,
  area_type text NOT NULL CHECK (area_type IN ('lobby', 'elevator', 'corridor', 'gym', 'pool', 'parking', 'storage', 'other')),
  building_area_id uuid REFERENCES guesthub.areas(id) ON DELETE SET NULL,
  floor text,
  is_active boolean NOT NULL DEFAULT true,
  relevant_cleaning boolean NOT NULL DEFAULT false,
  relevant_maintenance boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'maintenance', 'cleaning', 'blocked')),
  status_note text,
  sort_order integer NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS operational_areas_code_uniq
  ON guesthub.operational_areas (tenant_id, lower(code)) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_operational_areas_tenant ON guesthub.operational_areas (tenant_id);
DROP TRIGGER IF EXISTS trg_operational_areas_updated_at ON guesthub.operational_areas;
CREATE TRIGGER trg_operational_areas_updated_at
  BEFORE UPDATE ON guesthub.operational_areas
  FOR EACH ROW EXECUTE FUNCTION guesthub.set_updated_at();

-- ---- seed a default amenities catalog per tenant (idempotent) ----
INSERT INTO guesthub.lookup_items (tenant_id, category, key, label, icon, sort_order)
SELECT t.id, 'amenities', v.key, v.label, v.icon, v.ord
FROM guesthub.tenants t,
  (VALUES
    ('wifi',        'Wi-Fi',        'link',        1),
    ('ac',          'מיזוג אוויר',  'settings',    2),
    ('tv',          'טלוויזיה',     'dashboard',   3),
    ('kitchenette', 'מטבחון',       'concierge',   4),
    ('balcony',     'מרפסת',        'building',    5),
    ('jacuzzi',     'ג׳קוזי',       'star',        6),
    ('safe',        'כספת',         'lock',        7),
    ('fridge',      'מקרר',         'concierge',   8),
    ('coffee',      'ערכת קפה',     'concierge',   9),
    ('hairdryer',   'מייבש שיער',   'brush',       10),
    ('accessible',  'נגישות',       'users-round', 11),
    ('sea_view',    'נוף לים',      'eye',         12)
  ) AS v(key, label, icon, ord)
ON CONFLICT (tenant_id, category, key) DO NOTHING;

-- ---- backfill: every existing room starts with a Hebrew translation row ----
INSERT INTO guesthub.room_translations (tenant_id, room_id, lang, name)
SELECT r.tenant_id, r.id, 'he', r.name
FROM guesthub.rooms r
ON CONFLICT (room_id, lang) DO NOTHING;

COMMIT;
