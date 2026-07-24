# Beds24 completion plan — prioritized, awaiting owner approval

**Status: PLAN ONLY. Nothing below is built. Every item needs an explicit owner
go-ahead before any code is written.** Grounded in the 2026-07-24 read-only
audit: live token introspection (`GET /authentication/details`), a file-by-file
code capability map, and the public API v2 surface (OpenAPI spec
`beds24.com/api/v2/apiV2.yaml` + wiki). Card-data endpoints and scopes are
**excluded throughout per D108** and stay excluded in every item below.

## Where we stand (audited facts)

- **API v2**, token-header auth, 24h access tokens cached+encrypted (minting
  costs credits), refresh token held encrypted. Live token scopes:
  `all:bookings, all:bookings-personal, all:bookings-financial, all:inventory,
  all:properties, all:accounts, all:channels`, whole-account
  (`linkedProperties=false`) — **materially over-scoped** for today's workload
  (poll + ARI push use roughly the `read:` halves plus `write:inventory`).
- **Inbound**: poll-only, ~5-min floor inside 20s worker ticks, 7-day
  modifiedFrom overlap, synthetic revision ids, pre-acknowledged rows (Beds24
  has no ack endpoint), quarantine + bounded self-healing sweep. No circuit
  breaker on this path.
- **Outbound**: single endpoint `POST /inventory/rooms/calendar` — numAvail
  (0|1), one base-occupancy `price1`, minStay/maxStay; stop-sell expressed as
  numAvail:0; fail-closed on unpriceable dates. CTA/CTD are NOT pushed (the
  calendar shape has no such fields). 500-day horizon, past-date clamp live.
- **Credits**: 100 credits / rolling 5 min / account, dynamic per-request cost,
  headers `X-FiveMinCreditLimit*` + `X-RequestCost` (worker already reads
  remaining); +10 EUR/month doubles the budget.
- **Guards**: `check:beds24-{connection,jobs,revisions,ari}` land with this PR
  (read-only, DB-backed). The deeper fixture-based integration guards (fake
  Beds24 API + disposable DB) remain open — item P0-2.

## P0 — truth and safety (small, low-risk, do first)

| # | Item | Why | Effort | Risk |
|---|------|-----|--------|------|
| P0-1 | **Stale-header sweep**: `revisions.ts` ("no live poller calls these yet"), `queue.ts` ("nothing runs, nothing talks to a provider"), `evidence.ts` ("inbound acknowledgement path") all describe a pre-D68/D78 world and mislead every reader today | Comments-only fix; zero runtime change | S | none |
| P0-2 | **Fixture-based integration guards**: fake Beds24 HTTP + disposable DB covering the ARI drain, inbound import, cancellation, quarantine-self-heal paths (the INVENTORY doc's own coverage note) | The live revenue paths still have no behavioral test; the new check:beds24-* scripts watch production health, not logic | M | none (test-only) |
| P0-3 | **Calendar read-back reconciliation**: periodic `GET /inventory/rooms/calendar` diffed against our projection; wire the dormant `reconcile_inventory` job type; alert on drift | Today nothing detects Beds24 holding stale ARI (the overbooking recipe); read-only API call | M | low — read-only; credit cost must be measured (X-RequestCost) |
| P0-4 | **Credit-window backoff**: use `X-FiveMinCreditLimit-ResetsIn` to pace the worker when Remaining runs low; surface credits in /channels diagnostics | One 429-storm today = blind retries; headers are already parsed in beds24-http | S | none |

## P1 — inbound latency (webhook-as-trigger)

| # | Item | Why | Effort | Risk |
|---|------|-----|--------|------|
| P1-1 | **Booking webhook → targeted pull**: panel-configured per-property webhook (Alpha) hitting a GuestHub endpoint that only ENQUEUES the existing targeted-pull path (`booking_id` fast path is already staged in code, `generateWebhookToken` helper exists); poll relaxes to 15–30 min as the reconciliation net | New OTA bookings land in seconds instead of ≤5 min; cuts polling credit spend; wiki Best Practices explicitly recommends it | M | Alpha maturity; no HMAC signing documented → payload treated as untrusted trigger only, auth via opaque token header; per-property enablement is an onboarding footgun (checklist item) |
| P1-2 | *(optional)* **Inventory webhook** (`SYNC_ROOM`, documented 30-min retries) as a second trigger for inventory-driven re-syncs | Complements P1-1; restriction changes do NOT fire it (documented) | S | low |

## P2 — guest experience

| # | Item | Why | Effort | Risk |
|---|------|-----|--------|------|
| P2-1 | **OTA unified inbox**: `GET/POST/PATCH /bookings/messages` surfaced in the communications screen (read threads, reply, mark read; message kinds guest/host/internalNote/system) | Guest messages from OTAs currently live only in the OTA extranets; scope (`all:bookings-personal`) already present | L | OTA-bookings-only coverage (not direct bookings); needs its own poll/webhook cadence and credit budget |
| P2-2 | **Booking.com operational actions**: `reportNoShow`, `reportCancel`, `reportInvalidCard` (`POST /channels/booking`) wired to the existing cancellation flow (which already models an `invalid_card` origin). These are OTA status reports — **no card data is involved** | Closes the loop the manual extranet steps cover today | M | needs `all:channels` (present); misuse can affect OTA state — operator-confirmed actions only |

## P3 — two-way booking sync (biggest design decision)

| # | Item | Why | Effort | Risk |
|---|------|-----|--------|------|
| P3-1 | **Push GuestHub-originated bookings into Beds24** (`POST /bookings`, bulk array semantics): direct/website reservations appear in the Beds24 calendar as bookings, not just as consumed availability | Single pane of glass in Beds24; more robust OTA closure than pure numAvail | L | **Echo-loop hazard**: our own pushed booking returns through the 5-min pull as a "new" revision — needs apiReference/system-marker dedup designed BEFORE any code; financial-field ownership must stay one-way; write scope already present |
| P3-2 | **Decision item — token scope narrowing**: scopes are fixed at invite-code creation; narrowing means issuing a new invite code. Minimal set for today: `read:bookings(+personal,+financial) + all:inventory + read:properties`. Keeping `all:bookings` is justified only by P3-1; `all:accounts` / `all:properties` (write) / most of `all:channels` have no current or planned use | Least-privilege vs. the cost of re-issuing when P1–P3 land; an owner call, documented either way | S | none (decision + one re-auth cycle) |

## P4 — housekeeping

| # | Item | Why | Effort | Risk |
|---|------|-----|--------|------|
| P4-1 | **Legacy row cleanup**: paused channex/hospitable `channel_connections` rows + their 66 inert non-synced dirty ranges (surfaced informationally by check:beds24-ari) | Dead rows that every operator query must mentally filter | S | needs a small migration (data delete) — deliberate, separately approved |
| P4-2 | **055 candidate**: rename channex-named indexes/constraints (`uq_*_channex_*`, 023's `chk_*`) and the `channel_inbound_rate_plan_aliases.source` value `'channex_verified'` | Post-054, the last places `channex` appears in the live catalog; names only | S | rename-only; the source VALUE change touches data semantics — needs its own review |
| P4-3 | **Heartbeat nuance**: `last_drain_at` advances only when sentValues > 0, so a quiet healthy system shows a stale "last drain" in /channels | Observability truthfulness | S | none |
| P4-4 | **Inbound/full-sync circuit breaker**: the breaker currently guards only the incremental drain; full sync relies on pacing + request cap, inbound has none | Symmetric protection against provider outages | M | low |
| P4-5 | **card-ingest.ts** dead-code decision (pre-existing candidate, outside D91) | Keep-or-delete call for the owner | S | none |

## Explicitly out of scope

- **Anything card-data** (endpoints, scopes, payload fields) — D108. The token
  carries no card scope and none will be requested or mapped.
- `POST /properties` / `POST /accounts` writes — account-admin blast radius,
  no identified need.
- PSP work (Cardcom/Tranzila) — separate track on `wip/psp-beds24`.

## Suggested order if everything is approved

P0-1 → P0-4 → P0-2 → P0-3 → P1-1 (+P1-2) → P3-2 (decide scopes before new
surface area) → P2-2 → P2-1 → P3-1 → P4-*.
