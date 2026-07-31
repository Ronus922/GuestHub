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

-- The FK alone permits a CHAIN (A→B→C), which the resolver's single-level
-- grouping COALESCE(lineage_id, id) would silently split: A and B would not be
-- siblings of each other. A lineage is a flat family — members point at a ROOT,
-- and NULL is how a root spells itself. Enforced, not merely documented.
CREATE OR REPLACE FUNCTION guesthub.enforce_template_lineage_root()
RETURNS trigger AS $$
BEGIN
  IF NEW.lineage_id IS NOT NULL THEN
    IF NEW.lineage_id = NEW.id THEN
      RAISE EXCEPTION 'lineage_id must not point at the row itself — NULL already means "my own lineage"';
    END IF;
    IF EXISTS (SELECT 1 FROM guesthub.message_templates parent
               WHERE parent.id = NEW.lineage_id AND parent.lineage_id IS NOT NULL) THEN
      RAISE EXCEPTION 'lineage_id must point at a lineage ROOT (a template whose own lineage_id is NULL); chains split the family';
    END IF;
  END IF;
  -- A root that joins another lineage would orphan the members pointing at it.
  IF TG_OP = 'UPDATE' AND NEW.lineage_id IS NOT NULL AND OLD.lineage_id IS NULL
     AND EXISTS (SELECT 1 FROM guesthub.message_templates child WHERE child.lineage_id = OLD.id) THEN
    RAISE EXCEPTION 'this template is the root of a lineage — it cannot join another one while members point at it';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_template_lineage_root ON message_templates;
CREATE TRIGGER trg_template_lineage_root
  BEFORE INSERT OR UPDATE OF lineage_id ON message_templates
  FOR EACH ROW EXECUTE FUNCTION guesthub.enforce_template_lineage_root();

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

-- The published pointer itself must point at a version the template OWNS —
-- 036's pointer FK was template-agnostic, which is the same defect class one
-- storage bug away (a pointer at another template's version would serve that
-- template's body). The resolver also defends in the JOIN; this makes the
-- corruption unwritable at the schema.
DO $$ BEGIN
  ALTER TABLE message_templates
    ADD CONSTRAINT message_templates_current_version_owned_fkey
    FOREIGN KEY (tenant_id, id, current_published_version_id)
    REFERENCES message_template_versions(tenant_id, template_id, id)
    ON DELETE RESTRICT
    NOT VALID;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
