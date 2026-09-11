-- ============================================================
--  088 — channel_sync_errors.resolved_by: WHO closed the row (D184)
--
--  WHY. Until now resolved_at had exactly two writers, both automatic: the
--  read-back closer (086/D161) and the import's own quarantine closer
--  (D164/D167). D184 adds the first HUMAN closure — "סמן כטופל" on an
--  OTA_STAY_RESTRICTION_VIOLATION row in the dashboard's stuck-channel
--  panel. A closure written by a person must say which person, or the row
--  reads exactly like the automatic ones and the audit question "who decided
--  this violation was handled?" has no answer.
--
--  SEMANTICS. resolved_by is NULL for every automatic closure (the closers
--  are unchanged and keep the default) and the operator's users.id for a
--  manual one. NULL therefore MEANS "closed by the system", not "unknown".
--  Never a delete: a resolved row stays until purge_channel_sync_errors (043)
--  removes it 30 days after resolution — the history of "this violation was
--  seen and dismissed" outlives the dismissal.
--
--  ON DELETE SET NULL: a departed operator's closures stay closed; the row
--  merely loses its author, it does not reopen.
--
--  No backfill: nothing recorded who closed the existing resolved rows, and
--  inventing an author would be fabrication.
--
--  Idempotent. Safe to replay.
--
--  ROLLBACK:
--    ALTER TABLE guesthub.channel_sync_errors DROP COLUMN IF EXISTS resolved_by;
-- ============================================================
SET search_path TO "guesthub", public;

ALTER TABLE guesthub.channel_sync_errors
  ADD COLUMN IF NOT EXISTS resolved_by uuid REFERENCES guesthub.users(id) ON DELETE SET NULL;
