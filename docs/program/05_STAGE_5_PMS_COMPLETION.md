# STAGE 5 — PMS CAPABILITY COMPLETION

Read first: `00_COMMON_CHARTER.md`, `GUESTHUB_PROGRAM_V2.md`, `docs/program/STATE.md`, Stage 4 report.

## Stage mission

Complete the operational capabilities a mature PMS needs, per the Stage 1 gap matrix: communications, housekeeping, maintenance, tasks, reports and exports, permissions completeness, business settings, and Israel-market readiness — all connected to the real reservation lifecycle, never decorative.

## Entry gate

Charter entry gate (§5). Additionally: load the Stage 1 gap matrix; confirm each item classified "required for operational safety now" or "high-value near-term" and assigned to this stage has a concrete work item; confirm items classified "architectural preparation only" and "optional future" will be documented, not built.

## Binding V2 scope for this stage

* §10, implementation for these areas in full: Communications; Housekeeping foundation; Maintenance foundation; Operational tasks; Reports and exports; Israel-market readiness (tourist VAT zero-rating driven by guest attributes, invoice/receipt readiness or a clean external seam, full RTL and Hebrew correctness, guest-language communications, privacy-law-aware PII handling with retention and deletion capability).
* §1 completeness items not owned elsewhere: user roles and permissions completeness, data import/export, business settings, integration settings, production diagnostics.
* §8, §22 enforced throughout; every new module writes through the canonical services and the audit trail from Stage 3 and marks dirty ranges through the sync outbox where it affects availability.

## Stage-specific directives

* Honor the V2 warnings verbatim: no decorative housekeeping screens disconnected from the reservation lifecycle; no separate incompatible task systems per module; implement only reports whose underlying data is reliable; no shallow modules to fill a checklist.
* Housekeeping state changes, maintenance out-of-order blocks and owner blocks must correctly affect availability and, through the outbox, channel sync.
* Every deferred item is recorded in `PMS_CAPABILITY_MATRIX.md` with justification — deferral is documented, never silent.

## Active agents

C (lead), A, B, H, F, L, I, M.

## Milestones

1. Communications hardening: delivery attempts, retries, failure classification, immutable history, guest-language rendering.
2. Housekeeping foundation wired to checkout and reservation lifecycle.
3. Maintenance foundation with optional out-of-order inventory effect.
4. Unified operational task foundation.
5. Reports and exports with safe server-side generation.
6. Israel-market readiness items.
7. Permissions, settings, import/export, diagnostics completeness.
8. `PMS_CAPABILITY_MATRIX.md` finalized: implemented versus deferred with reasons.

## Checks added in this stage

Extend the Stage 3 domain checks to cover the new modules (housekeeping/maintenance availability effects inside `check:inventory-integrity`; report correctness inside `check:pms-domain-invariants`). No new check names are required, but coverage must demonstrably grow; record the delta in the stage report.

## Exit gate

Charter exit gate (§6), plus:

* Every stage-assigned gap item implemented with evidence or documented as deferred with justification.
* New modules proven connected to the real lifecycle (a checkout creates a cleaning task; an out-of-order block removes availability and syncs).
* RTL and Hebrew correctness verified on all new and touched screens.
* All previous checks still pass.
* Tag `stage-5-complete`.
