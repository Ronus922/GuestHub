# Channex Certification — Screenshare Demo Script

- **Status:** Complete draft — Stage 4; rehearsed in **Stage 7** (live)
- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Sources:** `PMS_CERTIFICATION_REQUIREMENTS.md` §1, `CERTIFICATION_SCENARIO_MATRIX.md`, `CHANNEX_CERTIFICATION_MAPPING.md`

The narrated script for the live screenshare, where Channex reviewers watch real
PMS actions — some scripted, some **ad-hoc arbitrary** — and confirm each Channex
call fires from the real update path. Rule: *"If the Channex call doesn't fire
from your real update path, you don't pass."* Everything below is driven from the
production surfaces (`/rates`, `/reservations`, `/calendar`, `/channels`); there
is no certification-only UI, and `check:channex-ari` proves at source level that
no other module can send ARI.

## 0 · Setup (before the call)

- Certification tenant logged in as super_admin; `/channels` shows the Staging
  connection **active**, property mapped, rooms + rate plans mapped.
- Two browser tabs: **(A)** the operator surface being demonstrated; **(B)**
  `/channels` → the read-only **certification console** (evidence ledger) to show
  Task IDs appearing live.
- One terminal (optional) tailing the PM2 channel worker log for the queue view.
- Confirm production is inactive: console shows "סביבה פעילה: staging",
  "production כבוי (guard)".

## 1 · Opening (≈60s) — the architecture in one breath

> "Every rate, restriction and availability change in GuestHub is written
> canonically in one transaction that also marks the affected room×plan×date
> ranges dirty (`markAriDirty`). A durable outbox (`channel_dirty_ranges`) feeds
> a job queue; the PM2 worker drains it through a single seam (`pushAri`) to
> Channex. There is exactly one send path — no cron, no request-path send, no
> test bypass. I'll show each action, the dirty range, the queued job, and the
> Task ID landing in the evidence ledger."

Point at: the seam diagram in `ARI_SYNC_FLOW.md`.

## 2 · Scripted walkthrough

For EACH action: perform the save in tab A → switch to tab B and refresh the
console → point at the new evidence row (scenario, request count vs expected,
Task IDs, firing file+function).

| Step | Action (tab A) | What to point at | Matrix test |
|---|---|---|---|
| 2.1 | `/channels` → "סנכרון מלא" (Full Sync) | evidence row `full_sync`, **2 requests**, Task IDs; console shows 500-day range | 1 |
| 2.2 | `/rates` → edit one cell, save | `incremental_sync` row, 1 request, Task ID; dirty range appeared then cleared | 2 |
| 2.3 | `/rates` → Group Update: 3 rooms × 2 plans, a date range, weekday chips, a min-stay + stop-sell | **one combined** request, Task ID | 3–8 |
| 2.4 | `/reservations` → create a booking on a mapped room | `availability` request (0/1 model), Task ID | 9 |
| 2.5 | `/reservations` → extend it to multi-night, then cancel | availability requests; room re-opens | 10 |
| 2.6 | (inbound) trigger a Booking.com/CRS test revision | booking imported, `booking_ack` evidence, ACK after commit | 11 |

## 3 · Ad-hoc / arbitrary changes (reviewer-driven)

Invite the reviewer to name **any** room, plan, date range and value. Perform it
in `/rates` Group Update or a reservation. Narrate:

> "This is an arbitrary value you just chose — watch it fire from the same path."

Show the same evidence row appears with their value's Task ID. This proves the
arbitrary-value capability and that nothing is pre-canned (also asserted by
`check:channex-certification`).

## 4 · Queue / retry / mapping talking points

- **Queue:** show a dirty range → queued job → worker drain → `synced`. FIFO per
  connection; duplicate enqueue is a DB no-op.
- **Retry / rate-limit:** describe the circuit breaker — a 429 opens a cooldown
  for the provider's `Retry-After`; ranges stay pending and drain after
  (`check:channex-rate-limit-cooldown`).
- **Mapping:** show `/channels` room-type + rate-plan mapping (physical room →
  one Channex Room Type, count_of_rooms=1; local plan×room → one Channex Rate
  Plan).
- **One seam:** note that `check:channex-ari` forbids any other module from
  sending ARI.

## 5 · Evidence ledger close

Show the console's per-scenario roll-up: each certification test with its Task-ID
count and pass status, and each row's firing file+function — the form entry and
the running code are the same path.

## 6 · Stage-7 rehearsal notes

- Target length ≈ 12–15 min; 2.x is the core, keep 1 and 4 tight.
- Pre-seed varied realistic data (multiple room types, seasons, weekend pricing)
  so Group Update compression is visible but stays one request.
- Dry-run the tab-switch cadence; have the console pre-opened.
- Failure recovery: if a call errors live, show it landing as a `failed`/`partial`
  evidence row + the range staying retryable — honesty is part of passing.
- **Live dependency:** steps that hit Channex Staging require the active Staging
  connection + (2.6) a Booking.com test account or the Booking CRS tool (V2 §2).
