-- ============================================================
--  060 · Template content kinds — category CHECK fix
--
--  Template content gained two new JSONB kinds (kind:'html' full-document
--  email, kind:'whatsapp_text' plain text). NO schema change is needed for
--  them: draft_content / message_template_versions.content are jsonb, the
--  channel CHECK already includes 'whatsapp', and message_templates.subject
--  has been nullable since 020.
--
--  The ONE structural fix: the UI has offered category "אחר" ('other', in
--  STAGE_LABELS/STAGES) since D36, but the category CHECK rejects it with
--  23514 on save. Recreate the constraint with 'other' included.
--
--  Idempotent: DROP IF EXISTS + guarded ADD. No seeds, no data rewrites.
-- ============================================================

SET search_path TO "guesthub", public;

ALTER TABLE message_templates DROP CONSTRAINT IF EXISTS message_templates_category_check;
DO $$ BEGIN
  ALTER TABLE message_templates ADD CONSTRAINT message_templates_category_check
    CHECK (category IN ('reservation','pre_arrival','check_in','in_stay','check_out','post_stay','cancellation','payment','other'));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
