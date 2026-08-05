-- ============================================================
--  076 — Guest conversations + messages + Booking.com reviews (ingest only)
--
--  WHAT THIS ADDS. Three tables for Phase 4 RECEIVE-ONLY ingest:
--    guest_conversations — one thread per (tenant, channel, external key)
--    guest_messages      — the individual messages, append-only
--    channel_reviews     — Booking.com reviews pulled through Beds24
--  plus the additive job_type CHECK widening for the two new worker jobs
--  ('pull_guest_messages', 'pull_channel_reviews') — the 024/025 pattern.
--
--  EVERY COLUMN BELOW IS MODELED ON A MEASURED WIRE SHAPE, not on the spec:
--  ref/audit/BEDS24-MESSAGES-SHAPE-2026-08-05.json (56 messages, live probe)
--  ref/audit/BEDS24-REVIEWS-SHAPE-2026-08-05.json  (24 reviews,  live probe)
--  corroborated by ref/audit/BEDS24-REVIEWS-PROBE-2026-08-02.md.
--
--  CONVERSATION IDENTITY. Beds24 messages carry NO thread/conversation id —
--  measured: the only grouping key is bookingId. A Beds24 conversation is
--  therefore DEFINED AS "all messages sharing a bookingId", and
--  external_thread_key holds that bookingId as text. For WhatsApp (GREEN-API)
--  the key is the chatId ("<msisdn>@c.us"). UNIQUE (tenant_id, channel,
--  external_thread_key) makes every ingest path converge on one row.
--
--  MESSAGES ARE APPEND-ONLY. UNIQUE (tenant_id, provider, external_message_id)
--  + ON CONFLICT DO NOTHING makes every re-poll of an unchanged window a
--  no-op — the same synthetic-idempotency doctrine as
--  channel_booking_revisions. Nothing ever updates a message body.
--
--  THE REVIEWS JOIN-KEY TRAP (measured 2026-08-02, do not "fix" this).
--  A review's wire reservation_id is BOOKING.COM's reservation number, the
--  same namespace as guesthub.reservations.ota_reservation_code. It is NOT
--  the Beds24 booking id: joining booking_id to reservations.external_booking_id
--  matches 0 rows and produces an empty screen with no error. The messages
--  feed keys on the OPPOSITE identifier (bookingId = external_booking_id,
--  14/14 matched). booking_id here stores the wire value verbatim.
--
--  `reply` IS READ-ONLY, FOREVER. Beds24 support confirmed (2026-08-02):
--  there is NO API endpoint to post a review reply. The spec's only
--  occurrence of `reply` is this response field. A staff reply written in the
--  Booking.com extranet is reflected back by polling — that poll is the ONLY
--  writer of reply/replied_at. Nothing in this system composes a reply.
--  "Awaiting response" = reply IS NULL (surfaced worst-score-first), hence
--  the partial index below.
--
--  NO UI, NO OUTBOUND SEND in this phase. The dashboard 'msg'/'rvw' windows
--  stay placeholders; POST /bookings/messages is deliberately not built.
--
--  HOW THIS IS APPLIED — NOT BY HAND. The deploy owns migration application
--  (064): scripts/apply-pending-migrations.mjs runs before the pm2 restart
--  and writes the guesthub.schema_migrations row only after a clean apply.
--
--  Idempotent. Safe to replay from zero. No data is deleted.
--
--  ROLLBACK (manual):
--    DROP TABLE IF EXISTS guesthub.guest_messages;
--    DROP TABLE IF EXISTS guesthub.guest_conversations;
--    DROP TABLE IF EXISTS guesthub.channel_reviews;
--    -- then re-run the 025 job_type CHECK block to drop the two new values
-- ============================================================

SET search_path TO "guesthub", public;

-- ---- 1. conversations — one thread per (tenant, channel, external key) ----

CREATE TABLE IF NOT EXISTS guesthub.guest_conversations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,

  -- resolved lazily: a Beds24 thread resolves through
  -- reservations.external_booking_id (measured 14/14); a WhatsApp thread may
  -- never resolve. NULL is a normal, renderable state — never a defect.
  reservation_id uuid REFERENCES guesthub.reservations(id) ON DELETE SET NULL,
  guest_id       uuid REFERENCES guesthub.guests(id) ON DELETE SET NULL,

  channel        text NOT NULL CHECK (channel IN ('beds24', 'whatsapp')),

  -- beds24: the Beds24 bookingId (as text) — the ONLY grouping key on that
  -- wire (measured: no threadId exists). whatsapp: the GREEN-API chatId.
  external_thread_key text NOT NULL,

  -- denormalized stamps for inbox ordering, maintained by the single message
  -- insert path (GREATEST — a backfilled older message never regresses them)
  last_message_at timestamptz,
  last_inbound_at timestamptz,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, channel, external_thread_key),
  -- tenant-scoped composite FK target (036 doctrine): a message row can only
  -- ever point at a conversation of its OWN tenant
  UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS guest_conversations_inbox_idx
  ON guesthub.guest_conversations (tenant_id, last_message_at DESC);

DROP TRIGGER IF EXISTS trg_guest_conversations_updated_at ON guesthub.guest_conversations;
CREATE TRIGGER trg_guest_conversations_updated_at
  BEFORE UPDATE ON guesthub.guest_conversations
  FOR EACH ROW EXECUTE FUNCTION guesthub.set_updated_at();

-- ---- 2. messages — append-only, idempotent on the provider's own id ----

CREATE TABLE IF NOT EXISTS guesthub.guest_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,

  direction       text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  -- who delivered the bytes. beds24 = the poll (both directions — its feed
  -- carries host AND guest messages); green_api = the inbound webhook.
  provider        text NOT NULL CHECK (provider IN ('beds24', 'green_api')),

  -- beds24: the numeric message id, as text. green_api: idMessage.
  external_message_id text NOT NULL,

  body            text NOT NULL,
  -- beds24 `time` is measured UTC ("...Z", 56/56); green_api sends epoch secs
  sent_at         timestamptz NOT NULL,

  -- future join: an outbound WhatsApp row in outbound_messages that this
  -- message mirrors. NULL for everything this phase writes — outbound
  -- WhatsApp history is deliberately NOT backfilled here (the thread view
  -- will read outbound_messages directly; that join is a later task).
  outbound_message_id uuid REFERENCES guesthub.outbound_messages(id) ON DELETE SET NULL,

  raw             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- idempotency: a re-poll / webhook replay of a known message is a no-op
  UNIQUE (tenant_id, provider, external_message_id),
  -- same-tenant enforcement through the composite key (036 doctrine)
  CONSTRAINT guest_messages_conversation_tenant_fkey
    FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES guesthub.guest_conversations (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS guest_messages_thread_idx
  ON guesthub.guest_messages (conversation_id, sent_at);

-- ---- 3. reviews — upsert on the review id; `reply` arrives later ----

CREATE TABLE IF NOT EXISTS guesthub.channel_reviews (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  connection_id      uuid NOT NULL REFERENCES guesthub.channel_connections(id) ON DELETE CASCADE,

  -- the Beds24 property the poll was scoped to; text, matching
  -- channel_beds24_room_mappings.beds24_property_id
  property_id        text NOT NULL,

  -- wire review_id — an opaque string ("Y6walWdoHzY"), NOT numeric
  external_review_id text NOT NULL,

  -- wire reservation_id — BOOKING.COM's reservation number. Joins
  -- reservations.ota_reservation_code, NOT external_booking_id (see header).
  booking_id         text,

  guest_name         text,
  -- wire created_timestamp, "YYYY-MM-DD HH:MM:SS" with no zone; stored as
  -- UTC, the verbatim string survives in raw
  submitted_at       timestamptz NOT NULL,

  -- scoring.review_score, 1..10; category scores are fractional (7.5), so
  -- the overall is stored fractional too
  overall_score      numeric(4, 1) NOT NULL,
  -- the whole measured scoring object: facilities/comfort/staff/value/clean/
  -- location/review_score. Note: the live wire carries `comfort` and NOT the
  -- spec's `services` — jsonb absorbs that drift instead of losing it.
  category_scores    jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- content.positive / content.negative; content itself is null on score-only
  -- reviews (10 of 24 measured), so both are nullable
  positive_text      text,
  negative_text      text,

  -- READ-ONLY REFLECTION of a staff reply written in the Booking.com
  -- extranet, populated ONLY by the Beds24 poll (reply.text /
  -- reply.last_change_timestamp). No write path exists in the API — Beds24
  -- support, 2026-08-02. Nothing in this system ever composes these.
  reply              text,
  replied_at         timestamptz,

  raw                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, external_review_id)
);

-- "awaiting response" = reply IS NULL, surfaced worst-score-first. Partial on
-- purpose: answered reviews leave the index entirely.
CREATE INDEX IF NOT EXISTS channel_reviews_awaiting_reply_idx
  ON guesthub.channel_reviews (tenant_id, overall_score, submitted_at DESC)
  WHERE reply IS NULL;

DROP TRIGGER IF EXISTS trg_channel_reviews_updated_at ON guesthub.channel_reviews;
CREATE TRIGGER trg_channel_reviews_updated_at
  BEFORE UPDATE ON guesthub.channel_reviews
  FOR EACH ROW EXECUTE FUNCTION guesthub.set_updated_at();

-- ---- 4. durable job types for the two pollers (additive CHECK widening) ----
-- 'pull_guest_messages'  = GET /bookings/messages, every 5 minutes
-- 'pull_channel_reviews' = GET /channels/booking/reviews, once per 24 hours
ALTER TABLE guesthub.channel_sync_jobs DROP CONSTRAINT IF EXISTS channel_sync_jobs_job_type_check;
ALTER TABLE guesthub.channel_sync_jobs ADD  CONSTRAINT channel_sync_jobs_job_type_check
  CHECK (job_type IN (
    'validate_connection','full_sync','sync_availability','sync_rates',
    'sync_restrictions','sync_ari_range','pull_booking_revisions',
    'import_booking_revision','acknowledge_booking_revision',
    'reconcile_inventory','retry_failed_range',
    'sync_room_types','create_room_type',
    'sync_rate_plans','create_rate_plan',
    'pull_guest_messages','pull_channel_reviews'));
