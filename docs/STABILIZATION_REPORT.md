# STABILIZATION REPORT — INTERIM (run paused at its designed gate)

**Moti ✅ (diagnosed, correctly NOT repaired) | שומרים 0/8 ⏸️ (פאזה 2 מוקפאת) | טריאז' ✅ | UI-verify ✅ | env ✅ | גיבוי ✅ | Channex-sweep ✅ | ledger ⏸️ | mapping ⏸️ | manual-decision ⏸️ | אדוורסרי ⏸️**

Run date 2026-07-25. Production `/var/www/guesthub` = `5b171bd` throughout, working tree clean,
pm2 restart counts unchanged (guesthub 41 / channel-worker 13 — nothing restarted).
`origin/main` never moved. Nothing merged, nothing deployed.

## Why the run is paused
Phase 1's stop condition fired: **rooms with no live Beds24 mapping = 2** (not zero).
Per the run rules, Phase 2 waits for Ronen. Phases 5 and 6 depend on Phase 2 and on that
same decision, so they have not started. Everything that was runnable in parallel was run.

---

## 1. Moti Grosman — DIAGNOSED, deliberately NOT repaired ✅
`docs/DIAG_MOTI_CANCELLATION.md` (in this worktree, uncommitted).

**Neither STATE A nor STATE B.** The cancellation never reached Beds24; GuestHub is faithfully
mirroring a source that still says the booking is live.

| | |
|---|---|
| local | reservation 1026 · Moti Grosman · `confirmed` · 28–29/07 · room `Studio Delux with Sea View - 1130` · `is_blocking=t` |
| stored revision | `90359426:2026-07-24T08:50:35Z` |
| live Beds24 GET | `status:"new"` · `cancelTime:null` · `modifiedTime:2026-07-24T08:50:35Z` · `roomId:707495` · `referer:"Booking.com"` |

`modifiedTime` is **identical** to the stored revision — zero divergence. Independently
re-verified by the orchestrator with its own GET and its own SQL.
A targeted pull would have been a provable no-op (the revision is already `imported`).
Releasing would have put a still-sold room back on sale.

**Scope 4.1 = 0** · **Scope 4.2 = 2** (rooms `1318` and `חניה זמנית`).

The root cause is covered by **no open branch**: #112 needs an ingested cancellation plus a
checked-in guest; #106/P0-3 compares us to Beds24, and that is exactly where no gap exists.
The divergence is Booking.com→Beds24, one hop further upstream, invisible to every guard we own.

## 2. Guard layer — NOT STARTED ⏸️
Phase 2 is the gated phase. What exists is a **measured baseline of all 63 `check:*` guards on
clean main** (`GUARD_BASELINE.md`), which materially enlarges the brief's picture:

- **9 guards can only run against production** (`--env-file=.env.local`) — not just `check:inventory`:
  `beds24-ari`, `beds24-connection`, `beds24-jobs`, `beds24-revisions`, `effective-state`,
  `hydration-browser`, `inventory`, `rate-grid`, `sellability`.
- **7 are RED on clean main**: `calendar`, `calendar-ui`, `cards`, `channels-badge`, `design` (6
  violations, all in the frozen `MyTasksScreen.tsx`), `supply-chain` (5 high advisories),
  `guest-communications-db` (migration 036 fails on a virgin schema).
- **3 never run at all** — need `CHECK_CONCURRENCY_DB_URL`.
- **41 green standalone.**

### ⚠️ CORRECTION — the test-DB reset used all run was a NO-OP; DB-backed rows are unverified
Raised by another session, reproduced here. `DROP SCHEMA IF EXISTS guesthub CASCADE` run as
user `postgres` answers `ERROR: must be owner of schema guesthub` and exits 1 — and both the
baseline sweep and `b2harness.sh` discarded stderr *and* the exit code. Measured: 63 tables
before, 63 after. The schema is owned by `supabase_admin`.
Worse, on a genuinely empty schema the guards' own replay is broken: `000_init` as
`supabase_admin` → exit 0, but `005` as `postgres` → `permission denied for schema guesthub`,
exit 3. It only ever looked fine because the schema was already built and every
`CREATE ... IF NOT EXISTS` was a no-op. Over the owner connection the chain replays 56/56 clean.

What this invalidates:
- `check:guest-communications-db` was listed above as "migration 036 fails on a virgin schema".
  **Wrong.** Re-measured: `ERROR: must be owner of table reservations` as `postgres`; applies
  cleanly over the owner connection. It is a permissions defect in the guard, not a bad migration.
- The "3 pass only if another guard seeded the test DB first" row is **withdrawn** — the crashes
  and passes were real, but they happened against a shared schema that concurrent agents were
  rebuilding, so the stated mechanism was never demonstrated.
- `--env-file`-gated, structural and UI rows never touch the test DB and stand unchanged.
- **New finding this exposes:** `guesthub-testdb` is shared, so concurrent DB-backed guard runs
  corrupt each other. Any parallel CI execution of these guards is unreliable by construction.

`b2harness.sh` is fixed: reset runs over the owner connection, keeps stderr, checks the exit
code, re-counts tables, and `run_guard()` now returns 90 with "NOT RUN … any verdict here would
be meaningless" instead of emitting a verdict. A `replay_chain()` helper was added.

Two brief corrections, evidence-backed:
1. `check:calendar` and `check:calendar-ui` are **two different red guards**.
   `docs/CALENDAR_UI_GUARD_DIAGNOSIS.md` is on **#107** (not #111) and diagnoses only the latter.
2. `check:calendar`'s breaking commit is **`3e9a451` — the D93 fix that is production right now**.
   It put a live Beds24 GET in `src/app/(dashboard)/reservations/actions.ts:814-824`. In context
   that is the *supervised release escape hatch*, not the save path: an operator-triggered action
   that refuses to release unless Beds24 says "cancelled" live. The guard's assertion is
   FILE-scoped where the rule is PATH-scoped. `actions.ts` is also in #112's diff → iron rule 6.

`b2harness.sh` (scratchpad) is ready so the eight Phase 2 agents share one valid A/B2 method.

## 3. PR triage ✅ — `stab/pr-triage`, `docs/PR_TRIAGE.md`
12 open PRs (not 9). All ten of #103–#112 typecheck green **individually**.

| PR | verdict |
|---|---|
| #112 | READY — merge first |
| #103, #107, #109, #111 | READY |
| #106 | READY with a manual `worker.ts` resolution |
| #104 | **NEEDS FIX** — merge `fix/beds24-credit-gate-swallows-failures` instead |
| #105, #110 | NEEDS FIX (+ fix branches) |
| #108 | NEEDS FIX — ships behaviour with **zero** guard |
| #23, #60 | CLOSE (275 / 196 behind; #60 is Channex-era) |

**#104 defect (a)** — swallows a real provider failure. On staging with real worker modules,
one drain at HTTP 500 + `remaining=8.4`: clean main → `attempts:1, last_error_code:server_error`;
with #104 → `attempts:0, last_error_code:null`. Over 8 scheduler passes on a permanently-400ing
range with `max_attempts=5`: main → `failed, attempts=5` (dead letter); #104 → `pending,
attempts=0` (retries forever). A regression against main. Cause: `gate.observe()` runs on failing
responses too, so `if (creditPause && warnings.length === 0)` never consults `failure`.

**#104 defect (b)** — deleting the entire outbound credit gate (52 lines, tree still compiles)
left the shipped guard **11/11 GREEN**. Rebuilt with DB-backed outbound assertions: 15/15
baseline, A RED, B2-a RED@4, B2-b RED@13, B2-c RED@14.

**#104+#110 — the brief reproduces, and the orchestrator reproduced it independently:**
`beds24-booking-reports.ts(152,30): TS2339: Property 'creditsRemaining' does not exist on type
'Beds24Response'` — one error, only in combination. #110 alone is green, so the brief's
"#110 breaks typecheck" is true only of the pair. The fix stack
(`fix/beds24-credit-gate-swallows-failures` + #110 + `fix/booking-com-reports-credit-meter`)
was independently merged and typechecked by the orchestrator: **GREEN**.

## 4.1 Staging UI verification ✅ — `stab/staging-ui-verification`
All three screenshots exist and were visually confirmed by the orchestrator: real authenticated
RTL Hebrew screens. RTL is *enforced* — the driver asserts `documentElement.dir === "rtl"` plus
Hebrew codepoints before capturing.

Two walls, not one: (1) no staging auth existed at all; (2) supabase-js calls
`${SUPABASE_URL}/auth/v1/…` which Kong strips but bare GoTrue does not serve — every staging auth
attempt 404s, very likely why the previous attempt fell back to production auth.
Zero writes to `guesthub.users`; staging `auth.users` holds exactly 1 row.
`HYDRATION_BASE_URL` / `HYDRATION_EMAIL` / `HYDRATION_PASSWORD` — all three test-harness only.

**Orchestrator finding, not the agent's:** in `BookingComReports.tsx:166-167` the disabled
destructive action is styled `btn-danger` while the only *enabled* action is `btn-secondary`, and
`design-system.css:326` de-emphasises disabled state with `opacity: 0.6` only. Result: the
loudest element in the panel is the disabled one, the quietest is the only usable one. Inverted
affordance hierarchy — a finding against #110.

## 4.2 + 4.3 env & backups ✅ — `stab/env-and-backup`
**The four `/home/ubuntu` tarballs have no producing script** — they were hand-made with
`tar czf`. The exposure came from the *absence* of a script, not a faulty one. All four contain
all four `.env*` files (names only; never extracted), independently confirmed.
`check:no-secrets` is green because it scans `git ls-files` while `.gitignore:37` is `.env*`.

systemd is the honest end state (`EnvironmentFile` injects into a process that cannot read the
0600 root file — measured); pm2 cannot (no `env_file`, `--env-file` banned in `NODE_OPTIONS`).
Recommendation: pm2 wrapper first, systemd second. Neither cutover performed.

**Cutover trap:** the four `NEXT_PUBLIC_*` are inlined at BUILD time. Confirmed from both sides —
the live build has 0 name references in `.next/static` (value substituted); a build made without
`.env.local` keeps `f.default.env.NEXT_PUBLIC_SUPABASE_URL` as a runtime lookup that resolves to
`undefined`. Delete `.env.local` and rebuild unwrapped → green build, broken browser.

## 4.4 Channex zero-trace ✅ — `stab/channex-zero-trace`
`src/` and `package.json` are already zero-trace. 3 documentation lines renamed; **no `src/`, no
`db/`, no `DECISIONS.md`** touched. Catalog residue: 4 `uq_*_channex_*` index names (Postgres
keeps index names across `RENAME COLUMN`), 10 `channex_verified` rows, 2 suspended connections,
66 permanently-`pending` dirty ranges, 1 dead table.

**New defect (P-5), independently verified on production:** `src/lib/rates/grid-state.ts:193`
reads `channel_room_mappings` filtered by tenant only, no connection filter. That table holds
**13 rows, all belonging to the paused Channex connection**; Beds24's real mappings live in
`channel_beds24_room_mappings` (14 rows) and are never read there.
Measured: `ui_says_mapped=13, truly_mapped=14, ui_says_pending=66`.
**Honest bound on the damage: exactly one room (1042) is currently mis-displayed**, plus the 66
orphaned ranges rendering as "pending sync" forever. The defect is that the source is wrong, not
that today's numbers are far apart — they will drift arbitrarily as rooms change.

## 5. Proven bugs — NOT STARTED ⏸️ (gated behind Phase 2)
5.3 is **no longer blocked** by 4.1 — the staging auth stack is up and left running.

## 6. Adversarial — NOT STARTED ⏸️ (depends on Phase 2)

---

## A recurring structural conflict — needs Ronen's ruling
The run rule "record blockers in `DECISIONS.md`" collides with iron rule 6, because **PR #112 owns
both `DECISIONS.md` and `package.json`**. Three separate agents hit this and all three obeyed rule
6, writing into their own runbooks instead. Consequence: **no new `check:*` script was registered
in `package.json` by any phase**, so the new scripts have no CI guard yet. Also pending:
a `D97` entry, and #104's `## D94` heading collides with #112's (the fix branch renumbers to D97/D98).

## Branches pushed (none merged, no PRs opened)
`stab/pr-triage` · `stab/staging-ui-verification` · `stab/env-and-backup` · `stab/channex-zero-trace` ·
`fix/beds24-credit-gate-swallows-failures` · `fix/ari-drain-guard-measured-credit-headers` ·
`fix/booking-com-reports-credit-meter`

## Merge-and-deploy sequence (Phase 3's, verified: tsc 0, eslint 0 errors, build 0, migrations 58/58)
`#112 → #103 → fix/beds24-credit-gate-swallows-failures (instead of #104) →
#105 + fix/ari-drain-guard-measured-credit-headers → #106 (manual worker.ts fix) →
#110 + fix/booking-com-reports-credit-meter → #109 → #108 (only if you accept no guard) →
#107 → #111` → then deploy **once** with `PROD_DEPLOY_OK=1 npm run deploy:prod`. Close #23, #60.

Migration **055 collides** between #110 and the out-of-scope `fix/quote-window-long-stay`; whichever
lands second renumbers to **057**.

**Verify after deploy:** pm2 ↺ increments by exactly 1 each and both stay `online`; the Moti
reservation 1026 remains `confirmed` and still holds its room (it is still sold);
`check:beds24-connection` green. **Rollback sign:** either process restart-looping, or any
external reservation changing status without a matching Beds24 `modifiedTime` change.
