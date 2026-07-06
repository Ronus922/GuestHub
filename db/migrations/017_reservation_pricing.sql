-- ============================================================
-- 017 — Canonical reservation pricing (D51).
-- Additive only; idempotent; safe on a live database.
--
--   1. reservation_rooms.rate_plan_id      — the tenant-level Rate Plan the
--      stay was priced under (NULL = base-ARI layer, the pre-Rate-Plans mode).
--      ON DELETE SET NULL keeps history safe when a plan is hard-deleted.
--   2. reservation_rooms.pricing_snapshot  — the immutable commercial snapshot
--      (engine version, fingerprint, nightly breakdown, adjustments, VAT,
--      occupancy/extra-guest, manual-override provenance) written at pricing
--      time and NEVER recomputed at read time.
--   3. permission reservations.price_override — authorized manual nightly
--      price (§13). manager inherits; admin / super_admin bypass granular
--      checks (see requirePermission).
-- ============================================================

SET search_path TO "guesthub", public;

ALTER TABLE reservation_rooms
  ADD COLUMN IF NOT EXISTS rate_plan_id uuid REFERENCES pricing_plans(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pricing_snapshot jsonb;

CREATE INDEX IF NOT EXISTS idx_reservation_rooms_rate_plan
  ON reservation_rooms(rate_plan_id) WHERE rate_plan_id IS NOT NULL;

INSERT INTO permissions (key, description, category) VALUES
  ('reservations.price_override', 'קביעת מחיר ידני מאושר להזמנה', 'reservations')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.key = 'reservations.price_override'
WHERE r.key = 'manager'
ON CONFLICT DO NOTHING;
