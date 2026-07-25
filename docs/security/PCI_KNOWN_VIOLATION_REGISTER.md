# PCI known-violation register

Companion to the machine-readable register inside `scripts/check-cards.mjs`.
Run `pnpm check:cards` — the register prints on **every** run.

## Why this exists

`check-cards.mjs` used to contain assertions of this shape:

```js
assert.ok(/cvv_encrypted/.test(cardActions), "save/reveal touch the cvv_encrypted column");
assert.ok(/encryptCvv\(/.test(cardActions), "the CVV is encrypted before persistence");
assert.equal(typeof rules.cvvValid, "function", "cvvValid restored — the stored CVV is validated");
```

Retaining a CVV/CVC after authorization is a PCI-DSS violation (v4.0 req. 3.3.1 /
3.3.3; D87 records the same ceiling as "Req. 3.2"). Those assertions therefore
made the suite go **red when someone REMOVED the violation** — a guard that
locks a security defect in place. Verified, not asserted: with the CVV path
stripped out of `src/`, the pre-existing guard fails at line 66 with
`AssertionError: cvvValid restored — the stored CVV is validated`.

## What replaced it

The CVV-at-rest deviation is now **registered**, not enforced:

- Every run probes whether the deviation is still present, and prints an
  unmissable banner naming it, the standard it breaks, the decision that
  accepted it (D87) and its owner.
- The suite never prints an all-clear line while a registered deviation stands.
- Removing the violation makes the suite **greener**, never redder: when no CVV
  signal is found, the entry flips to `RESOLVED` and the suite exits 0.
- The deviation the owner accepted is "CVV retained, but AES-256-GCM encrypted
  at rest, validated on entry, readable only through the audited reveal".
  Anything weaker is **escalated** to CRITICAL with a named reason — that check
  is behavioural (it encrypts a sample and inspects the blob), so replacing the
  vault with base64 while keeping the `encryptCvv` name is caught.

### Exit codes

| code | meaning |
| ---- | ------- |
| 0 | no unresolved deviation; every assertion passed |
| 1 | an assertion failed — a real behaviour or contract breach |
| 3 | every assertion passed, but a registered deviation is still in the code |

Exit 3 runs **last**, after the entire suite. Nothing is skipped or silenced to
produce it. It is distinguishable from a genuine regression (exit 1) by code.

### CONTRACT vs behaviour

Assertions that read source text are now raised through `contract()`, whose
failure message says *"CONTRACT BREACH (structural/source-text assertion — the
code no longer LOOKS the way this suite requires; this is NOT a proven behaviour
failure)"*. 93 assertions carry that label. Assertions that call the code and
read values back stay `assert.*` and rank above them.

The register's own signals are mixed and labelled as such in the output:
`vault.encryptCvv` / round-trip / encrypted-at-rest are **behavioural**; the
storage-path signals (`cvv_encrypted` column, `encryptCvv(` call site, CVV
collected/forwarded in the UI) are **source-text** — they read files that are
JSX/Next server actions and cannot be executed from a node script.

## Open items — NOT implemented, awaiting owner decision

1. **Card-storage behaviour is untouched.** `cvv_encrypted`,
   `revealReservationCardAction` and the hosted payment page are exactly as they
   were on `main`. This change is guard-only.

2. **PROPOSAL — CI wiring for exit 3.** There is no `.github/` directory in this
   repo, so `check:cards` is not wired into any automated pipeline today and
   exit 3 currently blocks nothing. When CI lands, the proposal is:
   - treat exit 1 as a hard failure, always;
   - treat exit 3 as a **non-blocking annotation** on `main`, so a known,
     owner-accepted deviation does not wedge every unrelated merge;
   - treat exit 3 as a **hard failure on any branch that touches
     `src/lib/card-vault.ts`, `src/lib/card-rules.ts` or
     `src/app/(dashboard)/reservations/card-actions.ts`**, so the deviation
     cannot quietly grow;
   - never add an env var that suppresses the banner. The banner is the point.

   This is a proposal only. Do not implement without Ronen's decision.

3. **Register the exit-3 convention in `DECISIONS.md`.** Blocked: `DECISIONS.md`
   and `package.json` are owned by branch `fix/beds24-checkin-cancellation-guard`
   (PR #112), awaiting merge. No new `check:*` script was added — `check:cards`
   already exists in `package.json` — but the exit-code convention and this
   register should be folded into `DECISIONS.md` (as D-next, amending D87 §3)
   once #112 lands.

4. **Second-order finding, out of scope for this branch.** The same
   assert-the-violation-exists pattern very likely lives in
   `scripts/check-channel-card-ingest.mjs`, which D87 says was "flipped" at the
   same time. Not audited here.
