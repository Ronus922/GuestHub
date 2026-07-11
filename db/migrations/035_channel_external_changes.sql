-- ============================================================
-- 035 — External change notifications (additive, idempotent)
--
-- WHY: an inbound OTA revision (Booking.com via Channex) can MOVE the stay
-- dates of a reservation that already exists locally. The import itself is
-- automatic (the OTA regards the change as confirmed), but the operator needs
-- one visible, reconcilable record per external revision: old dates, new
-- dates, the affected room, and whether the change was applied to the calendar
-- or parked on a conflict. One row per (connection, provider_revision_id) —
-- repeated webhook delivery can never create a second notification or a
-- second email.
--
-- "Reconciled" here is an OPERATIONAL acknowledgement only: it never claims
-- to reverse anything in the OTA.
-- ============================================================

CREATE TABLE IF NOT EXISTS guesthub.channel_external_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES guesthub.channel_connections(id) ON DELETE CASCADE,
  -- the external revision that carried the change (idempotency key)
  provider_revision_id text NOT NULL,
  provider_booking_id text NOT NULL,
  ota_reservation_code text,
  ota_name text,
  -- the affected local reservation (kept on reservation deletion for history)
  reservation_id uuid REFERENCES guesthub.reservations(id) ON DELETE SET NULL,
  reservation_number text,
  change_kind text NOT NULL DEFAULT 'dates_changed'
    CHECK (change_kind IN ('dates_changed')),
  old_check_in date NOT NULL,
  old_check_out date NOT NULL,
  new_check_in date NOT NULL,
  new_check_out date NOT NULL,
  -- display-only room numbers involved in the stay
  room_labels text[] NOT NULL DEFAULT '{}',
  -- applied = the calendar already shows the new dates;
  -- conflict = the revision quarantined and the calendar still shows the old dates
  apply_status text NOT NULL CHECK (apply_status IN ('applied', 'conflict')),
  conflict_detail text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reconciled')),
  reconciled_at timestamptz,
  reconciled_by uuid REFERENCES guesthub.users(id) ON DELETE SET NULL,
  -- email lifecycle: pending → sent | failed | skipped (terminal; never resent)
  email_status text NOT NULL DEFAULT 'pending'
    CHECK (email_status IN ('pending', 'sent', 'failed', 'skipped')),
  email_detail text,
  outbound_message_id uuid REFERENCES guesthub.outbound_messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_external_change_revision UNIQUE (connection_id, provider_revision_id)
);

CREATE INDEX IF NOT EXISTS idx_external_changes_pending
  ON guesthub.channel_external_changes (tenant_id, status, created_at DESC);
