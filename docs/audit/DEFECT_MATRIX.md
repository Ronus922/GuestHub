# GuestHub — Consolidated Defect Matrix

**Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification` · **Stage:** 1 (audit)

This matrix consolidates every defect and risk found by the Stage-1 read-only audit (the ten inventories under `docs/audit/` and `docs/security/THREAT_MODEL.md`). Per charter §7 and the Stage-1 exit gate, **every Critical and High item has an owning stage**. Medium/Low items are assigned where an owner is clear or marked "continuous" (fixed opportunistically in whichever stage touches that area; residual Medium/Low documented at Stage 6/7).

Owning-stage rule (charter coverage matrix): dedicated-DB/topology/backup infra → **Stage 2**; core-domain integrity (reservations, inventory, pricing, payments, audit, DB constraints, double-booking) → **Stage 3**; Channex wiring/evidence/rate-limits/booking receiving → **Stage 4**; communications, housekeeping, maintenance, tasks, reports, Israel-market → **Stage 5**; full red-team, performance, observability/alerts → **Stage 6**; final verification/docs → **Stage 7**. Critical data-integrity/security defects are always in-scope for the current stage regardless (charter §1).

Source key: ARCH=Architecture, DOM=Domain, CODE=Codebase, RES=Reservations/Inventory, PRICE=Pricing, PAY=Payments, OPS=Operations/Observability, CHX=Channex mapping, GAP=PMS gap matrix, SEC=Threat model.

---

## Critical

| ID | Source | Defect | Evidence | Owning stage |
|---|---|---|---|---|
| C1 | SEC F1 / ARCH / STATE#1 | **Environment crossover — dev and production share one DB+schema.** Dev checkout resolves DB solely from `DATABASE_URL` (no in-code prod guard); shared host `:5432` is the live PROD Supabase DB. A stray dev process or broad `pkill` has hit prod before (MEMORY D45). | `src/lib/db.ts:11-17`; `.env.local` both checkouts → `localhost:5432/postgres` schema `guesthub` | **Stage 2** (dedicated Certification/Staging + Production DBs eliminate the shared target). Interim guard: no migrations/seeds/tests via the dev env — enforced now. |
| C2 | ARCH#1 | **Production DB reachable past the host firewall.** Supavisor `0.0.0.0:5432`, Kong `:8000/8443`, testdb `:5433` are Docker-published; the `DOCKER-USER` iptables chain is empty so Docker bypasses UFW (only 22/80/443 allowed). Password auth is the only barrier unless an unverified cloud firewall exists. | `docker ps` port bindings; empty `DOCKER-USER` chain | **Stage 2** design input; hardening verified **Stage 6**. Shared-infra constraint: cannot reconfigure the shared stack — document and coordinate; a cloud-firewall check is a user blocker candidate. |

No Critical defects were found in application domain logic, pricing, payments, or the Channex integration itself — both Criticals are infrastructure/topology and are owned by Stage 2 (with Stage 6 verification).

---

## High

| ID | Source | Defect | Evidence | Owning stage |
|---|---|---|---|---|
| H1 | RES F1 / DOM#1 | **No database-level double-booking guard.** No exclusion constraint / range index / advisory lock on `reservation_rooms`; prevention is entirely app-level `lockRooms()` FOR UPDATE + `check_room_availability()`. Two direct-SQL bypass incidents already documented (026/028). All current product paths comply (snapshot: 0 overlaps), but the last line of defense is missing. | `src/lib/inventory.ts:38,57`; `db/migrations/004_*.sql:73`; RES scenario R9 | **Stage 3** (exclusion constraint `EXCLUDE USING gist` on room + stay `daterange` over active states, per V2 §10). |
| H2 | DOM#2 | **`reservations.status` has no CHECK constraint** though it drives inventory blocking via `inventory_blocking_statuses()`. A typo'd status silently frees the room. | `db/migrations`; `inventory-rules.ts` | **Stage 3** |
| H3 | SEC F2 / DOM#6 | **No DB-level tenant isolation backstop.** Zero RLS policies; app connects as a privileged pooled role that bypasses RLS anyway. One missing `WHERE tenant_id=` silently leaks cross-tenant PII. Composite `(tenant_id,id)` FKs exist only on 026/036-era tables. | migrations (no `CREATE POLICY`); `src/lib/db.ts` | **Stage 3** (canonical tenant-scoping enforcement + decide RLS vs server-side per access path, ADR); topology enablement Stage 2; verified Stage 6. |
| H4 | ARCH#4 / OPS F1 / GAP#2 | **Backups omit the auth schema and have no off-host copy.** `nightly-backup.sh` dumps `--schema=guesthub` only — GoTrue `auth` (all logins) never backed up; restore loses authentication. Backups sit on the same host/disk as the DB and the `.env.local` keys. | `scripts/nightly-backup.sh`; restore snapshot has only `guesthub`+`public` | **Stage 2** (scheduled encrypted backups incl. auth, retention, off-host copy, exercised restore — V2 §9/§21). |
| H5 | ARCH#2 / DOM#3 / CODE#6 | **Migration history unreconstructable from the branch.** Migration 021 applied to prod but present only on non-ancestor commit `597801a` (`db/migrations` jumps 020→022); no `schema_migrations` ledger; duplicate `009_` prefix. Fresh install ordering is ambiguous. | `db/migrations/` listing; git history | **Stage 2** (migration ledger + replay-from-zero tooling; recover 021 into the branch). |
| H6 | CODE#1 | **OTA modification wipes local money adjustments.** Inbound revision sets `total_price` to the channel total, silently dropping locally-added `discount_amount`/`extra_charges` that the edit panel permits on OTA reservations. | `src/lib/channel/booking-import.ts:541-560` vs `reservations/actions.ts:530-533` | **Stage 3** (canonical reservation-money model + reconcile inbound vs local adjustments). |
| H7 | PAY H-1 / OPS F7 / GAP | **Refunds/reversals unimplemented.** `refunded/voided/failed/pending` statuses are constrained and excluded from sums, but no code path ever writes them; no void/correction path for a mistaken payment. | `src/lib/payments/ledger.ts`; migration 019 | **Stage 3** (payment ledger completion — refund/void/correction as ledger entries). |
| H8 | PAY H-5 / SEC | **Full reversible PAN vault keeps GuestHub in full PCI scope.** `reservation_cards` + browser reveal store/serve decryptable PAN, coexisting with (not replaced by) the token model; no key-rotation tooling; ciphertext lives in the shared multi-project Postgres. | `src/lib/.../card-vault.ts`; `card-actions.ts:208-273`; migration 008/018 | **Stage 3** (payment/tokenization boundary decision + retention job, V2 §18) with **Stage 6** PCI-scope verification. Depends on Stage 2 dedicated DB for blast-radius reduction. |
| H9 | CHX G1 | **Incremental syncs discard Channex Task IDs.** 136/136 succeeded `sync_ari_range` jobs have NULL `provider_task_id`; certification evidence for tests 2–10 is unfillable from GuestHub data today. | snapshot `channel_sync_jobs`; `ari-sync.ts` | **Stage 4** (evidence ledger captures Task IDs on every ARI submission — V2 §13). |
| H10 | CHX G2 | **No dedicated certification evidence ledger** (V2 §13). Only `channel_sync_jobs` (full-sync task_ids) + `channel_sync_errors` exist. | schema; CHX mapping | **Stage 4** |
| H11 | OPS F2 | **Quarantined revisions re-imported every poll, logging a fresh error row each cycle** — unbounded `channel_sync_errors` growth (579 rows = 25 quarantines × ~20 cycles in one day), no dedup/retention. | snapshot; `booking-import.ts`; poll job | **Stage 3** (dirty-range/quarantine handling + retention) / **Stage 4** (Channex-side quarantine visibility). Primary owner **Stage 3**. |
| H12 | OPS F3 | **Zero alerting on dead-letter jobs, new quarantines, or worker-heartbeat staleness.** If PM2 exhausts `max_restarts:10` the worker stays `errored` and OTA imports stop silently (webhook still returns 200). | `ecosystem.config.cjs`; OPS audit | **Stage 6** (observability/alerts); heartbeat/queue-visibility foundations **Stage 3** (§21 split). |
| H13 | GAP HV | **Audit trail is write-only.** 626 transactional audit rows but the only read surface is a last-10 per-reservation feed; no viewer/search/diff. | `audit-write.ts`; `reservations/actions.ts:1424` | **Stage 3** (audit read/query surface — foundation) / display polish **Stage 5**. |
| H14 | GAP HV | **Reports & exports are the largest wholesale gap.** No CSV/export code anywhere; dashboard is a stub; the entire essential report set (occupancy, revenue, balances due, cash-up, channel production, audit export) is missing. | `src/` (no export code); dashboard stub | **Stage 5** |
| H15 | GAP HV | **Israel-market compliance gaps.** `reservations.tax_exempt`/`tax_exempt` dead column (tourist VAT zero-rating unimplemented); no invoice/receipt entity or external-provider seam; no PII retention/deletion path (Privacy Law Amendment 13). | `vat.ts`; `reservations` schema; PRICE F-4 | **Stage 5** |

---

## Medium (assigned where owner is clear; else continuous)

| ID | Source | Defect | Owning stage |
|---|---|---|---|
| M1 | RES F2 | `channel_inventory_holds` is dead scaffolding — read by calendar/inventory, never written; quarantined OTA bookings hold no local inventory. | Stage 3 |
| M2 | RES F3 / CODE | No optimistic concurrency on operator edits — concurrent edits are last-write-wins with stale form data. | Stage 3 |
| M3 | RES F4 | `lockRooms` unsorted + divergent lock ordering → deadlock-abort potential. | Stage 3 |
| M4 | CODE#2 | OTA modify = DELETE+re-INSERT of `reservation_rooms`; local room moves/guest edits reverted; rr-id churn orphans audit rows. | Stage 3 |
| M5 | CODE#3 / RES F5 | Reservation-number allocator: O(n) `MAX(regexp)::bigint` scan under tenant lock, overflow-abort risk, duplicated in two files. | Stage 3 |
| M6 | PAY H-3 | Payment recording not idempotent — `idempotency_key` + unique index exist but no writer populates them. | Stage 3 |
| M7 | PAY H-4 / PRICE / CODE#4 | Calendar reschedule path uses a second inline balance formula bypassing `recomputePaymentAggregates` (the D51 drift class). | Stage 3 |
| M8 | PAY H-5 | Token model gaps vs V2 §18 (provider CHECK `'stripe'`-only; no customer ref/status/consent; PAN-based gateway seam can't charge stored refs). | Stage 3 |
| M9 | PAY H-6 | Currency integrity — payments rows carry no currency; back-office hardcodes ILS; OTA import persists foreign currency; PDF renders tenant currency regardless. | Stage 3 |
| M10 | PRICE F-2 | Calendar + rate grid re-implement `price ?? base_price` in ~5 places instead of one shared projection — drift risk. | Stage 3 |
| M11 | PRICE F-4 | VAT inclusive model has no tourist zero-rating dimension. | Stage 5 (Israel-market) |
| M12 | DOM#4 | Four competing channel mapping tables; 005-era `channel_room_type_mappings`/`channel_rate_plan_mappings` are permanent 0-row dead tables still FK-referenced by live jobs. | Stage 4 (mapping consolidation) |
| M13 | DOM#7 | Conflicting duplicate FKs on `outbound_messages` (020 SET NULL vs 036 composite RESTRICT); RESTRICT wins → messaged guests/reservations can never be hard-deleted (blocks PII deletion). | Stage 3 (constraint reconcile) / Stage 5 (PII deletion) |
| M14 | CHX G3 / SEC | 429 handling is generic 2.5–5 s backoff only — no 1-minute property pause, no `Retry-After`, no circuit breaker; declaration 12 only partially signable. | Stage 4 |
| M15 | CHX G4 | 0/1 availability model can't express test-9 "Twin → 7 units"; needs a declared form adaptation. | Stage 4 (declaration) |
| M16 | ARCH#6 | One PM2 worker couples Channex ARI sync with guest communications — one subsystem's failure stalls the other. | Stage 3 (worker separation) / Stage 6 (verify) |
| M17 | ARCH#7 | Dev and prod share the live uploads store `/var/www/guesthub-uploads`, no isolation. | Stage 2 |
| M18 | OPS F4 | No `/api/health` endpoint; site-health probes `GET /` (process-only); worker unmonitored externally. | Stage 6 (foundation Stage 3) |
| M19 | OPS F5 | Dirty ranges that exhaust 5 attempts become `failed` with no UI counter/requeue → silently stale OTA ARI. | Stage 3 (visibility) / Stage 6 (alert) |
| M20 | OPS F6 | Ambiguous/failed guest emails have no operator resend surface. | Stage 5 |
| M21 | SEC F3 | No app-layer login rate-limiting/lockout; brute-force protection depends on unverified upstream GoTrue config; minor username-enumeration timing. | Stage 6 |
| M22 | SEC F4 | GREEN-API webhook token stored plaintext and is the sole authenticator (no provider signature). | Stage 6 (Stage 4 for channel-security tests) |
| M23 | SEC F5 | `admin`/`super_admin` bypass all granular permission checks; thin local auth in `channel/*-admin.ts` helpers needs reachability confirmation. | Stage 6 |
| M24 | GAP HV | Guest identity degrades — channel import inserts a new guest per booking; no merge tool, no guest-edit UI. | Stage 3 (guest model) / Stage 5 (merge UI) |
| M25 | GAP HV | No MFA on operator accounts. | Stage 6 |
| M26 | GAP HV | Housekeeping is a stub; maintenance closures are untyped free-text. | Stage 5 |
| M27 | DOM#8 / PAY | `reservations.paid_amount/balance` are unguarded caches of the ledger (drift happened once, 019 one-shot fix); `audit_logs` append-only by convention only. | Stage 3 |

---

## Low / Info (continuous; residual documented at Stage 6/7)

- L1 (PRICE F-3): ₪0-display edge in calendar tooltip. → Stage 3/6.
- L2 (PRICE F-6): one unrounded `r*nights` fast path. → Stage 3.
- L3 (PRICE F-7): heavy `min_stay_through` usage invisible on calendar strip. → Stage 5.
- L4 (PRICE F-8): inbound OTA amounts stored without conversion guard. → Stage 3.
- L5 (CODE#7): external-payment action rounds to whole shekels, skips zod. → Stage 3.
- L6 (CODE#8): `lifecycle: input.status` publishes null on ordinary saves; detail panel truncates payments/activity; ~8 unpinned `toLocaleString()` money sites (D71 class). → Stage 3/5.
- L7 (PAY H-7/H-8/H-9): whole-shekel truncation on external payments; free-text `method`; payments lack payment-level audit entry. → Stage 3.
- L8 (DOM#5/#10 / GAP AP): legacy `rates` table (0 rows) still read by `rooms/actions.ts:463`; `sellable_units_backup_028` (12 rows, no PK/FK); channel journals unpruned; pre-018 backups may hold encrypted CVV (PCI). → Stage 3 (dead-path removal) / Stage 2 (backup CVV note).
- L9 (ARCH#9): `default.disabled` in sites-enabled; no HSTS/security headers on vhost; per-process webhook rate limiter wholesale-clears at 5,000 keys. → Stage 6.
- L10 (SEC F6-F9): SSRF/token-exfil via operator-set provider host; service-role key blast radius; error-object logging; client `dangerouslySetInnerHTML` coupled to escape-first renderer. → Stage 6.
- L11 (OPS): `channel_webhook_events` frozen at `'enqueued'` (65/65 — cosmetic status never advanced). → Stage 4.

---

## Confirmed strengths (do not regress)

These were validated by the audit and must be preserved across all stages:

- **Idempotency** is sound end-to-end: queue keys, OTA revision import/ACK (three layers), webhook dedupe, delivery leases, ledger recompute (CODE, RES F9).
- **Transactional integrity**: all multi-entity reservation writes (create/edit/cancel/reschedule/closure/OTA-import) run in one `sql.begin` with audit + dirty-ranges + NOTIFY; **ACK strictly after commit** (RES).
- **One canonical pricing engine** with proven quote↔ARI equality, enforced by existing checks; exemplary date-only/timezone and money-in-cents discipline (PRICE).
- **Payment ledger** is authoritative; `paid_amount/balance` derived by one formula; snapshot shows 0 drift; **CVV never stored** (migration 018 proven end-to-end) (PAY).
- **Channel queue** is genuinely crash-safe: leases, `SKIP LOCKED`, FIFO per connection, durable-then-wake NOTIFY, idempotent full-sync re-run; no job-loss path found (OPS, CHX).
- **Security baseline**: escape-first email renderer, no string-concat SQL, 0 `console.log`, 0 real `any`, 0 empty catches, 0 prod npm vulns, magic-byte upload validation, fail-closed AES-256-GCM card vault, Twilio HMAC timing-safe, Gmail OAuth CSRF+re-auth, tenant-scoped PDF/reservation routes (no IDOR) (SEC, CODE).
- **Deploy layer**: triple fail-closed guards (prebuild marker, git/migration guard, verified restart) — no defects (ARCH).
- **Channex architecture is certification-shaped**: change detection → outbox → durable queue → batched push through one seam (`pushAri`); no rejected anti-pattern present; full-sync empirically 1+1 requests (CHX).
