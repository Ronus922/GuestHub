# GuestHub — PMS Capability Matrix

- **Status:** Skeleton — Stage 1; completed in **Stage 5**
- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Sources:** `docs/audit/PMS_GAP_MATRIX.md` (seeded verbatim below), `docs/architecture/TARGET_ARCHITECTURE.md` (§3)

A living map of GuestHub capabilities vs a mature commercial PMS (Cloudbeds/Guesty class), classified and owned per stage. This document tracks completion as stages deliver; the classifications are seeded from the Stage-1 gap matrix.

**Classification legend:** RS = Required for operational safety now · HV = High-value near-term · AP = Architectural preparation only · OF = Optional future module. Owning stage: core-domain → Stage 3; communications/housekeeping/maintenance/reports/Israel-market → Stage 5.

## Current state

GuestHub is mature in its core: ONE shared booking editor, transactional reservation actions with audit, the strongest pricing area (one engine, one seam, dual restriction semantics), an authoritative payments ledger, canonical room identity, ~60 mutation-verified `check:*` scripts, and the most-invested channel-manager integration (`PMS_GAP_MATRIX.md` §1–§6, §16, §19). The gaps are concentrated in operational completeness rather than foundations: no folio/line-item charges, no automated no-show sweep, no guest merge/edit UI, no refund workflow, no reports/exports (dashboard is a stub), housekeeping/maintenance are stubs, and Israel-market items (tourist VAT zero-rating, invoice/receipt seam, PII deletion/anonymization) are absent (`PMS_GAP_MATRIX.md` §7–§13, §21). Data reality: 1 tenant, 14 rooms, 60 guests, 81 reservations.

## Seeded RS/HV matrix (from PMS_GAP_MATRIX.md consolidated table)

| Area | Item | Class | Stage |
|---|---|---|---|
| Payments | Card-vault retention enforcement (purge expired card data) | RS | 3 |
| Data recovery | Off-site backup copy | RS | 3 |
| Reservations | Folio / itemized charges | HV | 3 |
| Reservations | Automated no-show / stale-status sweep | HV | 3 |
| Guests | Guest merge/dedup tooling | HV | 3 |
| Guests | Guest management UI (edit/VIP/block) | HV | 3 |
| Payments | Refund/void operator workflow | HV | 3 |
| Payments | Payment-policy stage enforcement/alerts | HV | 3 |
| Pricing | Restriction enforcement on direct entry (verify & close) | HV | 3 |
| Audit | Audit viewer/search + full per-entity history | HV | 3 |
| Users | MFA/2FA for operators | HV | 3 |
| Channels | Operator alerting on sync failure/quarantine | HV | 3 |
| Data recovery | Backup monitoring + codified restore runbook | HV | 3 |
| Housekeeping | Full housekeeping module | HV | 5 |
| Maintenance | Typed OOO/OOS closures with categories | HV | 5 |
| Communications | Guest-language template selection | HV | 5 |
| Reports | Arrivals/departures/in-house printable reports | HV | 5 |
| Reports | Occupancy + revenue (ADR/RevPAR) | HV | 5 |
| Reports | Balances-due / debtors | HV | 5 |
| Reports | Payments / end-of-day cash-up | HV | 5 |
| Reports | Cancellations / availability / channel-production | HV | 5 |
| Reports | Audit export | HV | 5 |
| Reports | Dashboard KPIs | HV | 5 |
| Data import/export | Reservation/guest/payment CSV export | HV | 5 |
| Israel | Tourist VAT zero-rating (+ passport evidence) | HV | 5 |
| Israel | Invoice/receipt seam | HV | 5 |
| Israel | PII retention + deletion/anonymization (Amendment 13) | HV | 5 |

(AP/OF items — PSP integration, drop `sellable_units_backup_028`, audit retention, multi-property readiness, direct-booking engine, promotions, unified inbox, etc. — are tracked in `PMS_GAP_MATRIX.md` and deferred.)

## Target state

- Stage 3 closes the core-domain RS/HV items (payments, guests, audit viewer, restriction enforcement, backup, MFA, sync alerting).
- Stage 5 delivers the PMS-completion set (reports/exports, housekeeping, maintenance, Israel-market, guest-language comms).
- This matrix is updated at each stage boundary with status per row.

## To be completed in Stage 5

- [ ] Convert the seeded table into a live status matrix (each row: current → target → status).
- [ ] Add per-item acceptance criteria and evidence links as items ship.
- [ ] Record any reclassification (e.g. OF → HV) with rationale.
- [ ] Final delivered-vs-deferred summary for Stage 7 handoff.
