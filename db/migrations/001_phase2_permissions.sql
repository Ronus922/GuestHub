-- ============================================================
--  GuestHub · Phase 2 — Users & Permissions
--  Adds the staff.* / permissions.* permission keys (missing from Phase 1's
--  users.*/roles.* catalog) and grants them to the management roles.
--  Idempotent: safe to re-run.
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/001_phase2_permissions.sql
-- ============================================================

SET search_path TO "guesthub", public;

INSERT INTO permissions (key, description, category) VALUES
  ('staff.view',         'צפייה בעובדים',          'staff'),
  ('staff.create',       'יצירת עובד',             'staff'),
  ('staff.update',       'עריכת עובד',             'staff'),
  ('staff.disable',      'השבתה/הפעלה של עובד',    'staff'),
  ('permissions.view',   'צפייה במטריצת ההרשאות',  'permissions'),
  ('permissions.update', 'עדכון הרשאות לתפקיד',    'permissions')
ON CONFLICT (key) DO NOTHING;

-- Grant the new keys to the management roles (per tenant). super_admin/admin bypass
-- checks anyway, but the grant keeps the matrix display consistent.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key IN (
  'staff.view','staff.create','staff.update','staff.disable',
  'permissions.view','permissions.update'
)
WHERE r.key IN ('super_admin','admin','manager')
ON CONFLICT (role_id, permission_id) DO NOTHING;
