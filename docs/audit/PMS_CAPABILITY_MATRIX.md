# PMS Capability Matrix (Stage 5 §10/§1)

**Date:** 2026-07-18 · **Stage:** 5 — PMS Capability Completion · **Branch:** `feat/pms-hardening-channex-certification`

Implemented vs deferred, with justification. Deferral is documented, never silent
(charter §4). Every implemented capability writes through the canonical services +
audit trail and affects availability/outbox where relevant (§8/§22).

## Implemented in Stage 5

| # | Capability | What shipped | Lifecycle connection | Check |
|---|---|---|---|---|
| 1 | Communications — guest language | `resolveVersion` selects a published template variant by `guests.language` (same category), honest fallback; locked policy never overridden | fires on the real automation send path | `check:guest-communications-automation` (11 groups) |
| 2 | Housekeeping module | checkout auto-generates a cleaning task (idempotent); cleaner queue + advance dirty→cleaning→clean→inspected; manager assign/inspect; real my-tasks mobile screen | **checkout → cleaning task** | `check:housekeeping` |
| 3 | Maintenance OOO/OOS | typed closures (`kind` ooo/oos + category); OOO removes availability + syncs, OOS dirty-but-sellable; 3 availability functions filter `kind='ooo'` | **OOO block → availability −1 + outbox** | `check:maintenance-closures` |
| 4 | Operational tasks | unified store (`housekeeping_tasks.task_type` housekeeping/maintenance/general) — no parallel system; `createOperationalTaskAction` | shares the housekeeping flow | `check:housekeeping` |
| 5 | Reports | arrivals/departures/in-house, occupancy (canonical `room_type_inventory`), revenue+ADR, balances-due, cash-up, channel-production; safe server-side, tenant-scoped | reads canonical reliable data only | `check:reports` |
| 5b | Exports | reservation + guest CSV (injection-hardened `toCsv`, BOM); serves accountant handoff + privacy portability | audited | `check:reports` |
| 6 | Israel — tourist VAT | `includedVatForReservation` zero-rates a `tax_exempt` stay; `setReservationTaxExemptAction` (+ passport-evidence audit) | per-reservation, canonical VAT | `check:israel-market` |
| 6 | Israel — privacy (Amdt 13) | `anonymizeGuestAction` scrubs PII, keeps the row, stamps `anonymized_at`, idempotent, audits names-only | guest lifecycle | `check:israel-market` |
| 6 | Israel — invoice seam | provider-neutral `InvoiceProvider` interface + fail-closed Unconfigured default + validation | payment/reservation-ready | `check:israel-market` |

New migrations (staging :5434 only): 040 typed closures, 041 operational tasks, 042 guest anonymization.

## Deferred (with justification)

| Capability | Why deferred | Target |
|---|---|---|
| Report UI surfaces (dashboard KPI widgets, printable report pages) | The data layer + CSV export are the reliable-data foundation (built + checked); the UI is presentation over proven queries and is lower-risk to add incrementally. Charter warns against decorative screens — surfaces are added as real operators need them. | Stage 5 follow-on / Stage 7 polish |
| Real invoice provider (Green Invoice / EZcount) wiring | External provider account + government-allocated document numbers = a deployment dependency (V2 §2). The seam is built + fail-closed; the concrete provider is a single implementation. | Post-program, user-provisioned |
| Bulk data IMPORT (CSV in) | Export (out) serves the immediate accountant/portability need; import is higher-risk (validation, dedup, conflict) and no operational driver exists yet. | Stage 5 follow-on if a migration need arises |
| Maintenance ticketing (fault photos, resolution tracking) | The unified task foundation (maintenance task_type) covers the operational need; rich ticketing is "optional future" in the gap matrix. | Optional future |
| Multi-property permissions | Current model is complete for single-property (gap matrix §12); multi-property is an architectural expansion, not a Stage-5 gap. | When multi-property is scoped |
| H13 audit read/search UI | Audit write-integrity is sound; the read surface is presentation. Data-export (audit rows) partially covers the need. | Stage 5 follow-on / Stage 6 |

## Explicitly out of scope this stage (unchanged)

- Housekeeping cleanliness does NOT reduce availability (a dirty room is sellable before the next arrival — D64 0/1 model); only OOO maintenance does.
- Invoice documents are never fabricated — the seam fails closed until a real provider is wired.
- Anonymization keeps financial/audit records (retention) while erasing identity.
