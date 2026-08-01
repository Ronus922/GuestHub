-- ============================================================
--  071 — TTLock passcodes + the delete outbox (D124)
--
--  WHAT THIS ADDS ON TOP OF 070. 070 gave every door a row and bound it to a
--  room. This migration gives every door its CODES: the digits the guest types
--  on the keypad. Two tables — the codes themselves, and a small durable outbox
--  for the one remote operation that must not be lost.
--
--  THE DOOR MUST NEVER BE CODELESS. This is the invariant the whole design
--  serves, and it is why an outbox exists for a single operation. Rotation is
--  ADD THE NEW CODE FIRST, delete the old one LAST. If the add fails, the old
--  code is still on the door and the guest still gets in. If the delete fails,
--  the door briefly answers to TWO codes — which is a nuisance, not a lockout,
--  and is recoverable by retry. The opposite order (delete, then add) makes
--  every upstream failure a family standing outside a door at midnight. So the
--  delete is enqueued, attempted inline once, and retried by the worker until
--  it lands or the attempts are exhausted; `state` on the passcode row and
--  `done_at` on the op row are how the screen tells the operator which of those
--  happened.
--
--  WHY `state` AND NOT A BOOLEAN. A passcode is not merely active or inactive.
--  It can be committed locally but not yet acknowledged upstream ('rotating'),
--  superseded but still physically on the door ('revoking'), gone ('revoked'),
--  or removed by somebody working directly in the TTLock app ('missing'). Each
--  of those needs a different sentence on the screen, and — critically —
--  'rotating'/'revoking' are the two states a SYNC MUST NOT OVERWRITE: an
--  in-flight local operation is newer than any list we fetched a second ago.
--
--  WHY `role` IS ASSIGNED ONCE AND NEVER RECOMPUTED. Every door carries a
--  manager code named "מנהל" and an apartment code for the guest. We tell them
--  apart by name on FIRST SIGHT and never again. Names are operator-editable
--  upstream: if classification re-ran on every sync, an operator renaming
--  "דירה 4" to "דירה 4 (ישן)" could turn the apartment code into 'other', and
--  the rotate button would then create a SECOND apartment code beside a live
--  one instead of replacing it. Worse, a rename containing "מנהל" would make
--  the guest code look like the manager code, and the manager code is the one
--  thing this feature may never rotate. Classification is therefore an INSERT-
--  time decision, and scripts/check-ttlock-secrets.mjs rule 10 fails the build
--  if any sync path ever UPDATEs the column.
--
--  `rotated_reason` IS A SEAM, NOT A FEATURE. Its CHECK admits 'checkout'
--  today, but no code path writes it: phase B rotates the apartment code when a
--  guest checks out, and it will need to distinguish its own rotations from an
--  operator pressing the button. Adding the value now costs one CHECK entry and
--  means phase B is not a migration. Nothing in this task emits it.
--
--  `code` IS STORED IN PLAINTEXT, DELIBERATELY. It is not a credential of ours
--  to protect with a vault key — it is a five-digit number the operator must be
--  able to read off a screen and say out loud on the phone, and TTLock itself
--  returns it in cleartext on every list call. Encrypting it would buy nothing
--  (the decryption key would sit in the same process that renders it) while
--  making the screen impossible to build. What IS enforced is that a full code
--  never reaches an audit row, a log line or an error message — masked to the
--  last two digits everywhere except the authorized operator's own screen.
--  Rule 11 fails the build on a violation.
--
--  THE ADMIN CODE THAT WAS ALREADY SITTING IN 070's `raw`. 070's header states
--  that /v3/lock/list "returns device metadata and no credential". That is
--  WRONG, and this migration corrects it. The real payload carries `noKeyPwd` —
--  the lock's ADMIN passcode, in cleartext — and all 12 production rows have
--  one (eleven 7-digit, one 4-digit). It was never rendered, never returned by
--  an action and never logged, so nothing leaked; but a live admin door code
--  had no business being at rest in a jsonb column that the header described as
--  credential-free. The scrub below removes the key from existing rows, and
--  src/lib/ttlock/locks.ts now strips it before every write. It is not modelled
--  anywhere: we do not need the admin code, so we do not keep it.
--
--  HOW THIS IS APPLIED — NOT BY HAND. Since 064 the deploy owns migration
--  application: scripts/deploy-production.sh runs
--  scripts/apply-pending-migrations.mjs BEFORE the pm2 restart, and that runner
--  writes the guesthub.schema_migrations row only after the file applied
--  cleanly. Applying this DDL manually via `docker exec … psql` leaves NO
--  ledger row — the "applied but unrecorded" state migration 064 exists to end.
--  065-070 carry no run line for exactly this reason; neither does this one.
--
--  Idempotent. Safe to replay — and that is load-bearing, not a courtesy: the
--  runner performs the apply and the ledger INSERT as two separate psql
--  invocations, not one transaction, so a crash between them re-applies this
--  file on the next deploy.
--
--  NO NEW PERMISSIONS. 069 seeded locks.view (read the board and the codes) and
--  locks.rotate (change a code); 070 added locks.map. Rotation is the screen
--  locks.rotate was seeded for two migrations ago — it finally has one.
--
--  ROLLBACK:
--    DROP TABLE IF EXISTS guesthub.ttlock_ops;
--    DROP TABLE IF EXISTS guesthub.ttlock_passcodes;
--    -- the noKeyPwd scrub is NOT reversible; re-running a lock sync repopulates
--    -- `raw` from upstream, minus that key, which is the intended end state.
-- ============================================================

SET search_path TO "guesthub", public;

-- ============================================================
--  ttlock_passcodes — one row per code that exists (or existed) on a door
-- ============================================================
CREATE TABLE IF NOT EXISTS guesthub.ttlock_passcodes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,

  -- The DOOR this code opens. CASCADE is right here where it was wrong on
  -- rooms: a lock row disappearing means the tenant no longer has that device,
  -- and a code for a device we do not have is not information, it is litter.
  lock_id     uuid NOT NULL REFERENCES guesthub.ttlock_locks(id) ON DELETE CASCADE,

  -- keyboardPwdId upstream. NULL for exactly one window: between our local
  -- INSERT and the /v3/keyboardPwd/add that gives the code an upstream identity.
  -- A row that keeps a NULL here is a rotation that never reached the door.
  ttlock_passcode_id bigint,

  -- the digits. Plaintext by design — see the header.
  code        text NOT NULL,
  -- keyboardPwdName upstream; the string the classification below reads ONCE.
  name        text NOT NULL,

  -- Assigned at INSERT and never recomputed. See header; rule 10 enforces it.
  role        text NOT NULL DEFAULT 'other'
              CHECK (role IN ('manager', 'apartment', 'other')),

  -- TTLock's own type number, stored UNTRANSLATED. We do not model what "2"
  -- means; we reuse whatever the existing apartment code on that door carries
  -- so a rotation produces a code of the same kind the operator already has.
  keyboard_pwd_type integer,

  -- upstream startDate/endDate. NULL when upstream sends 0 — which is how it
  -- says "permanent", and a permanent code with a 1970 start would sort and
  -- render as an expired one.
  starts_at   timestamptz,
  ends_at     timestamptz,

  state       text NOT NULL DEFAULT 'active'
              CHECK (state IN ('active', 'rotating', 'revoking', 'revoked', 'missing')),

  -- 'ttlock' = we learned about it from a sync. 'local' = we created it. The
  -- distinction matters when reconciling: a 'local' row with no upstream id is
  -- a failed rotation of ours, not a code somebody deleted in the app.
  origin      text NOT NULL DEFAULT 'ttlock'
              CHECK (origin IN ('local', 'ttlock')),

  -- 'checkout' is admitted but unwritten in this phase — see header.
  rotated_reason text CHECK (rotated_reason IN ('manual', 'checkout')),

  -- A SAFE category or a Hebrew sentence. Never an upstream body, never the
  -- Chinese errmsg, and never a code value.
  last_error  text,

  raw         jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per upstream code, per door. PARTIAL because ttlock_passcode_id is
-- NULL for every code we have created but not yet placed on the door, and two
-- concurrent rotations of DIFFERENT doors must not collide on that NULL. As in
-- 070, this is written partial rather than leaning on NULLs not colliding.
CREATE UNIQUE INDEX IF NOT EXISTS ttlock_passcodes_upstream_uniq
  ON guesthub.ttlock_passcodes (tenant_id, lock_id, ttlock_passcode_id)
  WHERE ttlock_passcode_id IS NOT NULL;

-- The screen's access path and the rotation's lookup: "the active apartment
-- code on this door", asked once per row on every page load.
CREATE INDEX IF NOT EXISTS idx_ttlock_passcodes_lookup
  ON guesthub.ttlock_passcodes (tenant_id, lock_id, role, state);

COMMENT ON TABLE guesthub.ttlock_passcodes IS
  'Keypad codes per TTLock door (D124). role is decided at INSERT and never recomputed — an upstream rename must not reclassify a live code. state distinguishes committed-locally from acknowledged-upstream; sync never overwrites rotating/revoking.';

COMMENT ON COLUMN guesthub.ttlock_passcodes.code IS
  'Plaintext by design: a five-digit number the operator reads off the screen, which TTLock itself returns in cleartext. Never written to an audit row, a log line or an error message — masked to the last two digits everywhere else.';

COMMENT ON COLUMN guesthub.ttlock_passcodes.state IS
  'active | rotating (created locally, not yet on the door) | revoking (superseded, still physically on the door) | revoked | missing (deleted upstream by somebody else).';

-- ============================================================
--  ttlock_ops — the durable outbox for the one operation we may not lose
-- ============================================================
--  Only 'delete_remote' lives here, and that is the point: it is the ONLY step
--  in a rotation that happens AFTER the operator has been told the new code.
--  Everything before it either succeeded or failed in front of them. A delete
--  that fails silently would leave a stale code working on a real door for as
--  long as nobody noticed — so it is written down, retried with backoff, and
--  surfaced on the screen while it is outstanding.
CREATE TABLE IF NOT EXISTS guesthub.ttlock_ops (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,

  -- the code this op is about. CASCADE: no passcode, no op.
  passcode_id uuid REFERENCES guesthub.ttlock_passcodes(id) ON DELETE CASCADE,

  op          text NOT NULL CHECK (op IN ('delete_remote')),

  attempts    int NOT NULL DEFAULT 0,
  -- exponential backoff lands here; the drain claims only rows that are due
  run_after   timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The drain's only query: due, not finished. Partial so the index stays the
-- size of the backlog rather than the size of the history.
CREATE INDEX IF NOT EXISTS idx_ttlock_ops_due
  ON guesthub.ttlock_ops (run_after)
  WHERE done_at IS NULL;

COMMENT ON TABLE guesthub.ttlock_ops IS
  'Durable outbox for TTLock operations that happen after the operator has been answered (D124). Today: delete_remote only — retiring the code a rotation superseded.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guesthub_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON guesthub.ttlock_passcodes TO guesthub_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON guesthub.ttlock_ops TO guesthub_app';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE guesthub.ttlock_ops_id_seq TO guesthub_app';
  END IF;
END $$;

-- ============================================================
--  Scrub: the admin passcode 070 stored without meaning to. See header.
-- ============================================================
UPDATE guesthub.ttlock_locks
SET raw = raw - 'noKeyPwd', updated_at = now()
WHERE raw ? 'noKeyPwd';

COMMENT ON COLUMN guesthub.ttlock_locks.raw IS
  'The upstream lock row minus noKeyPwd. 070 described this column as credential-free; it was not — /v3/lock/list returns the lock ADMIN passcode in cleartext. It is stripped on write (src/lib/ttlock/locks.ts) and scrubbed from existing rows by 071.';
