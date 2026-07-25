# Detaching check:\* guards from production (phase-2 / TARGET 2.3)

**Branch:** `stab/guard-inventory-staging` · **Base:** `origin/main` @ `5b171bd`
**Scope:** the nine guards wired as `node --env-file=.env.local scripts/…`, i.e.
pointed at the PRODUCTION database.

Pointing an automated guard at production data is forbidden. It also made these
guards **inert**: with no production `.env.local` present (every worktree, every
CI runner) node aborts with `node: .env.local: not found`, exit 9, before the
first assertion. A guard that exits 9 whether the system is healthy or wholly
broken carries **zero signal** — see the measured evidence in "Experiment log"
below.

## 1. Detached in this branch (4)

| check | why it can run on staging |
|---|---|
| `check:inventory` | asserts inventory FUNCTION integrity + the TS↔SQL mirror; all writes are inside rolled-back transactions |
| `check:effective-state` | pure `rules.ts` half + rolled-back DB half |
| `check:rate-grid` | scaffolds every scenario inside a rolled-back transaction |
| `check:rate-sellability` | pure classifier + rolled-back SQL twins. Its own header always said `--env-file=.env.test` — an ISOLATED database — while `package.json` invoked it with `--env-file=.env.local`. The header was right; the wiring was wrong. |

Mechanism: `scripts/lib/check-db-target.mjs`, a copy of the idiom already used
correctly by `scripts/check-db-isolation.mjs` and
`scripts/check-pms-domain-invariants.mjs`:

```
CHECK_DB_URL  ||  STAGING_DATABASE_URL   (env, else .env.staging)
```

`DATABASE_URL` is **deliberately not consulted**. That is what makes the
detachment real rather than cosmetic: the production DSN arrives in
`DATABASE_URL`, so even the still-unchanged `--env-file=.env.local` invocation
can no longer aim these four guards at production. Each run prints its redacted
target (`host:port/database`, never credentials) so a green tick is always
attributable to a database.

## 2. BLOCKER — `package.json` could not be updated

Iron rule 6 of this stabilization run reserves `package.json` for branch
`fix/beds24-checkin-cancellation-guard` (PR #112), which is awaiting merge. The
`--env-file=.env.local` flag lives in `package.json`, so **the `pnpm check:*`
entry points still exit 9** and no new `check:*` script could be registered.
`DECISIONS.md` is reserved by the same branch, which is why this record is here.

Apply after #112 merges (verified: with these four lines changed, all four
guards run end to end against staging):

```diff
-    "check:rate-grid": "node --env-file=.env.local scripts/check-rate-grid.mjs",
+    "check:rate-grid": "node scripts/check-rate-grid.mjs",
-    "check:effective-state": "node --env-file=.env.local scripts/check-effective-state.mjs",
+    "check:effective-state": "node scripts/check-effective-state.mjs",
-    "check:inventory": "node --env-file=.env.local scripts/check-inventory.mjs",
+    "check:inventory": "node scripts/check-inventory.mjs",
-    "check:sellability": "node --env-file=.env.local scripts/check-rate-sellability.mjs",
+    "check:sellability": "node scripts/check-rate-sellability.mjs",
```

Until then the working entry point is `node scripts/check-inventory.mjs`
(and siblings), which needs no flags.

## 3. FINDINGS — five guards that cannot be hosted by staging as it stands

These are not skips. Each asserts **live production operational state**, not
code or schema integrity, so running it against staging would not be a weaker
version of the same check — it would be a different, meaningless check.

| check | what it asserts | what staging would need to host it |
|---|---|---|
| `check:beds24-connection` | exactly ONE `state='active'` connection, `provider='beds24'`, `environment='production'`, refresh token present, circuit breaker closed | a staging Beds24 connection row with its own credentials **and** relaxing `environment='production'` to "the environment under test". Staging currently holds a single `provider='channex', environment='staging', state='active'` row — a D91 leftover (see §4), which fails the assertion for the right reason. |
| `check:beds24-jobs` | ≥1 succeeded `pull_booking_revisions` in 24h; ≤10% failure share per job type | a channel worker actually running against staging on the ~5-minute cadence. Without it the counters are frozen history. |
| `check:beds24-revisions` | last succeeded pull ≤ 30 minutes old; zero revisions stuck >1h | same live worker. This is a freshness SLO, not an invariant. |
| `check:beds24-ari` | zero dirty ranges pending >2h; ARI pushes happened if anything dirtied | same live worker plus a live outbound ARI drain. |
| `check:hydration-browser` | loads `/channels` in real Chrome, fails on any React #418/#425 hydration error | a running staging app + staging Supabase auth + test credentials (`HYDRATION_BASE_URL`, `HYDRATION_EMAIL/PASSWORD`, `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY`). Only the credentials/URL are missing — it reads no production table. Overlaps the staging-UI-verification work; left alone here to avoid a collision. |

The honest conclusion for the first four: they are **production monitoring**
wearing a `check:*` name. The right home is OBSERVABILITY alerting against
production (read-only, which they already are), not a pre-merge guard set — and
they should be excluded from any "all checks green" claim, because in every
worktree and CI runner they are exit-9 inert.

## 4. Incidental finding (not touched — no DB rows were deleted)

The staging database still carries an **active `channex` channel connection**
(`provider='channex', environment='staging', state='active'`, inbound+outbound
enabled, credentials present) plus 1358 `channel_sync_jobs`, 65
`channel_booking_revisions` and 537 `channel_dirty_ranges`. D91 removed
Channex from the code; the staging data was not cleaned up. Reported, not acted
on.

## 5. Experiment log — the B2 standard, four runs

Target guard: `check:inventory`.

### A (before) — clean `origin/main`, identity verified

```
$ git rev-parse origin/main
5b171bd6abbb7608b200d725fc38c40274da10fb
$ git diff --stat origin/main -- src scripts/check-inventory.mjs   (empty)
$ git status --porcelain -- src scripts/check-inventory.mjs        (empty)
----- running check:inventory -----
node: .env.local: not found
----- check:inventory exit=9 -----
```

RED — but it never reached an assertion. This IS the defect.

### B2 (before) — same origin/main guard, central predicate neutered

`guesthub.check_room_availability` on staging wrapped in
`SELECT * FROM (<original body>) WHERE false` (name, signature, return type and
every string literal verbatim; only the result emptied) **and** the TS mirror
`INVENTORY_BLOCKING_STATUSES` changed from
`["confirmed","checked_in","blocked"]` to `["confirmed","checked_in"]`.

```
  rows returned for a KNOWN-MISSING room id (was 1, now should be 0): 0
----- running check:inventory -----
node: .env.local: not found
----- check:inventory exit=9 -----
```

Byte-identical output to the healthy run. RED for the wrong reason — a guard
that is unconditionally red is exactly as useless as one that is
unconditionally green.

### A (after) — clean `origin/main` src, identity verified

```
$ git rev-parse origin/main
5b171bd6abbb7608b200d725fc38c40274da10fb
$ git diff --stat origin/main -- src   (empty)
$ git status --porcelain src           (empty)
$ git diff --stat origin/main          -> scripts/ only, 4 files, never src/

entry point 1: pnpm -s check:inventory
  node: .env.local: not found                              exit=9   (§2 blocker)
entry point 2: node scripts/check-inventory.mjs
  check-inventory: target 127.0.0.1:5434/guesthub_staging
  check-inventory: all assertions passed                   exit=0
```

GREEN is the correct result here: this branch changes no `src/` file, so
"clean origin/main src" is the healthy state. The RED-under-A proof for this
target is the run above, against clean origin/main **scripts/**.

### B2 (after) — three neuterings

**B2-a, BEHAVIOUR** — `guesthub.check_room_availability` emptied (signature
unchanged; literals `room_missing` / `room_status` / `closure` / `reservation`
all still in the body):

```
AssertionError: projection agrees with check_room_availability for type
153cd40e-… on 2026-08-01 (live)   4 !== 3          exit=1   RED
```

**B2-b, CONTRACT** — TS mirror value changed, `export const` / name / `as const`
all surviving:

```
AssertionError: CONTRACT BREACH (not a behaviour breach): the TS mirror
INVENTORY_BLOCKING_STATUSES has drifted from
guesthub.inventory_blocking_statuses()                     exit=1   RED
```

**B2-c, the negative result** — `src/lib/inventory.ts :: checkRoomAvailability`
(the single server-side availability check, called from
`reservations/actions.ts`, `calendar/actions.ts`, `channel/booking-import.ts`,
`pricing/engine.ts`) made to always return `[]`, i.e. "every room is free". No
identifier disappeared; `pnpm tsc --noEmit` exits 0:

```
check-inventory: target 127.0.0.1:5434/guesthub_staging
check-inventory: all assertions passed                     exit=0   GREEN
```

**check:inventory does not cover the TypeScript inventory layer at all.** It
proves the SQL functions and the mirrored constant; it never calls
`checkRoomAvailability`. The double-booking path can be deleted and this guard
stays green. Of the sibling guards, only `check:calendar` goes red under the
same neutering — and `check:calendar` is already red on clean main for an
unrelated layering assertion
(`reservations/actions.ts must not import @/lib/channel/beds24-http`), so its
redness is not distinguishable from its baseline and carries no signal.
`check:maintenance-closures` stays green; `check:pricing-equality` is red both
with and without the neutering.

Open work this implies: a guard that exercises `checkRoomAvailability` itself
(behaviourally, through the exported function) does not exist and should.

## 6. Assertion labelling

Per the B2 standard, `check-inventory.mjs` now labels its two mirror assertions
explicitly: the value read back from the database is a **BEHAVIOUR** assertion,
and the regex read of `src/lib/inventory-rules.ts` is a **CONTRACT** assertion
whose failure message says "CONTRACT BREACH (not a behaviour breach)". A missing
declaration is also caught now instead of throwing `TypeError` on `m[1]`. No
assertion was weakened.
