# Channex PMS Certification — Versioned Requirements Document

**Accessed:** 2026-07-18 (live fetch from docs.channex.io)
**Sources:**
- https://docs.channex.io/api-v.1-documentation/pms-certification-tests.md
- https://docs.channex.io/api-v.1-documentation/rate-limits.md
- https://docs.channex.io/guides/best-practices-guide.md
- Index: https://docs.channex.io/llms.txt

**Program rule (V2 §4):** the certification test tables change periodically. This document is the captured snapshot for the program; it must be refreshed at Stage 4 entry and Stage 7 entry, and the values below re-verified live before any certification run. Never hardcode these values into product code.

---

## 1. The official multi-stage certification process

| Stage | What happens |
|---|---|
| 1. Integration build | Build against Channex Staging; real ARI changes must propagate from the PMS UI to Channex automatically. Complete the pre-flight checklist before advancing. |
| 2. Test execution | Configure the staging property per spec; perform each scenario by triggering actions in the PMS UI; record Task IDs from Channex responses. Data must look like a real hotel (varied prices/inventory/restrictions), not uniform placeholders. |
| 3. Form submission | Submit the Google certification form (https://forms.gle/xA8F3eSYBPBd8apYA) with Task IDs and answers to the Extra Notes questions. Synthetic-looking data triggers rejection before stage 4. |
| 4. **Live screenshare review** | Channex watches the shared screen while actions — some from the tests, some **ad-hoc arbitrary changes** — are performed in the real PMS. Reviewers verify API calls fire from the real update paths and examine queue logic, retries and the mapping layer. Failing restarts from stage 1. |
| 5. Production access | Production credentials granted after passing stage 4. |

## 2. Official pre-flight checklist (all must be "yes"; last two need file paths)

1. When a user saves a price change in the PMS UI, does the code emit a domain event / database change observed by the integration layer?
2. Is there an outbox/queue between the PMS and the Channex client (not a direct API call from the save handler)?
3. On 429, does retry logic back off (not silently drop the update)?
4. Where in the codebase is `POST /availability` called? (file + line)
5. If all certification-specific code were deleted, would the PMS still push updates to Channex correctly?

Required infrastructure: event-based change detection (not DB polling loops), outbox/queue with batching respecting rate limits, retry/backoff for 429 and 5xx, webhook endpoint with acknowledgement flow, mapping layer (internal IDs ↔ Channex UUIDs).

## 3. Officially rejected anti-patterns (fail even with valid Task IDs)

- Standalone script / CLI / Postman collection posting the table values.
- A "certification UI" built solely to trigger the test events.
- Full sync on a timer instead of delta updates on change events.
- Per-date or per-rate API calls where the test specifies one call.
- Hardcoded UUIDs or values copied from the documentation into product code paths.
- Integration logic living in test files instead of the main PMS codebase.

## 4. Test property setup (staging)

- Property: `Test Property - GuestHub`, currency **USD**.
- Room Types (occupancy 2 each): **Twin Room**, **Double Room**.
- Rate Plans (4): Twin/BAR $100, Twin/B&B $120, Double/BAR $100, Double/B&B $120.
- **Vacation-rental adaptation (official):** a product that models one unit / one price per unit may configure the staging property to mirror its actual data model; every adapted test is noted in the certification form. GuestHub interpretation (D64 model, one physical room per Room Type, `count_of_rooms=1`): Open = 1, Sold/blocked = 0, cancellation/release = 1. Tests using availability 8 are adapted accordingly and the adaptation recorded in the form notes.
- **Realistic-data requirement:** before the certification Full Sync the property must carry varied prices/min-stay/restrictions across the 500-day window and availability changes from real test reservations. Uniform data is flagged as synthetic.

## 5. Scenario table (snapshot of 2026-07-18 — re-verify live at Stage 4/7)

Tests 1–11 are **executable scenarios** (triggered only from the normal PMS UI). Items 12–14 are **declarations**.

| # | Title | Official test data (snapshot) | Expected calls | Evidence |
|---|---|---|---|---|
| 1 | Full Sync (500 days, all rooms+plans) | Varied, realistic values | **Exactly 2**: one `POST /availability`, one rates+restrictions update | Task IDs |
| 2 | Single date, single rate | Twin/BAR 22 Nov 2026 → $333 | 1 | Task ID |
| 3 | Single dates, multiple rates | Twin/BAR 21 Nov $333; Double/BAR 25 Nov $444; Double/B&B 29 Nov $456.23 | **1 batched** | Task ID |
| 4 | Date ranges, multiple rates | Twin/BAR 1–10 Nov $241; Double/BAR 10–16 Nov $312.66; Double/B&B 1–20 Nov $111 | 1 | Task ID |
| 5 | Min Stay | Twin/BAR 23 Nov→3; Double/BAR 25 Nov→2; Double/B&B 15 Nov→5 | 1 | Task ID |
| 6 | Stop Sell | Twin/BAR 14 Nov; Double/BAR 16 Nov; Double/B&B 20 Nov → true | 1 | Task ID |
| 7 | Combined restrictions | 4 rows mixing CTA/CTD/min-stay/max-stay over ranges (see source page) | 1 | Task ID |
| 8 | Half-year update | Twin/BAR & Double/BAR 1 Dec 2026–1 May 2027, rate+restrictions | 1 | Task ID |
| 9 | Single-date availability via booking | Booking in PMS: Twin 21 Nov 8→7; Double 25 Nov 1→0 | 1–2 | Task IDs + PMS booking screenshots |
| 10 | Multi-date availability | Twin 10–16 Nov→3; Double 17–24 Nov→4 | 1–2 | Task IDs |
| 11 | Booking receiving | Booking.com test account (preferred) or Booking CRS app: create → modify → cancel; ACK each; use `booking_revisions` feed endpoints, never plain `bookings` listing; prefer webhooks | — | Booking IDs + PMS screenshots |
| 12 | Rate limits (declaration) | Confirm limits respected; queue/limiter required | — | Written answer |
| 13 | Update logic (declaration) | Delta-only updates; no timer-based full sync; full sync ≤ once/24h, off-peak, only when required | — | Written answer |
| 14 | Extra notes (declarations) | (a) Min Stay Arrival vs Through — which supported; (b) unsupported restrictions; (c) multiple room types / rate plans support; (d) credit-card details required?; (e) PCI certified or PCI service? | — | Written answers |

GuestHub availability-value adaptation for tests 9–10: single-unit model → values become 1→0 (booking) and 0/1 per unit; recorded in form notes per §4.

## 6. Rate limits (official snapshot, 2026-07-18)

- **20 ARI requests per minute total**, per property (not per API key).
- Breakdown: 10/min restrictions+price requests, 10/min availability requests.
- Rolling per-minute window; excess requests are not handled until the window expires; HTTP 429 `http_too_many_requests`.
- **Payload limit: 10 MB per JSON call**; no documented limit on change count inside one message. Batch aggressively ("one message with 100 changes instead of 100 messages"); messages are processed sequentially (FIFO).
- Recommended: queue+batch (e.g. one combined call every ~6s), throttling, exponential backoff (~1-minute pause after 429).
- `x-api-key` header on all requests.

## 7. Booking flow requirements

- Retrieve bookings via the **booking revisions feed** endpoints only — never the plain bookings listing.
- **ACK only after the booking is successfully saved locally** (prevents resend/duplicates).
- Prefer webhooks for change notification; V2 §17 additionally mandates a polling fallback (every 15–20 min per official guidance) so a failed webhook cannot lose a booking.
- Per-property API keys are the recommended strategy for self-hosted systems.

## 8. Known limitations / open items to re-verify at Stage 4

- The rate-limits page did not state property-count or size limits beyond the 10 MB payload cap; property-size limits and revision retention periods must be re-checked live at Stage 4 entry (the best-practices snapshot did not state retention numbers; operational observation D76: the feed served revisions for ~30 min in one incident — treat retention as short).
- The certification-form questions (Extra Notes) are answered from what the integration actually does; GuestHub's Min Stay semantics must be determined from code (Stage 1 pricing audit) and declared accordingly in Stage 4.
- Test-table dates (Nov 2026 / Dec 2026–May 2027) are the current snapshot; they roll forward periodically.

## 9. Mapping to program stages

- Stage 3 builds: canonical rate/inventory services, transactional dirty-range marking, generic sync outbox (pre-flight items 1–2).
- Stage 4 builds: Channex wiring, batching envelopes (tests 2–10 "1 call" semantics), 429/5xx cooldown + circuit breaker (item 12–13), evidence ledger with Task IDs, booking receiving flow (test 11), declarations (12–14), screenshare rehearsal.
