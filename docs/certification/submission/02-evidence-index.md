# 02 — Evidence Index · Scenarios 1–11

**Environment:** Channex Staging (every row). **Product:** GuestHub.
**Evidence store:** `guesthub.channel_evidence_ledger` (migration 038) — append-only,
written only by `recordAriEvidence` (`src/lib/channel/evidence.ts`), read-only in the
`/channels` certification console. Every executed scenario stamps its `scenario_key`,
`task_ids`, `firing_file`, `firing_function`, `request_count` and `expected_requests`,
so the form entry and the running code are provably the same path.

**Live-run status (see `DECISIONS.md` D-1).** As assembled, the ledger holds **0 rows**
(no scenario has been executed against the certification property yet). Each row below
therefore names the exact ledger key + firing path + expected counts; the **Task IDs**
and **Screenshots** columns are filled during the live run.

Legend — *Date executed / Task IDs / Screenshots*: **PENDING** = produced by the live
run; everything else (UI screen, code path, expected counts) is fixed and verified now.

---

## Executable scenarios (1–11)

| # | Scenario | Triggering UI screen | Code path (firing file → function) | Ledger `scenario_key` | Expected requests | Date executed | Task IDs | Screenshots |
|---|---|---|---|---|---|---|---|---|
| 1 | Full Sync (500 days, all rooms+plans) | `/channels` → "סנכרון מלא" (`AriSyncSection.tsx:235`) | `admin.ts:305 requestFullSyncAction` → `ari-sync.ts:312 runInitialFullSync` → `ari-sync.ts:214 sendBatches` → `channex-ari.ts:85 pushAri` | `full_sync` | **Exactly 2** (1× `POST /availability`, 1× rates+restrictions) over 500 property-local dates | PENDING | PENDING (2 Task IDs) | PENDING |
| 2 | Single date, single rate | `/rates` → edit one cell, save | `rates/actions.ts` → `lib/rates/service.ts markAriDirty` → `ari-sync.ts:618 drainAriDirtyRanges` → `ari-projection.ts:206 projectAri` → `ari-payloads.ts:184 buildRestrictionValues` → `channex-ari.ts:85 pushAri` | `incremental_sync` | 1 | PENDING | PENDING (1) | PENDING |
| 3 | Single dates, multiple rates | `/rates` → Group Update (3 combos), one save | same drain path; one batched restrictions call | `incremental_sync` | **1 batched** | PENDING | PENDING (1) | PENDING |
| 4 | Date ranges, multiple rates | `/rates` → Group Update with ranges (D93 datepicker) | same; ranges compressed to `[from,to)` | `incremental_sync` | 1 | PENDING | PENDING (1) | PENDING |
| 5 | Min Stay | `/rates` → min-stay fields, Group Update | same restrictions path (`min_stay_arrival` primary, `min_stay_through` optional) | `incremental_sync` | 1 | PENDING | PENDING (1) | PENDING |
| 6 | Stop Sell | `/rates` → sale-state close, Group Update | same; every value carries `stop_sell` | `incremental_sync` | 1 | PENDING | PENDING (1) | PENDING |
| 7 | Combined restrictions (CTA/CTD/min/max) | `/rates` → Group Update, mixed restrictions over ranges | same restrictions path | `incremental_sync` | 1 | PENDING | PENDING (1) | PENDING |
| 8 | Half-year update | `/rates` → Group Update over ~180-day range | same; long range compresses | `incremental_sync` | 1 | PENDING | PENDING (1) | PENDING |
| 9 | Single-date availability (via booking) | `/reservations` → create/edit/cancel a reservation | `reservations/actions.ts markAriDirty(availability)` → `ari-sync.ts:618 drainAriDirtyRanges` → `channex-ari.ts:85 pushAri` (`POST /availability`) | `incremental_sync` (availability) | 1–2 (0/1 model) | PENDING | PENDING | PENDING (booking) |
| 10 | Multi-date availability | `/reservations` → multi-night reservation / closure | same; consecutive days compressed | `incremental_sync` (availability) | 1–2 | PENDING | PENDING | PENDING |
| 11 | Booking receiving (new/modify/cancel + ACK) | Inbound: Booking.com test account → else Booking CRS injector | `webhook/[token]` → worker `runInboundPull` → `booking-import.ts` → `channex-bookings.ts:125 acknowledgeBookingRevision` (after commit; gated by `revisions.ts:247 markRevisionAcknowledged`) | `inbound_new` / `inbound_modify` / `inbound_cancel` / `booking_ack` | per revision (ACK strictly after commit) | PENDING | PENDING (revision + ACK IDs) | PENDING |

---

## Evidence currently in the package (`assets/`)

| Artifact | What it proves |
|---|---|
| `assets/check-outputs.log` | All Channex certification gates **PASS** offline — one send seam, "1 call" batching, exactly-2 Full Sync, 429 circuit breaker, environment routing, production guard, evidence-ledger shape, booking-receiving flow. Captured 2026-07-19 on branch `main`. |

## How to fill the PENDING cells (live run)

1. Provision `Test Property - GuestHub` on Channex Staging (`DECISIONS.md` D-2); record UUIDs in `01-cover.md`.
2. Execute scenarios 1–11 from the PMS UI per `docs/channex/CERTIFICATION_RUNBOOK.md`.
3. Read Task IDs from the `/channels` certification console (the ledger); capture per-scenario screenshots into `assets/`.
4. Replace each PENDING cell with the ledger `task_ids` value, the execution date, and the screenshot path.

> Traceability guarantee: `check:channex-certification` fails CI unless every firing
> file named above exists, and the ledger stamps the same `firing_file`/`firing_function`
> per execution — so these rows cannot drift from the code that actually sends.
