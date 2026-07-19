# 03 — Declarations · Items 12–14 (written form answers)

These are the written answers for the certification form's declaration items. Each
answer is backed by a named file + function and a passing `check:channex-*` gate.

---

## Item 12 — Rate-limit compliance

**Q: How does your integration respect Channex's ARI rate limits and handle HTTP 429?**

GuestHub respects Channex's documented ARI limits — **20 ARI requests / minute / property**
(10 restrictions+price, 10 availability), rolling per-minute window. Outbound ARI is not
sent from a request handler; it is drained by a single PM2 worker that paces requests
below the budget (Full Sync paces ~6.5 s between requests, ≤ 6 batches per kind).

On **HTTP 429**, the client reads the `Retry-After` header and a connection-level
**circuit breaker** opens for exactly that cooldown (falling back to a base cooldown when
the header is absent), then half-opens to test recovery. Repeated server/transport
failures also trip the breaker with an exponential, capped cooldown. The cooldown is
**persisted on the connection** (`circuit_open_until`, `consecutive_failures`), so it
survives a worker restart; dirty ranges stay pending and drain after the cooldown — an
update is **never silently dropped**.

There is **no periodic or timer-based Full Sync anywhere** — a full sync is
operator-triggered only. Between full syncs GuestHub sends deltas only (see item 13).

- **Files:** `src/lib/channel/circuit-breaker.ts`, `src/lib/channel/channex-http.ts`,
  gating the drain in `src/lib/channel/ari-sync.ts`; migration `db/migrations/039_*`
  (persistent breaker columns).
- **Verified by:** `check:channex-rate-limit-cooldown` (PASS — see `assets/check-outputs.log`).

---

## Item 13 — Update logic (delta-only)

**Q: After the initial Full Sync, how do you send updates — full re-syncs or deltas?**

**Deltas only.** After the initial Full Sync (exactly **500 property-local dates in
exactly two requests** — one availability, one rates/restrictions), GuestHub sends only
what changed:

1. Every canonical save (rate, restriction, availability) calls **`markAriDirty`**
   (`src/lib/channel/outbox.ts:41`) **inside the same DB transaction** as the business
   write, recording the affected `(room × plan × date)` ranges into the coalescing outbox
   `channel_dirty_ranges` and enqueuing one deduplicated `sync_ari_range` job.
2. The worker's **`drainAriDirtyRanges`** (`src/lib/channel/ari-sync.ts:618`) unions the
   pending spans, runs the canonical `projectAri` projection (shared verbatim with the
   pricing engine), and sends **one combined `POST /availability` + one combined
   restrictions call** — so a Group Update over many rooms/plans/dates collapses to
   **one API call per dimension** (tests 3–8), not one call per cell.

There is **no timer-driven or periodic full re-sync**; a full sync is operator-triggered
from `/channels` only. Incremental ARI is structurally impossible before a clean initial
Full Sync (`check:channex-ari` assertion 47).

- **Exact firing point for delta sends:** `sendBatches` → `pushAri`
  (`src/lib/channel/channex-ari.ts:85`), the single ARI seam.
- **Verified by:** `check:channex-full-sync-two-requests` and
  `check:channex-group-update-batching` (both PASS).

---

## Item 14 — Extra notes (supported features)

**(a) Minimum Stay — Arrival vs Through.** GuestHub supports **both** as first-class,
independently-editable restrictions in its Rate Grid and Group Update.
`min_stay_arrival` is the primary minimum-stay (always sent, floored by the rate plan's
`default_min_stay`); `min_stay_through` is optional and sent **only when the operator
sets it**. Both map **1:1** to the Channex `min_stay_arrival` / `min_stay_through`
fields with no transformation (`src/lib/channel/ari-projection.ts`,
`src/lib/channel/ari-payloads.ts`; `docs/channex/MIN_STAY_SEMANTICS.md`).

**(b) Supported restrictions.** Rate/price, availability, `stop_sell`, `min_stay_arrival`,
`min_stay_through`, `closed_to_arrival` (CTA), `closed_to_departure` (CTD), and max-stay
are supported and emitted via the single restrictions payload. Each field is included
only when non-null (`buildRestrictionValues`, `ari-payloads.ts:184`).

**(c) Multiple room types / rate plans.** Fully supported. Each physical room maps to one
Channex Room Type (`count_of_rooms = 1`, D64); each `(room × local plan)` maps to one
Channex Rate Plan (D65), tracked in `channel_room_mappings` / `channel_room_rate_mappings`.

**(d) Credit-card details.** OTA bookings that carry card data are handled at the inbound
boundary: the **PAN is encrypted before the event is redacted and the CVV is discarded** —
GuestHub **never stores CVV** (CVV column dropped entirely, migration 018 / D52). The card
`/pci` endpoints are never called from the booking client.

**(e) PCI posture.** GuestHub does not transmit raw card data to Channex and does not act
as a card processor in this flow; card handling follows the tokenization boundaries in
`docs/payments/`. All certification traffic is Staging-only; Production is guarded and
inactive (`check:production-activation-guard` — PASS).

- **Verified by:** `check:channex-group-update-batching` (min-stay fields survive
  projection→payload), `check:channex-environment-routing`, `check:production-activation-guard`.
