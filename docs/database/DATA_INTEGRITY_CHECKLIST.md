# Data Integrity Checklist

**Date:** 2026-07-18 · **Stage:** 2 · Used to verify a dedicated environment (staging now; production at cutover) faithfully carries GuestHub data. V2 §9 "verify" list.

Run after any provisioning, replay, or data copy.

| # | Item | How | Staging result (2026-07-18) |
|---|---|---|---|
| 1 | UUID preservation | `validate-copy.mjs` content md5 includes PKs | ✓ (58/59 identical) |
| 2 | Foreign keys | replay applies all FK constraints; load with `--disable-triggers` then re-enabled | ✓ (replay 38/38) |
| 3 | Constraints (unique/check) | replay-from-zero applies them; load respects them | ✓ |
| 4 | Indexes | created by replay | ✓ |
| 5 | Triggers | created by replay (026/028 mirror + orphan-archive) | ✓ |
| 6 | Functions | e.g. `check_room_availability` present + EXECUTE works | ✓ (smoke) |
| 7 | Audit logs | `audit_logs` copied | ✓ (content md5 match) |
| 8 | Users (auth) | `auth.users` in backup + restore | ✓ (14 users restored) |
| 9 | Active reservations | count + content match | ✓ (81) |
| 10 | Payment totals | `payments` content md5 match | ✓ (14) |
| 11 | Room identities | `rooms` content md5 match | ✓ (14) |
| 12 | Channel mappings | `channel_room_mappings` etc. content match | ✓ |
| 13 | Migration versions | `guesthub.schema_migrations` = 38 in manifest order | ✓ (ledger present) |

## Standing verifications (commands)

- Schema faithfulness: `MIGRATE_DATABASE_URL=<disposable> npm run db:replay` → 38/38, then compare table/column structure to production (Stage-2 method: 61 tables = 60 + ledger; column structure byte-identical).
- Data faithfulness: `SOURCE_DATABASE_URL=<src> TARGET_DATABASE_URL=<tgt> node scripts/db/validate-copy.mjs` → 0 MISMATCH (volatile ops tables may drift if source is live).
- Dedication: `CHECK_DB_URL=<tgt> npm run check:db-isolation` → PASS.
- App/worker: `SMOKE_DATABASE_URL=<app DSN> node scripts/db/smoke-staging.mjs` → PASS.
- Backup restorability: `scripts/ops/guesthub-restore-drill.sh` → PASSED.

## Known acceptable differences
- Target has `guesthub.schema_migrations` (ledger) that the legacy source lacks.
- `sellable_units_backup_028` is a migration-created backup table (present in both); excluded from copy comparison.
- Volatile ops tables (`channel_sync_jobs/errors/dirty_ranges`, `channel_worker_state`, `audit_logs`, messaging/communication tables) may differ when copied from a live source; they reconcile once writes are quiesced at cutover.
