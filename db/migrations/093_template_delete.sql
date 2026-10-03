-- ============================================================
--  093 · Delete a message template (D205)
--
--  1. message_templates.deleted_at — a SOFT delete for a template that was
--     ever sent: the row and its immutable versions stay, so history rows keep
--     rendering the content that went out; every UI surface filters it out.
--     The delete action also takes it out of service (is_active = false,
--     lifecycle 'archived'), so every send path that already refuses archived
--     templates refuses it too. Nullable, no default, no backfill.
--
--  2. A HARD delete of a never-sent template must remove its versions, which
--     the 036 trigger forbids. The trigger keeps refusing every UPDATE, and
--     every DELETE — except a DELETE of a version whose template_id equals the
--     transaction-local setting guesthub.template_hard_delete, which only the
--     delete action sets (set_config(..., true): it dies with the
--     transaction). Outbound rows still hold their FK (RESTRICT) on versions,
--     so a sent version can never be removed even with the setting on.
--
--  NO data changes. Nothing is deleted on migrate.
-- ============================================================

SET search_path TO "guesthub", public;

ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE OR REPLACE FUNCTION guesthub.reject_message_template_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND OLD.template_id::text = current_setting('guesthub.template_hard_delete', true) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'published message template versions are immutable';
END;
$$;
