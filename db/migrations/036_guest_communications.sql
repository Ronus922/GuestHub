-- ============================================================
-- GuestHub · Guest Communications
--
-- Additive extension of D53 messaging. No event or delivery is created here,
-- so applying this migration never backfills or sends guest communication.
-- Flexible JSONB columns have matching Zod schemas in
-- src/lib/communications/schemas.ts.
-- ============================================================

SET search_path TO "guesthub", public;

-- Reservation provenance is explicit. Existing rows are intentionally marked
-- back_office only when no channel connection exists; imported history is ota.
-- This migration emits no events. Future direct entry points must explicitly
-- set direct_website.
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS booking_origin text,
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS guest_communication_opt_out boolean NOT NULL DEFAULT false;

UPDATE reservations
SET booking_origin = CASE WHEN channel_connection_id IS NULL THEN 'back_office' ELSE 'ota' END
WHERE booking_origin IS NULL;
ALTER TABLE reservations ALTER COLUMN booking_origin SET DEFAULT 'back_office';
ALTER TABLE reservations ALTER COLUMN booking_origin SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE reservations ADD CONSTRAINT reservations_booking_origin_check
    CHECK (booking_origin IN ('back_office','direct_website','ota'));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- Existing mutable templates become the draft/template identity. Published
-- content lives in immutable message_template_versions below.
-- The draft carries the SAME editable surface as a published version: the whole
-- point of "שמירת טיוטה" is that publishing changes nothing but immutability.
-- Sender name / reply-to / preheader therefore need real draft columns; without
-- them a draft could not round-trip what the editor shows.
ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'reservation',
  ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'he',
  ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS draft_content jsonb,
  ADD COLUMN IF NOT EXISTS draft_sender_display_name text,
  ADD COLUMN IF NOT EXISTS draft_reply_to text,
  ADD COLUMN IF NOT EXISTS draft_preheader text,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

DO $$ BEGIN
  ALTER TABLE message_templates ADD CONSTRAINT message_templates_lifecycle_check
    CHECK (lifecycle_state IN ('draft','published','archived'));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE message_templates ADD CONSTRAINT message_templates_language_check
    CHECK (language IN ('he','en'));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
-- "שלב בחיי ההזמנה" — organisational only. It is NOT a trigger: what actually
-- sends is an automation. The constraint keeps the filter list closed.
DO $$ BEGIN
  ALTER TABLE message_templates ADD CONSTRAINT message_templates_category_check
    CHECK (category IN ('reservation','pre_arrival','check_in','in_stay','check_out','post_stay','cancellation','payment'));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- Composite candidate keys make it impossible for a child row to reference an
-- object belonging to another tenant, even if an application query is faulty.
DO $$ BEGIN
  ALTER TABLE reservations ADD CONSTRAINT reservations_tenant_id_id_key UNIQUE (tenant_id, id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE guests ADD CONSTRAINT guests_tenant_id_id_key UNIQUE (tenant_id, id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE message_templates ADD CONSTRAINT message_templates_tenant_id_id_key UNIQUE (tenant_id, id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_tenant_id_id_key UNIQUE (tenant_id, id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS message_template_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id         uuid NOT NULL,
  version_number      integer NOT NULL CHECK (version_number > 0),
  sender_display_name text,
  reply_to_behavior   text NOT NULL DEFAULT 'channel_default'
                        CHECK (reply_to_behavior IN ('channel_default','custom','none')),
  reply_to_address    text,
  subject             text NOT NULL,
  preheader           text,
  content             jsonb NOT NULL,
  published_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_template_versions_template_tenant_fkey
    FOREIGN KEY (tenant_id, template_id)
    REFERENCES message_templates(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT message_template_versions_reply_to_check CHECK (
    (reply_to_behavior = 'custom' AND NULLIF(btrim(reply_to_address), '') IS NOT NULL)
    OR (reply_to_behavior <> 'custom' AND reply_to_address IS NULL)
  ),
  UNIQUE (tenant_id, id),
  UNIQUE (template_id, version_number)
);

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS current_published_version_id uuid;
DO $$ BEGIN
  ALTER TABLE message_templates ADD CONSTRAINT message_templates_current_version_tenant_fkey
    FOREIGN KEY (tenant_id, current_published_version_id)
    REFERENCES message_template_versions(tenant_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- Published versions are snapshots. Restoring means copying to a new draft and
-- publishing a new version, never mutating history.
CREATE OR REPLACE FUNCTION guesthub.reject_message_template_version_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'published message template versions are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_immutable_message_template_versions ON message_template_versions;
CREATE TRIGGER trg_immutable_message_template_versions
  BEFORE UPDATE OR DELETE ON message_template_versions
  FOR EACH ROW EXECUTE FUNCTION guesthub.reject_message_template_version_mutation();

CREATE TABLE IF NOT EXISTS communication_automations (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                       text NOT NULL,
  description                text,
  stage                      text NOT NULL DEFAULT 'reservation',
  status                     text NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft','active','disabled','needs_attention','archived')),
  attention_reason           text,
  trigger_type               text NOT NULL,
  timing_config              jsonb NOT NULL DEFAULT '{"mode":"immediate","quietHours":"bypass"}'::jsonb,
  source_filters             jsonb NOT NULL DEFAULT '{"include":[]}'::jsonb,
  conditions                 jsonb NOT NULL DEFAULT '{"logic":"all","items":[]}'::jsonb,
  exclusion_rules            jsonb NOT NULL DEFAULT '{}'::jsonb,
  recipient_config           jsonb NOT NULL DEFAULT '{"type":"primary_guest"}'::jsonb,
  channel                    text NOT NULL CHECK (channel IN ('email','whatsapp')),
  template_id                uuid NOT NULL,
  template_version_policy    text NOT NULL DEFAULT 'latest_published'
                               CHECK (template_version_policy IN ('latest_published','locked')),
  locked_template_version_id uuid,
  duplicate_policy           text NOT NULL DEFAULT 'once_per_event'
                               CHECK (duplicate_policy IN ('once_per_event','allow_explicit_resend')),
  manual_activation_enabled  boolean NOT NULL DEFAULT false,
  created_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  archived_at                timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT communication_automations_template_tenant_fkey
    FOREIGN KEY (tenant_id, template_id)
    REFERENCES message_templates(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT communication_automations_version_tenant_fkey
    FOREIGN KEY (tenant_id, locked_template_version_id)
    REFERENCES message_template_versions(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT communication_automations_version_policy_check CHECK (
    (template_version_policy = 'latest_published' AND locked_template_version_id IS NULL)
    OR (template_version_policy = 'locked' AND locked_template_version_id IS NOT NULL)
  ),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS communication_automations_trigger_idx
  ON communication_automations (tenant_id, trigger_type, status);

CREATE TABLE IF NOT EXISTS communication_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type        text NOT NULL,
  aggregate_type    text NOT NULL DEFAULT 'reservation',
  reservation_id    uuid,
  source            text NOT NULL,
  occurrence_key    text NOT NULL,
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','processing','processed','failed')),
  available_at       timestamptz NOT NULL DEFAULT now(),
  attempt_count      integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts       integer NOT NULL DEFAULT 10 CHECK (max_attempts BETWEEN 0 AND 10),
  lease_owner        text,
  lease_expires_at   timestamptz,
  last_error_category text,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT communication_events_reservation_tenant_fkey
    FOREIGN KEY (tenant_id, reservation_id)
    REFERENCES reservations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT communication_events_lease_check CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, event_type, aggregate_type, occurrence_key)
);

CREATE INDEX IF NOT EXISTS communication_events_pending_idx
  ON communication_events (available_at, occurred_at)
  WHERE status IN ('pending','processing');

-- D53 outbound_messages is the canonical delivery table. Add immutable render
-- snapshots and automation/outbox linkage without breaking legacy manual sends.
ALTER TABLE outbound_messages
  ADD COLUMN IF NOT EXISTS automation_id uuid,
  ADD COLUMN IF NOT EXISTS template_version_id uuid,
  ADD COLUMN IF NOT EXISTS event_id uuid,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS rendered_sender_name text,
  ADD COLUMN IF NOT EXISTS rendered_reply_to text,
  ADD COLUMN IF NOT EXISTS rendered_preheader text,
  ADD COLUMN IF NOT EXISTS rendered_html text,
  ADD COLUMN IF NOT EXISTS rendered_plain_text text,
  ADD COLUMN IF NOT EXISTS delivery_type text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS final_error_category text,
  ADD COLUMN IF NOT EXISTS resend_of_delivery_id uuid,
  ADD COLUMN IF NOT EXISTS resend_reason text,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

-- Delivery history needs truthful non-provider terminal states in addition to
-- D53's provider lifecycle. This is a compatible expansion: every legacy
-- status remains valid, while skipped/cancelled work is recorded explicitly.
ALTER TABLE outbound_messages
  DROP CONSTRAINT IF EXISTS outbound_messages_status_check;
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_status_check CHECK (status IN (
    'draft','validation_failed','provider_not_configured','queued','submitting',
    'submitted','sent','delivered','read','failed','undelivered','skipped','cancelled'
  ));

DO $$ BEGIN
  ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_delivery_type_check
    CHECK (delivery_type IN ('normal','test','manual','manual_resend'));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_attempts_check
    CHECK (attempt_count >= 0 AND max_attempts BETWEEN 0 AND 10 AND attempt_count <= max_attempts);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_lease_check
    CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_automation_tenant_fkey
    FOREIGN KEY (tenant_id, automation_id)
    REFERENCES communication_automations(tenant_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_version_tenant_fkey
    FOREIGN KEY (tenant_id, template_version_id)
    REFERENCES message_template_versions(tenant_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_event_tenant_fkey
    FOREIGN KEY (tenant_id, event_id)
    REFERENCES communication_events(tenant_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_resend_tenant_fkey
    FOREIGN KEY (tenant_id, resend_of_delivery_id)
    REFERENCES outbound_messages(tenant_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_resend_reason_check CHECK (
    (delivery_type = 'manual_resend' AND resend_of_delivery_id IS NOT NULL AND NULLIF(btrim(resend_reason), '') IS NOT NULL)
    OR (delivery_type <> 'manual_resend' AND resend_of_delivery_id IS NULL AND resend_reason IS NULL)
  );
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_reservation_tenant_fkey
    FOREIGN KEY (tenant_id, reservation_id)
    REFERENCES reservations(tenant_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_guest_tenant_fkey
    FOREIGN KEY (tenant_id, guest_id)
    REFERENCES guests(tenant_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_template_tenant_fkey
    FOREIGN KEY (tenant_id, template_id)
    REFERENCES message_templates(tenant_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS outbound_messages_idempotency_idx
  ON outbound_messages (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS outbound_messages_normal_event_once_idx
  ON outbound_messages (tenant_id, reservation_id, automation_id, event_id)
  WHERE delivery_type = 'normal' AND automation_id IS NOT NULL AND event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS outbound_messages_worker_queue_idx
  ON outbound_messages (scheduled_at, created_at)
  WHERE status IN ('queued','submitting');

CREATE TABLE IF NOT EXISTS communication_delivery_attempts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  delivery_id            uuid NOT NULL,
  attempt_number         integer NOT NULL CHECK (attempt_number > 0 AND attempt_number <= 10),
  started_at             timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz,
  result                 text NOT NULL DEFAULT 'processing'
                           CHECK (result IN ('processing','submitted','retry_scheduled','failed_permanent','failed_final')),
  provider_response_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_category         text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT communication_delivery_attempts_delivery_tenant_fkey
    FOREIGN KEY (tenant_id, delivery_id)
    REFERENCES outbound_messages(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (delivery_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS communication_delivery_attempts_timeline_idx
  ON communication_delivery_attempts (tenant_id, delivery_id, attempt_number);

CREATE TABLE IF NOT EXISTS communication_settings (
  tenant_id                 uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  default_language          text NOT NULL DEFAULT 'he' CHECK (default_language IN ('he')),
  quiet_hours               jsonb NOT NULL DEFAULT '{"enabled":false,"start":"22:00","end":"07:00"}'::jsonb,
  retry_policy              jsonb NOT NULL DEFAULT '{"maxAttempts":5,"baseDelaySeconds":60,"maxDelaySeconds":3600}'::jsonb,
  failure_notification      jsonb NOT NULL DEFAULT '{"enabled":false}'::jsonb,
  manual_booking_recipients text[] NOT NULL DEFAULT ARRAY[]::text[],
  direct_booking_recipients text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- Granular server-enforced permission catalog. Existing roles receive nothing
-- except system admin roles, preserving least privilege.
INSERT INTO permissions (key, description, category) VALUES
  ('communications.templates.view', 'צפייה בתבניות תקשורת', 'communications'),
  ('communications.deliveries.view', 'צפייה בהיסטוריית משלוחים', 'communications'),
  ('communications.templates.edit', 'יצירה ועריכת טיוטות תקשורת', 'communications'),
  ('communications.templates.publish', 'פרסום גרסאות תבנית', 'communications'),
  ('communications.automations.manage', 'יצירה ועריכת אוטומציות', 'communications'),
  ('communications.automations.activate', 'הפעלה והשבתה של אוטומציות', 'communications'),
  ('communications.channels.manage', 'ניהול הגדרות ערוצי תקשורת', 'communications'),
  ('communications.credentials.replace', 'החלפת פרטי התחברות לספק', 'communications'),
  ('communications.test.send', 'שליחת הודעת בדיקה', 'communications'),
  ('communications.messages.resend', 'שליחה חוזרת ידנית לאורח', 'communications')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description, category = EXCLUDED.category;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key LIKE 'communications.%'
WHERE r.is_system = true AND r.key = 'admin'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Canonical default structured Hebrew confirmation. This is a real template,
-- but seed values contain no fake property/reservation data. Variables resolve
-- only from the tenant-scoped reservation snapshot at delivery creation.
UPDATE message_templates m
SET name = 'תודה ואישור הזמנה',
    subject = 'אישור הזמנה {{reservation.number}} · {{property.name}}',
    category = 'reservation',
    language = 'he',
    lifecycle_state = 'published',
    is_active = true,
    draft_preheader = COALESCE(m.draft_preheader, 'ההזמנה אושרה — כל הפרטים החשובים לקראת האירוח'),
    draft_content = COALESCE(m.draft_content, jsonb_build_object(
    'schemaVersion', 1,
    'blocks', jsonb_build_array(
      jsonb_build_object('id','header','type','logo_header','enabled',true,'condition','always','data',jsonb_build_object()),
      jsonb_build_object('id','title','type','heading','enabled',true,'condition','always','data',jsonb_build_object('text','תודה שהזמנתם אצלנו','level',1)),
      jsonb_build_object('id','greeting','type','text','enabled',true,'condition','always','data',jsonb_build_object('text','שלום {{guest.first_name}},')),
      jsonb_build_object('id','confirmation','type','text','enabled',true,'condition','always','data',jsonb_build_object('text','ההזמנה שלכם אושרה. הנה כל הפרטים החשובים לקראת האירוח:')),
      jsonb_build_object('id','reservation','type','reservation_details','enabled',true,'condition','always','data',jsonb_build_object()),
      jsonb_build_object('id','room','type','room_details','enabled',true,'condition','room_assigned','data',jsonb_build_object()),
      jsonb_build_object('id','payment','type','payment_summary','enabled',true,'condition','always','data',jsonb_build_object()),
      jsonb_build_object('id','balance','type','balance','enabled',true,'condition','balance_positive','data',jsonb_build_object()),
      jsonb_build_object('id','manage','type','action_button','enabled',true,'condition','manage_url_exists','data',jsonb_build_object('label','לצפייה וניהול ההזמנה','urlVariable','reservation.manage_url')),
      jsonb_build_object('id','address','type','property_address','enabled',true,'condition','always','data',jsonb_build_object()),
      jsonb_build_object('id','divider','type','divider','enabled',true,'condition','always','data',jsonb_build_object()),
      jsonb_build_object('id','policy','type','cancellation_policy','enabled',true,'condition','cancellation_policy_exists','data',jsonb_build_object()),
      -- E'' — a plain SQL literal would store a backslash and an "n", and the
      -- guest would receive "נשמח לארח אתכם,\nמגדל הים" verbatim.
      jsonb_build_object('id','signature','type','signature','enabled',true,'condition','always','data',jsonb_build_object('text',E'נשמח לארח אתכם,\n{{property.name}}')),
      jsonb_build_object('id','contact','type','contact','enabled',true,'condition','always','data',jsonb_build_object())
    )
  ))
WHERE m.channel = 'email' AND m.slug = 'booking_confirmation';

INSERT INTO message_template_versions
  (tenant_id, template_id, version_number, sender_display_name, subject, preheader, content)
SELECT m.tenant_id, m.id, 1, m.draft_sender_display_name, m.subject,
       m.draft_preheader, m.draft_content
FROM message_templates m
WHERE m.channel = 'email' AND m.slug = 'booking_confirmation'
  AND m.draft_content IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM message_template_versions v
    WHERE v.template_id = m.id AND v.version_number = 1
  );

UPDATE message_templates m
SET current_published_version_id = v.id, lifecycle_state = 'published'
FROM message_template_versions v
WHERE v.template_id = m.id AND v.version_number = 1
  AND m.slug = 'booking_confirmation'
  AND m.current_published_version_id IS NULL;

INSERT INTO communication_automations
  (tenant_id, name, description, stage, status, attention_reason, trigger_type,
   timing_config, source_filters, conditions, exclusion_rules, recipient_config,
   channel, template_id, template_version_policy, duplicate_policy,
   manual_activation_enabled)
SELECT
  t.id,
  'אישור הזמנה לאורח',
  'שליחת אישור לאורח מיד לאחר אישור הזמנה שנוצרה ב־GuestHub או באתר ההזמנות הישיר',
  'reservation',
  -- BORN 'draft', ALWAYS. A migration must never start sending mail to real
  -- guests: with a connected Gmail channel an 'active' seed would email the very
  -- next confirmed booking, without any operator ever choosing to enable it.
  -- Turning it on is one switch in /communications — an explicit human act, and
  -- setAutomationStatusAction still refuses unless a published template and a
  -- tested provider are both present.
  'draft',
  NULL,
  'reservation.confirmed',
  '{"mode":"immediate","quietHours":"bypass"}'::jsonb,
  '{"include":["back_office","direct_website"]}'::jsonb,
  '{"logic":"all","items":[{"field":"reservation.status","operator":"equals","value":"confirmed"},{"field":"guest.email","operator":"exists"},{"field":"reservation.is_test","operator":"equals","value":false},{"field":"reservation.is_cancelled","operator":"equals","value":false}]}'::jsonb,
  '{"guestCommunicationOptOut":true,"ota":true}'::jsonb,
  '{"type":"primary_guest"}'::jsonb,
  'email', m.id, 'latest_published', 'once_per_event', true
FROM tenants t
JOIN message_templates m
  ON m.tenant_id = t.id
 AND m.channel = 'email'
 AND m.slug = 'booking_confirmation'
 AND m.lifecycle_state = 'published'
 AND m.current_published_version_id IS NOT NULL
ON CONFLICT (tenant_id, name) DO NOTHING;

INSERT INTO communication_settings (tenant_id)
SELECT id FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

DROP TRIGGER IF EXISTS trg_touch_communication_automations ON communication_automations;
CREATE TRIGGER trg_touch_communication_automations
  BEFORE UPDATE ON communication_automations
  FOR EACH ROW EXECUTE FUNCTION guesthub.touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_communication_events ON communication_events;
CREATE TRIGGER trg_touch_communication_events
  BEFORE UPDATE ON communication_events
  FOR EACH ROW EXECUTE FUNCTION guesthub.touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_communication_settings ON communication_settings;
CREATE TRIGGER trg_touch_communication_settings
  BEFORE UPDATE ON communication_settings
  FOR EACH ROW EXECUTE FUNCTION guesthub.touch_updated_at();

DO $$
DECLARE templates_count bigint; automations_count bigint;
BEGIN
  SELECT count(*) INTO templates_count FROM message_templates WHERE slug = 'booking_confirmation' AND channel = 'email';
  SELECT count(*) INTO automations_count FROM communication_automations WHERE name = 'אישור הזמנה לאורח';
  RAISE NOTICE 'Guest Communications — confirmation templates: %, default automations: %',
    templates_count, automations_count;
END $$;
