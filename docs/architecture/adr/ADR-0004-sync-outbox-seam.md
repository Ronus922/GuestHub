# ADR-0004 — Sync-outbox seam design

- **Status:** Accepted (Stage 1) — approved by Agent A; input to Stage 3 (build) and Stage 4 (consume)
- **Date:** 2026-07-18
- **Deciders:** Agents A, D, E, F, G
- **Context inputs:** `docs/audit/CHANNEX_CERTIFICATION_MAPPING.md`, `WORKFLOW_INVENTORY.md`, `OPERATIONS_OBSERVABILITY_AUDIT.md`, `docs/channex/PMS_CERTIFICATION_REQUIREMENTS.md`, V2 §14–§17

## Context

Channex certification's pre-flight checklist requires: change detection on save → an outbox/queue (not direct API calls from the save handler) → batched delta updates → retry/backoff on 429/5xx → webhook + ACK. The audit found GuestHub **already has this shape**: every canonical ARI-affecting save writes `channel_dirty_ranges` in the same transaction (`markAriDirty`), a durable `channel_sync_jobs` queue drains them via one worker seam (`pushAri` → `sendBatches`), with leases, `SKIP LOCKED`, FIFO per connection, and ACK-after-commit on inbound. No rejected anti-pattern is present. The gaps are evidentiary and resilience-related, not structural: Task IDs are discarded on incremental syncs (H9), there is no dedicated evidence ledger (H10), 429 handling lacks a proper cooldown/circuit-breaker (M14), and quarantine re-import grows errors unbounded (H11).

## Decision

**Keep the existing outbox seam as the canonical design; formalize and harden it rather than replace it.** The seam is:

```
canonical domain write (Stage 3 services)
  └─ same transaction → markAriDirty(connection, room, rate?, date-range)  →  channel_dirty_ranges   (the OUTBOX)
                                                                                      │
worker drain (drainAriDirtyRanges) ── coalesce ranges ── build ONE batched payload ── pushAri() ── Channex
                                                                                      │
                                                          record Task IDs + payload hash + counts → EVIDENCE LEDGER (Stage 4)
```

Design commitments:

1. **Transactional dirty-range marking is the only way ARI change enters the outbox.** No worker or UI path pushes to Channex outside this seam (satisfies pre-flight items 1–2; keeps the "delete all cert code and it still works" property).
2. **Batching/coalescing lives in the drain, not the producer.** Multiple dirty rows for a connection collapse into one `POST /availability` + one restrictions/rates call where the values fit the 10 MB limit — this is what makes certification tests 3–8 emit "1 API call". Group Update writes many rows in one transaction that the drain coalesces into one envelope (V2 §15).
3. **Evidence is a first-class output of every submission** (Stage 4 builds `certification_*`/ARI-submission tables per V2 §13): correlation ID, endpoint, environment, scope, value count, byte size, payload hash, Task IDs, status, sanitized failure. Task IDs are captured for **incremental** syncs too (fixes H9/H10). Never store API keys, auth headers, card data, or unbounded response bodies.
4. **Rate-limit resilience is a property of the connection, not the request** (Stage 4, V2 §16): persistent `cooldown_until`, failure category, consecutive-transient count, last-success, circuit state — survives worker restart; manual actions cannot bypass cooldown; separate budgets for availability vs restrictions; bounded exponential backoff; 1-minute pause after 429.
5. **Environment routing is resolved from `channel_connections.environment`** on every call (V2 §11); the hardcoded staging base URL (CHX G6) is removed in Stage 4. Production stays disabled behind the activation guard (V2 §26).
6. **Outbox generality:** the same dirty-range/queue pattern is the model for other durable async work (communications already ride an analogous events→deliveries queue); do not invent a second incompatible queue.
7. **Retention:** dirty-range/job/error tables get a pruning policy (fixes unbounded growth H11/OPS) — a Stage 3 foundation, tuned in Stage 6.

## Consequences

- Stage 3 builds: canonical rate/inventory services that call `markAriDirty` transactionally, the generic outbox semantics, queue heartbeat/visibility foundations, and quarantine/retention handling.
- Stage 4 builds: the Channex wiring on top (single sync envelope, Group Update expansion, evidence ledger with Task IDs, cooldown/circuit-breaker, Min Stay declaration, booking-receiving flow).
- Because the seam already exists and is anti-pattern-free, this is hardening, not a rewrite — low regression risk, and it preserves the confirmed strength "Channex architecture is certification-shaped".
