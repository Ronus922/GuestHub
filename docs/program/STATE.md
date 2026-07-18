# GuestHub Program — STATE

Durable program memory. Updated at every stage exit and after significant mid-stage milestones (charter §4).

## Current stage

**Stage 4 — Channex Integration & Certification Readiness** — IN PROGRESS (2026-07-18). Continuous mode (charter §1). Not tagged.

### Stage 4 progress
- ✅ Entry gate: tags 1-3 present, Stage-3 outbox live (`markAriDirty`), branch current.
- ✅ Milestone 1 (partial) — **CHX G6 environment routing, ARI send path**: `AriConnection.environment` added + `credentialsFor` resolves `CHANNEX_BASE_URLS[conn.environment]` (was hardcoded staging). Inbound/reporting/payments/inbound-admin already route by env.
- ⏳ **Remaining Stage-4 scope** (large; much needs LIVE Channex Staging — external dependency per V2 §2):
  - CHX G6 completion: property/room-type/rate-plan SETUP ops (`admin.ts`, `rate-plan-admin.ts`, `room-type-admin.ts`) still hardcode staging — parametrize with the §26 production flow. `check:channex-environment-routing`.
  - Evidence ledger (H9/H10) + read-only certification console (§13) + `check:channex-certification-evidence`.
  - Full Sync 500-day/two-request semantics + size preflight (§14) + `check:channex-full-sync-two-requests`.
  - Group Update expansion + single-envelope batching (§15) + `check:channex-group-update-batching`; Min Stay Arrival/Through declaration.
  - Rate-limit cooldown + circuit breaker (§16, M14) + fault tests + `check:channex-rate-limit-cooldown`.
  - Inbound booking hardening + ACK + booking-receiving cert flow (§17) + `check:channex-booking-crs-flow`; `check:channel-security`, `check:channel-chaos`.
  - Production activation guard (§26, built + inactive) + `check:production-activation-guard`.
  - Certification property provisioned with varied realistic data; scenario execution with Task IDs (LIVE Channex).
  - 9 `docs/channex/` docs (skeletons exist) incl. SCREENSHARE_DEMO_SCRIPT draft; declaration answers 12-14.
  - **Note:** re-fetch official Channex docs at execution (Stage-1 capture in `docs/channex/PMS_CERTIFICATION_REQUIREMENTS.md` is from 2026-07-18; still current this session).

## Prior stage

### Stage 3 deliverables (closed + proven)
- **H1/H2/M3 — DB-level double-booking prevention (ADR-0003)** — migration 037: exclusion constraint on `reservation_rooms` (room + half-open stay range) scoped to a trigger-maintained `is_blocking` flag; `reservations.status` CHECK. Proven under true concurrency (`check:reservation-concurrency`).
- **H7/M6 — refund/void ledger ops** (`src/lib/payments/mutations.ts` + `refundPaymentAction`/`voidPaymentAction`) + reference-based idempotency. Proven by `check:payment-refund-void`.
- **M7 — reschedule balance** now via canonical `recomputePaymentAggregates` (no inline formula).
- **H6 — OTA modify** preserves local discount/extra_charges (`booking-import.ts`).
- **H3 — tenant isolation** decided (ADR-0006: server-side canonical + `check:pms-domain-invariants` backstop; RLS deferred with re-eval triggers).
- **Guest dedup seam (ADR-0005, M24 foundation)** — `upsertChannelGuest` reuses on unique normalized-email match.
- **§18** payment docs (`docs/payments/`) + provider-neutral model documented.
- **7 Stage-3 checks all green** (+ existing `check:pricing-equality` 22/22): pms-domain-invariants, reservation-concurrency, inventory-integrity, payment-ledger-integrity, background-job-recovery, timezone-and-money-invariants, payment-refund-void.
- **7 domain docs** (§23) complete.
- Sync-outbox seam is transactional (`markAriDirty` in canonical writes) per ADR-0004 — Channex wiring in Stage 4.

## Prior stage

## Completed stages

| Stage | Tag | Commit | Date |
|---|---|---|---|
| 1 | `stage-1-complete` | (see tag) | 2026-07-18 |
| 2 | `stage-2-complete` | (see tag) | 2026-07-18 |
| 3 | `stage-3-complete` | (see tag) | 2026-07-18 |

### Stage 2 deliverables
- **C2 mitigated**: DOCKER-USER DROP on ens3 for DB ports 5432/6543 (v4+v6), persisted via `guesthub-db-firewall.service`; localhost/apps unaffected. Runbook `docs/database/DB_EXPOSURE_MITIGATION.md`. (Kong 8000/8443 gateway hardening → Stage 6.)
- **H5 fixed**: migration 021 recovered into branch; `db/migrations/manifest.txt` + `scripts/db/migrate.mjs` ledger runner (`guesthub.schema_migrations`); replay-from-zero 38/38, schema structurally identical to prod.
- **Dedicated staging DB**: container `guesthub-staging-db` (`supabase/postgres:15.8.1.085`, **127.0.0.1:5434**, volume `guesthub-staging-db-data`, 2g/2cpu), db `guesthub_staging`; 4 least-privilege roles (`db/roles/roles.sql`); data-copy validated (58/59 content-identical); app+worker smoke PASSED as `guesthub_app`.
- **H4 fixed**: `scripts/ops/guesthub-backup.sh` (guesthub+**auth**, AES-256, retention, off-host hook) + `guesthub-restore-drill.sh`; systemd timers nightly/weekly; old auth-less cron superseded; restore drill PASSED (14 auth.users recovered).
- **check:db-isolation** (`npm run check:db-isolation`) — PASSES on staging, FAILS on shared DB.
- Cutover runbook + rollback + 4 `docs/database/` docs (cutover NOT executed).

### Stage 1 deliverables
- `docs/program/` (charter, V2, 7 stage docs, STATE) + `reports/STAGE_1_REPORT.md`.
- `docs/channex/PMS_CERTIFICATION_REQUIREMENTS.md` (live docs snapshot 2026-07-18).
- `docs/audit/` — 10 inventories + `DEFECT_MATRIX.md` (2 Critical, 15 High, 27 Medium, ~11 Low; every Critical/High has an owning stage) + `PMS_GAP_MATRIX.md`.
- `docs/security/THREAT_MODEL.md` (initial; full red-team = Stage 6).
- `docs/architecture/TARGET_ARCHITECTURE.md` + `adr/ADR-0001..0005`.
- V2 §23 document skeletons (architecture/channex/security).

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

Full matrix: `docs/audit/DEFECT_MATRIX.md`. Highest-severity, by owning stage:

| # | Severity | Issue | Owning stage |
|---|---|---|---|
| C1 | Critical | Dev and production share one DB+schema on the shared supabase-db | Stage 2 |
| C2 | Critical | Production DB reachable past UFW (Docker bypasses firewall) | Stage 2 design / Stage 6 verify |
| H1 | High | No DB-level double-booking guard (exclusion constraint absent) | Stage 3 (ADR-0003) |
| H3 | High | No DB tenant-isolation backstop (no RLS; privileged pooled role) | Stage 3 |
| H4 | High | Backups omit `auth` schema + no off-host copy | Stage 2 |
| H5 | High | Migration history unreconstructable (021 off-branch, no ledger) | Stage 2 |
| H7 | High | Refunds/reversals unimplemented | Stage 3 |
| H8 | High | Full reversible PAN vault = full PCI scope | Stage 3 / Stage 6 |
| H9/H10 | High | Incremental Task IDs discarded; no evidence ledger | Stage 4 |
| H14/H15 | High | Reports/exports missing; Israel VAT/invoice/PII gaps | Stage 5 |

## Verified environment facts (addendum, Stage 1 close)

- Scratch restore DB `guesthub_stage1_restore` retained on `guesthub-testdb` (:5433) as restore evidence and the read-only source used by all audit agents.
- Backup artifacts: `/home/ubuntu/guesthub-backups/stage1/guesthub_db_stage1_20260718T064542.sql` + uploads tar.
- PM2 (untouched): prod `guesthub` (:3007) + `guesthub-channel-worker`, both cwd `/var/www/guesthub-production`; unrelated apps `pms`, `mail-system`, `sys-app`.
- Draft PR: #92 (https://github.com/Ronus922/GuestHub/pull/92).

## Verified environment facts (Stage 2 addendum)

- **Dedicated staging DB**: `guesthub-staging-db` container, `127.0.0.1:5434`, db `guesthub_staging`, PG 15.8. Credentials (owner/app/readonly/backup DSNs) in gitignored `/var/www/guesthub/.env.staging`.
- **Backup key**: `/home/ubuntu/.guesthub-backup-key` (chmod 600) — must be stored off-host separately before enabling off-host copies.
- **Stage-2 backup evidence**: `/home/ubuntu/guesthub-backups/stage2/guesthub_full_20260718T140913.sql.enc` (encrypted, guesthub+auth).
- **systemd units added** (host, not repo): `guesthub-db-firewall.service`, `guesthub-backup.{service,timer}`, `guesthub-restore-drill.{service,timer}`.
- **App root path** returns 307→`/login` (D77 middleware); `/login` is 200 — use `/login` for liveness checks.
- Production dedicated DB: **not yet provisioned**; cutover prepared, not executed (`MIGRATION_AND_CUTOVER_RUNBOOK.md`).

## Deferred items

| Item | Justification | Target |
|---|---|---|
| Off-host backup copy destination + credential | No off-host destination/credential exists on the host (no rclone/mount); `BACKUP_OFFHOST_CMD` hook is built and warns when unset. Local encrypted backup + restore drill are in place. | User provides destination; wired at/ before production cutover |
| Kong gateway (8000/8443) external hardening | Blocking could break `db.bios.co.il` auth ingress; needs ingress-path confirmation | Stage 6 |
| Execute production cutover | Forbidden during the program (V2 §3/§26); runbook + tooling prepared | Post-program, user-approved |

## Re-scoping log

Charter §4 — items moved between stages, with justification (never dropped):

| Item | From → To | Justification |
|---|---|---|
| H8 — PAN-vault retention purge job + full PCI-scope review | Stage 3 → **Stage 6** | Stage-3 portion done (provider-neutral model, `docs/payments/` boundaries, ciphertext moved off shared DB in Stage 2). A scheduled purge job + full PCI review are red-team/observability concerns (V2 §19/§21 = Stage 6). |
| H11 — quarantined-revision error re-log growth (retention/dedup of `channel_sync_errors`) | Stage 3 → **Stage 6** | Stage-3 queue foundation present (dead_letter, structured errors, heartbeat, `check:background-job-recovery`). Log retention + hygiene is explicitly Stage 6 (V2 §21 coverage matrix). |
| H13 — audit read/search UI | Stage 3 → **Stage 5** | Audit write-integrity is sound (append-only, tenant-scoped); the display half is already Stage 5 in the coverage matrix. No read surface is a UI feature, built with the other operator UIs. |
| Maintainability refactor: `round2` dedup (8 modules) + large-module split (CalendarGrid, reservations/actions, EditReservationPanel, channel/admin, RoomWizard) — L2/L7, M-large-modules | Stage 3 → **Stage 5/6** | Low/Medium maintainability, not Critical/High. Characterization guards (the 7 Stage-3 checks) are in place first, so the refactor can prove behavior-preservation when done. |
| M1 (dead holds), M2 (optimistic concurrency), M4 (OTA rr churn), M5 (reservation-number allocator) | Stage 3 → **Stage 5** | Medium reliability/UX items; the Critical/High integrity core is closed. Tracked in `DEFECT_MATRIX.md`. |

## Blockers requiring the user

- **Off-host backup destination** (not blocking Stage 2 completion): to fully satisfy H4's off-host requirement in production, the user must provide an off-host backup target (e.g. an object store or a second host) and its credential; then set `BACKUP_OFFHOST_CMD` in `guesthub-backup.service`. Documented in `BACKUP_RESTORE_AND_ROLLBACK.md`.
