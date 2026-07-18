# Channex Integration — Architecture

- **Status:** Skeleton — Stage 1; completed in **Stage 4**
- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Sources:** `docs/audit/CHANNEX_CERTIFICATION_MAPPING.md`, ADR-0004, `docs/channex/PMS_CERTIFICATION_REQUIREMENTS.md`

The end-to-end Channex integration architecture: change detection → outbox → queue → worker → single sync seam → mapping layer → inbound feed/ACK.

## Current state

Every outbound ARI request goes through exactly one seam — `pushAri()` in `src/lib/channel/channex-ari.ts` (POST `/availability` | POST `/restrictions`), invoked only by `sendBatches()` in `ari-sync.ts`, invoked only by the PM2 channel worker (`CHANNEX_CERTIFICATION_MAPPING.md` §1). Change detection is event-based: every canonical save calls `markAriDirty()` inside the same transaction as the business write, feeding `channel_dirty_ranges` (coalescing outbox) → the durable `channel_sync_jobs` queue → the worker. The mapping layer is live: `channel_connections` (property), `channel_room_mappings` (room→Room Type, `count_of_rooms=1`, D64), `channel_room_rate_mappings` (room×plan→Rate Plan), plus inbound alias adoption (032). Inbound is persist-then-quarantine with ACK strictly after commit. The audit concludes the architecture matches the official pre-flight checklist almost point-for-point with **no rejected anti-pattern present** (`CHANNEX_CERTIFICATION_MAPPING.md` §3, §4, §6 summary).

The gaps are evidentiary and resilience-related, not structural: incremental drains **discard the Task IDs** they receive (G1); there is **no dedicated evidence ledger** (V2 §13, G2); **429 handling** has no property-level 1-minute pause, no Retry-After, no circuit breaker — generic backoff retries too fast (G3); the availability model is 0/1 per physical room so test 9's "Twin→7" is inexpressible (G4); "exactly 2 calls" for Full Sync is empirical not asserted (G5); and outbound paths **hardcode the staging base URL** even though `channel_connections.environment` exists and inbound honors it (G6) (`CHANNEX_CERTIFICATION_MAPPING.md` §6).

## Target state (per ADR-0004)

- Keep the existing outbox seam as canonical; formalize and harden, not replace (ADR-0004).
- Evidence is a first-class output of every submission (correlation id, endpoint, environment, scope, value count, byte size, payload hash, Task IDs, status) — Task IDs captured for incremental syncs too (G1/G2).
- Rate-limit resilience as a property of the connection: persistent `cooldown_until`, circuit state, 1-minute 429 pause, separate availability/restrictions budgets — survives restart (G3).
- Environment routing resolved from `channel_connections.environment` on every call; staging hardcode removed (G6).
- Single batched sync envelope; Group Update expansion (G5/G7); Min Stay declared dual.

## To be completed in Stage 4

- [ ] Component diagram: save → outbox → queue → worker → pushAri → Channex; inbound webhook/feed → import → ACK.
- [ ] Mapping-layer reference (property/room/rate-plan/alias tables).
- [ ] Evidence-ledger schema (V2 §13).
- [ ] 429/circuit-breaker design (G3).
- [ ] Environment-routing removal of the staging hardcode (G6).
- [ ] Cross-links to ARI_SYNC_FLOW, BOOKING_REVISION_FLOW, ENVIRONMENT_SEPARATION, FAILURE_AND_RECOVERY.
