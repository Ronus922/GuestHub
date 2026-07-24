-- ============================================================
--  GuestHub · D88 — manual ordering for the drag-and-drop task board.
--
--  The /housekeeping + /tasks boards become dnd-kit Kanban boards (columns =
--  cleaners, cards = tasks). A drag inside a column persists a MANUAL order that
--  outlives a refresh — that order lives in order_index, the same contract the
--  PMS housekeeping board uses. Existing rows default to 0 and fall back to the
--  natural sort (priority, checkout/created) until first dragged.
--
--  Idempotent. Safe to replay. No data deleted.
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/048_task_board_order.sql
-- ============================================================
SET search_path TO "guesthub", public;

ALTER TABLE guesthub.housekeeping_tasks
  ADD COLUMN IF NOT EXISTS order_index integer NOT NULL DEFAULT 0;

-- the board reads one bucket at a time: WHERE tenant_id, task_type, status
-- ORDER BY assigned_to NULLS FIRST, order_index — index the ordering path
CREATE INDEX IF NOT EXISTS idx_hk_board_order
  ON guesthub.housekeeping_tasks (tenant_id, assigned_to, order_index);

GRANT SELECT, INSERT, UPDATE ON guesthub.housekeeping_tasks TO guesthub_app;
