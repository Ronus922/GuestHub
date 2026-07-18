# STAGE 2 — DEDICATED DATABASE INFRASTRUCTURE

Read first: `00_COMMON_CHARTER.md`, `GUESTHUB_PROGRAM_V2.md`, `docs/program/STATE.md`, Stage 1 report.

## Stage mission

Give GuestHub database infrastructure dedicated only to GuestHub: a working certification/staging database, a disposable test database, and a fully prepared (but not executed) production cutover — while the shared infrastructure and every other application on it remain completely untouched.

## Entry gate

Charter entry gate (§5). Additionally verify: Stage 1 ADR on database topology exists; the Stage 1 verified backup is still restorable; host resource headroom recorded in the State file is sufficient for the chosen topology, or the topology decision is revisited before provisioning.

## Binding V2 scope for this stage

* §9 in full: shared-infrastructure protection, required topology (Production prepared, Certification/Staging provisioned, disposable test database), topology decision recorded as an ADR, authentication dependency handling (GoTrue and Supabase schemas), Supabase key and RLS audit for database access paths, least-privilege roles, the thirteen-item data-migration tooling list, the verification list, the four database documents, and `check:db-isolation`.
* §21, backup portion: automated scheduled backups with a defined retention policy and at least one off-host copy, for the new GuestHub databases; the restore procedure exercised, not merely documented.
* §19, applicable portion: role and privilege review for the new databases; no runtime role owns schemas or migrations; secrets for the new environments handled per §3.

## Stage-specific directives

* Never modify, restart, reconfigure or upgrade the shared stack. Read from it only for inventory, backup and data-copy purposes. At stage exit, prove the other applications are unaffected.
* Point the development and staging application and workers at the new certification/staging database; smoke-test both (application and workers) against it.
* Prove migration replay from zero on the disposable database, and data-copy fidelity from the shared source into staging with checksum and row-count validation (V2 §9 verify list).
* Prepare, but do not execute, the production cutover: provisioning plan or provisioned-but-idle production database, cutover runbook, rollback tooling.
* All destructive experiments run only on the disposable database.

## Active agents

E (lead), A, I, K, L. Agent N reviews the isolation claims at stage end.

## Milestones

1. Topology ADR finalized against measured host resources.
2. Certification/staging stack provisioned; roles created; application and workers running against it.
3. Migration replay from zero proven; data copy validated.
4. Backup automation with retention and off-host copy; restore drill passed.
5. Production cutover runbook and rollback tooling prepared.
6. The four `docs/database/` documents complete.

## Checks added in this stage

`check:db-isolation`.

## Exit gate

Charter exit gate (§6), plus:

* Application and worker smoke tests pass against the new staging database.
* `check:db-isolation` passes; no unrelated data in target databases.
* Restore drill evidence recorded.
* Other applications on the shared infrastructure verified untouched and functioning.
* Cutover runbook reviewed by Agent N; cutover NOT executed.
* Tag `stage-2-complete`.
