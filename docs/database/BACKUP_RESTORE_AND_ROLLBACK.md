# Backup, Restore and Rollback

**Date:** 2026-07-18 · **Stage:** 2 · **Defect:** H4

## Backup

- **Script:** `scripts/ops/guesthub-backup.sh` → installed `/usr/local/sbin/guesthub-backup.sh`.
- **Content:** `pg_dump -n guesthub -n auth` — both the app schema AND GoTrue logins (the old `nightly-backup.sh` dumped only `guesthub`, so a restore lost all logins).
- **At rest:** AES-256 (`openssl enc -aes-256-cbc -pbkdf2`), key at `/home/ubuntu/.guesthub-backup-key` (chmod 600, generated on first run). Plus a `tar.gz` of `/var/www/guesthub-uploads`.
- **Retention:** `KEEP_DAYS` (default 14).
- **Schedule:** `guesthub-backup.timer` (systemd, nightly 03:15). The old auth-less cron is commented out (superseded).
- **Off-host (H4 requirement):** set `BACKUP_OFFHOST_CMD` (e.g. an rclone/scp wrapper invoked as `$CMD <file>`) in `/etc/systemd/system/guesthub-backup.service`. **Currently unset** — the script warns loudly on every run until a destination is provided. This is the one remaining production prerequisite (needs an off-host destination + credential = a user-provided setting).

⚠️ **Key custody:** the AES key must be stored **off-host**, separately from the backups, or an off-host copy is useless. Document where the key lives before enabling off-host copies.

## Restore

- **Drill:** `scripts/ops/guesthub-restore-drill.sh` → `/usr/local/sbin/…`, scheduled `guesthub-restore-drill.timer` (weekly Sun 04:10). Decrypts the latest backup, restores into a scratch DB on `guesthub-testdb`, verifies table + row counts.
- **Last drill (2026-07-18):** PASSED — 0 load errors, 60 guesthub + 20 auth tables, 81 reservations, **14 `auth.users` recovered** (logins survive).
- **Real restore** into a target: `openssl enc -d … | psql "<target owner DSN>"` (the drill script is the reference implementation).

## Rollback

### Cutover rollback (during the production DB cutover)
The cutover **reads** from the shared source and never deletes/modifies it, so rollback is a fast env revert:
1. Revert production `.env.local` `DATABASE_URL` (and auth env) to the shared-stack values.
2. Restart the GuestHub PM2 web + worker (never the shared stack).
3. Only if the shared source was mutated during the window (it should not be — writes are quiesced): restore the pre-cutover backup with the restore procedure above.

### Migration rollback
Migrations are forward-only with a checksum ledger. To undo a bad migration on a **dedicated/disposable** DB: restore the pre-migration backup (the dedicated DBs are the only ones this program migrates; production is never migrated in-place during this program). Never `git reset --hard` / force-push (V2 §3).

## Evidence
Stage-2 backup: `/home/ubuntu/guesthub-backups/stage2/guesthub_full_20260718T140913.sql.enc` (7 MB, guesthub+auth). Restore drill: PASSED. See `reports/STAGE_2_REPORT.md`.
