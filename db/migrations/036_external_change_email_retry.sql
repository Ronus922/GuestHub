-- 036: external-change email retry (D83).
-- Adds the in-flight 'sending' claim state so the automatic dispatcher (worker)
-- and the explicit super_admin retry action serialize on an atomic
-- status-claim UPDATE — one revision can never produce two successful logical
-- emails, even across processes. Additive only: no data changes, existing
-- values all remain valid.
ALTER TABLE guesthub.channel_external_changes
  DROP CONSTRAINT IF EXISTS channel_external_changes_email_status_check;
ALTER TABLE guesthub.channel_external_changes
  ADD CONSTRAINT channel_external_changes_email_status_check
  CHECK (email_status IN ('pending', 'sending', 'sent', 'failed', 'skipped'));
