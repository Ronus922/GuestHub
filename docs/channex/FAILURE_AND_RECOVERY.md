# Channex — Failure & Recovery

- **Status:** Skeleton — Stage 1; completed in **Stage 4**
- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Sources:** `docs/audit/OPERATIONS_OBSERVABILITY_AUDIT.md` (§3–§5, F2/F3/F5), `docs/audit/WORKFLOW_INVENTORY.md` (§16), ADR-0004

Every failure mode of the Channex integration and its recovery path: rate limits, dead-letter jobs, dead dirty ranges, quarantine, worker crash, and webhook loss.

## Current state

The queue core is crash-safe: durable-then-wake NOTIFY on commit, `FOR UPDATE SKIP LOCKED` claims, 10-min lease reclaim, FIFO per connection, ack-after-commit with re-ack sweep, persist-then-quarantine, and state-replacing (not delta) ARI payloads — no job-loss path was found (`OPERATIONS_OBSERVABILITY_AUDIT.md` F11; `WORKFLOW_INVENTORY.md` §16). Recovery paths exist for the main flows: Full Sync re-run button, `pull_booking_revisions` auto re-enqueue, recovery-by-revision-ID action.

But several failure modes are silent or unbounded: **429 handling** has no property-level 1-minute pause, no Retry-After, no circuit breaker (G3); **dead-letter jobs** have no requeue UI, only a count (§3 F-gap); **dead (`failed`) dirty ranges** (after `max_attempts=5`) have no counter, list, or requeue — the OTA keeps stale ARI until an unrelated save re-dirties the dates (F5); **quarantine reprocessing storms** re-import every poll writing a fresh error row (579 rows in one day, F2); if PM2 exhausts `max_restarts:10` the worker stays `errored` with jobs queued and **no alert** (F3). None of these page anyone (§7 — no alerting on channel-domain failure).

## Target state (per ADR-0004, TARGET_ARCHITECTURE.md)

- 429 cooldown + circuit breaker as a persistent property of the connection (G3, ADR-0004 §4).
- Dead-letter and dead-dirty-range requeue surfaces (Stage 3/Stage 6 observability).
- Quarantine-logging dedup + retention (ADR-0004 §7).
- Alerting on dead-letter, new quarantine, worker heartbeat staleness, dead ranges (Stage 6).

## To be completed in Stage 4

- [ ] Failure-mode catalog (rate-limit / dead-letter / dead-range / quarantine / worker-crash / webhook-loss) with recovery per mode.
- [ ] 429/circuit-breaker recovery behavior.
- [ ] Requeue procedures (dead-letter, dead-range).
- [ ] Quarantine resolution/resync workflow.
- [ ] Alerting hooks (cross-link OBSERVABILITY.md, Stage 6).
