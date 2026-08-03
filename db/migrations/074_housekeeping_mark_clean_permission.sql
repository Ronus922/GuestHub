-- ============================================================
--  074 — one narrow permission: housekeeping.mark_clean
--
--  WHY. The dashboard's hk window puts "סמן כנקי" in front of the FRONT DESK.
--  Today the only key that can complete a task is housekeeping.manage, held by
--  admin / manager / super_admin only — receptionist and staff cannot press it
--  (audit §6.5). Granting them housekeeping.manage would work, and would also
--  hand them task CREATION, ASSIGNMENT, REORDERING and board editing, which is
--  four capabilities more than the button needs (audit §6, question 6).
--
--  So the capability is split at its real seam: "I finished cleaning this room"
--  is not "I run the housekeeping board". The new key grants exactly the first.
--
--  WHAT THIS DOES NOT DO. It alters NO existing grant. housekeeping.manage
--  keeps every role and every capability it has today; this migration only
--  ADDS a key and its grants. A role that could mark clean before still can,
--  through the same code path, because the check becomes
--  (housekeeping.manage OR housekeeping.mark_clean) — a widening of who may
--  press one button, never a narrowing of anyone.
--
--  NUMBERING. 073 is taken by all_statuses_block_inventory (D126, already
--  applied in production), so this is 074.
--
--  Idempotent. Safe to replay from zero. No data is deleted.
--
--  ROLLBACK (manual):
--    DELETE FROM guesthub.role_permissions rp USING guesthub.permissions p
--     WHERE rp.permission_id = p.id AND p.key = 'housekeeping.mark_clean';
--    DELETE FROM guesthub.permissions WHERE key = 'housekeeping.mark_clean';
-- ============================================================
SET search_path TO "guesthub", public;

-- 1. the key ---------------------------------------------------------------
INSERT INTO guesthub.permissions (key, description, category)
VALUES ('housekeeping.mark_clean', 'סימון חדר כנקי', 'housekeeping')
ON CONFLICT (key) DO NOTHING;

-- 2. the grants — the front desk included, and nobody loses anything --------
--    Roles are per-tenant rows, so this grants across every tenant that has
--    the role, exactly like the seed grants it mirrors.
INSERT INTO guesthub.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM guesthub.roles r
  JOIN guesthub.permissions p ON p.key = 'housekeeping.mark_clean'
 WHERE r.key IN ('admin', 'manager', 'super_admin', 'receptionist', 'staff')
ON CONFLICT (role_id, permission_id) DO NOTHING;
