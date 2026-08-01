-- ============================================================
--  070 — TTLock locks + room mapping, per tenant (D123)
--
--  WHAT THIS ADDS ON TOP OF 069. 069 stored the CONNECTION: one encrypted
--  credential per tenant, proven by a probe that counted 12 locks upstream and
--  then threw the list away. This migration gives those locks a home and binds
--  each one to a room. Still no passcodes, no code issuing, no rotation history
--  and no reservation linkage — those are separate tables in the next task and
--  are deliberately absent so that a half-built lock feature cannot appear to
--  exist. A `locks.rotate` permission has existed since 069 and STILL has no
--  screen behind it; that is intentional, not an oversight.
--
--  WHY PERSIST LOCKS AT ALL INSTEAD OF LISTING THEM LIVE. The mapping is the
--  reason. A lock→room binding is operator knowledge that exists nowhere
--  upstream: TTLock knows a door is called "דירה 4 כניסה", it has never heard
--  of room 402. That binding needs a row of our own to live on, and a row of
--  our own needs a stable local key for the upstream lock — hence
--  UNIQUE (tenant_id, ttlock_lock_id). Once the row exists, caching alias/mac/
--  battery on it is free and makes the screen readable without an API call.
--
--  `missing_since` — WHY A SYNC MAY NEVER DELETE. The obvious implementation of
--  "sync the lock list" is: fetch, upsert what came back, delete what did not.
--  That implementation destroys operator work. A gateway that is offline, a
--  paging edge, a rate limit, a lock temporarily unshared from the account —
--  each returns a SHORTER list, and each would silently drop a mapping the
--  operator built by hand. They would find out when a door stopped getting
--  codes, with nothing on any screen explaining why.
--
--  So a lock that is not in the response is STAMPED, never removed:
--  missing_since := now(), everything else — above all room_id — untouched. The
--  lock keeps its row, keeps its mapping, and the screen says out loud that it
--  was not in the last sync and since when. A lock that reappears clears the
--  stamp. Deletion is an operator decision, never a sync's, and this table has
--  no code path that deletes on the strength of an upstream absence.
--
--  THE TWO UNIQUE CONSTRAINTS ARE THE SAME RULE TWICE. One physical door, one
--  physical room. UNIQUE (tenant_id, ttlock_lock_id) stops the same upstream
--  lock landing twice; the partial UNIQUE (tenant_id, room_id) WHERE room_id IS
--  NOT NULL stops two locks claiming one room. It must be PARTIAL: unmapped
--  locks all carry room_id NULL, and a plain unique index would be satisfied by
--  that only because NULLs do not collide in Postgres — relying on that is a
--  coincidence, not a design. Written as a partial index it says what it means.
--
--  WHY room_id IS `ON DELETE SET NULL` AND NOT CASCADE. Deleting a room must
--  not delete the lock — the door still exists and still belongs to this
--  tenant's TTLock account. It becomes unmapped and shows up on the screen as
--  awaiting a room, which is exactly true.
--
--  `tz_offset_minutes` IS FOR THE NEXT TASK. TTLock returns timezoneRawOffset
--  and every passcode has a validity window expressed in the LOCK's timezone,
--  not ours. Capturing it now costs one column and means the code-issuing task
--  does not need a second sync pass to learn it. It is stored and unused today.
--
--  `raw` IS THE UPSTREAM ROW VERBATIM. Not a secret: /v3/lock/list returns
--  device metadata (alias, mac, battery, feature flags, gateway state) and no
--  credential — the accessToken travels in the REQUEST and is never echoed in
--  the response. Keeping the whole row means a field we did not think to model
--  is still recoverable without re-syncing.
--
--  Permission `locks.map` joins the 069 pair. Same category, same two roles:
--  mapping a lock to a room is an operational act (which door is which
--  apartment), not a credential act. The credential boundary remains
--  canManageTTLock in src/lib/auth/guards.ts, super_admin only, and nothing in
--  this migration widens it.
--
--  HOW THIS IS APPLIED — NOT BY HAND. Since 064 the deploy owns migration
--  application: scripts/deploy-production.sh runs
--  scripts/apply-pending-migrations.mjs BEFORE the pm2 restart, and that runner
--  writes the guesthub.schema_migrations row only after the file applied
--  cleanly. Applying this DDL manually via `docker exec … psql` leaves NO
--  ledger row — the "applied but unrecorded" state migration 064 exists to end.
--  065-069 carry no run line for exactly this reason; neither does this one.
--
--  Idempotent. Safe to replay — and that is load-bearing, not a courtesy: the
--  runner performs the apply and the ledger INSERT as two separate psql
--  invocations, not one transaction, so a crash between them re-applies this
--  file on the next deploy.
--
--  ROLLBACK:
--    DROP TABLE IF EXISTS guesthub.ttlock_locks;
--    DELETE FROM guesthub.role_permissions rp USING guesthub.permissions p
--      WHERE rp.permission_id = p.id AND p.key = 'locks.map';
--    DELETE FROM guesthub.permissions WHERE key = 'locks.map';
-- ============================================================

SET search_path TO "guesthub", public;

CREATE TABLE IF NOT EXISTS guesthub.ttlock_locks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,

  -- TTLock's own numeric id for the device. The join key to upstream, and the
  -- only stable identity a lock has: an operator can rename an alias freely.
  ttlock_lock_id bigint NOT NULL,

  -- THE MAPPING. NULL = this lock has no room yet. Never written by a sync —
  -- see the header, and scripts/check-ttlock-secrets.mjs rule 6, which fails
  -- the build if syncLocks ever touches this column.
  room_id     uuid REFERENCES guesthub.rooms(id) ON DELETE SET NULL,

  -- lockAlias upstream — how the operator recognises the door, so it leads on
  -- the screen. NOT NULL: a lock with no name is unusable to a human, and the
  -- sync falls back to the id rather than storing an empty string.
  alias       text NOT NULL,
  mac         text,
  battery     smallint,

  -- timezoneRawOffset, in minutes. Stored for the passcode task; unused today.
  tz_offset_minutes integer,

  -- the upstream row verbatim (no credential is present in it — see header)
  raw         jsonb NOT NULL DEFAULT '{}'::jsonb,

  synced_at   timestamptz,

  -- Stamped when a sync did not see this lock. NOT a deletion and NOT a
  -- tombstone: the row and its mapping stay live and visible. Cleared the
  -- moment the lock reappears.
  missing_since timestamptz,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- one row per upstream lock, per tenant
  UNIQUE (tenant_id, ttlock_lock_id)
);

-- One room may carry at most one lock. PARTIAL on purpose: unmapped locks all
-- hold room_id NULL and must not compete with each other. See header.
CREATE UNIQUE INDEX IF NOT EXISTS ttlock_locks_tenant_room_uniq
  ON guesthub.ttlock_locks (tenant_id, room_id)
  WHERE room_id IS NOT NULL;

-- The screen's own access path: this tenant's locks, joined to their rooms.
CREATE INDEX IF NOT EXISTS idx_ttlock_locks_tenant_room
  ON guesthub.ttlock_locks (tenant_id, room_id);

COMMENT ON TABLE guesthub.ttlock_locks IS
  'Per-tenant TTLock devices and their room mapping (D123). room_id is OPERATOR data and is never written by a sync. A lock absent from a sync is stamped missing_since and kept — deletion is never a sync''s decision.';

COMMENT ON COLUMN guesthub.ttlock_locks.missing_since IS
  'Set when a sync did not return this lock; cleared when it reappears. The row and its mapping survive — a short upstream list is a fault, not an instruction to forget a mapping.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guesthub_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON guesthub.ttlock_locks TO guesthub_app';
  END IF;
END $$;

-- ---- permission catalog (global; roles are per-tenant) ----
-- Joins locks.view / locks.rotate from 069. Same two roles: mapping a door to
-- an apartment is operational knowledge, not a credential.
INSERT INTO permissions (key, description, category) VALUES
  ('locks.map', 'מיפוי מנעול לחדר', 'locks')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = 'locks.map'
WHERE r.key IN ('super_admin', 'admin')
ON CONFLICT (role_id, permission_id) DO NOTHING;
