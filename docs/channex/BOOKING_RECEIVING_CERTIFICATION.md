# Booking-receiving certification workflow (§17)

**Status:** flow built + hardened; live execution pending a Channex Staging test channel (external dependency, V2 §2). · **Last reviewed:** 2026-07-18

Channex certifies that a PMS receives OTA bookings correctly by delivering real
new / modified / cancelled booking revisions to the PMS and checking they land,
are acknowledged, and are visible. This document is the runbook for that test and
records the identifiers/evidence it produces.

## Canonical inbound flow (what is being certified)

1. **Webhook** (`/api/channel/webhook/[token]`) — Channex calls it on a new
   revision. It authenticates by hashed per-connection token, persists a redacted
   event, dedupes, and enqueues a `pull_booking_revisions` job. It never mutates a
   booking inline.
2. **Feed pull** (`GET /booking_revisions/feed?filter[property_id]=…`) — the
   worker pulls **unacknowledged revisions only, oldest first**. This is the sole
   source of truth; the webhook is only a wake signal, and a low-frequency
   fallback poll covers a missed webhook (a booking can never be lost).
3. **Import** (`booking-import.ts`) — each revision is normalized and imported in
   ONE transaction: `new` → create, `modified` → update the same reservation,
   `cancelled` → cancel (never delete). Unmapped room / mismatched plan /
   conflicting dates / normalize failure → **persist-then-quarantine** (visible,
   never lost). Unknown external rate plan → quarantine then self-heal via alias
   adoption (D78).
4. **Acknowledge** (`POST /booking_revisions/:id/ack`) — sent **only after** the
   import transaction commits; the `import_status='imported'` WHERE clause in
   `markRevisionAcknowledged` is the structural backstop. A failed ack leaves the
   booking imported + unacknowledged and is retried on the next pull.
5. **Recovery** — `GET /booking_revisions/:id` / `GET /bookings/:id` for
   controlled recovery by id only; never a blind re-pull.

## Test channel: Booking.com (preferred) → Booking CRS (fallback)

- **Preferred:** a Booking.com test property connected to the Channex Staging
  property, generating real new/modify/cancel revisions. Requires a Booking.com
  test account on the Channex Staging connection (external dependency).
- **Documented fallback:** the **Booking CRS** test tool in Channex Staging,
  which injects synthetic new/modify/cancel revisions into the feed for the
  property — no OTA account required. This is the path used when a Booking.com
  test account is unavailable.

## Scenarios + evidence to capture (per revision)

| # | Scenario | Expected result | Evidence |
|---|---|---|---|
| B1 | New booking | one reservation on the mapped room; ACK sent | revision id, reservation number, ACK task, screenshot |
| B2 | Modified (dates/occupancy/amount) | same reservation updated; old room released; ACK | revision id, before/after, screenshot |
| B3 | Cancelled | same reservation cancelled (not deleted); room freed; ACK | revision id, status, screenshot |
| B4 | Unmapped room | visible quarantine, no guessed room | revision id, quarantine reason |
| B5 | Redelivered revision | zero duplicates | revision id, single reservation |

Each executed scenario is recorded in the **evidence ledger**
(`channel_evidence_ledger`, scenario_key `inbound_new`/`inbound_modify`/
`inbound_cancel`/`booking_ack`) with the Channex revision id, the firing file +
function, and the ACK task — visible in the read-only certification console.

## Live-execution blocker (V2 §2)

The flow, hardening (`check:channel-security`), resilience
(`check:channel-chaos`) and pipeline shape (`check:channex-booking-crs-flow`) are
built and verified offline. Executing B1–B5 against live Channex Staging requires
a connected Booking.com test account or the Booking CRS test tool on the Staging
connection — an external dependency. When available: run each scenario through the
real UI, capture the identifiers/screenshots above, and attach them here.

## Verified by

`check:channex-booking-crs-flow` (pipeline shape + this runbook), plus the
functional DB suite `check:inbound-bookings` (235 assertions covering
new/modify/cancel, dedup, ack-after-commit, quarantine, alias, tenant isolation).
