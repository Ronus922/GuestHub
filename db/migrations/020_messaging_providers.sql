-- ============================================================
--  GuestHub · D53 — Guest messaging platform (Gmail email + WhatsApp).
--
--  Canonical, per-tenant messaging infrastructure. Prior to this, the booking
--  editor's header email/WhatsApp/confirmation actions were DOCUMENTED AND
--  OMITTED (D40) because no messaging infra existed. This migration adds the
--  ONE real infrastructure the whole app depends on — no parallel systems.
--
--  Tables (all guesthub schema, tenant-scoped):
--    1. messaging_provider_connections — one row per (tenant, provider). Holds
--       NON-secret config (jsonb) + an AES-256-GCM encrypted secret blob
--       (secret_ciphertext, src/lib/messaging/secrets.ts, key
--       MESSAGING_SECRETS_ENCRYPTION_KEY). Secrets NEVER leave the server and
--       are NEVER returned to a client (actions return masked hints only).
--       provider ∈ gmail | gmail_smtp | green_api | twilio.
--    2. message_templates — editable Hebrew booking templates, channel-tagged
--       (email|whatsapp). Variables resolved from the canonical booking record
--       (src/lib/messaging/templates.ts). Seeded with a few defaults per tenant.
--    3. outbound_messages — one row per email/WhatsApp send, with the HONEST
--       status lifecycle (draft…queued…submitted…sent…delivered…read / failed…
--       undelivered) and the provider's own message id. NEVER "sent" merely
--       because a local row was created.
--    4. message_events — provider webhook/status callbacks. dedup_key UNIQUE
--       makes ingestion idempotent; tenant is resolved via the stored message,
--       never trusted from the payload.
--
--  The ACTIVE WhatsApp provider pointer + gmail-enabled flag are NON-secret and
--  live in tenants.settings.messaging (jsonb, migration 007) — not here.
--
--  Idempotent: safe to re-run. Prints COUNTS only, never a secret or a guest
--  contact value.
--
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/020_messaging_providers.sql
--
--  ROLLBACK (destroys all messaging config + logs):
--    DROP TABLE IF EXISTS guesthub.message_events, guesthub.outbound_messages,
--      guesthub.message_templates, guesthub.messaging_provider_connections;
-- ============================================================

SET search_path TO "guesthub", public;

-- ---- 1. provider connections (encrypted secrets) ----
CREATE TABLE IF NOT EXISTS messaging_provider_connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider          text NOT NULL CHECK (provider IN ('gmail','gmail_smtp','green_api','twilio')),
  -- NON-secret configuration only: sender display name, reply-to, gmail sender
  -- address, smtp host/port/tls, green-api host/instance-id, twilio account sid /
  -- from-number / messaging-service-sid, oauth mode, etc.
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- AES-256-GCM ciphertext of the JSON secret bag (tokens/passwords/keys). NULL
  -- until credentials are entered. NEVER decrypted on a client-facing path.
  secret_ciphertext text,
  -- last connection-test / oauth result: 'connected' | 'not_configured' |
  -- 'error'. Human-safe Hebrew detail in status_detail (never a raw secret).
  status            text NOT NULL DEFAULT 'not_configured',
  status_detail     text,
  last_tested_at    timestamptz,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);

-- ---- 2. editable booking message templates ----
CREATE TABLE IF NOT EXISTS message_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('email','whatsapp')),
  slug        text NOT NULL,
  name        text NOT NULL,
  -- email only; NULL for whatsapp
  subject     text,
  body        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel, slug)
);

-- ---- 3. outbound message log (honest status lifecycle) ----
CREATE TABLE IF NOT EXISTS outbound_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reservation_id      uuid REFERENCES reservations(id) ON DELETE SET NULL,
  guest_id            uuid REFERENCES guests(id) ON DELETE SET NULL,
  channel             text NOT NULL CHECK (channel IN ('email','whatsapp')),
  provider            text NOT NULL,
  template_id         uuid REFERENCES message_templates(id) ON DELETE SET NULL,
  to_address          text NOT NULL,           -- email address or E.164 phone
  subject             text,
  body                text NOT NULL,
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','validation_failed','provider_not_configured',
                                          'queued','submitting','submitted','sent','delivered',
                                          'read','failed','undelivered')),
  provider_message_id text,                     -- Gmail message id / Twilio SID / green-api id
  provider_thread_id  text,                     -- Gmail thread id when available
  error_code          text,
  error_detail        text,
  submitted_at        timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbound_messages_reservation_idx
  ON outbound_messages (reservation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS outbound_messages_provider_msg_idx
  ON outbound_messages (provider, provider_message_id);

-- ---- 4. provider status callbacks (idempotent) ----
CREATE TABLE IF NOT EXISTS message_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id      uuid REFERENCES outbound_messages(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  event_type      text NOT NULL,               -- provider raw status/event name
  mapped_status   text,                        -- canonical outbound_messages.status
  -- provider event id (+ status) — UNIQUE so replays/duplicates are no-ops
  dedup_key       text NOT NULL,
  event_ts        timestamptz,
  raw             jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, dedup_key)
);

-- keep updated_at fresh on the mutable rows (reuses the shared trigger fn if
-- present; created here idempotently otherwise)
CREATE OR REPLACE FUNCTION guesthub.touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_provider_conn ON messaging_provider_connections;
CREATE TRIGGER trg_touch_provider_conn BEFORE UPDATE ON messaging_provider_connections
  FOR EACH ROW EXECUTE FUNCTION guesthub.touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_msg_templates ON message_templates;
CREATE TRIGGER trg_touch_msg_templates BEFORE UPDATE ON message_templates
  FOR EACH ROW EXECUTE FUNCTION guesthub.touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_outbound_messages ON outbound_messages;
CREATE TRIGGER trg_touch_outbound_messages BEFORE UPDATE ON outbound_messages
  FOR EACH ROW EXECUTE FUNCTION guesthub.touch_updated_at();

-- ---- seed default Hebrew booking templates per tenant (idempotent) ----
-- {{variables}} resolved from the canonical booking record at send time
-- (src/lib/messaging/templates.ts). Only inserted where absent.
INSERT INTO message_templates (tenant_id, channel, slug, name, subject, body, is_system)
SELECT t.id, v.channel, v.slug, v.name, v.subject, v.body, true
FROM tenants t
CROSS JOIN (VALUES
  ('email','booking_confirmation','אישור הזמנה',
   'אישור הזמנה #{{booking_number}} · {{property_name}}',
   E'שלום {{guest_first_name}},\n\nהזמנתך במלון {{property_name}} התקבלה בהצלחה.\n\nמספר הזמנה: {{booking_number}}\nתאריך הגעה: {{check_in_date}}\nתאריך עזיבה: {{check_out_date}}\nמספר לילות: {{nights}}\nחדר: {{room_number}} · {{room_type}}\nאורחים: {{guest_composition}}\nסה״כ לתשלום: {{total_price}}\nיתרה לתשלום: {{balance_due}}\n\nנשמח לארח אתכם!\n{{property_name}}'),
  ('email','payment_reminder','תזכורת תשלום',
   'תזכורת תשלום · הזמנה #{{booking_number}}',
   E'שלום {{guest_first_name}},\n\nזוהי תזכורת בנוגע להזמנה #{{booking_number}} במלון {{property_name}}.\nיתרה לתשלום: {{balance_due}}\nתאריך הגעה: {{check_in_date}}\n\nלכל שאלה נשמח לעמוד לרשותכם.\n{{property_name}}'),
  ('whatsapp','booking_confirmation','אישור הזמנה',
   NULL,
   E'שלום {{guest_first_name}}! 🏨\nהזמנתך #{{booking_number}} במלון {{property_name}} אושרה.\nהגעה: {{check_in_date}} · עזיבה: {{check_out_date}} ({{nights}} לילות)\nחדר {{room_number}} · {{room_type}}\nסה״כ: {{total_price}} · יתרה: {{balance_due}}\nנתראה בקרוב!'),
  ('whatsapp','check_in_info','מידע צ׳ק-אין',
   NULL,
   E'שלום {{guest_first_name}}, לקראת הגעתכם ({{check_in_date}}) להזמנה #{{booking_number}}:\nחדר {{room_number}} · {{room_type}}\nלכל שאלה אנחנו כאן. {{property_name}}')
) AS v(channel, slug, name, subject, body)
WHERE NOT EXISTS (
  SELECT 1 FROM message_templates m
  WHERE m.tenant_id = t.id AND m.channel = v.channel AND m.slug = v.slug
);

DO $$
DECLARE tpl bigint; conn bigint;
BEGIN
  SELECT count(*) INTO tpl FROM message_templates;
  SELECT count(*) INTO conn FROM messaging_provider_connections;
  RAISE NOTICE 'D53 messaging — templates: %, provider connections: %', tpl, conn;
END $$;
