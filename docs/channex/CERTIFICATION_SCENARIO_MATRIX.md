# Channex PMS Certification — Scenario Matrix

- **Status:** Skeleton — Stage 1; completed in **Stage 4**
- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Sources:** `docs/channex/PMS_CERTIFICATION_REQUIREMENTS.md` (§5, the 14 rows), `docs/audit/CHANNEX_CERTIFICATION_MAPPING.md` (§1 firing points)

The 14 certification items mapped to the exact PMS UI action, the code path that fires the call, expected vs actual request count, and evidence capture. Seeded from the Stage-1 requirement snapshot and mapping audit; re-verify test values live at Stage 4 entry (values roll forward periodically — V2 §4).

## Current state

Tests 1–11 are executable scenarios (triggered only from the normal PMS UI); items 12–14 are declarations. The architecture already fires each call from a real update path, but **incremental drains do not persist Task IDs** (only `full_sync` and room-type/rate-plan creation do) — so the certification form cannot be filled from GuestHub data for tests 2–10 today (`CHANNEX_CERTIFICATION_MAPPING.md` §1 columns "Task-ID capture today", G1). 429 handling (item 12) cannot be honestly signed until G3 is fixed; the availability model deviation (0/1 per room, G4) must be declared in the form notes for tests 9–10.

## Seeded scenario matrix (from PMS_CERTIFICATION_REQUIREMENTS.md §5 + mapping firing points)

| # | Title | PMS UI action | Code path (firing point) | Expected calls | Evidence | Task-ID today |
|---|---|---|---|---|---|---|
| 1 | Full Sync (500 days, all rooms+plans) | `/channels` → "סנכרון מלא" | `admin.ts requestFullSync` → `ari-sync.ts runInitialFullSync` → `sendBatches` → `pushAri` | Exactly 2 (empirically 2) | Task IDs | **Yes** |
| 2 | Single date, single rate | `/rates` edit one cell, save | `rates/actions.ts` → `service.ts:177 markAriDirty` → drain → 1 POST `/restrictions` | 1 | Task ID | No (G1) |
| 3 | Single dates, multiple rates | `/rates` Group Update (3 combos), one save | same drain, `buildRestrictionValues` one batch | 1 batched | Task ID | No (G1) |
| 4 | Date ranges, multiple rates | `/rates` Group Update with ranges (D93) | same; ranges → `[from,to)` compressed | 1 | Task ID | No (G1) |
| 5 | Min Stay | `/rates` min-stay fields, Group Update | same restrictions path | 1 | Task ID | No (G1) |
| 6 | Stop Sell | `/rates` sale-state close | same; every value carries `stop_sell` | 1 | Task ID | No (G1) |
| 7 | Combined restrictions (CTA/CTD/min/max) | `/rates` editor, Group Update | same restrictions path | 1 | Task ID | No (G1) |
| 8 | Half-year update | `/rates` Group Update over long range | same; ~180d compresses | 1 | Task ID | No (G1) |
| 9 | Single-date availability (booking) | create/edit/cancel reservation | `reservations/actions.ts` → `markAriDirty(availability)` → 1 POST `/availability` | 1–2 (0/1 model, G4) | Task IDs + screenshots | No (G1) |
| 10 | Multi-date availability | multi-night reservation / closure | same; consecutive days compressed | 1–2 | Task IDs | No (G1) |
| 11 | Booking receiving (create/modify/cancel + ACK) | BDC test account inbound | webhook → `runInboundPull` → `booking-import.ts` → `acknowledgeBookingRevision` (ack after commit) | per revision | Booking IDs + screenshots | **Yes** |
| 12 | Rate limits (declaration) | — | pacing 1/6.5s; **G3 gap** | — | Written answer | Partial (G3) |
| 13 | Update logic (declaration) | — | delta-only, no timer full-sync | — | Written answer | Pass |
| 14 | Extra notes (declarations) | — | dual min-stay, CVV never stored, PCI posture | — | Written answers | Declarable |

## To be completed in Stage 4

- [ ] Re-verify all test values/dates live at Stage 4 entry (V2 §4) and update the table.
- [ ] After G1/G2, add the captured Task ID per executed scenario.
- [ ] Finalize the G4 availability-model deviation note text for the form.
- [ ] Write declarations 12–14 (429 behavior after G3, min-stay dual semantics, PCI).
- [ ] Cross-link each row to CERTIFICATION_RUNBOOK steps.
