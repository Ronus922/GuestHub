# check:beds24-ari-readback — B2 record, blockers, residual gaps

Phase 2 / target 2.6 (guard integrity). Branch `stab/guard-ari-readback-b2`.
Subject under test: the ARI read-back from PR #106 (`origin/night/p0-3-ari-readback`,
commit `b7719ba`), imported here **verbatim** so the experiments are reproducible.

## What the module must do

`src/lib/channel/beds24-ari-readback.ts` DETECTS (never corrects) drift between
what Beds24 HOLDS and what we intend it to hold, inside the existing
`reconcile_inventory` job. It is the outbound mirror of D93: a room occupied
here that Beds24 is still selling.

A guard for it is therefore only real if it goes red when **detection is
silently disabled** — not when a name or an import disappears.

## The B2 record (measured, not claimed)

Every neutering below kills a predicate and leaves **every** identifier, import,
call site and string literal in place; the runner verifies that no identifier
disappeared from the diff before it runs the guard.

| # | Semantic neutering | file | #106 guard | rebuilt guard |
|---|--------------------|------|-----------|---------------|
| A | subject restored from clean `origin/main` (module deleted, worker unwired) | `src/` | RED (ENOENT stack) | RED (diagnosed: "MISSING SUBJECT …") |
| 1 | `if (readbackWired && drainable) await runBeds24AriReadback(sql, drainable, jobId)` — the job never calls it | `worker.ts` | **GREEN — FAILED** | RED |
| 2 | the drainable half of `ensureReconcileJobs` targets nothing — an outbound-only connection never gets a job | `worker.ts` | **GREEN — FAILED** | RED |
| 3 | the `ari_readback_failed` branch disabled — blindness is never reported | `beds24-ari-readback.ts` | **GREEN — FAILED** | RED |
| 4 | a transport failure THROWS instead of being recorded — the reconcile job fails with it | `beds24-ari-readback.ts` | **GREEN — FAILED** | RED |
| 5 | `if (availabilityDriftDetected && got.numAvail !== want.numAvail)` — the comparison itself | `beds24-ari-readback.ts` | RED | RED |
| 6 | `oversell: … && DETECT_OVERSELL` (false) — the oversell signature is never flagged | `beds24-ari-readback.ts` | RED | RED |

Phase 3 reported #106's guard as "11/11, B2 RED". That is true only for the
predicate they happened to neuter (5 or 6). Four of the six neuterings above
passed unnoticed: the module's **wiring**, its **cadence** and its **failure
contract** were asserted with `readFileSync` + a regex, never executed.

`false && <narrowed expression>` does not compile under TS strict (narrowing is
dropped in unreachable code, `TS18048`), so neuterings are written as
`<expr> && FLAG` or with a `const FLAG = false` guard — a neutering that does
not compile is not an experiment.

## What the rebuild adds

* **§7 — the wiring, executed.** `worker.runTick()` runs for real: the reconcile
  cadence must enqueue a job for a connection with **no inbound sync** (the
  read-back is the only reason such a connection needs one), the tick must run
  it, and the `channel_evidence_ledger` row must carry **that job's id**.
* **§8 — a blind read-back is an alert, never a failed job.** Beds24 answers 500
  for a whole cycle: `ari_readback_failed` must be raised, the evidence row must
  say `outcome = failed`, and the reconcile job must still end `succeeded` —
  the D93 cancellation half rides in the same job.
* **CONTRACT labelling.** The remaining text-level assertions (no push import,
  one `beds24Request` call site, GET only, the one path literal, no new job
  type) fail with `CONTRACT breach (source text, not behaviour)`.
* **A diagnosed experiment-A failure** instead of an ENOENT stack.
* **Self-seeding**: the check replays the migration chain into the disposable
  test DB when the schema is absent, so it runs standalone (11 → 13 assertions).

## Blockers (they could NOT be fixed on this branch)

1. **`package.json` cannot be touched** (iron rule 6 — owned by PR #112). The
   entry `"check:beds24-ari-readback": "node scripts/check-beds24-ari-readback.mjs"`
   therefore does **not** exist on this branch; it exists on #106. Until one of
   the two is merged, the check runs only as
   `node scripts/check-beds24-ari-readback.mjs`, and `pnpm check:beds24-ari-readback`
   fails with "command not found". Same rule blocks the DECISIONS.md entry, which
   is why this file exists.
2. **The run-wide test-DB reset is a no-op.** Every phase of this run resets with
   `docker exec -i guesthub-testdb psql -U postgres -d postgres -c "DROP SCHEMA IF EXISTS guesthub CASCADE;"`.
   The schema is owned by `supabase_admin`; psql answers
   `ERROR: must be owner of schema guesthub` **and exits 0**, and the harness
   sends stderr to `/dev/null`. Nothing is dropped, no migration replays, and
   every "virgin schema" claim in this run is false. Working reset: run
   `DROP SCHEMA … CASCADE` + the chain over the `TEST_DATABASE_URL` connection
   (user `supabase_admin`), which is what this check now does for itself.
3. **The check writes to the disposable test DB (`:5433`), not to staging
   (`:5434`)** — deliberately, against the phase-2 preference. It creates a
   scratch tenant and deletes it again; iron rule 8 forbids deleting DB rows, and
   `guesthub-testdb` is the only DB in this environment where the whole schema is
   disposable. Pointing it at staging would mean either leaving fixture rows
   behind forever or deleting rows in a shared DB.

## Residual gaps (honest list)

* The reconcile job's **ordering** contract — the read-back must not delay or
  suppress the D93 booking half — is only half covered. §8 proves a failed
  read-back does not fail the job; it does not prove that a failing *booking*
  reconciliation still leaves the read-back running (the fixture connection has
  `inbound_sync_enabled = false`, so `reconcileError` is always null). Covering
  it needs an inbound fixture plus a booking-import mock, which belongs with
  PR #112's material.
* `BEDS24_READBACK_DAYS`, `BEDS24_READBACK_REQUEST_COST` and
  `BEDS24_CREDIT_CEILING` are asserted as exported values, i.e. against the
  measurement recorded in #106's header. They are not re-measured against the
  live API by this check (and must not be — the guard is offline).
* `pnpm build` was not run on this branch: nothing under `src/` is authored here
  (`pnpm typecheck` and `pnpm lint` are clean; lint reports 0 errors, and none of
  its 31 pre-existing warnings is in this file).
