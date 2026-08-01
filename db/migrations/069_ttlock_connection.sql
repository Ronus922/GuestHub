-- ============================================================
--  069 — TTLock Open Platform connection, per tenant (D120)
--
--  WHY THIS TABLE EXISTS. Ronen's apartment doors are TTLock smart locks. To
--  ever issue a door code to a guest, the server must first hold a working
--  TTLock Open Platform connection for the tenant. This migration stores that
--  connection and NOTHING else: no locks, no passcodes, no rotation history.
--  Those are separate tables in a later task, and deliberately absent here so
--  that a half-built lock feature cannot appear to exist.
--
--  WHY A TENANT-SCOPED TABLE AND NOT AN ENV VAR. GuestHub is multi-tenant. A
--  TTLock account belongs to a property owner, not to the server, so the
--  credential is per-tenant data like every Beds24/messaging connection before
--  it — UNIQUE (tenant_id), FK to tenants ON DELETE CASCADE. An env var would
--  make every tenant share one owner's locks, which is the whole failure mode.
--
--  WHY `region` IS A COLUMN AND NOT A CONSTANT. TTLock runs two disjoint
--  clouds: an application registered on euopen.ttlock.com does not exist for
--  api.ttlock.com and vice versa. The mismatch surfaces as errcode 10001
--  ("invalid client") — the SAME error as a wrong clientSecret, and it fires
--  BEFORE TTLock ever looks at the account. If the region were hardcoded, an
--  operator whose app is registered on the other cloud would see "wrong secret"
--  forever while holding a perfectly correct secret. It has to be selectable,
--  so it has to be stored.
--
--  SECRET HANDLING (mirrors messaging_provider_connections / D53). Two values
--  are secret: the application's clientSecret and the TTLock account password.
--  Both live in ONE AES-256-GCM bag in secret_ciphertext, encrypted with the
--  DEDICATED key TTLOCK_SECRETS_KEY (env, never in the DB, never shared with
--  CHANNEL_SECRETS_KEY or MESSAGING_SECRETS_ENCRYPTION_KEY — separate secret,
--  separate blast radius). client_id and username are NOT secret and are stored
--  in the clear because the operator must see them to know which application
--  and which account this row points at. secret_hint holds a masked tail
--  ("••••••••A92F") for display and is never the value.
--
--  WHY TOKENS ARE CACHED HERE. TTLock access tokens are minted from the
--  account grant and live ~30 days. Re-minting on every call would put the
--  account password on the wire constantly and rate-limit the integration, so
--  the current token is cached encrypted (access_token_ciphertext) alongside
--  its expiry and refresh token, exactly as the Beds24 connection caches its
--  own (D78/D79). status/status_detail/last_tested_at carry the last "בדיקת
--  חיבור" result in HEBREW, because that string is shown to the operator
--  verbatim — the upstream errmsg is Chinese and is never stored or displayed.
--
--  PERMISSIONS SEEDED, NOT YET CONSUMED. locks.view / locks.rotate enter the
--  global catalog now so the next task ships a screen against an existing key
--  rather than a migration+screen in one step. No screen reads them yet.
--  Granted to super_admin + admin only — an admin ROTATES a door code
--  (operational) but never sees a CREDENTIAL: the credential boundary is
--  canManageTTLock in src/lib/auth/guards.ts, which is super_admin-only. Two
--  different boundaries on purpose.
--
--  Idempotent. Safe to replay.
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/069_ttlock_connection.sql
--
--  ROLLBACK:
--    DROP TABLE IF EXISTS guesthub.ttlock_connections;
--    DELETE FROM guesthub.role_permissions rp USING guesthub.permissions p
--      WHERE rp.permission_id = p.id AND p.key IN ('locks.view', 'locks.rotate');
--    DELETE FROM guesthub.permissions WHERE key IN ('locks.view', 'locks.rotate');
-- ============================================================

SET search_path TO "guesthub", public;

CREATE TABLE IF NOT EXISTS guesthub.ttlock_connections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,

  -- which TTLock cloud the application is registered on; selects the base URL
  -- (eu → euapi.ttlock.com, global → api.ttlock.com). See header.
  region      text NOT NULL DEFAULT 'eu'
              CHECK (region IN ('eu', 'global')),

  -- NOT secrets: the operator must see which application and which account
  -- this row points at, and neither value authenticates anything on its own.
  client_id   text NOT NULL,
  username    text NOT NULL,

  -- AES-256-GCM bag { clientSecret, password } under TTLOCK_SECRETS_KEY.
  -- NULL until the operator first supplies them.
  secret_ciphertext text,
  -- masked tail for display only ("••••••••A92F"); NEVER the value
  secret_hint text,

  -- cached access token (encrypted) + its expiry, persisted ~60s early so
  -- clock skew never hands out a token that is already dead upstream
  access_token_ciphertext  text,
  access_token_expires_at  timestamptz,
  refresh_token_ciphertext text,

  -- TTLock's own account id, returned by the token endpoint
  ttlock_uid  bigint,

  status      text NOT NULL DEFAULT 'not_configured'
              CHECK (status IN ('not_configured', 'connected', 'error')),
  -- last "בדיקת חיבור" message, already in Hebrew (hebrewMessageFor) — the
  -- upstream Chinese errmsg is never stored here
  status_detail text,
  last_tested_at timestamptz,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- one TTLock connection per tenant
  UNIQUE (tenant_id)
);

COMMENT ON TABLE guesthub.ttlock_connections IS
  'Per-tenant TTLock Open Platform connection (D120). secret_ciphertext is an AES-256-GCM bag {clientSecret, password} under TTLOCK_SECRETS_KEY — never returned to a client. region selects the cloud (eu|global); a mismatch reports as errcode 10001, indistinguishable from a wrong secret.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guesthub_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON guesthub.ttlock_connections TO guesthub_app';
  END IF;
END $$;

-- ---- permission catalog (global; roles are per-tenant) ----
-- Seeded for the NEXT task's screen. Least privilege, following 036/055: the
-- key exists in every tenant's matrix, but is granted only to the roles that
-- already carry full authority. Reception gets it by an explicit decision in
-- /permissions, never by default.
INSERT INTO permissions (key, description, category) VALUES
  ('locks.view',   'צפייה במנעולים ובקודי הכניסה', 'locks'),
  ('locks.rotate', 'החלפת קוד כניסה',              'locks')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key IN ('locks.view', 'locks.rotate')
WHERE r.key IN ('super_admin', 'admin')
ON CONFLICT (role_id, permission_id) DO NOTHING;
