# GuestHub — Observability

- **Status:** Complete — Stage 6 · **Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification`

Operational visibility, actionable alerts, log hygiene, and backup-status
monitoring. Every alert names its first response step (charter: alerts must be
actionable). All values here are sanitized — no secret, no PAN, no guest PII.

## Operational visibility (sanitized)

| Signal | Where | What it shows |
|---|---|---|
| App liveness | `/login` returns 200 (root 307→/login is normal, D77) | the Next app is up |
| Channel worker heartbeat | `guesthub.channel_worker_state` (last tick, last drain, last error) | the PM2 worker is draining |
| Queue health | `/channels` diagnostics: pending / failed / dead-letter jobs, dirty-range backlog | outbound sync backlog + failures |
| Sync errors | `channel_sync_errors` (unresolved, newest first) | ARI/inbound failures, safe categories only |
| Circuit state | `channel_connections.circuit_open_until` / `consecutive_failures` | a provider is being backed off (429/failures) |
| Sync evidence | read-only console (`/channels`) — per-scenario counts + Task IDs | Beds24 ARI submission audit |
| Inbound quarantine | `channel_booking_revisions.import_status='quarantined'` count | bookings needing operator attention |
| Backup status | `guesthub-backup.service` last run + artifact timestamp | nightly encrypted backup ran |

## Alert list (each with first response)

| Alert | Condition | First response |
|---|---|---|
| App down | `/login` not 200 for 2 checks | site-health auto-restarts pm2 `guesthub`; if it recurs, check `pm2 logs guesthub` |
| Worker stalled | `channel_worker_state.last_tick` older than 5 min | restart pm2 `guesthub-channel-worker`; check its log for the last error |
| Dead-letter jobs | any `channel_sync_jobs.status='dead_letter'` | open `/channels`, read the error category; re-trigger Full Sync after fixing mapping/credential |
| Circuit open (sustained) | `circuit_open_until` in the future for >30 min | verify the Beds24 credential + provider status; the drain resumes automatically after cooldown |
| Quarantine backlog | quarantined revisions > 0 for >1h | open `/channels` inbound section; resolve mapping/alias, then re-pull |
| Backup missing | no backup artifact in 26h | run `guesthub-backup.service` manually; check disk + the encryption key path |
| DB exposure regression | external probe reaches :5432/:6543 | re-run `scripts/ops/guesthub-db-firewall.sh` (idempotent DOCKER-USER DROP) |
| High/critical advisory | `pnpm audit --prod` reports high/critical | triage + pin/override or upgrade; `check:supply-chain` gates it |

Alerts are delivered via the existing site-health channel (WhatsApp/email); wiring
additional channels is an operator configuration concern.

## Log hygiene

- **No secret or PII in logs** — `check:channel-security` asserts no api-key/ciphertext/token reaches a log or audit payload; upstream provider bodies are never echoed (only safe categories + field names).
- **Bounded growth** — `channel_sync_errors` retention (`purge_channel_sync_errors`, H11); PAN retention (`purge_expired_cards`, H8). Nightly via `scripts/ops/guesthub-purge.mjs`.
- **Audit trail** — append-only, tenant-scoped; records field NAMES, never erased/secret values (anonymization, card reveal, tax-exempt, exports all audited this way).

## Backup-status monitoring

On top of the Stage-2 backup automation (`guesthub-backup.{service,timer}`, encrypted, restore-drilled): the "Backup missing" alert above watches artifact freshness. Off-host copy is the remaining Stage-2 open item (destination TBD by operator).

## Maintenance timers (host, documented — not in repo)

| Timer | Runs | Purpose |
|---|---|---|
| `guesthub-backup.timer` | nightly | encrypted DB (+auth) backup |
| `guesthub-restore-drill.timer` | weekly | prove a backup restores |
| `guesthub-db-firewall.service` | boot + after docker | re-assert the DB-port DROP (C2) |
| `guesthub-purge` (to add) | nightly | H8/H11 retention purge (`scripts/ops/guesthub-purge.mjs`, `PURGE_DATABASE_URL`) |

## Verified by
`check:channel-security` (log hygiene), `check:retention` (bounded growth), `check:background-job-recovery` (worker recovery), `check:db-isolation` (exposure).
