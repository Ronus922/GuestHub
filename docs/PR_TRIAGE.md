# PR TRIAGE — 12 open PRs against main @ `5b171bd`

Produced 2026-07-25 in `/var/www/wt-triage` (worktree off `origin/main`, branch `stab/pr-triage`).
Production (`/var/www/guesthub`) was never used as a working tree and never deployed to.
All DB-backed work ran against the dedicated staging DB (`127.0.0.1:5434`, container
`guesthub-staging-db`) and the disposable DB (`:5433`) — never `:5432`.

---

## 1. Verdict table

| PR | Branch | Verdict | typecheck | Guards touched · A / B2 | What must be fixed | Blockers |
|----|--------|---------|-----------|--------------------------|--------------------|----------|
| **#112** | `fix/beds24-checkin-cancellation-guard` | **READY TO MERGE** — merge first | GREEN (individually and in the full stack) | `check:beds24-checkin-cancellation-guard` — 13/13 green (read-only run in the combined tree). No A/B2 run: hands-off by instruction; the PR carries its own B1/B2 assertions. | nothing | none. Its `## D94` heading collides with #104's — resolved by renumbering **#104**, not this PR. |
| **#103** | `night/p0-1-channel-comments` | **READY TO MERGE** | GREEN | none (adds no guard) | nothing | none. Verified **comments-only**: zero non-comment changed lines in the whole diff. |
| **#104** | `night/p0-4-credit-backoff` | **NEEDS FIX — do not merge as is.** Merge `fix/beds24-credit-gate-swallows-failures` (a superset of #104) instead | GREEN alone; **RED combined with #110** (fixed) | `check:beds24-credit-backoff` **as shipped: FAILS B2** — deleting the entire outbound credit gate left it 11/11 green. Rebuilt on the fix branch: **15/15 green; A RED; B2 RED ×3** (details §3) | (a) the credit pause swallows a real provider failure — proof §2; (b) the guard was vacuous on the outbound half | none — fixed, pushed |
| **#105** | `night/p0-2-fixture-guards` | **NEEDS FIX** — merge with `fix/ari-drain-guard-measured-credit-headers`, **after #104** | GREEN | `check:beds24-ari-drain` 10/10 · `check:beds24-quarantine-selfheal` 5/5 — both green; **B2 RED** for both (§3) | its static assert on `"x-fivemincreditlimit-remaining"` and its mock's credit headers both break the moment #104 lands | hard ordering dependency on #104 |
| **#106** | `night/p0-3-ari-readback` | **READY TO MERGE — with a manual merge resolution** | GREEN alone and combined | `check:beds24-ari-readback` 11/11 green; **B2 RED** (§3) | nothing in the branch. `src/lib/channel/worker.ts` conflicts with #104 — exact resolution in §5 | conflicts with #104 (`worker.ts`) |
| **#107** | `night/calendar-ui-guard-diagnosis` | **READY TO MERGE** | n/a (no code) | none | nothing | none. **Docs only**: `A docs/CALENDAR_UI_GUARD_DIAGNOSIS.md` (1 file) |
| **#108** | `night/room-display-state-closed` | **NEEDS FIX — no guard at all** | GREEN | **none — the PR ships a behaviour change with zero coverage** | add a guard: a room with `pricing_plan_rates.stop_sell` on the board date derives `closed`, and `closed` never outranks `occupied`/`blocked`/`maintenance` | none technical. Every dependency verified present: `pricing_plan_rates.stop_sell`, `pricing_plans.is_base`, `sellable_unit_rooms`, `Icon` key `lock` |
| **#109** | `night/reservation-source-system` | **READY TO MERGE** | GREEN | `check:reservation-source-system` 4 groups green; **B2 RED** (§3) | nothing | migration numbering — see §4 |
| **#110** | `night/p2-2-booking-com-reports` | **NEEDS FIX** — merge with `fix/booking-com-reports-credit-meter`, **after #104** | GREEN alone; **RED combined with #104** (reproduced, §2.3) | `check:booking-com-reports` 18/18 green after fix; **B2 RED** (§3). As shipped it cannot run at all here (§2.4) | (a) `beds24-booking-reports.ts:152` reads the removed `Beds24Response.creditsRemaining`; (b) its guard shells out to `docker exec … guesthub-testdb -U postgres`, bypassing `TEST_DATABASE_URL` | hard ordering dependency on #104; migration 055 collision (§4) |
| **#111** | `night/night-run-report` | **READY TO MERGE** | n/a (no code) | none | nothing | none. **Docs only** — full file list below |
| **#23** | `feat/room-configuration-and-inventory-cleanup` | **CLOSE** | n/a | none | — | 275 behind, 3 conflicts. Substance already on main (§6) |
| **#60** | `feat/reservation-defaults-policy-snapshot` | **CLOSE** and reopen D83/D84 as fresh PRs | n/a | none | — | 196 behind, **21 conflicts**, Channex-era, modifies a script main deleted (§6) |

### #111 file list (verifying "no code")

```
$ git diff --name-status origin/main...origin/night/night-run-report
A	docs/NIGHT_AUDIT.md
A	docs/NIGHT_RUN_REPORT.md
```

Two added Markdown files. No `src/`, no `scripts/`, no `db/`, no `package.json`. Docs only — confirmed.

---

## 2. Evidence

### 2.1 #104 defect (a) — the credit pause swallows a real provider failure

`sendCalendarRequests` feeds **every** response to the credit gate, including a failing one
(`gate.observe(res.credits, …)` runs before the `if (!res.ok)` check). So an HTTP 500/400/network
error that merely happened to arrive while `x-five-min-limit-remaining` was below the threshold
set `outcome.creditPause`, and `drainBeds24AriDirtyRanges` took

```ts
if (creditPause && warnings.length === 0) {   // ← failure is not consulted
```

which re-arms the range **without** calling `failRanges` — no attempt charged, no `last_error_code`,
no `channel_connections.last_error`, and the evidence ledger records `partial / credit_paused`
instead of `failed / server_error`.

One drain, HTTP 500 + `remaining=8.4`, through the real compiled worker modules against staging:

```
##### /var/www/wt-triage-main  (clean origin/main — git diff origin/main -- src/ EMPTY) #####
dirty_range.attempts         : 1
dirty_range.last_error_code  : server_error
connection.last_error        : שגיאת שרת אצל Beds24 — נסה שוב מאוחר יותר
evidence.outcome/error_code  : failed / server_error
=== VERDICT: attempt charged? YES ===

##### origin/main + #104 (as shipped) #####
dirty_range.attempts         : 0
dirty_range.last_error_code  : null
connection.last_error        : null
evidence.outcome/error_code  : partial / credit_paused
=== VERDICT: attempt charged? NO — FAILURE SWALLOWED ===
```

The consequence — a permanently-failing range never dead-letters. Eight consecutive scheduler
passes over a range that always gets HTTP 400, `max_attempts = 5`:

```
##### /var/www/wt-triage-main  (clean origin/main) #####
provider calls issued        : 5
dirty_range.status           : failed        ← dead letter reached, calls stopped
dirty_range.attempts         : 5

##### origin/main + #104 (as shipped) #####
provider calls issued        : 8
dirty_range.status           : pending       ← retries forever
dirty_range.attempts         : 0
```

A clear regression against main: the range keeps calling Beds24 every cycle, burning exactly the
credits the pause exists to protect.

**Fix** (branch `fix/beds24-credit-gate-swallows-failures`, commit `f838f52`): the pause replaces the
failure path only when the credit window is the whole story.

```ts
const creditIsTheWholeStory =
  failure === null ||
  (creditPause?.reason === "rate_limited" && failure.code === "rate_limited");
if (creditPause && creditIsTheWholeStory && warnings.length === 0) {
```

and in the failure path the breaker is still opened for the provider-stated reset span, so the range
is charged **and** the connection is paced. After the fix, both scenarios reproduce main exactly
(attempts=1 / `server_error`; `status='failed'` after 5 calls).

### 2.2 #104 defect (b) — the guard was vacuous on the outbound half

The entire outbound credit gate deleted from `beds24-ari-sync.ts` (gate creation, mid-loop stop,
`gate.observe`, and the whole credit-pause branch), tree still compiling:

```
############ THE ENTIRE OUTBOUND CREDIT GATE DELETED ############
TSC=0
 src/lib/channel/beds24-ari-sync.ts | 52 +------------------------------------
✓ 1 … ✓ 11   check-beds24-credit-backoff: all 11 assertions passed
GUARD_EXIT=0
```

The shipped guard covers `beds24-credits.ts` (pure) and the **inbound** pull path only. It never
touches `drainBeds24AriDirtyRanges`. Rebuilt — see §3.

### 2.3 #104 + #110 merge simulation — the brief's claim REPRODUCES

Both branches merged onto `origin/main` in a scratch worktree (only `package.json` and `DECISIONS.md`
conflicted textually — resolved by keeping both sides), then `tsc --noEmit`:

```
src/lib/channel/beds24-booking-reports.ts(152,30): error TS2339:
  Property 'creditsRemaining' does not exist on type 'Beds24Response'.
TSC_EXIT=1
```

Cause: #104 replaces `Beds24Response.creditsRemaining?: number` with
`credits: Beds24CreditSnapshot` (the old header name `x-fivemincreditlimit-remaining` does not exist
on the wire). #110 was authored against main and reads the removed field. **One line.** Fixed on
`fix/booking-com-reports-credit-meter` → `r.credits.remaining`. After the fix the combined tree is
`TSC_EXIT=0`.

Note the brief's other claim — "#110 breaks typecheck" — did **not** reproduce: #110 alone is green.
The breakage is purely the #104 combination.

### 2.4 #110's guard cannot run against the named database

```
✓ 6. static: migration 055 shape + manifest entry
ERROR:  permission denied for schema guesthub
Error: Command failed: docker exec -i guesthub-testdb psql -U postgres -d postgres … < db/migrations/055_…sql
```

`scripts/check-booking-com-reports.mjs:195` hardcodes a container name and a superuser, ignoring
`TEST_DATABASE_URL`. Two consequences: the guard's own safety preamble (which refuses production
markers in `TEST_DATABASE_URL`) guarded nothing — the DDL landed in a container the operator never
named — and it fails outright wherever `postgres` does not own schema `guesthub`. Fixed on
`fix/booking-com-reports-credit-meter`: the migration is applied twice through the same `postgres`
connection every other assertion uses. Then **18/18 green** against staging.

### 2.5 #105's guard breaks the moment #104 lands — reproduced

```
$ node scripts/check-beds24-ari-drain.mjs          # tree = main + #104 + #105
AssertionError [ERR_ASSERTION]: the credit-window counter is read from the real header name
GUARD_EXIT=1
```

`scripts/check-beds24-ari-drain.mjs:63` asserts `beds24-http.ts` contains
`"x-fivemincreditlimit-remaining"` — the phantom name #104 deletes. Its mock also serves the old
header spelling, so after #104 the evidence-context assertion (`creditsRemaining === 4900`) reads
`null`. Fixed on `fix/ari-drain-guard-measured-credit-headers`: the duplicated contract assertion is
removed (its one owner is `check:beds24-credit-backoff`, which asserts both the measured names **and**
the phantom name's absence) and the fixture speaks the measured wire. Order proof:

```
with #104   : check-beds24-ari-drain: all 10 assertions passed
without #104: AssertionError — the measured credit meter is carried into the evidence context
```

### 2.6 The brief's "branches leaned on files that do not exist" claim did NOT reproduce

Checked across **all** branches with `git ls-tree -r`: every `scripts/…` path referenced from every
branch's `package.json` exists on that branch (the only "misses" were a regex artefact matching the
`scripts/db/` directory prefix of `scripts/db/migrate.mjs`, which is present). For #108 (night task 6)
and #109 (night task 7) specifically, every dependency was verified live: `guesthub.pricing_plan_rates`
(`stop_sell`, `date`, `pricing_plan_id`, `tenant_id`), `pricing_plans.is_base`,
`sellable_unit_rooms`, `Icon.tsx` key `lock`, `src/lib/colors.ts`, migration `056`. Nothing missing.

### 2.7 Pre-existing reds — not caused by any PR

`check:design` and `check:calendar-ui` are RED on **clean `origin/main`** with **byte-identical
output** to the fully merged stack (`diff` of the two logs is empty):

- `check:calendar-ui` — `the channel row is CONDITIONAL — an internal reservation gets no row, not an empty one`. This is exactly what #107 diagnoses.
- `check:design` — `TOTAL: 6 violation(s)`, incl. `src/app/housekeeping/my-tasks/MyTasksScreen.tsx:160 — rounded-[22px]` (a frozen screen per `STATE.md`).

Neither is a merge blocker. Neither was weakened.

---

## 3. Guard verification (the B2 standard)

`check:beds24-credit-backoff` — full A + B2, on `fix/beds24-credit-gate-swallows-failures`:

| Experiment | What was changed | Result |
|---|---|---|
| baseline | none | **GREEN 15/15** |
| **A** | `git checkout origin/main -- src/` + removed the files main does not have. Identity printed: `git diff --stat origin/main -- src/` **empty**, `ls src/lib/channel/beds24-credits.ts` → *No such file* | **RED** (exit 1). Honest caveat: it dies at the first CONTRACT assertion because the module under test does not exist on main at all — A proves absence, B2 below proves the behaviour. |
| **B2-a** | `evaluateBeds24Credits` neutered to always return `null` (export name, signature, both original branches, imports, call sites, header constants, threshold, gate and message builder all left in place; tree compiles) | **RED** at ✓4 |
| **B2-b** | **the entire outbound credit gate deleted** — the exact experiment that left the shipped guard 11/11 green (imports, `Beds24CreditPause` type, `creditPause` field, all call sites kept; tree compiles) | **RED** at ✓13 — `a credit pause must leave the claimed range PENDING for the next window (got 'synced' — the outbound credit gate is not running)`. Assertions 1–12 stay green, which is precisely the old guard's blind spot. |
| **B2-c** | the D98 predicate reverted to the shipped `if (creditPause && warnings.length === 0)` (`creditIsTheWholeStory` still computed, just not consulted) | **RED** at ✓14 — `a 500 must charge an attempt even when the credit meter is low (got attempts=0 …)` |

Structural assertions in the rebuilt guard are labelled `CONTRACT:` and fail with
`CONTRACT BREACH (structural, not behaviour): …`. All four new outbound assertions read the
**database** after a real `drainBeds24AriDirtyRanges` run.

B2 spot-checks on every other new guard (central predicate neutered, all structural signs kept, tree
recompiled each time):

| Guard | PR | Baseline | Neutering | Result |
|---|---|---|---|---|
| `check:beds24-ari-drain` | #105 | 10/10 | `beds24-ari.ts`: per-item `success === false` no longer sets `anyFailure` | **RED** at ✓3 |
| `check:beds24-quarantine-selfheal` | #105 | 5/5 | `sweepUnimportedRows` re-imports nothing | **RED** at ✓2 |
| `check:beds24-ari-readback` | #106 | 11/11 | `diffBeds24Calendar` always reports "no drift" | **RED** at ✓4 |
| `check:reservation-source-system` | #109 | 4 groups | `normalizeVisibleChannel("system")` returns `"booking"` (the exact mistake the PR warns about) | **RED** at ✓1 |
| `check:booking-com-reports` | #110 | 18/18 | `windowRejection` always returns `null` | **RED** at ✓14 |
| `check:beds24-checkin-cancellation-guard` | #112 | 13/13 | not run — **#112 is hands-off** | — |

---

## 4. Migration numbering

| File | Claimed by | Status |
|---|---|---|
| `055_booking_com_channel_reports.sql` | **#110** | keep 055 |
| `055_length_of_stay_discounts.sql` | `fix/quote-window-long-stay` — **local branch, never pushed, outside this scope** | **must renumber → `057`** |
| `056_source_system.sql` | **#109** | keep 056 |

Recommendation: #110 keeps 055 and #109 keeps 056 — both are pushed, reviewable PRs whose guards and
manifests already reference those numbers, and 056 is sequenced behind 055. `fix/quote-window-long-stay`
renumbers to **057** (`db/migrations/057_length_of_stay_discounts.sql` + its `manifest.txt` line).
**That branch was not touched.** No other branch, local or remote, claims 055–058.

Verified: with #110's 055 and #109's 056 both applied, the manifest replays from zero on a virgin
schema — `Done: 58 applied, 58 total` on the disposable DB (`:5433`, `DROP SCHEMA guesthub CASCADE`
first) and 57/57 on staging (`:5434`).

---

## 5. Merge order

Everything below was simulated end to end in `/var/www/wt-triage-sim3` (a scratch worktree off
`origin/main`). Result of the full stack:

- `tsc --noEmit` → **exit 0**
- `eslint .` → **0 errors** (31 pre-existing warnings)
- `next build --turbopack` → **exit 0**
- migration chain from zero → **58/58**

| # | Merge | Why here |
|---|-------|----------|
| 1 | **PR #112** `fix/beds24-checkin-cancellation-guard` | Already approved and waiting; keeps `## D94`. Everything after it is renumbered around it. |
| 2 | **PR #103** `night/p0-1-channel-comments` | Comments only, conflicts with nothing. |
| 3 | **`fix/beds24-credit-gate-swallows-failures`** *(merge this **instead of** PR #104 — it contains #104 plus the fix)* | Renames the credit-window decision `D94 → D97` (freeing D94 for #112) and adds `D98`. Everything below depends on its `Beds24CreditSnapshot`. Expect a textual `package.json` / `DECISIONS.md` conflict — keep both sides. |
| 4 | **PR #105** `night/p0-2-fixture-guards` **+ `fix/ari-drain-guard-measured-credit-headers`** | Hard dependency on step 3 — its guard reads the credit meter. Merge the branch and the fix together; do not merge #105 alone after step 3. |
| 5 | **PR #106** `night/p0-3-ari-readback` | **One manual conflict** in `src/lib/channel/worker.ts` (`reconcile_inventory`). Take #106's restructured block and keep #104's credit line inside the `if (inbound)` arm — resolution below. |
| 6 | **PR #110** `night/p2-2-booking-com-reports` **+ `fix/booking-com-reports-credit-meter`** | Hard dependency on step 3. Keeps migration **055**. |
| 7 | **PR #109** `night/reservation-source-system` | Migration **056**, sequenced after 055. Textual `db/migrations/manifest.txt` conflict with #110 — keep both lines, 055 then 056. |
| 8 | **PR #108** `night/room-display-state-closed` | Independent. **Merge only if you accept it landing without a guard** — otherwise hold it and ask for one. |
| 9 | **PR #107** `night/calendar-ui-guard-diagnosis` | Docs only. |
| 10 | **PR #111** `night/night-run-report` | Docs only, largest text diff — last, so it never causes a conflict. |
| — | **PR #23**, **PR #60** | **Close.** Do not merge, do not rebase. |

Then deploy **once**.

### Step 5 — the exact `worker.ts` resolution

Both #104 and #106 edit the `reconcile_inventory` arm. The merged form (verified: whole stack
`tsc` exit 0):

```ts
      const [inbound] = (await loadBeds24InboundConnections(sql)).filter((c) => c.id === connectionId);
      if (inbound) {
        const summary = await runBeds24BookingReconciliation(sql, inbound);
        // P0-4 — the meter this call measured, parked on the job row.
        await recordJobCredits(jobId, summary.credits, summary.creditPause?.reason ?? null);
        released = summary.released;
        if (summary.errors.length > 0 && summary.checked === 0) reconcileError = summary.errors[0];
      }
```

Everything else in that arm is #106's version verbatim.

### Textual conflicts to expect (not defects)

`package.json` (each PR appends its own `check:*` script) and `DECISIONS.md` (each appends a section)
conflict between almost every pair. Keep **both** sides every time. `db/migrations/manifest.txt`
conflicts between #109 and #110 — keep both lines in numeric order. No branch touches
`pnpm-lock.yaml`, so dependencies are identical throughout.

---

## 6. #23 and #60 — reasoned verdicts

### PR #23 — `feat/room-configuration-and-inventory-cleanup` · **CLOSE**

275 behind, 3 commits, 5 files, 3 conflicts (`DECISIONS.md`, `calendar/data.ts`, `RoomWizard.tsx`).
Checked commit by commit against current main:

| Commit | Substance | On main today? |
|---|---|---|
| `597801a` | `db/migrations/021_room_inventory_cleanup.sql` | **byte-identical to main's 021** — `git diff` empty |
| `5f400b1` | numeric room ordering in `calendar/data.ts` | **superseded** — main uses `sortRoomsByNumber` from `src/lib/rooms/sort.ts` (D86), applied in `calendar/data.ts:53` |
| `44ac035` | `FLOOR_OPTIONS = ["5"…"16"]` + a seed rename | `FLOOR_OPTIONS` is **already on main** (`RoomWizard.tsx:66`, identical). Only **8 lines of `scripts/seed.mjs`** remain unlanded (`בניין ראשי`/`אגף הבריכה` → `צפוני`/`דרומי`, and two room-type renames) |

Residual value: an 8-line rename in a dev seed script. Cost: resolving 3 conflicts across 275
commits, including `calendar/data.ts` which has since been rewritten twice (D86, D92).
**Rebasing costs more than reopening.** Close it; if the seed rename is still wanted, make it as a
fresh 8-line commit on main.

### PR #60 — `feat/reservation-defaults-policy-snapshot` · **CLOSE, reopen D83/D84**

196 behind, 5 commits, 36 files, **21 conflicts** — including `CalendarGrid.tsx`,
`CalendarScreen.tsx`, `ReservationTooltip.tsx`, `calendar/data.ts`, `ReservationsScreen.tsx`,
`reservations/actions.ts`, `BookingPanel.tsx`, `CardFields.tsx`, `EditReservationPanel.tsx`,
`card-rules.ts`, `booking-import.ts`, `booking-normalize.ts`. Every one of those is in an area main
has since rewritten (D92 calendar draw boundary, D93 cancellation import, migrations 047
`restore_stored_cvv` and 051 `psp_readiness`), and `CardFields.tsx` / `card-rules.ts` are exactly the
files the repo's concurrency rule flags as contested.

Two further signals: it contains **6 Channex references** (a provider deleted by D91/#97) and it
carries a **modify/delete** conflict on `scripts/check-inbound-bookings.mjs`, which main removed.

Most of it already landed by another route: `policy-snapshot.ts`, `rooms/sort.ts`, `card-rules.ts`,
`external-changes.ts`, `check-status-default.mjs` are all present on main, and main's DECISIONS.md
cites D86 for the one canonical card section.

Genuinely unlanded: **D83** (explicit email retry for external-change notifications) and **D84**
(approval-gated OTA date modifications) — main has only D82. Both are small, self-contained
features. **Reopen those two as fresh PRs against current main**; re-authoring them is cheaper and
safer than resolving 21 conflicts in the calendar/reservations/cards hot zone.

---

## 7. Fix branches pushed (no PRs opened, nothing merged)

| Branch | Base | Contents |
|---|---|---|
| `fix/beds24-credit-gate-swallows-failures` | `night/p0-4-credit-backoff` (#104) | The swallowed-failure fix + the rebuilt guard (4 new DB-backed outbound assertions, CONTRACT labelling) + `DECISIONS.md`: credit window renumbered `D94 → D97`, regression recorded as `D98`. **Merge this instead of #104.** |
| `fix/ari-drain-guard-measured-credit-headers` | `night/p0-2-fixture-guards` (#105) | Removes the duplicated credit-header contract assertion; fixture speaks the measured wire names. **Merge with #105, after #104.** |
| `fix/booking-com-reports-credit-meter` | `night/p2-2-booking-com-reports` (#110) | `r.credits.remaining` (fixes the #104+#110 typecheck break) + the guard applies migration 055 through `TEST_DATABASE_URL` instead of `docker exec … -U postgres`. **Merge with #110, after #104.** |

Every commit was staged file by file after `git status --porcelain -- <file>`; no `git add -A`,
no `git add .`. No PR was opened or modified. Nothing was merged. Nothing was pushed to `main`.

## 8. Worktrees left behind

`/var/www/wt-triage` (this document), `/var/www/wt-triage-main` (clean `origin/main` baseline),
`/var/www/wt-triage-104`, `/var/www/wt-triage-105`, `/var/www/wt-triage-110`,
`/var/www/wt-triage-fix104`, and `/var/www/wt-triage-sim3` — the fully merged, verified simulation of
the whole order above. Remove with `git worktree remove` when done.
