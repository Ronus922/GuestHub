# STAGE 6 — SECURITY, PERFORMANCE AND OBSERVABILITY

Read first: `00_COMMON_CHARTER.md`, `GUESTHUB_PROGRAM_V2.md`, `docs/program/STATE.md`, Stage 5 report.

## Stage mission

Attack, measure and instrument the completed system: the full red-team review, the full performance and scalability program, and complete operational observability with alerts — so the system survives real load, real failures and a real security review.

## Entry gate

Charter entry gate (§5). Additionally: the system is feature-complete for this program (Stages 3–5 closed); load the residual security findings from all previous stage reports as the starting backlog.

## Binding V2 scope for this stage

* §19 in full: authorization attacks, secrets (including the git-history secret scan and Supabase key discipline), the supply-chain subsection (dependency vulnerability audit, lockfile integrity, pinned Node.js runtime), application attacks, and synchronization attacks and failures. Resolve all Critical and High; document residual Medium/Low.
* §20 in full: measurement-driven performance work at current realistic scale and the growth-scale fixture, query-plan inspection, justified indexes only, DST dates in fixtures, and the full verification list.
* §21 in full: the complete sanitized operational visibility list, the complete alert list, log hygiene rules, and backup-status monitoring on top of the Stage 2 backup automation.
* §24, fault-injection and remaining concurrency portions: the full fault-injection list and any §24 concurrency scenarios not yet exercised (webhook plus poll, credential rotation during a job, certification reset during a run, two Full Sync clicks, database unavailable, corrupted queue payload, expired lease).
* §23, security documents: `THREAT_MODEL.md` (finalized), `SECURITY_TEST_REPORT.md`, `SECRET_HANDLING.md`; plus `OBSERVABILITY.md` completed.

## Stage-specific directives

* Red-team work runs only against staging and the disposable database; never against production or the shared infrastructure.
* Performance conclusions require measurements before and after; no blind optimization.
* Alerting must be actionable: each alert lists the runbook or first response step.

## Active agents

I (lead security), J (lead performance), K (lead observability), B, L, E. Agent N reviews the security-fix evidence.

## Checks added in this stage

`check:no-secrets`. Fault-injection scenarios are added to `check:channel-chaos` and `check:background-job-recovery` coverage; record the delta.

## Exit gate

Charter exit gate (§6), plus:

* Zero unresolved Critical/High security findings; residual risks documented.
* Dependency audit clean of unresolved high/critical advisories, or each one documented with justification.
* Performance targets met or limits documented with measurements at both scales.
* Full fault-injection list executed with evidence; system recovers per §8.
* Alerts and dashboards documented; log-hygiene verification passed.
* All previous checks still pass.
* Tag `stage-6-complete`.
