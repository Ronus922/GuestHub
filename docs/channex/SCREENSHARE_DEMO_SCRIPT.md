# Channex Certification — Screenshare Demo Script

- **Status:** Skeleton — Stage 1; completed in **Stage 4**, rehearsed in **Stage 7**
- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Sources:** `docs/channex/PMS_CERTIFICATION_REQUIREMENTS.md` (§1 stage 4), `docs/audit/CHANNEX_CERTIFICATION_MAPPING.md`

The narrated script for the live screenshare review, where Channex reviewers watch real PMS actions — some scripted, some **ad-hoc arbitrary** — and confirm API calls fire from the real update paths.

## Current state

Stage 4 of the official process is a live screenshare: *"If the Channex call doesn't fire from your real update path, you don't pass."* Reviewers perform some test actions and some ad-hoc arbitrary changes, and examine the queue logic, retries, and mapping layer; failing restarts from stage 1 (`PMS_CERTIFICATION_REQUIREMENTS.md` §1). GuestHub is well-positioned: all triggers are the production `/rates`, `/reservations`, `/calendar`, `/channels` surfaces (no certification-only UI), and `check:channex-ari.mjs` part D asserts at source level that no other module can send ARI (`CHANNEX_CERTIFICATION_MAPPING.md` §4). The demonstrable seam is `markAriDirty` (same tx) → `channel_dirty_ranges` → queue → worker → `pushAri`.

## Target state

- A rehearsed narration that shows, for each action: the UI save, the dirty range appearing, the queue job, and the resulting Task ID in the evidence ledger (post G1/G2).
- Prepared answers for the reviewer's likely ad-hoc requests (arbitrary date/rate/restriction/booking changes) that all route through the same seam.
- Live demonstration of 429/backoff behavior (post G3) and the mapping layer.

## To be completed in Stage 4 (rehearsed Stage 7)

- [ ] Opening: architecture one-liner (change detection → outbox → queue → worker → one seam).
- [ ] Scripted action walkthrough (a rate edit, a Group Update, a booking, a cancel) with what to point at on screen.
- [ ] Ad-hoc-change readiness: how to show any arbitrary change fires from the real path.
- [ ] Queue/retry/mapping demonstration talking points.
- [ ] Evidence-ledger live view of Task IDs.
- [ ] Stage 7 rehearsal notes + timing.
