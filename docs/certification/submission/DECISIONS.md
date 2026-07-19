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

## D-5 — Provisioning attempt (2026-07-19) blocked: no certification Channex Staging key ❌

**Attempt.** Ran the "provision staging property + fixture" task (audit → provision →
seed → verify). Halted at STEP 0's mandatory precondition — *"verify staging credentials
load and `GET /properties` succeeds BEFORE creating anything"* — because the credential to
authenticate a certification-property Channex call does not exist. **No live entity was
created; the dev hotel was not touched; no app was restarted.**

**Root cause (three compounding, verified facts):**

1. **No dedicated certification Channex Staging API key.** `createChannexPropertyAction`
   resolves the key via `withChannexKey(tenantId)` → `loadChannexRow(tenantId).api_key_ciphertext`,
   i.e. it needs the **certification tenant's own stored, encrypted Channex key**. On
   staging there is **no certification tenant/connection at all** — the only
   `channel_connections` row is the dev hotel (`גינות הים · תל אביב`, `environment=staging`,
   key hint `••••IBaJ`), which HARD RULES forbid touching. `CHANNEL_SECRETS_KEY` (needed to
   encrypt/decrypt any key) is present **only** in `/var/www/guesthub-production/.env.local`,
   not in this checkout's env. So the first Channex request cannot authenticate.

2. **Create + reservation flows are authenticated Next server actions, not scriptable.**
   `createChannexPropertyAction`, `createChannexRoomType`/`room-type-admin`,
   `rate-plan-admin`, `upsertChannelConnectionAction`, and `createReservationAction` are all
   `"use server"` and gated by `requireChannelAdmin()` / `getActor()` / `requirePermission()`
   — they need a super_admin browser session (cookies), so a standalone
   `scripts/provision-channex-certification.mjs` cannot invoke them. Reimplementing them in a
   script would (a) still need the key from (1), (b) duplicate server-action logic, and (c) be
   the Channex-**rejected** anti-pattern ("standalone script / certification-only tooling",
   `PMS_CERTIFICATION_REQUIREMENTS.md` §3). No such script was written, by design.

3. **App topology.** The running staging GuestHub app is pm2 **`guesthub`** @
   `/var/www/guesthub-production` (:3007). pm2 **`pms`** is an **unrelated** repo at
   `/var/www/pms` — the task's "pm2 restart pms" targets the wrong app; not run.

**The correct provisioning path (UI-driven, what the code is built for).** Provisioning is
designed to be operated by Ronen from the running app, needing only the one missing input:

1. Obtain a **Channex Staging** account/property API key for certification (separate from the
   dev hotel's). Confirm `GET /properties` on `staging.channex.io` succeeds with it.
2. In GuestHub (`:3007`, super_admin) create the isolated tenant **GuestHub Certification**
   with its Business Profile (property name `Test Property - GuestHub`, currency **USD**), 2
   physical rooms (Twin Room, Double Room, occ 2) and 2 local rate plans (BAR / B&B).
3. `/channels` → save the certification Channex Staging API key on this tenant's connection
   (`environment=staging`), then **Create property** → room-type sync → rate-plan sync; map
   the 4 room×rate-plan pairs and verify **4/4**. All IDs come back from the API list
   endpoints (never hardcoded).
4. Seed varied 500-day rates/min-stay/restrictions in the Rate Grid, and create a few test
   reservations from `/reservations` (the real path) so some dates read sold (0/1 model).
5. Read the real Channex UUIDs from the `/channels` console into `01-cover.md` (replacing
   *"assigned at provisioning"*), then run the scenarios per `CERTIFICATION_RUNBOOK.md`.

Everything from step 2 on is a live, authenticated, UI operation; the only external
dependency is the key in step 1. Until that key exists, provisioning cannot proceed safely
(STAGING-ONLY, no-secrets, don't-touch-dev-hotel all hold).

---

## Status summary

- **Ready to send today:** declarations (12–14), adaptations, demo script, cover
  (intended identity), architecture/flow references, and offline-check evidence.
- **Blocked on the live run (external dependency V2 §2):** the executable-scenario
  Task IDs (1–11), the certification-property Channex UUIDs, test-11 booking
  evidence, and scenario screenshots.
- **Provisioning (D-5) blocked on one input:** a dedicated certification **Channex
  Staging API key**; then provisioning is a UI operation on `guesthub`:3007 (not a script,
  not `pms`).
- No application code was changed. No live entity was created. No secrets are bundled
  (scan: `SUBMISSION_STATUS.md`).
