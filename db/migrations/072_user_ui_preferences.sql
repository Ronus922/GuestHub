-- ============================================================
--  072 — per-user UI preferences (dashboard window layout)
--
--  WHAT THIS ADDS. One jsonb column on guesthub.users holding UI state that
--  belongs to a PERSON rather than to the tenant: which dashboard windows they
--  hid, and in what order they dragged the rest. Nothing else. It is not a
--  settings store, not a feature-flag table and not a cache — anything with a
--  business meaning gets its own column or its own table, as it always has.
--
--  WHY A COLUMN AND NOT localStorage. The reference implementation kept the
--  layout in localStorage under a versioned key. This codebase has not one
--  localStorage call site, and per-browser state is invisible to the server,
--  lost on a new device, and impossible to reason about when an operator says
--  "my dashboard looks wrong". A column follows the user across devices and is
--  readable in support.
--
--  WHY KEYED BY SCREEN. The shape is { "<screen>": { … } } — today only
--  "dashboard" exists. Every writer MUST merge into its own key
--  (`ui_preferences || jsonb_build_object('dashboard', …)`), never replace the
--  whole column, so a second screen added later cannot be erased by the first.
--
--  WHY NOT NULL DEFAULT '{}'. A nullable jsonb would make every reader write
--  `coalesce(ui_preferences, '{}')` and every writer guard against NULL || …
--  returning NULL — which silently drops the write. The empty object removes
--  both failure modes; existing rows get it without a rewrite of meaning.
--
--  Idempotent. Safe to replay from zero. No data deleted.
--
--  ROLLBACK (manual, only while no code reads the column):
--    ALTER TABLE guesthub.users DROP COLUMN IF EXISTS ui_preferences;
-- ============================================================
SET search_path TO "guesthub", public;

ALTER TABLE guesthub.users
  ADD COLUMN IF NOT EXISTS ui_preferences jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN guesthub.users.ui_preferences IS
  'Per-user UI state, keyed by screen. Writers merge their own key only — never replace the object.';
