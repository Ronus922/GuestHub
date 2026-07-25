# `check:no-secrets` — credential exposure guard (rebuilt, phase 2 target 2.2)

Branch: `stab/guard-no-secrets-filesystem`. Script: `scripts/check-no-secrets.mjs`.
**No value of any secret appears in this document, in the guard's code, or in the
guard's output. Names only.**

---

## 1. Why it was rebuilt

The previous guard scanned `git ls-files` and nothing else.

`.gitignore` line 37 is `.env*`. Every real credential file in the deploy tree is
therefore **untracked**, and every untracked file was **invisible** to the guard.
The four hand-made rollback tarballs in `/home/ubuntu` were outside its world
entirely — it had no filesystem input of any kind.

It reported `PASS` over a live exposure:

| exposure | old guard |
|---|---|
| 4 dotenv files in `/var/www/guesthub` (2 of them stray `.bak` duplicates) | invisible |
| the same 4 dotenv files inside each of 4 rollback tarballs | invisible |
| those 4 tarballs being mode `0664` (world-readable) | invisible |

That is not a guard that missed an edge case. That is a guard whose scan surface
never intersected the thing it was named after.

---

## 2. What it asserts now

This guard has no DB behaviour to assert, so the strongest class available to it
is **OBSERVED**: state read back from the real filesystem, the real tarball
indexes and the real git object store. Assertions that merely match a text
pattern over source are labelled **CONTRACT**, and their failure message says so
explicitly — a CONTRACT failure is a *contract breach, not a behaviour breach*.

| id | class | assertion |
|---|---|---|
| A | OBSERVED | credential-store inventory of the deploy tree (content-shape classified) |
| B | OBSERVED | no **stray** credential store — an unmanaged duplicate of live secrets |
| C | OBSERVED | no credential store in the deploy tree is world-readable |
| D | OBSERVED | no backup tarball carries a credential member (`tar -tzf`, list only) |
| E | OBSERVED | no credential-carrying tarball is world-readable |
| F | OBSERVED | no `.env*` — and no file of credential *shape* — is tracked by git |
| G | OBSERVED | no `.env*` was ever committed |
| H | CONTRACT | no secret material in tracked text files |
| I | CONTRACT | encryption env vars are never bound or assigned in source |

### The central predicate

`classifyDotenvShape()` decides whether a file is a credential store from its
**content**, never its name:

> ≥ 3 `KEY=VALUE` assignments **and** ≥ 60 % assignment density **and** ≥ 1 key
> whose **name** reads as a credential and whose value is not an obvious
> placeholder.

Renaming `.env.local` to `application-config.txt` changes nothing. This is what
makes the guard survive B2 (§3).

The value is inspected inside that function's loop body and reduced to a boolean
there. It is never assigned to an outer scope, never returned, never printed.
`say()` is a last-resort output filter that **throws** if a JWT, a DSN carrying a
password, a PEM header, a long hex key or a vendor-prefixed token would ever
reach stdout — proven live in test 6 below.

### Tarballs are listed, never extracted

The only tar invocation is `tar -tzf`. `TAR_LIST_ARGV` is `Object.freeze`d and
asserted at load time. No code path can pass `-x`.

---

## 3. B2 evidence

Four experiments, run against the real world and against a sandbox in which the
defect's structural sign is removed while its semantics stay byte-identical.

| experiment | guard | result |
|---|---|---|
| **A before** | origin/main `0d590acc…` vs the real, unfixed defect | **GREEN — FAILED A** |
| **B2 before** | origin/main `0d590acc…` vs semantic neutering | **GREEN — FAILED B2** |
| **A after** | rebuilt `f09e5f39…` vs the real, unfixed defect | **RED (exit 1), 6 failures** |
| **B2 after** | rebuilt `f09e5f39…` vs semantic neutering | **RED (exit 1)** |

**The neutering.** `ctrl-tree/.env.local` and `neut-tree/application-config.txt`
are byte-identical (`sha256 78b3ac12df9e4588c04cde3d68512cbcef24e72dedfeb9939f814fcea0b32c5e`,
`diff` empty). Only the name differs; no filename in the neutered tree contains
the token `.env`. The rebuilt guard still flags it as a stray credential store.

**A guard that is always red is also not a guard.** Test 1 below proves it goes
green on a clean world, so its redness today is a finding, not a constant.

### Supporting tests

| # | scenario | result |
|---|---|---|
| 1 | clean world: managed `.env.local` at `0600`, clean `0600` tarball | **PASS (exit 0)** |
| 2 | same world, `.env.local` at `0644` | C goes **RED** |
| 3 | `NO_SECRETS_TREE` set without `NO_SECRETS_SANDBOX=1` | **refused, exit 2** |
| 4 | deploy tree missing | **CANNOT ASSERT, exit 2** — never PASS |
| 5 | computed hardcode `const CARD_VAULT_KEY = ["dead","beef"].join("")` | I goes **RED**; the old rule scored **0 hits** |
| 6 | credential store whose *filename* is JWT-shaped | `say()` **throws**; nothing printed |

Test 3 exists because a retarget knob is an escape hatch. The overrides
(`NO_SECRETS_TREE`, `NO_SECRETS_BACKUP_GLOB`) only work with
`NO_SECRETS_SANDBOX=1`, which prints a banner saying the run asserts nothing
about the real deploy tree. Silently pointing this guard somewhere empty is
exactly how a real exposure gets a green tick.

Assertion I was **narrowed from an over-broad first draft**: requiring every
occurrence to be a `process.env` read produced two false positives, because the
key names legitimately appear as **JSX text** in the Hebrew UI (`… בשרת
(CHANNEL_SECRETS_KEY) אינו מוגדר`), which is neither a JS string nor a comment.
It now matches on binding / assignment / literal-property *shape*. This is still
strictly stronger than the original `KEY = "…"` rule — test 5 proves it catches a
hardcode the original was blind to — and it no longer fires on UI copy.

---

## 4. Known limitations — stated, not hidden

1. **D is name-shaped, by mandate.** Extraction of the backup tarballs is
   forbidden, so members can only be matched by name. A credential file renamed
   *before* it was tarred would evade D. **D would go green under B2.** The guard
   prints this limitation in its own output rather than letting a reader assume
   otherwise. The deploy-tree assertions (A/B/C) do not share this weakness.
   Lifting it requires permission to stream a single member (`tar -xzO`), which
   this run did not have.
2. **The guard reads the production deploy tree.** It reads *names, modes and
   dotenv shape* only — no DB, no network, no writes, no values. It is read-only.
3. **It is not wired into CI**, and if it were it would exit 2 there, because
   `/var/www/guesthub` does not exist on a CI runner. Fail-closed is deliberate:
   a guard that cannot see its subject must not report PASS. Wiring it up needs a
   decision about which host runs it.
4. **Group-readable (`0660`) is tolerated**; only world-readable fails. The four
   deploy-tree dotenvs are `ubuntu:devops-www 0660`, which is the intended devops
   arrangement. Tightening to `0600` would be a deployment change, not a guard
   change.

---

## 5. Open findings this guard now surfaces (RED on `main` today)

Six failures, all real, none fixed by this branch — this branch adds the
detection, not the remediation:

| # | finding |
|---|---|
| 1 | `.env.local.bak-roles-2026-07-19` — stray credential store in the deploy tree |
| 2 | `.env.local.pre-merge.bak` — stray credential store in the deploy tree |
| 3–6 | all four `guesthub-backup-*.tgz` carry 4 dotenv members each |
| + | **new**: all four tarballs are mode `0664` — **world-readable** |

Remediation belongs to `origin/stab/env-and-backup`
(`scripts/ops/guesthub-tree-snapshot.sh`, `scripts/ops/repack-backup-without-env.sh`,
`docs/BACKUP_HYGIENE.md`), which prepared the repack but deliberately did not
execute it. The world-readable tarball modes are **not** covered there and are a
new finding from this branch.

---

## 6. Blocker register (this branch)

Recorded here rather than in `DECISIONS.md` because branch
`fix/beds24-checkin-cancellation-guard` (PR #112) owns `DECISIONS.md` and
`package.json` and is awaiting merge. Iron rule 6 forbids touching either.

| # | blocker | status |
|---|---|---|
| B-1 | Cannot write to `DECISIONS.md` (owned by PR #112). | Recorded here. Fold into `DECISIONS.md` after #112 merges. |
| B-2 | Cannot register a new `check:*` script in `package.json` (owned by PR #112). | **Not needed.** `check:no-secrets` was already registered at `package.json:79`; the guard was rebuilt in place under its existing name, so `package.json` is untouched and no registration is pending. |
| B-3 | Tarball members cannot be content-classified (extraction forbidden). | Open — see limitation 1. Needs a decision on `tar -xzO` streaming. |
| B-4 | Guard is not wired into any CI pipeline and would exit 2 on a runner. | Open — needs a host decision. |
