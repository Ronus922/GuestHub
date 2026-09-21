-- ============================================================
--  092 — BIOS Bot service-write idempotency (Phase 5 §11)
--
--  WHY. The Phase 5 audit found reservation create/modify/cancel have ZERO
--  request-level idempotency anywhere in GuestHub today — the only defense
--  against a double-submit is a disabled UI button. BIOS Bot's own Phase 4
--  idempotency covers its side only; this is the GuestHub-side durable
--  defense-in-depth layer the audit and the owner decision both require,
--  scoped to exactly the BIOS Bot service boundary (/api/bios-bot/v1/*).
--
--  SEMANTICS (owner decision, documented here since the schema encodes it):
--    - same (tenant, operation, idempotency_key) + same normalized request
--      → the ORIGINAL result is replayed, success or failure alike. A
--        legitimate business failure (e.g. ROOM_NOT_AVAILABLE) is cached
--        and replayed too — a blind client retry on ANY non-2xx must never
--        get a different answer for the same key.
--    - same key + a DIFFERENT normalized request → IDEMPOTENCY_CONFLICT.
--    - the claim INSERT (status='pending'), the business write, and the
--      finalize UPDATE (status→'succeeded'|'failed') all happen in ONE
--      transaction (src/lib/bios-bot/idempotency.ts) — so a 'pending' row
--      is NEVER visible to any other transaction: by the time anyone else
--      can see this row, it already committed in its final state. A crash
--      or unexpected exception before that commit rolls back the WHOLE
--      thing, claim row included — an incomplete execution leaves no
--      trace and is safe to retry fresh.
--    - the UNIQUE constraint is what makes "concurrent same key executes
--      exactly once" true: a second transaction's claim INSERT (via
--      ON CONFLICT DO NOTHING against this same unique index) blocks on
--      the unique index until the first commits or rolls back, so by the
--      time it can see a row (or its own INSERT reports the conflict), that
--      row is already final.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/092_bios_bot_idempotency.sql
--
--  ROLLBACK (only if nothing has written through the Phase 5 write API yet):
--    DROP TABLE IF EXISTS guesthub.bios_bot_idempotency_keys;
-- ============================================================
SET search_path TO "guesthub", public;

CREATE TABLE IF NOT EXISTS guesthub.bios_bot_idempotency_keys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  operation        text NOT NULL,
  idempotency_key  text NOT NULL,
  request_hash     text NOT NULL,
  -- 'pending' exists only transiently inside the claiming transaction — see
  -- the header. No other transaction can ever read a 'pending' row.
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  resource_id      uuid,
  response         jsonb,
  error_code       text,
  error_message    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  CHECK (status <> 'succeeded' OR (error_code IS NULL AND completed_at IS NOT NULL)),
  CHECK (status <> 'failed' OR (response IS NULL AND resource_id IS NULL AND error_code IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS bios_bot_idempotency_keys_scope_uniq
  ON guesthub.bios_bot_idempotency_keys (tenant_id, operation, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_bios_bot_idempotency_keys_tenant
  ON guesthub.bios_bot_idempotency_keys (tenant_id);
