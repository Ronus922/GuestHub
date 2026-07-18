# GuestHub PMS — Operations & Observability Audit (read-only, Agent K scope)

- **Date:** 2026-07-18
- **Branch:** feat/pms-hardening-channex-certification
- **Method:** read-only code walk + read-only snapshot SELECTs against `guesthub-testdb` / `guesthub_stage1_restore` (a restore of production state; row counts below are from this snapshot, not live) + read-only inspection of PM2, cron, systemd timers and `/etc/nginx` / `/etc/site-health`. No process, DB, or config was changed.

---

## 1. Health checks

- **No `/api/health` endpoint exists.** `grep` across `src/` finds no health route; the deploy script and site-health both probe ordinary pages.
- **External probe:** the fleet's `site-health` systemd timer (`site-health.service`/`.timer`, script `/home/ubuntu/DevOPS/site-health.sh`) DOES cover the web app: `/etc/site-health/sites.conf` line `guesthub|GET|http://127.0.0.1:3007/|200 307|runuser -u ubuntu -- pm2 restart guesthub`. This proves only that the Next.js process serves — per the config's own comment, a `GET /` probe does not prove DB reachability (other apps use a gated 401 endpoint for that; GuestHub has none to offer).
- **The channel worker has NO probe at all.** It exposes no port by design; site-health cannot see it; its only supervision is PM2 autorestart. Its DB heartbeat (below) is read by the app UI but nothing alerts on staleness.
- **Deploy-time checks:** `deploy-production.sh` verifies PM2 cwd, worker survives 6s, port answers, 3 routes non-5xx — good, but one-shot at deploy time only.

## 2. Worker heartbeat (`channel_worker_state`)

- Written every tick by `heartbeat()` — `src/lib/channel/worker.ts:67` (singleton row: `worker_id`, `beat_at`, `last_drain_at`, `last_error`). Heartbeat failures are swallowed so they never kill the worker.
- Read by three server actions for UI freshness: `admin.ts:488` (ARI section), `inbound-admin.ts:182` (inbound section), `rates-sync.ts:74` (rates sync chip).
- **Snapshot:** `worker_id=vps-ad565027:2530680`, `beat_at=2026-07-18 06:45 UTC` (fresh), `last_drain_at=2026-07-17 19:22`, `last_error=NULL` — worker alive and beating.
- **Gap:** staleness is only visible if a super_admin happens to open /channels; there is no threshold, no alert, no page. If PM2 gives up after `max_restarts:10` (worker `errored`), `beat_at` silently ages while queued jobs accumulate with no consumer.

## 3. Queue visibility (`channel_sync_jobs`)

- **States:** `queued` / `retry_wait` / `processing` (10-min lease, expired leases reclaimable) / `succeeded` / `dead_letter` / `suppressed` (recorded-but-not-runnable, §S). Retry cap: `max_attempts=8` (migration 005:141), permanent error codes short-circuit to `dead_letter` (`ranges.ts:55`).
- **Snapshot:** 1,270 `succeeded`, 1 `dead_letter`, 0 queued/processing — healthy backlog. By type: `pull_booking_revisions` 1,061; `sync_ari_range` 136; `create_rate_plan` 52; `create_room_type` 13; `full_sync` 6; `sync_rate_plans` 2; `sync_room_types` 1.
- **Dead letter observed:** `full_sync` / `validation_error` / "רק 13 מתוך 14 חדרים ממופים ל-Channex" (2026-07-17) — correct by design (Full Sync never auto-retries), and the operator DID re-run (later runs succeeded).
- **Gaps:** (a) no UI to inspect or requeue a `dead_letter` job — only a count on /channels; recovery relies on re-triggering the originating flow, which exists for `full_sync` (re-run button) and `pull_booking_revisions` (auto re-enqueue) but not generically; (b) succeeded/dead rows are never pruned (unbounded, slow growth); (c) `channel_dirty_ranges` that exhaust `max_attempts=5` become `status='failed'` **dead ranges with no requeue path and no UI surface at all** — the /channels counter shows only `pending` ranges ("טווחים ממתינים"), so a dead range means silently stale OTA ARI until some later save re-dirties the same dates. Snapshot: 5 pending / 532 synced / 0 failed today, so latent, not active.

## 4. `channel_sync_errors` growth (579 rows)

- **Snapshot distribution:** `inbound_quarantine` 493, `inbound_normalize_failed` 86 — total 579, ALL created on **one day (2026-07-11)**.
- **Root cause of the growth pattern:** quarantined revisions stay UNacknowledged by design, so Channex's feed keeps returning them; the fallback poll runs every ~5 minutes; every poll re-runs `importRevisionRow`, re-quarantines, and inserts a **fresh** `channel_sync_errors` row (`booking-import.ts:826-833`) — 493 rows ≈ 25 quarantined revisions × ~20 poll cycles. Same multiplier for normalize-failures. There is no dedup/suppression ("already quarantined with same reason — skip logging"), no retention job, and the /channels error list shows only the latest N, so the table grows without bound whenever a quarantine backlog exists. (The 2026-07-11 storm stopped because the owner resolved/resynced — D81 memory — not because anything rate-limited it.)
- Error rows are structured (tenant, connection, job, room/plan, date range, code, message, jsonb context) and never carry upstream bodies — good.

## 5. Quarantine visibility

- **Snapshot:** 25 revisions `import_status='quarantined'` (`ack_status='unacknowledged'`): 10 × "התנגשות מקומית בחדר…", 8 × "אותו חדר פיזי מופיע פעמיים בתאריכים חופפים", 7 × "חדר בהזמנה ללא מזהה Room Type של הערוץ". 40 imported+acknowledged.
- **UI:** /channels shows a danger-highlighted counter ("הזמנות בהסגר (quarantine)", `channels/page.tsx:222`) and the `InboundBookingsSection` lists inbound state; external date changes that conflict are ALSO recorded as unresolved external changes with ops email (D82). Per-revision detail (reason, payload identity, retry button) is limited — the manual pull-by-revision-id action exists but the operator must know the id.
- **Gap:** quarantine is visible only to super_admin on /channels; no notification when a NEW quarantine appears (an OTA guest may arrive for a booking the calendar never showed). The ops-email path covers only date-change conflicts on EXISTING reservations, not a brand-new quarantined booking.

## 6. Structured logging assessment

- **DB-structured where it matters:** `channel_sync_errors` (§AA), job rows (`last_error_code/message`), `channel_booking_revisions.mapping_error`, `communication_delivery_attempts` (immutable per-attempt results + categories), `outbound_messages` error columns, `audit_logs` for every canonical write (including worker-context channel audits with `session_info='channel:<ota>'`). This is the system's real observability backbone and is good.
- **Process logs:** worker logs single-line `[channel-worker] …` via `console.log` to PM2 logs (no rotation config found in repo — PM2 default files under `~/.pm2/logs` grow unless `pm2-logrotate` is installed host-side); web app logs `console.error("[reservations]" | "[rates]" | "[calendar]" | "[channel-webhook]" | "[realtime]" …)` on unexpected errors only. No log levels, no JSON logs, no correlation ids, no aggregation/shipping. TypeScript rule "no console.log" is honored in app code (errors only) — the worker's operational log is the deliberate exception.
- **Verdict:** adequate for single-host, single-operator; queries against the DB tables are the only practical way to investigate incidents, and they work.

## 7. Alerting

- **None for domain failures.** Nothing pages/emails/WhatsApps on: dead-letter jobs, dead (`failed`) dirty ranges, quarantine arrivals, worker heartbeat staleness, `channel_sync_errors` bursts, ambiguous email deliveries, or backup failures (cron output goes to `/home/ubuntu/logs/guesthub-backup.log`, unmonitored).
- **Exceptions:** (a) site-health restarts + alerts (fleet WhatsApp/email channel) when the WEB app stops answering `GET /`; (b) D82 ops emails for external date-change conflicts (via the tenant's own configured email provider — which is also the component most likely broken when it matters); (c) the /channels danger counters, which require a human to look.
- Site-health's shared-layer guard (skip restarts when most sites fail → DB/pooler fault) applies to this host.

## 8. Backup automation

- **Verified in root crontab:** `15 3 * * * bash /var/www/guesthub-production/scripts/nightly-backup.sh >> /home/ubuntu/logs/guesthub-backup.log 2>&1`.
- **Script (`scripts/nightly-backup.sh`):** schema-scoped `pg_dump --schema=guesthub` via the `supabase-db` container → `/home/ubuntu/guesthub-backups/guesthub_db_<stamp>.sql`; tars `/var/www/guesthub-uploads` (room images are LOCAL DISK — D55); rotates at **14 days**.
- **CONFIRMED: no off-host copy.** The script contains no rsync/rclone/scp/S3 step; backups live on the SAME host and same filesystem tree as the database container volume. Disk loss, host compromise, or `rm -rf` incidents destroy primary + all backups together. Dumps are plaintext SQL containing encrypted-PAN ciphertexts and tenant PII, protected only by filesystem permissions. No restore-test automation, no dump integrity verification (a zero-byte dump would rotate in silently — `set -euo pipefail` catches pg_dump failure but not a logically-empty dump).

## 9. What an operator can and cannot see in the UI today

**Can see (all on `/channels`, super_admin only — `page.tsx:127`):**
- Connection card: state badge, environment, property id, outbound/inbound toggles, `full_sync_required`, masked key hint, `last_outbound_sync_at`, `last_inbound_import_at`, `last_error`.
- Stat cards: pending jobs, failed jobs, dead-letter jobs (danger), pending dirty ranges, quarantined revisions (danger).
- Recent `channel_sync_errors` list; ARI section with persisted Full Sync progress (phase/percent/message, D69) and the Full Sync button; room-type & rate-plan mapping status incl. broken mappings; inbound section with worker freshness + manual pull (incl. by revision id); external date changes pending reconciliation (D82); rates page sync chip + incremental-only button (D75).
- Elsewhere: reservation panel shows OTA identity/origin/cancellation provenance; audit trail exists in DB for everything.

**Cannot see:**
- Worker heartbeat staleness as an explicit alarm (only indirect freshness text); anything at all if the worker is dead AND nobody opens /channels.
- Dead (`failed`) dirty ranges — no counter, no list, no requeue.
- Individual dead-letter job payloads/messages or a requeue control.
- Communications: ambiguous/failed deliveries exist in DB with categories, but there is no operator dashboard listing failed guest emails needing manual resend.
- `channel_sync_errors` history beyond the latest slice; no filtering/grouping.
- Backup status/last-success anywhere in the product.

## 10. Findings table

| # | Severity | Description | Evidence |
|---|----------|-------------|----------|
| F1 | **HIGH** | Backups have NO off-host copy: nightly pg_dump + uploads tar stay on the same host/filesystem as the live DB; 14-day rotation; no restore test, no empty-dump detection, no failure alert. Single disk/host incident loses everything. | `/var/www/guesthub/scripts/nightly-backup.sh:8-27`; root crontab entry `15 3 * * *` |
| F2 | **HIGH** | Quarantine reprocessing storm: quarantined revisions are re-imported on EVERY ~5-min poll, inserting a new `channel_sync_errors` row each cycle — unbounded table growth and repeated work; no logging dedup, no retention, no backoff on quarantined rows (`attempts` increments but caps nothing). Snapshot: 579 error rows in ONE day (493 `inbound_quarantine` from ~25 revisions). | `/var/www/guesthub/src/lib/channel/booking-import.ts:826-833,950-956`; `worker.ts:174-191`; snapshot `channel_sync_errors` grouped counts |
| F3 | **HIGH** | No alerting on channel-domain failure states: dead-letter jobs, new quarantines, worker heartbeat staleness, and dead dirty ranges are invisible unless a super_admin opens `/channels`. A worker that exhausts PM2 `max_restarts:10` stays `errored` forever with queued jobs and no consumer — OTA bookings stop importing silently (webhook still 200s, jobs just queue). | `/var/www/guesthub/ecosystem.config.cjs` (`max_restarts:10`); `/etc/site-health/sites.conf` (web only); no alert code anywhere in `src/` |
| F4 | **MEDIUM** | No `/api/health`: site-health probes `GET /` (200/307) which proves the Next process only, not DB reachability; the channel worker is entirely outside external monitoring (no port, no probe, DB heartbeat unmonitored). | `/etc/site-health/sites.conf` guesthub line + its own header comment; `src/app/api/` route listing |
| F5 | **MEDIUM** | Dead dirty ranges are a silent-stale path: after `max_attempts=5` a range becomes `status='failed'` — no UI counter, no requeue, no alert; the OTA keeps outdated availability/rates for those dates until an unrelated save re-dirties them. | `/var/www/guesthub/src/lib/channel/ari-sync.ts:677-702`; `db/migrations/027:76`; `/channels` counts only `pending` (`channels/page.tsx:221`) |
| F6 | **MEDIUM** | Ambiguous email deliveries fail closed permanently (`ambiguous_provider_outcome`) with no operator-facing resend queue/dashboard — correct anti-duplicate design, but a guest confirmation lost this way requires DB spelunking to notice. Same for `failed` deliveries generally. | `/var/www/guesthub/src/lib/communications/delivery.ts:51-69`; no UI consumer of `final_error_category` found in `src/app` |
| F7 | **MEDIUM** | Refund is not implemented: ledger and permissions vocabulary reference refunds, but no action/UI can record a refund or void a payment; refunds today require manual DB writes (bypassing audit). | `src/lib/payments/ledger.ts:13-16`; `src/app/(dashboard)/permissions/PermissionsMatrix.tsx:16`; grep: no refund write path in `src/` |
| F8 | **LOW** | `channel_webhook_events.status` is written `'enqueued'` and never transitions (65/65 rows `enqueued` in snapshot) — a lifecycle column that lies; also the table has no retention. | `src/app/api/channel/webhook/[token]/route.ts:90`; grep shows only SELECTs elsewhere (`inbound-admin.ts:189,466`); snapshot counts |
| F9 | **LOW** | Unbounded growth of operational tables besides errors: `channel_sync_jobs` (1,271 rows and growing ~1 pull-job/5min/connection), `channel_webhook_events`, `communication_delivery_attempts` — no pruning/archival anywhere. | snapshot `jobs_by_type` (1,061 `pull_booking_revisions`); no retention code in `src/` or `scripts/` |
| F10 | **LOW** | Process logs: no rotation config in-repo for PM2 logs, no aggregation, no correlation ids; incident forensics depend on DB tables (which are good) plus grep over plain-text PM2 logs. | `scripts/channel-worker.cjs:51`; PM2 defaults; repo-wide absence of log config |
| F11 | **INFO (positive)** | Crash-safety of the queue core is genuinely sound: durable-then-wake NOTIFY on commit, `FOR UPDATE SKIP LOCKED` claims, 10-min lease reclaim, FIFO-per-connection, ack-only-after-commit with re-ack sweep, persist-then-quarantine for normalize failures, transactional outbox for ARI and communications. No job-loss path was found for `sync_ari_range` / `pull_booking_revisions`; a crashed `full_sync` is re-run on reclaim (idempotent state-replacing payloads). | `src/lib/channel/queue.ts:65-101`; `worker.ts:243-293`; `booking-import.ts:963-1002`; `revisions.ts:244-259` |
