-- ============================================================
--  GuestHub · Stage 5 — guest anonymization marker (§21, Privacy Amendment 13).
--
--  A guest whose PII has been erased on request keeps its row (so reservations,
--  payments and the audit trail stay coherent) but is stamped anonymized_at.
--  The stamp makes the erasure idempotent and auditable, and lets reports/exports
--  exclude or label anonymized guests.
--
--  Idempotent. Safe to replay from zero. No data deleted by this migration.
-- ============================================================
SET search_path TO "guesthub", public;

ALTER TABLE guesthub.guests
  ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_guests_anonymized
  ON guesthub.guests (tenant_id) WHERE anonymized_at IS NOT NULL;
