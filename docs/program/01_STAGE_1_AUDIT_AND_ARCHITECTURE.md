# STAGE 1 — FOUNDATION, SYSTEM AUDIT AND TARGET ARCHITECTURE

Read first: `00_COMMON_CHARTER.md` and `GUESTHUB_PROGRAM_V2.md`. Both are binding.

## Stage mission

Establish a safe working foundation, understand the entire current system, and produce the reconciled target architecture that every later stage implements. This stage changes no product behavior. Its deliverables are knowledge, decisions and safety infrastructure.

## Entry gate

Run the charter entry gate (§5). Since this is the first stage, additionally:

1. Execute V2 Phase 0 in full: resolve and print the database identity of every configured environment; confirm no process in this program can reach the production database; record host disk, memory and CPU headroom in the State file.
2. Take a fresh, verified backup of all current GuestHub data (V2 §3, execution-environment safety) and prove it restores into a scratch database. Record backup location and verification result.
3. Run the V2 §6 git procedure, create the integration branch `feat/pms-hardening-channex-certification`, and open the draft PR.
4. Commit all program files into `docs/program/` on the branch as the first milestone, and create `docs/program/STATE.md`.

## Binding V2 scope for this stage

* §4 in full: read all project guidance files, deployment/PM2/environment configuration, every migration, and all listed module families. Fetch the current official Channex documentation live and produce the versioned requirements document, including the multi-stage certification process, the pre-flight checklist and the rejected anti-patterns.
* §7 in full: the four audit inventories (architecture, domain, workflow, defect) with severity classification. Persist everything under `docs/audit/`.
* §10, audit portion only: for every listed PMS area — including Israel-market readiness — document current capability, defects and missing foundations, and produce the gap matrix with the four-way classification. Assign every "required now" and "high-value near-term" item to Stage 3 or Stage 5 per the charter coverage matrix. Implementation happens in those stages, not here.
* §19, read-only portion: Agent I produces the initial threat model (no fixes yet unless a live Critical exposure demands an emergency, minimal, documented fix).
* V2 Phase 2: the target architecture and ADRs, reviewed by the architecture, database, security and PMS-gap agents, honoring §8 in full.
* §23, skeleton portion: create every listed architecture document with current-state and target-state sections filled from the audit; later stages complete them.

## Stage-specific directives

* Every finding and decision is persisted as files in the repository. Chat output is not durable.
* The defect matrix must state, for each Critical and High item, which stage will fix it. Nothing is left unassigned.
* The ADRs must decide, at minimum: canonical source of truth per business concept (§8), the sync-outbox seam design consumed later by Stage 4, the guest-model direction, the database topology direction (input to Stage 2), and the double-booking prevention mechanism (exclusion constraint design, input to Stage 3).
* Do not begin refactoring, do not add features, do not change schemas. Read-only, plus documentation and tooling for the audit itself.

## Active agents

A (lead), B, C, D (read-only mapping), E, I (read-only), M. Agents F, G, H, J, K contribute findings to the audit in their domains without modifying code.

## Milestones

1. Program files committed, State file created, backup verified.
2. Channex versioned requirements document.
3. Architecture, domain and workflow inventories.
4. Defect matrix with severities and stage assignments.
5. PMS gap matrix with classifications and stage assignments.
6. Target architecture, ADRs, document skeletons.

## Checks added in this stage

None (this stage adds no product code). Existing project checks must pass at every commit.

## Exit gate

Charter exit gate (§6), plus:

* All audit artifacts exist under `docs/audit/` and are internally consistent.
* Every Critical/High defect has an owning stage.
* Every gap-matrix item has a classification and, where applicable, an owning stage.
* ADRs approved by Agent A; disagreements between agents resolved and recorded.
* No product behavior changed; diff contains only documentation, program files and audit tooling.
* Tag `stage-1-complete`.
