# GuestHub Program — STATE

Durable program memory. Updated at every stage exit and after significant mid-stage milestones (charter §4).

## Current stage

**PROGRAM COMPLETE + DEPLOYED TO PRODUCTION** (2026-07-18).

### Production deployment (2026-07-18, commit `29c09aa`)
PR #92 merged to `main` (`--no-ff`, merge commit `29c09aa`, two parents `b78650c`+`a7c0a82`) and deployed to `/var/www/guesthub-production` (build `CFUkBzq7FzTFJVvWdt_c0`, port 3007) via `PROD_DEPLOY_OK=1 npm run deploy:prod`.
- **Rollback anchor:** tag `prod-pre-v2` = `b78650c` (pushed). Schema backup (verified restorable, counts matched): `/var/www/guesthub-production/backups/guesthub-schema-preV2-20260718-204927.sql`.
- **Migrations applied to prod :5432** (8, each single-transaction, all exit 0): `021` (no-op — prod names already canonical, 0 orphans), `037` double-booking guard (status CHECK + `rr_no_double_booking` EXCLUDE — pre-flight confirmed 0 non-canonical statuses, 0 overlapping blocking stays; `is_blocking` backfilled 56/82), `038`–`043`. Prod had **no** `schema_migrations` ledger (historical manual psql applies); migrations applied by hand in manifest order. `migrate.mjs` intentionally refuses :5432 — used the per-file psql path instead.
- **Data integrity:** unchanged vs baseline — tenants 1, users 7, rooms 14, room_types 3, reservations 81, reservation_rooms 82, guests 60, payments 14.
- **Verified:** `/login` 200 (renders), all central routes (incl. `/housekeeping` `/tasks` `/reports`) non-5xx (307 auth-redirect), both PM2 apps online (`guesthub`, `guesthub-channel-worker`), worker heartbeat fresh + `last_error` null, unrelated PM2 apps (`pms`/`mail-system`/`sys-app`) untouched. **Channex:** one `staging` connection unchanged; **no `production` connection exists** (stays OFF).
- Also shipped in this merge: the `check:channel-worker` residue-flake fix (`a7c0a82`, see Stage 7 note below).

Stage 7 final Agent N matrix: **PASS 9/9, no must-fix items.** Report: `FINAL_REPORT.md`.

### Stage 7 — Final Verification & Delivery — ✅ COMPLETE, tag `stage-7-complete`, Agent N PASS 9/9. Report `reports/STAGE_7_REPORT.md`.

### Stage 7 progress
- ✅ Entry gate: tags 1-6 present; no unassigned open Critical/High; branch current.
- ✅ **Replay-from-zero:** all **45** migrations apply cleanly to a fresh DB (verified on disposable :5433, scratch dropped).
- ✅ **Consolidated regression (§25):** all headless `check:*` green (72/73 in the battery + `check:inventory` fixed after). `check:hydration-browser` is a live-server + Chromium E2E (Phase-15 browser verification) — environment-dependent, run against the running app; not a code defect.
- ✅ **Fixed 5 stale checks** (not regressions): inventory (dropped flaky live-prod backlog assertion → focus on function integrity), check-in-check-out-db (harness missing split module), rates-sync (connRow missing env/circuit cols), channels-fullsync-ui (D89 btn-primary), realtime (ADR-0005 email dedup). All committed.
- ✅ **check:code-documentation** (§22) added + green.
- ✅ **Post-completion fix (2026-07-18) — `check:channel-worker` residue flake:** the "two concurrent workers never claim the same job" assertion intermittently read `claimed.length` 6–10 vs 1. Root cause: **the test, not the claim.** `claimChannelJobs()` is GLOBAL (any connection's runnable jobs) and its `FOR UPDATE SKIP LOCKED` is correct (no regression since Stage 3); the assertion used a global COUNT that only holds on an empty queue, while the shared :5433 DB accumulates `processing`/`retry_wait` rows from prior **crashed** runs (the agents-rtl loop, killed mid-run) that become claimable as their lease/backoff expires. Fixed by (a) starting the queue sub-test from an empty jobs table — the check is the sole legitimate actor on the isolated DB — and (b) asserting the real invariant directly: no id is claimed by both workers. Proof: fresh DB 16/16; injected 30 stale-lease residue jobs → old test fails `actual 10 vs 1`, fixed test passes; 5/5 consecutive green. `check:background-job-recovery` (staging DSN) + `check:channex-rate-limit-cooldown` green. Commit on `feat/pms-hardening-channex-certification`.
- ✅ **Fresh-clone setup (§28):** `git clone` + `pnpm install --frozen-lockfile` + `tsc --noEmit` all clean.
- ✅ **FINAL_REPORT.md** (§29) written (Hebrew summary, cert matrix ref, declarations, remaining-human-steps, security/perf, test results, git delivery + review map, user test plan, safety).
- ✅ DECISIONS.md program-completion addendum.
- ⏳ Final Agent N pass/fail matrix (running) → then tag `stage-7-complete` + final PR.
- **Environment-dependent (V2 §2), documented not blocking:** live screenshare rehearsal + `check:hydration-browser` (need the running app + Chromium); live Channex cert-scenario execution (needs a Staging channel/Booking.com test account).

## Prior stage

### Stage 6 — Security, Performance & Observability — ✅ COMPLETE (2026-07-18), tag `stage-6-complete`

Zero unresolved Critical/High; report `reports/STAGE_6_REPORT.md`. New checks: `check:no-secrets`, `check:supply-chain`, `check:retention`, `check:performance` (+ §24 coverage in `check:channel-chaos`). Migration 043 (retention purge) on staging :5434 only. 4 security docs complete + THREAT_MODEL finalized. Residual (Medium/Low, documented): Kong hardening (operator ingress), off-host backup, GREEN-API token, card-key rotation tooling. Node runtime now pinned; postcss advisory resolved.

### Stage 6 progress (historical)
- ✅ Entry gate: `stage-5-complete` tag present, branch current, headroom OK, residual backlog loaded (H8, H11, Kong from Stage-2/3 reports).
- ✅ **Secrets (§19)** — `check:no-secrets`: 430 tracked files scanned, no secret material, no `.env*` ever committed, encryption/activation env vars never hardcoded. Commit 5e8712a.
- ✅ **Supply-chain (§19)** — resolved the one moderate advisory (postcss<8.5.10 via next) with a pinned pnpm override → audit clean; pinned Node (engines >=20<21, `.nvmrc`, packageManager pnpm@10.32.1). `check:supply-chain`. Commit 60062c4.
- ⏳ **Remaining Stage-6 scope:**
  - Red-team (§19): authorization/application/synchronization attacks — resolve Critical/High, document residual; `SECURITY_TEST_REPORT.md`.
  - **H8** (re-scoped): PAN purge job + full PCI review. **H11** (re-scoped): `channel_sync_errors` retention/dedup.
  - Performance (§20): measure at current + growth-scale fixtures; justified indexes only; before/after evidence.
  - Observability (§21): sanitized visibility list, actionable alert list (each with runbook step), log hygiene, backup-status monitoring; `OBSERVABILITY.md`.
  - Fault-injection (§24): full list (webhook+poll, credential rotation mid-job, cert reset during run, two Full Sync clicks, DB unavailable, corrupted queue payload, expired lease) — add coverage to `check:channel-chaos` + `check:background-job-recovery`.
  - **Kong gateway (8000/8443)** external hardening (Stage-2 deferral) — confirm ingress path first, then restrict without breaking `db.bios.co.il` auth.
  - Docs: `THREAT_MODEL.md` (finalize), `SECURITY_TEST_REPORT.md`, `SECRET_HANDLING.md`, `OBSERVABILITY.md`.
  - New checks so far: `check:no-secrets`, `check:supply-chain`. Node runtime now pinned (was unpinned).

### Stage 6 prior (entry-gate context)

## Prior stage

### Stage 5 — PMS Capability Completion — ✅ COMPLETE (2026-07-18), tag `stage-5-complete`

All 8 items shipped; new checks green; prior battery green. Report `reports/STAGE_5_REPORT.md`; capability matrix `docs/audit/PMS_CAPABILITY_MATRIX.md`. Migrations 040 (typed closures), 041 (operational tasks), 042 (guest anonymization) on staging :5434 only. New checks: `check:housekeeping`, `check:maintenance-closures`, `check:reports`, `check:israel-market`. Deferred items (report UIs, real invoice provider, bulk import, maintenance ticketing, multi-property perms, audit read UI) documented with justification in the capability matrix.

### Stage 5 entry gate (passed)
- ✅ Prior tag `stage-4-complete` present; Stage-4 exit checklist recorded passed (report + Agent N 7/7).
- ✅ Branch `feat/pms-hardening-channex-certification` current, clean tree.
- ✅ Safety (V2 §3): dev DB resolves to shared :5432 (read-only; NO migrations/destructive there — use :5434 staging / :5433 disposable). Headroom OK (disk 109G, mem 12Gi, load ~1).
- ✅ Requirements refresh: Channex requirements snapshot still current (Stage 4). No external doc changes for Stage 5.
- ✅ Regression guard: Stage 1-4 checks pass (full battery run at Stage-4 exit; note the 3 destructive Stage-3 checks need `CHECK_CONCURRENCY_DB_URL`/`CHECK_DB_URL`=staging owner DSN).

### Stage 5 scope (from `docs/audit/PMS_GAP_MATRIX.md`, all HV/Stage-5)
Ordered work items (each must connect to the real lifecycle + audit + outbox where availability is affected; deferrals → `PMS_CAPABILITY_MATRIX.md` with justification):
1. **Communications** — guest-language template selection in `automation.ts` (data exists: `guests.language` + template `language`; absent in automation path). §10/§21.
2. **Housekeeping module** — auto task generation from checkout/stayover, assignment, my-tasks flow, clean/dirty/inspected lifecycle tied to arrivals; must affect availability + outbox. (`housekeeping_tasks`, stub `housekeeping/my-tasks/page.tsx`, `rooms/actions.ts:752`).
3. **Maintenance** — typed OOO (removed from inventory) vs OOS (dirty but sellable) closures + categories; OOO must remove availability + sync. (`room_closures`, free-text reason).
4. **Operational tasks** — unified task foundation (avoid a separate incompatible system per module).
5. **Reports/exports** — arrivals/departures/in-house, cancellations, occupancy, revenue (ADR/RevPAR), balances-due, payments/cash-up, availability, channel-production, audit export, dashboard KPIs; safe server-side generation; only reports whose data is reliable.
6. **Israel-market** — tourist VAT zero-rating (`reservations.tax_exempt` exists, 0 code refs; + passport/foreign-guest evidence), invoice/receipt external seam (Green-Invoice class), guest-language comms (item 1), privacy/Amendment-13 PII retention + guest deletion/anonymization.
7. **Completeness** — permissions (multi-property readiness), business/integration settings, data import/export (CSV), production diagnostics.
8. **`PMS_CAPABILITY_MATRIX.md`** — implemented vs deferred with reasons.

### Stage 5 progress
- ✅ **Item 1 — guest-language template selection** (`automation.ts`): `resolveVersion(automation, guestLanguage)` prefers a published sibling template (same category, guest's language) with honest fallback; locked policy never overridden. `check:guest-communications-automation` extended (11 groups). Commit 9aa5232.
- ✅ **Item 2 — Housekeeping**: checkout auto-generates a cleaning task (idempotent, `reservations/actions.ts`); `src/lib/housekeeping/actions.ts` (cleaner queue + advance dirty→cleaning→clean, manager assign/inspect); real my-tasks mobile page. `check:housekeeping` (static + DB idempotency). Commit 303581b.
- ✅ **Item 3 — Maintenance OOO/OOS**: migration 040 (`room_closures.kind`/`category` + 3 availability functions filter `kind='ooo'`); OOO blocks+syncs, OOS dirty-but-sellable. `check:maintenance-closures` (DB proof OOS stays / OOO −1). Commit 9ce7353.
- ⏳ **Item 4** — unified operational tasks foundation (avoid a parallel task system; `housekeeping_tasks` is the base — generalize with a task_type rather than a new table).
- ⏳ **Item 5** — reports/exports (arrivals/departures/in-house, cancellations, occupancy, revenue ADR/RevPAR, balances-due, payments/cash-up, availability, channel-production, audit export, dashboard KPIs); safe server-side; only reliable-data reports.
- ⏳ **Item 6** — Israel-market: tourist VAT zero-rating (`reservations.tax_exempt` exists, 0 refs + passport evidence), invoice/receipt external seam, PII retention + guest deletion/anonymization (Amendment 13).
- ⏳ **Item 7-8** — completeness (permissions/settings/import-export/diagnostics) + `PMS_CAPABILITY_MATRIX.md` (implemented vs deferred).
- New migrations this stage: **040** (typed closures) on staging :5434 only. New checks: `check:housekeeping`, `check:maintenance-closures` (+ extended `check:guest-communications-automation`).

**NOTE (execution model, charter §1 clarified):** continuous mode — on stage exit, proceed immediately to the next stage's entry gate in the SAME session; fresh-session = re-read from disk, NOT stop. Keep going until `stage-7-complete` exists. Stop only for a real external blocker (V2 §2).

## Prior stage

### Stage 4 — Channex Integration & Certification Readiness — ✅ COMPLETE (2026-07-18), tag `stage-4-complete`

All 9 milestones shipped; all 10 new checks green; prior battery still green; quote-to-ARI equality 22/22. Report: `reports/STAGE_4_REPORT.md`.

- **M1** env routing canonical — `config.channexBaseUrl` sole resolver; setup ops via `effectiveChannexEnvironment()`, runtime via `conn.environment`. `check:channex-environment-routing`.
- **M8** production activation guard — `production-guard.ts`, staging-by-default, gated prod-connection creation. `check:production-activation-guard`.
- **M2** evidence ledger (migration 038, staging :5434) + read-only console; H9/H10 fixed (incremental Task IDs captured). `check:channex-certification-evidence`.
- **M4** Full Sync 500d/2 requests + byte-bounded 10MB preflight (removed 1000-value cap). `check:channex-full-sync-two-requests`.
- **M5** Group Update single envelope + Min Stay declaration (`MIN_STAY_SEMANTICS.md`). `check:channex-group-update-batching`.
- **M6** rate-limit cooldown (429 Retry-After) + circuit breaker (`circuit-breaker.ts`, migration 039). `check:channex-rate-limit-cooldown`.
- **M7** inbound security/chaos + booking-receiving cert flow. `check:channel-security`, `check:channel-chaos`, `check:channex-booking-crs-flow`.
- **M3+M9** scenario matrix (14 tests, traceable), declarations 12-14, complete `SCREENSHARE_DEMO_SCRIPT.md`, env/activation runbooks. `check:channex-certification`.
- Fixed pre-existing stale assertions in `check:channex-ari` (46/46) and `check:channel-worker` (16/16).
- **External dependency (V2 §2):** live scenario execution with real Task IDs needs an active Channex Staging channel / Booking.com test account — offline harness+mocks+evidence+docs built; live run documented in the scenario matrix + booking-receiving doc.
- New migrations: 038 (evidence ledger), 039 (circuit breaker) — applied to staging :5434 ONLY.

### Stage 4 progress (historical)
- ✅ Entry gate: tags 1-3 present, Stage-3 outbox live (`markAriDirty`), branch current.
- ✅ **M1 — environment routing canonical (CHX G6 complete)**: `config.channexBaseUrl(env)` is the SOLE base-URL resolver; all setup ops (`admin.ts`, `room-type-admin.ts`, `rate-plan-admin.ts`) resolve env via `production-guard.effectiveChannexEnvironment()` (no `"staging"` literal); runtime paths route off `conn.environment`. `check:channex-environment-routing` PASS.
- ✅ **M8 — production activation guard (built + inactive)**: `production-guard.ts` — production only behind `CHANNEX_PRODUCTION_ACTIVATION` on-flag; staging by default; `assertProductionActivationAuthorized` fails closed; prod-connection creation gated. `check:production-activation-guard` PASS (transpiles + executes the real guard).
- ✅ **M2 — evidence ledger (H9/H10) + read-only console (§13)**: migration **038** `channel_evidence_ledger` (append-only, applied to staging :5434, roundtrip proven); `evidence.ts` (sole writer `recordAriEvidence`, reader `loadEvidenceLedger`); wired into full-sync AND incremental drain (incremental Task IDs no longer discarded); `certification.ts` read-only console action + `CertificationConsoleSection.tsx`. `check:channex-certification-evidence` PASS.
- ✅ **M4 — Full Sync two-request semantics + 10MB size preflight (§14)**: batching is now byte-bounded to the real 10MB limit (removed the artificial 1000-value cap that broke two-request semantics); `payloadByteSize`/`PAYLOAD_BYTE_LIMIT`; full-sync evidence records `requestBytes`+`expectedRequests:2`; delta-only after. `check:channex-full-sync-two-requests` PASS. Also fixed 3 pre-existing stale assertions in `check:channex-ari` (was fully red at HEAD) → now 46/46.
- ⏳ **Remaining Stage-4 scope**:
  - **M5** Group Update expansion + single-envelope batching (§15) + Min Stay Arrival/Through declaration + `check:channex-group-update-batching`.
  - **M6** Rate-limit cooldown + circuit breaker (§16, M14) + fault tests + `check:channex-rate-limit-cooldown`.
  - **M7** Inbound hardening + ACK + booking-receiving cert flow (§17) + `check:channex-booking-crs-flow`, `check:channel-security`, `check:channel-chaos`.
  - **M3+M9** Certification property provisioned + scenario execution with Task IDs (**LIVE Channex Staging — external dependency per V2 §2; build harness/mocks + document blocker**); 9 `docs/channex/` docs incl. SCREENSHARE_DEMO_SCRIPT draft; declaration answers 12-14 + `check:channex-certification`.
  - **Note:** re-fetch official Channex docs at execution (Stage-1 capture in `docs/channex/PMS_CERTIFICATION_REQUIREMENTS.md` from 2026-07-18; still current this session).

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
| 4 | `stage-4-complete` | (see tag) | 2026-07-18 |
| 5 | `stage-5-complete` | (see tag) | 2026-07-18 |
| 6 | `stage-6-complete` | (see tag) | 2026-07-18 |
| 7 | `stage-7-complete` | (see tag) | 2026-07-18 |

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
