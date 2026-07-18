# GuestHub — Observability

- **Status:** Skeleton — Stage 1; completed in **Stage 6**
- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Sources:** `docs/audit/OPERATIONS_OBSERVABILITY_AUDIT.md`, `docs/architecture/TARGET_ARCHITECTURE.md` (§3 Stage 6)

Health checks, worker heartbeat, queue/quarantine visibility, structured logging, alerting, and backup monitoring.

## Current state

There is **no `/api/health` endpoint** — the fleet `site-health` timer probes `GET /` (200/307), which proves only the Next process serves, not DB reachability, and the channel worker is entirely outside external monitoring (no port, no probe) (`OPERATIONS_OBSERVABILITY_AUDIT.md` §1, F4). The worker writes a `channel_worker_state` heartbeat each tick (fresh in the snapshot) but nothing alerts on staleness — visible only if a super_admin opens `/channels` (§2, F3). The real observability backbone is DB-structured: `channel_sync_errors`, job rows, `channel_booking_revisions.mapping_error`, `communication_delivery_attempts`, `outbound_messages`, and `audit_logs` for every canonical write — adequate for single-host forensics via DB queries (§6). Process logs are single-line `console` to PM2 with no rotation config in-repo, no levels, no correlation ids, no shipping (§6, F10).

The dominant gap is **alerting**: nothing pages/emails/WhatsApps on dead-letter jobs, new quarantines, worker heartbeat staleness, dead dirty ranges, error bursts, ambiguous email deliveries, or backup failures (§7, F3). Concrete pain points seeded for Stage 6: the quarantine reprocessing storm (579 error rows in one day from ~25 revisions × ~20 poll cycles, F2), dead (`failed`) dirty ranges as a silent-stale path (F5), ambiguous email deliveries with no operator resend surface (F6), a `channel_webhook_events.status` column that never leaves `'enqueued'` (F8), and unbounded growth of operational tables (F9). Backups have **no off-host copy**, no restore test, no empty-dump detection, no failure alert (F1 — the Stage-3 off-host RS also feeds here).

## Target state (per TARGET_ARCHITECTURE.md §3 Stage 6)

- Health endpoint proving DB reachability; worker heartbeat staleness alerts.
- Dead-letter / quarantine / dead-dirty-range alerts and operator-visible surfaces.
- Off-host backup monitoring (last-success, integrity).
- Log hygiene (rotation, levels, correlation ids where useful).
- Quarantine-logging dedup + retention (foundation Stage 3, tuned Stage 6).

## To be completed in Stage 6

- [ ] Health-check design (web + worker + DB probe).
- [ ] Alerting matrix (condition → channel → threshold) covering F1–F9.
- [ ] Structured-logging standard.
- [ ] Operator visibility surfaces (dead-letter/quarantine/dead-range/failed-delivery lists + requeue).
- [ ] Backup monitoring + restore-drill hook.
- [ ] Load-test observability at 13-room and 100-room fixtures (incl. DST dates).
