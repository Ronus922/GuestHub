-- ============================================================
--  014 · Rooms reference fidelity (D49)
--  Additive + idempotent. Two concerns:
--
--  1. rooms.min_occupancy — minimum bookable guests (approved brief §5).
--     Nullable like default_occupancy; existing rooms are backfilled with the
--     explicit safe minimum 1 (every stay satisfies it — nothing is invented).
--     Never repurposes default_occupancy.
--
--  2. Amenities catalog per the approved WindowNewRoom reference: 38 items in
--     5 groups (חדר רחצה / בידור / כללי / מטבח / יוקרה). The group lives in
--     lookup_items.metadata->>'group' (no schema change); icons only where the
--     reference shows them. The 12 keys seeded by 013 are updated in place so
--     existing room_amenities links survive; tenant-custom items are untouched.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/014_rooms_reference_fidelity.sql
--
--  ROLLBACK:
--    ALTER TABLE guesthub.rooms DROP CONSTRAINT IF EXISTS rooms_min_occupancy_chk;
--    ALTER TABLE guesthub.rooms DROP COLUMN IF EXISTS min_occupancy;
--    (catalog rows are data — restore labels from 013 if ever needed)
-- ============================================================

BEGIN;

-- ---- 1. rooms.min_occupancy ----
ALTER TABLE guesthub.rooms ADD COLUMN IF NOT EXISTS min_occupancy integer;

UPDATE guesthub.rooms SET min_occupancy = 1 WHERE min_occupancy IS NULL;

ALTER TABLE guesthub.rooms DROP CONSTRAINT IF EXISTS rooms_min_occupancy_chk;
ALTER TABLE guesthub.rooms ADD CONSTRAINT rooms_min_occupancy_chk
  CHECK (min_occupancy IS NULL OR (min_occupancy >= 1 AND min_occupancy <= max_occupancy));

-- ---- 2. amenities catalog — approved groups/labels/icons/order ----
-- update the 013-seeded keys in place (links survive)
UPDATE guesthub.lookup_items li SET
  label      = v.label,
  icon       = v.icon,
  sort_order = v.ord,
  metadata   = li.metadata || jsonb_build_object('group', v.grp)
FROM (VALUES
  ('hairdryer',  'מייבש שיער',   NULL,            'חדר רחצה', 10),
  ('tv',         'טלוויזיה חכמה', NULL,            'בידור',    20),
  ('wifi',       'Wi-Fi חינם',    'wifi',          'כללי',     30),
  ('ac',         'מיזוג אוויר',   NULL,            'כללי',     31),
  ('safe',       'כספת',          'lock',          'כללי',     32),
  ('accessible', 'גישה לנכים',    'accessibility', 'כללי',     37),
  ('fridge',     'מקרר',          NULL,            'מטבח',     50),
  ('coffee',     'קומקום חשמלי',  'coffee',        'מטבח',     51),
  ('kitchenette','מטבחון',        NULL,            'מטבח',     55),
  ('balcony',    'מרפסת',         NULL,            'יוקרה',    60),
  ('sea_view',   'נוף לים',       NULL,            'יוקרה',    61),
  ('jacuzzi',    'ג׳קוזי',        NULL,            'יוקרה',    62)
) AS v(key, label, icon, grp, ord)
WHERE li.category = 'amenities' AND li.key = v.key;

-- insert the reference items 013 did not seed (idempotent per tenant)
INSERT INTO guesthub.lookup_items (tenant_id, category, key, label, icon, sort_order, metadata)
SELECT t.id, 'amenities', v.key, v.label, v.icon, v.ord, jsonb_build_object('group', v.grp)
FROM guesthub.tenants t,
  (VALUES
    -- חדר רחצה
    ('shower',          'מקלחת',          NULL,       'חדר רחצה', 11),
    ('bathtub',         'אמבטיה',         NULL,       'חדר רחצה', 12),
    ('separate_wc',     'שירותים נפרדים', NULL,       'חדר רחצה', 13),
    ('towels',          'מגבות',          NULL,       'חדר רחצה', 14),
    ('bathrobes',       'חלוקי רחצה',     NULL,       'חדר רחצה', 15),
    ('slippers',        'נעלי בית',       NULL,       'חדר רחצה', 16),
    -- בידור
    ('smart_speaker',   'רמקול חכם',      NULL,       'בידור',    21),
    -- כללי
    ('wardrobe',        'ארון בגדים',     NULL,       'כללי',     33),
    ('desk',            'שולחן כתיבה',    NULL,       'כללי',     34),
    ('washer',          'מכונת כביסה',    NULL,       'כללי',     35),
    ('dryer',           'מייבש כביסה',    NULL,       'כללי',     36),
    ('iron',            'מגהץ',           NULL,       'כללי',     38),
    ('phone',           'טלפון',          'phone',    'כללי',     39),
    ('carpets',         'שטיחים',         NULL,       'כללי',     40),
    ('dimmable_lights', 'תאורה מתכווננת', NULL,       'כללי',     41),
    ('usb_outlets',     'USB בשקע',       NULL,       'כללי',     42),
    ('parking',         'חניה',           NULL,       'כללי',     43),
    ('lounge_chair',    'כיסא נוח',       NULL,       'כללי',     44),
    ('sofa',            'ספה',            'armchair', 'כללי',     45),
    -- מטבח
    ('coffee_machine',  'מכונת קפה',      'coffee',   'מטבח',     52),
    ('minibar',         'מיני בר',        NULL,       'מטבח',     53),
    ('microwave',       'מיקרוגל',        NULL,       'מטבח',     54),
    ('kitchenware',     'כלי מטבח',       NULL,       'מטבח',     56),
    ('oven',            'תנור',           NULL,       'מטבח',     57),
    ('dishwasher',      'מדיח כלים',      NULL,       'מטבח',     58),
    -- יוקרה
    ('private_pool',    'בריכה פרטית',    NULL,       'יוקרה',    63)
  ) AS v(key, label, icon, grp, ord)
ON CONFLICT (tenant_id, category, key) DO NOTHING;

COMMIT;
