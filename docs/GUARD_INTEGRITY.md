# GUARD_INTEGRITY — which green ticks in this repo can be believed

Stabilization run, **phase 2, target 2.8**. Branch `stab/guard-integrity-sweep`,
worktree `/var/www/wt-g28`, base `origin/main` = **`8494385`**
(the baseline handed to this target was measured at `5b171bd`; PRs #112, #113
and #114 landed in between and added three `check:*` scripts — 63 → **66**).

Production was never read, written, deployed to or pointed at. Every DB-backed
run in this document targeted `guesthub-testdb` (:5433) or
`guesthub_staging` (127.0.0.1:5434).

---

## 0. The verdict in one paragraph

Of 66 `check:*` entries, **41 are green, 11 are red, 3 exit 2 without running,
10 abort on a missing production env file and 1 is an aggregate of four of
those**. That is the *arithmetic*. The *integrity* picture is worse and is the
point of this document: **seven guards that touch money all stay GREEN while
`recomputePaymentAggregates` is neutered so that every reservation's
`paid_amount` becomes 0** (§4.1). Four more were only ever green because some
earlier guard had built a schema for them (§3.1). Three had never executed a
single assertion (§3.3). A "all checks green" claim on this repo is, today, not
a statement about the system.

---

## 1. How to read the table

| column | meaning |
|---|---|
| **runs at all** | does the entry reach its first assertion in a clean worktree? |
| **target env** | what the guard actually reads. `pure` = source text / in-process only |
| **A** | experiment A — red against the defect it exists to catch |
| **B2** | experiment B2 — red when the CENTRAL PREDICATE is semantically neutered while every name, import, call site and string literal stays in place |

`—` in **A**/**B2** means **not tested by me**. It is not a pass. §5 says
exactly how many rows were B2-tested and which were not.

Assertion classes used below follow the phase-2 standard: **BEHAVIOUR** (a value
read back from the database after real code ran) ranks above **CONTRACT**
(source text / structure). A guard made only of CONTRACT assertions cannot pass
B2 by construction — a structure-preserving neutering is invisible to it.

---

## 2. The table — all 66 entries

Exit codes are from a single sweep on `8494385`, each guard run **standalone**
with `DROP SCHEMA guesthub CASCADE` executed over the owner connection
immediately before it (`sweep.sh`, 55 runs). The ten production-wired entries
were **not run** (iron rule 11) — their status is derived from `package.json`
plus the fact that `.env.local` exists only in the production runtime tree.

### 2.1 Money · cards · inventory · channel (the priority band)

| guard | runs | target env | exit | A | B2 | notes |
|---|---|---|---|---|---|---|
| `check:payments` | yes | pure (source text) | 0 | — | **FAIL** | §4.1. Pure grep suite; its own header says "No DB required". A structure-preserving neutering of `recomputePaymentAggregates` leaves it green. |
| `check:payment-ledger-integrity` | yes | staging :5434 | 0 | — | **FAIL** | §4.1. Reads staging rows only. Green while the shipped recompute is dead. |
| `check:payment-refund-void` | **NO → yes** | disposable :5433 | **2 → 0** | — | **FAIL** | §3.3 + §4.1. Had NEVER run. Now runs (5 assertions) — but it re-implements the ledger recompute in its own SQL and never calls the shipped one. |
| `check:pms-domain-invariants` | yes | staging :5434 | 0 | — | **FAIL** | Green under the same money neutering. Data-conformance monitor, not a code guard. |
| `check:timezone-and-money-invariants` | yes | staging :5434 | 0 | — | **FAIL** | Same. |
| `check:pricing-engine` | yes | testdb :5433 (own chain replay) | 0 | — | — | Self-contained: replays all 56 migrations itself. Not B2-tested. |
| `check:pricing-equality` | yes | testdb :5433 (own chain replay) | 0 | — | — | Self-contained. Not B2-tested. |
| `check:room-pricing` | yes | pure | 0 | — | — | Not B2-tested. |
| `check:cards` | yes | pure | **1** | — | — | Red on main. **Fixed on `stab/guard-cards-pci`** — verified by me: that branch's script exits **3** ("registered deviation") on clean `origin/main` src, with 93 assertions labelled CONTRACT. |
| `check:channel-card-ingest` | **NO → yes** | disposable :5433 | **1 → 0** | — | **PASS** | §3.1+§3.2 fixed here. B2: `redactPayload` neutered (name, `SENSITIVE_KEY_RE`, call site and `"[redacted]"` all intact) → **RED**, a plaintext PAN survives in the stored payload. |
| `check:no-secrets` | yes | filesystem + git | 0 | **FAIL** | — | Green over a live exposure. **Fixed on `stab/guard-no-secrets-filesystem`** — verified by me: that branch's script exits **1 with 6 OBSERVED failures** against the real, unfixed state (world-readable backup tarballs carrying credential members). |
| `check:reservation-concurrency` | **NO → yes** | disposable :5433 | **2 → 0** | — | **PASS** | §3.3. Had NEVER run. B2: the `rr_set_blocking()` trigger predicate neutered (column, trigger, constraint name and the `EXCLUDE USING gist` clause all intact) → **RED** on "overlapping blocking insert was NOT rejected". |
| `check:inventory-integrity` | yes | staging :5434 | 0 | — | — | Reads staging rows. A code or migration neutering is not observable to it. |
| `check:maintenance-closures` | yes | staging :5434 | 0 | — | — | Same. |
| `check:calendar-departure-edge` | **NO → yes** | disposable :5433 | **1 → 0** | — | **PASS** | §3.1 fixed here. B2: an extra `AND rr.check_out <> ${from}` added to `getCalendarData` **below** the grepped literal, so assertion 1 (CONTRACT) still passes → **RED** on assertion 2, "departing-on-from stay is fetched" (BEHAVIOUR). |
| `check:beds24-cancellation-sync` | **NO → yes** | disposable :5433 | **1 → 0** | **PASS** | **PASS** | My target. Four printed runs in §6. |
| `check:beds24-checkin-cancellation-guard` | **NO** | shared :5433 (assumed schema) | **1** | — | — | **Same §3.1 defect, NOT FIXED — iron rule 6 reserves this file.** Crashes at line 135 on `relation "guesthub.tenants" does not exist`. Patch in §7. |
| `check:beds24-payload-integrity` | yes | dedicated :5433 `guesthub_payload_check` | 0 | — | — | The reference pattern (PR #114) my fix generalises. One residual: it never issues `CREATE DATABASE`, so it still assumes that database exists. |
| `check:background-job-recovery` | **NO → yes** | disposable :5433 | **2 → 0** | — | **FAIL** | §3.3. Had NEVER run; now 9 assertions. But it *copies* the claim predicate out of `queue.ts` into its own SQL — it executes no `src/` code. |
| `check:channel-security` | yes | pure | 0 | — | — | Not B2-tested. |
| `check:channel-chaos` | yes | pure | 0 | — | — | Not B2-tested. |
| `check:channels-badge` | yes | pure | **1** | — | — | Red on main: expects the channel key set `[airbnb, booking, expedia, site]`, code ships `[airbnb, booking, expedia, manual, site]`. Stale assertion, D107. |
| `check:channels-fullsync-ui` | yes | pure | 0 | — | — | Not B2-tested. |
| `check:beds24-connection` | **NO** | **PRODUCTION** `.env.local` | 9 | **FAIL** | **FAIL** | Exit 9 in every worktree and every CI runner. **Rebuilt on `stab/guard-beds24-four-b2`** — verified by me: 16 assertions, exit 0, no `.env.local`. |
| `check:beds24-jobs` | **NO** | **PRODUCTION** | 9 | **FAIL** | **FAIL** | Same. Rebuilt: 11 assertions, exit 0, verified. |
| `check:beds24-revisions` | **NO** | **PRODUCTION** | 9 | **FAIL** | **FAIL** | Same. Rebuilt: 14 assertions, exit 0, verified. |
| `check:beds24-ari` | **NO** | **PRODUCTION** | 9 | **FAIL** | **FAIL** | Same, and its rebuilt version proves the old one printed `2 PASSED` **on an empty database**. Rebuilt: 10 assertions, exit 0, verified. |
| `check:beds24` | **NO** | **PRODUCTION** | 9 | n/a | n/a | Aggregate of the four above. Inert wherever they are. |
| `check:beds24-credit-headers` | **NO** | **PRODUCTION** | 9 | — | — | New in PR #113. Same `--env-file=.env.local` defect as the other nine. |
| `check:inventory` | **NO** | **PRODUCTION** | 9 | **FAIL** | **FAIL** | **Detached on `stab/guard-inventory-staging`**; that branch also proves the guard never calls `checkRoomAvailability` — the double-booking path can be deleted and it stays green. |
| `check:effective-state` | **NO** | **PRODUCTION** | 9 | — | — | Detached on the same branch. |
| `check:rate-grid` | **NO** | **PRODUCTION** | 9 | — | — | Detached on the same branch. |
| `check:sellability` | **NO** | **PRODUCTION** | 9 | — | — | Detached on the same branch. Its own header always said `.env.test`; `package.json` said `.env.local`. |
| `check:hydration-browser` | **NO** | **PRODUCTION** + real Chrome | 9 | — | — | Needs a running staging app + credentials. |

### 2.2 Everything else

All green standalone on `8494385` unless the exit column says otherwise. None
were B2-tested (§5) — this is the "believe with care" band.

| guard | runs | target env | exit | notes |
|---|---|---|---|---|
| `check:agents-concurrency` | yes | pure (two greps) | 0 | Guards CLAUDE.md/AGENTS.md, D90. |
| `check:business-profile` | yes | pure | 0 | |
| `check:calendar` | yes | pure (AST) | **1** | Red on main: `actions.ts must not import @/lib/channel/beds24-http`. **Diagnosed STALE on `stab/guard-calendar-scope`** — verified by me: that branch's script exits **0** on clean `origin/main` src. |
| `check:calendar-ui` | yes | pure | **1** | Red on main. **Fixed on `stab/guard-calendar-scope`** — verified by me: exits **0** on clean `origin/main` src. |
| `check:check-in-check-out` | yes | pure | 0 | |
| `check:check-in-check-out-db` | yes | testdb (own chain replay) | 0 | Self-contained. |
| `check:code-documentation` | yes | pure | 0 | |
| `check:commercial` | yes | pure | 0 | |
| `check:commercial-db` | yes | testdb (own chain replay) | 0 | Self-contained. |
| `check:datepicker` | yes | pure | 0 | |
| `check:db-isolation` | yes | staging :5434 | 0 | Resolves `CHECK_DB_URL \|\| STAGING_DATABASE_URL` — the idiom the other guards should copy. |
| `check:design` | yes | pure | **1** | 6 violations, all in `src/app/housekeeping/my-tasks/MyTasksScreen.tsx`, a **frozen** screen (STATE.md). Red for a real but out-of-scope reason. |
| `check:e2e-safety` | yes | pure | 0 | |
| `check:guest-communications` | yes | pure (3 scripts) | 0 | |
| `check:guest-communications-db` | **NO** | shared :5433 (assumed schema) | **1** | §3.4 — diagnosed here, **not fixed**. |
| `check:housekeeping` | yes | staging :5434 | 0 | |
| `check:israel-market` | yes | staging :5434 | 0 | |
| `check:maps-picker` | yes | pure | 0 | |
| `check:messaging` | yes | pure | 0 | |
| `check:performance` | yes | staging :5434 | 0 | |
| `check:rate-plans` | yes | testdb (own chain replay) | 0 | Self-contained. |
| `check:rates-ui` | yes | pure | 0 | |
| `check:reports` | yes | staging :5434 | 0 | |
| `check:reservation-snapshot` | yes | pure | 0 | |
| `check:reservations-ui` | yes | pure | 0 | |
| `check:retention` | yes | staging :5434 | 0 | |
| `check:room-db` | yes | testdb (own chain replay) | 0 | Self-contained. |
| `check:room-identity` | yes | testdb (own chain replay) | 0 | Self-contained. |
| `check:settings-regression` | yes | pure | 0 | |
| `check:status-default` | yes | pure | 0 | |
| `check:su-lifecycle` | yes | testdb (own chain replay) | 0 | Self-contained. |
| `check:supply-chain` | yes | `pnpm audit` | **1** | 5 high advisories, 0 critical. Real, unfixed. |

---

## 3. The three integrity defects this target was asked to record

### 3.1 Guards whose green was a property of the RUN ORDER — **FIXED (4 of 5)**

`check:beds24-cancellation-sync`, `check:calendar-departure-edge`,
`check:channel-card-ingest` and `check:beds24-checkin-cancellation-guard` all
opened the **shared** `postgres://…@localhost:5433/postgres` and queried
`guesthub.tenants` immediately. They never built the schema. Measured
standalone after a `DROP SCHEMA guesthub CASCADE`:

```
PostgresError: relation "guesthub.tenants" does not exist
    at …/check-beds24-cancellation-sync.mjs:115   code: '42P01'
    at …/check-calendar-departure-edge.mjs:85     code: '42P01'
    at …/check-channel-card-ingest.mjs:79         code: '42P01'
    at …/check-beds24-checkin-cancellation-guard.mjs:135  code: '42P01'
```

Fixed here for the first three (the fourth is reserved by iron rule 6, §7) by
`scripts/lib/check-disposable-db.mjs`: each guard names a database **it owns**
on the isolated test server; the helper creates it and replays all 56 migrations
into it over the owner connection when the `guesthub` schema is absent.

### 3.2 `check:channel-card-ingest` needed a tenant row someone else had left — **FIXED**

It ran `SELECT id FROM guesthub.tenants LIMIT 1` and used whatever came back. It
now inserts its own tenant inside the rolled-back transaction.

### 3.3 Three guards had NEVER run — **FIXED**

`check:reservation-concurrency`, `check:payment-refund-void` and
`check:background-job-recovery` exited **2** with "need CHECK_CONCURRENCY_DB_URL
(a disposable DB)". Nothing in the repo ever set that variable, so between them
**18 assertions covering double-booking, refund/void money arithmetic and the
job-queue claim predicate had never executed once.** They now default to a
database they own; `CHECK_CONCURRENCY_DB_URL` still wins when set, and the
fail-closed production checks are unchanged and strengthened (see §8).

### 3.4 A fourth, found during the sweep — `check:guest-communications-db`, **NOT FIXED**

It reapplies migration **036 alone** into the shared DB and so needs 000–035
already present:

```
ERROR:  relation "reservations" does not exist
Command failed: docker exec -i guesthub-testdb psql -U postgres -d postgres … < db/migrations/036_guest_communications.sql
```

I attempted the same fix and **reverted it**, because it is not cheap and the
half-fix would have been a lie:

1. giving it its own database moves the failure to
   `ERROR: must be owner of table reservations` — `docker exec … psql -U postgres`
   cannot replay 036 into a database whose `guesthub` schema was created by
   `supabase_admin`. (Moving the replay onto the owner connection via
   `sql.unsafe(...).simple()` fixes that part.)
2. the next failure is the real one: assertion 4, *"the seeded automation is born
   a draft"*, compares `[]` to `['draft']`. 036 seeds per tenant **and only for a
   tenant that already owns a published `booking_confirmation` template**, which
   an earlier migration creates for tenants existing **at chain-replay time**.
   Seeding a tenant afterwards produces nothing, and the assertion becomes a
   comparison of two empty sets — i.e. **it is vacuous today on the shared DB
   too, whenever the shared DB happens to hold no such tenant.**

**Remedy (not implemented):** `ensureDisposableSchema` needs a
`seedBeforeReplay` hook so the tenant exists before migration 000 runs. Then
assertion 4 has something to be true about. Do not "fix" this guard by relaxing
assertion 4.

---

## 4. What B2 actually found

### 4.1 The headline: the money guards do not guard money

Central predicate neutered — `recomputePaymentAggregates` in
`src/lib/payments/ledger.ts`, the ONE place `paid_amount` and `balance` are
derived. Two neuterings were run; the second is the strict one, in which **every
literal any guard greps for survives verbatim**:

```diff
-      WHERE reservation_id = ${reservationId} AND tenant_id = ${tenantId}
+      WHERE reservation_id = ${reservationId} AND tenant_id = ${tenantId} AND false
```

Effect: every reservation's `paid_amount` becomes 0 and `balance` becomes the
full `total_price`. Every guest looks unpaid. Result:

| guard | verdict |
|---|---|
| `check:payments` | **GREEN** |
| `check:payment-ledger-integrity` | **GREEN** |
| `check:payment-refund-void` | **GREEN** |
| `check:pms-domain-invariants` | **GREEN** |
| `check:timezone-and-money-invariants` | **GREEN** |
| `check:reservation-snapshot` | **GREEN** |
| `check:commercial` | **GREEN** |

Seven for seven. The looser first neutering (`FILTER (WHERE status = ${COLLECTED_PAYMENT_STATUS} AND false)`)
was caught by `check:payments` — but only because its regex
`SUM\(amount\) FILTER \(WHERE status = \$\{COLLECTED_PAYMENT_STATUS\}\)` stopped
matching. That is a CONTRACT catch: it detects an edit to the *text*, not a
change in the *money*.

**No guard in this repo executes `recomputePaymentAggregates` and reads the
result back.** `check:payment-refund-void` comes closest and re-implements it
instead. Open work: a behavioural money guard that calls the shipped function.

### 4.2 The guards that DO pass B2

| guard | neutering | result |
|---|---|---|
| `check:beds24-cancellation-sync` (after my fix) | `applyCancellation`'s release branch gated behind `RELEASE_ON_CANCEL = false` | **RED** — `actual: 'confirmed', expected: 'cancelled'` |
| `check:reservation-concurrency` (after my fix) | `rr_set_blocking()` predicate → `false AND (…)` | **RED** — "overlapping blocking insert was NOT rejected" |
| `check:calendar-departure-edge` (after my fix) | extra `AND rr.check_out <> ${from}` below the grepped literal | **RED** — "departing-on-from stay is fetched" |
| `check:channel-card-ingest` (after my fix) | `redactPayload` gated behind `REDACT_ENABLED = false` | **RED** — plaintext PAN survives in the stored payload |

Every one of these was `tsc`-clean and passed the harness structural-signs check
(`OK — no identifier disappeared`).

### 4.3 A correction to the shared harness's own note

`b2harness.sh` states that the guards' `docker exec … psql -U postgres` replay
"hits *permission denied for schema guesthub* from 005 onward on a genuinely
empty schema". **Measured: it does not.** After
`DROP SCHEMA guesthub CASCADE` over the owner connection, `check:pricing-engine`,
`check:room-identity`, `check:su-lifecycle`, `check:commercial-db`,
`check:rate-plans`, `check:room-db` and `check:check-in-check-out-db` all replay
the chain as `postgres` and exit 0 — because whoever runs `CREATE SCHEMA guesthub`
first becomes its owner. The ownership failure is real but conditional: it
appears when the schema was created by `supabase_admin` and is then written by
`postgres` (§3.4, step 1). Both notes matter; the harness's is too broad.

---

## 5. Coverage — stated exactly, because a silent cap is a lie

- **66** `check:*` entries exist on `8494385`.
- **55** were executed by me, standalone, each after an owner-connection
  `DROP SCHEMA guesthub CASCADE`. Exit codes in §2.
- **10** were NOT executed: the `--env-file=.env.local` production-wired set
  (`beds24-ari`, `beds24-connection`, `beds24-credit-headers`, `beds24-jobs`,
  `beds24-revisions`, `effective-state`, `hydration-browser`, `inventory`,
  `rate-grid`, `sellability`). Iron rule 11 forbids pointing a guard at
  production; they abort on the missing env file anyway.
- **1** is an aggregate (`check:beds24`).
- **B2-tested by me: 12 guards.** Four passed (§4.2), seven failed (§4.1), and
  `check:beds24-cancellation-sync` failed before my change and passed after.
- **B2 NOT tested by me: 54 guards.** Why: B2 is not automatable — each one needs
  its own central predicate identified, a compiling semantic neutering written,
  and a run. At roughly 10–20 minutes each that is 12–18 hours. I spent the
  budget on the priority band the brief named (money, inventory, cards, channel)
  and on making 6 guards run at all. **Every `—` in the A/B2 columns is
  untested, not passed.**
- **16 rows are folded in from targets 2.1–2.7 and are marked as such.** I did
  not take their word for it: I extracted each sibling branch's script with
  `git show <branch>:<path>` and ran it inside a clean `origin/main` worktree.
  Verified live: `check-cards.mjs` → exit 3; `check-no-secrets.mjs` → exit 1 with
  6 OBSERVED failures; `check-calendar.mjs` → exit 0; `check-calendar-ui.mjs` →
  exit 0; the four rebuilt Beds24 health checks → exit 0 with 16/11/14/10
  assertions and **no `.env.local`**. Their B2 records I read but did not re-run.

---

## 6. My target's four experiments — `check:beds24-cancellation-sync`

### A (before) — clean `origin/main`, identity verified

```
$ git rev-parse origin/main
84943858c46bb5486d907df03d7af0d032d84e2e
$ git diff --stat origin/main -- src/                                  (empty)
$ git status --porcelain src/                                          (empty)
$ git status --porcelain -- scripts/check-beds24-cancellation-sync.mjs (empty)

NOTICE:  schema "guesthub" does not exist, skipping
testdb guesthub tables after reset: 0
----- running check:beds24-cancellation-sync -----
PostgresError: relation "guesthub.tenants" does not exist
    at …/scripts/check-beds24-cancellation-sync.mjs:115:29   code: '42P01'
----- exit=1 -----
```

RED — but it never reached an assertion.

### B2 (before) — same guard, `applyCancellation` semantically neutered

```diff
-  if (existing.status !== "cancelled") {
+  const RELEASE_ON_CANCEL: boolean = false; // B2 NEUTERING — semantic only
+  if (existing.status !== "cancelled" && RELEASE_ON_CANCEL) {
```

```
   OK — no identifier disappeared; the neutering is semantic.
tsc -p tsconfig.worker.json --noEmit  exit=0
----- running check:beds24-cancellation-sync -----
PostgresError: relation "guesthub.tenants" does not exist   code: '42P01'
----- exit=1 -----

=== IS THE NEUTERED RUN DISTINGUISHABLE FROM THE HEALTHY RUN? ===
NO DIFFERENCE — output byte-identical with and without the defect
```

**FAILED B2.** An unconditional red carries no more signal than an
unconditional green.

### A (after) — clean `origin/main` src, identity verified

```
$ git rev-parse origin/main
84943858c46bb5486d907df03d7af0d032d84e2e
$ git diff --stat origin/main -- src/     (empty)
$ git status --porcelain src/             (empty)
$ git diff --stat origin/main
 scripts/check-beds24-cancellation-sync.mjs | 24 +++++++++++++++---------

NOTICE:  database "guesthub_cancel_sync_check" does not exist, skipping
shared testdb guesthub tables: 0   (the old crash condition still holds)
----- running check:beds24-cancellation-sync -----
check-beds24-cancellation-sync: disposable DB localhost:5433/guesthub_cancel_sync_check — created, migrations replayed, 63 tables
✓ 1. static: repeated status params (incl. cancelled) on both window pulls
✓ 2. cycle 1: three live bookings imported as confirmed reservations
✓ 3. cycle 2: source cancellation lands and releases inventory within ONE pull cycle
✓ 4. wire proof: the incremental window carries repeated status params incl. cancelled
✓ 5. reconciliation: a window-missed cancellation is released through the canonical path + loud audit
✓ 6. checked-in guard: no auto-release, a loud operator alert instead
✓ 7. zero cancelled-at-source reservations still occupy inventory (the 1021 invariant)
check-beds24-cancellation-sync: all 7 assertions passed
----- exit=0 -----
```

GREEN is the correct result here — clean `origin/main` **is** the fixed state
(D93 shipped in `3e9a451`). The RED-under-A proof is the run below.

### A′ (after) — the guard against the PRE-D93 code it exists to catch

```
$ git log --oneline -1 0d5cb2b
0d5cb2b Merge pull request #101 from Ronus922/fix/calendar-departure-edge
$ git checkout 0d5cb2b -- src/lib/channel/beds24-booking-import.ts
$ git diff --stat 0d5cb2b -- src/lib/channel/beds24-booking-import.ts   (empty — we ARE at pre-D93)
$ git diff --stat origin/main -- src/
 src/lib/channel/beds24-booking-import.ts | 131 +----------------  4 insertions(+), 127 deletions(-)

----- running check:beds24-cancellation-sync (PRE-D93 src) -----
AssertionError: the exported status list includes cancelled
  expected: /BEDS24_STATUS_FILTER = \["confirmed", "new", …, "cancelled", …\]/
----- exit=1 -----
```

RED. Honest caveat: this is the guard's **CONTRACT** assertion 1 firing first
and short-circuiting the behavioural half. The behavioural proof is B2 below.

### B2 (after) — same semantic neutering as B2 (before)

```
--- the neutering diff ---
-  if (existing.status !== "cancelled") {
+  const RELEASE_ON_CANCEL: boolean = false; // B2 NEUTERING — semantic only
+  if (existing.status !== "cancelled" && RELEASE_ON_CANCEL) {

   OK — no identifier disappeared; the neutering is semantic.
--- imports still present --- 12
tsc exit=0
----- running check:beds24-cancellation-sync (NEUTERED) -----
AssertionError [ERR_ASSERTION]: released in the same cycle
+ actual   - expected
+ 'confirmed'
- 'cancelled'
    at …/scripts/check-beds24-cancellation-sync.mjs:170:10
----- exit=1 -----
```

**PASSES B2.** The guard tests behaviour, not text.

No `src/` file is modified or staged by this branch — every neutering was
reverted with `git checkout HEAD -- <file>` and `git status --porcelain src/`
verified empty afterwards.

---

## 7. BLOCKERS — recorded here because I could not record them where they belong

1. **No `check:*` script could be registered in `package.json`.** Iron rule 6
   reserves it for `fix/beds24-checkin-cancellation-guard` (PR #112). *(That PR
   has in fact already merged — `c93b401` is in `origin/main` — but the rule
   names the file, so I obeyed it.)* Nothing on this branch needs a new entry:
   all six guards I changed already have one. But the same rule blocks
   `DECISIONS.md`, which is why this document exists.

2. **`scripts/check-beds24-checkin-cancellation-guard.mjs` is reserved by the
   same rule and carries the §3.1 defect unfixed.** It is red standalone. The
   patch, ready to apply, is three lines — identical to the one applied to its
   sibling:

   ```diff
   +import { disposableDsn, ensureDisposableSchema } from "./lib/check-disposable-db.mjs";
   -const TEST_URL = process.env.TEST_DATABASE_URL
   -  || "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
   +const TEST_URL = disposableDsn({
   +  dbName: "guesthub_checkin_cancel_check",
   +  envVars: ["TEST_DATABASE_URL"],
   +  label: "check-beds24-checkin-cancellation-guard",
   +});
   +await ensureDisposableSchema({ dsn: TEST_URL, label: "check-beds24-checkin-cancellation-guard" });
   ```

3. **Nothing runs any of this automatically.** There is no `.github/` directory.
   Every verdict in this document is a verdict about a command a human has to
   remember to type.

---

## 8. What this branch changed

| file | change |
|---|---|
| `scripts/lib/check-disposable-db.mjs` | **new.** `disposableDsn()` + `ensureDisposableSchema()`: a guard names a database it owns; the helper creates it and replays all 56 migrations over the owner connection when the schema is absent. Fail-closed on production markers and on loopback `:5432`. Credentials are never printed — only `host:port/database`. |
| `scripts/check-beds24-cancellation-sync.mjs` | owns `guesthub_cancel_sync_check` |
| `scripts/check-calendar-departure-edge.mjs` | owns `guesthub_calendar_edge_check` |
| `scripts/check-channel-card-ingest.mjs` | owns `guesthub_card_ingest_check`; seeds its own tenant |
| `scripts/check-reservation-concurrency.mjs` | owns `guesthub_concurrency_check`; `CHECK_CONCURRENCY_DB_URL` still wins |
| `scripts/check-background-job-recovery.mjs` | owns `guesthub_jobrecovery_check` |
| `scripts/check-payment-refund-void.mjs` | owns `guesthub_refundvoid_check` |
| `docs/GUARD_INTEGRITY.md` | this file |

**No assertion was weakened, removed or skipped.** The six guards run the same
assertions they always did; they now reach them. Net: 18 assertions that had
never executed (4 + 9 + 5), plus 16 named assertions that only executed by luck
of ordering (7 + 9) and the whole `check:channel-card-ingest` suite, now execute
from a cold, empty test server:

```
=== clean slate: shared schema tables=0, own DBs dropped ===
check:beds24-cancellation-sync exit=0
check:calendar-departure-edge  exit=0
check:channel-card-ingest      exit=0
check:reservation-concurrency  exit=0
check:background-job-recovery  exit=0
check:payment-refund-void      exit=0
```

The production fail-closed checks got *stronger*, not weaker: the old inline
guard only rejected loopback `:5432`; `assertDisposable()` also rejects the
four production hostname markers and refuses a remote maintenance database.

---

## 9. Open work, in priority order

1. **A behavioural money guard.** Nothing calls `recomputePaymentAggregates` and
   reads the result back (§4.1). This is the largest single hole found.
2. **B2 the other 54.** Especially `check:pricing-engine`,
   `check:pricing-equality`, `check:room-identity` and `check:su-lifecycle` —
   self-contained and DB-backed, so they are the cheapest to test and the most
   likely to be real.
3. **`check:guest-communications-db`** — §3.4, needs `seedBeforeReplay`.
4. **`check:beds24-checkin-cancellation-guard`** — §7.2, patch ready.
5. **Merge the phase-2 sibling branches.** Sixteen rows in §2 are "fixed on a
   branch". Until they merge, `main`'s guard set is the broken one.
6. **CI.** Until then, §7.3 stands: none of this is enforced.

---

## 10. Closure run, 2026-07-25 — six gaps embedded, and the B2 tally

Recorded by the closure run that merged the nine open PRs and deployed
`main = 43f0d32`. Source: `docs/GUARD_GAPS_PENDING.md` (branch
`docs/closure-2026-07-25`), which this section supersedes. Everything below was
measured, not inferred.

### 10.1 `unmappedRooms` cannot see a room with no mapping row at all

`src/lib/channel/beds24-ari-payloads.ts:196-199`. The counter counts EXISTING
mappings that lack a rate plan. A room with no row in
`channel_beds24_room_mappings` never enters the `mappings` array, so it is never
counted and appears in no summary. **A room that was never mapped looks exactly
like a room with nothing to publish.**

*Evidence:* 1318 was the only real room not being distributed until 2026-07-25
11:58, and `unmappedRooms` reported 0 the whole time.

*Fix:* a coverage assertion — every active `rooms` row on the connection must
have a mapping row, or be counted explicitly as `roomsWithNoMapping`.

### 10.2 `check:beds24-ari` passes over 22 ranges marked `synced` that sent nothing

`scripts/check-beds24-ari.mjs:19-26`. Twenty-two ranges for 1318
(revisions 834→1606) closed `synced` before the room was mapped — not one byte
left the process. The guard is green. It also filters `cc.state = 'active'`, so
**66 pending channex ranges** on a paused connection fall to an informational
"note" line instead of being counted.

*Fix:* assert on `status = 'synced'` together with `sent_values = 0`.
`check:beds24-payload-integrity` (#114) covers the live case — "no range is
synced by a drain that sent nothing" — but not the historical debt.

### 10.3 No guard on `succeeded` without `sentValues` — "mapped but silent"

`src/lib/channel/worker.ts:157` returns `{ sentValues: 0 }` **silently** when the
connection is not drainable, and a drain with no rows returns an empty summary.
Both are recorded `succeeded` and are indistinguishable afterwards.

*Evidence:* ledger rows from 2026-07-25 12:18–12:19 show `claimed:1,
sentValues:0` beside `claimed:1, sentValues:1` — both `succeeded`.

*Fix:* assert against `channel_evidence_ledger` on `claimed > 0 AND
sentValues = 0` with no declared reason. This is now also rule 2 in AGENTS.md.

### 10.4 #104's guard leaned on a grep — **fixed, and proven fixed**

The old `scripts/check-beds24-credit-backoff.mjs:56-58` was
`assert.ok(!httpSrc.includes("fivemincreditlimit"), ...)` — a static grep over
ONE file. It stayed green across 223 evidence rows carrying
`creditsRemaining = NULL`, and could never have caught the name moving to
another file.

**Status: ✅ replaced** by four behavioural assertions through the real
`beds24Request`. Proven by B2: reintroducing the old names as aliases **in a
different file** (`beds24-credits.ts`) turns the new guard red, and would have
left the grep green. Merged in #104/#105, live on `main` since 43f0d32.

### 10.5 #110's guard is not self-contained — iron rule 11

`scripts/check-booking-com-reports.mjs:194` applies migration `055` only, and
assumes the rest of the schema exists, is owned by a role `postgres` can create
in, and that the table it creates will belong to it.

*Evidence — it failed twice in one run, both environmental:*
```
ERROR:  permission denied for schema guesthub
ERROR:  must be owner of table booking_channel_reports
```
#110's code was correct both times; what changed was role ownership in the
shared DB after another guard ran first. After replaying the chain under one
role: 18/18 green.

**What this means: the guard's result depends on the order other guards ran in.
Green does not prove the migration is idempotent — it proves the role happened
to fit.**

*Fix:* a dedicated DB plus an `ensureSchema()` that replays `db/migrations` in
`manifest.txt` order, the way `check:beds24-payload-integrity` (#114) does.

### 10.6 `ref/` is gitignored and poisons a local build

`.gitignore:54` — `/ref/`. #110's build in a reused worktree failed with
`Type error: Property 'externalUniqueId' is missing` in
`ref/proof/render/entry.tsx`: an **untracked, gitignored** leftover that is not
part of #110 and not in the repo. Next picks it up because it sits inside the
project tree. In a clean tree #110 builds green.

**Operational conclusion: a local build in a worktree somebody has been working
in is not evidence** — exactly what CLAUDE.md says about isolated verification.

### 10.7 The B2 tally for this run

| guards subjected to B2 | mutations applied | stayed green (vacuous) |
|---|---|---|
| 7 | 10 | **0** |

Six new guards arrived with the merge — `check:beds24-ari-readback`,
`check:booking-com-reports`, `check:beds24-credit-backoff`,
`check:beds24-ari-drain`, `check:beds24-quarantine-selfheal`,
`check:reservation-source-system` — and every one turned red under a semantic
neutralisation that left every structural sign in place. A seventh,
`check:beds24-maxstay-no-limit` (PR #115), took two distinct B2 mutations and a
leg A that fails **behaviourally**, reproducing the production symptom
(`enforcing [31,31,31,31,31,31]`) rather than an import error.

**Leg A needs one qualification, recorded so nobody later reads it as a pass.**
Three of the six were green on leg A: `check:beds24-ari-drain`,
`check:beds24-quarantine-selfheal` and `check:reservation-source-system`. That is
**correct for them** — they are regression fixtures for code that already exists
on `main` (the drain, `sweepUnimportedRows`, `normalizeVisibleChannel`), or their
subject is a migration rather than `src/`. Leg A only substitutes `src/`, so it
cannot say anything about a DB seed. For a guard that pins EXISTING behaviour,
green on leg A is the expected result and B2 is the decisive test.

**One trap worth naming:** `git checkout <tree> -- src/` does **not** delete
files absent from that tree. The first leg-A attempt in this run left seven new
modules (1,735 lines) in place and produced four false GREENs. `rm -rf src`
first, then check out, then verify `git diff <tree> -- src/` prints **0 lines**.
