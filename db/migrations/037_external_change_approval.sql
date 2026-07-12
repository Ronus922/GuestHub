-- ============================================================
-- 037 — Approval-gated external date changes (additive, idempotent)
--
-- Product decision (reverses the D82 auto-apply): an inbound OTA revision
-- that changes an EXISTING reservation's stay dates (or room allocation) is
-- no longer applied automatically. The revision is persisted and HELD, one
-- pending review is created on channel_external_changes, and the operator
-- approves or rejects it in /channels. The calendar keeps the old dates until
-- approval. Nothing here messages the OTA — rejection is a local decision
-- only (Booking.com still regards its change as effective).
--
--  · channel_booking_revisions.import_status gains:
--      'awaiting_approval' — persisted + review created, nothing applied.
--        Acknowledgeable upstream (the durable row + review ARE the record;
--        the staging feed expires unacked revisions after ~30 minutes).
--      'rejected'          — operator rejected; terminal, never re-imported.
--  · channel_external_changes.apply_status gains:
--      'pending_approval' — awaiting the operator's decision
--      'rejected'         — operator kept the local dates
--      'superseded'       — a newer revision replaced this pending review
--  · decided_at / decided_by record the approval/rejection itself
--    (reconciled_* remain the operational-acknowledgement trail).
-- ============================================================

ALTER TABLE guesthub.channel_booking_revisions
  DROP CONSTRAINT IF EXISTS channel_booking_revisions_import_status_check;
ALTER TABLE guesthub.channel_booking_revisions
  ADD CONSTRAINT channel_booking_revisions_import_status_check
  CHECK (import_status IN ('pending', 'imported', 'quarantined', 'failed',
                           'awaiting_approval', 'rejected'));

ALTER TABLE guesthub.channel_external_changes
  DROP CONSTRAINT IF EXISTS channel_external_changes_apply_status_check;
ALTER TABLE guesthub.channel_external_changes
  ADD CONSTRAINT channel_external_changes_apply_status_check
  CHECK (apply_status IN ('applied', 'conflict', 'pending_approval',
                          'rejected', 'superseded'));

ALTER TABLE guesthub.channel_external_changes
  ADD COLUMN IF NOT EXISTS decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS decided_by uuid REFERENCES guesthub.users(id) ON DELETE SET NULL;
