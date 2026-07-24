-- ============================================================
--  GuestHub · D91 closure — rename the legacy channex_* columns to the
--  external_* convention the code already uses (externalRoomId, external_state,
--  reservations.external_*).
--
--  Channex was removed as a provider (D91, deployed 2026-07-24); Beds24 lives on
--  its own channel_beds24_room_mappings table, and NO live code references any
--  channex_* column (verified: zero matches in src/, zero pg functions/views/
--  triggers). This is therefore pure catalog metadata — RENAME COLUMN only,
--  instant, no table rewrite, no data touched. Indexes/constraints track the
--  rename automatically (they bind by attribute number, not by name).
--
--  Idempotent. Safe to replay: each rename runs only while the old name exists
--  and the new one does not.
--
--  WARNING — do NOT manually re-run the historical channel migrations
--  (022-027, 032) on a database where 054 has already run: their
--  ADD COLUMN IF NOT EXISTS blocks would re-create stray channex_* columns
--  beside the renamed external_* ones (and 023 would rebind its CHECK
--  constraints to the strays). Replay-from-zero through the manifest ledger
--  (scripts/db/migrate.mjs) is the only supported replay path.
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/054_external_column_rename.sql
-- ============================================================
SET search_path TO "guesthub", public;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('channel_connections',              'channex_property_id',          'external_property_id'),
      ('channel_connections',              'channex_property_method',      'external_property_method'),
      ('channel_connections',              'channex_property_snapshot',    'external_property_snapshot'),
      ('channel_connections',              'channex_property_title',       'external_property_title'),
      ('channel_connections',              'channex_property_verified_at', 'external_property_verified_at'),
      ('channel_connections',              'channex_reconcile_state',      'external_reconcile_state'),
      ('channel_inbound_rate_plan_aliases','channex_property_id',          'external_property_id'),
      ('channel_inbound_rate_plan_aliases','channex_rate_plan_id',         'external_rate_plan_id'),
      ('channel_inbound_rate_plan_aliases','channex_room_type_id',         'external_room_type_id'),
      ('channel_inbound_rate_plan_aliases','channex_title',                'external_title'),
      ('channel_rate_plan_mappings',       'channex_rate_plan_id',         'external_rate_plan_id'),
      ('channel_room_mappings',            'channex_property_id',          'external_property_id'),
      ('channel_room_mappings',            'channex_room_type_id',         'external_room_type_id'),
      ('channel_room_mappings',            'channex_title',                'external_title'),
      ('channel_room_rate_mappings',       'channex_property_id',          'external_property_id'),
      ('channel_room_rate_mappings',       'channex_rate_plan_id',         'external_rate_plan_id'),
      ('channel_room_rate_mappings',       'channex_room_type_id',         'external_room_type_id'),
      ('channel_room_rate_mappings',       'channex_title',                'external_title'),
      ('channel_room_type_mappings',       'channex_room_type_id',         'external_room_type_id')
    ) AS m(tbl, old_col, new_col)
  LOOP
    IF EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'guesthub' AND table_name = r.tbl AND column_name = r.old_col)
    THEN
      IF EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'guesthub' AND table_name = r.tbl AND column_name = r.new_col)
      THEN
        -- old AND new coexist = catalog drift (e.g. a hand-applied hotfix).
        -- Renaming would fail and dropping is out of scope — make it LOUD
        -- instead of silently skipping, so the D91 "0 channex columns"
        -- invariant can't rot invisibly.
        RAISE WARNING '054: % has BOTH % and % — stray legacy column left in place, resolve manually',
          r.tbl, r.old_col, r.new_col;
      ELSE
        EXECUTE format('ALTER TABLE guesthub.%I RENAME COLUMN %I TO %I', r.tbl, r.old_col, r.new_col);
      END IF;
    END IF;
  END LOOP;
END $$;
