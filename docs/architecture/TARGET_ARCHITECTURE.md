# GuestHub — Target Architecture

**Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification` · **Status:** Stage 1 deliverable, approved by Agent A (lead architect)

This is the reconciled target the seven-stage program implements. It honors V2 §8 in full and is the contract Stages 2–7 are measured against. Current-state facts come from the ten audit inventories under `docs/audit/`; decisions are recorded as ADRs under `docs/architecture/adr/`.

## 1. Guiding principles (V2 §8)

- **One source of truth** per business concept — see ADR-0001.
- **Layered separation:** UI → validation → application services → domain logic → persistence → provider clients → workers → audit/observability. Server actions orchestrate; they do not hold business logic.
- **Transaction safety:** every multi-entity change is one transaction (already true for reservations; extend to any new path).
- **Idempotency:** every external/repeatable operation is safe to run twice (already sound; preserve).
- **Time discipline:** all business-day logic in the property timezone through one shared date utility (already exemplary — preserve; test DST).
- **Money discipline:** exact decimal / integer minor units; one money module owns rounding (mostly true; remove the residual float fast-paths).
- **Fail visibly / fail closed:** missing price → stop-sell not zero; unknown mapping → quarantine; unknown environment → refuse; insufficient authz → deny.

## 2. Current architecture (as-audited)

- **Runtime:** Next.js 15 (App Router, RTL Hebrew), one PM2 web process (`guesthub`, :3007) + one PM2 worker (`guesthub-channel-worker`), both in `/var/www/guesthub-production`.
- **Data:** shared self-hosted Supabase Postgres (`supabase-db`, Supavisor `:5432`), schema `guesthub` (60 tables), GoTrue auth via Kong. **Dev and prod share this DB — Critical C1.**
- **Async:** durable `channel_sync_jobs` queue (leases, SKIP LOCKED, FIFO/connection), `channel_dirty_ranges` outbox, pg `NOTIFY`+SSE realtime; communications ride an events→deliveries queue **inside the same worker tick** (coupling M16).
- **Integrations:** Channex (staging), Gmail OAuth, GREEN-API/Twilio, Google Maps, local-disk uploads.
- **Strengths (preserve):** one pricing engine with quote↔ARI equality; authoritative payment ledger; crash-safe queue; ACK-after-commit; escape-first email renderer; fail-closed card vault; triple deploy guards. See `DEFECT_MATRIX.md` "Confirmed strengths".

See `docs/audit/ARCHITECTURE_INVENTORY.md` for the full inventory + Mermaid diagram.

## 3. Target architecture (per stage)

### Data tier (Stage 2 — ADR-0002)
Dedicated GuestHub PostgreSQL clusters per environment (Production; Certification/Staging) + per-environment GoTrue; disposable test DB (`guesthub-testdb`:5433) retained. Four least-privilege roles. Backups include the `auth` schema, are encrypted, retained, copied off-host, and restore-tested. Migration ledger + replay-from-zero + data-copy/checksum/smoke/rollback tooling + cutover runbook — cutover **not executed**.

### Domain tier (Stage 3)
Canonical sources enforced (ADR-0001). DB-level double-booking exclusion constraint + status CHECK + generated blocking-status column (ADR-0003). Payment ledger completed (refund/void/correction; idempotency keys populated; single balance formula). Canonical guest record + snapshot + import dedup seam (ADR-0005). Transactional `markAriDirty` on every ARI-affecting write feeding the outbox (ADR-0004). Audit read surface + append-only enforcement. Worker split so ARI sync and communications don't share a failure domain (M16). Dead paths removed (legacy `rates`, `sellable_units_backup_028`).

### Channel tier (Stage 4 — ADR-0004)
Environment routing from `channel_connections.environment` (remove hardcoded staging URL). Certification evidence ledger (V2 §13) capturing Task IDs on **all** submissions. Single batched sync envelope (tests 3–8 → "1 API call"); Group Update expansion (multi-room/plan/range/weekday). Rate-limit cooldown + circuit breaker (persistent, restart-safe, 429 1-min pause). Booking-receiving flow (create/modify/cancel + ACK; revisions feed only; polling fallback). Mapping consolidation (drop dead 005-era tables). Min Stay declaration = dual (Arrival + Through, per PRICING_AUDIT). Production activation guard (built, disabled — V2 §26).

### PMS completion (Stage 5)
Reports & exports (occupancy, revenue, balances-due, cash-up, channel production, audit export; safe server-side CSV). Israel-market: tourist VAT zero-rating dimension, invoice/receipt seam, PII retention/deletion/anonymization. Housekeeping and maintenance beyond stubs. Guest merge/edit UI. Communications resend surface.

### Security / performance / observability (Stage 6)
Full red-team resolving Critical/High in touched areas + supply chain. DB exposure hardening (C2). Load tests at 13-room and 100-room fixtures incl. DST dates. Health endpoint, worker heartbeat alerts, dead-letter/quarantine alerts, off-host backup monitoring, log hygiene.

### Verification / delivery (Stage 7)
Independent verifier, full regression, fresh-clone setup proof, final report, screenshare rehearsal, draft PR finalized. No merge, no deploy, no cutover.

## 4. Canonical sources of truth (summary — ADR-0001)

rooms → identity · `check_room_availability`/inventory.ts → availability · pricing engine → price · payments ledger → balance · reservations(+CHECK) → reservation state · guests(+snapshot) → guest · `channel_connections.environment` → channel env · dirty-ranges/outbox → sync · audit_logs → history.

## 5. Cross-cutting invariants (enforced by Stage-3+ checks)

- No UI/integration surface recomputes a canonical rule that has a shared function (`check:pms-domain-invariants`).
- Every ARI-affecting write marks dirty ranges in the same transaction (`check:channex-group-update-batching`, `check:reservation-concurrency`).
- Balance is always ledger-derived (`check:payment-ledger-integrity`).
- Quote == ARI price (`check:pricing-equality`, exists).
- One environment source; Production cannot self-activate (`check:channex-environment-routing`, `check:production-activation-guard`).
- No secrets in code/history/logs (`check:no-secrets`).
- Time/money invariants incl. DST (`check:timezone-and-money-invariants`).

## 6. Open decisions deferred to their stage

- Exact backup off-host destination and encryption key custody → Stage 2 runbook.
- RLS vs server-side-only enforcement per access path → Stage 3 ADR addendum (H3).
- PSP selection (Cardcom/Tranzila/Stripe) → business decision; the seam is provider-neutral (Stage 3), selection deferred (V2 §18).
- Invoice provider vs built-in → Stage 5 (seam either way).
