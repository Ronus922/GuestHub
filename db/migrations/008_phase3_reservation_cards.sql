-- ============================================================
--  GuestHub · Phase 3 — Protected reservation card storage (D41)
--  ONE active card per reservation. The PAN is stored ONLY as
--  AES-256-GCM ciphertext produced at the application layer
--  (src/lib/card-vault.ts, key from env CARD_VAULT_KEY — never in the
--  DB). CVV is NEVER stored (no column exists). brand/last4/expiry are
--  kept separately for masked display. New permission keys:
--    payments.card_manage — save / replace / delete a stored card
--    payments.card_reveal — decrypt the full PAN (explicit, audited)
--  Idempotent: safe to re-run.
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/008_phase3_reservation_cards.sql
--
--  ROLLBACK (reverse order):
--    DELETE FROM guesthub.role_permissions WHERE permission_id IN
--      (SELECT id FROM guesthub.permissions WHERE key IN ('payments.card_manage','payments.card_reveal'));
--    DELETE FROM guesthub.user_permission_overrides WHERE permission_id IN
--      (SELECT id FROM guesthub.permissions WHERE key IN ('payments.card_manage','payments.card_reveal'));
--    DELETE FROM guesthub.permissions WHERE key IN ('payments.card_manage','payments.card_reveal');
--    DROP TABLE IF EXISTS guesthub.reservation_cards;
-- ============================================================

SET search_path TO "guesthub", public;

CREATE TABLE IF NOT EXISTS reservation_cards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reservation_id  uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  holder_name     text NOT NULL,
  holder_id_number text,
  pan_encrypted   text NOT NULL,            -- "v1.<iv>.<tag>.<data>" (base64), AES-256-GCM
  key_version     smallint NOT NULL DEFAULT 1,
  brand           text,
  last4           text NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  exp_month       smallint NOT NULL CHECK (exp_month BETWEEN 1 AND 12),
  exp_year        smallint NOT NULL CHECK (exp_year BETWEEN 2000 AND 2099),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reservation_id)                   -- one active stored card per reservation
);
CREATE INDEX IF NOT EXISTS idx_reservation_cards_tenant ON reservation_cards(tenant_id);

INSERT INTO permissions (key, description, category) VALUES
  ('payments.card_manage', 'שמירה, החלפה ומחיקה של כרטיס אשראי בהזמנה', 'payments'),
  ('payments.card_reveal', 'חשיפת מספר כרטיס מלא (מבוקר ומתועד)',      'payments')
ON CONFLICT (key) DO NOTHING;

-- manage: management + reception (they take reservations with cards);
-- reveal: management only. super_admin/admin bypass checks anyway.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.key = 'payments.card_manage'
WHERE r.key IN ('super_admin','admin','manager','receptionist')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.key = 'payments.card_reveal'
WHERE r.key IN ('super_admin','admin','manager')
ON CONFLICT (role_id, permission_id) DO NOTHING;
