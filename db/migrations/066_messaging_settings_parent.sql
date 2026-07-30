-- ============================================================
--  066 — seed the tenants.settings->'messaging' parent object
--
--  Incident (2026-07-28 → 2026-07-30, D113): GREEN-API was connected, tested
--  and provably delivering, yet every WhatsApp surface reported "no provider".
--  setActiveWhatsAppProvider wrote the pointer with
--      jsonb_set(settings, '{messaging,whatsappProvider}', …, create_missing => true)
--  and create_missing only creates the LAST element of the path. No migration
--  had ever seeded the `messaging` parent, so PostgreSQL returned the document
--  unchanged, the UPDATE matched its row, and the action reported success.
--  Six operator clicks over two days were audit-logged and none persisted.
--
--  The writer is fixed in code (it now builds the parent in the same
--  expression and verifies by read-back). This migration removes the wall for
--  tenants that already exist, so the very first click after deploy lands even
--  if some other nested writer is still using the old shape.
--
--  It deliberately does NOT set whatsappProvider. Which provider is active —
--  or whether WhatsApp is off entirely — is the operator's decision, and
--  guessing it here would re-create the exact confusion D113 is about: a
--  pointer nobody chose that looks like a choice.
--
--  Idempotent: after this runs, settings->'messaging' is an object, so a
--  replay matches zero rows. Never overwrites an existing object.
--
--  The predicate tests jsonb_typeof rather than IS NULL because `messaging`
--  can be absent (SQL NULL) or hold a JSON null, and only the first of those
--  is caught by IS NULL — while both break the `||` merge the writer performs.
-- ============================================================

SET search_path TO "guesthub", public;

UPDATE guesthub.tenants
SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('messaging', '{}'::jsonb),
    updated_at = now()
WHERE settings IS NULL
   OR jsonb_typeof(settings->'messaging') IS DISTINCT FROM 'object';
