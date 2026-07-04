-- ============================================================
--  GuestHub · Phase 2 — Per-user permission overrides
--  Roles stay the default permission source (role_permissions); this table adds
--  a personal layer on top: effect='grant' adds a permission the role lacks,
--  effect='revoke' removes one the role includes. Resolution (server-side):
--    effective = role_permissions ∪ grants − revokes
--  Managed only by holders of permissions.update (existing key — no new seed
--  permission needed), guarded further by rank/dominance rules in the app.
--  Idempotent: safe to re-run.
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/003_user_permission_overrides.sql
-- ============================================================

SET search_path TO "guesthub", public;

CREATE TABLE IF NOT EXISTS user_permission_overrides (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id)     ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  effect        text NOT NULL CHECK (effect IN ('grant', 'revoke')),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, permission_id)
);

-- Permission resolution reads by (tenant_id, user_id) — covered by the UNIQUE
-- index prefix above. Extra indexes keep FK-side deletes cheap.
CREATE INDEX IF NOT EXISTS idx_user_perm_overrides_user
  ON user_permission_overrides(user_id);
CREATE INDEX IF NOT EXISTS idx_user_perm_overrides_permission
  ON user_permission_overrides(permission_id);

-- updated_at trigger — same pattern as 000_init_schema.
DROP TRIGGER IF EXISTS trg_user_permission_overrides_updated_at ON user_permission_overrides;
CREATE TRIGGER trg_user_permission_overrides_updated_at
  BEFORE UPDATE ON user_permission_overrides
  FOR EACH ROW EXECUTE FUNCTION guesthub.set_updated_at();

-- Hardened grants — same posture as 000: service_role only, nothing for
-- anon/authenticated (the app reaches the schema through DATABASE_URL only).
GRANT ALL ON user_permission_overrides TO service_role;
REVOKE ALL ON user_permission_overrides FROM anon, authenticated;
