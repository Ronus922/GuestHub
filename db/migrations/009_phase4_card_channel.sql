-- ============================================================
--  GuestHub · Phase 4 — Payment-card section: channel-sourced cards,
--  card metadata, immediate-charge permission, richer audit (D42).
--
--  Extends the D41 reservation_cards vault with the operational metadata the
--  PMS requires for direct + channel bookings, WITHOUT weakening the storage
--  contract: the PAN is still ONLY AES-256-GCM ciphertext (src/lib/card-vault.ts,
--  key from env CARD_VAULT_KEY, never in the DB); CVV still has NO column and is
--  NEVER persisted (collected transiently for an immediate charge only).
--
--  New card columns:
--    source                   — where the card came from: manual|telephone|
--                               walk_in|website|back_office|channel
--    source_channel           — OTA / channel name when source='channel'
--    provider_reservation_ref — original OTA reservation code (never dropped)
--    is_virtual               — virtual card vs regular guest card (handled apart)
--    available_from/until      — card-data availability window supplied by a channel
--    billing_notes            — free-text billing notes
--    received_at              — when the card details were received (now() for manual)
--  New permission:
--    payments.card_charge     — immediate charge of a stored card (separate perm)
--  Audit columns (immutable log): ip_address, session_info — for reveal/charge/edit.
--  Idempotent: safe to re-run.
--
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/009_phase4_card_channel.sql
--
--  ROLLBACK:
--    ALTER TABLE guesthub.reservation_cards
--      DROP COLUMN IF EXISTS source, DROP COLUMN IF EXISTS source_channel,
--      DROP COLUMN IF EXISTS provider_reservation_ref, DROP COLUMN IF EXISTS is_virtual,
--      DROP COLUMN IF EXISTS available_from, DROP COLUMN IF EXISTS available_until,
--      DROP COLUMN IF EXISTS billing_notes, DROP COLUMN IF EXISTS received_at;
--    ALTER TABLE guesthub.audit_logs
--      DROP COLUMN IF EXISTS ip_address, DROP COLUMN IF EXISTS session_info;
--    DELETE FROM guesthub.role_permissions WHERE permission_id IN
--      (SELECT id FROM guesthub.permissions WHERE key = 'payments.card_charge');
--    DELETE FROM guesthub.permissions WHERE key = 'payments.card_charge';
-- ============================================================

SET search_path TO "guesthub", public;

ALTER TABLE reservation_cards
  ADD COLUMN IF NOT EXISTS source                   text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_channel           text,
  ADD COLUMN IF NOT EXISTS provider_reservation_ref text,
  ADD COLUMN IF NOT EXISTS is_virtual               boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS available_from           date,
  ADD COLUMN IF NOT EXISTS available_until          date,
  ADD COLUMN IF NOT EXISTS billing_notes            text,
  ADD COLUMN IF NOT EXISTS received_at              timestamptz NOT NULL DEFAULT now();

ALTER TABLE reservation_cards
  DROP CONSTRAINT IF EXISTS reservation_cards_source_check;
ALTER TABLE reservation_cards
  ADD CONSTRAINT reservation_cards_source_check
  CHECK (source IN ('manual','telephone','walk_in','website','back_office','channel'));

-- immediate-charge permission (separate effective permission from manage/reveal)
INSERT INTO permissions (key, description, category) VALUES
  ('payments.card_charge', 'חיוב מיידי של כרטיס אשראי שמור (סליקה)', 'payments')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.key = 'payments.card_charge'
WHERE r.key IN ('super_admin','admin','manager')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- audit log: capture IP + session for sensitive card events (append-only)
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS ip_address   text,
  ADD COLUMN IF NOT EXISTS session_info text;
