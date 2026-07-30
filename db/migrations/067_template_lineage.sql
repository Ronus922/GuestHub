-- ============================================================
--  067 — template lineage: version resolution is lineage-scoped (D117)
--
--  THE DEFECT (reservation 1060). resolveVersion's guest-language "sibling"
--  lookup matched templates by (tenant, category, channel, language) — a
--  coincidence of labels, not an identity. Two published WhatsApp templates
--  shared category='reservation' + language='he', the join matched both,
--  LIMIT 1 without ORDER BY picked by execution-plan luck, and the guest
--  confirmation automation sent the internal-notification body to the guest.
--
--  THE FIX, structurally:
--
--  1. lineage_id — the identity that language-siblings SHARE. NULL means
--     "my own lineage is myself": today no template is linked to any other,
--     so every template resolves only to its own versions. Linking a he/en
--     translation pair is a deliberate future act (set both rows to one
--     lineage id), never an inference from matching labels.
--
--  2. outbound_messages: a delivery row whose template_version_id belongs to
--     a different template than its template_id is self-contradictory. The
--     composite FK makes that impossible to WRITE from now on. NOT VALID by
--     design: the 2026-07-30 rows produced by this very defect stay readable
--     as evidence — history is not rewritten to look consistent (D112).
-- ============================================================

SET search_path TO "guesthub", public;

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS lineage_id uuid;

COMMENT ON COLUMN message_templates.lineage_id IS
  'Translation-family identity: language siblings share one lineage_id. NULL = the template is its own lineage (never linked). Version resolution may only cross templates INSIDE one lineage (D117).';

-- Garbage lineage ids stay out, and a lineage can never point across tenants.
DO $$ BEGIN
  ALTER TABLE message_templates ADD CONSTRAINT message_templates_lineage_tenant_fkey
    FOREIGN KEY (tenant_id, lineage_id)
    REFERENCES message_templates(tenant_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- The referenced side of the delivery-consistency FK: (id) is already unique,
-- the wider key exists so the FK below can bind version AND owning template.
DO $$ BEGIN
  ALTER TABLE message_template_versions
    ADD CONSTRAINT message_template_versions_tenant_template_id_key
    UNIQUE (tenant_id, template_id, id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- A delivery's template_id must be the template its version belongs to.
-- MATCH SIMPLE: rows without a version (manual/test/skips) are untouched.
-- NOT VALID: pre-fix contradictory rows remain as evidence; every NEW write
-- is checked.
DO $$ BEGIN
  ALTER TABLE outbound_messages
    ADD CONSTRAINT outbound_messages_version_matches_template_fkey
    FOREIGN KEY (tenant_id, template_id, template_version_id)
    REFERENCES message_template_versions(tenant_id, template_id, id)
    ON DELETE RESTRICT
    NOT VALID;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
