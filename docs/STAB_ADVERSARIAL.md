# STAB_ADVERSARIAL — RUN 2

Adversarial review of the GuestHub stabilization run. I wrote none of the code
under review. I was given the branches and the guards only.

**Base:** `origin/main` = `8494385` (**not** `5b171bd` — the baseline handed to
me is two merges stale; PRs #112, #113, #114 landed in between).
**Worktree:** `/var/www/wt-adv` (branch `stab/adversarial`).
**Scratch worktrees:** `/var/www/wt-adv-{cards-pci,nosecrets,invstg,calscope,credit,aridrain,bcr,merge,r2a,r2b,r2c}`.
**Production was never used as a working tree, never built, never deployed to,
never read by any guard I ran.** Every DB-backed run targeted `guesthub-testdb`
(:5433) or `guesthub_staging` (127.0.0.1:5434).

**Grade counts: 5 SEVERE · 8 MEDIUM · 6 MINOR.**

Everything below was re-derived in RUN 2. Nothing was carried over from RUN 1.

---

## 0. Facts about the environment that change the picture

| claim in the brief | measured |
|---|---|
| `origin/main` is `5b171bd` | **`8494385`**. `5b171bd` is an ancestor; #112/#113/#114 merged after it. |
| PR #112 `fix/beds24-checkin-cancellation-guard` "is awaiting merge" | **Already merged** (`c93b401`). Iron rule 6's premise is false. I still obeyed rule 6 and wrote nothing outside `docs/STAB_ADVERSARIAL.md`. |
| 63 `check:*` scripts | **66** on `8494385` (`git show origin/main:package.json \| grep -oE '"check:[a-z0-9-]+"\s*:' \| wc -l` → 66). |
| — | **There is NO CI in this repository.** No `.github/`, no `.gitlab-ci`, no husky/lefthook, no git hooks. `prebuild` is only the production-tree build blocker. **Nothing runs any `check:*` automatically, ever.** Registration in `package.json` is the only discoverability mechanism there is. |

---

## SEVERE

### S1 — `check:cards`: a PCI **escalation** is indistinguishable from the accepted deviation. The loud failure became a quiet one (D94 pattern)

**Files:** `scripts/check-cards.mjs:91` (the exit handler), `:395-408` (the
escalation block), `:78-83` (the banner text) — branch `stab/guard-cards-pci`.

Target 2.1 was told not to change card-storage behaviour but to make the PCI
violation report loudly. It does report loudly — in **prose**. The **signal**
does not change.

```js
// scripts/check-cards.mjs:87-92
process.on("exit", (code) => {
  printRegister();
  if (code === 0 && DEVIATIONS.some((d) => d.status !== "resolved")) process.exitCode = 3;
});
```

`d87Escalation` is never consulted. Its only effects are the printed
`!! ESCALATION` block and the `severity` string.

**B2, run by me.** Semantic neutering of the CVV vault — `encryptCvv` keeps its
name, its export and every call site; only the ciphertext construction is
replaced so the CVV is stored recoverably:

```ts
// src/lib/card-vault.ts:50-51  (B2 neutering — reverted after the run)
-export const encryptCvv = encryptPan;
-export const decryptCvv = decryptPan;
+export const encryptCvv = (v: string): string => `v1.${v}`;
+export const decryptCvv = (v: string): string => v.replace(/^v1\./, "");
```

Printed result:

```
  severity : CRITICAL (escalated beyond the accepted deviation)
     absent  · behavioural probe: the retained CVV is versioned-AES encrypted at rest
  !! ESCALATION — the deviation is now WORSE than the one that was accepted:
     the retained CVV is NOT encrypted at rest — encryptCvv() did not produce versioned ciphertext that hides the value
     the stored CVV value is recoverable from the stored blob WITHOUT the vault key (plaintext at rest)
...
1 REGISTERED DEVIATION(S) STILL PRESENT — check:cards is NOT green.
Exit code 3 = known, owner-owned deviation still in the code.
Every assertion in this suite PASSED; nothing was skipped or silenced.

EXIT=3
```

Baseline, same branch, healthy code: **also `EXIT=3`**, also
`1 REGISTERED DEVIATION(S) STILL PRESENT`, also
`Every assertion in this suite PASSED; nothing was skipped or silenced.`

So: **plaintext card verification codes at rest produce byte-identical exit
behaviour to the state the owner accepted**, and the summary line actively
reassures. Anything that watches exit codes — a human running
`pnpm check:cards; echo $?`, a future CI, a deploy script — sees no change at
all. The register is strictly better at *detection* than main's
`assert.notEqual(ct, "123")` (which my neutering would have passed); it is
strictly worse at *alerting*.

**Proposed fix (one line, no behaviour change):**

```js
process.on("exit", (code) => {
  printRegister();
  const escalated = DEVIATIONS.some((d) => d.escalation?.length);
  if (code === 0 && escalated) process.exitCode = 4;              // NEW: escalation ≠ accepted
  else if (code === 0 && DEVIATIONS.some((d) => d.status !== "resolved")) process.exitCode = 3;
});
```

and make the two "nothing was skipped or silenced" lines conditional on
`!escalated`.

---

### S2 — `stab/guard-inventory-staging` and `stab/guard-beds24-four-b2` are **inert as delivered**: eight guards still exit 9 before their first assertion

**Files:** `package.json:27,34,35,36` (inventory branch) and
`package.json:28,29,30,31,34` (beds24 branch) — **neither branch modifies
`package.json` at all** (`git diff <base> <branch> --stat -- package.json` is
empty on both).

Both branches rewrite the `.mjs` files to resolve `CHECK_DB_URL ||
STAGING_DATABASE_URL` and to ignore `DATABASE_URL`. But `package.json` still
invokes them as `node --env-file=.env.local scripts/…`, and **node aborts on the
missing env file before it loads a single line of the script**:

```
### check:inventory via pnpm:         node: .env.local: not found   EXIT=9
### check:effective-state via pnpm:   node: .env.local: not found   EXIT=9
### check:rate-grid via pnpm:         node: .env.local: not found   EXIT=9
### check:sellability via pnpm:       node: .env.local: not found   EXIT=9
### check:beds24-connection via pnpm: node: .env.local: not found   EXIT=9
### check:beds24-jobs via pnpm:       node: .env.local: not found   EXIT=9
### check:beds24-revisions via pnpm:  node: .env.local: not found   EXIT=9
### check:beds24-ari via pnpm:        node: .env.local: not found   EXIT=9
```

The same scripts invoked **directly** are healthy — the work is real, it is just
not wired:

```
### check-inventory direct:          check-inventory: target 127.0.0.1:5434/guesthub_staging
                                     check-inventory: all assertions passed          EXIT=0
### check-effective-state direct:    all DB assertions passed                        EXIT=0
### check-rate-grid direct:          ALL 8 RATE-GRID CHECKS PASSED                   EXIT=0
### check-rate-sellability direct:   ✔ rate sellability: 7 checks passed             EXIT=0
### check-beds24-connection direct:  BEDS24 CONNECTION CHECK: 16 PASSED              EXIT=0
### check-beds24-jobs direct:        BEDS24 JOBS CHECK: 11 PASSED                    EXIT=0
### check-beds24-revisions direct:   BEDS24 REVISIONS CHECK: 14 PASSED               EXIT=0
### check-beds24-ari direct:         BEDS24 ARI CHECK: 10 PASSED                     EXIT=0
```

`check:beds24` (the aggregate of the four) is inert with them. This is exactly
the failure mode `scripts/lib/check-db-target.mjs`'s own header describes —
"the guard exited 9 … before reaching a single assertion, so it was RED whether
the system was healthy or broken. A guard with the same output in both states
carries zero signal." — left in place by the branch that wrote it.

**Proposed fix:** drop `--env-file=.env.local` from those eight entries
(`check:beds24` needs no change). One `package.json` hunk. It could not be
written because iron rule 6 reserved `package.json` for PR #112 — **which is
already merged**, so the block no longer exists.

---

### S3 — `fix/booking-com-reports-credit-meter` does not typecheck, standalone **or** merged onto current main

**File:** `src/lib/channel/beds24-booking-reports.ts:155`.

```ts
  const creditsRemaining = r.credits.remaining;
```

Standalone on its own branch (`pnpm typecheck`, exit 2):

```
src/lib/channel/beds24-booking-reports.ts(155,30): error TS2339: Property 'credits' does not exist on type 'Beds24Response'.
```

Merged onto `origin/main` `8494385` (conflicts in `DECISIONS.md` +
`package.json` resolved, then `pnpm typecheck`, exit 2):

```
src/lib/channel/beds24-booking-reports.ts(155,28): error TS18048: 'r.credits' is possibly 'undefined'.
```

Main (post-#113) declares `credits?: Beds24CreditReading` — **optional**. The
branch needs the **non-optional** `credits: Beds24CreditSnapshot` that exists
only on `stab/guard-credit-backoff-b2` / `fix/beds24-credit-gate-swallows-failures`,
neither of which is merged and both of which conflict with main (S4).

`check:booking-com-reports` therefore cannot run at all — it dies compiling
`tsconfig.check.json` after six static assertions:

```
✓ 6. static: migration 055 shape + manifest entry
src/lib/channel/beds24-booking-reports.ts(155,30): error TS2339: ...
Error: Command failed: pnpm exec tsc -p tsconfig.check.json      EXIT=1
```

The dependency is **not declared anywhere in the branch** — no note in `docs/`,
no `DECISIONS.md` line. The branch looks self-contained (a migration, a
component, a guard) and is the kind of thing a reviewer merges first. Doing so
breaks `pnpm typecheck` and `pnpm build` on main.

**Proposed fix:** land the credit work first (rebased — see S4), then rebase
this branch on it; or make line 155 defensive (`r.credits?.remaining ?? null`)
so it compiles against main's optional shape, and tighten it afterwards.

---

### S4 — the D97/D98 credit work **re-implements what PR #113 already merged**, and conflicts with main in three `src/` files

**Branches:** `stab/guard-credit-backoff-b2` (`8b29b7b`),
`fix/beds24-credit-gate-swallows-failures` (`f838f52`).

Merging either into `8494385`:

```
CONFLICT (content): Merge conflict in DECISIONS.md
CONFLICT (content): Merge conflict in package.json
CONFLICT (content): Merge conflict in src/lib/channel/beds24-ari-sync.ts
CONFLICT (content): Merge conflict in src/lib/channel/beds24-ari.ts
CONFLICT (content): Merge conflict in src/lib/channel/beds24-http.ts
```

and with `stab/guard-ari-readback-b2` already merged, a sixth:
`CONFLICT (content): Merge conflict in src/lib/channel/worker.ts`.

This is not just staleness. **Two independent implementations of the same
measured-header credit reader now exist:**

| | `origin/main` (PR #113) | branch |
|---|---|---|
| module | `src/lib/channel/beds24-http.ts` | **new** `src/lib/channel/beds24-credits.ts` |
| reader | `readBeds24Credits(headers: HeaderBag)` | `readBeds24Credits((name) => …)` |
| type | `Beds24CreditReading` | `Beds24CreditSnapshot` |
| response field | `credits?: Beds24CreditReading` (optional) | `credits: Beds24CreditSnapshot` (required) |
| guard | `check:beds24-credit-headers` (**production-wired**, `--env-file=.env.local`) | `check:beds24-credit-backoff` (testdb) |
| uses it to **gate**? | **no** — main only records the meter | **yes** — this is the whole point |

The two are complementary in *intent* (main records; the branch gates) and
overlapping in *implementation*. A careless conflict resolution can leave both
readers in the tree, or wire the gate to the reader that is never populated on
the failing path. There is no note anywhere saying which one survives.

**Proposed fix:** rebase `stab/guard-credit-backoff-b2` onto `8494385`,
deleting main's `readBeds24Credits`/`Beds24CreditReading` in favour of
`beds24-credits.ts` (or the reverse), and reconcile
`check:beds24-credit-headers` with `check:beds24-credit-backoff` — they assert
the same three header names twice.

---

### S5 — four new guards ship with **no `package.json` entry**, in a repo that has **no CI**

| guard script | branch | `check:*` entry |
|---|---|---|
| `scripts/check-payment-ledger-concurrency.mjs` | `fix/payment-ledger-concurrent-refunds` | **none** |
| `scripts/check-channel-mapping-alert.mjs` | `feat/channel-mapping-missing-alert` | **none** |
| `scripts/check-manual-decision-surface.mjs` | `feat/needs-manual-decision-surface` | **none** |
| `scripts/check-beds24-ari-readback.mjs` | `stab/guard-ari-readback-b2` | **none** |

(`grep -c 'check:<name>' package.json` → 0 on each branch.)

All four are **real** guards — I ran and B2'd every one of them (§6). But there
is no `.github/workflows`, no git hook and no aggregate `check:all` in this
repo, so a guard that is not in `package.json` is not merely "not in CI" — it is
**not discoverable at all**. It will be found by whoever greps `scripts/` next.

This matters most for `check:payment-ledger-concurrency`. It is, as of this run,
**the only guard in the repository that catches the money neutering
`GUARD_INTEGRITY.md` §4.1 is built around** (verified — see M5) — and it is the
one nobody can invoke by name.

**Proposed fix:** four lines in `package.json`. Blocked by iron rule 6 for the
authoring agents; **that block is gone** now that #112 is merged.

---

## MEDIUM

### M1 — three **new** guards reintroduce the exact run-order defect target 2.8 exists to eliminate

`stab/guard-integrity-sweep` fixed six guards that crashed on a virgin schema by
giving each one its own database (`scripts/lib/check-disposable-db.mjs`).
Verified — all six now run standalone after `DROP SCHEMA guesthub CASCADE` over
the owner connection:

```
check:beds24-cancellation-sync           exit=0
check:calendar-departure-edge            exit=0
check:channel-card-ingest                exit=0
check:background-job-recovery            exit=0
check:payment-refund-void                exit=0
check:reservation-concurrency            exit=0
```

Three guards **added by this same run** do not follow the pattern. Each opens
the shared `postgres://…@localhost:5433/postgres` and queries `guesthub.tenants`
without building the schema:

| guard | branch | virgin schema | after another guard seeded it |
|---|---|---|---|
| `check:beds24-credit-backoff` | `stab/guard-credit-backoff-b2`, `fix/beds24-credit-gate-swallows-failures` | **crash** — `PostgresError: relation "guesthub.tenants" does not exist` at `check-beds24-credit-backoff.mjs:242` | 20/20 pass |
| `check:beds24-ari-drain` | `fix/ari-drain-guard-measured-credit-headers` | **crash**, same error at `check-beds24-ari-drain.mjs:277` | 10/10 pass |
| `check:beds24-quarantine-selfheal` | same | **crash**, same error | 5/5 pass |

Their green is a property of the run ORDER. `scripts/lib/check-disposable-db.mjs`
already exists on a sibling branch and solves this in ~10 lines per guard.

### M2 — D-number collisions: this run allocated D96/D97 over numbers already in use

`DECISIONS.md` on main stops at **D94**. But `docs/` on main already cites
higher numbers, with different meanings:

```
origin/main:docs/audit/WORKFLOW_INVENTORY.md:109  ... probe via userinfo (D95).
origin/main:docs/audit/WORKFLOW_INVENTORY.md:110  **D96 automated guest communications:** ...
origin/main:docs/audit/PMS_GAP_MATRIX.md:99       ## 10. Communications (D96/D97)
origin/main:docs/BEDS24_COMPLETION_PLAN.md:8      **excluded throughout per D108** ...
```

Against that:

| new allocation | branch | collides with |
|---|---|---|
| `## D96 — דיווחי מצב ל-Booking.com` | `fix/booking-com-reports-credit-meter` | D96 = automated guest communications (3 docs on main) |
| `## D97 — חלון הקרדיטים של Beds24` | both credit branches | D97 = Communications (`PMS_GAP_MATRIX.md:99`) |
| `// Staging-only Supabase-URL shim (D97).` | `stab/staging-ui-verification` (`scripts/staging-auth-proxy.mjs:2`, `scripts/staging-screenshot.mjs:2`) | a **third** meaning of D97 |
| `D107` (calendar channel row) | `stab/guard-calendar-scope`, `stab/guard-integrity-sweep` | not in `DECISIONS.md` at all; only in commit `2ab6ae1` |

Historically: PR #104 shipped the same credit work as **D94**, which #112 then
took. Renumbering to D97 moved the collision rather than resolving it.

**Proposed fix:** allocate D109+ for everything in this run and add a one-line
"next free number" marker at the top of `DECISIONS.md`.

### M3 — `check:cards`: the CVV containment assertions are gated behind `D87_ACTIVE`, and the comment above them says the opposite

```js
// scripts/check-cards.mjs — the comment
// A channel guarantee NEVER carries a CVV and a stored card NEVER shows one
// before the audited reveal — asserted unconditionally, because these bound
// how far the registered deviation can spread.
  if (D87_ACTIVE) {
    assert.equal(ch.cvv, "", "a channel guarantee never carries a CVV");
    assert.equal(both.cvv, "", "a stored card shows no CVV until the audited reveal");
```

They are not asserted unconditionally. And `D87_ACTIVE` is
`D87_SIGNALS.some(([, present]) => present)` over **eleven name-based signals** —
`typeof rules.cvvValid === "function"`, `typeof vault.encryptCvv === "function"`,
source greps for `cvv_encrypted`, `encryptCvv(`, `decryptCvv(`, and the UI
forwarding sites. A rename-only refactor (`cvv_encrypted` →
`verification_code_enc`, `encryptCvv` → `encryptVerification`, …) drives all
eleven to absent. The register then prints
`[NONE] D87 — CVV/CVC retention — NO LONGER DETECTED … status: resolved`, the
containment assertions never run, and the suite exits **0 — fully green** —
while the retention continues under new names.

The `.some()` (rather than `.every()`) means this needs a *complete* rename, so
it is not a one-line escape; it is a plausible refactor.

**Proposed fix:** add one signal that cannot be renamed away — e.g. probe
`reservation_cards` for any column whose stored value round-trips a 3–4 digit
numeric through the vault — and fail the suite (exit 1) if the register flips to
`resolved` while such a column exists.

### M4 — `check:channels-badge` left RED with the same D107 root cause the calendar branch diagnosed and fixed

On the merged tree:

```
check:calendar               exit=0     (fixed by stab/guard-calendar-scope)
check:calendar-ui            exit=0     (fixed by stab/guard-calendar-scope)
check:channels-badge         exit=1
  AssertionError: exactly four visible channel definitions — no manual entry
```

Three guards were stale for one reason (D107 added the `manual` badge). Two were
fixed; the third was left — and `stab/guard-calendar-scope` even asserts the
correct model (`CHANNEL_ORDER` = the four externals, `manual` is a badge, not a
legend entry) two files away. No branch in the set owns it.

### M5 — `GUARD_INTEGRITY.md` §4.1 overstates the remaining gap; a sibling branch already closed it

I reproduced the headline finding exactly. Structure-preserving neutering
(every literal any guard greps for survives verbatim):

```diff
-      WHERE reservation_id = ${reservationId} AND tenant_id = ${tenantId}
+      WHERE reservation_id = ${reservationId} AND tenant_id = ${tenantId} AND 1 = 0
```

```
check:payments                             exit=0
check:payment-ledger-integrity             exit=0
check:pms-domain-invariants                exit=0
check:timezone-and-money-invariants        exit=0
```

(My first, looser attempt — `FILTER (WHERE status = ${COLLECTED_PAYMENT_STATUS} AND false)` —
was caught by `check:payments` exit 1, exactly as §4.1 predicts and for exactly
the CONTRACT reason it gives. The document is right on both counts.)

But §4.1 then states:

> **No guard in this repo executes `recomputePaymentAggregates` and reads the
> result back.** … Open work: a behavioural money guard that calls the shipped
> function.

`fix/payment-ledger-concurrent-refunds`, a branch in the **same run**, delivers
exactly that. Under the identical neutering:

```
✗ D: BEHAVIOUR — a refund on one reservation broke a parallel refund on another — … R1={"ledger":40,"rows":2,"paid":0,…}
✗ E: BEHAVIOUR — sequential refund wrong — {"ledger":150,"rows":2,"paid":0,…}
✗ E: BEHAVIOUR — void did not exclude the capture — {"ledger":150,"rows":3,"paid":0,…}
check:payment-ledger-concurrency FAILED (7)      EXIT=1
```

A *coverage* overstatement, not a false green — but it is the one place the
document tells the reader "this is still open" when it is not. (Compounded by
S5: that guard has no `package.json` entry.)

### M6 — `PR_TRIAGE.md` is written against a base that no longer exists

Header: `# PR TRIAGE — 12 open PRs against main @ 5b171bd`. Its first row is
`**#112** … **READY TO MERGE** — merge first`. #112, #113 and #114 are all
merged. `gh pr list` now returns 11 open PRs (#103–#111, #23, #60).

The substantive verdicts I could re-derive all hold — the #104 credit-swallow
defect (§2.1), the #105→#104 ordering dependency, the #110 compile break, and
the #106↔#104 `worker.ts` conflict, which I reproduced directly: merging
`stab/guard-ari-readback-b2` and then `stab/guard-credit-backoff-b2` yields
`CONFLICT (content): Merge conflict in src/lib/channel/worker.ts`. Only the base
and the #112 row are stale.

### M7 — merging the whole stabilization set does not produce a green `main`

Merged set (the 15 branches that merge cleanly onto `8494385`): `pnpm typecheck`
exit 0, `pnpm lint` exit 0 (36 warnings, 0 errors), `pnpm build` exit 0. Good.

Remaining red on the merged tree:

```
check:cards                   exit=3    (registered PCI deviation — by design)
check:channels-badge          exit=1    (M4 — nobody owns it)
check:design                  exit=1    (6 violations, frozen MyTasksScreen.tsx)
check:supply-chain            exit=1    (5 high advisories)
check:no-secrets              exit=1    (6 OBSERVED failures — see below)
check:guest-communications-db exit=1    (diagnosed, not fixed)
```

`check:no-secrets` stays red because the exposure is on the host, not in the
tree: four world-readable (`0664`) tarballs in `/home/ubuntu`, each carrying four
credential members. `stab/env-and-backup` correctly ships
`scripts/ops/repack-backup-without-env.sh` in prepare-and-verify mode and
correctly deletes nothing — but no branch owns *running* it, and nothing in the
set says who does. The run should state plainly that main is expected to stay
red on six guards, and name an owner for each.

### M8 — the D98 evidence table claims staging `:5434`; the shipped guard uses testdb `:5433`

`DECISIONS.md` (credit branches):

> **הראיה (staging :5434, דרך מודולי ה-dist האמיתיים, טווח מלוכלך אחד, `max_attempts=5`)**

`scripts/check-beds24-credit-backoff.mjs:52-54`:

```js
const TEST_URL =
  process.env.TEST_DATABASE_URL ||
  "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
```

The guard's production-marker refusal list contains `":5432/"` but nothing that
would steer it to `:5434`. I could not reproduce any `:5434` run from the
shipped artefact. The *behaviour* is verified (§6) — the *provenance line* is
wrong, and a provenance line is exactly what a reviewer trusts when they cannot
re-run the measurement.

---

## MINOR

### m1 — `check:calendar-ui` weakened the `.cb-msep` width assertion to accept any number

```diff
-assert.ok(/position: absolute/.test(sepRule) && /width: 3px/.test(sepRule),
-  ".cb-msep is ONE positioned line, not a border");
+assert.ok(/position: absolute/.test(sepRule) && /\bwidth: [\d.]+px/.test(sepRule) && !/\bborder/.test(sepRule),
+  ".cb-msep is ONE positioned line of a fixed width, not a border");
```

Justified (D107.1 `1268d29` thinned it to a `0.5px` hairline, and the added
`!/\bborder/` is genuinely stronger). But `width: 40px` now passes too. If the
number matters, pin a range; if it does not, say so in the message.

### m2 — the new backup excludes are narrower than the detector that found the exposure

`scripts/ops/guesthub-tree-snapshot.sh` and
`scripts/ops/repack-backup-without-env.sh` filter on `--exclude='.env*'`.
`check:no-secrets` finds credential stores by **shape**, not by name — a stray
`config.secrets` / `credentials.json` still rides into a snapshot. `.env*` also
excludes the tracked `.env.example`, so the snapshot is not a byte-complete
rollback target of the tree it claims to snapshot.

### m3 — `check:no-secrets` reports on the host, not on the branch (deliberate, worth stating)

`scripts/check-no-secrets.mjs:79-80` hardcodes `/var/www/guesthub` and
`/home/ubuntu`; retargeting is gated behind `NO_SECRETS_SANDBOX=1` and the
script explains why. Correct design — but it means the guard's verdict is
**identical on every branch**, so it can never be used as a merge gate, and its
red will follow main until an operator acts on the host. Nothing in
`docs/guards/CHECK_NO_SECRETS.md` says that out loud.

### m4 — `GUARD_INTEGRITY.md`'s `check:inventory` row is right but easy to misread

"that branch also proves the guard never calls `checkRoomAvailability`" is true
for **execution**: `scripts/check-inventory.mjs` imports only `postgres`,
`node:assert/strict` and `./lib/check-db-target.mjs`. But
`scripts/check-maintenance-closures.mjs:23` **does** mention the name — as a
source-text grep (`/if \(isOoo\)[\s\S]{0,200}checkRoomAvailability/`), never as a
call. A reader grepping to confirm the row will hit it and doubt the document.
One clause ("no guard *executes* it; one greps for it") fixes this.

### m5 — the two credit branches are near-duplicates; only one should become a PR

`git diff origin/fix/beds24-credit-gate-swallows-failures origin/stab/guard-credit-backoff-b2`
touches exactly one file: `scripts/check-beds24-credit-backoff.mjs` (+180). The
`src/`, `DECISIONS.md` and `package.json` trees are **byte-identical**.
`stab/guard-credit-backoff-b2` is a strict superset (20 assertions vs 15) and
should be the only one that gets a PR.

### m6 — a **tenth** production-wired guard landed in #113 while targets 2.3/2.6 were detaching the first nine

`"check:beds24-credit-headers": "node --env-file=.env.local scripts/check-beds24-credit-headers.mjs"`
— reads `process.env.DATABASE_URL` and (leg 5) makes a **live Beds24 call**
unless `SKIP_LIVE=1`. `stab/guard-beds24-four-b2` detached four of the nine;
this new one restores the count. Fold it into the same `package.json` hunk as S2.

---

## 6. What I verified as REAL (experiment A and B2, run by me)

These survived adversarial probing. Recorded because a review that only lists
defects is not a review.

| guard | experiment | result |
|---|---|---|
| `check:calendar` (`stab/guard-calendar-scope`) | **A** — `git checkout origin/main -- src/`; `git rev-parse origin/main` = `8494385`; `git diff --stat origin/main -- src/` **empty** | **GREEN** — correct; the old `HTTP_MODULES` regex assertion was stale (D93 put a permission-gated, audited, enqueue-only escape hatch in `actions.ts`) |
| `check:calendar` | **defect injection A** — new `src/lib/channel/audit-helper.ts` re-exporting `beds24Request`, imported and used in `outbox.ts`. The old regex matches **0** times. | **RED** — `CONTRACT BREACH (§M/§W): a canonical save reaches the network — …/outbox.ts → …/audit-helper.ts → …/beds24-http.ts (uses the global fetch at line 107)`. The rescoped guard is **stronger** than the one it replaced, not narrower. |
| `check:calendar` | **defect injection B** — `__leakProbe()` added to `reservations/actions.ts` calling `beds24Request` **outside** the allow-listed hatch | **RED** — `a canonical save reaches the network — …/actions.ts → …/beds24-http.ts`. `ESCAPE_HATCHES` does not blanket the file. |
| `check:calendar-ui` | **A** (same clean-main src) | **GREEN** — stale assertion confirmed, product correct |
| `check:calendar-ui` | **B2** — `resolveChannelBadge` returns `normalizeVisibleChannel(...) as BadgeChannel` (name, export, signature, call site intact) | **RED** — `resolveChannelBadge(null) must land on a CHANNEL_CONFIG key — got null` |
| `check:beds24-connection` | **B2** — `circuitAllowsRequest` → `void circuitPhase(state, now); return true;` | **RED** — `CONTRACT BREACH … C5-src: the shipped circuitAllowsRequest()/circuitPhase() BLOCK the tripped fixture` |
| `check:beds24-credit-backoff` (**the #104 replacement**) | **B2** — `creditIsTheWholeStory` → `failure === null \|\| (creditPause?.reason !== undefined && failure.code !== undefined)`; tsc-clean, every identifier preserved | **RED** at assertion 14 — `a 500 must charge an attempt even when the credit meter is low (got attempts=0 — the credit pause swallowed a real provider failure, D98)` |
| `check:beds24-credit-backoff` | baseline, seeded testdb | 20/20 — including **#14** (500 + `remaining=8.4` → `attempts=1`, `last_error_code='server_error'`, `connection.last_error` set, ledger `failed/server_error`, breaker held 137 s) and **#15** (`max_attempts=5` dead-letter: `status='failed'`, `attempts=5`, ≤5 provider calls over 8 scheduler passes). **The specific behaviour I was told to verify is real.** Caveat M8: on testdb `:5433`, not staging `:5434`. |
| `check:beds24-ari-readback` | **B2** — `oversell: … && false` | **RED** (`actual: 0, expected: 1`) |
| `check:channel-mapping-alert` | **B2** — `if (room.mapping_status === null && false)` | **RED** — `an active room with no Beds24 mapping must raise exactly one room_mapping_missing alert; found 0` |
| `check:manual-decision-surface` | **B2** — `isCancellationBlocked` → `… && false` | **RED** — `BEHAVIOUR: a reservation the channel cancelled while the guest is checked in produced NO manual-decision view` |
| `check:payment-ledger-concurrency` | **B2** — the §4.1 money neutering | **RED (7)** — the only guard in the repo that catches it |
| `check:no-secrets` | **A** (real host state) | **RED (6)** — 2 stray credential stores, 4 tarballs × 4 credential members, 4 world-readable |
| `check:no-secrets` | **B2** — planted `service_role`-shaped JWT appended to the **tracked** `src/lib/colors.ts` | **RED (7)** — `H. src/lib/colors.ts: possible JWT/service_role token`. (An **untracked** file is not scanned — correct, but worth knowing.) |
| `stab/guard-integrity-sweep` | 6 guards, standalone, `DROP SCHEMA guesthub CASCADE` before each | all exit 0 (were 1/1/1/2/2/2) |
| `stab/channex-zero-trace` §0.1 | code re-read | **confirmed** — `src/lib/rates/grid-state.ts:177-201` is tenant-scoped and reads `channel_room_mappings` (the dead Channex table), never `channel_beds24_room_mappings`. Real, user-visible, correctly flagged as outside a rename-only mandate. `git grep -niE 'channex\|hospitable\|stripe' -- src/` → 0. |
| merged clean set (15 branches) | `typecheck` / `lint` / `build` | 0 / 0 (36 warnings) / 0 |

---

## 7. Claims made by this run that I could NOT reproduce

1. **`DECISIONS.md` D98: "הראיה (staging :5434 …)"** — the shipped guard targets
   `:5433`. No `:5434` path exists in it. (M8)
2. **`GUARD_INTEGRITY.md` §4.1: "No guard in this repo executes
   `recomputePaymentAggregates` and reads the result back … Open work."** —
   `check:payment-ledger-concurrency`, from a sibling branch in this run, does
   exactly that and fails 7 assertions under the neutering. (M5)
3. **`PR_TRIAGE.md`: "#112 … READY TO MERGE — merge first"** and the whole
   `main @ 5b171bd` framing — #112/#113/#114 are merged; the base is `8494385`. (M6)
4. **Iron rule 6's own premise** — "branch `fix/beds24-checkin-cancellation-guard`
   (PR #112), which is awaiting merge". It is merged (`c93b401`). Every
   `package.json` blocker attributed to it (S2, S5) is therefore already gone.
5. **The 63-script / `5b171bd` baseline** in the brief — 66 scripts on `8494385`.
6. **`fix/room-1318-beds24-mapping` (`docs/MAPPING_1318.md`, `docs/CLOSE_1318.md`,
   `docs/DIAG_MOTI_CANCELLATION_CLOSURE.md`, `docs/GUARD_GAPS_1318.md`)** and the
   production measurements quoted in `db/migrations/057_channel_mapping_audit.sql`
   ("14 of 16 rooms carry a live mapping … Room 1318 has none") — **not
   verifiable by me.** They are assertions about production data; iron rule 11
   forbids pointing anything at it. The *code-level* consequence is
   independently confirmed (an unmapped room is invisible to
   `loadBeds24InboundConnections`), and `check:channel-mapping-alert` proves the
   new alert path behaviourally on a disposable DB — but the row counts stand
   unverified.
7. **`docs/STAGING_UI_VERIFICATION.md` and its five screenshots** — not
   re-derivable without running the staging app under the auth proxy. The proxy
   itself is safe (`scripts/staging-auth-proxy.mjs:23-27` aborts on any
   non-loopback upstream). The screenshots are evidence I can neither confirm
   nor impeach.
8. **`GUARD_INTEGRITY.md` rows marked `—` in the A/B2 columns** — the document
   states plainly that `—` "means **not tested by me**. It is not a pass." I
   spot-checked every row that carries a verdict in the priority band plus the
   arithmetic (66 scripts; the four money guards green under neutering; the six
   §3.1/§3.3 guards now standalone-green; `check:beds24-checkin-cancellation-guard`
   still crashing on `guesthub.tenants`; `check:guest-communications-db` red).
   **Every one reproduced.** I did **not** spot-check `check:reservation-snapshot`
   or `check:commercial` from the §4.1 table of seven.

---

## 8. Ranked merge order (my recommendation, not an instruction)

1. `stab/pr-triage`, `stab/staging-ui-verification`, `stab/env-and-backup`,
   `stab/channex-zero-trace`, `fix/room-1318-beds24-mapping` — docs/ops only,
   merge clean.
2. `stab/guard-integrity-sweep` — it is the measuring instrument for everything
   else; land it first among the guards.
3. `stab/guard-calendar-scope`, `stab/guard-cards-pci` (**with the S1 exit-code
   fix**), `stab/guard-no-secrets-filesystem`.
4. `stab/guard-inventory-staging` + `stab/guard-beds24-four-b2` — **only
   together with the `package.json` hunk from S2**; without it they change
   nothing.
5. `fix/payment-ledger-concurrent-refunds`, `feat/channel-mapping-missing-alert`,
   `feat/needs-manual-decision-surface`, `stab/guard-ari-readback-b2` — **with
   the four `package.json` entries from S5**.
6. `stab/guard-credit-backoff-b2` — **rebased onto `8494385`**, reconciled with
   PR #113 (S4). Close `fix/beds24-credit-gate-swallows-failures` as a duplicate.
7. `fix/ari-drain-guard-measured-credit-headers` — after 6; green only on top of
   main (verified 10/10 + 5/5), red standalone.
8. `fix/booking-com-reports-credit-meter` — **last**, and only after 6, or it
   breaks the build (S3).

Steps 4, 5 and 6 all edit the same `package.json` region; do them in one hunk.
