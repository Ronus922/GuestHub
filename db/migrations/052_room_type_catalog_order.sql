-- 052 — room-type catalog: two new types + explicit owner ordering
-- (owner request 2026-07-24). The add-room type select must read:
--   סטודיו · סטודיו וחצי · חדר שינה וסלון · 2 חדרי שינה וסלון · סוויטה
-- Hebrew name order cannot express that, so room_types gains the same
-- sort_order every other user-ordered lookup already has (areas, lookup_items).

BEGIN;

ALTER TABLE guesthub.room_types
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

UPDATE guesthub.room_types SET sort_order = 10 WHERE name = 'סטודיו';
UPDATE guesthub.room_types SET sort_order = 30 WHERE name = 'חדר שינה וסלון';
UPDATE guesthub.room_types SET sort_order = 50 WHERE name = 'סוויטה';

-- The two new types, for every tenant that does not already have them.
-- Capacity/price sit between their neighbours (studio 450/2 · one-bed 680/4 ·
-- suite 980/6); the "half" and the second bedroom each add a sleeping spot —
-- all four numbers are owner-editable later in the rooms screen.
INSERT INTO guesthub.room_types
  (tenant_id, name, base_price, max_occupancy, max_adults, max_children,
   max_infants, queen_beds, sofa_beds, sort_order)
SELECT t.id, v.name, v.base_price, v.max_occupancy, v.max_adults, v.max_children,
       v.max_infants, v.queen_beds, v.sofa_beds, v.sort_order
FROM guesthub.tenants t
CROSS JOIN (VALUES
  ('סטודיו וחצי',       550.00, 3, 2, 1, 1, 1, 1, 20),
  ('2 חדרי שינה וסלון', 850.00, 6, 4, 2, 1, 2, 1, 40)
) AS v(name, base_price, max_occupancy, max_adults, max_children,
       max_infants, queen_beds, sofa_beds, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM guesthub.room_types rt
  WHERE rt.tenant_id = t.id AND rt.name = v.name
);

COMMIT;
