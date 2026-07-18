# Channex PMS Certification — Runbook

- **Status:** Skeleton — Stage 1; completed in **Stage 4**
- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Sources:** `docs/channex/PMS_CERTIFICATION_REQUIREMENTS.md` (§1, §4, §5), `docs/audit/CHANNEX_CERTIFICATION_MAPPING.md` (§1 manual steps)

The step-by-step operator procedure to execute all 14 certification items against Channex Staging, capture Task IDs, and submit the form.

## Current state

The official process is 5 stages: build against Staging → execute scenarios from the PMS UI recording Task IDs → submit the Google form → **live screenshare review** (reviewers perform ad-hoc changes and verify calls fire from real paths) → production access (`PMS_CERTIFICATION_REQUIREMENTS.md` §1). The staging test property is `Test Property - GuestHub`, USD, Twin/Double room types, 4 rate plans; GuestHub's 0/1 availability model requires the documented vacation-rental adaptation (§4). Each scenario's manual steps already exist in the mapping audit (e.g. "run each of tests 3–8 as ONE Group Update so it emits 1 API call"; G7) (`CHANNEX_CERTIFICATION_MAPPING.md` §1 "Manual steps"). Two blockers must be fixed before a clean run: Task IDs are not captured for incremental syncs (G1/G2) and 429 handling is not declarable (G3).

## Target state (per PMS_CERTIFICATION_REQUIREMENTS.md §9, ADR-0004)

- Realistic varied 500-day data seeded before Full Sync (uniform data is flagged synthetic, §4).
- Task IDs read directly from GuestHub's evidence ledger after G1/G2 (no Channex-dashboard spelunking).
- Each of tests 2–10 run as a single Group Update/save within one worker tick (G7).
- Declarations 12–14 pre-written and verified against actual behavior.

## To be completed in Stage 4

- [ ] Pre-run checklist: verify staging connection, mappings 100%, realistic data seeded, evidence ledger live.
- [ ] Per-scenario numbered steps (1–11) with exact UI actions and where to read the Task ID.
- [ ] Task-ID capture procedure from the evidence ledger.
- [ ] Declaration answers (12–14) with source-of-truth citations.
- [ ] Form-submission checklist (https://forms.gle/... — do not hardcode values from docs into product).
- [ ] Re-verify live test values at Stage 4 entry (V2 §4).
