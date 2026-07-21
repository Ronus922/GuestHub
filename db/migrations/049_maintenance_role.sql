-- ============================================================
--  GuestHub · D88.1 — a dedicated "עובד תחזוקה" (maintenance worker) role.
--
--  The dispatch boards now scope their COLUMNS to worker type: /housekeeping
--  shows only cleaners (role key 'cleaner'), /maintenance shows only maintenance
--  workers. GuestHub had a 'cleaner' role but no maintenance equivalent — this
--  adds one per tenant (mirroring the cleaner role) and grants it the same
--  worker permission (housekeeping.my_tasks) so those users get the /…/my-tasks
--  screen. Managers / reception / admins are deliberately NOT board columns.
--
--  Idempotent. Safe to replay.
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/049_maintenance_role.sql
-- ============================================================
SET search_path TO "guesthub", public;

-- one maintenance role per tenant that already has the cleaner role
INSERT INTO roles (tenant_id, name, key, description, is_system)
SELECT DISTINCT c.tenant_id, 'עובד תחזוקה', 'maintenance', 'משימות תחזוקה בלבד', true
FROM roles c
WHERE c.key = 'cleaner'
  AND NOT EXISTS (
    SELECT 1 FROM roles m WHERE m.tenant_id = c.tenant_id AND m.key = 'maintenance'
  );

-- grant the worker permission (permissions are global — no tenant scoping)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = 'housekeeping.my_tasks'
WHERE r.key = 'maintenance'
ON CONFLICT (role_id, permission_id) DO NOTHING;
