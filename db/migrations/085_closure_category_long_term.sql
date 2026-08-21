-- ============================================================
--  085 — 'long_term' joins the closed closure-category taxonomy (084)
--
--  WHY. A flat rented on a yearly lease is a PHYSICAL fact: a person lives
--  there. Today rooms 1006/1042 are held out of sale by 165 rows of
--  pricing_plan_rates.stop_sell each — a COMMERCIAL rule, which by design a
--  manager holding reservations.restriction_override may knowingly sell
--  against ("המשך בכל זאת", 084/OVERRIDABLE_STAY_RULE_CODES). That is the
--  wrong instrument: nobody may sell a bed somebody else sleeps in, and no
--  permission should be able to.
--
--  The right instrument already exists — a dated room_closures row of
--  kind='ooo', which removes the room from inventory (sellable_unit_inventory)
--  and is refused by check_room_availability with no override path anywhere.
--  What it lacked was a NAME for this reason: 084 froze the taxonomy at five
--  values, and "שכירות ארוכה" is not "שימוש פרטי" (an owner staying a weekend)
--  nor "אחר". This migration adds the sixth value, and nothing else.
--
--  WHAT THIS DOES NOT DO. It writes no closure, moves no data, and clears no
--  stop_sell. The 1006/1042 conversion is a separate, explicitly-run script
--  (scripts/migrate-longterm-closures.mjs) so the data change is reviewable and
--  reversible on its own. NULL stays legal, exactly as 084 left it: every
--  historical row predates the taxonomy and none is rejected.
--
--  MUST STAY IN LOCKSTEP with CLOSURE_CATEGORY_VALUES in
--  src/lib/closures/categories.ts — the CHECK below is the constraint half of
--  that one list, and check:maintenance-closures asserts the two agree.
--
--  Idempotent: DROP IF EXISTS + ADD, so a replay from zero and a re-apply on a
--  live database both land on the same constraint. No data is deleted.
--
--  ROLLBACK (manual):
--    ALTER TABLE guesthub.room_closures
--      DROP CONSTRAINT IF EXISTS room_closures_category_check;
--    ALTER TABLE guesthub.room_closures ADD CONSTRAINT room_closures_category_check
--      CHECK (category IS NULL OR category IN
--             ('maintenance', 'cleaning', 'renovation', 'private_use', 'other'));
--    -- …which FAILS while any 'long_term' row exists. Reclassify or delete
--    -- those closures first (see scripts/revert-longterm-closures.mjs).
-- ============================================================
SET search_path TO "guesthub", public;

-- The closed category list, now six — NULL still allowed for historical rows.
-- Unlike 084 this cannot use the duplicate_object catch: the constraint already
-- exists under this name, so it is REPLACED rather than added.
ALTER TABLE guesthub.room_closures
  DROP CONSTRAINT IF EXISTS room_closures_category_check;

ALTER TABLE guesthub.room_closures
  ADD CONSTRAINT room_closures_category_check
  CHECK (category IS NULL OR category IN
         ('maintenance', 'cleaning', 'renovation', 'private_use', 'other', 'long_term'));

COMMENT ON CONSTRAINT room_closures_category_check ON guesthub.room_closures IS
  '084+085: the CLOSED closure-category taxonomy. Mirror of CLOSURE_CATEGORY_VALUES in src/lib/closures/categories.ts — the two must be changed together. NULL = a row filed before 084.';
