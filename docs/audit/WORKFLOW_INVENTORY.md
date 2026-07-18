# GuestHub PMS — Workflow Inventory (V2 §7)

- **Date:** 2026-07-18
- **Branch:** feat/pms-hardening-channex-certification
- **Method:** read-only code walk of `/var/www/guesthub` + read-only snapshot queries against `guesthub-testdb` (`guesthub_stage1_restore`). No product code was modified.
- **Companion doc:** `OPERATIONS_OBSERVABILITY_AUDIT.md` (observability/operations findings table lives there).

Conventions: paths are absolute; "tx" means all listed writes share ONE `sql.begin` transaction; "NOTIFY" refers to `pg_notify` which PostgreSQL delivers only on COMMIT.

---

## 1. Manual reservation creation

- **Entry point:** `createReservationAction` — `/var/www/guesthub/src/app/(dashboard)/reservations/actions.ts:200`
- **Services:** `getActor`/`requirePermission` (`reservations.create`, plus `reservations.price_override` for manual rates) → zod `createReservationSchema` → in tx: `lockRooms` → `priceReservationStays` (canonical engine, `src/lib/pricing/reservation-pricing`) → `upsertGuest` → `allocateReservationNumber` (tenant row `FOR UPDATE` + MAX+1) → `resolveCancellationSnapshot` (034 policy snapshot).
- **Tables written:** `guesthub.reservations`, `reservation_rooms` (with `pricing_snapshot`), `guests`, `payments` (if `paidAmount>0`), aggregates via `recomputePaymentAggregates` (ledger-derived `paid_amount`/`balance`), `audit_logs`, `channel_dirty_ranges` + `channel_sync_jobs` (via `markAriDirty`, blocking statuses only), `communication_events` (via `enqueueReservationConfirmed`, status `confirmed` only).
- **Side effects:** `publishDomainEvent` (`reservation.created`, `inventory.changed`) on commit → SSE fan-out + worker wake; `revalidatePath('/calendar','/reservations')`.
- **Failure behavior:** any throw rolls back the WHOLE transaction (no partial reservation, no dirty range, no event). Domain/authorization errors return a Hebrew toast; unexpected errors are `console.error`'d and return a generic message. Nothing is retried — the operator retries manually.

## 2. OTA reservation creation (webhook → revision fetch → normalize → apply → ACK)

- **Webhook receipt:** `POST /api/channel/webhook/[token]` — `/var/www/guesthub/src/app/api/channel/webhook/[token]/route.ts:41`. Token (min 20 chars, in-memory 120/min rate limit) → SHA-256 lookup on `channel_connections.webhook_token_hash` (active + inbound-enabled only; otherwise indistinguishable 404). Body ≤256KB, JSON only. In ONE tx: insert redacted event into `channel_webhook_events` (dedup on `connection_id, dedup_key`) + `enqueueChannelJob('pull_booking_revisions', priority 20, idempotencyKey 'pull:<conn>:<dedup>')`. NOTIFY on `guesthub_jobs` wakes the worker on commit. Any DB error → sanitized 503 → Channex retries.
- **Fetch/import:** worker claims the job → `runInboundPull` — `/var/www/guesthub/src/lib/channel/booking-import.ts:1004`. Feed pages (`fetchBookingRevisionsFeed`, always page 1, ≤20 rounds, stop on no-new). Per revision (`processFeedRevision:895`):
  1. `normalizeBookingRevision` (`booking-normalize.ts`) — even a normalize-FAILED revision is persisted by raw identity so feed expiry (~30 min) can never lose it (D82); only a revision with no booking id at all is log-only (`inbound_normalize_failed` in `channel_sync_errors`).
  2. `persistBookingRevision` (`revisions.ts:111`) — idempotent on (connection, revision_id); PAN extracted + encrypted BEFORE redaction, CVV discarded; stored payload redacted.
  3. `importRevisionRow` (`booking-import.ts:773`) — wrong property → quarantine; `reconcileInboundRatePlans` (verified alias self-heal, D78) runs OUTSIDE the tx; then ONE tx: `applyLiveRevision` (`:495`) — room resolution strictly by external UUID via `channel_room_mappings`/aliases, `lockRooms` + `checkRoomAvailability` (same rule as manual writes), guest upsert, reservation insert/update (`booking_origin='ota'`, channel price with `is_manual_rate=true`, `pricing_snapshot NULL`), `reservation_rooms` delete+reinsert on modification, `recomputePaymentAggregates` (hotel-collect arrives unpaid), audit row, `recordExternalDateChange` when dates moved, `markAriDirty`, `publishDomainEvent`, and `markRevisionImported` (attaches staged encrypted card to `reservation_cards`) — all commit together.
  4. **ACK:** `acknowledgeBookingRevision` is called ONLY after the commit; `markRevisionAcknowledged` structurally refuses non-imported rows. Failed acks are swept by `reacknowledgeImported` (≤50/pull; definite 404/422/409 counts as acked; ambiguous stays for the next pull).
- **Tables written:** `channel_webhook_events`, `channel_sync_jobs`, `channel_booking_revisions`, `reservations`, `reservation_rooms`, `guests`, `reservation_cards`, `channel_external_changes`, `audit_logs`, `channel_dirty_ranges`, `channel_sync_errors`.
- **Failure behavior:** domain conditions (unmapped room/plan, local conflict, duplicate room overlap) → `QuarantineError` → `quarantineRevision` + `logChannelError('inbound_quarantine')`; NOT acknowledged → stays in the feed. Transient failure → `markRevisionFailed`, retried by the next pull. A pull with zero progress and errors fails the job as `network_error` (bounded retries + backoff). **Note:** a quarantined revision is re-attempted on EVERY 5-minute poll with a fresh error row each time — see observability audit finding F2.

## 3. Reservation modification

- **Entry point:** `updateReservationAction` — `reservations/actions.ts:345` (the ONE editor; never cancels).
- **Flow (one tx):** reservation `FOR UPDATE` (cancelled rows refuse edit) → override-authorization gate (§13: turning ON or changing a manual rate requires `reservations.price_override`; preserved overrides don't) → skip-checks set for untouched stays (§F) → committed-price snapshots for unchanged price basis (§6) → `lockRooms` (old + new) → `validateAndPriceStays` → room rows delete/update/insert → parent aggregates + `recomputePaymentAggregates` → audit.
- **Side effects:** `markAriDirty` over the UNION of old+new rooms/dates when blocking on either side; `publishDomainEvent` (lifecycle-aware: `reservation.checked_in/checked_out/no_show/modified`, `payment_changed` when additional payment recorded, `inventory.changed`); confirmation email event when transitioning into `confirmed` (non-OTA origins only).
- **Failure behavior:** full rollback; friendly toast for domain errors; no retry.

## 4. Cancellation (incl. D77 realtime flow)

- **Local:** `cancelReservationAction` — `reservations/actions.ts:657`. Requires `reservations.cancel` + a reason. In tx: refuses an ACTIVE OTA reservation (D77 §9 — local cancel would release inventory while the OTA booking stays live); cancel-never-delete `UPDATE reservations SET status='cancelled', cancelled_* ...`; audit; `markAriDirty` + `inventory.changed` over the released nights; `reservation.cancelled` domain event.
- **Inbound (OTA):** `applyCancellation` — `booking-import.ts:699`. Missing local reservation → revision marked imported with no reservation (history only). Otherwise status flip to cancelled with `cancellation_origin` = `invalid_card` (if we requested it) or `ota_revision`, `external_cancellation_confirmed_at=now()`, ARI dirty + `reservation.cancelled` + `inventory.changed` events, audit.
- **Realtime path (D77):** `publishDomainEvent` (`realtime/publish.ts:19`) does `pg_notify('guesthub_events', payload)` inside the SAME tx → delivered on COMMIT only → web-process hub (`realtime/hub.ts`, one `sql.listen` per Node process, auto-reconnect) → tenant-scoped SSE `/api/events` (`api/events/route.ts`: auth-bound tenant, 25s heartbeat, 10-min max stream forcing re-auth). Events are whitelisted invalidation hints (ids/rooms/dates/lifecycle only); clients refetch through authorized reads.
- **Failure behavior:** a publish failure is swallowed (`publish.ts` catch) — the row is truth, the event is a hint; open calendars then converge on next refetch/poll. Hub LISTEN failure degrades to no live updates with retry every 5s.

## 5. Room move (calendar drag/resize)

- **Entry point:** `rescheduleReservationRoomAction` — `reservations/actions.ts:795`; price preview via `previewRescheduleAction:942` (same validation inside a deliberately rolled-back tx).
- **Flow (one tx):** stay+reservation `FOR UPDATE` → `lockRooms(target, old)` → `validateAndPriceStays` (availability always enforced — even drafts can't land on closures; restrictions only when blocking; manual overrides survive; same-room date change keeps committed nightly, room change re-prices) → update `reservation_rooms` → recompute parent aggregates in SQL → audit.
- **Side effects:** `markAriDirty` + `inventory.changed` over old∪new rooms/dates (blocking only); `reservation.modified` event.
- **Failure behavior:** full rollback; toast. The floating confirm dialog re-validates server-side on commit — the preview is advisory.

## 6. Payment recording

- **Paths:** (a) create/update actions' `paidAmount`/`additionalPayment` inserts into `guesthub.payments` (status `'paid'`); (b) `recordExternalPaymentAction` — `reservations/card-actions.ts:322` — explicit staff confirmation required (`confirmed:true`), permission `payments.card_charge`, records amount/method/reference/note, audited as `payment_external_record` with IP/session (NEVER as a GuestHub charge).
- **Canonical rule:** `recomputePaymentAggregates` (`src/lib/payments/ledger.ts:26`) — `payments` is the ledger; `reservations.paid_amount/balance` are derived caches recomputed in the same tx; only `status='paid'` counts; negative balance = honest credit.
- **Charge:** `chargeReservationCardAction` (`card-actions.ts:281`) fails closed — `getPaymentGateway()` (`payments/gateway.ts`) is null (no PSP integrated); the attempt is audited, then returns the no-gateway message.
- **Side effects:** `reservation.payment_changed` domain event.
- **Failure behavior:** tx rollback; no retries.

## 7. Refund

- **NOT IMPLEMENTED.** The ledger recognizes `refunded`/`voided` statuses only by EXCLUDING them from `paid` (`ledger.ts:13`), and the permissions matrix lists a `refund` verb (`permissions/PermissionsMatrix.tsx:16`), but no server action or UI writes a refund/void payment row or transitions an existing payment. Overpayment surfaces as customer credit (negative balance); an actual refund can only be reflected today by manual DB intervention. Recorded as finding F7 in the observability audit.

## 8. Rate edit (single cell)

- **Entry point:** `upsertRateCellAction` — `rates/actions.ts:65`. Permission `rates.edit`; server-side writable window re-enforced (tenant-tz today → horizon).
- **Flow (one tx):** resolve base plan if none given → `writeRateCells` (`src/lib/rates/service.ts:83`) → `guesthub.pricing_plan_rates` (canonical) → `markAriDirty` inside the service (`service.ts:177` — rates/restrictions kinds, plan-family expansion) → audit `rate_edit`.
- **Failure behavior:** rollback + toast. Outbound delivery is decoupled (dirty range + queue).

## 9. Bulk rate update (Group Update)

- **Entry point:** `bulkUpdateRatesAction` — `rates/actions.ts:116`. Permission `rates.bulk_update`; window-clamped; weekday chips filter dates (inclusive end — D93).
- **Flow (one tx):** load base plans per sellable unit → current prices for relative modes → build cells → `writeRateCells` (same service as single cell — cannot diverge) → `bulk_rate_update_logs` + `bulk_rate_update_items` (old/new price per cell) → audit `bulk_update` → `markAriDirty` via service.
- **Failure behavior:** all-or-nothing rollback; honest preview is computed separately (D93).

## 10. Room closure

- **Create/delete:** `createClosureAction` / `deleteClosureAction` — `calendar/actions.ts:26/87`. Permission `rooms.edit`. In tx: `lockRooms` + `checkRoomAvailability` (create refuses conflicts) → `room_closures` insert/delete → audit → `markAriDirty` (availability only — stop_sell never derives from a closure §7) → `inventory.changed` event.
- **Administrative room status** (`available|inactive|out_of_order`): `setRoomStatusAction` — `rates/actions.ts:235` — couples `status` and `is_active`, dirties availability over the FULL 500-day horizon (no natural end date).
- **Failure behavior:** rollback + toast.

## 11. Full Sync (D68/D69/D72)

- **Trigger:** operator-only from /channels — `requestFullSyncAction` (`src/lib/channel/admin.ts:298`): probes the STORED key first (D70 §7 — no job on a dead credential), enqueues `full_sync` (priority 10, idempotency `full_sync:<conn>` → one live run), sets `full_sync_required=true`.
- **Execution:** worker → `runInitialFullSync` (`src/lib/channel/ari-sync.ts:280`). Phases with persisted milestone progress on the JOB ROW (`channel_sync_jobs.payload.progress`, throttled writes, D69): validating (readiness: ALL rooms mapped, ALL room×plan combos mapped, no broken mappings; live auth probe) → project availability (500 tenant-tz days) → submit availability → project rates/restrictions → submit → check warnings → activate.
- **Pacing/limits:** ~6.5s between requests (10/min/property Channex budget), ≤6 batches per kind per run.
- **Success (clean only):** `channel_connections` → `state='active', outbound_sync_enabled=true, full_sync_required=false`; progress 100%.
- **Failure behavior:** ANY failure/warning/deferred batch → progress frozen at the reached phase, `full_sync_required=true`, `last_error` set, `logChannelError` (`partial_warnings` or the failure code) — and the job **dead-letters immediately** (`worker.ts:117-127`): a Full Sync is never auto-retried (it would send ARI unasked); the operator re-runs from /channels. Snapshot evidence: 1 dead_letter `full_sync` job — "רק 13 מתוך 14 חדרים ממופים" (2026-07-17).

## 12. Incremental ARI sync (dirty ranges → worker → Channex)

- **Producer:** every canonical write calls `markAriDirty` (`src/lib/channel/outbox.ts:41`) in the SAME tx: no-op with no active outbound connection; coalesces overlapping/adjacent pending ranges per (connection, room, kind, plan-scope); enqueues ONE deduplicated `sync_ari_range` job per connection (idempotency `ari_drain:<conn>`), NOTIFY on commit.
- **Consumer:** worker `sync_ari_range` → gate `loadDrainableConnections` (active + outbound enabled + `full_sync_required=false` ONLY) → `drainAriDirtyRanges` (`ari-sync.ts:547`): SELECT pending due ranges (≤500, ordered by revision; FIFO-per-connection job lease is the concurrency guard) → union spans per dimension → `projectAri` canonical projection → filtered to covered cells → paced `pushAri` batches.
- **Success:** ranges → `synced`; `channel_connections.last_outbound_sync_at=now(), last_error=NULL`.
- **Failure behavior:** `failRanges` — attempts+1, exponential backoff with jitter (cap ~1h), `status='pending'` until `max_attempts` (5, migration 027) then `status='failed'` (dead range); `last_error` on the connection; warnings logged to `channel_sync_errors`. The worker's `ensureDrainJobs` (`worker.ts:150`) re-enqueues a drain each tick for any due pending range — a transiently failed range can never be stranded waiting for the next operator save. A range that exhausts attempts (`failed`) is NOT retried and has no UI requeue (finding F5).

## 13. Inbound revision recovery job (D76)

- **Fallback poll:** `ensureInboundPullJobs` (`worker.ts:174`) — every tick, per inbound-enabled connection, enqueues `pull_booking_revisions` (priority 40, idempotency `inbound_pull:<conn>`) unless one ran/queued within 5 minutes → a missed webhook can delay a booking by ≤~5 min but never lose it (the feed serves unacknowledged revisions).
- **Recovery by ID:** `requestInboundPullAction` (`inbound-admin.ts:355`) can name ONE revision; `runInboundPull` then uses `fetchBookingRevision` for that id through the SAME persist→import→ack pipeline (used for revisions the feed already expired, ~30-min staging window).

## 14. Webhook receipt

Covered in §2 first bullet. Additional notes: dedup key = provider `event_id`/`id` or body hash; duplicate → `{ok, duplicate:true}` with no second job; the event row and job commit atomically (D77 §3 — no stranded dedup row). `channel_webhook_events.status` is written as `'enqueued'` and never transitions afterwards (display-only lifecycle — see finding F8). Webhook registration/re-registration: `reregisterWebhookAction` (`inbound-admin.ts:408`).

## 15. Email/messaging send (Gmail OAuth, GREEN-API/Twilio, D96 automations)

- **Manual send (toolbar, D53):** `sendEmailMessage`/`sendWhatsAppMessage` — `src/lib/messaging/service.ts:36/76`. Validation-failed / provider-not-configured are recorded as terminal `outbound_messages` rows (honest audit even when nothing is sent) → `resolveEmailProvider` (Gmail OAuth or SMTP app-password; encrypted tenant secrets, migration 020) / `resolveWhatsAppProvider` (GREEN-API | Twilio behind one interface) → send → `applySendResult` → audit.
- **Gmail OAuth:** `/api/messaging/gmail/oauth` + `/callback` routes; send-only scope, probe via userinfo (D95). Inbound webhooks: `/api/messaging/webhook/green-api|twilio` with opaque per-tenant tokens (D53).
- **D96 automated guest communications:** transactional outbox `communication_events` (`communications/outbox.ts:31`, occurrence-key dedup — one confirmation per reservation ever) → worker tick (`communications/worker.ts:19`, runs FIRST in the channel worker's tick) → `prepareDeliveriesForEvent` (`automation.ts:371`) which selects ONLY automations with `status='active'` (`automation.ts:386-388`) — **an automation is born a draft and sends NOTHING until a human enables it** → `outbound_messages` deliveries → `drainDeliveries` (`delivery.ts:286`).
- **Delivery safety:** eligibility re-asserted at claim time (`cancelIneligibleDeliveries` — a cancelled/opted-out/test reservation's queued email is cancelled, never sent); lease-based claim with immutable `communication_delivery_attempts` rows; failure classification (permanent vs transient) with per-tenant backoff and `max_attempts` (5/10, migration 036); **ambiguous** (lease expired while `submitting`) → fail-closed `ambiguous_provider_outcome`, never auto-resent (`delivery.ts:51`).
- **Failure behavior:** event preparation failure → bounded retries then event `failed`; provider failures classified; permanent categories fail fast. Ops emails for external date changes are dispatched strictly AFTER import commits and never fail the pull (`booking-import.ts:1056`).

## 16. Background worker loop (scripts/channel-worker.cjs)

- **Process:** PM2 `guesthub-channel-worker` (`ecosystem.config.cjs`: fork, 1 instance, autorestart, `min_uptime 30s`, `max_restarts 10`, `restart_delay 5s`, `kill_timeout 15s`, `max_memory_restart 300M`). Entry `scripts/channel-worker.cjs` → compiled `dist/worker/lib/channel/worker.js` (`runChannelWorker`). Refuses to start without `DATABASE_URL` or a built dist.
- **Loop (`worker.ts:243`):** LISTEN `guesthub_jobs` for instant wake (degrades to poll-only on failure — never a dead worker); every tick (20s default): communications tick → `ensureDrainJobs` → `ensureInboundPullJobs` → `claimChannelJobs` (≤5).
- **Claiming/leases (`queue.ts:76`):** `FOR UPDATE SKIP LOCKED`, FIFO per connection (a connection with a LIVE processing job is skipped — no concurrent ARI for one connection), lease = `JOB_LEASE_MINUTES` (10): a job whose `locked_at` is older is reclaimable.
- **Retries:** `failChannelJob` — permanent codes (`validation_error`, `mapping_error`, `unauthorized`, `not_found`) or exhausted `max_attempts` (8) → `dead_letter`; otherwise `retry_wait` with jittered exponential backoff.
- **Crash mid-job — honest assessment:** the job row stays `processing` until the 10-minute lease expires, then ANY worker reclaims it (attempts+1). Consequences per job type: `sync_ari_range` — safe, ARI values are absolute state, a re-drain re-sends the same canonical values; `pull_booking_revisions` — safe, persist/import are idempotent and ack-after-commit means at-worst re-import returns `already` + re-ack sweep; `full_sync` — a crash mid-run leaves progress frozen and the reclaimed attempt RE-RUNS the full sync (attempts+1; it was not operator-triggered the second time, but it re-sends the same canonical baseline — idempotent upstream, though it consumes API budget; a FAILED (non-crash) full sync dead-letters instead). The in-flight HTTP request itself is lost; no partial-batch bookkeeping exists below the range/job granularity — acceptable because payloads are state-replacing, not deltas. Worst case visible delay: 10 min lease + backoff. If the worker crash-loops >10 times PM2 leaves it `errored` permanently — jobs then sit queued with NO consumer and no alert (finding F3).
- **Heartbeat:** `heartbeat()` (`worker.ts:67`) upserts `channel_worker_state` (singleton: `worker_id`, `beat_at`, `last_drain_at`, `last_error`) each tick; heartbeat failure never kills the worker. Shutdown: SIGTERM/SIGINT abort → finish in-flight job → close pool.

## 17. Deployment (deploy-production.sh + guards)

- **Entry:** `PROD_DEPLOY_OK=1 npm run deploy:prod` → `/var/www/guesthub/scripts/deploy-production.sh` running inside `/var/www/guesthub-production` (must contain `.production-runtime` marker).
- **Guards (fail-closed):** `scripts/production-deploy-guard.mjs` runs BEFORE and AFTER fast-forward: clean tree, HEAD reachable from origin/main, on main (or HEAD==`APPROVED_MAIN_COMMIT`), no migrations outside the approved release (three-dot diff), explicit `PROD_DEPLOY_OK=1`. `scripts/prebuild-guard.mjs` re-requires the opt-in for any build in the marked checkout.
- **Steps:** fetch → guard → `git merge --ff-only origin/main` (never a merge, never another branch) → guard again → build (postbuild compiles `dist/worker`; deploy fails if worker didn't build) → `pm2 restart guesthub` + `pm2 startOrRestart ecosystem.config.cjs --only guesthub-channel-worker` → verify PM2 cwd of BOTH processes == prod dir → worker must survive 6s (`online`) → port 3007 answers → `/`, `/login`, `/calendar` return non-5xx → report commit + BUILD_ID (D61: verify BUILD_ID, not just curl).
- **Failure behavior:** any step fails the script; no rollback automation (previous build remains until overwritten — a failed build before restart leaves the old process serving; a failed restart is surfaced immediately).
- **Migrations:** applied manually/operator-controlled (guard only ensures they're merged); no automatic migration step in the deploy script.
