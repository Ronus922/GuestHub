# STAGE 7 — FINAL VERIFICATION, DOCUMENTATION AND DELIVERY

Read first: `00_COMMON_CHARTER.md`, `GUESTHUB_PROGRAM_V2.md`, `docs/program/STATE.md`, all previous stage reports.

## Stage mission

Prove the whole program: independent adversarial verification, complete browser verification with a certification screenshare rehearsal, the full regression and consolidated test run, documentation completion, and the final delivery — a clean branch, a finished draft PR, and the comprehensive final report.

## Entry gate

Charter entry gate (§5). Additionally: re-fetch the Channex documentation one final time and reconcile the versioned requirements document; all tags `stage-1-complete` through `stage-6-complete` exist; the State file shows no unassigned open Critical/High items.

## Binding V2 scope for this stage

* V2 Phase 15 in full: browser verification of every listed workflow, including RTL and Hebrew rendering, no console errors, no hydration errors, no overflow; and the full screenshare rehearsal — perform every certification scenario and several ad-hoc arbitrary changes through the real UI, confirm the Channex calls fire from the main code paths, and finalize `docs/channex/SCREENSHARE_DEMO_SCRIPT.md`.
* §25 in full: the complete regression list.
* §24, consolidation: run every check from every stage in one consolidated pass; add and pass `check:code-documentation`.
* §22, completion: the documentation sweep — code comments, JSDoc, database comments — and the agent-guidance updates: `CLAUDE.md`, `AGENTS.md`, `DECISIONS.md`, and `GUIDELINES.md` where relevant, describing the final canonical architecture, sources of truth, safety boundaries and decisions.
* §23, completion: every architecture, Channex, database, payments and security document current; every Mermaid diagram verified against the final code.
* V2 Phase 17 / Agent N in full: the independent final verifier re-runs tests, re-reads official requirements, attempts failures and unauthorized actions, verifies database isolation, verifies no hardcoded Staging path remains, verifies Production cannot activate accidentally, verifies critical PMS workflows, and issues the final pass/fail matrix. No implementing agent self-certifies.
* §26, verification: Agent N independently exercises the Production activation guard's refusal paths.
* §28 in full: verify every Definition of Done item, including the fresh-clone setup test actually performed.
* §29 in full: the comprehensive final report, including the Hebrew executive summary, the certification scenario matrix with UI workflows and firing locations, the declaration answers, the remaining-human-steps list, the security and performance sections, the complete test-command results, the git delivery details with the review map, the ordered user test plan, and the safety confirmation.

## Stage-specific directives

* Any failure found here is fixed in this stage if small and safe, or honestly reported as a blocker — never papered over. Every fix goes back through the relevant checks.
* The final draft PR description is completed with the full accumulated review map across all stages.
* The remaining-human-steps list must state plainly what only the user can do: review and merge the PR, submit the official Channex certification form with Task IDs and declaration answers, schedule and perform the live screenshare using the demo script, and approve the future production cutover and activation.

## Active agents

N (lead), M, L, D, A. Implementing agents respond to N's findings but do not certify their own work.

## Checks added in this stage

`check:code-documentation`, plus the consolidated all-checks run.

## Exit gate

Charter exit gate (§6), plus:

* Agent N's pass/fail matrix: all pass, or every fail converted to an explicit user-visible blocker in the final report.
* Fresh-clone setup verified by actually performing it.
* Full §25 regression green; consolidated all-checks run green.
* Final report delivered; State file marked program-complete.
* Tag `stage-7-complete`; draft PR final; not merged; not deployed.
