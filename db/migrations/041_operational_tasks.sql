-- ============================================================
--  GuestHub · Stage 5 — unified operational task foundation (§9).
--
--  V2 warns against "separate incompatible task systems per module". Rather than
--  add a parallel table, the existing housekeeping_tasks becomes the SINGLE
--  operational task store, distinguished by task_type:
--    · housekeeping — auto-generated on checkout (the existing rows), cleaner flow
--    · maintenance  — fault/upkeep follow-ups (optionally linked to a closure)
--    · general      — any other operational follow-up
--  plus a human title and an optional due_date. Existing rows default to
--  'housekeeping', so nothing changes for them.
--
--  Idempotent. Safe to replay from zero. No data deleted.
-- ============================================================
SET search_path TO "guesthub", public;

ALTER TABLE guesthub.housekeeping_tasks
  ADD COLUMN IF NOT EXISTS task_type text NOT NULL DEFAULT 'housekeeping',
  ADD COLUMN IF NOT EXISTS title     text,
  ADD COLUMN IF NOT EXISTS due_date  date;

DO $$ BEGIN
  ALTER TABLE guesthub.housekeeping_tasks ADD CONSTRAINT housekeeping_tasks_type_check
    CHECK (task_type IN ('housekeeping','maintenance','general'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- open-task queue by type (the my-tasks + manager views filter on this)
CREATE INDEX IF NOT EXISTS idx_hk_type_status
  ON guesthub.housekeeping_tasks (tenant_id, task_type, status);
