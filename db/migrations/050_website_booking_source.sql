-- 050: מקור הזמנה "אתר רשמי" עבור מנוע ההזמנות הציבורי (sea-tower).
-- ההזמנות מהאתר מסומנות booking_origin='direct_website' + source_id של ה-lookup הזה,
-- כדי שדוחות ומסננים יבדילו הזמנות ישירות מהאתר מהזמנות ערוצים (beds24 וכו').
-- Idempotent (ON CONFLICT DO NOTHING) — נזרע לכל tenant קיים; בטוח להרצה חוזרת.
BEGIN;

INSERT INTO guesthub.lookup_items (tenant_id, category, key, label, sort_order, is_active)
SELECT t.id, 'booking_sources', 'website', 'אתר רשמי', 15, true
FROM guesthub.tenants t
ON CONFLICT (tenant_id, category, key) DO NOTHING;

COMMIT;
