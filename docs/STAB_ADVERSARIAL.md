# STAB — ADVERSARIAL REVIEW

**Reviewer:** adversarial agent. Wrote none of the code under review; was given the branches and
the guards only, deliberately without the reasoning that produced them.
**Base:** `origin/main` = `5b171bd6abbb7608b200d725fc38c40274da10fb`
**Worktrees used:** `/var/www/wt-adv` (report), `/var/www/wt-adv-merge` (all-branch merge),
`/var/www/wt-adv-{cards-pci,nosecrets,invstg,calscope,credit,aridrain,bcr}` (per-branch).
`/var/www/guesthub` was **never** used as a working tree, never built in, never deployed.
Every DB-backed experiment ran against the disposable `guesthub-testdb` (`:5433`, databases
`advcredit` / `advdrain` / `advmerge`, created and migrated by this review) or against staging
(`127.0.0.1:5434`). Production (`:5432`) was never written and never read by a guard.

**Grade counts:** 3 SEVERE · 8 MEDIUM · 6 MINOR.

---

## 0. Branch inventory — six of nineteen do not exist

`git fetch origin --prune`, then `git rev-parse origin/<branch>`:

```
stab/guard-cards-pci                               c55eaca
stab/guard-no-secrets-filesystem                   590af8d
stab/guard-inventory-staging                       323c091
stab/guard-calendar-scope                          d6d15cd
stab/guard-credit-backoff-b2                       8b29b7b
stab/guard-ari-readback-b2                         MISSING
stab/guard-beds24-four-b2                          MISSING
stab/guard-integrity-sweep                         MISSING
fix/payment-ledger-concurrent-refunds              MISSING
feat/channel-mapping-missing-alert                 MISSING
feat/needs-manual-decision-surface                 MISSING
stab/pr-triage                                     132c127
stab/staging-ui-verification                       7256e03
stab/env-and-backup                                24ff37d
stab/channex-zero-trace                            40ae5d6
fix/beds24-credit-gate-swallows-failures           f838f52
fix/ari-drain-guard-measured-credit-headers        c20a29d
fix/booking-com-reports-credit-meter               cddabb4
fix/room-1318-beds24-mapping                       b70c930
```

`docs/GUARD_INTEGRITY.md` exists on **no** branch in the repository:

```
$ for b in $(git branch -r); do git ls-tree -r --name-only $b -- docs/GUARD_INTEGRITY.md; done
(no output)
```

So there is no B2-coverage table to spot-check. Its intended producer,
`stab/guard-integrity-sweep`, was never pushed.

---

# SEVERE

## S1 — `stab/guard-inventory-staging` is inert through the only interface anyone uses

**Files:** `package.json:27,34,35,36` (unchanged by the branch) ·
`docs/GUARD_STAGING_DETACH.md:8,38-43`

The branch rewrites four guards to resolve their DSN from `CHECK_DB_URL || STAGING_DATABASE_URL`
and to ignore `DATABASE_URL`. The scripts are correct. But the `--env-file=.env.local` prefix
lives in `package.json`, which iron rule 6 reserves for PR #112, so it was not removed. The
canonical entry points therefore still fail exactly the way the branch's own header says it fixed
("the guard exited 9 (`node: .env.local: not found`) before reaching a single assertion").

Measured in `/var/www/wt-adv-invstg` (HEAD = `323c091`, `.env.staging` present, no `.env.local`):

```
$ ls -a | grep '^\.env'
.env.staging
$ pnpm -s check:inventory        → node: .env.local: not found   EXIT=9
$ pnpm -s check:effective-state  → node: .env.local: not found   EXIT=9
$ pnpm -s check:rate-grid        → node: .env.local: not found   EXIT=9
$ pnpm -s check:sellability      → node: .env.local: not found   EXIT=9
```

Bypassing the entry point proves the scripts themselves are fine:

```
$ node scripts/check-inventory.mjs
check-inventory: target 127.0.0.1:5434/guesthub_staging
check-inventory: all assertions passed                                   EXIT=0
$ node scripts/check-effective-state.mjs   → all DB assertions passed    EXIT=0
$ node scripts/check-rate-grid.mjs         → ALL 8 RATE-GRID CHECKS PASSED EXIT=0
$ node scripts/check-rate-sellability.mjs  → 7 checks passed             EXIT=0
```

Why SEVERE and not MEDIUM: the deliverable of target 2.3 was "these guards no longer run against
production and now actually run". Neither half is true through `pnpm check:*`. Anyone verifying
the branch the normal way sees exit 9 — the identical symptom to before the fix — and there is no
CI to catch the discrepancy (see M5). The branch documents the blocker honestly in
`docs/GUARD_STAGING_DETACH.md:38`, but a documented inert guard is still an inert guard.

**Proposed fix.** After #112 merges, four one-line edits — drop `--env-file=.env.local` from
`package.json:27,34,35,36`. Until then, add `scripts/lib/check-db-target.mjs` support for a
`CHECK_DB_URL` set in `.env.staging` (already done) **and** make each script `process.exit(2)`
with the "run me as `node scripts/…`" message when `process.argv` shows it was launched through
the broken alias — so the failure names its own cause instead of dying in node's arg parser.

---

## S2 — the D98 fix closes the swallow for HTTP 500 and leaves it wide open for HTTP 429

**File:** `src/lib/channel/beds24-ari-sync.ts:611-615` on
`fix/beds24-credit-gate-swallows-failures` (and on `stab/guard-credit-backoff-b2`, which contains
the same commit `f838f52`).

```ts
const creditPause = outcome.creditPause;
const creditIsTheWholeStory =
  failure === null ||
  (creditPause?.reason === "rate_limited" && failure.code === "rate_limited");
if (creditPause && creditIsTheWholeStory && warnings.length === 0) {
  …re-arm the ranges WITHOUT charging an attempt, open the breaker, return…
}
```

The second disjunct means: **when the provider answers 429, the failure is still swallowed.** No
attempt is charged, no `last_error_code` is recorded, and the range can never reach
`max_attempts`. On `origin/main` there is no such exemption — every failure, 429 included, goes
through `failRanges` (`src/lib/channel/beds24-ari-sync.ts:` the
`if (failure || warnings.length > 0 || deferred > 0)` block) and
`const dead = attempts >= r.max_attempts;` dead-letters it at 5. `grep -n rate_limited
src/lib/channel/queue.ts src/lib/channel/beds24-ari-sync.ts` on main returns nothing: 429 is not
special-cased anywhere.

Measured on a real database. I copied the branch's own guard, changed **one** fixture value in
the "permanently-failing range" section — `push = { status: 500, … }` → `status: 429` — and left
everything else untouched:

```
✓ 12. outbound control: a healthy window pushes the calendar and syncs the range
✓ 13. outbound (a): low Remaining re-arms the claimed range without an attempt …
✓ 14. outbound (D98): a 500 arriving on a low meter still charges an attempt …
>>> PROBE (permanent 429, 8 drains): status='pending' attempts=0 last_error_code='null' pushCalls=8
AssertionError: PROBE: a permanently 429-ing range must dead-letter (got 'pending', attempts=0)
   — an unbounded retry burns the very credits the pause exists to protect
```

Eight scheduler passes, eight provider calls, zero attempts charged, status still `pending`. The
quoted sentence in that assertion is the guard's **own** words, from
`scripts/check-beds24-credit-backoff.mjs:521` — the branch states the invariant and then exempts
the one status code most likely to violate it, because 429 is precisely what a credit-metered API
returns under pressure.

This is the D94 pattern in its purest form: a loud, bounded failure (dead-letter after 5) was
converted into a quiet, unbounded one, for the exact class of failure the change was written to
handle. The guard certifies the hole it does not probe: assertion 15 tests only status 500.

**Proposed fix.** Charge the attempt on a 429 as main does, and use the credit pause only to
control the *cooldown*, not the *accounting* — i.e. keep the `GREATEST(next_attempt_at, …)` push
and the breaker span, but always call `failRanges`. If unbounded 429 retry is genuinely wanted,
it must be bounded some other way (a separate `credit_pause_count` column with its own ceiling),
and `check:beds24-credit-backoff` must gain a `status: 429` twin of assertion 15.

---

## S3 — `check:cards`: a plaintext CVV at rest exits with the *same* code as the accepted deviation, under a banner that says nothing was silenced

**File:** `scripts/check-cards.mjs:75-92` (register/exit handler), `:381`, `:398` (escalation) on
`stab/guard-cards-pci`.

The branch does **not** simply make the check pass — that suspicion is cleared. Baseline and
branch both exit non-zero:

```
clean main      : AssertionError: no PSP_PROVIDER configured …check-cards.mjs:269   EXIT=1
guard-cards-pci : 1 REGISTERED DEVIATION(S) STILL PRESENT — check:cards is NOT green  EXIT=3
```

The defect is the *resolution* of the signal. I applied a B2 semantic neutering to
`src/lib/card-vault.ts:50-51`, replacing the `encryptCvv = encryptPan` alias with a function of
the same name that emits `v1.<iv>.<tag>.<base64-of-plaintext>` — every identifier, import and
call site preserved, only the encryption removed:

```
[ACTIVE] D87 — CVV/CVC is RETAINED AFTER AUTHORIZATION on the manual-entry card
  severity : CRITICAL (escalated beyond the accepted deviation)
     absent  · behavioural probe: the retained CVV is versioned-AES encrypted at rest
  !! ESCALATION — the deviation is now WORSE than the one that was accepted:
     the retained CVV is NOT encrypted at rest …
     the stored CVV value is recoverable from the stored blob WITHOUT the vault key (plaintext at rest)
…
1 REGISTERED DEVIATION(S) STILL PRESENT — check:cards is NOT green.
Exit code 3 = known, owner-owned deviation still in the code.
Every assertion in this suite PASSED; nothing was skipped or silenced.
B2_CARDS_EXIT=3
```

`3`. Byte-identical to the unmodified tree. A machine — and a human reading only the exit code or
the last line — cannot tell "the owner's accepted, encrypted-at-rest CVV" from "every stored CVV
is readable without the vault key". The final line, `Every assertion in this suite PASSED;
nothing was skipped or silenced`, is printed unconditionally at `:80` and is actively wrong in
the escalated case: an escalation is by construction something no assertion covered.

The same mechanism silently downgrades coverage that existed on main. `main`'s
`assert.ok(/cvvValid\(/.test(cardActions), "the stored CVV is validated")` was a hard exit-1
failure; the branch turns it into `cvvProbe.validateCall`, whose only consumer is the escalation
string at `:387` — i.e. exit 3, indistinguishable from baseline. Same for
`cvv_encrypted`-written-without-`encryptCvv()` and for `cvvValid()` becoming a no-op.

The register design is good and the "removing a deviation must make this greener, never redder"
principle is right. Nothing about that principle requires an **escalation** to be silent.

**Proposed fix.** One line: after the escalation list is built,
`assert.equal(d87Escalation.length, 0, "ESCALATION beyond the accepted D87 deviation: " +
d87Escalation.join("; "))`. That keeps removal green, keeps the accepted state at exit 3, and
makes "worse than accepted" exit 1. Also make the closing banner conditional — do not print
"nothing was skipped or silenced" when `DEVIATIONS.some(d => d.escalation?.length)`.

---

# MEDIUM

## M1 — `check:calendar-ui`: the month separator can be made invisible and the guard stays green

**File:** `scripts/check-calendar-ui.mjs:456-457` on `stab/guard-calendar-scope`.

The 3px pin was genuinely stale — `src/app/styles/calendar.css:435` reads
`width: 0.5px; /* reference month-boundary hairline */`, thinned by D107.1. Unpinning was
necessary. Unpinning to `/\bwidth: [\d.]+px/` was too far:

```
$ sed -i 's/width: 0.5px/width: 0px/' src/app/styles/calendar.css
$ grep -n 'width: 0px' src/app/styles/calendar.css
435:  width: 0px; /* reference month-boundary hairline */
$ pnpm -s check:calendar-ui
check-calendar-ui: all interaction/geometry rules hold ✔
MSEP_ZERO_WIDTH_EXIT=0
```

The month boundary — the very line whose disappearance the surrounding assertions exist to catch
("no cell/segment draws the month boundary as its own border — that is what broke the line") —
can be deleted entirely and the guard reports all rules hold. The guard was narrowed until it no
longer bites on the failure mode it was written for.

**Proposed fix.** Parse the number instead of matching it:
`const w = Number(sepRule.match(/\bwidth:\s*([\d.]+)px/)?.[1]); assert.ok(w > 0, ".cb-msep has a
visible width")`. Design owns the value; the guard owns "greater than zero".

## M2 — four branches collide on `package.json`, two on `DECISIONS.md`, despite iron rule 6

Merging the published branches into a scratch worktree in the listed order:

```
OK   stab/guard-cards-pci · stab/guard-no-secrets-filesystem · stab/guard-inventory-staging
OK   stab/guard-calendar-scope · fix/beds24-credit-gate-swallows-failures · stab/guard-credit-backoff-b2
CONFLICT fix/ari-drain-guard-measured-credit-headers   → package.json
CONFLICT fix/booking-com-reports-credit-meter          → package.json, DECISIONS.md
OK   stab/pr-triage · stab/staging-ui-verification · stab/env-and-backup
OK   stab/channex-zero-trace · fix/room-1318-beds24-mapping
CONFLICT fix/beds24-checkin-cancellation-guard (#112)  → package.json, DECISIONS.md
```

Rule 6 reserved `package.json` and `DECISIONS.md` for #112, but four branches added `check:*`
lines to `package.json` anyway (`check:beds24-credit-backoff`, `check:beds24-ari-drain`,
`check:beds24-quarantine-selfheal`, `check:booking-com-reports`) and two appended to
`DECISIONS.md`. Every conflict is an additive-line conflict and resolves trivially, but they must
be resolved by hand, in a fixed order, by whoever merges — and the one branch that genuinely
*needed* to edit `package.json` (S1) is the one that obeyed the rule.

With the conflicts hand-resolved, the fully merged stack is healthy:

```
$ pnpm typecheck   TYPECHECK_EXIT=0
$ pnpm lint        ✖ 31 problems (0 errors, 31 warnings)   LINT_EXIT=0
$ pnpm build       BUILD_EXIT=0
```

and all five new guards pass together against a freshly migrated DB (`advmerge`, 64 tables):

```
check-beds24-ari-drain: all 10 assertions passed                        EXIT=0
check-beds24-quarantine-selfheal: all 5 assertions passed               EXIT=0
check-beds24-credit-backoff: all 20 assertions passed                   EXIT=0
check-booking-com-reports: all 18 assertions passed                     EXIT=0
check-beds24-checkin-cancellation-guard: all 13 assertions passed       EXIT=0
```

## M3 — PR #113 is a third, conflicting implementation of the credit-header fix, and the triage does not mention it

`docs/PR_TRIAGE.md:1` — "PR TRIAGE — 12 open PRs against main @ `5b171bd`". There are **13**:

```
$ gh pr view 113 --json number,createdAt,headRefName,files
113  2026-07-25T13:46:39Z  fix/beds24-credit-headers
['docs/CREDIT_HEADERS_IMPACT.md','docs/FIX_CREDIT_HEADERS.md','package.json',
 'scripts/check-beds24-credit-headers.mjs','src/lib/channel/beds24-ari-sync.ts',
 'src/lib/channel/beds24-ari.ts','src/lib/channel/beds24-http.ts']
```

Its own commit says "…and the #104 overlap", so the collision is known to its author but not to
the triage. Merged onto the stack:

```
$ git merge origin/fix/beds24-credit-headers
CONFLICT (content): src/lib/channel/beds24-ari-sync.ts
CONFLICT (content): src/lib/channel/beds24-ari.ts
CONFLICT (content): src/lib/channel/beds24-http.ts
```

Three core channel files, plus a competing guard `check:beds24-credit-headers` that overlaps
`check:beds24-credit-backoff` on the same wire contract. The triage's central recommendation
("merge `fix/beds24-credit-gate-swallows-failures` instead of #104") is made without knowing a
third claimant to the same code exists.

**Proposed fix.** Re-run the triage against `gh pr list` at merge time, and decide explicitly
between #113 and the credit-gate branch — they cannot both land.

## M4 — the staging screenshot driver's "cannot reach production" claim is not true on this host

**Files:** `scripts/staging-screenshot.mjs:48-56` · `docs/STAGING_UI_VERIFICATION.md:254`
("הסקריפט מסרב לרוץ אם … אינם loopback — הוא לא יכול להתחבר לפרודקשן גם בטעות").

The refusal is a loopback allow-list: `["127.0.0.1","localhost","::1"]`. Production Supabase on
this host is `supabase-kong` bound to `0.0.0.0:8000`, i.e. reachable at `http://localhost:8000`:

```
$ curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8000/auth/v1/health
401
$ curl -s http://localhost:8000/auth/v1/health
{"message":"No API key found in request","request_id":"…"}
$ node -e '…console.log(["127.0.0.1","localhost","::1"].includes(new URL("http://localhost:8000").hostname))'
true
```

So a `NEXT_PUBLIC_SUPABASE_URL=http://localhost:8000` sails through the check, and the driver's
`grant_type=password` call would mint a session against **production GoTrue** — a write to
production auth (iron rule 12). The runbook's own invocation is
`node --experimental-websocket --env-file=.env.local scripts/staging-screenshot.mjs` (`:245`,
`:372`); the doc explains at `:203-214` that this `.env.local` is a staging-pointed one in the
*worktree*, but nothing in the script enforces that, and a copied production `.env.local` is the
obvious accident the guard claims to prevent.

**Proposed fix.** Replace the hostname allow-list with a port/identity allow-list: require the
resolved auth origin to be the staging GoTrue (`127.0.0.1:9989` or the `:9990` shim), or require
an explicit `STAGING_AUTH_FINGERPRINT` that the script verifies by `GET /settings` before it
posts credentials. Refuse port 8000 by name.

## M5 — there is no CI, so no guard runs unless a human types it

```
$ ls -a .github            → (absent)
$ ls .husky                → (absent)
$ ls .git/hooks | grep -v sample → (empty)
$ find . -maxdepth 3 -name '*.yml' | grep -v node_modules → ./pnpm-lock.yaml
```

Sixty-eight `check:*` scripts after the merge, zero automated invocations. Every statement in
this stabilization run of the form "the guard will catch X" means "a human who remembers to run
this one script will catch X". This also means S1's exit-9 breakage would never have surfaced on
its own, and that the exit-code nuance in S3 (3 vs 1) currently has no consumer at all.

**Proposed fix.** One workflow that runs the guards which need no database, plus a
`check:staging` aggregate for the DB-backed set, gated on a staging service container. Until then
the claim "guarded" should be written as "checkable".

## M6 — `check:beds24-ari-drain` is RED on its own branch; it only passes after another branch merges

`fix/ari-drain-guard-measured-credit-headers` standalone, against a freshly migrated DB
(`advdrain`):

```
$ pnpm -s check:beds24-ari-drain
null !== 97.6
    at scripts/check-beds24-ari-drain.mjs:407
EXIT=1
$ pnpm -s check:beds24-quarantine-selfheal
check-beds24-quarantine-selfheal: all 5 assertions passed   EXIT=0
```

The commit message declares the dependency ("תלוי ב-#104"), and in the merged stack it is green
(M2). But as published, the branch adds a `check:*` entry to `package.json` for a guard that
fails, so merging it alone turns main red. The same is true of
`fix/booking-com-reports-credit-meter`, whose fix commit also says "תלוי ב-#104".

**Proposed fix.** State the ordering constraint in the PR body as a merge-blocking checklist, or
rebase these two onto the credit-gate branch so they cannot be merged out of order.

## M7 — `check:no-secrets` reads production credential files by default and is pinned to this host

**File:** `scripts/check-no-secrets.mjs:79-80` — `DEFAULT_TREE = "/var/www/guesthub"`,
`DEFAULT_BACKUP_DIR = "/home/ubuntu"`.

The guard is genuinely good — it fails closed when the tree is absent (`:199-203`, `blocked`
counter, `CANNOT ASSERT` at `:440`), it never prints a value (`say()` at `:65-71` throws on
value-shaped tokens, verified in every run below), and it never extracts a tarball. Its
content-shape claim reproduces exactly: I planted a synthetic dotenv named
`application-config.txt` (fake values) in a sandbox tree and it was classified anyway:

```
[OBSERVED] A. credential-store inventory of …/faketree (1 files walked)
  · application-config.txt  —  mode 0664, 4 assignments, 100% assignment density
  ·      credential-bearing KEY NAMES: CARD_VAULT_KEY, DATABASE_URL, SUPABASE_SERVICE_ROLE_KEY
✗ [OBSERVED] B. 1 STRAY credential store(s) …
RENAMED_EXIT=1
```

Against the real defaults it finds real exposure and goes red (`EXIT=1`): two stray
`.env.local.*.bak` files in the deploy tree and four world-readable `/home/ubuntu` tarballs each
carrying four dotenv members.

The MEDIUM is the coupling, not the correctness. `classifyDotenvShape` reads the **plaintext of
production credential files** into process memory on every run, and the two default paths are
machine-specific. That is defensible for a secrets-hygiene scanner and only ever emits names, but
it means (a) the guard is unrunnable anywhere else, and (b) it is the one guard in the suite that
must read production to be meaningful — which sits awkwardly beside iron rule 11 and cannot be
reconciled by the guard itself.

**Proposed fix.** Make the target explicit rather than defaulted: require `NO_SECRETS_TREE`
(without the sandbox flag) and ship the production path in a committed `check-targets.json`, so
the choice to read production is a visible, reviewable line rather than a constant at `:79`.

## M8 — `docs/PR_TRIAGE.md` and `docs/GUARD_STAGING_DETACH.md` are the run's only record of two blockers that `DECISIONS.md` should carry

Both documents correctly explain that rule 6 prevented them from writing to `DECISIONS.md` and
`package.json`. The consequence is that the canonical decision log records neither the
`--env-file=.env.local` debt (S1) nor the #104/#113 contention (M3). A reader of `DECISIONS.md`
after #112 merges will find no trace of either. This is a process finding, not a code defect, but
it is how S1 gets forgotten.

**Proposed fix.** A single `## D99 — stabilization-run debts` entry appended to `DECISIONS.md` by
whoever merges #112, listing the four `package.json` lines and the #113 decision, with links to
the two docs.

---

# MINOR

## m1 — the `check:calendar` escape-hatch contract is entirely text-matching on the hatch body

`scripts/check-calendar.mjs` step 4 (the `ESCAPE_HATCHES` block) asserts `requirePermission(`,
`writeAudit(`, `enqueueChannelJob(` and the absence of `UPDATE|INSERT INTO|DELETE FROM
guesthub.reservations` / `markAriDirty|applyCancellation|recomputePaymentAggregates` — all by
regex over `sf.text.slice(region.start, region.end)`. A helper function declared elsewhere in the
file and *called* from the hatch performs any of those writes without the hatch body ever
matching. The assertions are correctly labelled `CONTRACT BREACH (§M/§W)`, so they are within the
standard, but they are the compensating control for the only exemption in an otherwise
graph-based rule.

**Proposed fix.** Extend the region walk one hop: attribute writes performed by any top-level
function *reachable only from* the hatch to the hatch itself.

## m2 — the transitive module walk drops the type-only filter below depth 0

`scripts/check-calendar.mjs`: at the entry file, `st.importClause.isTypeOnly` is skipped, but the
recursive step pushes every specifier from `moduleEdges(parseFile(target))`, which does not
distinguish `import type`. A type-only edge into a network module will be reported as a save
reaching the socket. False positive, not false negative — but false positives are how a guard
gets narrowed next time.

## m3 — `NET_PKGS` is an incomplete package list

`/^(axios|undici|got|node-fetch|superagent|node:https?|https?)$/` misses `ky`, `phin`, `needle`,
`request`, `bent`, and any `@scope/http-*`. The global-`fetch` leaf predicate covers most real
cases, so this is a gap in the belt, not the braces.

## m4 — `assert.doesNotMatch(tooltip, /normalizeVisibleChannel/)` bans an identifier outright

`scripts/check-calendar-ui.mjs`. Any future legitimate use of the nullable normalizer anywhere in
`ReservationTooltip.tsx` — including in an unrelated line — fails the guard. The intent (do not
feed the badge from the nullable resolver) is narrower than the assertion.

## m5 — new non-`check:` scripts have no `pnpm` entry point

`scripts/lib/check-db-target.mjs`, `scripts/staging-auth-proxy.mjs`,
`scripts/staging-screenshot.mjs`, `scripts/ops/guesthub-tree-snapshot.sh`,
`scripts/ops/repack-backup-without-env.sh`, `scripts/ops/with-guesthub-env.sh` — all unregistered.
Correct for a library and for ops scripts, but it means the runbooks are the only discovery path
for `guesthub-tree-snapshot.sh`, the script that exists specifically to stop people hand-rolling
`tar czf`.

## m6 — migration 055 is claimed by two branches with byte-identical content

```
$ diff <(git show origin/night/p2-2-booking-com-reports:db/migrations/055_booking_com_channel_reports.sql) \
       <(git show origin/fix/booking-com-reports-credit-meter:db/migrations/055_booking_com_channel_reports.sql)
055 IDENTICAL across the two branches
```

Not a collision (the second is the rebase of the first), but only one of them may merge. 056 is
held by `origin/night/reservation-source-system` (`056_source_system.sql`); the next free number
is 057, as instructed.

---

# What I verified and could NOT fault

Recorded so the negatives carry weight.

| Claim | Verdict | Evidence |
|---|---|---|
| Target 2.1 did not "just make check:cards pass" | **TRUE** | branch exits 3, banner is loud, no assertion deleted without a behavioural replacement (S3 is about resolution, not about passing) |
| `check:cards`'s new gateway assertion is behavioural, and main's grep was dead text | **TRUE** | `src/lib/payments/gateway.ts:39-46` has no `if (!provider) return null;`; main died at `:269`, skipping exactly **114** later assertions — the branch's number reproduces to the unit |
| Target 2.4 did not narrow §M/§W into uselessness | **TRUE, it is stronger** | a re-export chain (`rate-plans/actions.ts → lib/rates/plan-metrics.ts → beds24-http.ts`) is caught by the new guard and provably invisible to the old regex (`old HTTP regex hits file: false`, `old HTTP_MODULES hits any import: false`); importing `channel/worker` is still caught, transitively, five hops down to `twilio.ts` |
| the D93 escape hatch really is confined | **TRUE** | AST attribution shows `beds24-http`, `channel-http`, `beds24-token`, `beds24-normalize`, `channel/config`, `channel/queue` referenced **only** inside `releaseChannelReservationAction`; `channel/outbox` only inside the four real saves |
| `resolveChannelBadge` totality is asserted behaviourally | **TRUE, B2 RED** | neutering `?? "manual"` to `?? null` while keeping the name → `EXIT=1` |
| a 500 on a low meter charges an attempt and dead-letters at 5 | **TRUE, verified on a real DB** | assertions 14/15 pass; B2 (`creditIsTheWholeStory … \|\| true`, names intact) → `AssertionError: a 500 must charge an attempt even when the credit meter is low (got attempts=0 …)` `EXIT=1` |
| `check:beds24-ari-drain` is real | **TRUE, B2 RED** | `const dead = attempts >= r.max_attempts && neverDead` → `AssertionError: the exhausted range is reported as failed` `EXIT=1` |
| `check:booking-com-reports` is real | **TRUE, B2 RED** | `windowRejection` short-circuited to `return null` with every identifier intact → `EXIT=1` |
| `check:no-secrets` catches a renamed credential file | **TRUE** | see M7 |
| `check:no-secrets` never prints a value | **TRUE** | `say()` boundary at `:65-71`; four full runs, no value emitted |
| Channex zero-trace: `src/` is clean | **TRUE** | `git grep -niE 'channex\|hospitable\|stripe' -- src/` → 0 lines on main |
| Channex P-5: `/rates` badges are tenant-scoped, not connection-scoped | **TRUE (code)** | `src/lib/rates/grid-state.ts:177-201` — three queries keyed on `tenant_id` only |
| the source-dropdown screenshot shows what its caption says | **TRUE** | `docs/screenshots/02b-…png` renders `כל המקורות · אתר רשמי · ישיר · טלפון · מזדמן · Booking.com · Airbnb · Expedia · מהמערכת`, `מהמערכת` last, exactly as claimed |
| backup hygiene scripts exclude `.env*` | **TRUE** | `--exclude='.env*'` present in both tar invocations and in `guesthub-tree-snapshot.sh`, which additionally re-lists the archive and deletes it if any `.env` member survives |
| `with-guesthub-env.sh` is fail-closed and value-silent | **TRUE** | refuses missing/unreadable file, refuses mode ≠ 600/400, prints names only |
| the merged stack builds | **TRUE** | typecheck 0, lint 0 errors, build 0 |

---

# Claims I could not reproduce

1. **`docs/GUARD_INTEGRITY.md`** — does not exist on any branch. No B2-coverage table to
   spot-check; its producer branch (`stab/guard-integrity-sweep`) was never pushed.
2. **Six of the nineteen branches I was given do not exist on `origin`** —
   `stab/guard-ari-readback-b2`, `stab/guard-beds24-four-b2`, `stab/guard-integrity-sweep`,
   `fix/payment-ledger-concurrent-refunds`, `feat/channel-mapping-missing-alert`,
   `feat/needs-manual-decision-surface`. Nothing to attack.
3. **"Several agents could not register their `check:*` scripts in package.json."** The opposite
   is what I measured: **all four** new guards (`check:beds24-credit-backoff`,
   `check:beds24-ari-drain`, `check:beds24-quarantine-selfheal`, `check:booking-com-reports`)
   *are* registered — which is why they conflict with #112 (M2). The one branch that respected
   rule 6, `stab/guard-inventory-staging`, is the one left inert (S1).
4. **`fix/room-1318-beds24-mapping`** — "room 1318 is absent from Beds24, case (a), no
   overbooking exposure". Verifying this requires reading production data and/or calling the
   Beds24 API with the production token. Iron rules 8 and 11 forbid both. **Unverified.**
5. **`docs/CHANNEX_ZERO_TRACE.md` production-data figures** — 13 `channel_room_mappings` rows, 66
   `pending` dirty ranges, 10 `channex_verified` alias rows, 2 suspended `channel_connections`,
   14 `channel_beds24_room_mappings`. All are production reads. **Unverified.** The code-level
   half of the same finding (§0.1, tenant-scoped queries in `grid-state.ts`) reproduces exactly.
6. **`docs/STAGING_UI_VERIFICATION.md` screenshots 01 and 03** — I verified 02b against its
   caption only. 01 (`/rooms` closed-state chips on rooms 1006/1000) and 03 (Booking.com action
   bar on reservation #1083) rest on a staging seed I did not rebuild. **Unverified.**
7. **`docs/GUARD_STAGING_DETACH.md`'s claim that all four guards go green with the four
   `package.json` lines changed** — reproduced by the equivalent route (`node scripts/…`, all
   four `EXIT=0`), not by editing `package.json`, which rule 6 forbids.

---

# Method

Experiment A and B2 followed `b2harness.sh` exactly: A restores from `origin/main` and prints
`git rev-parse origin/main` plus an empty `git diff --stat` / `git status --porcelain` before the
run; B2 edits the central predicate to a no-op **by hand**, leaving every name, import, call site
and string literal in place, and confirms no identifier disappeared from the diff. `git stash`
was never used as an experiment. Every DB-backed run started from a virgin schema: for the shared
`guesthub-testdb` schema, `DROP SCHEMA IF EXISTS guesthub CASCADE`; for the guards that want a
whole database, a fresh `CREATE DATABASE` plus the full 62-entry `db/migrations/manifest.txt`
chain (`advcredit`, `advdrain`, `advmerge` — 63/63/64 tables respectively).

No file was deleted. No fix was applied. Every source edit made for an experiment was reverted
with `git checkout HEAD -- <file>` in the same command that made it; every scratch worktree is
detached and unpushed except `stab/adversarial`, which contains this document and nothing else.
