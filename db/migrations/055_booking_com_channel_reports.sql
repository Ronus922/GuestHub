-- ============================================================
--  GuestHub · D96 — Booking.com status reports (invalid card / cancel / no-show)
--  get a durable local ledger.
--
--  WHY. Beds24 exposes POST /channels/booking ("Alpha - Perform actions at
--  Booking.com") with exactly three actions: reportInvalidCard, reportNoShow,
--  reportCancel. Migration 030 already added the three OTA reporting STAMPS on
--  reservations (invalid_card_reported_at, external_cancellation_requested_at,
--  no_show_reported_at) for this feature — nothing ever wrote them, because the
--  channel-side reporting path left with the previous provider (D91). The stamps
--  answer "was it reported?"; they cannot answer "who tried, when, and what did
--  the channel say?" — and for an irreversible request to an OTA that is the
--  question that matters. Hence one append-only ledger row PER ATTEMPT.
--
--  ATTEMPT, not success: a row is written for a provider rejection and for a
--  local eligibility rejection too (status='failed' + a Hebrew error_message),
--  so a report that never left the building is as visible as one that did.
--
--  action = the LOCAL vocabulary, deliberately NOT the wire enum
--  (cancel_due_invalid_card → reportCancel). The local name records the
--  operator's intent; the wire name is an implementation detail of the client.
--
--  waived_fees — LOCAL RECORD ONLY. The provider contract (apiV2.yaml
--  POST /channels/booking) accepts exactly two fields, bookingId and action;
--  there is no fee-waiver field anywhere in the spec. This column records the
--  operator's own decision so the collection side knows not to chase the fee.
--  It is NEVER transmitted to Booking.com, and the UI says so.
--
--  ZERO CARD DATA (D41/D87 line): these are status reports. No PAN, no CVV and
--  no reservation_cards reference exists on this path or in this table — the
--  `response` column stores a structurally extracted, allow-listed envelope,
--  never a raw upstream body.
--
--  Idempotent. Safe to replay.
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/055_booking_com_channel_reports.sql
-- ============================================================
SET search_path TO "guesthub", public;

CREATE TABLE IF NOT EXISTS guesthub.booking_channel_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES guesthub.reservations(id) ON DELETE CASCADE,
  -- the LOCAL action vocabulary (see header); cancel_due_invalid_card is sent
  -- to Beds24 as the wire action "reportCancel"
  action text NOT NULL
    CHECK (action IN ('invalid_card', 'cancel_due_invalid_card', 'no_show')),
  -- operator's fee-waiver decision — local record, never sent to Booking.com.
  -- NULL for the two actions where the question does not arise.
  waived_fees boolean,
  status text NOT NULL CHECK (status IN ('success', 'failed')),
  -- allow-listed structural extract of the provider envelope; NULL when the
  -- attempt was rejected locally and no request was ever issued
  response jsonb,
  error_message text,
  created_by uuid REFERENCES guesthub.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE guesthub.booking_channel_reports IS
  'Append-only ledger: one row per Booking.com status-report ATTEMPT (D96). action is the local vocabulary; waived_fees is a local record never sent to the channel.';

-- the one access path: "every report of this reservation, newest first"
CREATE INDEX IF NOT EXISTS idx_booking_channel_reports_reservation
  ON guesthub.booking_channel_reports (tenant_id, reservation_id, created_at DESC);

-- ---- permission catalog (global; roles are per-tenant) ----
-- Least privilege, following 036: the key is created for every tenant's matrix,
-- but granted only to the roles that already carry full authority. Reception
-- gets it by an explicit decision in /permissions, never by default.
INSERT INTO permissions (key, description, category) VALUES
  ('reservations.channel_report', 'דיווח מצב הזמנה ל-Booking.com (כרטיס לא תקין / ביטול / אי-הגעה)', 'reservations')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = 'reservations.channel_report'
WHERE r.key IN ('super_admin', 'admin', 'manager')
ON CONFLICT (role_id, permission_id) DO NOTHING;
