-- ============================================================
--  064 — the applied-migrations ledger the deploy script reads
--
--  Incident (2026-07-28, ca11f15): `deploy:prod` built and restarted but never
--  applied migrations. New code went live writing to columns 062 had not yet
--  created, "✓ DEPLOYED" printed for an incomplete release, and production
--  wrote to missing columns for ~3 minutes until 062 was applied by hand.
--
--  A release is code + schema, atomically. The deploy script now applies
--  pending migrations (scripts/apply-pending-migrations.mjs) BEFORE restarting
--  processes — and "pending" needs a durable definition. This ledger is it:
--  one row per applied migration file. The backfill below seeds every file
--  that exists on main at this migration's own birth AND is verifiably applied
--  in production — measured 2026-07-29 by probing every CREATE TABLE /
--  ADD COLUMN / CREATE FUNCTION each file declares. ONE file failed the probe
--  and is deliberately NOT backfilled: 055_booking_com_channel_reports.sql
--  (its table never reached production — a past deploy carried it unapplied,
--  the exact incident class this ledger exists to end). Leaving it out makes
--  the first ledger-aware deploy apply it. The chain is never replayed
--  wholesale over a live schema (054's rename breaks a second 005) — only
--  individually-idempotent pending files are applied.
--
--  Files added after 064 are recorded by the deploy script itself, one row
--  per file, only after that file applied cleanly.
--
--  Idempotent. Safe to replay.
-- ============================================================
SET search_path TO "guesthub", public;

CREATE TABLE IF NOT EXISTS guesthub.schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO guesthub.schema_migrations (filename) VALUES
  ('000_init_schema.sql'),
  ('001_phase2_permissions.sql'),
  ('002_users_unique_ci.sql'),
  ('003_user_permission_overrides.sql'),
  ('004_phase3_calendar.sql'),
  ('005_phase3_channel_foundation.sql'),
  ('006_availability_unknown_rooms.sql'),
  ('007_phase3_tenant_settings.sql'),
  ('008_phase3_reservation_cards.sql'),
  ('009_phase4_card_channel.sql'),
  ('009_phase4a_sellable_units.sql'),
  ('010_card_cvv_channel_ingest.sql'),
  ('011_commercial_settings.sql'),
  ('012_room_occupancy_commercial.sql'),
  ('013_rooms_module.sql'),
  ('014_rooms_reference_fidelity.sql'),
  ('015_room_history_integrity.sql'),
  ('016_rate_plans.sql'),
  ('017_reservation_pricing.sql'),
  ('018_remove_stored_cvv.sql'),
  ('019_payment_status_ledger_reconcile.sql'),
  ('020_messaging_providers.sql'),
  ('021_room_inventory_cleanup.sql'),
  ('022_channex_connection_test.sql'),
  ('023_channex_property_mapping.sql'),
  ('024_channex_room_type_mappings.sql'),
  ('025_channex_rate_plan_mappings.sql'),
  ('026_sellable_unit_lifecycle.sql'),
  ('027_channex_ari_room_dimension.sql'),
  ('028_canonical_room_identity.sql'),
  ('029_inbound_booking_identity.sql'),
  ('030_workflow_statuses_payment_methods.sql'),
  ('031_cancellation_history_realtime.sql'),
  ('032_inbound_rate_plan_aliases.sql'),
  ('033_expected_arrival_time.sql'),
  ('034_cancellation_snapshot_arrival_source.sql'),
  ('035_channel_external_changes.sql'),
  ('036_guest_communications.sql'),
  ('037_double_booking_guard.sql'),
  ('038_channel_evidence_ledger.sql'),
  ('039_channel_circuit_breaker.sql'),
  ('040_typed_room_closures.sql'),
  ('041_operational_tasks.sql'),
  ('042_guest_anonymization.sql'),
  ('043_retention_purge.sql'),
  ('044_hospitable_provider.sql'),
  ('045_beds24_provider.sql'),
  ('046_active_provider_selector.sql'),
  ('047_restore_stored_cvv.sql'),
  ('048_task_board_order.sql'),
  ('049_maintenance_role.sql'),
  ('050_website_booking_source.sql'),
  ('051_psp_readiness.sql'),
  ('052_room_type_catalog_order.sql'),
  ('053_room_show_on_calendar.sql'),
  ('054_external_column_rename.sql'),
  ('056_source_system.sql'),
  ('057_length_of_stay_discounts.sql'),
  ('058_reservation_totals_v2.sql'),
  ('059_billing_notes_to_reservation_notes.sql'),
  ('062_channel_failure_evidence.sql'),
  ('064_schema_migrations.sql')
ON CONFLICT (filename) DO NOTHING;
