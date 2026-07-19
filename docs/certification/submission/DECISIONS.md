# DECISIONS — Channex Certification Submission Package

Unresolved items and decisions taken while bundling the submission package
(documentation-only task; no application code was modified). Each item that would
require a code change or a live action beyond documentation is logged here and
marked ❌ in `SUBMISSION_STATUS.md`.

Captured: 2026-07-19 · Branch: `main` · Package: `docs/certification/submission/`

---

## D-1 — Live scenario evidence (Task IDs) does not yet exist ❌ (scenarios 1–11)

**Finding.** The evidence ledger on Channex Staging is empty:

```
SELECT count(*) FROM guesthub.channel_evidence_ledger;  -- → 0
```

No executable scenario (1–11) has been run against live Channex Staging, so there
are **no real Channex Task IDs, revision IDs, or scenario screenshots** to bundle.
All scenario evidence in `02-evidence-index.md` is therefore structured as
**pending**: it names the exact ledger row (`scenario_key`), the firing file +
function that will stamp it, and the expected request counts — but the Task-ID and
screenshot cells cannot be filled until the live run.

**Why not resolved here.** Running the scenarios requires live Channex Staging API
traffic (out of scope for a documentation task) and the dedicated certification
property (see D-2). This is the program's known external dependency (V2 §2;
`CERTIFICATION_SCENARIO_MATRIX.md` "Live execution pending").

**To close:** provision the certification property (D-2), execute the runbook
(`docs/channex/CERTIFICATION_RUNBOOK.md`) from the PMS UI, then paste the ledger's
Task IDs and screenshots into `02-evidence-index.md` / `assets/`.

---

## D-2 — Dedicated certification property not provisioned ❌ (cover IDs)

**Finding.** The only live Channex Staging connection belongs to an unrelated
**development** property, not the certification property:

| Field | Live staging value | Certification spec requires |
|---|---|---|
| Tenant | `גינות הים · תל אביב` (Ginot HaYam · Tel Aviv) | `GuestHub Certification` |
| Channex property ID | `10338c65-5b0e-402b-bdaa-f3efe10e9896` | (property `Test Property - GuestHub`) |
| Currency | ILS | USD |
| Room types | Hebrew Suite/Studio names, rooms 926–1424 (13 mapped) | Twin Room, Double Room (occupancy 2) |
| Rate plans | ביטול גמיש / ללא החזר / חודשי / שבועי (52 mapped) | Twin&Double × BAR $100 / B&B $120 (4) |

So the Channex staging **property ID, room-type IDs (Twin/Double), rate-plan IDs
(BAR/B&B USD) and the 4 room×rate-plan mappings** requested for the cover **do not
exist yet**. `01-cover.md` records the intended certification identity from the
spec and marks the concrete Channex UUIDs as *assigned at provisioning*.

**Why not resolved here.** Creating the property + mappings is a live Channex
Staging operation, not a documentation change. GuestHub never auto-creates a
Channex property (operator create/adopt only, D60), by design.

**To close:** operator creates `Test Property - GuestHub` (USD, Twin/Double, 4 BAR/B&B
plans) on Channex Staging via `/channels`, verifies mappings 100%, and records the
returned UUIDs in `01-cover.md`.

---

## D-3 — Booking-receiving evidence (test 11) pending a test channel ❌

**Finding.** Test 11 (create/modify/cancel + ACK) needs a Booking.com test account
on the Staging connection, or the Booking CRS injector. Neither has been exercised
against this property; `channel_webhook_events` and inbound evidence rows for the
certification property are empty. The flow itself is built, hardened and verified
offline (`check:channex-booking-crs-flow`, `check:inbound-bookings` — 235
assertions).

**To close:** connect a Booking.com test account (preferred) or run Booking CRS
(fallback) per `docs/channex/BOOKING_RECEIVING_CERTIFICATION.md`; capture revision
IDs, reservation numbers, ACK tasks and screenshots into `02-evidence-index.md`.

---

## D-4 — No scenario screenshots in the repo (assets are logs only)

**Finding.** `docs/proof/` contains phase-3 **PMS-UI** screenshots (calendar,
side-panels, cards) — none show Channex evidence (no `/channels` console, Task IDs,
or ARI calls). So `assets/` bundles the **offline-verification evidence that does
exist** — the captured `check:channex-*` outputs (all PASS) — rather than fake
scenario screenshots. Scenario screenshots are produced during the live run (D-1).

---

## Status summary

- **Ready to send today:** declarations (12–14), adaptations, demo script, cover
  (intended identity), architecture/flow references, and offline-check evidence.
- **Blocked on the live run (external dependency V2 §2):** the executable-scenario
  Task IDs (1–11), the certification-property Channex UUIDs, test-11 booking
  evidence, and scenario screenshots.
- No application code was changed. No secrets are bundled (scan: `SUBMISSION_STATUS.md`).
