-- ============================================================
--  087 — messaging_channel_alerts: the owner is told ONCE per failure streak
--
--  WHY. From 2026-09-02 to 2026-09-05 every WhatsApp send failed green_400
--  ("Instance account is expired") — nine rows, three automation runs and a
--  manual send — while messaging_provider_connections.status still read
--  'connected' from the test of 2026-07-30, and nobody was told. D173 adds a
--  dashboard card that reads outbound_messages instead of the test row, and an
--  email to the owner when a channel reaches 3 consecutive provider failures.
--
--  WHAT THIS TABLE IS. The "once" of that email, as a database fact. One row
--  per (tenant, channel, streak): streak_key is the id of the last SUCCESSFUL
--  send before the failures began ('none' when no success is in the window).
--  The UNIQUE constraint is the lock — INSERT … ON CONFLICT DO NOTHING lets
--  exactly one caller (the PM2 worker or a server action, whichever lands the
--  row) send the mail; every later failure in the same streak finds the row
--  and does nothing. A new success starts a new key, so the next outage alerts
--  again. The mail itself is NOT an outbound_messages row: an alert about the
--  pipe must not become a data point about the pipe.
--
--  email_status records what happened to the alert mail — including that it
--  could not go out (the email channel itself may be the one failing). That is
--  recorded, not retried: the dashboard card is the surface that does not
--  depend on a working channel.
--
--  The index on outbound_messages serves the one health query
--  (channel-health-db.ts): newest counted rows per tenant+channel, ordered by
--  the send moment COALESCE(submitted_at, updated_at) — a worker row is
--  created when queued and may fail an hour of retries later, so created_at
--  would misorder it.
--
--  Grants: covered by 082's default privileges for supabase_admin in schema
--  guesthub — no per-table GRANT here, by design.
--
--  Idempotent: CREATE IF NOT EXISTS throughout. No backfill — the nine
--  historical failures are not re-alerted.
--
--  ROLLBACK:
--    DROP INDEX IF EXISTS guesthub.outbound_messages_channel_health_idx;
--    DROP TABLE IF EXISTS guesthub.messaging_channel_alerts;
-- ============================================================
SET search_path TO "guesthub", public;

CREATE TABLE IF NOT EXISTS guesthub.messaging_channel_alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  -- id of the last successful send before this streak, or 'none'
  streak_key    text NOT NULL,
  -- the streak length when the alert fired
  failures      integer NOT NULL CHECK (failures > 0),
  -- the last failure's error_code at that moment (green_400, gmail_401, …)
  error_code    text,
  notified_to   text[] NOT NULL DEFAULT '{}',
  email_status  text NOT NULL DEFAULT 'pending'
                  CHECK (email_status IN ('pending', 'sent', 'partial', 'send_failed',
                                          'no_recipients', 'email_not_configured', 'error')),
  email_error   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  notified_at   timestamptz,
  UNIQUE (tenant_id, channel, streak_key)
);

CREATE INDEX IF NOT EXISTS outbound_messages_channel_health_idx
  ON guesthub.outbound_messages (tenant_id, channel, (COALESCE(submitted_at, updated_at)) DESC);
