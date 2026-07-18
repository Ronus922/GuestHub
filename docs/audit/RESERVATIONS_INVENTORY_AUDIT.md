# Reservations & Inventory Reliability Audit (Agent F)

- **Date:** 2026-07-18
- **Branch:** feat/pms-hardening-channex-certification
- **Scope:** reservation creation (manual + OTA), edit, move/date change, cancellation, no-show, availability computation, holds, conflict handling, overbooking prevention, concurrency, inventory release, OTA revision apply/ACK, duplicate prevention, audit writes.
- **Method:** read-only code + migration review; SELECT-only sanity queries on the `guesthub_stage1_restore` snapshot (guesthub-testdb). **No writes, no concurrency experiments executed** — race scenarios below are designed on paper for Stage 3.

---

## 1. Current flows (with file:line evidence)

### 1.1 Manual reservation create
`createReservationAction` — `src/app/(dashboard)/reservations/actions.ts:200-340`.
Single `sql.begin` transaction:
1. `lockRooms(tx, …)` first (`actions.ts:214`) — `SELECT id FROM guesthub.rooms … FOR UPDATE` (`src/lib/inventory.ts:38-52`), serializing all availability-checked writers per room (D34).
2. `validateAndPriceStays` → `priceReservationStays` (`src/lib/pricing/reservation-pricing.ts:221`) → `calculateReservationPrice`, which runs THE availability check inside the engine (`src/lib/pricing/engine.ts:242` → `checkRoomAvailability`, `src/lib/inventory.ts:57-74` → SQL `guesthub.check_room_availability`, migration `db/migrations/004_phase3_calendar.sql:73-111`). `enforceAvailability: true` (`actions.ts:216`).
3. Guest upsert (`actions.ts:159-187`), reservation-number allocation under tenant-row `FOR UPDATE` (`actions.ts:151-157`; unique backstop `UNIQUE (tenant_id, reservation_number)` in `db/migrations/000_init_schema.sql:245`).
4. Insert `reservations` (`actions.ts:248`) + per-stay `reservation_rooms` (`actions.ts:265-279`) + optional payment + ledger recompute (`actions.ts:289`), audit (`actions.ts:291`), ARI dirty ranges (`actions.ts:299-306`), domain events (`actions.ts:315-330`) — **all inside the one transaction**.

### 1.2 Edit (the ONE editor)
`updateReservationAction` — `actions.ts:345-652`. One transaction: reservation row `FOR UPDATE` (`actions.ts:364`), old rows loaded, `lockRooms` over old ∪ new rooms (`actions.ts:457-463`), re-validate/price with `excludeRrIds` (own rows only; sibling rooms still conflict) (`actions.ts:465-471`). `enforceAvailability: nowBlocking` — a draft edit is not availability-enforced (drafts do not consume inventory); a draft→blocking transition clears every skip and re-proves availability for ALL stays (`actions.ts:436`). Row apply: delete removed / update kept / insert new (`actions.ts:479-528`), parent aggregate update (`actions.ts:536-558`), ledger recompute (`actions.ts:568`), audit (`actions.ts:570-576`), ARI dirty over old ∪ new rooms and the min/max date span (`actions.ts:584-598`), lifecycle events (incl. `no_show`, `actions.ts:613-629`).

### 1.3 Room move / date change (calendar drag/resize)
`rescheduleReservationRoomAction` — `actions.ts:795-935`. `FOR UPDATE OF rr, res` (`actions.ts:826`), `lockRooms([target, old])` (`actions.ts:830-831`), `enforceAvailability: true` **always, even for drafts** (`actions.ts:856` — closures/unsellable rooms), price rules for manual/committed prices (`actions.ts:833-863`), stay update + parent recompute (`actions.ts:866-893`), audit (`actions.ts:895-901`), ARI dirty for old+new (`actions.ts:903-918`). `previewRescheduleAction` (`actions.ts:942-1017`) runs identical validation and **always rolls back** (throws a symbol at `actions.ts:1016`).

### 1.4 Cancellation / no-show
- Local cancel: `cancelReservationAction` — `actions.ts:657-742`. `FOR UPDATE` (`actions.ts:672`), refuses active OTA reservations (`actions.ts:681-685`, D77 §9), cancel-never-delete status flip with who/when/why on the row (031) (`actions.ts:691-699`), audit, and inventory "release" = `markAriDirty` + events (`actions.ts:713-726`). Release is implicit: `cancelled` is not in `inventory_blocking_statuses()` (`004:62-64`; TS mirror `src/lib/inventory-rules.ts:11`, asserted equal by `scripts/check-inventory.mjs`), so availability is derived, not decremented — nothing to "give back", the status flip is the release.
- No-show: not a dedicated action; a status change through `updateReservationAction` (`actions.ts:619-621`). `no_show` is non-blocking (`inventory-rules.ts:11`), so the same derived-release logic applies via `wasBlocking || nowBlocking` dirty-marking (`actions.ts:591`).
- OTA cancel: `applyCancellation` — `src/lib/channel/booking-import.ts:699-769`, same semantics, origin `invalid_card` vs `ota_revision` (`booking-import.ts:719`).

### 1.5 Closures
`createClosureAction` / `deleteClosureAction` — `src/app/(dashboard)/calendar/actions.ts:26-130`: lockRooms → availability check → insert → audit → ARI dirty, one transaction each.

### 1.6 OTA import (normalize → apply → ACK)
Runs only in the PM2 channel worker (`pull_booking_revisions`, `src/lib/channel/worker.ts:94`), never in a web request.
- **Persist:** `persistBookingRevision` (`src/lib/channel/revisions.ts:111-132`) — `ON CONFLICT (connection_id, provider_revision_id) DO NOTHING` (schema: `db/migrations/005_phase3_channel_foundation.sql:192`). Normalize-fail revisions are still persisted with raw identity so nothing is lost when the feed expires (~30 min) (`booking-import.ts:875-948`).
- **Apply:** `importRevisionRow` (`booking-import.ts:773-858`): `import_status='imported'` short-circuits (`:784`); wrong property → quarantine (`:794-805`); one `db.begin` transaction runs `applyLiveRevision`/`applyCancellation` **and** `markRevisionImported` together (`:815-822`), so "imported" implies durably saved. `applyLiveRevision` locks the existing external reservation `FOR UPDATE` (`:376-389`), then `lockRooms`, then the same `checkRoomAvailability` every local write uses, excluding only its own rr rows (`:511-528`); any conflict → `QuarantineError` → visible quarantine + external-date-change record (`:825-846`), **never an overwrite**. Room resolution is by external UUID mapping only, never title (`:129-137`); rate-plan alias adoption requires live UUID-chain proof (`:214-288`).
- **ACK:** sent only after the import transaction committed (`booking-import.ts:963-971`); `markRevisionAcknowledged` structurally refuses any row not `imported` (`revisions.ts:247-259`). Failed ACKs are re-swept (`:978-1002`), ambiguous failures never blind-retried.
- **Duplicate prevention:** reservation identity = `uq_reservations_external_booking` on `(channel_connection_id, external_booking_id)` (`db/migrations/029_inbound_booking_identity.sql:54-56`) — DB-enforced, not code.

### 1.7 Audit history
`writeAudit` inside the transaction on every path: create `actions.ts:291`, update `:570`, cancel `:700`, workflow `:772`, reschedule `:895`, closures `calendar/actions.ts:56,104`, channel imports via `channelAudit` (`booking-import.ts:305-318`) and card attach audit (`revisions.ts:186-196`).

---

## 2. Answers to the six questions

### Q1 — Where is availability computed? One canonical function?
**One canonical conflict-level function, plus two derived count projections.**
- Canonical: SQL `guesthub.check_room_availability` (`004:73-111`, half-open overlap, blocking statuses, closures, room sellability), sole TS entry `checkRoomAvailability` (`inventory.ts:57`). All booking-side paths reach it through the pricing engine (`engine.ts:242`) or directly (OTA import `booking-import.ts:516`, closures `calendar/actions.ts:41`). The blocking-status list is single-sourced (`004:62-64` ↔ `inventory-rules.ts:11`, CI-asserted).
- Aggregate projections (counts, not conflicts): `room_type_inventory()` (`005:263-345`) **includes** `channel_inventory_holds`; `sellable_unit_inventory()` (`009_phase4a_sellable_units.sql:147-164`) **intentionally excludes** holds and feeds outbound ARI (`src/lib/channel/ari-projection.ts:15-21,257-275`). The divergence is documented but is a latent inconsistency the day holds get written (they currently never are — see F2).
- The calendar UI computes no availability: it renders raw stays/closures/holds (`src/app/(dashboard)/calendar/data.ts:67-92`). The booking panel goes through the same engine. **No competing implementations found.**

### Q2 — Any database-level double-booking guard?
**No.** `reservation_rooms` constraints are only `CHECK (check_out > check_in)`, PK and FKs (verified live on the snapshot via `pg_constraint`; schema `000_init_schema.sql`). No `EXCLUDE USING gist` on (room_id, daterange), no unique index over stay ranges, no advisory locks. The guard is **entirely application-level**: `lockRooms` (`inventory.ts:38-52`, room-row `FOR UPDATE`) + `check_room_availability` in the same transaction, per the D34 contract written in `004:71-72`. Every product write path audited does follow the contract (insert paths: `actions.ts:268,516`, `booking-import.ts:611`; update paths: `actions.ts:505,867`). The race exists only for a path that skips the contract — none in product code today, but scripts (`scripts/seed.mjs:591`, `scripts/check-*.mjs`) insert directly, and any future code path or manual SQL writes overlaps silently. → **Finding F1 (High, defense-in-depth)** with exact racing insert paths listed there.

### Q3 — Are multi-entity changes transactional?
**Yes, on every path.** reservation + reservation_rooms + payments + ledger recompute + audit + `channel_dirty_ranges` (`markAriDirty`) + NOTIFY events commit atomically:
- create `actions.ts:213-332`; update `:355-644`; cancel `:665-735`; reschedule `:808-927`; closures `calendar/actions.ts:39-78,91-123`; OTA import `booking-import.ts:815-822` (revision status included). `publishDomainEvent` is transactional NOTIFY (committed-only realtime, D77 §6). Post-commit-only side effects are deliberate: ACK, quarantine records, ops e-mails (`booking-import.ts:1051-1060`).

### Q4 — Is OTA revision apply idempotent? ACK only after commit?
**Yes, at three layers:** (1) `persistBookingRevision` `ON CONFLICT DO NOTHING` on `(connection_id, provider_revision_id)` (`revisions.ts:129`, `005:192`); (2) `importRevisionRow` returns `already` for `import_status='imported'` (`booking-import.ts:784-785`); (3) `uq_reservations_external_booking` (`029:54-56`) makes a double concurrent "new" import a DB error, not a duplicate reservation. `markRevisionImported` runs inside the apply transaction (`booking-import.ts:820`); ACK is issued strictly after commit (`:963-971`) and `markRevisionAcknowledged` refuses non-imported rows (`revisions.ts:251-256`). Crash between commit and ACK → next pull sees `already` → re-ack sweep (`:978-1002`). The status-read at `:784` is not `FOR UPDATE`, but job claiming is `FOR UPDATE SKIP LOCKED` with DB-enforced duplicate prevention (`queue.ts:74-96`), and the inner reservation lock + unique index make a double-apply converge (see race R4).

### Q5 — Can a modification silently overwrite a conflicting reservation?
**Room/date conflicts: no.** OTA modifications re-check availability excluding only their own rows; a conflict quarantines the revision and records an external-date-change with `applyStatus: 'conflict'` (`booking-import.ts:516-528, 405-455`) — the calendar keeps local truth. Manual edits/moves enforce availability under locks; the editor comment at `actions.ts:368-371` closes the stale-status overwrite.
**Reservation fields: yes (concurrent operators).** There is no optimistic-concurrency check (no version/updated_at compare): two operators editing the same reservation are serialized by `FOR UPDATE`, then the second's full-form payload overwrites the first's committed field changes with stale client data (`actions.ts:536-558`). Not an inventory bug, but silent data loss. → **Finding F3**.
Also note: an OTA modification legitimately rewrites the stays of a `checked_in` reservation (status preserved via `PRESERVED_STATUSES`, `booking-import.ts:459`, rows deleted+reinserted `:561-563`) — by design (channel truth) with notification, listed as F8 for awareness.

### Q6 — Snapshot sanity SELECTs (read-only, executed 2026-07-18)
| Check | SQL shape | Count |
|---|---|---|
| Overlapping **blocking** stays, same room (self-join, half-open) | rr a ⋈ rr b on room_id, a.id<b.id, overlap, both statuses ∈ blocking | **0** |
| Reservations with no reservation_rooms rows | NOT EXISTS | **0** |
| Negative/zero-length stays (`check_out <= check_in`) | direct | **0** (also CHECK-constrained) |
| Orphan reservation_rooms (no parent) | LEFT JOIN IS NULL | **0** (FK CASCADE) |
| reservation_rooms with NULL room_id | direct | **0** |
| Parent check_in/check_out ≠ MIN/MAX of child stays | join on aggregates | **0** |
| Duplicate `(connection, external_booking_id)` | GROUP BY HAVING >1 | **0** |
| Rows imported but unacknowledged | import/ack status | **0** |
| **Quarantined revisions** | import_status | **25** (8× "same physical room twice, overlapping dates", 7× "room without channel Room Type id", several local-conflict parks) |
| `channel_inventory_holds` rows (any status) | COUNT | **0** |
| Total reservations | COUNT | 81 |

Snapshot integrity is clean; the 25 quarantines are the designed visible-park behaviour, but they are an operational backlog (F7).

---

## 3. Designed race scenarios for Stage 3 (NOT executed here)

| # | Scenario | Expected (per code contract) | What would falsify it |
|---|---|---|---|
| R1 | Two parallel `createReservationAction`, same room, overlapping dates (two sessions, commit-window overlap) | `lockRooms` serializes on the room row; loser re-checks and fails with conflict Hebrew message | Both commit → overlap row pair appears in the Q6 self-join |
| R2 | Manual create vs worker OTA import, same room/dates | Same serialization (`actions.ts:214` vs `booking-import.ts:514`); loser fails or quarantines | Overlap, or OTA overwrite of the manual stay |
| R3 | Two multi-room creates locking rooms in opposite orders (A: [r1,r2], B: [r2,r1]) | `lockRooms` does **not** sort ids (`inventory.ts:44`) → Postgres deadlock, one aborts with the generic error | Both succeed with overlap, or hang > deadlock_timeout without abort |
| R4 | `importRevisionRow` invoked twice concurrently for the same un-imported revision (bypassing job dedup) | New booking: second INSERT hits `uq_reservations_external_booking` → `failed` → retry → `already`. Modified: serialized on reservation `FOR UPDATE`, converges | Two reservations for one external_booking_id |
| R5 | Two operators submit the edit panel for the same reservation seconds apart | Second overwrites first (no version check) — demonstrate silent field loss (F3) | n/a (documented weakness) |
| R6 | Concurrent draft→confirmed edit and new create, same room/dates | Both enforce availability under room locks (`actions.ts:436,467`); exactly one wins | Both blocking reservations commit |
| R7 | Kill worker between import-commit and ACK; re-pull | `already` + re-ack sweep; no second reservation | Duplicate reservation or lost revision |
| R8 | Closure create concurrent with reservation create on same room/dates | Serialized on room row; loser conflicts (`calendar/actions.ts:40-47`) | Closure and blocking stay coexist on same night |
| R9 | Direct SQL INSERT into reservation_rooms overlapping an existing blocking stay (simulating a lockRooms-bypassing path) | **Commits silently — no DB guard** (proves F1); Q6 self-join then detects it | n/a (this is the point) |

All of these must run on the disposable test DB (:5433 / guesthub-testdb clone), never on :5432.

---

## 4. Findings

| # | Severity | Description | Evidence |
|---|---|---|---|
| F1 | **High** (defense-in-depth gap; no active violation) | No database-level double-booking guard: no exclusion constraint / unique range index / advisory lock on `reservation_rooms(room_id, [check_in,check_out))`. Overbooking prevention rests entirely on the app contract "lockRooms then check in the same tx" (D34). Every current product path complies, but any bypass (future code, admin SQL, scripts) writes overlaps silently. Racing insert paths if the contract is skipped: `actions.ts:268` (create), `actions.ts:516` (edit-insert), `booking-import.ts:611` (OTA), `actions.ts:505/867` (updates). Recommend `btree_gist` + `EXCLUDE USING gist (room_id WITH =, daterange(check_in, check_out) WITH &&)` restricted to blocking statuses (needs a mirrored status/active flag on rr or a trigger, since status lives on the parent). | `004:71-72` (contract is a comment, not a constraint); live `pg_constraint` on snapshot: only CHECK/PK/FK; Q6 overlap count 0 |
| F2 | **Medium** | `channel_inventory_holds` is dead scaffolding: designed in `005:199-223` ("unassigned lane"), counted by `room_type_inventory()` (`005:323-343`), rendered by the calendar (`calendar/data.ts:85-92`) — but **no product code ever inserts a hold** (repo-wide grep; snapshot count 0). Consequence: an OTA booking that cannot be applied (unmapped/conflict) quarantines and consumes **no** local inventory while the OTA regards it as confirmed → window for local overbooking against the channel until an operator resolves the quarantine. Also latent divergence: `sellable_unit_inventory()` (ARI) deliberately ignores holds (`009:150-151`), so if holds ever start being written, outbound availability and local counts disagree. | grep: only read sites; `booking-import.ts` quarantines instead of holding |
| F3 | **Medium** | No optimistic concurrency on reservation edit: `updateReservationAction` takes `FOR UPDATE` and then applies the client's full form; a second operator's save silently overwrites the first's committed changes (guest fields, rooms, prices) with stale data. No version column / updated_at compare / conflict error. | `actions.ts:355-364, 536-558`; comment `:368-371` covers only the status field |
| F4 | **Low** | `lockRooms` does not sort room ids (`[...new Set(roomIds)]` preserves caller order), and lock ordering differs across paths (create: rooms→tenant, `actions.ts:214→152`; OTA import: reservation→rooms→tenant, `booking-import.ts:505→514→566`; several settings/card actions take the tenant row first, e.g. `card-actions.ts:155`). Concurrent multi-room/cross-path writes can deadlock; Postgres aborts one with the generic "אירעה שגיאה בלתי צפויה" — safe but user-hostile and retry-less. | `inventory.ts:44`; paths cited |
| F5 | **Low** | `allocateReservationNumber` = tenant-row `FOR UPDATE` + `MAX(number)+1` (`actions.ts:151-157`, duplicated at `booking-import.ts:297-303`): serializes **all** reservation creation per tenant (throughput ceiling; every OTA import contends with every manual create) and MAX+1 on a regex over free-text numbers is fragile if formats ever mix. Unique `(tenant_id, reservation_number)` backstop exists (`000:245`). | cited |
| F6 | **Low** | Reschedule recomputes the parent total/balance with inline SQL (`actions.ts:882-893`) instead of `recomputePaymentAggregates` used by create/update (`actions.ts:289,568`) — a second formula for the same aggregates. Currently consistent with `reservationTotal` (`reservation-pricing.ts:314-320`), but it is exactly the D51 "divergent formulas" class of bug waiting to re-happen. | cited |
| F7 | **Low** (operational) | 25 quarantined revisions in the snapshot (8 "same room twice overlapping" — channel-side data corruption; 7 missing Room Type id; several genuine local conflicts). Designed behaviour, but each is an OTA-confirmed booking not on the local calendar; needs operator resync workflow visibility (Q6). | snapshot query |
| F8 | **Info** (by design, flag for ops) | An OTA modification rewrites the stays of a `checked_in` reservation (rows deleted+reinserted to channel dates/rooms; only the status is preserved) — can "move" an in-house guest if no conflict; recorded as an external date change. Deliberate (channel truth, D82) but worth surfacing prominently in the UI. | `booking-import.ts:459, 540-563, 654-671` |
| F9 | **Positive** | Idempotent OTA pipeline is exemplary: persist-then-quarantine (nothing lost on feed expiry), UNIQUE revision + UNIQUE external-booking identity, apply+mark in one tx, ACK strictly post-commit with a structurally-gated `markRevisionAcknowledged`, ambiguous-ack re-convergence. Cancel-never-delete with on-row provenance; audit writes in-tx on every path; committed-only NOTIFY. | §1.6, §2 Q4 |

---

*Agent F — read-only audit; no product code, DB rows, or services were modified.*
