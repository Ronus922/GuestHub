# STAGE 3 — CORE DOMAIN INTEGRITY

Read first: `00_COMMON_CHARTER.md`, `GUESTHUB_PROGRAM_V2.md`, `docs/program/STATE.md`, Stage 2 report.

## Stage mission

Make the heart of the PMS correct, transaction-safe and canonical: reservations, inventory, pricing, payments, guests, background jobs, audit history. After this stage, double bookings are impossible at the database level, every price comes from one engine, every balance comes from one ledger, and every multi-entity change is transactional. This is the foundation Stage 4 builds Channex on.

## Entry gate

Charter entry gate (§5). Additionally verify: staging database live and smoke-tested; Stage 1 defect matrix items assigned to Stage 3 are loaded as the working backlog; characterization-test rule acknowledged — no fragile area is refactored before its current behavior is captured (V2 §24 opening rule).

## Binding V2 scope for this stage

* §10, implementation for these areas in full: Properties and business identity; Rooms and inventory; Reservations (including the database-level double-booking prevention: exclusion constraint over room and stay daterange on active states, plus row/advisory locks); Guests (per the Stage 1 ADR, with migration safety); Pricing and restrictions (quote, calendar and rate-grid equality proven; ARI equality is proven in Stage 4); Payments; Audit and history.
* §18 in full: payment and tokenization boundaries, the provider-neutral payment-method reference model, and both `docs/payments/` documents.
* §15, foundation portion: every canonical operation affecting availability, rates or restrictions writes its dirty range through a generic sync outbox in the same business transaction, per the Stage 1 ADR. The outbox is provider-agnostic here; Stage 4 attaches Channex.
* §1 "canonical background-job infrastructure" and §21 foundations: durable queues, idempotent job claims, lease recovery, dead-letter handling, worker heartbeat and basic queue visibility.
* §8 enforced everywhere touched: one source of truth, layer separation, transaction safety, idempotency, time discipline (one shared property-local date utility, DST-tested), money discipline (one shared exact-arithmetic money module), fail visibly, fail closed.
* V2 Phase 5: maintainability refactor of the core areas — remove duplicated paths, split unsafe large modules, document invariants — with characterization tests captured first.
* §19, applicable portion: fix every Critical/High authorization, tenant-isolation and server-action finding from the Stage 1 threat model that touches these code paths.
* §23, domain documents: complete `DOMAIN_MODEL.md`, `RESERVATION_LIFECYCLE.md`, `INVENTORY_AND_AVAILABILITY.md`, `PRICING_AND_RESTRICTIONS.md`, `PAYMENTS_AND_LEDGER.md`, `BACKGROUND_JOBS.md`, `AUTHORIZATION_AND_TENANCY.md`.

## Stage-specific directives

* Migrations for constraints and schema corrections follow §3: verified backup, tested rollback, replay proven on the disposable database before touching staging.
* Concurrency proof is mandatory, not optional: run the V2 §24 concurrency tests relevant to this stage (two manual reservations for the last room, simultaneous rate updates, simultaneous cancellation and modification, worker crash, two workers) and record evidence.
* Existing behavior the business depends on is preserved unless the defect matrix marks it wrong; every intentional behavior change is listed in the stage report.

## Active agents

A (lead), F, G, H, B, L, I, M. Agent N spot-reviews the double-booking and ledger proofs.

## Milestones

1. Characterization tests for fragile core areas.
2. Reservation and inventory canonicalization with database-level double-booking prevention proven.
3. Canonical pricing engine with quote/calendar/grid equality proven.
4. Payment ledger integrity and payment-method reference model.
5. Guest model per ADR, migrated safely.
6. Sync outbox and durable background-job infrastructure.
7. Maintainability refactor and domain documentation.

## Checks added in this stage

`check:pms-domain-invariants`, `check:reservation-concurrency`, `check:inventory-integrity`, `check:pricing-equality`, `check:payment-ledger-integrity`, `check:background-job-recovery`, `check:timezone-and-money-invariants`.

## Exit gate

Charter exit gate (§6), plus:

* All seven new checks pass; Stage 2 checks still pass.
* Double-booking prevention proven at the database-constraint level with recorded evidence.
* Quote, calendar and rate-grid price equality proven.
* Scoped regression: the V2 §25 items touching reservations, calendar, rates, payments, permissions all pass.
* Every Stage-3-assigned Critical/High defect closed or re-scoped with justification.
* Tag `stage-3-complete`.
