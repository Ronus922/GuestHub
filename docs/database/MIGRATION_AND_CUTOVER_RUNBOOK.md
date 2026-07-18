# Migration and Production Cutover Runbook

**Date:** 2026-07-18 · **Stage:** 2 · **Status:** Prepared — **NOT executed** (V2 §3/§9/§26) · **Review:** Agent N (Stage 2 exit)

The cutover moves GuestHub production off the shared `supabase-db` stack onto a dedicated production PostgreSQL cluster. **Do not run the final cutover as part of this program** — it is an explicit later action after user testing and requires the Stage-4 production activation guard for Channex to remain disabled.

## Tooling (V2 §9 thirteen-item list → what implements it)

| # | Item | Implementation |
|---|---|---|
| 1 | Current DB inventory | `npm run check:db-isolation` (lists schemas/tables); `docs/audit/ARCHITECTURE_INVENTORY.md` |
| 2 | GuestHub-owned object list | `guesthub` schema + `auth` (per ADR-0002) |
| 3 | Verified logical backup | `scripts/ops/guesthub-backup.sh` (guesthub+auth, encrypted) |
| 4 | Restore verification | `scripts/ops/guesthub-restore-drill.sh` |
| 5 | Target DB provisioning | container provisioning (below) + `db/roles/roles.sql` |
| 6 | Migration replay from zero | `scripts/db/migrate.mjs --apply` (`npm run db:replay`) |
| 7 | Data-copy tooling | `pg_dump --data-only -n guesthub` → load (below) |
| 8 | Validation tooling | `scripts/db/validate-copy.mjs` |
| 9 | Checksum + row-count comparison | `scripts/db/validate-copy.mjs` (order-independent content md5) |
| 10 | Application smoke | `scripts/db/smoke-staging.mjs` |
| 11 | Worker smoke | `scripts/db/smoke-staging.mjs` (claim + heartbeat paths) |
| 12 | Rollback tooling | `BACKUP_RESTORE_AND_ROLLBACK.md` + env revert (below) |
| 13 | Final cutover runbook | this document |

All of items 3–11 were exercised on staging in Stage 2 (see `reports/STAGE_2_REPORT.md`).

## Pre-cutover checklist

- [ ] Fresh verified backup taken and restore-drilled (`guesthub-backup.sh` + `guesthub-restore-drill.sh`, both green).
- [ ] Off-host backup copy confirmed (`BACKUP_OFFHOST_CMD` configured — the one remaining prod prerequisite).
- [ ] Host headroom re-checked (disk/mem/CPU).
- [ ] Maintenance window agreed; operators notified.
- [ ] Channex production remains disabled (Stage-4 guard).

## Cutover steps (execute only in the approved window)

1. **Provision the dedicated production DB** (localhost-bound, capped, persistent volume):
   ```
   docker run -d --name guesthub-production-db --restart unless-stopped \
     -p 127.0.0.1:5435:5432 \
     -e POSTGRES_USER=supabase_admin -e POSTGRES_PASSWORD="<generated>" -e POSTGRES_DB=postgres \
     -v guesthub-production-db-data:/var/lib/postgresql/data \
     --memory=4g --cpus=3 supabase/postgres:15.8.1.085
   docker exec guesthub-production-db psql -U supabase_admin -c "CREATE DATABASE guesthub_production"
   ```
2. **Roles:** apply `db/roles/roles.sql` with fresh generated passwords (stored off-repo).
3. **Schema:** `MIGRATE_DATABASE_URL=<owner DSN> npm run db:replay` → expect 38/38.
4. **Quiesce writes:** stop the GuestHub production PM2 web + worker **only** (never the shared stack) so the source is consistent for the final copy.
5. **Final data copy:** `pg_dump -n guesthub --data-only --disable-triggers` from the shared source → truncate target guesthub tables (keep ledger) → load. Copy `auth.users`/identities too (from the shared `auth`) so logins survive.
6. **Validate:** `SOURCE_DATABASE_URL=<shared> TARGET_DATABASE_URL=<prod> node scripts/db/validate-copy.mjs` → expect 0 MISMATCH (volatile ops tables may drift; acceptable while writes are quiesced they should be 0).
7. **Isolation:** `CHECK_DB_URL=<prod> npm run check:db-isolation` → PASS.
8. **Switch env:** point production `.env.local` `DATABASE_URL` at `guesthub_app@127.0.0.1:5435/guesthub_production`; point auth env at the dedicated GoTrue.
9. **Smoke:** `SMOKE_DATABASE_URL=<prod app DSN> node scripts/db/smoke-staging.mjs` → PASS; then start PM2 web + worker; verify `:3007` HTTP 200 and worker heartbeat.
10. **Watch:** monitor logs, worker queue, and a real reservation read/write for one cycle.

## Rollback (if any step fails)

See `BACKUP_RESTORE_AND_ROLLBACK.md`. Summary: revert production `.env.local` `DATABASE_URL` to the shared stack value, restart PM2 web+worker, and (only if the shared source was mutated) restore from the pre-cutover backup. Because the cutover does not delete or modify the shared source (it reads from it), rollback is a fast env revert; no data is lost.

## Safety

Provisioning the dedicated production DB and preparing this runbook do **not** constitute cutover. The shared stack and all other applications are untouched. The final switch (steps 4–10) is an explicit, supervised, later action.
