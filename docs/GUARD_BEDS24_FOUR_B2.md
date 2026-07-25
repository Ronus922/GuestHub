# TARGET 2.7 — B2 on `check:beds24-{connection,jobs,revisions,ari}`

Stabilization run, phase 2 (guard integrity). Branch `stab/guard-beds24-four-b2`.
Worktree `/var/www/wt-g27`. Staging DB `127.0.0.1:5434/guesthub_staging`
(container `guesthub-staging-db`). Production was never read, written or
deployed to.

Baselines used: `origin/main` was **5b171bd** when the run started and moved to
**8494385** mid-run (PRs #112, #113, #114 landed). Every "after" experiment in
this document was re-run against 8494385; the "before" experiments were taken
at 5b171bd, where these four guards were byte-identical to 8494385 anyway
(neither #112 nor #113 nor #114 touched them — verified with
`git diff 5b171bd..origin/main -- scripts/check-beds24-{connection,jobs,revisions,ari}.mjs`,
empty).

---

## 1. The verdict, up front

**All four guards FAILED experiment A and FAILED experiment B2 in their
shipped form.** Not marginally — they were incapable of passing either, for a
structural reason:

> The four scripts import exactly two things: `postgres` and
> `node:assert/strict`. They execute **zero lines of application code**. No
> defect that can be introduced into `src/` is observable to them.

That was not a hypothesis. Measured on 2026-07-25: with
`circuitAllowsRequest()` in `src/lib/channel/circuit-breaker.ts`,
`isPermanentError()` in `src/lib/channel/ranges.ts` and
`markRevisionAcknowledged()` in `src/lib/channel/revisions.ts` all semantically
neutered at once, each guard's stdout was **byte-identical** to its output on
clean `src/`.

| guard | A (before) | B2 (before) | A (after) | B2 (after) |
|---|---|---|---|---|
| `check:beds24-connection` | FAIL (fake red, exit 9) | **FAIL** — output byte-identical under neutering | n/a — see §5 | **PASS** — red under both src and rule neutering |
| `check:beds24-jobs` | FAIL (fake red, exit 9) | **FAIL** — byte-identical | n/a — see §5 | **PASS** |
| `check:beds24-revisions` | FAIL (fake red, exit 9) | **FAIL** — byte-identical | n/a — see §5 | **PASS** |
| `check:beds24-ari` | FAIL (fake red, exit 9) | **FAIL** — **GREEN, 2 PASSED, on an empty database** | n/a — see §5 | **PASS** |

### B2 (after), in full — three families, eleven runs, all RED

**Family 1 — neuter the shipped `src/` predicate the guard now executes.**
Each was applied alone, compiled cleanly (`tsc -p tsconfig.worker.json`), and
passed the harness structural-signs check (`OK — no identifier disappeared`).

| guard | neutered | result |
|---|---|---|
| connection | `circuitAllowsRequest()` → always true (`circuit-breaker.ts`) | RED — `CONTRACT BREACH — C5-src: the shipped circuitAllowsRequest()/circuitPhase() BLOCK the tripped fixture` |
| jobs | `enqueueChannelJob()` → no-op (`queue.ts`) | RED — `CONTRACT BREACH — J0: the SHIPPED enqueueChannelJob() produced the rows the histogram reads back` |
| revisions | `markRevisionAcknowledged()` → no-op (`revisions.ts`) | RED — `CONTRACT BREACH — R-lifecycle: the shipped markRevisionAcknowledged() acknowledged the imported revision` |
| ari | `markAriDirty()` → no-op (`outbox.ts`) | RED — `CONTRACT BREACH — A0: the SHIPPED markAriDirty() actually wrote a dirty range (read back: 0)` |

A first attempt at family 1 was **discarded rather than counted**: the
neutering used `if (db && job)`, which tsc rejects with TS2774, so all three
guards went red on a *compile error* instead of on the defect. A red you did not
earn is worth no more than a green you did not earn. The neuterings were rewritten
in `void x;` form, applied one at a time, and re-run.

**Family 2 — neuter the rule (the central predicate surface), both directions.**
One line in `scripts/lib/beds24-health-rules.mjs`; every export, call site and
string literal untouched.

| direction | connection | jobs | revisions | ari |
|---|---|---|---|---|
| `no()` → `ok:true` (accepts everything) | RED `C1 ACCEPTED a broken fixture` | RED `J1 ACCEPTED…` | RED `R1 ACCEPTED…` | RED `A1 ACCEPTED…` |
| `yes()` → `ok:false` (rejects everything) | RED `C1 rejected a healthy fixture` | RED `J1 rejected…` | RED `R1 rejected…` | RED `A1 rejected…` |

**Family 3 — put the shipped bug back.** `ruleAriDrainKeepingUp()` restored to
the exact behaviour that produced `BEDS24 ARI CHECK: 2 PASSED` on an empty
database (`dirtied === 0 → { ok: true, applicable: true }`):

```
BEDS24 ARI CHECK FAILED: BEHAVIOUR BREACH — A2 treated an empty dirty-range
history as applicable; that is the vacuous green this guard was rebuilt to remove
true !== false                                                        exit=1
```

That is the one that matters: **the regression that shipped can no longer
ship.**

One honesty note on family 3: the harness's structural-signs check flagged the
identifier `APPLICABLE` as having disappeared. It is a word inside a string
literal in the rule's `detail` message, not a name, import or call site, and
nothing greps for it — the neutering is semantic. Flagged here rather than
quietly ignored.

---

## 2. Three distinct defects found

### 2.1 Red in every state (all four)

`package.json` wires all four as `node --env-file=.env.local scripts/…`.
`.env.local` is the **production** env file and exists only in the production
runtime tree. In any worktree — i.e. anywhere work actually happens, and in CI —
the process dies before the first assertion:

```
----- running check:beds24-connection -----
node: .env.local: not found
----- check:beds24-connection exit=9 -----
```

A guard with the same output whether the system is healthy or broken carries
exactly zero signal. Worse, the shared B2 harness scores that exit 9 as
`### RESULT A: RED (exit 9) — correct, the guard detects the clean-main state`
and `### RESULT B2: RED — the guard is REAL. It tests behaviour, not text.`
**Both verdicts are false.** See §6 — this is a harness-level hazard affecting
every agent in this run, not just this target.

### 2.2 `check:beds24-ari` was green on the absence of Beds24

Run against staging, whose Beds24 integration does not exist (one `channex`
connection, zero Beds24 dirty ranges, zero Beds24 jobs):

```
  ✓ zero beds24 dirty ranges pending > 2h
  · beds24 ranges currently in-flight (< 2h, worker will drain): 0
  · nothing dirtied in 24h (0 pushes ran) — freshness vacuously OK

BEDS24 ARI CHECK: 2 PASSED      exit=0
```

Both "passes" were produced by the *absence* of the guarded subject: `count = 0`
satisfies "no stale ranges", and the freshness test's `else` branch did `n++`
and called it a pass. This guard would have gone green on a database where the
entire channel manager had been deleted.

`check:beds24-jobs` had the same shape in J2: `for (const [type, e] of by) {…}`
over an empty map, followed unconditionally by
`ok("failure share ≤ 10% for every beds24 job type")`.

### 2.3 Every threshold was unguarded

`30` minutes, `10%`, `1` hour, `2` hours and the D91 cutover instant were inline
magic numbers. Widening `30` to `30000` broke no check anywhere in the repo.

---

## 3. What was changed

Guard-only. **This branch modifies zero files under `src/`**
(`git diff --stat origin/main -- src/` is empty).

| file | status |
|---|---|
| `scripts/lib/check-db-target.mjs` | vendored **byte-identical** from `origin/stab/guard-inventory-staging` (target 2.3), so the two branches merge without conflict |
| `scripts/lib/beds24-health-rules.mjs` | new — the 13 assertions as pure, exported predicates (the central-predicate surface B2 neuters) |
| `scripts/lib/beds24-staging-fixture.mjs` | new — staging fixture, always-rollback transaction discipline, read-back queries, compiled-worker loader |
| `scripts/check-beds24-connection.mjs` | rewritten |
| `scripts/check-beds24-jobs.mjs` | rewritten |
| `scripts/check-beds24-revisions.mjs` | rewritten |
| `scripts/check-beds24-ari.mjs` | rewritten |
| `docs/GUARD_BEDS24_FOUR_B2.md` | this file |

Each of the 13 rules is now exercised **in both directions** against state read
**back out of** the staging database:

* **ACCEPT arm** — a satisfying fixture; the rule must return ok.
* **REJECT arm** — a fixture violating exactly that one rule; the rule must
  return not-ok.

Neutering a rule in *either* direction turns its guard red: `return {ok:true}`
kills the REJECT arm, `return {ok:false}` kills the ACCEPT arm.

Additionally — and this is what restores the missing `src/` binding — the
ACCEPT arms are **built by the shipped code**, not by hand-written SQL:

| guard | shipped functions it now executes |
|---|---|
| connection | `circuitPhase()`, `circuitAllowsRequest()` (`src/lib/channel/circuit-breaker.ts`), `loadDrainableBeds24Connections()` (`src/lib/channel/beds24-ari-sync.ts`) |
| jobs | `enqueueChannelJob()` (`src/lib/channel/queue.ts`) |
| revisions | `persistBookingRevision()`, `markRevisionImported()`, `markRevisionAcknowledged()`, `quarantineRevision()` (`src/lib/channel/revisions.ts`) |
| ari | `markAriDirty()` (`src/lib/channel/outbox.ts`) |

Assertion labelling, as required: `expectAccept` / `expectReject` emit
`BEHAVIOUR BREACH` on failure; `expectContract` emits
`CONTRACT BREACH (not a behaviour breach)`. Behavioural assertions outnumber
contract assertions in every guard.

Safety properties of the fixture:

* target resolved by `CHECK_DB_URL || STAGING_DATABASE_URL`; `DATABASE_URL` is
  deliberately **not** consulted, so a stray `--env-file=.env.local` can no
  longer aim these at production;
* every write is inside a transaction that is unconditionally rolled back —
  the rollback is forced by throwing a private sentinel, so no code path
  (success, assertion failure or crash) reaches a COMMIT;
* **nothing is ever DELETEd** — the fixture only INSERTs;
* `assertNoNetRows()` re-counts the four tables after the rollback and fails
  the run if one row leaked. Every run prints the proof, e.g.
  `no net rows written (channel_connections=1, channel_sync_jobs=1358,
  channel_booking_revisions=65, channel_dirty_ranges=537)`;
* no secret value is read, printed or compared — `api_key_ciphertext` is seeded
  with the literal placeholder `fixture::not-a-secret::presence-only` and the
  rule only tests it for PRESENCE.

---

## 4. BLOCKER — the guards still cannot be invoked by name

**`package.json` still wires all four as `node --env-file=.env.local`, so
`pnpm check:beds24-connection` still exits 9. I could not fix that.**

Iron rule 6 of this run names `package.json` as owned by branch
`fix/beds24-checkin-cancellation-guard` (PR #112) and forbids touching it. That
PR merged into main as `c93b401` **during** this run, which arguably dissolves
the reason for the rule — but the rule is stated absolutely and three earlier
agents obeyed it, so this one does too. The rewiring is therefore recorded here
rather than applied. For the same reason no `check:*` script could be
registered in `package.json` and no entry could be added to `DECISIONS.md`.

The exact patch someone with the right to touch `package.json` must apply:

```diff
-    "check:beds24-connection": "node --env-file=.env.local scripts/check-beds24-connection.mjs",
-    "check:beds24-jobs": "node --env-file=.env.local scripts/check-beds24-jobs.mjs",
-    "check:beds24-revisions": "node --env-file=.env.local scripts/check-beds24-revisions.mjs",
-    "check:beds24-ari": "node --env-file=.env.local scripts/check-beds24-ari.mjs",
+    "check:beds24-connection": "node scripts/check-beds24-connection.mjs",
+    "check:beds24-jobs": "node scripts/check-beds24-jobs.mjs",
+    "check:beds24-revisions": "node scripts/check-beds24-revisions.mjs",
+    "check:beds24-ari": "node scripts/check-beds24-ari.mjs",
```

Until that lands, the four guards run only as
`node scripts/check-beds24-<name>.mjs` from a worktree holding a `.env.staging`.

**Related, and newly arrived:** PR #113 added
`"check:beds24-credit-headers": "node --env-file=.env.local scripts/check-beds24-credit-headers.mjs"`
to main *during this run* — a **tenth** production-wired guard. The measured
baseline for this run said nine. Whatever mechanism let that through will keep
producing them.

---

## 5. Experiment A does not apply to a guard-only change — stated, not dodged

Experiment A is "restore `src/` from clean `origin/main`; the guard must be
RED". It is the right test for a guard that certifies a fix present in `src/`
on the same branch. **This branch contains no `src/` fix** —
`git diff --stat origin/main -- src/` is empty — so there is no defect on clean
main for these guards to detect, and A is green by construction. Reporting that
as a pass would be dishonest; reporting it as a failure would be equally
misleading. It is *not applicable*, and the printed identity verification in
the run log shows why: the restore is a no-op.

The substantive test for these four is B2, and it is run twice over: once
neutering the **shipped `src/` predicate** each guard now executes, and once
neutering the **rule** in `scripts/lib/beds24-health-rules.mjs`.

A caution for whoever runs the harness next: `git checkout origin/main -- src/`
inside the harness silently imports whatever `origin/main` currently points at.
`origin/main` moved from 5b171bd to 8494385 in the middle of this run, and that
checkout dropped eight files of newer main — including five owned by PR #112 —
into this worktree as staged modifications. They were reverted with
`git reset -- src/ && git checkout HEAD -- src/` and never committed; the
identity verification block is what exposed it (`git status --porcelain -- src/`
was non-empty, which by the harness's own rules invalidates the run). Re-fetch
and re-baseline before trusting an A result.

---

## 6. Finding: the shared B2 harness mis-scores an unrunnable guard

`/tmp/.../scratchpad/b2harness.sh` decides RED/GREEN purely on the exit code of
`pnpm -s "$CHECK"`. Any guard whose *wiring* is broken — a missing
`--env-file`, a missing binary, a typo in the script name — exits non-zero and
is certified:

```
### RESULT A: RED (exit 9) — correct, the guard detects the clean-main state
### RESULT B2: RED (exit 9) — the guard is REAL. It tests behaviour, not text.
```

Nine guards in this repo are wired `--env-file=.env.local` (ten as of #113).
Every one of them will be certified "real" by this harness from any worktree,
without executing a single assertion. Proposed fix: before scoring, the harness
should require a *baseline green* — run the guard on the unmodified tree first
and refuse to score A/B2 unless that baseline is green. A guard that is red
before the experiment cannot be shown to have gone red because of it.

The local copy used here (`.b2/b2harness.sh`, gitignored) adds two things and
changes nothing else: `B2_SKIP_TESTDB_RESET=1` (these guards target staging;
dropping the shared `guesthub-testdb` schema would sabotage concurrent agents
mid-replay) and `B2_RUN_CMD` (direct invocation, since §4 blocks the
`package.json` rewiring).

---

## 7. Findings that a staging fixture CANNOT express — recorded, not deleted

Per the target's instruction, no assertion was removed. But it must be said
plainly what the new green tick means and what it does not.

The rebuilt guards prove the **rules** are correct and non-vacuous, and that
the **shipped code** agrees with them. They do **not** prove anything about the
live production integration. These five subjects are facts about production
that no staging fixture can establish:

| # | assertion | why staging cannot express it |
|---|---|---|
| C1 | exactly one ACTIVE connection, and it is Beds24 | a fact about the production tenant's rows; staging currently holds one **`channex`** connection (see §8) |
| C2 | the active connection is `environment=production` | a fixture can set the column, but "the live connection is not a sandbox" is unverifiable off production |
| C4 | a refresh token is configured | presence of a production credential; the fixture asserts only that the rule detects absence |
| C5 | the circuit breaker is closed **right now** | breaker state is live operational state; the fixture proves the rule and the shipped `circuitPhase()` agree on both an open and a closed row |
| J1 / R1 / A2 | the feed pulled in the last 30 min / the drain is keeping up | statements about the last 24h of production traffic |

These are **monitoring** questions, not guard questions. They are preserved as
an explicit, opt-in `--observe` mode on each script:

```
node scripts/check-beds24-connection.mjs --observe
```

`--observe` prints the same rules against whatever DSN was resolved and scores
**nothing** (`OBSERVE COMPLETE (informational — no assertions were scored)`). It
is never the default, and iron rule 11 still forbids pointing it at production
from automation. Turning it into a real production health signal needs an
alerting path, not a `check:*` script — that remains open.

---

## 8. Incidental findings for other targets

1. **Staging holds a `channex` connection** — `provider='channex'`,
   `state='active'`. D91 declared Channex deleted. The shipped
   `check:beds24-connection` fails on staging with
   `active provider must be beds24, got channex`. Relevant to the
   channex-zero-trace target; not fixed here (iron rule 8 — no row deletions).
2. **The `channel_connections.provider` CHECK constraint still admits
   `'channex'` and `'hospitable'`** — `CHECK (provider = ANY (ARRAY['channex',
   'hospitable', 'beds24']))`. D91's removal did not reach the schema. A
   migration 057+ could narrow it; not done here (migration numbering is
   contended and this is not this target).
3. **`channel_hospitable_property_mappings` still exists** in the staging
   schema.
4. **Nine → ten production-wired guards.** See §4.

---

## 9. What remains open

* the `package.json` rewiring in §4 — **the deliverable is inert until it lands**;
* `check:beds24-credit-headers` (new on main) has the same production wiring and
  has never been B2-tested;
* the harness scoring hazard in §6 affects every phase-2 target;
* production health monitoring (§7) has no home now that these four are guards
  rather than probes; `--observe` is a placeholder, not an alerting path;
* the staging `channex` row and the permissive provider CHECK (§8).
