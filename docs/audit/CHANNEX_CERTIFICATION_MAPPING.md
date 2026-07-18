# Channex PMS Certification — Requirement Mapping (Agent D)

- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Scope:** read-only audit of `/var/www/guesthub` against the CURRENT official Channex certification documentation. No API calls were made; documentation fetched live.

## Documentation version (fetched 2026-07-18)

| Source | URL |
|---|---|
| Index | `https://docs.channex.io/llms.txt` |
| PMS Certification Tests | `https://docs.channex.io/api-v.1-documentation/pms-certification-tests.md` |
| Best Practices Guide | `https://docs.channex.io/guides/best-practices-guide.md` |
| Rate Limits | `https://docs.channex.io/api-v.1-documentation/rate-limits.md` |
| PMS Integration Guide (referenced) | `https://docs.channex.io/guides/pms-integration-guide.md` |

Key documented figures: **10 availability req/min/property + 10 restrictions req/min/property (20 ARI/min total)**; 429 = `http_too_many_requests`, guidance "pause updates for the property for 1 minute and try again"; payload cap **10 MB per JSON call**; Feed API: *acknowledge only when you have successfully saved the booking*. Certification stage 4 is a live screenshare: *"If the Channex call doesn't fire from your real update path, you don't pass."*

---

## 1. Scenario-by-scenario mapping (executable tests 1–11)

Legend for "code that fires the call": every outbound ARI request goes through exactly one seam — `pushAri()` in `src/lib/channel/channex-ari.ts` (POST `/availability` | POST `/restrictions`), invoked only by `sendBatches()` in `src/lib/channel/ari-sync.ts`, which is invoked only by the PM2 channel worker (`src/lib/channel/worker.ts`, `scripts/channel-worker.cjs`).

| # | Test (as documented) | Normal PMS UI workflow that triggers it | Code path (file → function) | Expected requests vs. actual | Task-ID capture today | DB evidence today | Automated test | Manual steps |
|---|---|---|---|---|---|---|---|---|
| 1 | **Full Data Update** — 500 days of availability + rates + restrictions in **2 calls** (1 availability, 1 restrictions) | `/channels` → operator "סנכרון מלא" button (operator-gated, D68/D69) | `src/lib/channel/admin.ts` `requestFullSync` (enqueues `full_sync` job, idempotency `full_sync:<conn>`) → worker `runJob` → `src/lib/channel/ari-sync.ts` `runInitialFullSync` → `sendBatches` → `pushAri` | Doc: 2. Code: **1–6 per kind** (batches of ≤1000 values, `MAX_VALUES_PER_PAYLOAD`, run cap `MAX_REQUESTS_PER_KIND_PER_RUN=6`). Empirically exactly 2 (snapshot: all 5 succeeded `full_sync` jobs carry exactly 2 `task_ids`) because per-room / per-combo run-length compression keeps values ≪1000 | **Yes** — `channel_sync_jobs.provider_task_id` + `payload.task_ids[]` (ari-sync.ts:436-448) | `channel_sync_jobs` row (date_from/date_to, `payload.progress` milestones, task_ids); `channel_sync_errors` on warnings | `scripts/check-channex-ari.mjs`, `scripts/check-channel-worker.mjs`, `scripts/check-channels-fullsync-ui.mjs` | Log in as super-admin, open `/channels`, run Full Sync, read task IDs from the job row |
| 2 | **Single date / single rate** (Twin BAR → 333 on one date) | `/rates` grid — edit one cell price, save | `src/app/(dashboard)/rates/actions.ts` → `src/lib/rates/service.ts:177` `markAriDirty` (same tx as the save) → `channel_dirty_ranges` → worker `drainAriDirtyRanges` → 1 POST `/restrictions` | 1 — achieved (drain sends only the affected room×plan×date; `coveredBy` filter) | **NO** — drain collects `taskIds` in `SendOutcome` but never persists them; `completeChannelJob` called without `providerTaskId` (worker.ts:134-136). Snapshot: 136 succeeded `sync_ari_range` jobs, **0** with `provider_task_id` | `channel_dirty_ranges` (status synced), `channel_sync_jobs` (`sync_ari_range`, no task id), `channel_connections.last_outbound_sync_at` | check-channel-worker.mjs ("only the AFFECTED rooms/plans/dates are sent") | Edit the cell, wait ≤20 s (worker tick / NOTIFY wake), task ID currently only visible in Channex UI — **gap** |
| 3 | **Single date, multiple rates in 1 batched call** | `/rates` Group Update across 3 plans/rooms, one save | Same as #2; one save writes several dirty ranges in one tx; one drain claims them all and `buildRestrictionValues` (ari-payloads.ts) emits one batch | 1 — achieved **if entered as one Group Update** (or several saves within one worker sleep; coalescing + single drain). Separate saves across ticks → >1 call | NO (same gap as #2) | as #2 | check-channex-ari.mjs (batching), check-channel-worker.mjs | Use one Group Update for all three combos; do not spread saves across minutes |
| 4 | **Multi-date, multiple rates in 1 call** | `/rates` Group Update with date ranges (D93 datepicker) | Same path; date ranges become `[from,to)` dirty ranges; payload compression collapses identical consecutive days into inclusive `date_from/date_to` ranges | 1 — achieved | NO | as #2 | same | One Group Update covering the three ranges |
| 5 | **Min-stay update in 1 call** | `/rates` editor / Group Update — `min_stay_arrival` (also supports `min_stay_through`) fields (rates/actions.ts:53-56,138-143) | Same restrictions path; values carried by `ari-projection.ts` (plan defaults + per-date overrides, lines 417-425) | 1 — achieved | NO | as #2 | check-channex-ari.mjs asserts restriction fields survive the projection | One Group Update setting min-stay on the three combos |
| 6 | **Stop-sell update in 1 call** | `/rates` sale-state open/close (two-way, D75/PR #10) | Same restrictions path; every emitted value always carries `stop_sell` (ari-payloads.ts invariant; blocked cell = stop_sell **without** rates, never price 0) | 1 — achieved | NO | as #2 | check-channex-ari.mjs (fail-closed rate handling) | Close the three combos in one action |
| 7 | **Multiple restrictions (CTA/CTD/min/max) in 1 call** | `/rates` editor — `closed_to_arrival`, `closed_to_departure`, `max_stay`, min-stay all editable | Same restrictions path | 1 — achieved | NO | as #2 | check-channex-ari.mjs | One Group Update per the documented 4-range matrix |
| 8 | **Half-year update (Dec 2026–May 2027) in 1 call** | `/rates` Group Update over the long range (writable-horizon clamp, D93; horizon = 500 days so the range is writable) | Same path; ~180 days × 2 combos compresses to few values — one batch | 1 — achieved | NO | as #2 | same | Single Group Update, both room types |
| 9 | **Single-date availability update (booking event; Twin→7, Double→0)** | Create / edit / cancel a reservation (global BookingPanel, D48) or room status change | `src/app/(dashboard)/reservations/actions.ts` (:300,:592,:714,:906) / `rooms/actions.ts:279` / `calendar/actions.ts` (:66,:111 closures) → `markAriDirty(kinds:["availability"])` → drain → 1 POST `/availability` | 1–2 — achieved. **Model caveat:** GuestHub is one-physical-room-per-Room-Type (`count_of_rooms=1`, D64) so availability values are only 0/1; "reduce Twin to 7 units" is inexpressible. The cert scenario must be executed on the mapped 0/1 property and the deviation declared in the form | NO | `channel_dirty_ranges` kind=availability; reservation row | check-channex-ari.mjs part C (dirty ranges marked by the right canonical saves) | Create a reservation covering the date; observe `/availability` push |
| 10 | **Multi-date availability update in 1–2 calls** | Multi-night reservation or calendar closure over a range | Same as #9; consecutive identical days compressed into one range value | 1 — achieved | NO | as #9 | same | One multi-night reservation per room type |
| 11 | **Booking receiving (create/modify/cancel via BDC test account) + acknowledgement** | Live inbound (D76/D78/D80-82): webhook or 5-min fallback poll; reservations appear in `/reservations` with OTA number | `src/app/api/channel/webhook/[token]/route.ts` `POST` (opaque-token auth, dedupe, redacted persist, enqueue `pull_booking_revisions` prio 20) → worker → `src/lib/channel/booking-import.ts` `runInboundPull` (feed → persist → import → **ack only after commit**, :963-968; re-ack sweep :978) → `src/lib/channel/channex-bookings.ts` `acknowledgeBookingRevision` (POST `/booking_revisions/:id/ack`) | Ack per revision — achieved; persist-then-quarantine guarantees nothing is lost (D82) | Revision IDs: **yes** — `channel_booking_revisions.provider_revision_id`, ack_status/import_status | `channel_webhook_events` (65 rows in snapshot), `channel_booking_revisions` (65), quarantine states, external-change notifications | `scripts/check-channel-worker.mjs`, inbound covered by D76/D82 checks (`check-channel-card-ingest.mjs` for cards) | Create/modify/cancel on the BDC test account; screenshot `/reservations`; report booking IDs |

## 2. Declarations (12–14)

| # | Declaration | GuestHub state | Verdict |
|---|---|---|---|
| 12 | **Rate limits** — queue/limiter, never spam | Proactive pacing 1 req/6.5 s per kind (`PACE_MS`, ari-sync.ts:41-43 — matches 10/min/property/kind), per-run cap 6, DB queue FIFO per connection, per-range bounded exponential backoff + jitter (`backoffMs`, ranges.ts:48). **But:** on an actual 429 there is no 429-specific handling — see gap G3 | **Partial** — declarable only after G3 |
| 13 | **Update logic** — delta only; no timer full-sync (max 1/24 h off-peak) | Fully compliant: full sync is operator-triggered only, dead-letters instead of auto-retrying (worker.ts:117-129); incremental drain sends only dirty ranges; a repeat drain with no new dirt sends nothing (asserted by check-channel-worker.mjs). No cron, no scheduled full sync at all | **Pass** |
| 14 | **Extra notes** — restriction support, structures, cards/PCI | Supports: min_stay_arrival + min_stay_through, max_stay, stop_sell, CTA, CTD; per-room Room Types + per-(room×plan) Rate Plans; per-occupancy rates as decimal strings. Cards: encrypted local vault (`CARD_VAULT_KEY`), **CVV never stored** (removed at schema level, D52/migration 018); charge fails-closed (no PSP). PCI posture must be stated in the form | **Declarable** (write-up needed) |

---

## 3. Pre-flight checklist assessment

| Official requirement | GuestHub implementation | Status |
|---|---|---|
| Real-time ARI **change detection** (events, not polling) | Every canonical save calls `markAriDirty()` (`src/lib/channel/outbox.ts:41`) **inside the same transaction** as the business write — reservations, calendar closures, room status, rates grid/Group Update, rate-plan edits (incl. derived-plan family expansion `expandPlanFamily`), inbound imports. No diff-polling anywhere | ✅ |
| **Queue/outbox** batching within rate limit | `channel_dirty_ranges` (coalescing on overlap/adjacency, `coalesceRange`) + `channel_sync_jobs` durable queue (`FOR UPDATE SKIP LOCKED`, FIFO per connection, 10-min lease, idempotency keys, pg_notify wake) consumed solely by the PM2 worker | ✅ |
| **Retry/backoff on 429 & 5xx** | Bounded exponential backoff + full jitter (cap 1 h) per dirty range and per job; permanent errors dead-letter (`isPermanentError`). Single HTTP attempt per call, ambiguous writes never blindly retried (channex-http.ts). **429 is treated as any transient error** — no 1-minute property pause, no Retry-After parsing, no circuit breaker | ⚠️ partial (G3) |
| **Webhook + acknowledgement flow** | Token-hashed webhook endpoint (404-opaque, deduped, transactional persist+enqueue) + 5-min fallback poll; feed pull persists and imports **before** acking; ambiguous acks re-swept | ✅ |
| **Mapping layer** (internal IDs ⇄ Channex UUIDs) | `channel_connections` (property), `channel_room_mappings` (room→Room Type), `channel_room_rate_mappings` (room×plan→Rate Plan), alias adoption (032); `loadMappings` (ari-sync.ts:170); readiness validator blocks full sync until 100 % mapped | ✅ |
| Integration lives in main codebase, identifiable paths | All under `src/lib/channel/` + real UI actions; worker is `scripts/channel-worker.cjs` under PM2 | ✅ |

## 4. Anti-pattern assessment

| Rejected anti-pattern | GuestHub | Verdict |
|---|---|---|
| Standalone scripts / Postman posting exact test values | None. The only scripts are `check-*.mjs` tests using an **injected fetch** (no network); `check-channex-ari.mjs` part D asserts at source level that no other module can send ARI | Clean |
| Certification-only UI | None — triggers are the production `/rates`, `/reservations`, `/calendar`, `/channels` surfaces | Clean |
| Timer-based full sync instead of deltas | None — full sync only via operator button; worker tick (20 s) only drains **deltas** and never falls back to full sync (`drainAriDirtyRanges` "never falls back", ari-sync.ts:31) | Clean |
| Per-date calls where a single call is specified | Avoided structurally: run-length compression into inclusive ranges + ≤1000-value batches; one drain claims up to 500 ranges into ≤1 request per kind (typical) | Clean (see G5 note) |
| Hardcoded UUIDs/values in production paths | None — all external IDs resolved from mapping tables at runtime. One environment hardcode exists (staging base URL, G6) but it is not a test-value hardcode | Clean (G6 noted) |

## 5. Current behavior — findings called out by the audit brief

1. **Full Sync request count** — *not* structurally "exactly one POST per kind": `runInitialFullSync` sends one request **per ≤1000-value batch**, up to 6 per kind, and a deferred batch fails the run (not clean → incremental stays disabled). With the current property (13 rooms, compressed ranges) it is empirically exactly 1 + 1: all five successful `full_sync` jobs in the snapshot carry exactly 2 task IDs. A cert property with highly varied 500-day data could exceed 1000 restriction values and produce 2+ restriction requests — still within the documented "2 API calls" *spirit* but should be measured before the screenshare.
2. **Rate-limit handling today** — proactive pacing only (6.5 s between requests per kind = 10/min/property). On a real 429 (`rate_limited` category): full sync fails the run; incremental ranges retry via the **generic** backoff (first retry ≈2.5–5 s — well inside the same rate-limit window, contradicting Channex's "pause 1 minute" guidance). There is **no 429 cooldown, no Retry-After handling, no per-connection circuit breaker**. Absence confirmed in `channex-http.ts`, `ari-sync.ts`, `queue.ts`.
3. **Evidence persistence today** — `channel_sync_jobs` is the only ledger. `provider_task_id`/`payload.task_ids` are written **only** for `full_sync` (and room-type/rate-plan creation). Incremental drains discard the task IDs they receive (`SendOutcome.taskIds` never persisted; 136/136 succeeded `sync_ari_range` jobs have NULL `provider_task_id` in the snapshot). There is no scenario-taggable, per-request evidence ledger of the kind V2 §13 requires (request summary + task IDs + timestamps + value counts per push). `channel_sync_errors` (579 rows) covers failures/warnings only.

## 6. Gap list

| ID | Gap | Severity | Certification impact | Fixed in |
|---|---|---|---|---|
| G1 | Incremental drains do not persist Channex Task IDs (tests 2–10 each require a recorded task ID for the submission form) | **High** | Cannot fill the certification form from GuestHub data; IDs only recoverable from the Channex dashboard | **Stage 4** (evidence wiring: persist `SendOutcome.taskIds` per push) |
| G2 | No dedicated evidence ledger (V2 §13): per-request row with kind, connection, date span, value count, task IDs, outcome, timestamps — queryable per certification scenario | **High** | Stage-2/3 evidence assembly is manual; screenshare prep weak | **Stage 4** |
| G3 | 429 handling: no property-level 1-minute pause, no Retry-After, no circuit breaker; generic backoff retries too fast after `rate_limited` | **Medium** | Declaration 12 cannot be honestly signed as-is; risk of visible spam during screenshare under load | **Stage 4** (rate-limit hardening on the existing queue — Stage 3 outbox already provides the seam) |
| G4 | Availability model is 0/1 per physical room (`count_of_rooms=1`); test 9's "Twin → 7 units" is inexpressible | **Medium** | Needs an adapted scenario + explicit note in the form (Channex accepts model notes in Test 14); otherwise a reviewer surprise | **Stage 4** (declaration text; optional multi-unit aggregation is out of scope) |
| G5 | "Exactly 2 calls" for Full Sync is empirical, not asserted; per-kind run cap 6 could silently split a large property; no recorded request-count metric per run | **Medium** | Test 1 asks for the request count; today it must be inferred from `payload.task_ids` length | **Stage 4** (record `requests` per kind on the job row — already in `FullSyncResult`, just not persisted; Stage 3 canonical services unaffected) |
| G6 | Outbound ARI + room-type/rate-plan/admin paths hardcode `CHANNEX_BASE_URLS.staging` (ari-sync.ts:107, room-type-admin.ts, rate-plan-admin.ts, admin.ts) even though `channel_connections.environment` exists and inbound paths honor it (booking-import.ts:94, inbound-admin.ts) | **Low** (until go-live) | Blocks the post-certification production cutover, not certification itself | **Stage 4** (Channex wiring: `CHANNEX_BASE_URLS[conn.environment]` everywhere) |
| G7 | Cert scenarios 3–8 expect "1 API call"; changes saved as separate actions across worker ticks legitimately produce >1 call | **Low** | Procedural: run each scenario as ONE Group Update/save (documented in §1 manual steps) | Runbook (Stage 4 evidence doc), no code change |
| G8 | Webhook per-token rate limiter is in-process memory (fine single-process; noted for multi-process futures) | **Low** | None for certification | Backlog |

### Certification-readiness summary

Architecture (change detection → transactional outbox → durable queue → single worker → mapping layer → persist-then-ack inbound) matches the official pre-flight checklist almost point-for-point, and **no rejected anti-pattern is present**. The blocking work is evidentiary, not architectural: persist task IDs for every push (G1/G2), harden 429 behavior (G3), and prepare the model-deviation declarations (G4, test 14).
