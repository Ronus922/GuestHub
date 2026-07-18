# Channex — Production Activation Runbook

- **Status:** Skeleton — Stage 1; completed in **Stage 4**, verified in **Stage 7**
- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Sources:** ADR-0004 (§5), `docs/audit/CHANNEX_CERTIFICATION_MAPPING.md` (G6), `docs/architecture/TARGET_ARCHITECTURE.md` (§3 Stage 4), V2 §26

The gated procedure to switch a tenant from Channex Staging to Production **after** certification — built but disabled; the cutover is never executed in this program.

## Current state

There is no production activation path today; outbound calls hardcode staging (G6) and production credentials are only granted by Channex after passing the live screenshare (`PMS_CERTIFICATION_REQUIREMENTS.md` §1 stage 5). The program requires a **production activation guard**: built, disabled — Production cannot self-activate (`TARGET_ARCHITECTURE.md` §3 Stage 4; invariant `check:production-activation-guard`, §5). This mirrors the existing fail-closed discipline (triple deploy guards, fail-closed card/charge paths).

## Target state (per ADR-0004, TARGET_ARCHITECTURE.md §3)

- Environment routing from `channel_connections.environment` in place (G6 fixed) so switching environment is a data change, not a code change.
- A guard that prevents Production activation without explicit, audited operator authorization (V2 §26) — the guard is built and **disabled** in this program.
- Pre-activation checklist: certification passed, mappings verified, credentials installed, evidence archived.
- No cutover executed (Stage 7 verifies the guard exists and refuses, without activating).

## To be completed in Stage 4 (verified Stage 7)

- [ ] Pre-activation checklist (certification pass, mappings 100%, prod credentials, evidence archive).
- [ ] Step-by-step gated activation procedure (audited, explicit authorization).
- [ ] The activation-guard behavior + `check:production-activation-guard` description.
- [ ] Rollback-to-staging procedure.
- [ ] Stage 7 verification: guard present and refusing; nothing activated.
