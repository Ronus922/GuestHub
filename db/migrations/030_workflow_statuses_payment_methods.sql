-- ============================================================
--  030 · D77 — tenant workflow statuses, OTA reporting stamps,
--        PSP payment-method references, charge idempotency
--  Additive + idempotent. NO existing reservation/payment row is modified
--  except the workflow-status BACKFILL (sets a previously NULL column).
--
--  THREE STATUS DOMAINS (D77 §B) — never one column for all meanings:
--   · technical lifecycle  = reservations.status            (unchanged)
--   · workflow status      = reservations.workflow_status_id → lookup_items
--   · payment status       = derived from the payments ledger (unchanged)
--
--  WHY lookup_items (not a new table): lookup_items IS the existing
--  tenant-scoped configurable list model (id/tenant/key/label/color/
--  sort_order/is_active/metadata, UNIQUE(tenant,category,key)), already
--  FK-referenced by reservations.source_id, and the approved Settings design
--  (ref/html/Settings.html) manages exactly such lists. A parallel
--  "workflow_statuses" table would duplicate it.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/030_workflow_statuses_payment_methods.sql
--
--  ROLLBACK:
--    ALTER TABLE guesthub.reservations
--      DROP COLUMN IF EXISTS workflow_status_id,
--      DROP COLUMN IF EXISTS invalid_card_reported_at,
--      DROP COLUMN IF EXISTS external_cancellation_requested_at,
--      DROP COLUMN IF EXISTS no_show_reported_at;
--    DROP TABLE IF EXISTS guesthub.reservation_payment_methods;
--    ALTER TABLE guesthub.payments DROP COLUMN IF EXISTS idempotency_key;
--    DELETE FROM guesthub.lookup_items WHERE category = 'workflow_statuses';
--    (indexes/constraints drop with their columns/tables)
-- ============================================================

SET search_path TO "guesthub", public;

-- ---- 1. workflow status definitions (lookup_items, category-scoped) ----
-- colour must be a full hex value — the UI derives WCAG text colour from it
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'lookup_items_workflow_color_chk') THEN
    ALTER TABLE guesthub.lookup_items ADD CONSTRAINT lookup_items_workflow_color_chk
      CHECK (category <> 'workflow_statuses' OR color ~ '^#[0-9A-Fa-f]{6}$');
  END IF;
END $$;

-- at most ONE ACTIVE default per tenant (the app refuses to deactivate the
-- default without electing another, keeping it exactly one)
CREATE UNIQUE INDEX IF NOT EXISTS uq_lookup_workflow_default
  ON guesthub.lookup_items (tenant_id)
  WHERE category = 'workflow_statuses' AND is_active
    AND (metadata->>'is_default') = 'true';

-- seed the four statuses for EVERY tenant, idempotently (colors from the
-- existing seeded palette). No is_default yet — elected below.
INSERT INTO guesthub.lookup_items
  (tenant_id, category, key, label, color, sort_order, is_active, metadata)
SELECT t.id, 'workflow_statuses', v.key, v.label, v.color, v.ord, true, '{}'::jsonb
FROM guesthub.tenants t
CROSS JOIN (VALUES
  ('approved',         'הזמנה אושרה',   '#16A34A', 0),
  ('missing_docs',     'חסר מסמכים',    '#EA9314', 1),
  ('card_declined',    'כרטיס לא עבר',  '#DC2626', 2),
  ('awaiting_payment', 'ממתין לתשלום',  '#2540C8', 3)
) AS v(key, label, color, ord)
ON CONFLICT (tenant_id, category, key) DO NOTHING;

-- "הזמנה אושרה" becomes the default ONLY where no active default exists yet —
-- an existing tenant default is never overridden
UPDATE guesthub.lookup_items li
SET metadata = jsonb_set(li.metadata, '{is_default}', 'true'::jsonb)
WHERE li.category = 'workflow_statuses' AND li.key = 'approved' AND li.is_active
  AND NOT EXISTS (
    SELECT 1 FROM guesthub.lookup_items x
    WHERE x.tenant_id = li.tenant_id AND x.category = 'workflow_statuses'
      AND x.is_active AND (x.metadata->>'is_default') = 'true');

-- ---- 2. reservations: workflow link + OTA reporting stamps ----
-- ON DELETE RESTRICT = a status referenced by any reservation cannot be
-- hard-deleted (deactivation is the supported retirement path)
ALTER TABLE guesthub.reservations
  ADD COLUMN IF NOT EXISTS workflow_status_id uuid
    REFERENCES guesthub.lookup_items(id) ON DELETE RESTRICT,
  -- Booking.com Reporting API stamps (D77 §I): durable idempotency + the
  -- server-side eligibility inputs for cancel-due-invalid-card
  ADD COLUMN IF NOT EXISTS invalid_card_reported_at timestamptz,
  ADD COLUMN IF NOT EXISTS external_cancellation_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS no_show_reported_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_reservations_workflow
  ON guesthub.reservations (tenant_id, workflow_status_id);

-- backfill: every reservation without a workflow status gets its tenant's
-- active default (safe: only fills NULLs, touches nothing else)
UPDATE guesthub.reservations r
SET workflow_status_id = d.id
FROM guesthub.lookup_items d
WHERE r.workflow_status_id IS NULL
  AND d.tenant_id = r.tenant_id
  AND d.category = 'workflow_statuses' AND d.is_active
  AND (d.metadata->>'is_default') = 'true';

-- ---- 3. PSP payment-method references (D77 §E) ----
-- Stores ONLY the provider reference + safe display metadata. NEVER a PAN,
-- NEVER a CVV (no columns exist). The reference is unusable without the
-- provider's own secret key and is never logged or audited verbatim.
CREATE TABLE IF NOT EXISTS guesthub.reservation_payment_methods (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES guesthub.reservations(id) ON DELETE CASCADE,
  provider       text NOT NULL CHECK (provider IN ('stripe')),
  provider_ref   text NOT NULL,
  brand          text,
  last4          text CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$'),
  exp_month      smallint CHECK (exp_month IS NULL OR exp_month BETWEEN 1 AND 12),
  exp_year       smallint CHECK (exp_year IS NULL OR exp_year BETWEEN 2000 AND 2099),
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by     uuid REFERENCES guesthub.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- tokenization idempotency: a second click finds and reuses this row
  UNIQUE (reservation_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_rpm_tenant ON guesthub.reservation_payment_methods (tenant_id);

DROP TRIGGER IF EXISTS trg_reservation_payment_methods_updated_at
  ON guesthub.reservation_payment_methods;
CREATE TRIGGER trg_reservation_payment_methods_updated_at
  BEFORE UPDATE ON guesthub.reservation_payment_methods
  FOR EACH ROW EXECUTE FUNCTION guesthub.set_updated_at();

-- ---- 4. durable charge idempotency (D77 §F) ----
-- a retried/double-clicked charge with the same key can never create a second
-- payment row — enforced by the database, not the button
ALTER TABLE guesthub.payments
  ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_idempotency
  ON guesthub.payments (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---- 5. grants (000 pattern) ----
GRANT ALL ON ALL TABLES IN SCHEMA "guesthub" TO service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA "guesthub" FROM anon, authenticated;
