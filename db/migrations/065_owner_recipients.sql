-- ============================================================
--  065 — automation recipients: guest, business owner, or both
--
--  recipient_config on communication_automations was a dead literal
--  ({"type":"primary_guest"}) — every automation hardcoded the guest as the
--  sole recipient. Automations can now also (or instead) notify the business
--  owner, whose addresses live on communication_settings: a list of emails
--  (email automations) and a list of E.164 phones (whatsapp automations).
--
--  Fan-out means more than one outbound_messages row per (automation, event).
--  The 036 unique index outbound_messages_normal_event_once_idx forbade
--  exactly that, so it is replaced by a recipient-aware index; recipient_key
--  defaults to 'guest' so every historical row keeps its identity and the
--  recreated index stays unique over existing data.
--
--  The dead manual/direct_booking_recipients columns from 036 are NOT reused:
--  their semantics are per-booking-source, not owner notification.
-- ============================================================

SET search_path TO "guesthub", public;

ALTER TABLE communication_settings
  ADD COLUMN IF NOT EXISTS owner_notification_emails text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS owner_notification_phones text[] NOT NULL DEFAULT ARRAY[]::text[];

ALTER TABLE outbound_messages
  ADD COLUMN IF NOT EXISTS recipient_key text NOT NULL DEFAULT 'guest';

DROP INDEX IF EXISTS outbound_messages_normal_event_once_idx;
CREATE UNIQUE INDEX IF NOT EXISTS outbound_messages_normal_event_recipient_idx
  ON outbound_messages (tenant_id, reservation_id, automation_id, event_id, recipient_key)
  WHERE delivery_type = 'normal' AND automation_id IS NOT NULL AND event_id IS NOT NULL;
