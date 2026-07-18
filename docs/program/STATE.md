# GuestHub Program — STATE

Durable program memory. Updated at every stage exit and after significant mid-stage milestones (charter §4).

## Current stage

**Stage 1 — Foundation, System Audit and Target Architecture** — IN PROGRESS (entry gate passed 2026-07-18).

## Completed stages

| Stage | Tag | Commit | Date |
|---|---|---|---|
| — | — | — | — |

## Verified environment facts (2026-07-18)

### Database identities (resolved from effective environments)

| Environment | Resolution | Identity |
|---|---|---|
| Dev checkout `/var/www/guesthub` | `.env.local` → `DATABASE_URL` | `localhost:5432/postgres`, schema `guesthub` — **the SHARED production supabase-db (Supavisor session pooler)**. ⚠️ Dev and production currently point at the SAME database and schema. No migrations, seeds or destructive tests may run through this env. |
| Production checkout `/var/www/guesthub-production` | `.env.local` → `DATABASE_URL` | `localhost:5432/postgres`, schema `guesthub` (same shared supabase-db) |
| Disposable test DB | Docker `guesthub-testdb` | `localhost:5433/postgres` (Postgres in dedicated container; safe for destructive tests) |
| Auth | Self-hosted Supabase GoTrue via Kong | `https://db.bios.co.il` (browser) / `http://localhost:8000` (server-side admin) |

The shared supabase-db stack (containers `supabase-db`, `supabase-kong`, `supabase-auth`, …) also serves other, unrelated applications (`pms`, `mail-system`, `sys-app` in PM2). It must not be modified, restarted or reconfigured (V2 §3, §9).

### Runtime processes (PM2 — production, DO NOT TOUCH)

| Process | cwd | Port | Notes |
|---|---|---|---|
| `guesthub` | `/var/www/guesthub-production` | 3007 | Live production app (`npm start`) |
| `guesthub-channel-worker` | `/var/www/guesthub-production` | — | Channel sync worker (scripts/channel-worker.cjs) |
| `pms`, `mail-system`, `sys-app` | other apps | — | Unrelated apps on shared infra — untouchable |

### Host resource headroom (2026-07-18 06:44)

* Disk `/`: 193G total, **109G available** (44% used).
* Memory: 22Gi total, **13Gi available** (swap 11Gi, 6.3Gi used).
* CPU: 8 cores, load average ≈ 0.86–1.29. Headroom is sufficient for a dedicated DB stack (Stage 2 decision pending ADR).

### Backup (Stage 1 entry gate)

* Fresh backup taken 2026-07-18 06:45 (stamp `20260718T064542`):
  * DB: `/home/ubuntu/guesthub-backups/stage1/guesthub_db_stage1_20260718T064542.sql` (6.0 MB, schema-scoped `pg_dump --schema=guesthub`, ends with "dump complete").
  * Uploads: `/home/ubuntu/guesthub-backups/stage1/guesthub_uploads_stage1_20260718T064542.tar.gz` (144K, `/var/www/guesthub-uploads`).
* **Restore proof**: restored into scratch DB `guesthub_stage1_restore` on `guesthub-testdb` (:5433) with 0 errors; row counts across all **60 tables identical** to source (e.g. reservations=81, rooms=14, payments=14, users=7, tenants=1). Scratch DB retained on the disposable instance as evidence.
* Existing automatic backup: nightly cron 03:15 via `scripts/nightly-backup.sh` (14-day retention, on-host only — off-host copy is a Stage 2 §21 item).

### Git

* Integration branch: `feat/pms-hardening-channex-certification` (from `origin/main` @ `b78650c`).
* Repo is **PUBLIC** (`Ronus922/GuestHub`) — no secrets, no app screenshots in commits.
* ~40 historical feature branches exist from previous efforts; all already merged via PRs or superseded — none conflict with this program's branch.

## Open issues

| # | Severity | Issue | Owning stage |
|---|---|---|---|
| 1 | Critical (by program definition) | Dev and production share one database+schema on the shared supabase-db; no dedicated GuestHub DB | Stage 2 |
| 2 | High | Backups have no off-host copy and restore is not routinely exercised | Stage 2 |

(The full defect matrix is produced later in Stage 1 under `docs/audit/`.)

## Deferred items

None yet.

## Re-scoping log

None yet.

## Blockers requiring the user

None yet.
