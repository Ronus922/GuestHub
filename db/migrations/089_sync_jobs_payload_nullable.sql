-- ============================================================
--  089 — channel_sync_jobs.payload may be NULL (D186 retention)
--
--  WHY. D186 records, on every sync_ari_range job row, the exact request
--  bodies the outbound ARI drain sent to Beds24 (payload.sent — success AND
--  failure). Their retention is 90 days: a nightly pass in the channel
--  worker NULLs the column and KEEPS the row (the job's status, timing and
--  error columns are history; only the bodies expire). 005 declared the
--  column `NOT NULL DEFAULT '{}'`, which forbids exactly that write.
--
--  SAFETY. Every reader already tolerates NULL: each payload merge is
--  `COALESCE(payload, '{}'::jsonb) || …`, the worker reads
--  `payload && typeof payload === "object"`, and the two `payload ?` /
--  `payload->` readers (admin.ts credits, the pull-job window) yield NULL →
--  false for a NULL, which excludes the row — the same as `{}` did.
--  The default '{}' is unchanged, so every new row still starts as `{}`.
--
--  Idempotent. Safe to replay.
--
--  ROLLBACK (only after the retention pass is disabled):
--    UPDATE guesthub.channel_sync_jobs SET payload = '{}'::jsonb WHERE payload IS NULL;
--    ALTER TABLE guesthub.channel_sync_jobs ALTER COLUMN payload SET NOT NULL;
-- ============================================================
SET search_path TO "guesthub", public;

ALTER TABLE guesthub.channel_sync_jobs
  ALTER COLUMN payload DROP NOT NULL;
