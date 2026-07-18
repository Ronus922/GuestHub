# Channex PMS Certification — Scenario Matrix

- **Status:** Completed (offline) — Stage 4; live execution pending a Channex Staging channel (V2 §2)
- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Sources:** `docs/channex/PMS_CERTIFICATION_REQUIREMENTS.md` (§5, the 14 rows), `docs/audit/CHANNEX_CERTIFICATION_MAPPING.md` (§1 firing points)

The 14 certification items mapped to the exact PMS UI action, the code path that fires the call, expected vs actual request count, and evidence capture. Seeded from the Stage-1 requirement snapshot and mapping audit; re-verify test values live at Stage 4 entry (values roll forward periodically — V2 §4).

## Current state (Stage 4)

Tests 1–11 are executable scenarios (triggered only from the normal PMS UI); items 12–14 are declarations. Gaps that previously blocked honest form-filling are now **closed**:

- **G1 (Task IDs on incremental) — CLOSED (M2).** The evidence ledger
  (`channel_evidence_ledger`, migration 038) records the Channex Task IDs for
  EVERY scenario, including incremental drains (`drainAriDirtyRanges` no longer
  discards them). Tests 2–10 can now be filled from GuestHub data.
- **G3 (429 handling / item 12) — CLOSED (M6).** The circuit breaker
  (`circuit-breaker.ts`, migration 039) honours the 429 `Retry-After` cooldown
  and opens after repeated failures. Declaration 12 can be signed honestly.
- **G4 (availability 0/1-per-room model) — DECLARED.** GuestHub's inventory unit
  is the physical room (count_of_rooms=1, D64), so availability is 0/1 per room.
  This is a legitimate model, declared in the form notes for tests 9–10.

**Traceability:** every executable row names the firing file + function; the
evidence ledger stamps the same `firing_file`/`firing_function` per execution, so
the form entry and the running code are provably the same path. Verified by
`check:channex-certification`.

## Seeded scenario matrix (from PMS_CERTIFICATION_REQUIREMENTS.md §5 + mapping firing points)

| # | Title | PMS UI action | Code path (firing point) | Expected calls | Evidence | Task-ID today |
|---|---|---|---|---|---|---|
| 1 | Full Sync (500 days, all rooms+plans) | `/channels` → "סנכרון מלא" | `admin.ts requestFullSync` → `ari-sync.ts runInitialFullSync` → `sendBatches` → `pushAri` | Exactly 2 (empirically 2) | Task IDs | **Yes** |
| 2 | Single date, single rate | `/rates` edit one cell, save | `rates/actions.ts` → `service.ts markAriDirty` → drain → 1 POST `/restrictions` | 1 | Task ID | **Yes** |
| 3 | Single dates, multiple rates | `/rates` Group Update (3 combos), one save | same drain, `buildRestrictionValues` one batch | 1 batched | Task ID | **Yes** |
| 4 | Date ranges, multiple rates | `/rates` Group Update with ranges (D93) | same; ranges → `[from,to)` compressed | 1 | Task ID | **Yes** |
| 5 | Min Stay | `/rates` min-stay fields, Group Update | same restrictions path | 1 | Task ID | **Yes** |
| 6 | Stop Sell | `/rates` sale-state close | same; every value carries `stop_sell` | 1 | Task ID | **Yes** |
| 7 | Combined restrictions (CTA/CTD/min/max) | `/rates` editor, Group Update | same restrictions path | 1 | Task ID | **Yes** |
| 8 | Half-year update | `/rates` Group Update over long range | same; ~180d compresses | 1 | Task ID | **Yes** |
| 9 | Single-date availability (booking) | create/edit/cancel reservation | `reservations/actions.ts` → `markAriDirty(availability)` → 1 POST `/availability` | 1–2 (0/1 model, G4) | Task IDs + screenshots | **Yes** |
| 10 | Multi-date availability | multi-night reservation / closure | same; consecutive days compressed | 1–2 | Task IDs | **Yes** |
| 11 | Booking receiving (create/modify/cancel + ACK) | BDC test account inbound | webhook → `runInboundPull` → `booking-import.ts` → `acknowledgeBookingRevision` (ack after commit) | per revision | Booking IDs + screenshots | **Yes** |
| 12 | Rate limits (declaration) | — | circuit breaker + 429 Retry-After cooldown (M6) | — | Written answer §12 | Pass |
| 13 | Update logic (declaration) | — | delta-only, no timer full-sync | — | Written answer §13 | Pass |
| 14 | Extra notes (declarations) | — | dual min-stay, CVV never stored, PCI posture | — | Written answers §14 | Pass |

Task IDs for every executed scenario are captured in the evidence ledger and shown
in the read-only certification console (`/channels`). Each executable row's firing
file+function is stamped on its evidence row (traceability).

## Declarations (items 12–14 — written form answers)

### §12 — Rate limits

> GuestHub respects Channex's documented ARI rate limits (10 availability + 10
> restriction requests per minute per property). Outbound ARI is paced below that
> budget by the PM2 worker. On HTTP 429 the client reads `Retry-After` and a
> connection-level **circuit breaker** opens for exactly that cooldown (falling
> back to a base cooldown when the header is absent), then half-opens to test
> recovery. Repeated server/transport failures also trip the breaker with an
> exponential, capped cooldown. See `circuit-breaker.ts`, `channex-http.ts`,
> migration 039; proven by `check:channex-rate-limit-cooldown`.

### §13 — Update logic

> After the initial Full Sync (exactly 500 property-local dates in exactly two
> requests — one availability, one rates/restrictions), GuestHub sends **deltas
> only**. Every canonical save marks the affected (room × plan × date) ranges
> dirty; the worker merges them into one combined request per dimension and sends
> only what changed. There is no timer-driven or periodic full re-sync — a full
> sync is operator-triggered only. See `ari-sync.ts`; proven by
> `check:channex-full-sync-two-requests` + `check:channex-group-update-batching`.

### §14 — Extra notes (model + PCI)

> - **Availability model:** GuestHub's inventory unit is the physical room
>   (`count_of_rooms = 1` per Channex Room Type, D64), so availability is 0/1 per
>   room rather than a pooled count. This is deliberate and consistent across ARI.
> - **Min Stay:** both `min_stay_arrival` (primary, floored by the plan default)
>   and `min_stay_through` (optional) are supported and mapped 1:1 to Channex
>   (see `MIN_STAY_SEMANTICS.md`).
> - **PCI / cards:** GuestHub never stores CVV; card PANs from OTA bookings are
>   handled per the tokenization boundaries in `docs/payments/`. The card `/pci`
>   endpoints are never called from the booking client.
> - **Environment separation:** all certification traffic is Staging-only;
>   production is guarded and inactive (`check:production-activation-guard`).

## Cross-reference

Each executable row is executed per `CERTIFICATION_RUNBOOK.md`; evidence lands in
`channel_evidence_ledger` and is reviewed in the read-only console. Live execution
against Channex Staging is the one remaining external dependency (V2 §2) — see
`BOOKING_RECEIVING_CERTIFICATION.md` and the runbook.
