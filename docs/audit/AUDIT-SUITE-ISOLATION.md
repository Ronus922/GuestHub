# SUITE ISOLATION AUDIT

**Date:** 2026-08-03 · **Repo:** `/var/www/guesthub` (`Ronus922/GuestHub`) · **main @ 4d59eaa**
**Mode:** read-only investigation. No repo file was modified, no guard was rewritten, no migration was added, nothing was committed, nothing deployed. Everything below is measured; where I could not verify, the word is **UNKNOWN**.

**Test bed.** A detached worktree at `4d59eaa` (`/home/ubuntu/worktrees/suite-isolation`), `pnpm install --frozen-lockfile`, and a local `.env.local` copied from production with `DATABASE_URL` rewritten to the disposable `:5433` test database. Every number below comes from that tree.

---

## Headline

The suite has **three** contamination channels, and the one that caused the reported symptom is **not the database**.

1. **The filesystem.** Five guard scripts create their scratch directory with `mkdtempSync` inside `node_modules/.cache` *without creating that directory first*. On a tree where it does not exist they die with `ENOENT`. Five other guards create it as a side effect and never remove it. So the first run of the suite on a fresh checkout fails the consumers that happen to be ordered before the first creator; every later run passes them, forever, because the directory now exists on disk. That is exactly the reported symptom.
2. **The database.** Five guards leave rows behind in the shared `guesthub` schema. Three of them drop and rebuild that schema — including its migration ledger — as their *cleanup*. One of the leavers is the sole supplier of the `tenants` row that three other guards crash without.
3. **My own harness, and by extension the normal one.** Nine guards fail-closed on a missing `CHECK_*_DB_URL` and exit 2 *without running*. Counted naively that reads as nine failures. Given the env they ask for, **all nine pass**. Every headline pass/fail number for this suite is therefore sensitive to which shell launched it.

A fourth finding, unrelated to ordering but fatal to the premise of the exercise: **the repo's replay-from-zero tool has not worked since migration 064** (2026-07-29), and on `main` today it aborts before touching the database at all. No suite run since 064 has been against a freshly replayed schema, including the one reported for D133.

The one piece of good news is also measured: a replay from zero, done by hand, produces a schema **byte-identical to production's** — same tables, same columns, same ledger contents. The chain itself is sound. Only the tool that walks it is broken.

---

## 1. Method

Three passes over all 91 `check:*` scripts in `package.json`, each guard spawned as `pnpm -s <name>` with a 240 s timeout:

| pass | schema handling | purpose |
|---|---|---|
| **isolated** | `DROP SCHEMA guesthub CASCADE` + restore from a pristine dump before *every* guard; row counts of every table taken before and after | what each guard needs, and what each guard leaves |
| **ordered** ×3 | one restore, then all 91 straight through, in *declared*, *reverse*, and *shuffled (seed 20260803)* order | which verdicts move when only the order moves |
| **env-gated** | restore before each; `CHECK_DB_URL`, `CHECK_CONCURRENCY_DB_URL`, `CHECK_MARK_CLEAN_DB_URL`, `CHECK_SOURCES_DB_URL` all pointed at the disposable DB | real verdicts for the nine guards that had refused to run |

Harness: `runner.mjs`, `pass-isolated.mjs`, `pass-ordered.mjs`, `pass-envgated.mjs`; results in `isolated.json` / `ordered.json` / `envgated.json`. Those files are **not in this repository** — see [Raw evidence](#raw-evidence) at the end. Every number this report asserts is written out inline below, so the report stands on its own without them.

**What the passes do not control.** The filesystem. `restore()` resets the database only; `node_modules/.cache` persists across the whole audit. That is why the isolated pass — which ran first, on a tree where `pnpm install` had just created a virgin `node_modules` — is the only pass that ever saw the `ENOENT`. It is also why finding 1 is invisible to any suite run on a warm tree.

---

## 2. Finding A — the filesystem channel

Five scripts do this:

```js
const out = mkdtempSync(join(process.cwd(), "node_modules/.cache/<prefix>-"));
```

`mkdtempSync` creates the **last** path component only. If `node_modules/.cache` does not exist, it throws `ENOENT`. Measured, verbatim, from the isolated pass on the fresh tree:

```
Error: ENOENT: no such file or directory, mkdtemp
  '/home/ubuntu/worktrees/suite-isolation/node_modules/.cache/check-in-check-out-XXXXXX'
  at scripts/check-check-in-check-out.mjs:6:13
```

**Consumers (no `mkdirSync` first):**

| script | guard |
|---|---|
| `scripts/check-check-in-check-out.mjs` | `check:check-in-check-out` |
| `scripts/check-check-in-check-out-db.mjs` | `check:check-in-check-out-db` |
| `scripts/check-guest-communications.mjs` | `check:guest-communications` |
| `scripts/check-guest-communications-automation.mjs` | `check:guest-communications` |
| `scripts/check-guest-communications-worker.mjs` | `check:guest-communications` |

**Creators (`mkdirSync(…, {recursive:true})` first — they leave the directory behind):**
`check:ari-horizon` (#22), `check:wa-template-render` (#51), `check:resolve-version-lineage` (#53), `check:channels-fullsync-ui` (#66), `check:calendar-departure-edge` (#70).
(`scripts/render-pricing-evidence.mjs` also creates it, but is not a `check:` guard.)

**Why only two guards actually failed.** In declared order the first creator is `check:ari-horizon` at #22. `check:check-in-check-out` (#9) and `check:check-in-check-out-db` (#10) run before it and die. The `guest-communications` trio sits at #48, after #22, and passes on the dirt #22 left. So on a virgin tree the suite loses exactly two guards — and after that first run it never loses them again on that tree, because nothing ever removes `node_modules/.cache`.

**Corroboration from a second tree.** `baseline.txt`, captured earlier the same evening in `/home/ubuntu/worktrees/connection-health` by an unrelated script, shows `FAIL check:check-in-check-out` and `FAIL check:check-in-check-out-db` — the same pair, the same cause, a different worktree. This is reproducible, not incidental.

**Severity.** Every new worktree, every CI runner with a cold cache, every `rm -rf node_modules && pnpm install` starts with two red guards that have nothing to do with the code under test. The three `guest-communications` scripts are one reordering away from joining them.

**Fix (one line each):** `mkdirSync(join(process.cwd(), "node_modules/.cache"), { recursive: true })` before the `mkdtempSync`, exactly as `check-wa-template-render.mjs:35` and `check-resolve-version-lineage.mjs:90` already do. Better still, a shared `scratchDir()` helper so the next guard cannot get it wrong.

---

## 3. Finding B — the database channel

Row counts of every table in `guesthub`, taken before and after each guard on a freshly restored schema. Five guards ended with a different state than they started:

| guard | what it leaves |
|---|---|
| `check:deploy-migrations` | `schema_migrations` **77 → 0** |
| `check:totals-parity` | `schema_migrations` **77 → 62** |
| `check:beds24-failure-evidence` | `schema_migrations` **77 → 62** |
| `check:beds24-maxstay-no-limit` | 12 tables populated from empty: `tenants` 1, `rooms` 2, `room_types` 1, `sellable_units` 2, `sellable_unit_rooms` 2, `pricing_plans` 3, `pricing_plan_units` 2, `pricing_plan_unit_rates` 18, `channel_connections` 1, `channel_beds24_room_mappings` 2, `channel_dirty_ranges` 1, `channel_evidence_ledger` 1 |
| `check:mark-clean-permission` | `permissions` **30 → 31** |

Three of those — `check:totals-parity` (`check-totals-parity.mjs:96`), `check:beds24-failure-evidence` (`check-beds24-failure-evidence.mjs:77`) and the scratch-dir replay inside `check:deploy-migrations` — do `DROP SCHEMA IF EXISTS guesthub CASCADE` and re-apply `db/migrations/*.sql` in `readdirSync().sort()` order, against the **shared** schema. That is not cleanup; it is a rebuild of everyone else's world in the middle of the run.

**The 77 → 62 is itself a defect.** The ledger table is created by `064_schema_migrations.sql`, which backfills 62 filenames — every migration that existed and was verified applied at 064's birth. A plain sort-order replay therefore ends with 62 ledger rows, not 77: the 15 files added after 064 apply, but nothing records them, because only the deploy script (`apply-pending-migrations.mjs:82`) writes a row per applied file. Any guard that runs afterwards and asks "is the schema up to date?" is told **no**, incorrectly.

**Severity.** A guard that reports on the ledger is reading a lie for the rest of the run. `check:deploy-migrations` leaves it empty outright.

---

## 4. Finding C — order sensitivity, fully explained

Four guards changed verdict between the three orders:

| guard | declared | reverse | shuffled | alone |
|---|:--:|:--:|:--:|:--:|
| `check:rate-grid` | FAIL | **PASS** | FAIL | FAIL |
| `check:beds24-ari` | PASS | **FAIL** | PASS | PASS |
| `check:inventory` | FAIL | FAIL | **PASS** | FAIL |
| `check:sellability` | FAIL | FAIL | **PASS** | FAIL |

They are not flaky. They are deterministic functions of position, and one rule predicts **all twelve cells**.

### C1 — the tenant famine (`rate-grid`, `inventory`, `sellability`)

All three open with the same line:

```js
const [{ id: tenant }] = await sql`SELECT id FROM guesthub.tenants LIMIT 1`;
```

On an empty schema that destructure throws `TypeError: Cannot read properties of undefined (reading 'id')` — a crash, not an assertion. They need a tenant row and none of them creates one. The only guard in the suite that leaves a tenant behind is `check:beds24-maxstay-no-limit` — which **fails** in every order, and leaves its fixtures anyway.

So: *pass iff the supplier ran earlier **and** no schema-wiper ran in between.*

| order | supplier @ | wipers @ | `rate-grid` | `inventory` | `sellability` |
|---|---|---|---|---|---|
| declared | 32 | 1 / 14 / **34** | @18 — no supplier yet → **FAIL** | @37 — wiper 34 between → **FAIL** | @38 — wiper 34 between → **FAIL** |
| reverse | 60 | 91 / 78 / 58 | @74 — supplier before, clean → **PASS** | @55 — supplier not yet → **FAIL** | @54 — supplier not yet → **FAIL** |
| shuffled | 23 | 68 / 44 / 51 | @80 — three wipers between → **FAIL** | @40 — clean → **PASS** | @36 — clean → **PASS** |

Nine cells, nine correct predictions.

### C2 — the dirty range (`check:beds24-ari`)

`check:beds24-maxstay-no-limit` also leaves `channel_dirty_ranges` = 1. `check:beds24-ari` asserts on it:

```
BEDS24 ARI CHECK FAILED: 1 ranges dirtied in 24h but zero succeeded ARI pushes
```

Alone it passes *vacuously* — "nothing dirtied in 24h (0 pushes ran) — freshness vacuously OK".

| order | `beds24-ari` @ | supplier @ | wipers between? | result |
|---|---|---|---|---|
| declared | 23 | 32 | — supplier runs later | **PASS** (vacuous) |
| reverse | 69 | 60 | none (58 < 60) | **FAIL** ← reads another guard's row |
| shuffled | 75 | 23 | 44, 51, 68 all wipe | **PASS** (vacuous) |

Three cells, three correct predictions. Note both failure modes are present: the same leftover produces a **false FAIL** here and, via the tenant, a **false PASS** in C1. The suite is not merely noisy — it is wrong in both directions, and which direction you get is decided by `package.json` key order.

---

## 5. Finding D — replay-from-zero has been broken since 064

`scripts/db/migrate.mjs` is the tool whose docstring promises "deterministic replay-from-zero". On `main` today it has **two independent, measured defects**.

**D1 — it aborts before connecting.** The runner cross-checks manifest against disk and refuses any mismatch:

```
$ MIGRATE_DATABASE_URL=…:5433/gh_migrate_probe node scripts/db/migrate.mjs --status
Target database: host=localhost port=5433 db=gh_migrate_probe user=supabase_admin (password hidden)
ABORT: 075_sync_jobs_finished_index.sql is on disk but missing from manifest.txt
```

Measured: `manifest.txt` lists 76 files, 77 `.sql` files are on disk, the delta is exactly `075_sync_jobs_finished_index.sql`, and there are no duplicates and no manifest entries missing from disk. One forgotten line.

**D2 — two incompatible definitions of one table.** Fix D1 and the replay dies at 064 instead. `migrate.mjs` bootstraps its own ledger before applying anything (`migrate.mjs:72`):

```sql
CREATE TABLE IF NOT EXISTS guesthub.schema_migrations (
  version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz, applied_by text)
```

`064_schema_migrations.sql:30` declares the same table differently:

```sql
CREATE TABLE IF NOT EXISTS guesthub.schema_migrations (
  filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())
```

`IF NOT EXISTS` means whoever runs first wins silently, and the runner always runs first. Reproduced directly:

```
psql:db/migrations/064_schema_migrations.sql:33: NOTICE:  relation "schema_migrations" already exists, skipping
psql:db/migrations/064_schema_migrations.sql:98: ERROR:  column "filename" of relation "schema_migrations" does not exist
LINE 1: INSERT INTO guesthub.schema_migrations (filename) VALUES
```

The deploy path speaks `filename` (`apply-pending-migrations.mjs:82,96`); the replay path speaks `version`/`checksum`. Production runs the deploy path, which is why nobody noticed: **the ledger in production is correct and complete** (77 rows, matching the 77 files on disk exactly — verified, the only diff against `ls` being sort collation on `009_phase4a_sellable_units.sql`). It is only replay-from-zero that has been dead since 2026-07-29.

**Consequence for the record.** Every suite run since 064 — including the one reported for D133 — ran against a schema that was migrated *forward*, never one replayed from zero. Whatever those runs proved, they did not prove that.

**And the reassuring part.** Replaying the chain by hand into a scratch database (`replay-scratch.mjs`, manifest order plus the orphan, `--single-transaction` per file) applies all 77 cleanly and yields a schema whose table list and full column list are **identical** to production's. `diff` on both is empty. The migration chain is healthy; only `migrate.mjs` and one manifest line are not.

---

## 6. The real baseline

The nine env-gated guards (`check:db-isolation`, `check:reservation-concurrency`, `check:inventory-integrity`, `check:payment-ledger-integrity`, `check:payment-refund-void`, `check:pms-domain-invariants`, `check:background-job-recovery`, `check:mark-clean-permission`, `check:sources-breakdown`) exit 2 with `need CHECK_…_DB_URL` when the launching shell lacks the variable. My first two passes did not export it. Corrected by re-running them with it — **9 pass, 0 fail**.

| pass | raw | corrected |
|---|---|---|
| isolated (fresh schema, alone) | 58 / 33 | **67 pass / 24 fail** |
| ordered — declared | 60 / 31 | **69 pass / 22 fail** |
| ordered — reverse | 60 / 31 | **69 pass / 22 fail** |
| ordered — shuffled | 62 / 29 | **71 pass / 20 fail** |

The corrected declared-order number, **69/22 of 91**, matches `branch.txt` from the earlier D133 run exactly — an independent confirmation from a different worktree and a different launcher.

**Read that spread as the damage estimate.** Same code, same commit, same machine, same minute: the suite reports anywhere from 67 to 71 green depending on nothing but ordering and the caller's environment. Four guards' verdicts are decided by position; two more by whether `node_modules/.cache` happens to exist; nine more by which shell you used.

**The honest floor is the isolated column: 67 pass / 24 fail.** That is the only figure where each guard was asked its question against a known, identical starting state.

### What this audit does *not* claim

The 22 stable failures are stable — same verdict alone and in all three orders — so they are **not** ordering artifacts. Whether each is a real product defect, a stale fixture, or an environment gap (headless browser, network, missing secret) was **not** investigated here and remains **UNKNOWN**. Signature triage only: 5 assert cleanly, 3 crash on missing DB shape, the rest print guard-specific messages. That is a separate piece of work.

---

## 7. Recommended fixes, ranked

Each rests on a measurement above. None has been applied.

| # | fix | rests on | effort |
|---|---|---|---|
| 1 | Add `075_sync_jobs_finished_index.sql` to `manifest.txt` | §5 D1 | one line |
| 2 | Reconcile the two `schema_migrations` shapes — make `migrate.mjs` bootstrap the 064 shape, or stop bootstrapping and let 064 own the table | §5 D2 | small, but needs care: 064 is applied in production |
| 3 | `mkdirSync(…/node_modules/.cache, {recursive:true})` in the five consumer scripts, or one shared `scratchDir()` helper | §2 | five lines |
| 4 | Stop `check:totals-parity` and `check:beds24-failure-evidence` from dropping the **shared** schema — give each its own disposable database, as `check:mark-clean-permission` and `check:sources-breakdown` already do via their own `CHECK_*_DB_URL` | §3 | medium |
| 5 | Make `check:rate-grid`, `check:inventory`, `check:sellability` seed their own tenant instead of crashing on `LIMIT 1` — and fail with a message, not a `TypeError` | §4 C1 | small |
| 6 | Make `check:beds24-maxstay-no-limit` clean up its 12 tables in a `finally` | §3, §4 | small |
| 7 | A guard that runs the suite in shuffled order in CI and fails on any verdict that moves — this whole class stays fixed only if something watches it | §4 | medium |
| 8 | Export the four `CHECK_*_DB_URL` variables from one place the suite owns, so "did it run?" stops depending on the caller's shell | §6 | small |

Fixes 1 and 2 are prerequisites for ever trusting a from-zero suite run again. Fix 3 is what makes a fresh checkout green. Fixes 4–6 are what make the order stop mattering.

---

## Appendix — full per-guard table

`declared` / `reverse` / `shuffled` = the three ordered passes. `alone` = isolated pass, fresh schema per guard. Rows marked ⚑ are the nine env-gated guards, shown with their corrected verdict from the env-gated pass; every other cell is as originally measured.

| # | guard | declared | reverse | shuffled | alone | note |
|--:|---|:--:|:--:|:--:|:--:|---|
| 1 | `check:deploy-migrations` | PASS | PASS | PASS | PASS | **leaves** `schema_migrations` 77→0 |
| 2 | `check:e2e-safety` | PASS | PASS | PASS | PASS | |
| 3 | `check:guard-roots` | PASS | PASS | PASS | PASS | |
| 4 | `check:commercial` | PASS | PASS | PASS | PASS | |
| 5 | `check:commercial-db` | PASS | PASS | PASS | PASS | |
| 6 | `check:room-pricing` | PASS | PASS | PASS | PASS | |
| 7 | `check:room-db` | PASS | PASS | PASS | PASS | |
| 8 | `check:settings-regression` | PASS | PASS | PASS | PASS | |
| 9 | `check:check-in-check-out` | PASS | PASS | PASS | **FAIL** | ENOENT — needs `node_modules/.cache` |
| 10 | `check:check-in-check-out-db` | PASS | PASS | PASS | **FAIL** | ENOENT — needs `node_modules/.cache` |
| 11 | `check:rate-plans` | PASS | PASS | PASS | PASS | |
| 12 | `check:pricing-engine` | FAIL | FAIL | FAIL | FAIL | stable |
| 13 | `check:pricing-equality` | FAIL | FAIL | FAIL | FAIL | stable |
| 14 | `check:totals-parity` | PASS | PASS | PASS | PASS | **drops shared schema**; ledger 77→62 |
| 15 | `check:public-quote` | PASS | PASS | PASS | PASS | |
| 16 | `check:room-picker-window` | FAIL | FAIL | FAIL | FAIL | stable |
| 17 | `check:rates-ui` | PASS | PASS | PASS | PASS | |
| 18 | `check:rate-grid` | FAIL | **PASS** | FAIL | FAIL | **order-sensitive** — needs a tenant row (§4 C1) |
| 19 | `check:beds24-connection` | FAIL | FAIL | FAIL | FAIL | stable |
| 20 | `check:beds24-jobs` | FAIL | FAIL | FAIL | FAIL | stable |
| 21 | `check:beds24-revisions` | FAIL | FAIL | FAIL | FAIL | stable |
| 22 | `check:ari-horizon` | PASS | PASS | PASS | PASS | creates `node_modules/.cache` |
| 23 | `check:beds24-ari` | PASS | **FAIL** | PASS | PASS | **order-sensitive** — reads a leftover dirty range (§4 C2) |
| 24 | `check:beds24-credit-headers` | FAIL | FAIL | FAIL | FAIL | stable |
| 25 | `check:beds24-payload-integrity` | PASS | PASS | PASS | PASS | |
| 26 | `check:beds24` | FAIL | FAIL | FAIL | FAIL | stable |
| 27 | `check:beds24-cancellation-sync` | PASS | PASS | PASS | PASS | |
| 28 | `check:beds24-checkin-cancellation-guard` | PASS | PASS | PASS | PASS | |
| 29 | `check:beds24-ari-readback` | PASS | PASS | PASS | PASS | |
| 30 | `check:booking-com-reports` | PASS | PASS | PASS | PASS | |
| 31 | `check:beds24-credit-backoff` | PASS | PASS | PASS | PASS | |
| 32 | `check:beds24-maxstay-no-limit` | FAIL | FAIL | FAIL | FAIL | stable — **leaves 12 tables**, the suite's tenant supplier |
| 33 | `check:beds24-ari-drain` | PASS | PASS | PASS | PASS | |
| 34 | `check:beds24-failure-evidence` | PASS | PASS | PASS | PASS | **drops shared schema**; ledger 77→62 |
| 35 | `check:beds24-quarantine-selfheal` | PASS | PASS | PASS | PASS | |
| 36 | `check:effective-state` | FAIL | FAIL | FAIL | FAIL | stable |
| 37 | `check:inventory` | FAIL | FAIL | **PASS** | FAIL | **order-sensitive** — needs a tenant row (§4 C1) |
| 38 | `check:sellability` | FAIL | FAIL | **PASS** | FAIL | **order-sensitive** — needs a tenant row (§4 C1) |
| 39 | `check:reservation-snapshot` | PASS | PASS | PASS | PASS | |
| 40 | `check:calendar` | PASS | PASS | PASS | PASS | |
| 41 | `check:channels-badge` | FAIL | FAIL | FAIL | FAIL | stable |
| 42 | `check:cards` | FAIL | FAIL | FAIL | FAIL | stable |
| 43 | `check:payments` | PASS | PASS | PASS | PASS | |
| 44 | `check:channel-card-ingest` | PASS | PASS | PASS | PASS | |
| 45 | `check:card-save-flow` | PASS | PASS | PASS | PASS | |
| 46 | `check:messaging` | PASS | PASS | PASS | PASS | |
| 47 | `check:ttlock-secrets` | PASS | PASS | PASS | PASS | |
| 48 | `check:guest-communications` | PASS | PASS | PASS | PASS | latent ENOENT — passes only after #22 creates the cache dir |
| 49 | `check:guest-communications-db` | FAIL | FAIL | FAIL | FAIL | stable |
| 50 | `check:ota-confirm-once` | PASS | PASS | PASS | PASS | |
| 51 | `check:wa-template-render` | PASS | PASS | PASS | PASS | creates `node_modules/.cache` |
| 52 | `check:automation-design` | PASS | PASS | PASS | PASS | |
| 53 | `check:resolve-version-lineage` | PASS | PASS | PASS | PASS | creates `node_modules/.cache` |
| 54 | `check:business-profile` | PASS | PASS | PASS | PASS | |
| 55 | `check:maps-picker` | PASS | PASS | PASS | PASS | |
| 56 | `check:su-lifecycle` | PASS | PASS | PASS | PASS | |
| 57 | `check:room-identity` | PASS | PASS | PASS | PASS | |
| 58 | `check:db-isolation` ⚑ | PASS | PASS | PASS | PASS | needs `CHECK_DB_URL`; exits 2 without it |
| 59 | `check:channel-security` | FAIL | FAIL | FAIL | FAIL | stable |
| 60 | `check:channel-chaos` | PASS | PASS | PASS | PASS | |
| 61 | `check:housekeeping` | FAIL | FAIL | FAIL | FAIL | stable |
| 62 | `check:maintenance-closures` | PASS | PASS | PASS | PASS | |
| 63 | `check:reports` | PASS | PASS | PASS | PASS | |
| 64 | `check:israel-market` | PASS | PASS | PASS | PASS | |
| 65 | `check:agents-concurrency` | PASS | PASS | PASS | PASS | |
| 66 | `check:channels-fullsync-ui` | PASS | PASS | PASS | PASS | creates `node_modules/.cache` |
| 67 | `check:hydration-browser` | FAIL | FAIL | FAIL | FAIL | stable |
| 68 | `check:status-default` | PASS | PASS | PASS | PASS | |
| 69 | `check:calendar-ui` | FAIL | FAIL | FAIL | FAIL | stable |
| 70 | `check:calendar-departure-edge` | PASS | PASS | PASS | PASS | creates `node_modules/.cache` |
| 71 | `check:design` | FAIL | FAIL | FAIL | FAIL | stable |
| 72 | `check:dashboard-shell` | PASS | PASS | PASS | PASS | |
| 73 | `check:connection-health` | PASS | PASS | PASS | PASS | |
| 74 | `check:datepicker` | PASS | PASS | PASS | PASS | |
| 75 | `check:reservations-ui` | PASS | PASS | PASS | PASS | |
| 76 | `check:reservation-concurrency` ⚑ | PASS | PASS | PASS | PASS | needs `CHECK_CONCURRENCY_DB_URL` |
| 77 | `check:reservation-source-system` | PASS | PASS | PASS | PASS | |
| 78 | `check:inventory-integrity` ⚑ | PASS | PASS | PASS | PASS | needs `CHECK_DB_URL` |
| 79 | `check:payment-ledger-integrity` ⚑ | PASS | PASS | PASS | PASS | needs `CHECK_DB_URL` |
| 80 | `check:payment-refund-void` ⚑ | PASS | PASS | PASS | PASS | needs `CHECK_DB_URL` |
| 81 | `check:timezone-and-money-invariants` | PASS | PASS | PASS | PASS | |
| 82 | `check:pms-domain-invariants` ⚑ | PASS | PASS | PASS | PASS | needs `CHECK_DB_URL` |
| 83 | `check:background-job-recovery` ⚑ | PASS | PASS | PASS | PASS | needs `CHECK_DB_URL` |
| 84 | `check:no-secrets` | PASS | PASS | PASS | PASS | |
| 85 | `check:supply-chain` | FAIL | FAIL | FAIL | FAIL | stable |
| 86 | `check:retention` | PASS | PASS | PASS | PASS | |
| 87 | `check:performance` | PASS | PASS | PASS | PASS | |
| 88 | `check:code-documentation` | PASS | PASS | PASS | PASS | |
| 89 | `check:nightly-revenue` | PASS | PASS | PASS | PASS | |
| 90 | `check:mark-clean-permission` ⚑ | PASS | PASS | PASS | PASS | needs `CHECK_MARK_CLEAN_DB_URL`; **leaves** `permissions` 30→31 |
| 91 | `check:sources-breakdown` ⚑ | PASS | PASS | PASS | PASS | needs `CHECK_SOURCES_DB_URL` |

## Raw evidence

**The raw evidence is not in this repository, by design, and cannot be recovered from git.**

It lives on the audit host only, at:

```
/var/www/guesthub/ref/audit/suite-isolation-2026-08-03/
```

`ref/` is gitignored (`.gitignore:54`) under the D87 rule — this repository is public, and reference dumps must never be committed. Nothing in that directory was ever staged, and `git log` will never show it. If the host is rebuilt, it is gone.

That is deliberate, and it is why **every figure this report asserts is written out inline**: the per-guard verdicts (appendix), the leftover row counts (§3), the guard positions and the order model (§4), the verbatim `psql` and Node errors (§2, §5), and the four corrected pass/fail totals (§6). No claim here requires opening a file to check. The dump exists to let someone re-derive the same numbers, not to complete an argument this document leaves half-made.

Contents of that directory:

| file | what it holds |
|---|---|
| `isolated.json` | per-guard exit code, duration, output tail, and before/after row-count delta — fresh schema per guard |
| `ordered.json` | the same, for all three ordered passes (declared / reverse / shuffled) |
| `envgated.json` | the nine env-gated guards, re-run with `CHECK_*_DB_URL` exported |
| `order-lists.json` | the exact guard sequence used by each of the three orders, including the seed-20260803 shuffle |
| `buckets.json` | static classification of each guard script (writes / rollback / drops schema / no DB) |
| `runner.mjs`, `pass-isolated.mjs`, `pass-ordered.mjs`, `pass-envgated.mjs` | the harness, so the passes can be reproduced |
| `analyze.mjs`, `classify.mjs`, `replay-scratch.mjs` | the analysis and the from-zero replay used in §5 |
| `prod-tables.txt` / `rebuilt-tables.txt`, `prod-cols.txt` / `rebuild-cols.txt` | production vs replayed-from-zero schema — `diff` on both is empty |
| `prod-ledger.txt` / `disk.txt` | the 77 ledger rows against the 77 files on disk |
