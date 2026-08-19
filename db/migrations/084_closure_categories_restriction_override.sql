-- ============================================================
--  084 — a CLOSED closure-category taxonomy + one narrow permission:
--        reservations.restriction_override
--
--  WHY (part 1 — the category). 040 added room_closures.category as bare `text`
--  with no constraint, and the closure panel never sent it: every closure in
--  production carries category NULL and a free-text `reason`. Free text cannot
--  be grouped, filtered, coloured or translated, so the calendar had nothing to
--  render but whatever the operator happened to type. The owner decision is a
--  CLOSED list. The five values are the taxonomy 040's header already promised
--  ("a reason taxonomy instead of only free text"); `reason` survives beside it
--  as the optional free-text complement, not as the classifier.
--
--  NULL STAYS LEGAL. Every historical row has category NULL, and the CHECK is
--  written to permit it. This migration therefore rewrites NO data and rejects
--  no existing row — it only constrains what may be written from now on.
--
--  WHY (part 2 — the permission). A commercial restriction (CTA / CTD /
--  stop_sell / min-stay / max-stay) is a SALES rule, not a physical fact. The
--  front desk must be able to see it block a manual booking, and a manager must
--  be able to override it deliberately. Today there is no key for that, so the
--  choice is between blocking everyone and blocking no one. This key grants
--  exactly the override.
--
--  WHAT THIS DOES NOT DO. It alters NO existing grant and creates no path
--  around a PHYSICAL block. A room that is out_of_order / inactive, a room under
--  an OOO closure, and an existing blocking stay are availability facts; this
--  key has no effect on them (enforced in code: the availability group of
--  firstEnforcedError is never waived, and ROOM_CLOSED without a date stays in
--  it). Granted to manager here; admin / super_admin pass every permission
--  check by role (lib/auth/permission-check.ts), which is the approved
--  behaviour and is not special-cased.
--
--  NUMBERING. 083 is taken by ttlock_circuit, so this is 084.
--
--  Idempotent. Safe to replay from zero. No data is deleted.
--
--  ROLLBACK (manual):
--    ALTER TABLE guesthub.room_closures
--      DROP CONSTRAINT IF EXISTS room_closures_category_check;
--    DELETE FROM guesthub.role_permissions rp USING guesthub.permissions p
--     WHERE rp.permission_id = p.id AND p.key = 'reservations.restriction_override';
--    DELETE FROM guesthub.permissions WHERE key = 'reservations.restriction_override';
-- ============================================================
SET search_path TO "guesthub", public;

-- 1. the closed category list — NULL allowed for the historical rows ---------
DO $$ BEGIN
  ALTER TABLE guesthub.room_closures ADD CONSTRAINT room_closures_category_check
    CHECK (category IS NULL OR category IN
           ('maintenance', 'cleaning', 'renovation', 'private_use', 'other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. the key ---------------------------------------------------------------
INSERT INTO guesthub.permissions (key, description, category)
VALUES ('reservations.restriction_override', 'עקיפת הגבלה מסחרית ביצירת הזמנה', 'reservations')
ON CONFLICT (key) DO NOTHING;

-- 3. the grant — manager only, and nobody loses anything --------------------
--    Roles are per-tenant rows, so this grants across every tenant that has
--    the role, exactly like the seed grants it mirrors.
INSERT INTO guesthub.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM guesthub.roles r
  JOIN guesthub.permissions p ON p.key = 'reservations.restriction_override'
 WHERE r.key = 'manager'
ON CONFLICT (role_id, permission_id) DO NOTHING;
