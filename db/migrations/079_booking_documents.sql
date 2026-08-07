-- ============================================================
--  079 — booking_documents: real storage for the reservation documents block
--
--  WHAT THIS ADDS. One table backing the מסמכים block of both booking
--  windows (BookingDocuments.tsx), until now a graphic shell with local
--  state only. Files themselves live on disk under the durable uploads
--  store (lib/reservations/documents.ts — the lib/rooms/uploads.ts
--  pattern): uploads/bookings/<bookingId>/<uuid>.<ext>, written by
--  POST /api/reservations/documents and served — session + tenant
--  checked, never publicly — by app/uploads/bookings/[bookingId]/[name].
--
--  booking_id IS NULLABLE BY DESIGN: the create wizard uploads documents
--  BEFORE a reservation exists. Such rows are attached (booking_id set)
--  inside createReservationAction's transaction; a wizard discarded
--  without saving soft-deletes its orphans. Disk files of soft-deleted
--  rows are NOT removed — no physical deletion in this phase.
--
--  DELETION IS SOFT (deleted_at). Every read path filters
--  deleted_at IS NULL; there is no hard-DELETE path, and the app role
--  deliberately receives no DELETE grant so the doctrine is enforced at
--  the DB (the 077 pattern).
--
--  HOW THIS IS APPLIED — NOT BY HAND. The deploy owns migration
--  application (064): scripts/apply-pending-migrations.mjs runs before
--  the pm2 restart and records the file only after a clean apply.
--
--  Idempotent. Safe to replay from zero. No data is deleted.
--
--  ROLLBACK (manual):
--    DROP TABLE IF EXISTS guesthub.booking_documents;
-- ============================================================

SET search_path TO "guesthub", public;

CREATE TABLE IF NOT EXISTS guesthub.booking_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,

  -- NULL = uploaded from the create wizard, reservation not saved yet;
  -- set once, inside the creation transaction (the attach point)
  booking_id    uuid REFERENCES guesthub.reservations(id) ON DELETE CASCADE,

  file_name     text NOT NULL,  -- display name (inline-renameable, keeps its extension)
  original_name text NOT NULL,  -- as uploaded, immutable
  mime_type     text NOT NULL
    CHECK (mime_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes    int  NOT NULL CHECK (size_bytes > 0),

  -- path RELATIVE to the durable uploads root (UPLOADS_DIR); the on-disk
  -- basename is a server-generated uuid — NEVER a user-supplied name
  storage_path  text NOT NULL,

  uploaded_by   uuid REFERENCES guesthub.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_booking_documents_tenant_booking
  ON guesthub.booking_documents (tenant_id, booking_id);

-- grants — the 077 doctrine: explicit, minimal, in the creating migration
-- (supabase_admin-created tables get NO default app grant in this cluster).
-- No DELETE: deletion is deleted_at, enforced here.
GRANT SELECT, INSERT, UPDATE ON guesthub.booking_documents TO guesthub_app;
GRANT ALL ON guesthub.booking_documents TO service_role;
