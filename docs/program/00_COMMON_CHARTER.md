# GUESTHUB PROGRAM — COMMON CHARTER (STAGE PROTOCOL)

This charter governs every stage of the GuestHub engineering program. It is read together with the canonical specification `GUESTHUB_PROGRAM_V2.md` (in this folder) at the start of every stage. The charter defines HOW the program executes; the V2 specification defines WHAT must be built.

## 1. Program structure

The program is executed as seven strictly sequential, cumulative stages:

1. Stage 1 — Foundation, System Audit and Target Architecture (`01_STAGE_1_AUDIT_AND_ARCHITECTURE.md`)
2. Stage 2 — Dedicated Database Infrastructure (`02_STAGE_2_DEDICATED_DATABASE.md`)
3. Stage 3 — Core Domain Integrity (`03_STAGE_3_CORE_DOMAIN_INTEGRITY.md`)
4. Stage 4 — Channex Integration and Certification Readiness (`04_STAGE_4_CHANNEX_CERTIFICATION.md`)
5. Stage 5 — PMS Capability Completion (`05_STAGE_5_PMS_COMPLETION.md`)
6. Stage 6 — Security, Performance and Observability (`06_STAGE_6_SECURITY_PERFORMANCE_OBSERVABILITY.md`)
7. Stage 7 — Final Verification, Documentation and Delivery (`07_STAGE_7_VERIFICATION_AND_DELIVERY.md`)

Rules:

* Stages run strictly in order. A stage must not begin unless the previous stage's exit gate passed.
* No stage may skip, drop or silently defer any item assigned to it by the coverage matrix below.
* Work belonging to a later stage must not be pulled forward, except when a genuine dependency demands it; every such move is recorded in the re-scoping log (see State file).
* Re-scoping between stages is allowed only by updating the coverage matrix and the State file with justification. Deleting scope is never allowed.
* Critical data-integrity or security defects are always in scope for the current stage, regardless of the matrix, and are recorded in the re-scoping log.
* One user checkpoint exists between stages: the user reads the stage report and launches the next stage. Within a stage, execute without routine questions per V2 §2.

## 2. Universal rules — binding in every stage

The following sections of `GUESTHUB_PROGRAM_V2.md` apply verbatim and continuously in every stage:

* §0 Primary mission.
* §1 Final target.
* §2 Operating authority and prioritization order.
* §3 Absolute safety boundaries, including the execution-environment safety subsection.
* §5 Multi-agent program and agent roles (each stage lists which agents are active).
* §6 Git and worktree safety.
* §8 Target architecture principles, including time and money discipline.
* §22 Code documentation standard.
* §30 Quality standard.

No stage may claim an item is done without the evidence forms required by V2 §30.

## 3. Git and delivery protocol

* One integration branch for the whole program: `feat/pms-hardening-channex-certification`, created in Stage 1 per V2 §6.
* Commits by logical milestone; build, typecheck and lint pass at every commit.
* At each stage exit, create an annotated tag: `stage-1-complete`, `stage-2-complete`, and so on.
* One draft pull request into `main`, opened in Stage 1 and updated at every stage exit with that stage's review map (changed areas, reading order, risk level).
* Never merge. Never deploy to production. Never rewrite published history.

## 4. State file — program memory

`docs/program/STATE.md` is the durable memory of the program, updated at every stage exit (and mid-stage after significant milestones). It must contain:

* Current stage and status.
* Completed stages with tags and commit SHAs.
* Verified environment facts: database endpoints per environment, certification tenant/property/connection identifiers, worker endpoints, key file paths.
* Open issues with severity and the stage that owns each.
* Deferred items with justification and target stage.
* Re-scoping log: every item moved between stages, why, and where it now lives.
* Blockers requiring the user.

Stage reports are written to `docs/program/reports/STAGE_N_REPORT.md`. Each report covers: what was done, evidence (commands, results, Task IDs, screenshots where relevant), defects found and fixed, defects deferred and to which stage, exit-gate checklist results, and a short executive summary in Hebrew for the product owner.

## 5. Entry gate — run at the start of every stage

1. Read, in full: this charter, `GUESTHUB_PROGRAM_V2.md`, the current stage document, `docs/program/STATE.md`, and the previous stage report.
2. Verify the previous stage's tag exists and its exit checklist is recorded as passed. If not, stop and report; do not improvise.
3. Re-run execution-environment safety (V2 §3): resolve and print the effective database identity for every process that will run; abort anything that resolves to production. Confirm disk, memory and CPU headroom. Confirm the shared infrastructure and production PM2 processes will not be touched.
4. Run the git worktree safety procedure (V2 §6): status, preserve uncommitted work, confirm the integration branch is current.
5. Refresh any external documentation this stage depends on (the stage document lists it); update the versioned requirements document if it changed.
6. Confirm all checks introduced by previous stages still pass (regression guard).

If any entry-gate step fails, stop, record the failure in the State file, and report to the user.

## 6. Exit gate — run at the end of every stage

1. Every item assigned to the stage by the coverage matrix is implemented with evidence, or moved via the re-scoping log with justification (never dropped).
2. All checks introduced by this stage pass; all checks from previous stages still pass.
3. Scoped regression for the areas this stage touched shows no regressions (V2 §25 list, relevant subset).
4. Documentation required by the stage exists and matches the code.
5. State file and stage report written, including the Hebrew executive summary.
6. Milestone commits pushed, stage tag created, draft PR description updated with the stage review map.
7. Safety confirmation: production not activated, live OTA untouched, no real reservations affected, shared infrastructure untouched, no secrets committed.

## 7. Coverage matrix — every V2 section mapped to a stage

| V2 section | Owning stage(s) |
|---|---|
| §0 Mission | Charter — all stages |
| §1 Final target | Charter — all stages; verified per-stage via exit gates, in full at Stage 7 |
| §2 Operating authority | Charter — all stages |
| §3 Safety boundaries + execution-environment safety | Charter — enforced always; verified at every entry gate; first full run at Stage 1 entry |
| §4 Project guidance and Channex documentation | Stage 1 (initial capture, versioned requirements doc); refreshed at Stage 4 and Stage 7 entry |
| §5 Multi-agent roles | Charter; per-stage active-agent lists |
| §6 Git and worktree safety | Charter; branch and draft PR created in Stage 1 |
| §7 Initial system-wide audit | Stage 1 |
| §8 Architecture principles | Charter — all stages; target architecture and ADRs defined in Stage 1 |
| §9 Dedicated database | Stage 2 |
| §10 PMS domain completeness | Audit and gap classification: Stage 1. Implementation — properties/business identity, rooms/inventory, reservations, guests, pricing/restrictions, payments, audit/history: Stage 3. Implementation — communications, housekeeping, maintenance, tasks, reports/exports, Israel-market readiness: Stage 5 |
| §11 Channex environment separation | Stage 4 |
| §12 Certification environment and execution model | Stage 4 |
| §13 Certification evidence ledger | Stage 4 |
| §14 Full Sync | Stage 4 |
| §15 Incremental ARI and Group Update | Canonical rate/inventory services, transactional dirty-range marking and the generic sync outbox: Stage 3. Channex wiring, Group Update expansion, single sync envelope, Min Stay semantics declaration: Stage 4 |
| §16 Rate limits and circuit breaker | Stage 4 |
| §17 Inbound bookings and booking receiving | Stage 4 (consumes Stage 3 reservation services) |
| §18 Payment and tokenization boundaries | Model, boundaries and documentation: Stage 3. Certification declarations: Stage 4 |
| §19 Security review | Critical/High fixes in touched areas: every stage, continuously. Full dedicated red-team review including supply chain: Stage 6 |
| §20 Performance and scalability | Stage 6 (with basic sanity measurements in earlier stages where changes are performance-sensitive) |
| §21 Observability and operations | Scheduled backups with retention and off-host copy: Stage 2. Background-job heartbeat and queue visibility foundations: Stage 3. Full observability, alerts and log hygiene: Stage 6 |
| §22 Code documentation standard | Charter — continuous; completion sweep and agent-guidance-file updates: Stage 7 |
| §23 Architecture documentation | Skeletons: Stage 1. Database docs: Stage 2. Domain docs: Stage 3. Channex docs incl. screenshare script: Stage 4. Security docs: Stage 6. Completion and diagram verification: Stage 7 |
| §24 Test program | Checks distributed per stage (each stage document lists its checks); characterization-test rule applies from Stage 3 onward; consolidated full run: Stage 7 |
| §25 Full regression | Scoped regression at every stage exit; the complete list: Stage 7 |
| §26 Production activation guard | Built in Stage 4 (database prerequisites from Stage 2); independently verified in Stage 7 |
| §27 Implementation phases | Superseded by this stage structure. Mapping: Phase 0→Stage 1 entry; Phases 1–2→Stage 1; Phase 3→Stage 2; Phases 4–5→Stage 3; Phases 6–11→Stage 4; Phase 12→Stage 5; Phases 13–14→Stage 6; Phases 15–17→Stage 7; Phase 18→every stage exit, finalized in Stage 7 |
| §28 Definition of Done | Per-stage exit gates; the complete list verified in Stage 7 |
| §29 Final report | Stage reports at every stage; the comprehensive final report in Stage 7 |
| §30 Quality standard | Charter — all stages |

Check allocation (V2 §24): `check:db-isolation` → Stage 2. `check:pms-domain-invariants`, `check:reservation-concurrency`, `check:inventory-integrity`, `check:pricing-equality`, `check:payment-ledger-integrity`, `check:background-job-recovery`, `check:timezone-and-money-invariants` → Stage 3. `check:channex-environment-routing`, `check:channex-certification`, `check:channex-certification-evidence`, `check:channex-full-sync-two-requests`, `check:channex-group-update-batching`, `check:channex-rate-limit-cooldown`, `check:channex-booking-crs-flow`, `check:channel-security`, `check:channel-chaos`, `check:production-activation-guard` → Stage 4. `check:no-secrets` → Stage 6. `check:code-documentation` → Stage 7. All twenty checks are accounted for; none may be dropped.

## 8. Program files in the repository

All program files (this charter, the V2 specification, the seven stage documents, the State file and stage reports) live in the repository under `docs/program/`. Stage 1 commits them on the integration branch as its first milestone. Every later stage relies on them being present and current.
