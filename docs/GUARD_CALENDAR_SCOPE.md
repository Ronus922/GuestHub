# Guard scope record — `check:calendar` and `check:calendar-ui`

Stabilization phase 2, target 2.4. Branch `stab/guard-calendar-scope`, base
`origin/main` = `5b171bd`. Both guards were **RED on clean `main`**; both are
green here. This file is the decision record, because `DECISIONS.md` is reserved
by PR #112 (§5 below).

---

## 1. `check:calendar` — the assertion was FILE-scoped, the rule is PATH-scoped

**Failure on main:** `scripts/check-calendar.mjs:148` —
`src/app/(dashboard)/reservations/actions.ts must not import the channel HTTP
layer (@/lib/channel/beds24-http)`.

**Breaking commit:** `3e9a451` (D93, merged as PR #102 = `5b171bd`) — the fix
that is in production. It added `getBeds24AccessToken` + `beds24Request` at
`actions.ts:36-37,814-824`.

**Verdict: STALE ASSERTION, not a regression.** The code at those lines is
`releaseChannelReservationAction` — the supervised release escape hatch. It is
an operator-triggered admin action that
`requirePermission(actor, "reservations.cancel")`, asks Beds24 live whether the
booking is cancelled, refuses if it is not, writes an audit row naming the actor
and the source status, and then **enqueues** `pull_booking_revisions` for the PM2
worker. It persists no stay, no inventory and no price. It is not a save path.

The rule §M/§W is *"outbound ARI cannot originate from a save path"*. Its
implementation matched import-specifier **text anywhere in the file**, which is
strictly wider than the rule and produced this false RED. The same file-scoping
was also strictly *narrower* than the rule in the other direction: re-exporting
`beds24Request` from an innocently named module defeated the specifier regex
while the save still reached the socket (proved in §4, injection 2).

**Fix — narrow the guard, do not move the code.** `actions.ts` is inside PR
#112's diff and may not be touched. `scripts/check-calendar.mjs:125+` now:

1. resolves the **module graph** from each save path (`@/…`, relative,
   re-exports and dynamic `import()`), and flags the **real network primitives**
   at the leaves (`fetch` / `XMLHttpRequest` / `axios` / `node:http` in *value*
   position — not module names). This is what catches an alias chain, and it is
   what catches `channel-http.ts` / `beds24-http.ts`, whose only network token is
   `opts.fetchImpl ?? fetch` — a bare identifier the old `\bfetch\(` regex never
   saw;
2. splits each save-path file into top-level **regions** and attributes every
   value import to the function that uses it, so only the *save* side of the
   graph is walked;
3. allow-lists escape hatches by `file → function`, and makes each one **pay for
   its exemption**: it must be permission-gated, audited, must delegate through
   `enqueueChannelJob`, must not `UPDATE/INSERT/DELETE guesthub.reservations`,
   must not call `markAriDirty` / `applyCancellation` /
   `recomputePaymentAggregates`, must not be called from a save region, and must
   still actually touch the channel (a stale entry is a failure, so the
   allow-list cannot quietly widen);
4. keeps the "no network code of its own" ban **file-wide** on every save path —
   unchanged strength, now AST-based instead of regex.

Net: the guard is stronger than it was. Every assertion in the block is labelled
`CONTRACT BREACH (§M/§W)` — it is an architectural contract, not a behaviour
assertion.

---

## 2. `check:calendar-ui` — two stale design assertions behind one another

### 2a. the channel row (`check-calendar-ui.mjs:372`)

`docs/CALENDAR_UI_GUARD_DIAGNOSIS.md` (branch
`origin/night/calendar-ui-guard-diagnosis`, PR #107) diagnosed this one and
concluded STALE GUARD. **Independently verified and agreed:**

- `resolveChannelBadge()` is `normalizeVisibleChannel(k) ?? "manual"`
  (`src/lib/colors.ts:126-130`) — it cannot return `null`, so `{channel && (` is
  dead code, not a missing guard clause.
- the model is applied on all five surfaces (`CalendarGrid` pill + drag ghost,
  `MobileCalendar`, `MobileDetailSheet`, `ReservationTooltip`) — not a local slip.
- `ref/screens/GuesthubCalandrFix.png` (the owner reference D107 was built to;
  `/ref/` is gitignored, the file is on the box) shows internal reservations
  (שרה גולן / 103, תום שגב / 202) wearing the grey **pencil** badge, with the
  legend still carrying exactly four channels.

**Applied fix differs from the diagnosis's proposal.** The proposal was three
regex assertions. The invariant that actually makes an unconditional row safe is
that **`resolveChannelBadge` is total**, and that is behaviour, so it is asserted
as behaviour: `src/lib/colors.ts` is now compiled with the other pure modules and
`resolveChannelBadge` is exercised over the whole source-key domain
(`null`/`undefined`/`""`/OTA keys/internal keys/unknown/odd casing), asserting the
result is always a `CHANNEL_CONFIG` key with a non-empty name. The separation the
`EditReservationPanel` OTA check depends on is locked too
(`normalizeVisibleChannel` must stay nullable), as is the four-entry legend.
Two `CONTRACT:` assertions keep the card wired to the total resolver.

### 2b. the month separator (`check-calendar-ui.mjs:452`)

Only visible once 2a was fixed — the run aborts at the first failure, so the
existing diagnosis could not see it.

Assertion: `.cb-msep is ONE positioned line, not a border`, implemented as
`position: absolute` **and `width: 3px`**. `1268d29` (D107.1) thinned the
separator to a `0.5px` hairline: *"Month separator .cb-msep → 0.5px #8E9AB8
hairline (was a 3px washed line)"*, owner-reference-driven.

**Verdict: STALE ASSERTION.** The rule is the *mechanism* (a positioned line, not
a border); the thickness is a design value the owner reference owns. Rescoped to
`position: absolute` + a fixed `px` width + **no `border` declaration** — the
"not a border" teeth are now asserted directly instead of implied by a magic
number.

### 2c. code change

`src/app/(dashboard)/calendar/ReservationTooltip.tsx:166-170` carried a JSX
comment still describing the pre-D107 conditional row. Comment-only correction,
no behaviour.

---

## 3. Assertion taxonomy used here

- **BEHAVIOUR** — values read back from a compiled module or the DB.
  `check:calendar-ui`'s new channel block is behaviour.
- **CONTRACT** — structural/source-shape. Every one of them says
  `CONTRACT` / `CONTRACT BREACH` in its failure message so a reader is never
  told a behaviour broke when a contract did. The whole §M/§W block in
  `check:calendar` is contract, by nature: it asserts a layering rule.

---

## 4. Experiment log (B2 standard)

Full printed output is in the branch's PR body / run report. Summary:

| experiment | guard | before the change | after the change |
|---|---|---|---|
| A — vs clean `origin/main` src | `check:calendar` | RED `…must not import the channel HTTP layer` | **GREEN** (the target: main must be green) |
| A — vs clean `origin/main` src | `check:calendar-ui` | RED `the channel row is CONDITIONAL` | **GREEN** |
| B2 — semantic neutering | `check:calendar` | RED, but at the *stale* line 148 — the run never reached the neutered predicate, so the result certifies nothing | **RED at the neutered predicate** (`100 before 926`) |
| B2 — semantic neutering | `check:calendar-ui` | RED, but at the *stale* line 372 — same, certifies nothing | **RED at the neutered predicate** (`resolveChannelBadge(null) … got undefined`) |

Neuterings used (all identifiers, imports, call sites and string literals
preserved; verified by the harness's structural-signs check):
`compareRoomNumber` → constant `0`; `resolveChannelBadge`'s `?? "manual"` →
`?? (undefined as unknown as "manual")`.

**The A-verdict label of the shared harness is inverted for this target.** For a
guard that is red on main because its assertion rotted, GREEN-on-clean-main is
the goal, not a failure. The substantive form of A here is defect injection —
the guard must go red when the defect it exists to catch is present:

| injection | result |
|---|---|
| 1. `beds24Request` imported and called inside `markAriDirty` (a canonical save) | RED — `a canonical save reaches the network — outbox.ts → beds24-http.ts (uses the global fetch at line 107)` |
| 2. **grep-defeat**: same call routed through `channel/range-notifier.ts`, which re-exports `beds24Request`. No `beds24-http` / `channel-http` / `fetch(` token anywhere in `outbox.ts` | old guard: **GREEN on `outbox.ts`** (verified by running its verbatim predicate). New guard: RED, printing the full chain `outbox.ts → range-notifier.ts → beds24-http.ts` |
| 3. allow-list a genuine save (`createReservationAction`) | RED — `escape hatch … must delegate to the canonical worker job` |
| 4. allow-list a name that no longer exists | RED — the hatch's imports fall back to the save side and the graph walk fires |
| 5. revert the card to the pre-D107 conditional row + nullable normalizer | RED — `CONTRACT: the card resolves its channel through the TOTAL resolver` |
| 6. draw the month boundary as a `border-inline-start` again | RED — `.cb-msep is ONE positioned line of a fixed width, not a border` |

---

## 5. Blockers — could not be recorded where they belong

1. **`DECISIONS.md` is owned by PR #112** (`fix/beds24-checkin-cancellation-guard`,
   awaiting merge). This record therefore lives here instead of as a D-entry.
   After #112 merges, a D-entry should be opened for: *"the §M/§W save-path rule
   is PATH-scoped; `releaseChannelReservationAction` is an allow-listed operator
   escape hatch"* — and, separately, for **D107 itself, which has no
   `DECISIONS.md` entry at all** (the file ends at D93 while D107/D107.1/D108 are
   live in commit bodies). Two guards had rotted onto a decision that was never
   written down; that is the root cause of this target, and it will recur.
2. **`package.json` is owned by PR #112**, so **no new `check:*` script could be
   registered.** None was needed — both guards already have entries
   (`check:calendar`, `check:calendar-ui`) — but recording the constraint since
   it applied throughout.
3. **`src/app/(dashboard)/reservations/actions.ts` is owned by PR #112.** It was
   not touched. Had the verdict been "regressive code", the escape hatch would
   have had to move to its own module; the guard was narrowed instead, which is
   the correct fix on the merits and also the only one available.
4. **`check:channels-badge` is still RED on `main` and is NOT fixed here.** It
   fails on `exactly four visible channel definitions — no manual entry`
   (`scripts/check-channels-badge.mjs:22`) — the same D107 rot, in a guard
   outside this target. At least three further assertions there are known stale
   behind the first (`CHANNEL_CONFIG.site` glyph vs icon, `ChannelBadge`'s
   `VisibleChannel` vs `BadgeChannel` prop, and a `doesNotMatch(/Icon/)` that
   D107 broke). Whoever takes it must preserve the split: `normalizeVisibleChannel`
   = "is this an OTA booking?" (nullable, `EditReservationPanel` depends on it);
   `resolveChannelBadge` = "which badge?" (total). `CHANNEL_ORDER` genuinely
   stays four entries.
5. **`check:calendar` now requires the `typescript` compiler API at runtime.** It
   is already a devDependency and already invoked as `pnpm exec tsc` by the same
   script, so no dependency change was needed — noted because the guard now fails
   closed if `node_modules` is pruned to production.
