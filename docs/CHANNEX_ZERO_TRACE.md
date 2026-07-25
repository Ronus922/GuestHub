# CHANNEX ZERO-TRACE — D91 residue sweep (Channex · Hospitable · Stripe)

**Branch:** `stab/channex-zero-trace` (worktree `/var/www/wt-channex`, based on `origin/main` = `5b171bd`)
**Date:** 2026-07-25
**Scope:** SCAN everything; EXECUTE renames in **code and documentation only** (rename-only, zero behaviour change).
**Not executed (needs Ronen's approval):** the catalog rename migration, the `'channex_verified'` value change, any `channel_connections` row deletion.

---

## 0. Executive summary

| Category | Occurrences | Verdict |
|---|---|---|
| Application code — `src/` | **0** | Already zero-trace. `git grep -niE 'channex\|hospitable\|stripe' -- src/` → 0 lines. |
| Application code — `scripts/` | **1** | One historical cutover comment. Load-bearing. Kept. |
| UI strings (Hebrew/RTL, `src/**`) | **0** | No user-visible string mentions any of the three brands. |
| npm dependencies (`package.json`, `pnpm-lock.yaml`) | **0** | No dependency, devDependency, script name or lockfile entry. |
| Documentation (`docs/`, root `*.md`, `claude/`) | **336** | 3 lines rewritten across 3 **live/current-state** docs (§7.1). The rest are historical records — kept deliberately, see §7.2. |
| DB migrations on disk (`db/migrations/*.sql` + `manifest.txt`) | **160** | Immutable applied history. **Never** edited. See §7.2. |
| **Total (tracked files, unique lines)** | **497** — excluding this report. Was **499** before the sweep: 2 of the 3 rewritten lines dropped the dead brand entirely, the third (`BEDS24_COMPLETION_PLAN.md:68`) still names it legitimately. | |
| Live catalog — index / constraint names | **4 indexes** (`uq_*_channex_*`) + **2 CHECK definitions** + **1 dead table** (+4 of its indexes/6 constraints) | Pending approval — §8. |
| Live data — `channel_inbound_rate_plan_aliases.source` | **10 rows**, 1 distinct value: `channex_verified` | Pending approval — §8. |
| Live data — suspended `channel_connections` | **2 rows** (channex/staging, hospitable/production) + **66 inert `pending` date ranges** + 75 dependent mapping rows | Pending approval — §8. Iron rule 8 forbids deletion. |

Per-term unique-line counts across all tracked files: `channex` **459**, `hospitable` **42**, `stripe` **20**.

### 0.1 The one finding that is not cosmetic

`src/lib/rates/grid-state.ts` derives the /rates grid's channel badges **tenant-scoped, not connection-scoped**:

```
src/lib/rates/grid-state.ts:178-180   SELECT id FROM guesthub.channel_connections WHERE tenant_id = ... AND state = 'active'
src/lib/rates/grid-state.ts:194-195   SELECT DISTINCT room_id FROM guesthub.channel_room_mappings
                                      WHERE tenant_id = ... AND status = 'mapped' AND room_id IS NOT NULL
src/lib/rates/grid-state.ts:197-201   SELECT room_id, date_from, date_to FROM guesthub.channel_dirty_ranges
                                      WHERE tenant_id = ... AND status <> 'synced' AND ...
```

Production reality (read-only verification, schema `guesthub`):

* `channel_room_mappings` — **13 rows, all `status='mapped'`, all belonging to the PAUSED channex connection `5e6dba4e…`**. Beds24's real mappings live in a different table (`channel_beds24_room_mappings`, 14 rows).
* `channel_dirty_ranges` with `status <> 'synced'` — **66 rows, all `pending`, all on the paused channex connection**, all carrying a `room_id`.

Because the tenant now has an *active* Beds24 connection, `hasActiveConnection` is `true`, so the grid reads both queries and:

1. the "mapped" badge on /rates is currently sourced from **dead Channex mappings**, not from Beds24;
2. every (room, day) covered by those 66 orphaned `pending` ranges renders as "pending sync" **permanently** — nothing will ever drain them, the connection is paused.

This is a live, user-visible consequence of the residue. Fixing it is a **behaviour change**, therefore outside the rename-only EXECUTE mandate — recorded here as pending item **P-5** (§8).

---

## 1. Application code — `src/`

**0 occurrences.** Verified:

```
$ git grep -niE 'channex|hospitable|stripe' -- src/
(no output)
```

This also covers **UI strings**: there is no Hebrew or English user-facing literal containing `Channex`, `Hospitable` or `Stripe` anywhere under `src/`.

## 2. Application code — `scripts/`

**1 occurrence.**

```
scripts/check-beds24-jobs.mjs:43  // D91 cutover: the Channex/Stripe/Hospitable removal reached production at
```

**Kept.** The comment explains *why* the script's job-age filter starts at a specific timestamp — it is the D91 cutover boundary. Renaming the brands out of it would delete the reason the constant exists. Zero behaviour impact either way.

## 3. npm dependencies

**0 occurrences.**

```
$ grep -niE 'channex|hospitable|stripe' package.json pnpm-lock.yaml
(no output)
$ grep -oE '"check:[a-z0-9-]+"' package.json | grep -iE 'channex|hospit|stripe'
(no output)
```

No package, no lockfile entry, no npm script. The 18 `check-channex-*` guards listed in D91 §7 are gone from disk and from `package.json`.

`ecosystem.config.cjs` has no Channex/Hospitable/Stripe reference. Its only `pms` mention is line 7, a comment warning that the **unrelated** PM2 app `pms` (a different project at `/var/www/pms`) must not be touched — consistent with iron rule 14, nothing to do.

## 4. Documentation — full occurrence list (336 lines)

Includes `docs/**`, root `*.md` and `claude/*.md`. Snippets truncated at 110 chars.

### 4.1 `docs/**` (270)

```
docs/BEDS24_COMPLETION_PLAN.md:67  | P4-1 | **Legacy row cleanup**: paused channex/hospitable `channel_connections` rows + their 66 inert non-syn …
docs/BEDS24_COMPLETION_PLAN.md:68  | P4-2 | **055 candidate**: rename channex-named indexes/constraints (`uq_*_channex_*`, 023's `chk_*`) and the …
docs/CHANNEL_LAYER_INVENTORY.md:6  Channex and Hospitable were removed entirely.
docs/CHANNEL_LAYER_INVENTORY.md:35  | `channel-http.ts` | The leak-proof HTTP request core + error taxonomy + defensive parsers. Formerly `channex …
docs/CHANNEL_LAYER_INVENTORY.md:75  Migration `054_external_column_rename.sql` renamed all 19 legacy `channex_*`
docs/CHANNEL_LAYER_INVENTORY.md:78  `grep -rni channex src/ scripts/` returns 0.
docs/CHANNEL_LAYER_INVENTORY.md:81  behavior): index/constraint names (`uq_crtm_channex_id`, `uq_crpm_channex_id`,
docs/CHANNEL_LAYER_INVENTORY.md:82  `uq_crm_channex_room_type`, `uq_crrm_channex_rate_plan`, 023's `chk_*`) and the
docs/CHANNEL_LAYER_INVENTORY.md:83  `channel_inbound_rate_plan_aliases.source` value/CHECK `'channex_verified'`.
docs/CHANNEL_LAYER_INVENTORY.md:88  The deleted Channex integration guards (`check-channex-*`, worker/rates-sync/
docs/architecture/AUTHORIZATION_AND_TENANCY.md:4  - **Branch:** `feat/pms-hardening-channex-certification`
docs/architecture/BACKGROUND_JOBS.md:4  - **Branch:** `feat/pms-hardening-channex-certification`
docs/architecture/DEPLOYMENT.md:5  - **Branch:** `feat/pms-hardening-channex-certification`
docs/architecture/DOMAIN_MODEL.md:4  - **Branch:** `feat/pms-hardening-channex-certification`
docs/architecture/INVENTORY_AND_AVAILABILITY.md:4  - **Branch:** `feat/pms-hardening-channex-certification`
docs/architecture/OBSERVABILITY.md:5  - **Branch:** `feat/pms-hardening-channex-certification`
docs/architecture/PAYMENTS_AND_LEDGER.md:4  - **Branch:** `feat/pms-hardening-channex-certification`
docs/architecture/PMS_CAPABILITY_MATRIX.md:5  - **Branch:** `feat/pms-hardening-channex-certification`
docs/architecture/PRICING_AND_RESTRICTIONS.md:4  - **Branch:** `feat/pms-hardening-channex-certification`
docs/architecture/RESERVATION_LIFECYCLE.md:4  - **Branch:** `feat/pms-hardening-channex-certification`
docs/architecture/SYSTEM_OVERVIEW.md:5  - **Branch:** `feat/pms-hardening-channex-certification`
docs/architecture/TARGET_ARCHITECTURE.md:3  **Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification` · **Status:** Stage 1 deliverabl …
docs/architecture/TARGET_ARCHITECTURE.md:65  - PSP: Cardcom/Tranzila only — decided, **no Stripe** (D91); the seam is provider-neutral (Stage 3, V2 §18).
docs/audit/ARCHITECTURE_INVENTORY.md:4  - **Reflects branch:** `feat/pms-hardening-channex-certification` (dev checkout `/var/www/guesthub`)
docs/audit/ARCHITECTURE_INVENTORY.md:14  | **Channel worker** | Long-running Node process (`scripts/channel-worker.cjs` → compiled `dist/worker/lib/cha …
docs/audit/ARCHITECTURE_INVENTORY.md:44  ├── channel/               # 36 modules: queue, worker, ari-*, channex-*, booking-import,
docs/audit/ARCHITECTURE_INVENTORY.md:74  - **Channel manager (Channex):** `channel_connections`, `channel_sync_jobs`, `channel_webhook_events`, `channe …
docs/audit/ARCHITECTURE_INVENTORY.md:106  | **Channex** | Channel manager (Booking.com live). ARI push, room-type/rate-plan sync, booking revision pull. …
docs/audit/ARCHITECTURE_INVENTORY.md:130  | `POST /api/channel/webhook/[token]` | Channex → app | Opaque per-connection capability token (min length enf …
docs/audit/ARCHITECTURE_INVENTORY.md:166  | Encryption vaults (three separate blast radii) | `CARD_VAULT_KEY` (PAN vault), `CHANNEL_SECRETS_KEY` (Channe …
docs/audit/ARCHITECTURE_INVENTORY.md:212  | `check-channel-worker.mjs`, `check-channex-ari.mjs`, `check-channex-connection.mjs`, `check-channex-credenti …
docs/audit/ARCHITECTURE_INVENTORY.md:231  CHX[Channex staging/prod]
docs/audit/ARCHITECTURE_INVENTORY.md:287  7. **[Medium] One PM2 worker couples Channex sync and guest communications.** `runCommunicationTick` runs insi …
docs/audit/CODEBASE_AUDIT.md:4  - **Branch:** `feat/pms-hardening-channex-certification`
docs/audit/CODEBASE_AUDIT.md:5  - **Scope:** entire repository source — `src/` (app routes, server actions, components, lib/domain modules), ` …
docs/audit/CODEBASE_AUDIT.md:36  | 15 | `scripts/check-channex-ari.mjs` | 840 | test harness (non-product) |
docs/audit/DEFECT_MATRIX.md:3  **Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification` · **Stage:** 1 (audit)
docs/audit/DEFECT_MATRIX.md:7  Owning-stage rule (charter coverage matrix): dedicated-DB/topology/backup infra → **Stage 2**; core-domain int …
docs/audit/DEFECT_MATRIX.md:9  Source key: ARCH=Architecture, DOM=Domain, CODE=Codebase, RES=Reservations/Inventory, PRICE=Pricing, PAY=Payme …
docs/audit/DEFECT_MATRIX.md:20  No Critical defects were found in application domain logic, pricing, payments, or the Channex integration itse …
docs/audit/DEFECT_MATRIX.md:36  | H9 | CHX G1 | **Incremental syncs discard Channex Task IDs.** 136/136 succeeded `sync_ari_range` jobs have N …
docs/audit/DEFECT_MATRIX.md:38  | H11 | OPS F2 | **Quarantined revisions re-imported every poll, logging a fresh error row each cycle** — unbo …
docs/audit/DEFECT_MATRIX.md:57  | M8 | PAY H-5 | Token model gaps vs V2 §18 (provider CHECK `'stripe'`-only; no customer ref/status/consent; P …
docs/audit/DEFECT_MATRIX.md:65  | M16 | ARCH#6 | One PM2 worker couples Channex ARI sync with guest communications — one subsystem's failure s …
docs/audit/DEFECT_MATRIX.md:107  - **Channex architecture is certification-shaped**: change detection → outbox → durable queue → batched push t …
docs/audit/DOMAIN_INVENTORY.md:4  - **Branch:** `feat/pms-hardening-channex-certification`
docs/audit/DOMAIN_INVENTORY.md:40  | `room_types` | 3 | **Descriptive metadata only** since D64/024 — capacity/bed defaults + `base_price` fallba …
docs/audit/DOMAIN_INVENTORY.md:70  | `reservation_payment_methods` | 0 | PSP token references (030, Stripe-only CHECK): `provider_ref` + safe dis …
docs/audit/DOMAIN_INVENTORY.md:86  ### 2.6 Channel manager (Channex)
docs/audit/DOMAIN_INVENTORY.md:90  | `channel_connections` | 1 | 1 per (tenant, provider='channex', environment). State machine CHECK; encrypted  …
docs/audit/DOMAIN_INVENTORY.md:91  | `channel_room_mappings` | 13 | **The live inventory mapping (D64/024): ONE physical room ⇄ ONE Channex Room  …
docs/audit/DOMAIN_INVENTORY.md:92  | `channel_room_rate_mappings` | 52 | **The live rate mapping (D65/025): (room × local Rate Plan) ⇄ ONE Channe …
docs/audit/DOMAIN_INVENTORY.md:102  | `channel_inbound_rate_plan_aliases` | 10 | Inbound-only alias adoption (032): external rate-plan UUID → prov …
docs/audit/DOMAIN_INVENTORY.md:190  CHANNEL_CONNECTIONS ||--o{ CHANNEL_ROOM_MAPPINGS : "room ⇄ Channex room type"
docs/audit/OPERATIONS_OBSERVABILITY_AUDIT.md:4  - **Branch:** feat/pms-hardening-channex-certification
docs/audit/OPERATIONS_OBSERVABILITY_AUDIT.md:27  - **Dead letter observed:** `full_sync` / `validation_error` / "רק 13 מתוך 14 חדרים ממופים ל-Channex" (2026-07 …
docs/audit/OPERATIONS_OBSERVABILITY_AUDIT.md:33  - **Root cause of the growth pattern:** quarantined revisions stay UNacknowledged by design, so Channex's feed …
docs/audit/PAYMENTS_AUDIT.md:4  - **Branch:** feat/pms-hardening-channex-certification
docs/audit/PAYMENTS_AUDIT.md:64  - **Stripe/token-ready:** no — the seam has **no token-charge method**; `reservation_payment_methods.provider_ …
docs/audit/PAYMENTS_AUDIT.md:74  | provider | ⚠️ Partial | Column exists but `CHECK (provider IN ('stripe'))` (`030:112`) — Cardcom/Tranzila/ot …
docs/audit/PAYMENTS_AUDIT.md:154  | H-5 | Medium | Token model gaps vs V2 §18: provider CHECK hardwired to `'stripe'`; no external **customer**  …
docs/audit/PMS_CAPABILITY_MATRIX.md:3  **Date:** 2026-07-18 · **Stage:** 5 — PMS Capability Completion · **Branch:** `feat/pms-hardening-channex-cert …
docs/audit/PMS_GAP_MATRIX.md:4  - **Branch:** `feat/pms-hardening-channex-certification`
docs/audit/PMS_GAP_MATRIX.md:64  - **Restriction enforcement on direct entry** — min-stay/CTA/CTD are projected to Channex (`src/lib/channel/ar …
docs/audit/PMS_GAP_MATRIX.md:126  **Current capability.** No operator-facing import or export of any entity. The only structured data paths are: …
docs/audit/PMS_GAP_MATRIX.md:151  **Current capability.** None, by design: one tenant = one property. Business identity lives in `tenants.settin …
docs/audit/PMS_GAP_MATRIX.md:158  **Current capability.** The most invested area. Channex staging connection with verified credentials (`src/lib …
docs/audit/PMS_GAP_MATRIX.md:162  - Production (non-staging) Channex certification/cutover — this IS the current program, not a new gap.
docs/audit/PRICING_AUDIT.md:4  - **Branch:** feat/pms-hardening-channex-certification
docs/audit/PRICING_AUDIT.md:14  ONE server-side pricing engine exists: `calculateQuote` / `calculateReservationPrice` (alias, same function) i …
docs/audit/PRICING_AUDIT.md:69  | (d) Channex ARI projection | `projectAri` (`src/lib/channel/ari-projection.ts:206-496`) calls **the exact en …
docs/audit/PRICING_AUDIT.md:74  **Verdict:** there is no surface computing a *sale* price independently — every price that can be committed or …
docs/audit/PRICING_AUDIT.md:89  - **Outbound:** both fields are sent explicitly to Channex — `min_stay_arrival` and `min_stay_through` on ever …
docs/audit/PRICING_AUDIT.md:93  - **CTA** on the arrival date only (`rules.ts:64`); ARI also folds `allowed_checkin_days` (DOW rule) into per- …
docs/audit/PRICING_AUDIT.md:119  - **Channex:** rates serialized as fixed 2-decimal strings `toFixed(2)` (`ari-payloads.ts:115-118`) — unambigu …
docs/audit/PRICING_AUDIT.md:157  | F-1 | **Pass (Info)** | One canonical engine genuinely reached by every committing/publishing surface: booki …
docs/audit/PRICING_AUDIT.md:160  | F-4 | **Medium** | No tourist (foreign-guest) VAT zero-rating: VAT is one per-tenant scalar; a per-reservati …
docs/audit/PRICING_AUDIT.md:167  | F-11 | **Pass (Info)** | Min-stay dual semantics (Arrival + Through) stored separately, validated canonicall …
docs/audit/PRICING_AUDIT.md:168  | F-12 | **Pass (Info)** | Fail-closed everywhere: unpriceable night → structured error / stop_sell-no-rate; e …
docs/audit/PRICING_AUDIT.md:174  The pricing core is in unusually good shape for Stage 4: one engine, one seam, one write path (`writeRateCells …
docs/audit/RESERVATIONS_INVENTORY_AUDIT.md:4  - **Branch:** feat/pms-hardening-channex-certification
docs/audit/WORKFLOW_INVENTORY.md:4  - **Branch:** feat/pms-hardening-channex-certification
docs/audit/WORKFLOW_INVENTORY.md:22  - **Webhook receipt:** `POST /api/channel/webhook/[token]` — `/var/www/guesthub/src/app/api/channel/webhook/[t …
docs/audit/WORKFLOW_INVENTORY.md:86  - **Pacing/limits:** ~6.5s between requests (10/min/property Channex budget), ≤6 batches per kind per run.
docs/audit/WORKFLOW_INVENTORY.md:90  ## 12. Incremental ARI sync (dirty ranges → worker → Channex)
docs/payments/TOKENIZATION_AND_PCI_BOUNDARIES.md:28  | `provider` | cardcom / tranzila (migration 051 set the schema CHECK to `'cardcom'`/`'tranzila'`; **Stripe in …
docs/payments/TOKENIZATION_AND_PCI_BOUNDARIES.md:36  **Tokens are provider-specific:** a Cardcom token cannot be used by Tranzila and vice-versa — the model record …
docs/program/00_COMMON_CHARTER.md:12  4. Stage 4 — Channex Integration and Certification Readiness (`04_STAGE_4_CHANNEX_CERTIFICATION.md`)
docs/program/00_COMMON_CHARTER.md:46  * One integration branch for the whole program: `feat/pms-hardening-channex-certification`, created in Stage 1 …
docs/program/00_COMMON_CHARTER.md:95  | §4 Project guidance and Channex documentation | Stage 1 (initial capture, versioned requirements doc); refre …
docs/program/00_COMMON_CHARTER.md:102  | §11 Channex environment separation | Stage 4 |
docs/program/00_COMMON_CHARTER.md:106  | §15 Incremental ARI and Group Update | Canonical rate/inventory services, transactional dirty-range marking  …
docs/program/00_COMMON_CHARTER.md:114  | §23 Architecture documentation | Skeletons: Stage 1. Database docs: Stage 2. Domain docs: Stage 3. Channex d …
docs/program/00_COMMON_CHARTER.md:123  Check allocation (V2 §24): `check:db-isolation` → Stage 2. `check:pms-domain-invariants`, `check:reservation-c …
docs/program/01_STAGE_1_AUDIT_AND_ARCHITECTURE.md:15  3. Run the V2 §6 git procedure, create the integration branch `feat/pms-hardening-channex-certification`, and  …
docs/program/01_STAGE_1_AUDIT_AND_ARCHITECTURE.md:20  * §4 in full: read all project guidance files, deployment/PM2/environment configuration, every migration, and  …
docs/program/01_STAGE_1_AUDIT_AND_ARCHITECTURE.md:41  2. Channex versioned requirements document.
docs/program/03_STAGE_3_CORE_DOMAIN_INTEGRITY.md:7  Make the heart of the PMS correct, transaction-safe and canonical: reservations, inventory, pricing, payments, …
docs/program/03_STAGE_3_CORE_DOMAIN_INTEGRITY.md:17  * §15, foundation portion: every canonical operation affecting availability, rates or restrictions writes its  …
docs/program/07_STAGE_7_VERIFICATION_AND_DELIVERY.md:11  Charter entry gate (§5). Additionally: re-fetch the Channex documentation one final time and reconcile the ver …
docs/program/07_STAGE_7_VERIFICATION_AND_DELIVERY.md:15  * V2 Phase 15 in full: browser verification of every listed workflow, including RTL and Hebrew rendering, no c …
docs/program/07_STAGE_7_VERIFICATION_AND_DELIVERY.md:19  * §23, completion: every architecture, Channex, database, payments and security document current; every Mermai …
docs/program/07_STAGE_7_VERIFICATION_AND_DELIVERY.md:29  * The remaining-human-steps list must state plainly what only the user can do: review and merge the PR, submit …
docs/program/FINAL_REPORT.md:1  # GuestHub Hardening & Channex Certification — Final Report
docs/program/FINAL_REPORT.md:3  **Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification` · **Draft PR:** #92 (never merge …
docs/program/FINAL_REPORT.md:9  > **התוכנית בת 7 השלבים הושלמה — GuestHub מוקשח ומוכן להסמכת Channex (בכפוף להרצה חיה).**
docs/program/FINAL_REPORT.md:14  > - **שלב 4 — Channex:** ניתוב סביבה חסין-הצלבה; שומר הפעלת production (בנוי + כבוי); פנקס ראיות (Task IDs); F …
docs/program/FINAL_REPORT.md:19  > **בטיחות:** שום פעולה על production, על ה-DB המשותף (:5432 — קריאה בלבד), או על OTA חי. כל המיגרציות/בדיקות  …
docs/program/FINAL_REPORT.md:30  | 4 Channex Certification Readiness | `stage-4-complete` | PASS 7/7 |
docs/program/FINAL_REPORT.md:37  `docs/channex/CERTIFICATION_SCENARIO_MATRIX.md` — the 14 certification items, each mapped to its UI workflow + …
docs/program/FINAL_REPORT.md:56  Single integration branch `feat/pms-hardening-channex-certification` → draft PR #92 into `main` (never merged, …
docs/program/FINAL_REPORT.md:61  2. **Provision a Channex Staging channel / Booking.com test account**, then run the certification scenarios li …
docs/program/FINAL_REPORT.md:62  3. **Submit the official Channex certification form** with the captured Task IDs + the written declarations §1 …
docs/program/FINAL_REPORT.md:66  7. **Approve production Channex activation** (guard built + inactive; flip `CHANNEX_PRODUCTION_ACTIVATION` per …
docs/program/FINAL_REPORT.md:71  1. `git checkout feat/pms-hardening-channex-certification && pnpm install --frozen-lockfile && npx tsc --noEmi …
docs/program/FINAL_REPORT.md:79  No production activation; no live OTA/Channex production call; no shared-DB (:5432) writes (read-only througho …
docs/program/GUESTHUB_PROGRAM_V2.md:1  # GUESTHUB — COMPLETE PMS ARCHITECTURE, STABILITY, SECURITY, CHANNEX CERTIFICATION AND PRODUCTION-READINESS PR …
docs/program/GUESTHUB_PROGRAM_V2.md:17  This is not a request to add a few isolated Channex features.
docs/program/GUESTHUB_PROGRAM_V2.md:27  5. Ready to complete Channex PMS certification.
docs/program/GUESTHUB_PROGRAM_V2.md:28  6. Ready for a future controlled transition from Channex Staging to Production.
docs/program/GUESTHUB_PROGRAM_V2.md:123  ## Channex
docs/program/GUESTHUB_PROGRAM_V2.md:196  10. Alignment with official Channex requirements.
docs/program/GUESTHUB_PROGRAM_V2.md:202  2. Channex certification readiness through real PMS workflows.
docs/program/GUESTHUB_PROGRAM_V2.md:245  * Activate a real Channex Production connection.
docs/program/GUESTHUB_PROGRAM_V2.md:264  * use Postman or direct scripts as a substitute for a workflow that Channex requires to exist inside the PMS.
docs/program/GUESTHUB_PROGRAM_V2.md:274  * use Channex Staging.
docs/program/GUESTHUB_PROGRAM_V2.md:321  Read the current official Channex documentation, including:
docs/program/GUESTHUB_PROGRAM_V2.md:344  Fetch this documentation live at execution time. The certification test tables (dates, values, expected counts …
docs/program/GUESTHUB_PROGRAM_V2.md:413  This agent must inspect more than the Channex code.
docs/program/GUESTHUB_PROGRAM_V2.md:453  ## Agent D — Channex Certification Specialist
docs/program/GUESTHUB_PROGRAM_V2.md:470  For every scenario, identify the exact normal PMS UI action that triggers it and the exact file and function i …
docs/program/GUESTHUB_PROGRAM_V2.md:472  Independently verify the final result against current official Channex documentation.
docs/program/GUESTHUB_PROGRAM_V2.md:547  * Channex ARI.
docs/program/GUESTHUB_PROGRAM_V2.md:700  `feat/pms-hardening-channex-certification`
docs/program/GUESTHUB_PROGRAM_V2.md:950  * Channex Staging.
docs/program/GUESTHUB_PROGRAM_V2.md:1312  # 11. CHANNEX ENVIRONMENT SEPARATION
docs/program/GUESTHUB_PROGRAM_V2.md:1316  Every Channex operation must resolve:
docs/program/GUESTHUB_PROGRAM_V2.md:1318  `CHANNEX_BASE_URLS[connection.environment]`
docs/program/GUESTHUB_PROGRAM_V2.md:1339  `const CHANNEX_ENV = "staging"`
docs/program/GUESTHUB_PROGRAM_V2.md:1357  * `check:channex-environment-routing`
docs/program/GUESTHUB_PROGRAM_V2.md:1364  # 12. CHANNEX CERTIFICATION ENVIRONMENT
docs/program/GUESTHUB_PROGRAM_V2.md:1368  Channex certification is not a set of API calls to execute. It verifies that the real PMS product pushes corre …
docs/program/GUESTHUB_PROGRAM_V2.md:1373  * Never build a certification-only UI, endpoint, script or harness that triggers the scenario API calls direct …
docs/program/GUESTHUB_PROGRAM_V2.md:1374  * Browser automation may drive the real UI for pre-verification, because it exercises the true product code pa …
docs/program/GUESTHUB_PROGRAM_V2.md:1375  * The system must handle arbitrary values, not only the values in the official tables. During the screenshare  …
docs/program/GUESTHUB_PROGRAM_V2.md:1376  * You must be able to point to the exact file and function in the main codebase from which each Channex call f …
docs/program/GUESTHUB_PROGRAM_V2.md:1385  Create a certification property through GuestHub and Channex Staging:
docs/program/GUESTHUB_PROGRAM_V2.md:1413  * 2 Channex Room Types.
docs/program/GUESTHUB_PROGRAM_V2.md:1417  GuestHub uses one physical vacation-rental unit per Channex Room Type with inventory 1.
docs/program/GUESTHUB_PROGRAM_V2.md:1429  Channex rejects synthetic, uniform data. Before the certification Full Sync, the certification property must c …
docs/program/GUESTHUB_PROGRAM_V2.md:1435  * `scripts/provision-channex-certification.mjs`
docs/program/GUESTHUB_PROGRAM_V2.md:1508  * Channex Booking ID.
docs/program/GUESTHUB_PROGRAM_V2.md:1520  Add a `Channex Certification` area for `super_admin` only.
docs/program/GUESTHUB_PROGRAM_V2.md:1522  This area is strictly an evidence and monitoring console plus test-data administration. It must not contain an …
docs/program/GUESTHUB_PROGRAM_V2.md:1560  If it fits within Channex's current documented limit:
docs/program/GUESTHUB_PROGRAM_V2.md:1572  Operationally, Full Sync must never run on a timer as the synchronization strategy. Channex allows a full sync …
docs/program/GUESTHUB_PROGRAM_V2.md:1638  7. allow a certification scenario to produce one combined Channex request.
docs/program/GUESTHUB_PROGRAM_V2.md:1648  Implement the current official Channex rate-limit rules. At the time of writing the documented ARI budget is 2 …
docs/program/GUESTHUB_PROGRAM_V2.md:1760  * fetch canonical revision from Channex.
docs/program/GUESTHUB_PROGRAM_V2.md:1799  * a Stripe token cannot be used by Cardcom or Tranzila.
docs/program/GUESTHUB_PROGRAM_V2.md:1967  * Channex environment.
docs/program/GUESTHUB_PROGRAM_V2.md:2104  Create Channex documentation:
docs/program/GUESTHUB_PROGRAM_V2.md:2106  * `docs/channex/ARCHITECTURE.md`
docs/program/GUESTHUB_PROGRAM_V2.md:2107  * `docs/channex/PMS_CERTIFICATION_REQUIREMENTS.md`
docs/program/GUESTHUB_PROGRAM_V2.md:2108  * `docs/channex/CERTIFICATION_SCENARIO_MATRIX.md`
docs/program/GUESTHUB_PROGRAM_V2.md:2109  * `docs/channex/CERTIFICATION_RUNBOOK.md`
docs/program/GUESTHUB_PROGRAM_V2.md:2110  * `docs/channex/SCREENSHARE_DEMO_SCRIPT.md`
docs/program/GUESTHUB_PROGRAM_V2.md:2111  * `docs/channex/ARI_SYNC_FLOW.md`
docs/program/GUESTHUB_PROGRAM_V2.md:2112  * `docs/channex/BOOKING_REVISION_FLOW.md`
docs/program/GUESTHUB_PROGRAM_V2.md:2113  * `docs/channex/ENVIRONMENT_SEPARATION.md`
docs/program/GUESTHUB_PROGRAM_V2.md:2114  * `docs/channex/PRODUCTION_ACTIVATION_RUNBOOK.md`
docs/program/GUESTHUB_PROGRAM_V2.md:2115  * `docs/channex/FAILURE_AND_RECOVERY.md`
docs/program/GUESTHUB_PROGRAM_V2.md:2117  The screenshare demo script must list, for each certification scenario and for plausible ad-hoc requests, the  …
docs/program/GUESTHUB_PROGRAM_V2.md:2154  * `check:channex-environment-routing`
docs/program/GUESTHUB_PROGRAM_V2.md:2155  * `check:channex-certification`
docs/program/GUESTHUB_PROGRAM_V2.md:2156  * `check:channex-certification-evidence`
docs/program/GUESTHUB_PROGRAM_V2.md:2157  * `check:channex-full-sync-two-requests`
docs/program/GUESTHUB_PROGRAM_V2.md:2158  * `check:channex-group-update-batching`
docs/program/GUESTHUB_PROGRAM_V2.md:2159  * `check:channex-rate-limit-cooldown`
docs/program/GUESTHUB_PROGRAM_V2.md:2160  * `check:channex-booking-crs-flow`
docs/program/GUESTHUB_PROGRAM_V2.md:2266  * Channex 500.
docs/program/GUESTHUB_PROGRAM_V2.md:2267  * Channex 429.
docs/program/GUESTHUB_PROGRAM_V2.md:2368  ## Phase 6 — Channex environment routing
docs/program/GUESTHUB_PROGRAM_V2.md:2408  Verify actual rendered workflows, including RTL rendering. Execute a full screenshare rehearsal: perform each  …
docs/program/GUESTHUB_PROGRAM_V2.md:2460  ## Channex
docs/program/GUESTHUB_PROGRAM_V2.md:2528  * Ready for Channex certification request: yes/no.
docs/program/GUESTHUB_PROGRAM_V2.md:2591  ## Channex
docs/program/GUESTHUB_PROGRAM_V2.md:2614  * the file and function the Channex call fires from.
docs/program/GUESTHUB_PROGRAM_V2.md:2627  * Submitting the official Channex certification form with the Task IDs and declaration answers.
docs/program/GUESTHUB_PROGRAM_V2.md:2726  * a Channex certification screen share, including ad-hoc arbitrary changes requested live.
docs/program/README_HE.md:27  4. **Channex ו-certification** — הפרדת סביבות, ledger ראיות, Full Sync מדויק, Group Update, rate limits, הזמנו …
docs/program/README_HE.md:50  * למלא את טופס ה-certification הרשמי של Channex עם ה-Task IDs והתשובות המוכנות.
docs/program/README_HE.md:51  * לקבוע ולבצע את שיחת ה-screenshare החיה — לפי התסריט המוכן ב-`docs/channex/SCREENSHARE_DEMO_SCRIPT.md`.
docs/program/README_HE.md:56  בשום שלב: אין נגיעה ב-production ‏(DB, PM2, ערוצים חיים), אין merge ל-main, אין deploy, אין הפעלת Channex Prod …
docs/program/STATE.md:10  Channel providers were consolidated to **Beds24 only**. The Channex and Hospitable providers were removed enti …
docs/program/STATE.md:12  ### Post-program: Hospitable provider (D77, 2026-07-19)
docs/program/STATE.md:13  The Channex→Booking.com certification blocker (external Staging/Booking.com test-account provisioning, V2 §2)  …
docs/program/STATE.md:20  - **Verified:** `/login` 200 (renders), all central routes (incl. `/housekeeping` `/tasks` `/reports`) non-5xx …
docs/program/STATE.md:33  - ✅ **Post-completion fix (2026-07-18) — `check:channel-worker` residue flake:** the "two concurrent workers n …
docs/program/STATE.md:38  - **Environment-dependent (V2 §2), documented not blocking:** live screenshare rehearsal + `check:hydration-br …
docs/program/STATE.md:70  - ✅ Branch `feat/pms-hardening-channex-certification` current, clean tree.
docs/program/STATE.md:72  - ✅ Requirements refresh: Channex requirements snapshot still current (Stage 4). No external doc changes for S …
docs/program/STATE.md:100  ### Stage 4 — Channex Integration & Certification Readiness — ✅ COMPLETE (2026-07-18), tag `stage-4-complete`
docs/program/STATE.md:104  - **M1** env routing canonical — `config.channexBaseUrl` sole resolver; setup ops via `effectiveChannexEnviron …
docs/program/STATE.md:106  - **M2** evidence ledger (migration 038, staging :5434) + read-only console; H9/H10 fixed (incremental Task ID …
docs/program/STATE.md:107  - **M4** Full Sync 500d/2 requests + byte-bounded 10MB preflight (removed 1000-value cap). `check:channex-full …
docs/program/STATE.md:108  - **M5** Group Update single envelope + Min Stay declaration (`MIN_STAY_SEMANTICS.md`). `check:channex-group-u …
docs/program/STATE.md:109  - **M6** rate-limit cooldown (429 Retry-After) + circuit breaker (`circuit-breaker.ts`, migration 039). `check …
docs/program/STATE.md:110  - **M7** inbound security/chaos + booking-receiving cert flow. `check:channel-security`, `check:channel-chaos` …
docs/program/STATE.md:111  - **M3+M9** scenario matrix (14 tests, traceable), declarations 12-14, complete `SCREENSHARE_DEMO_SCRIPT.md`,  …
docs/program/STATE.md:112  - Fixed pre-existing stale assertions in `check:channex-ari` (46/46) and `check:channel-worker` (16/16).
docs/program/STATE.md:113  - **External dependency (V2 §2):** live scenario execution with real Task IDs needs an active Channex Staging  …
docs/program/STATE.md:118  - ✅ **M1 — environment routing canonical (CHX G6 complete)**: `config.channexBaseUrl(env)` is the SOLE base-UR …
docs/program/STATE.md:119  - ✅ **M8 — production activation guard (built + inactive)**: `production-guard.ts` — production only behind `C …
docs/program/STATE.md:120  - ✅ **M2 — evidence ledger (H9/H10) + read-only console (§13)**: migration **038** `channel_evidence_ledger` ( …
docs/program/STATE.md:121  - ✅ **M4 — Full Sync two-request semantics + 10MB size preflight (§14)**: batching is now byte-bounded to the  …
docs/program/STATE.md:123  - **M5** Group Update expansion + single-envelope batching (§15) + Min Stay Arrival/Through declaration + `che …
docs/program/STATE.md:124  - **M6** Rate-limit cooldown + circuit breaker (§16, M14) + fault tests + `check:channex-rate-limit-cooldown`.
docs/program/STATE.md:125  - **M7** Inbound hardening + ACK + booking-receiving cert flow (§17) + `check:channex-booking-crs-flow`, `chec …
docs/program/STATE.md:126  - **M3+M9** Certification property provisioned + scenario execution with Task IDs (**LIVE Channex Staging — ex …
docs/program/STATE.md:127  - **Note:** re-fetch official Channex docs at execution (Stage-1 capture in `docs/channex/PMS_CERTIFICATION_RE …
docs/program/STATE.md:141  - Sync-outbox seam is transactional (`markAriDirty` in canonical writes) per ADR-0004 — Channex wiring in Stag …
docs/program/STATE.md:167  - `docs/channex/PMS_CERTIFICATION_REQUIREMENTS.md` (live docs snapshot 2026-07-18).
docs/program/STATE.md:171  - V2 §23 document skeletons (architecture/channex/security).
docs/program/STATE.md:210  * Integration branch: `feat/pms-hardening-channex-certification` (from `origin/main` @ `b78650c`).
docs/program/reports/STAGE_1_REPORT.md:3  **Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification` · **Tag:** `stage-1-complete`
docs/program/reports/STAGE_1_REPORT.md:13  > המערכת "בנויה נכון" לצורך certification של Channex — יש זיהוי-שינוי, outbox, תור עמיד ו-batching, ואף אחד מה …
docs/program/reports/STAGE_1_REPORT.md:33  2. **Channex versioned requirements** — `docs/channex/PMS_CERTIFICATION_REQUIREMENTS.md`, fetched live 2026-07 …
docs/program/reports/STAGE_1_REPORT.md:34  3. **Audit inventories (10)** — `docs/audit/{ARCHITECTURE,DOMAIN,CODEBASE,RESERVATIONS_INVENTORY,PRICING,PAYME …
docs/program/reports/STAGE_1_REPORT.md:37  6. **Architecture/Channex/security document skeletons** — the V2 §23 set, current-state filled from the audit, …
docs/program/reports/STAGE_2_REPORT.md:3  **Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification` · **Tag:** `stage-2-complete` ·  …
docs/program/reports/STAGE_3_REPORT.md:3  **Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification` · **Tag:** `stage-3-complete` ·  …
docs/program/reports/STAGE_3_REPORT.md:55  ## Handoff to Stage 4 (Channex Integration & Certification Readiness)
docs/program/reports/STAGE_4_REPORT.md:1  # Stage 4 Report — Channex Integration & Certification Readiness
docs/program/reports/STAGE_4_REPORT.md:3  **Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification` · **Tag:** `stage-4-complete` ·  …
docs/program/reports/STAGE_4_REPORT.md:7  Reproduced every claim from source: (1) crossover impossibility — `CHANNEX_BASE_URLS` read only in config.ts;  …
docs/program/reports/STAGE_4_REPORT.md:11  > **תקציר מנהלים — שלב 4 הושלם (אינטגרציית Channex ומוכנות להסמכה).**
docs/program/reports/STAGE_4_REPORT.md:13  > הפכנו את אינטגרציית Channex למוכנה-להסמכה כתוצר לוואי של זרימות עבודה אמיתיות ב-PMS:
docs/program/reports/STAGE_4_REPORT.md:14  > - **ניתוב סביבה קנוני (M1):** כל קריאת HTTP ל-Channex גוזרת את כתובת הבסיס ממקור אחד בלבד (`channexBaseUrl`) …
docs/program/reports/STAGE_4_REPORT.md:23  > חסם חיצוני יחיד (V2 §2): הרצת התרחישים החיה מול Channex Staging עם Task IDs אמיתיים דורשת חיבור Staging פעיל …
docs/program/reports/STAGE_4_REPORT.md:27  1. **M1 — environment routing canonical (§11, CHX G6 closed).** `config.channexBaseUrl(env)` is the sole base- …
docs/program/reports/STAGE_4_REPORT.md:28  2. **M8 — production activation guard (§26, built + inactive).** `production-guard.ts`: staging by default, pr …
docs/program/reports/STAGE_4_REPORT.md:29  3. **M2 — evidence ledger (§13, H9/H10) + read-only console.** migration 038 `channel_evidence_ledger` (append …
docs/program/reports/STAGE_4_REPORT.md:30  4. **M4 — Full Sync two-request + 10MB preflight (§14).** byte-bounded batching (removed the artificial 1000-v …
docs/program/reports/STAGE_4_REPORT.md:31  5. **M5 — Group Update single envelope + Min Stay (§15).** verified the outbox emits one dirty envelope (plan  …
docs/program/reports/STAGE_4_REPORT.md:32  6. **M6 — rate-limit cooldown + circuit breaker (§16, M14).** `circuit-breaker.ts` (pure), 429 Retry-After ext …
docs/program/reports/STAGE_4_REPORT.md:33  7. **M7 — inbound security/chaos + booking-receiving cert flow (§17).** `check:channel-security`, `check:chann …
docs/program/reports/STAGE_4_REPORT.md:34  8. **M3+M9 — certification artifacts (§12/§23).** scenario matrix (14 tests, traceable, G1/G3 closed), declara …
docs/program/reports/STAGE_4_REPORT.md:38  `check:channex-environment-routing`, `check:production-activation-guard`, `check:channex-certification-evidenc …
docs/program/reports/STAGE_4_REPORT.md:40  Also fixed 3 pre-existing stale assertions in `check:channex-ari` (was fully red at HEAD) and 2 in `check:chan …
docs/program/reports/STAGE_4_REPORT.md:47  | Every executable scenario has evidence structure (UI workflow, firing file+function, request counts, Task-ID …
docs/program/reports/STAGE_4_REPORT.md:50  | Documentation matches code | ✅ 12 `docs/channex/` docs incl. complete demo script + declarations |
docs/program/reports/STAGE_4_REPORT.md:57  Live scenario execution against Channex Staging (real Task IDs for tests 1–11) and the live booking-receiving  …
docs/program/reports/STAGE_4_REPORT.md:61  Production not activated (guard inactive, verified); no live OTA touched; no real Channex production call; mig …
docs/program/reports/STAGE_5_REPORT.md:3  **Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification` · **Tag:** `stage-5-complete` ·  …
docs/program/reports/STAGE_5_REPORT.md:38  New: housekeeping, maintenance-closures, reports, israel-market. Extended: guest-communications-automation (gu …
docs/program/reports/STAGE_5_REPORT.md:58  No production/shared-DB writes; migrations 040/041/042 applied only to the dedicated staging DB (:5434); no li …
docs/program/reports/STAGE_6_REPORT.md:3  **Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification` · **Tag:** `stage-6-complete` ·  …
docs/program/reports/STAGE_7_REPORT.md:3  **Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification` · **Tag:** `stage-7-complete` ·  …
docs/program/reports/STAGE_7_REPORT.md:9  > אימות סופי בלתי-תלוי (Agent N) הריץ מחדש הכל מהקוד וה-DB — לא הסתמך על אף אישור קודם: תגיות, אי-קיום נתיב st …
docs/program/reports/STAGE_7_REPORT.md:16  | 2 | No hardcoded staging path (CHANNEX_BASE_URLS only in config.ts) | PASS |
docs/program/reports/STAGE_7_REPORT.md:48  Live Channex Staging certification-scenario execution with real Task IDs; the live screenshare rehearsal; `che …
docs/program/reports/STAGE_7_REPORT.md:52  All 7 stages delivered on `feat/pms-hardening-channex-certification` (draft PR #92), each independently Agent- …
docs/security/OBSERVABILITY.md:3  - **Status:** Complete — Stage 6 · **Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certificatio …
docs/security/PERFORMANCE.md:3  - **Status:** Complete — Stage 6 · **Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certificatio …
docs/security/SECRET_HANDLING.md:3  - **Status:** Complete — Stage 6 · **Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certificatio …
docs/security/SECURITY_TEST_REPORT.md:3  - **Status:** Complete — Stage 6 · **Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certificatio …
docs/security/SECURITY_TEST_REPORT.md:35  - **Rate-limit / provider failure:** 429 Retry-After cooldown + circuit breaker (`check:channex-rate-limit-coo …
docs/security/SECURITY_TEST_REPORT.md:43  | GREEN-API webhook token stored in provider config (messaging) | Medium | Plaintext token, asymmetric with th …
docs/security/THREAT_MODEL.md:4  - **Branch:** `feat/pms-hardening-channex-certification`
```

### 4.2 root `*.md` + `claude/*.md` (66, post-rename)

```
DECISIONS.md:326  # Phase 3 — Occupancy Calendar + Channex-ready foundation
DECISIONS.md:362  ## D35 — Channex foundation: structural, tenant-scoped, and OFF
DECISIONS.md:373  `createChannelProvider` yields Disabled unless `CHANNEX_ENABLED=true` AND an active connection,
DECISIONS.md:385  ## D37 — Rates schema unchanged; Channex fields derived in the payload builder
DECISIONS.md:386  guesthub.rates already carries price/min_nights/max_nights/closed/CTA/CTD. Channex-only
DECISIONS.md:555  UI/Channex NOT touched: manual reservations keep resolveStayPrice snapshots; future
DECISIONS.md:613  Public booking engine and Channex NOT started.
DECISIONS.md:633  ## D64 — Channex inventory unit = the PHYSICAL ROOM (not the room category)
DECISIONS.md:635  The old `/channels` metric "מיפוי סוגי חדרים 0/3" implied the three GuestHub room categories (סטודיו / סוויטה  …
DECISIONS.md:637  **Model:** one active physical room → one Channex Room Type → `count_of_rooms = 1`. `count_of_rooms` is the nu …
DECISIONS.md:639  **Canonical mapping:** new table `guesthub.channel_room_mappings` (migration 024). `channel_room_type_mappings …
DECISIONS.md:641  **Occupancy (evidence, not assumption):** Channex `occ_children` = "Child only bed spaces … Children can sleep …
DECISIONS.md:642  `occ_adults = max_adults` · `occ_children = clamp(max_occupancy − max_adults, 0, max_children)` · `occ_infants …
DECISIONS.md:646  **Safety:** creation happens in exactly ONE call site, inside an explicitly confirmed operator action. Channex …
DECISIONS.md:648  **Postal code:** `postal_code` is canonical on the Business Profile only (there is no Channex-only postal fiel …
DECISIONS.md:650  ## D65 — one local Rate Plan × mapped physical rooms → Channex Rate Plans (structure only, born unsellable)
DECISIONS.md:652  The local GuestHub Rate Plan (tenant-scoped `pricing_plans` row, `sellable_unit_id IS NULL`) is defined ONCE a …
DECISIONS.md:654  **Canonical mapping:** new table `guesthub.channel_room_rate_mappings` (migration 025). The 005 `channel_rate_ …
DECISIONS.md:656  **Title:** exactly `חדר <room_number> - <local plan name>` (255-symbol limit validated). Channex requires titl …
DECISIONS.md:660  **children_fee / infant_fee are NOT mapped:** GuestHub charges extra_child/extra_infant only for guests BEYOND …
DECISIONS.md:662  **Born unsellable:** every plan is created with `rate_mode: manual`, ALL occupancy option rates 0 (a placehold …
DECISIONS.md:664  **Durability (same construction as D64, hardened):** the parent run mutex (advisory lock + durable deduplicate …
DECISIONS.md:666  **Minimal UI (explicit scope correction):** one compact card on `/channels` — plan count + names, mapped rooms …
DECISIONS.md:668  ## D68 — the existing Bulk Update / Rate Plans workflows drive Channex ARI (no new operator surface)
DECISIONS.md:670  **Scope correction discovered in the audit.** The Phase-3 ARI machinery keyed every dirty range, watermark and …
DECISIONS.md:672  **Canonical reuse, not reimplementation.** `ari-projection.ts` owns no pricing, availability or restriction ru …
DECISIONS.md:676  **Hooks.** `writeRateCells` (the ONE path the Rate Grid and Bulk Update share) marks rates+restrictions per ro …
DECISIONS.md:678  **Withdrawal is a publication.** A plan that is archived, deactivated or hidden from channels is still project …
DECISIONS.md:680  **Fail closed (§6).** A (room, plan, date) whose price cannot be resolved is never guessed, never zero, never  …
DECISIONS.md:682  **The 200-with-warnings trap.** Channex answers a partially-rejected ARI update with HTTP 200 and a populated  …
DECISIONS.md:688  **Not built (deliberately):** no ARI editor, simulator, preview grid, second calendar, wizard, per-room/per-pl …
DECISIONS.md:690  **Also fixed:** `check:channel-card-ingest` ran against **production** (`:5432`, no fail-closed guard) and had …
DECISIONS.md:692  ## D69 — real, persisted progress for the existing Channex Full Sync
DECISIONS.md:710  **Proven source: (B) browser / password-manager autofill.** Evidence: `Java2026` occurs in **zero** tracked or …
DECISIONS.md:712  **The stored key was never overwritten.** It decrypts to a 64-character value that is not `Java2026`; `api_key …
DECISIONS.md:715  1. **The replacement input no longer exists in the DOM until the operator clicks "החלפת מפתח API".** Password  …
DECISIONS.md:716  2. `autocomplete="new-password"` on the input (managers offer to generate, they do not fill), a unique non-gen …
DECISIONS.md:718  4. **Verify before persist:** `saveChannexApiKeyAction` authenticates the candidate against Channex (one `GET  …
DECISIONS.md:723  `testChannexConnectionAction()` takes **zero parameters** by construction, so the replacement input, unsaved R …
DECISIONS.md:727  ## D76 — Channex inbound booking import: feed → revision → canonical reservation
DECISIONS.md:731  **Identity.** One reservation per (channel_connection_id, external_booking_id) — a partial unique index (migra …
DECISIONS.md:733  **Revision behavior.** NEW creates the one canonical reservation + reservation_rooms (channel price is authori …
DECISIONS.md:737  **Operator surface.** /channels gained one compact inbound card: enabled state, webhook registration, last imp …
DECISIONS.md:745  The 7-stage hardening program (branch `feat/pms-hardening-channex-certification`, draft PR #92) established th …
DECISIONS.md:747  **Sources of truth (ADR-0001).** One resolver per concern: pricing via `calculateReservationPrice`; availabili …
DECISIONS.md:749  **Safety boundaries (V2 §3).** Dev/prod share the shared supabase-db (:5432) — it is READ-ONLY for this progra …
DECISIONS.md:753  **Channex (Stage 4).** Environment routing is crossover-proof (one resolver); production is guarded off by `CH …
DECISIONS.md:769  ## D77 — Hospitable as second channel provider (dispatch-by-provider, no interface)
DECISIONS.md:771  **Why.** Booking.com certification via Channex stalled on external staging provisioning (STATE.md). The operat …
DECISIONS.md:773  **No provider interface — deliberately.** Consistent with D68 (the dead `ChannelManagerProvider` factory was d …
DECISIONS.md:775  **Model mapping.** Hospitable has no room-type/rate-plan axes: one physical room (sellable unit) ↔ one Hospita …
DECISIONS.md:777  **Inbound without a feed.** Hospitable exposes reservation GETs + UI-registered webhooks — no revision feed, n …
DECISIONS.md:779  **Production-only + PAT expiry.** Hospitable has no sandbox — `environment='production'` is the only value for …
DECISIONS.md:841  ## D91 — ערוץ הפצה יחיד: Beds24. הסרת Channex ו-Stripe במלואם
DECISIONS.md:843  **החלטת בעלים (2026-07-24).** Beds24 הוא מנהל הערוצים היחיד — חי בפרודקשן, קולט הזמנות מ-Booking.com ב-polling …
DECISIONS.md:845  **מה נעשה (בענף `chore/remove-channex-stripe`, worktree מבודד, אפס נגיעה בפרודקשן הרץ):**
DECISIONS.md:846  1. **השבתה קודם כול (שלב A):** שני ה-UPDATE-ים הממוקדים העבירו את חיבורי `channex` (staging) ו-`hospitable` (p …
DECISIONS.md:847  2. **`channex-http.ts → channel-http.ts`** — שכבת ה-HTTP הגנרית שכל מודולי Beds24 מייבאים ממנה. שינוי-שם בלבד  …
DECISIONS.md:848  3. **worker Beds24-בלבד:** `booking-import.ts` צומצם לליבת הייבוא המשותפת (RoomResolver חובה); `booking-normal …
DECISIONS.md:849  4. **UI:** `/channels` מציג את קונסולת Beds24 בלבד + כרטיס שינויי-ה-OTA (ניטרלי) + בריאות התור. כל סקשן Channe …
DECISIONS.md:850  5. **Stripe:** `payments-admin.ts` (זרימת "Stripe Tokenization" של Channex, D77 §E) נמחק — היה מת (אפס מייבאים …
DECISIONS.md:851  6. **דיווח OTA בביטול הזמנה:** `reporting-admin`/`reporting-rules` (כפתורי דיווח כרטיס-לא-תקין/no-show ל-Booki …
DECISIONS.md:852  7. **סקריפטים:** 18 גרדיאני `check-channex-*`/אינטגרציית-Channex נמחקו; 17 גרדיאנים גנריים עודכנו ל-Beds24.
DECISIONS.md:854  **מה נשאר במכוון (לא ניתן להסרה ללא מיגרציה — אסורה בטווח):** שמות עמודות ה-DB ההיסטוריים `channel_room_mappin …
claude/MOBILE_AUDIT.md:31  | **/channels** | `channels/page.tsx` + 10 sections (`ChannexRoomTypesSection.tsx` וכו') | settings‑sections + …
claude/MOBILE_AUDIT.md:64  **/channels** — טבלאות אבחון עם `min-width` קבוע ב‑`overflow-x-auto`: `ChannexRoomTypesSection.tsx:381-382` `m …
```

> The two lines this branch cleared of the dead brand (`STATE.md:7`, `PROJECT_OVERVIEW.md:218`) no longer appear above; they are documented in §7.1 with their before/after text. `docs/BEDS24_COMPLETION_PLAN.md:68` was also corrected but still legitimately names Channex, so it still appears in §4.1.
>
> `DECISIONS.md` accounts for **64** of these 66 lines. It was **not touched** — see §7.3.

## 5. DB migrations on disk — full occurrence list (160 lines)

`db/migrations/*.sql` + `db/migrations/manifest.txt`. **Nothing in this category was edited.** These are applied, replayable migrations: the file names are keys in `manifest.txt` and in the replay chain that every DB-backed `check:*` script re-runs from zero. Renaming a file or rewriting a migration body would break the chain and rewrite history that D91 explicitly preserves.

Per-file totals:

| File | Lines |
|---|---|
| `054_external_column_rename.sql` | 24 |
| `025_channex_rate_plan_mappings.sql` | 17 |
| `023_channex_property_mapping.sql` | 16 |
| `024_channex_room_type_mappings.sql` | 14 |
| `005_phase3_channel_foundation.sql` | 12 |
| `032_inbound_rate_plan_aliases.sql` | 10 |
| `027_channex_ari_room_dimension.sql` | 6 |
| `044_hospitable_provider.sql` | 6 |
| `manifest.txt` | 5 |
| `009_phase4a_sellable_units.sql` | 3 |
| `029_inbound_booking_identity.sql` | 3 |
| `038_channel_evidence_ledger.sql` | 3 |
| `011_commercial_settings.sql` | 2 |
| `022_channex_connection_test.sql` | 2 |
| `026_sellable_unit_lifecycle.sql` | 2 |
| `051_psp_readiness.sql` | 2 |
| `028_canonical_room_identity.sql` | 1 |
| `033_expected_arrival_time.sql` | 1 |
| `035_channel_external_changes.sql` | 1 |
| `039_channel_circuit_breaker.sql` | 1 |
| `045_beds24_provider.sql` | 1 |

```
db/migrations/005_phase3_channel_foundation.sql:2  --  005 · Phase 3 — channel-manager (Channex-ready) foundation
db/migrations/005_phase3_channel_foundation.sql:19  provider              text NOT NULL DEFAULT 'channex' CHECK (provider IN ('channex')),
db/migrations/005_phase3_channel_foundation.sql:23  channex_property_id   text,
db/migrations/005_phase3_channel_foundation.sql:47  channex_room_type_id text,
db/migrations/005_phase3_channel_foundation.sql:57  CREATE UNIQUE INDEX IF NOT EXISTS uq_crtm_channex_id
db/migrations/005_phase3_channel_foundation.sql:58  ON guesthub.channel_room_type_mappings (connection_id, channex_room_type_id)
db/migrations/005_phase3_channel_foundation.sql:59  WHERE channex_room_type_id IS NOT NULL;
db/migrations/005_phase3_channel_foundation.sql:70  channex_rate_plan_id text,
db/migrations/005_phase3_channel_foundation.sql:81  CREATE UNIQUE INDEX IF NOT EXISTS uq_crpm_channex_id
db/migrations/005_phase3_channel_foundation.sql:82  ON guesthub.channel_rate_plan_mappings (connection_id, channex_rate_plan_id)
db/migrations/005_phase3_channel_foundation.sql:83  WHERE channex_rate_plan_id IS NOT NULL;
db/migrations/005_phase3_channel_foundation.sql:263  -- THE single projection both the future Channex adapter and diagnostics
db/migrations/009_phase4a_sellable_units.sql:3  --  Additive + idempotent. NO Channex contact, NO worker, NO network. The
db/migrations/009_phase4a_sellable_units.sql:6  --  Introduces the Sellable Unit layer between physical rooms and Channex room
db/migrations/009_phase4a_sellable_units.sql:48  -- Channex-room-type binding for the existing mappings/outbox/room_type_inventory
db/migrations/011_commercial_settings.sql:4  --  Rate-Plan / Booking-Engine / Channex phases will consume. NO rooms rebuild,
db/migrations/011_commercial_settings.sql:5  --  NO rate plans, NO Channex, NO network — the local canonical model only.
db/migrations/022_channex_connection_test.sql:2  --  022 · Channex Staging — connection-test result columns
db/migrations/022_channex_connection_test.sql:11  --      < db/migrations/022_channex_connection_test.sql
db/migrations/023_channex_property_mapping.sql:2  --  023 · Channex Staging — property mapping (existing tenant → one Channex Property)
db/migrations/023_channex_property_mapping.sql:5  --  holding channex_property_id). This IS the canonical mapping — NO parallel
db/migrations/023_channex_property_mapping.sql:15  --  NO Channex property/room-type/rate-plan/channel/webhook/ARI/booking is
db/migrations/023_channex_property_mapping.sql:21  --      < db/migrations/023_channex_property_mapping.sql
db/migrations/023_channex_property_mapping.sql:25  -- external Channex property title (display only; never a credential)
db/migrations/023_channex_property_mapping.sql:26  ADD COLUMN IF NOT EXISTS channex_property_title      text,
db/migrations/023_channex_property_mapping.sql:27  -- how the mapping was established: the operator created a fresh Channex
db/migrations/023_channex_property_mapping.sql:29  ADD COLUMN IF NOT EXISTS channex_property_method      text,
db/migrations/023_channex_property_mapping.sql:33  ADD COLUMN IF NOT EXISTS channex_property_snapshot    jsonb,
db/migrations/023_channex_property_mapping.sql:34  -- last time the mapping was verified against Channex (GET succeeded)
db/migrations/023_channex_property_mapping.sql:35  ADD COLUMN IF NOT EXISTS channex_property_verified_at timestamptz,
db/migrations/023_channex_property_mapping.sql:38  ADD COLUMN IF NOT EXISTS channex_reconcile_state      text;
db/migrations/023_channex_property_mapping.sql:44  CHECK (channex_property_method IS NULL
db/migrations/023_channex_property_mapping.sql:45  OR channex_property_method IN ('created','adopted'));
db/migrations/023_channex_property_mapping.sql:51  CHECK (channex_reconcile_state IS NULL
db/migrations/023_channex_property_mapping.sql:52  OR channex_reconcile_state IN ('ok','inaccessible'));
db/migrations/024_channex_room_type_mappings.sql:2  --  024 · Channex Staging — PHYSICAL ROOM → Channex Room Type mapping
db/migrations/024_channex_room_type_mappings.sql:14  --    for the chosen inventory unit: ONE physical room ⇄ ONE Channex Room Type.
db/migrations/024_channex_room_type_mappings.sql:17  --  NOT the Channex inventory mapping unit and are neither created, modified nor
db/migrations/024_channex_room_type_mappings.sql:23  --  external Channex Room Type UUID per local physical room.
db/migrations/024_channex_room_type_mappings.sql:25  --  NO Channex entity is created by this migration. NO GuestHub room, room type,
db/migrations/024_channex_room_type_mappings.sql:30  --      < db/migrations/024_channex_room_type_mappings.sql
db/migrations/024_channex_room_type_mappings.sql:39  -- ---- 1. canonical physical-room → Channex Room Type mapping ----
db/migrations/024_channex_room_type_mappings.sql:46  channex_property_id  text NOT NULL,
db/migrations/024_channex_room_type_mappings.sql:54  channex_room_type_id text,
db/migrations/024_channex_room_type_mappings.sql:55  channex_title        text,
db/migrations/024_channex_room_type_mappings.sql:85  -- one external Channex Room Type UUID may map to only ONE local physical room
db/migrations/024_channex_room_type_mappings.sql:86  CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_channex_room_type
db/migrations/024_channex_room_type_mappings.sql:87  ON guesthub.channel_room_mappings (connection_id, channex_room_type_id)
db/migrations/024_channex_room_type_mappings.sql:88  WHERE channex_room_type_id IS NOT NULL;
db/migrations/025_channex_rate_plan_mappings.sql:2  --  025 · Channex Staging — (PHYSICAL ROOM × LOCAL RATE PLAN) → Channex Rate Plan
db/migrations/025_channex_rate_plan_mappings.sql:7  --  Channex Rate Plan belongs to exactly one Channex Room Type, and D64 fixed the
db/migrations/025_channex_rate_plan_mappings.sql:10  --      1 local Rate Plan × 13 mapped rooms = 13 Channex Rate Plans.
db/migrations/025_channex_rate_plan_mappings.sql:18  --    real mapping unit: (physical room, local rate plan) ⇄ one Channex Rate Plan.
db/migrations/025_channex_rate_plan_mappings.sql:23  --  external Channex Rate Plan UUID per ONE local combination.
db/migrations/025_channex_rate_plan_mappings.sql:25  --  NO Channex entity is created by this migration. NO GuestHub room, rate plan,
db/migrations/025_channex_rate_plan_mappings.sql:30  --      < db/migrations/025_channex_rate_plan_mappings.sql
db/migrations/025_channex_rate_plan_mappings.sql:39  -- ---- 1. canonical (room × local rate plan) → Channex Rate Plan mapping ----
db/migrations/025_channex_rate_plan_mappings.sql:46  channex_property_id     text NOT NULL,
db/migrations/025_channex_rate_plan_mappings.sql:50  -- the D64 room mapping this rate plan hangs off (its Channex Room Type)
db/migrations/025_channex_rate_plan_mappings.sql:54  channex_room_type_id    text,
db/migrations/025_channex_rate_plan_mappings.sql:56  channex_rate_plan_id    text,
db/migrations/025_channex_rate_plan_mappings.sql:57  channex_title           text,
db/migrations/025_channex_rate_plan_mappings.sql:88  -- one external Channex Rate Plan UUID may map to only ONE local combination
db/migrations/025_channex_rate_plan_mappings.sql:89  CREATE UNIQUE INDEX IF NOT EXISTS uq_crrm_channex_rate_plan
db/migrations/025_channex_rate_plan_mappings.sql:90  ON guesthub.channel_room_rate_mappings (connection_id, channex_rate_plan_id)
db/migrations/025_channex_rate_plan_mappings.sql:91  WHERE channex_rate_plan_id IS NOT NULL;
db/migrations/026_sellable_unit_lifecycle.sql:24  --       participates and the plan×room Channex mappings that already exist;
db/migrations/026_sellable_unit_lifecycle.sql:31  --  that bypass the app. No Channex table is touched; no network is involved.
db/migrations/027_channex_ari_room_dimension.sql:2  --  027 · Channex ARI — re-key the dirty-range outbox to the REAL mapping unit
db/migrations/027_channex_ari_room_dimension.sql:7  --  categories. D64 fixed the Channex inventory unit as the individual PHYSICAL
db/migrations/027_channex_ari_room_dimension.sql:8  --  ROOM (13 rooms ⇄ 13 Channex Room Types, count_of_rooms=1) and D65 fixed the
db/migrations/027_channex_ari_room_dimension.sql:9  --  commercial unit as (physical room × local Rate Plan) ⇄ one Channex Rate Plan
db/migrations/027_channex_ari_room_dimension.sql:29  --  NO Channex entity is created, updated or contacted. NO room, rate plan,
db/migrations/027_channex_ari_room_dimension.sql:34  --      < db/migrations/027_channex_ari_room_dimension.sql
db/migrations/028_canonical_room_identity.sql:32  --  No Channex table is touched; no pricing_plan_rates row is touched; no
db/migrations/029_inbound_booking_identity.sql:2  --  029 · Channex inbound bookings — external reservation identity (D76)
db/migrations/029_inbound_booking_identity.sql:12  --  the Channex booking UUID, scoped by connection (an OTA code alone is NOT
db/migrations/029_inbound_booking_identity.sql:40  -- the Channex booking UUID — the ONE stable identity of the OTA booking
db/migrations/030_workflow_statuses_payment_methods.sql:112  provider       text NOT NULL CHECK (provider IN ('stripe')),
db/migrations/032_inbound_rate_plan_aliases.sql:4  -- WHY: bookings arrive from a channel (Booking.com via Channex) carrying the
db/migrations/032_inbound_rate_plan_aliases.sql:5  -- rate_plan UUID the OWNER mapped in the Channex UI. That mapping can point at
db/migrations/032_inbound_rate_plan_aliases.sql:12  -- live, UUID-verified Channex lookup (property + room type chain). One
db/migrations/032_inbound_rate_plan_aliases.sql:24  channex_rate_plan_id text NOT NULL,
db/migrations/032_inbound_rate_plan_aliases.sql:30  channex_property_id text NOT NULL,
db/migrations/032_inbound_rate_plan_aliases.sql:31  channex_room_type_id text NOT NULL,
db/migrations/032_inbound_rate_plan_aliases.sql:32  channex_title text,
db/migrations/032_inbound_rate_plan_aliases.sql:33  source text NOT NULL DEFAULT 'channex_verified'
db/migrations/032_inbound_rate_plan_aliases.sql:34  CHECK (source IN ('channex_verified')),
db/migrations/032_inbound_rate_plan_aliases.sql:38  CONSTRAINT uq_inbound_rp_alias UNIQUE (connection_id, channex_rate_plan_id)
db/migrations/033_expected_arrival_time.sql:4  -- WHY: Channex booking revisions supply `arrival_hour` ("13:00"). Until now it
db/migrations/035_channel_external_changes.sql:4  -- WHY: an inbound OTA revision (Booking.com via Channex) can MOVE the stay
db/migrations/038_channel_evidence_ledger.sql:2  --  GuestHub · Stage 4 — Channex certification evidence ledger (defects H9, H10).
db/migrations/038_channel_evidence_ledger.sql:4  --  Until now, Channex Task IDs were recorded ONLY for the initial Full Sync
db/migrations/038_channel_evidence_ledger.sql:7  --  The Channex PMS certification requires, for every executed scenario, durable
db/migrations/039_channel_circuit_breaker.sql:2  --  GuestHub · Stage 4 — Channex outbound circuit-breaker state (§16, defect M14).
db/migrations/044_hospitable_provider.sql:2  --  044 · Hospitable provider — second channel provider alongside Channex
db/migrations/044_hospitable_provider.sql:5  --  1. Widens channel_connections.provider CHECK to allow 'hospitable'.
db/migrations/044_hospitable_provider.sql:6  --     Hospitable has NO staging environment — hospitable rows are always
db/migrations/044_hospitable_provider.sql:9  --     and Channex still uses staging).
db/migrations/044_hospitable_provider.sql:10  --  2. api_key_expires_at — Hospitable PATs are JWTs that expire after one
db/migrations/044_hospitable_provider.sql:12  --     operator ≥30 days before expiry. NULL for Channex rows (their keys
db/migrations/044_hospitable_provider.sql:14  --  3. channel_hospitable_property_mappings — Hospitable has no room-type/
db/migrations/044_hospitable_provider.sql:15  --     rate-plan axes: one GuestHub physical room maps to one Hospitable
db/migrations/044_hospitable_provider.sql:17  --     base-occupancy rate is the pushed price. channex_property_id on the
db/migrations/044_hospitable_provider.sql:18  --     connection stays NULL for hospitable rows.
db/migrations/044_hospitable_provider.sql:20  --  Inbound reuses channel_booking_revisions unchanged: Hospitable has no
db/migrations/044_hospitable_provider.sql:27  --      < db/migrations/044_hospitable_provider.sql
db/migrations/044_hospitable_provider.sql:35  CHECK (provider IN ('channex','hospitable'));
db/migrations/044_hospitable_provider.sql:41  -- 3 · room ↔ Hospitable property mapping
db/migrations/044_hospitable_provider.sql:42  CREATE TABLE IF NOT EXISTS guesthub.channel_hospitable_property_mappings (
db/migrations/044_hospitable_provider.sql:47  -- Hospitable property UUID (external id; never a credential)
db/migrations/044_hospitable_provider.sql:48  hospitable_property_id  text        NOT NULL,
db/migrations/044_hospitable_provider.sql:53  -- Hospitable flag: calendar pushes are rejected upstream while true
db/migrations/044_hospitable_provider.sql:60  UNIQUE (connection_id, hospitable_property_id)
db/migrations/044_hospitable_provider.sql:63  CREATE INDEX IF NOT EXISTS idx_hospitable_property_mappings_tenant
db/migrations/044_hospitable_provider.sql:64  ON guesthub.channel_hospitable_property_mappings (tenant_id);
db/migrations/044_hospitable_provider.sql:67  -- refreshed on every re-map) — lets the mapping table read like the Channex
db/migrations/044_hospitable_provider.sql:69  ALTER TABLE guesthub.channel_hospitable_property_mappings
db/migrations/044_hospitable_provider.sql:70  ADD COLUMN IF NOT EXISTS hospitable_property_name text;
db/migrations/044_hospitable_provider.sql:75  ON guesthub.channel_hospitable_property_mappings TO guesthub_app;
db/migrations/044_hospitable_provider.sql:76  GRANT ALL ON guesthub.channel_hospitable_property_mappings TO service_role;
db/migrations/045_beds24_provider.sql:3  --  Additive + idempotent. Mirrors 044 (Hospitable).
db/migrations/045_beds24_provider.sql:13  --  doctrine as Hospitable, D77).
db/migrations/045_beds24_provider.sql:25  CHECK (provider IN ('channex','hospitable','beds24'));
db/migrations/051_psp_readiness.sql:5  --  Owner decision (Ronen): NO Stripe. The table was born with a
db/migrations/051_psp_readiness.sql:6  --  CHECK (provider IN ('stripe')) for the dormant Channex-Stripe tokenization
db/migrations/051_psp_readiness.sql:7  --  experiment (030); the table is empty, so 'stripe' is dropped outright —
db/migrations/051_psp_readiness.sql:8  --  the legacy Channex tokenization admin flow will now be rejected by the DB,
db/migrations/051_psp_readiness.sql:22  --      CHECK (provider IN ('stripe'));
db/migrations/051_psp_readiness.sql:29  -- ---- 1. providers: stripe-only → cardcom / tranzila ----
db/migrations/054_external_column_rename.sql:2  --  GuestHub · D91 closure — rename the legacy channex_* columns to the
db/migrations/054_external_column_rename.sql:6  --  Channex was removed as a provider (D91, deployed 2026-07-24); Beds24 lives on
db/migrations/054_external_column_rename.sql:8  --  channex_* column (verified: zero matches in src/, zero pg functions/views/
db/migrations/054_external_column_rename.sql:18  --  ADD COLUMN IF NOT EXISTS blocks would re-create stray channex_* columns
db/migrations/054_external_column_rename.sql:33  ('channel_connections',              'channex_property_id',          'external_property_id'),
db/migrations/054_external_column_rename.sql:34  ('channel_connections',              'channex_property_method',      'external_property_method'),
db/migrations/054_external_column_rename.sql:35  ('channel_connections',              'channex_property_snapshot',    'external_property_snapshot'),
db/migrations/054_external_column_rename.sql:36  ('channel_connections',              'channex_property_title',       'external_property_title'),
db/migrations/054_external_column_rename.sql:37  ('channel_connections',              'channex_property_verified_at', 'external_property_verified_at'),
db/migrations/054_external_column_rename.sql:38  ('channel_connections',              'channex_reconcile_state',      'external_reconcile_state'),
db/migrations/054_external_column_rename.sql:39  ('channel_inbound_rate_plan_aliases','channex_property_id',          'external_property_id'),
db/migrations/054_external_column_rename.sql:40  ('channel_inbound_rate_plan_aliases','channex_rate_plan_id',         'external_rate_plan_id'),
db/migrations/054_external_column_rename.sql:41  ('channel_inbound_rate_plan_aliases','channex_room_type_id',         'external_room_type_id'),
db/migrations/054_external_column_rename.sql:42  ('channel_inbound_rate_plan_aliases','channex_title',                'external_title'),
db/migrations/054_external_column_rename.sql:43  ('channel_rate_plan_mappings',       'channex_rate_plan_id',         'external_rate_plan_id'),
db/migrations/054_external_column_rename.sql:44  ('channel_room_mappings',            'channex_property_id',          'external_property_id'),
db/migrations/054_external_column_rename.sql:45  ('channel_room_mappings',            'channex_room_type_id',         'external_room_type_id'),
db/migrations/054_external_column_rename.sql:46  ('channel_room_mappings',            'channex_title',                'external_title'),
db/migrations/054_external_column_rename.sql:47  ('channel_room_rate_mappings',       'channex_property_id',          'external_property_id'),
db/migrations/054_external_column_rename.sql:48  ('channel_room_rate_mappings',       'channex_rate_plan_id',         'external_rate_plan_id'),
db/migrations/054_external_column_rename.sql:49  ('channel_room_rate_mappings',       'channex_room_type_id',         'external_room_type_id'),
db/migrations/054_external_column_rename.sql:50  ('channel_room_rate_mappings',       'channex_title',                'external_title'),
db/migrations/054_external_column_rename.sql:51  ('channel_room_type_mappings',       'channex_room_type_id',         'external_room_type_id')
db/migrations/054_external_column_rename.sql:64  -- instead of silently skipping, so the D91 "0 channex columns"
db/migrations/manifest.txt:30  022_channex_connection_test.sql
db/migrations/manifest.txt:31  023_channex_property_mapping.sql
db/migrations/manifest.txt:32  024_channex_room_type_mappings.sql
db/migrations/manifest.txt:33  025_channex_rate_plan_mappings.sql
db/migrations/manifest.txt:35  027_channex_ari_room_dimension.sql
db/migrations/manifest.txt:52  044_hospitable_provider.sql
```

## 6. Live catalog — production **and** staging

Both were queried. Production (`postgres` @ `localhost:5432`, container `supabase-pooler`/`supabase-db`) was queried **strictly read-only** — every session ran with `PGOPTIONS='-c default_transaction_read_only=on'`, and only `SELECT`s were issued. Staging is `guesthub_staging` @ `127.0.0.1:5434` (container `guesthub-staging-db`, PostgreSQL 15.8). Endpoint identity was confirmed with `select current_database(), inet_server_addr(), inet_server_port()` — they are genuinely different databases; staging is a pre-D91 clone, so its **catalog** is identical to production while its **data** is older.

### 6.1 Index names — `uq_*_channex_*` and friends

Query: `SELECT schemaname, tablename, indexname FROM pg_indexes WHERE schemaname='guesthub' AND (indexname ILIKE '%channex%' OR '%hospitable%' OR '%stripe%')`

**Identical on production and staging — 8 rows:**

```
 schemaname |              tablename               |                            indexname
------------+--------------------------------------+-----------------------------------------------------------------
 guesthub   | channel_hospitable_property_mappings | channel_hospitable_property_m_connection_id_hospitable_prop_key
 guesthub   | channel_hospitable_property_mappings | channel_hospitable_property_mappings_connection_id_room_id_key
 guesthub   | channel_hospitable_property_mappings | channel_hospitable_property_mappings_pkey
 guesthub   | channel_hospitable_property_mappings | idx_hospitable_property_mappings_tenant
 guesthub   | channel_rate_plan_mappings           | uq_crpm_channex_id
 guesthub   | channel_room_mappings                | uq_crm_channex_room_type
 guesthub   | channel_room_rate_mappings           | uq_crrm_channex_rate_plan
 guesthub   | channel_room_type_mappings           | uq_crtm_channex_id
(8 rows)
```

The four `uq_*_channex_*` indexes come from migrations 005 (`uq_crtm_channex_id`, `uq_crpm_channex_id`), 024 (`uq_crm_channex_room_type`) and 025 (`uq_crrm_channex_rate_plan`). Migration 054 renamed the *columns* they index (`channex_*` → `external_*`) but PostgreSQL keeps the index **name** across a column rename, so the names survived.

### 6.2 Constraint names

Query: `pg_constraint` joined to `pg_namespace`, `nspname='guesthub'`, name `ILIKE` any of the three brands.

**Identical on production and staging — 8 rows, ALL on the dead `channel_hospitable_property_mappings` table:**

```
 channel_hospitable_property_m_connection_id_hospitable_prop_key  u  UNIQUE (connection_id, hospitable_property_id)
 channel_hospitable_property_mappings_connection_id_fkey          f  FOREIGN KEY (connection_id) REFERENCES guesthub.channel_connections(id) ON DELETE CASCADE
 channel_hospitable_property_mappings_connection_id_room_id_key   u  UNIQUE (connection_id, room_id)
 channel_hospitable_property_mappings_local_rate_plan_id_fkey     f  FOREIGN KEY (local_rate_plan_id) REFERENCES guesthub.pricing_plans(id)
 channel_hospitable_property_mappings_pkey                        p  PRIMARY KEY (id)
 channel_hospitable_property_mappings_room_id_fkey                f  FOREIGN KEY (room_id) REFERENCES guesthub.rooms(id)
 channel_hospitable_property_mappings_status_check                c  CHECK ((status = ANY (ARRAY['mapped','unmapped','quarantined'])))
 channel_hospitable_property_mappings_tenant_id_fkey              f  FOREIGN KEY (tenant_id) REFERENCES guesthub.tenants(id)
(8 rows)
```

**No constraint anywhere in schema `guesthub` has `channex` or `stripe` in its NAME.**

### 6.3 Constraint *definitions* mentioning a removed brand

```
 guesthub.channel_connections               | channel_connections_provider_check             | CHECK ((provider = ANY (ARRAY['channex'::text, 'hospitable'::text, 'beds24'::text])))
 guesthub.channel_inbound_rate_plan_aliases | channel_inbound_rate_plan_aliases_source_check | CHECK ((source = 'channex_verified'::text))
 guesthub.channel_hospitable_property_mappings | channel_hospitable_property_m_connection_id_hospitable_prop_key | UNIQUE (connection_id, hospitable_property_id)
(3 rows — identical on production and staging)
```

### 6.4 The `chk_*` constraints introduced by migration 023 — **already clean, no action needed**

Migration 023 named them `channel_connections_property_method_chk` and `channel_connections_reconcile_state_chk` (suffix `_chk`, not prefix `chk_`). Their **names never contained `channex`**, and their **definitions were auto-rewritten by migration 054's `ALTER TABLE … RENAME COLUMN`** (PostgreSQL rewrites dependent CHECK expressions on a column rename). Live state on both databases:

```
 channel_connections_property_method_chk | CHECK (((external_property_method IS NULL) OR (external_property_method = ANY (ARRAY['created','adopted']))))
 channel_connections_reconcile_state_chk | CHECK (((external_reconcile_state IS NULL) OR (external_reconcile_state = ANY (ARRAY['ok','inaccessible']))))
```

**Finding: migration 023's constraints carry zero Channex trace and are deliberately excluded from the proposed 057 rename.** Same for `channel_room_mappings_external_state_check`, `channel_room_rate_mappings_external_state_check` and `uq_inbound_rp_alias` (`UNIQUE (connection_id, external_rate_plan_id)`) — all already `external_*`.

### 6.5 Columns and tables

```
-- columns still named *channex*/*hospitable*/*stripe* (both DBs)
 channel_hospitable_property_mappings | hospitable_property_id   | text
 channel_hospitable_property_mappings | hospitable_property_name | text
(2 rows)

-- tables (both DBs)
 channel_hospitable_property_mappings | BASE TABLE
(1 row)
```

**Zero `channex_*` columns remain** — migration 054 closed that completely. The only column-level residue is the two Hospitable columns on a table that holds **0 rows on production and 0 rows on staging**.

Also verified: **0** pg functions and **0** views in schema `guesthub` mention any of the three brands.

### 6.6 `channel_inbound_rate_plan_aliases.source`

```
-- PRODUCTION
      source      | rows            total_rows
------------------+------          ------------
 channex_verified |   10                    10

-- STAGING (identical)
      source      | rows            total_rows
------------------+------          ------------
 channex_verified |   10                    10
```

**Exactly one distinct value: `channex_verified`. 10 rows. 100% of the table.** All 10 belong to connection `5e6dba4e-339e-4ab8-bfb0-d37d96b6d8a8` — the paused Channex connection. The value is pinned by `CHECK (source = 'channex_verified')`, so changing it requires dropping/recreating the CHECK **and** an `UPDATE` of live rows.

### 6.7 Suspended `channel_connections` and their now-inert date ranges

**PRODUCTION — all 3 connection rows** (`state`, not `status`, is the column; no secrets printed):

```
                  id                  |  provider  | environment | state  | is_active_provider | has_ext_prop_id | reconcile | last_inbound_import_at        | updated_at
--------------------------------------+------------+-------------+--------+--------------------+-----------------+-----------+-------------------------------+-----------------------------
 8365fdc8-b8b6-4db3-9ca7-62db2f1d18e8 | beds24     | production  | active | t                  | f               |           | 2026-07-24 20:32:40.124209+00 | 2026-07-25 10:10:06.646783+00
 5e6dba4e-339e-4ab8-bfb0-d37d96b6d8a8 | channex    | staging     | paused | f                  | t               | ok        | 2026-07-17 19:22:17.137618+00 | 2026-07-24 13:51:57.619208+00
 23fca9ea-2667-4a77-8a75-a3918da6c1b0 | hospitable | production  | paused | f                  | f               |           | (never)                       | 2026-07-24 13:51:57.693528+00
(3 rows)   -- all one tenant: 68139d06-58c4-4043-b256-4691f83e1556
```

Both suspended rows have `outbound_sync_enabled=false`, `is_active_provider=false`. The hospitable row also has `inbound_sync_enabled=false`; the **channex row still has `inbound_sync_enabled=true`** (inert only because `state='paused'`).

**Now-inert date ranges attached to the suspended channex connection — `guesthub.channel_dirty_ranges` (PRODUCTION):**

```
 provider | state  |     kind     | status  | rows |  min_from  |   max_to   |          last_updated
----------+--------+--------------+---------+------+------------+------------+-------------------------------
 beds24   | active | availability | synced  |   97 | 2026-06-22 | 2027-12-06 | 2026-07-25 10:10:06.644501+00
 beds24   | active | rates        | synced  |  222 | 2026-07-20 | 2027-05-01 | 2026-07-25 09:41:00.979825+00
 beds24   | active | restrictions | synced  |  222 | 2026-07-20 | 2027-05-01 | 2026-07-25 09:41:00.979825+00
 channex  | paused | availability | pending |   34 | 2026-06-22 | 2027-12-06 | 2026-07-24 08:52:12.379699+00
 channex  | paused | rates        | pending |   16 | 2026-07-20 | 2027-05-01 | 2026-07-24 06:45:39.006287+00
 channex  | paused | restrictions | pending |   16 | 2026-07-20 | 2027-05-01 | 2026-07-24 06:45:39.006287+00
(6 rows)
```

**66 `pending` ranges (34 + 16 + 16), all carrying a `room_id`, spanning 2026-06-22 … 2027-12-06, frozen since 2026-07-24.** They can never drain — their connection is paused. They are the only non-`synced` ranges in the whole table. See §0.1 for why they are visible on /rates today.

The hospitable connection has **0** dirty ranges. `channel_inventory_holds` is empty for every connection.

**Other rows hanging off the suspended connections (PRODUCTION):**

```
 channel_room_mappings             | channex | paused | 13   (all status='mapped', all with room_id)
 channel_room_rate_mappings        | channex | paused | 52
 channel_inbound_rate_plan_aliases | channex | paused | 10
 channel_beds24_room_mappings      | beds24  | active | 14   ← the live ones
```

`channel_rate_plan_mappings` and `channel_room_type_mappings` are **0 rows** — so `uq_crpm_channex_id` and `uq_crtm_channex_id` guard empty tables. `channel_hospitable_property_mappings` is **0 rows**.

**STAGING** is a pre-D91 snapshot: one connection row (`channex` / `staging` / `state='active'`, `is_active_provider=false`), 537 dirty ranges (5 `pending` + 532 `synced`, 2026-07-10 … 2030-09-10), 13 `channel_room_mappings`, 52 `channel_room_rate_mappings`, 10 `channel_inbound_rate_plan_aliases`, and **0** rows in both `channel_beds24_room_mappings` and `channel_hospitable_property_mappings`. Its **catalog is byte-identical to production** for every query in §6.1–§6.5.

---

## 7. What was actually done on this branch

### 7.1 Renames applied (documentation only — 2 lines)

Both are **live, current-state documents** that asserted something false after D91. Both are pure text renames with no behaviour attached.

**1 · `STATE.md:7`** — the root "what is frozen / what is the current priority" document.

```diff
-**מיקוד בלעדי בהסמכת Channex.** כל עבודה שאינה קשורה ישירות להסמכה
+**מיקוד בלעדי באינטגרציית Beds24.** כל עבודה שאינה קשורה ישירות לאינטגרציה
 (ARI, מיפוי, סנכרון, מגבלות לילות) — בהמתנה.
```

The Channex certification program is dead (D91); Beds24 is the only channel manager, and `docs/BEDS24_COMPLETION_PLAN.md` is the live backlog. The stated scope (ARI, mapping, sync, night limits) is unchanged — only the provider name.

**2 · `PROJECT_OVERVIEW.md:218`** — §15 "future integrations".

```diff
-לא בונים עכשיו — רק שומרים מבנה נקי: Channel Manager / Channex, WhatsApp, SMS, …
+לא בונים עכשיו — רק שומרים מבנה נקי: Channel Manager (Beds24 — מומש מאז, D91), WhatsApp, SMS, …
```

A bare `Channel Manager / Channex` in a "not building now" list is doubly wrong: Channex is deleted **and** the Channel Manager shipped. The parenthetical states only verifiable facts (Beds24 shipped, D91) without rewriting the spec section — restructuring §15 is a content change, not a rename, so it is flagged below rather than done.

**3 · `docs/BEDS24_COMPLETION_PLAN.md:68`** — the live backlog row P4-2, which is the register entry for pending item **P-1** below. It named a migration number that is already taken and asserted a rename that §6.4 disproves.

```diff
-| P4-2 | **055 candidate**: rename channex-named indexes/constraints (`uq_*_channex_*`, 023's `chk_*`) and the `channel_inbound_rate_plan_aliases.source` value `'channex_verified'` | …
+| P4-2 | **057 candidate** (055 → `night/p2-2-booking-com-reports`, 056 → `night/reservation-source-system`): rename the channex-named indexes (`uq_crtm_channex_id`, `uq_crpm_channex_id`, `uq_crm_channex_room_type`, `uq_crrm_channex_rate_plan`) and the `channel_inbound_rate_plan_aliases.source` value `'channex_verified'`. 023's `*_chk` constraints need **no** rename — 054 already rewrote their definitions to `external_*` and their names never held `channex` (verified in the live catalog, `docs/CHANNEX_ZERO_TRACE.md` §6.4) | …
```

Every claim added is verified in this document: the migration numbers by `git ls-tree -r --name-only <branch> -- db/migrations/` on both night branches (`055_booking_com_channel_reports.sql`, `056_source_system.sql`), the four index names by `pg_indexes` (§6.1), the 023 constraint state by `pg_constraint` (§6.4). The Why / Effort / Risk columns are untouched.

**Nothing else was renamed. `src/` needed no rename (already 0 occurrences), and no code file was modified on this branch.**

### 7.2 Deliberately NOT renamed — and why

| What | Lines | Why it stays |
|---|---|---|
| `db/migrations/*.sql` + `manifest.txt` | 160 | Applied, immutable, replayable history. File names are keys in `manifest.txt`; every DB-backed `check:*` replays the chain from zero. Editing them rewrites history and breaks replay. D91 states this explicitly. |
| `docs/program/**` (74 + 31 + 13 + reports…) , `docs/audit/**` | ~205 | Dated deliverables of the `feat/pms-hardening-channex-certification` program (Stage 1–7 reports, audit matrices). They record a **past** state. D91 §"מה נשאר במכוון": historical audit/program/certification reports are preserved as historical record, like migrations. |
| `**Branch:** feat/pms-hardening-channex-certification` header in 13 `docs/architecture/*.md` + `docs/security/*.md` | 13 | Provenance metadata naming a **real branch that still exists** (`git branch -a --list '*pms-hardening*'` → local + `remotes/origin/…`). Renaming it would point provenance at a branch that never existed. |
| `docs/CHANNEL_LAYER_INVENTORY.md` (8) | 8 | This is the **live** channel-layer inventory and its Channex mentions are *the documentation of this very residue* (lines 6, 35, 75–83, 88). Correct as written. |
| `docs/BEDS24_COMPLETION_PLAN.md:67` | 1 | Live backlog row **P4-1** — the register entry for pending item P-3. Removing the word would erase the backlog entry. (Row **P4-2** on line 68 *was* corrected — see §7.1 item 3.) |
| `docs/payments/TOKENIZATION_AND_PCI_BOUNDARIES.md:28,36` · `docs/architecture/TARGET_ARCHITECTURE.md:65` | 3 | Correct current-state statements ("Stripe intentionally excluded — D91"). The brand name is the *point* of the sentence. |
| `docs/security/SECURITY_TEST_REPORT.md:35,43` | 2 | Dated (2026-07-18) Stage-6 report. `check:channex-rate-limit-cooldown` no longer exists; the report documents what was true then. |
| `claude/MOBILE_AUDIT.md:31,64` | 2 | Dated (2026-07-19) READ-ONLY audit referencing `ChannexRoomTypesSection.tsx` / `ChannexPropertySection.tsx`, deleted by D91. **Stale by deletion, not renameable** — there is no Beds24 file with those line numbers, so any rename would fabricate a citation. Flagged: the /channels rows of that audit need re-auditing against the current Beds24 console. |
| `scripts/check-beds24-jobs.mjs:43` | 1 | Load-bearing historical comment explaining the D91 cutover timestamp the filter uses. |

### 7.3 `DECISIONS.md` — not touched (iron rule 6)

`DECISIONS.md` holds **64 of the 66** root-markdown occurrences (D35, D37, D64, D65, D68, D69, D76, D77, D91 …). It was **not modified**, for two independent reasons:

1. **Iron rule 6.** `DECISIONS.md` is on the file list of `fix/beds24-checkin-cancellation-guard` (PR #112), which is awaiting merge. Touching it risks a conflict.
2. It is by definition an append-only historical decision log. D91's own text is the record of the removal; renaming Channex out of D35/D64/D65 would make the log unreadable.

This creates a conflict with the "if you get stuck, append to DECISIONS.md" protocol. **Iron rule 6 wins** — every blocker and pending item is recorded in this document instead. Nothing was appended to `DECISIONS.md`.

---

## 8. PENDING — requires Ronen's approval. Not executed.

### P-1 · Catalog rename migration (would be `057_*`) — **rename only, no data, no semantics**

**Scope:** exactly 4 index renames. Migration numbers 055 and 056 are taken by night branches, so the next free number is **057**. No migration file was created on disk — this is a proposal only, so no number is consumed.

**Why not executed:** DDL against the production catalog is outside "renames in code and documentation only", it consumes a migration number, and it must be applied through the canonical deploy path.

**Note:** migration 023's `*_chk` constraints are **excluded on purpose** — §6.4 proves they are already provider-neutral.

```sql
-- ============================================================
--  057 · D91 zero-trace — rename the last channex-named indexes
--  Rename ONLY. No column, no data, no constraint semantics, no
--  behaviour. Migration 054 already renamed every channex_* COLUMN
--  to external_*; PostgreSQL keeps index NAMES across a column
--  rename, which is why these four survived.
--
--  NOT in scope (deliberate):
--   · channel_connections_property_method_chk / _reconcile_state_chk
--     (023) — their definitions were auto-rewritten to external_* by
--     054 and their names never held 'channex'. Verified in catalog.
--   · channel_inbound_rate_plan_aliases.source = 'channex_verified'
--     — that is DATA SEMANTICS, not a rename. See P-2.
--   · channel_connections rows / channel_dirty_ranges rows — see P-3.
--   · channel_hospitable_property_mappings — see P-4 (a DROP).
--
--  Idempotent: ALTER INDEX IF EXISTS is a no-op when already renamed.
--  Zero rows are read or written. Takes a brief ACCESS EXCLUSIVE lock
--  on each index's table (catalog-only, no rewrite, sub-millisecond).
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/057_channex_index_rename.sql
-- ============================================================

ALTER INDEX IF EXISTS guesthub.uq_crtm_channex_id
  RENAME TO uq_crtm_external_id;              -- 005 · channel_room_type_mappings (0 rows)

ALTER INDEX IF EXISTS guesthub.uq_crpm_channex_id
  RENAME TO uq_crpm_external_id;              -- 005 · channel_rate_plan_mappings (0 rows)

ALTER INDEX IF EXISTS guesthub.uq_crm_channex_room_type
  RENAME TO uq_crm_external_room_type;        -- 024 · channel_room_mappings (13 rows)

ALTER INDEX IF EXISTS guesthub.uq_crrm_channex_rate_plan
  RENAME TO uq_crrm_external_rate_plan;       -- 025 · channel_room_rate_mappings (52 rows)

-- Verification (expect 0 rows):
--   SELECT indexname FROM pg_indexes
--   WHERE schemaname='guesthub' AND indexname ILIKE '%channex%';
```

### P-2 · `'channex_verified'` → a provider-neutral value — **data semantics, NOT a rename**

**Scope:** `guesthub.channel_inbound_rate_plan_aliases.source` — 10 rows on production, 10 on staging, one distinct value, pinned by `CHECK (source = 'channex_verified')`.

**Why not executed:** the instruction excludes it explicitly, and it is genuinely not a rename — the string is a **provenance claim** ("this alias was verified against Channex's live property→room-type→rate-plan chain", migration 032). Rewriting it to `external_verified` asserts that the same verification holds for Beds24, which is false: the 10 rows were verified against a Channex property, and their connection is paused. Options — (a) keep the honest historical value, (b) widen the CHECK and add `beds24_verified` for future rows without touching the 10 legacy rows, (c) rewrite all 10. Only (a) and (b) preserve truth. **Recommended: (b), or do nothing until Beds24 actually writes an alias.**

```sql
-- ============================================================
--  057b · PROPOSAL ONLY — channel_inbound_rate_plan_aliases.source
--  DATA SEMANTICS CHANGE. Requires Ronen's explicit approval.
--  Presented in the two truth-preserving variants.
-- ============================================================

-- Variant (b) — RECOMMENDED: widen the CHECK, keep the 10 legacy rows
-- honest. New Beds24-sourced aliases can then be written truthfully.
ALTER TABLE guesthub.channel_inbound_rate_plan_aliases
  DROP CONSTRAINT IF EXISTS channel_inbound_rate_plan_aliases_source_check;
ALTER TABLE guesthub.channel_inbound_rate_plan_aliases
  ADD  CONSTRAINT channel_inbound_rate_plan_aliases_source_check
  CHECK (source IN ('channex_verified', 'beds24_verified'));

-- Variant (c) — FULL REWRITE. Erases the provenance of the 10 rows.
-- Do NOT run without a decision that the provenance is expendable.
--   ALTER TABLE guesthub.channel_inbound_rate_plan_aliases
--     DROP CONSTRAINT IF EXISTS channel_inbound_rate_plan_aliases_source_check;
--   UPDATE guesthub.channel_inbound_rate_plan_aliases
--     SET source = 'external_verified' WHERE source = 'channex_verified';  -- 10 rows
--   ALTER TABLE guesthub.channel_inbound_rate_plan_aliases
--     ADD  CONSTRAINT channel_inbound_rate_plan_aliases_source_check
--     CHECK (source IN ('external_verified'));
```

### P-3 · Deleting the suspended `channel_connections` rows and their inert ranges — **forbidden by iron rule 8**

**Scope if ever approved:** 2 `channel_connections` rows (`5e6dba4e…` channex/staging/paused, `23fca9ea…` hospitable/production/paused) plus everything cascading off them — 66 `channel_dirty_ranges`, 13 `channel_room_mappings`, 52 `channel_room_rate_mappings`, 10 `channel_inbound_rate_plan_aliases`. **141 rows total.**

**Why not executed:** iron rule 8 — *NEVER DELETE DB rows* — forbids it outright, with no exception and no approval path available to this agent. `docs/BEDS24_COMPLETION_PLAN.md:67` already carries it as backlog item **P4-1** ("needs a small migration (data delete) — deliberate, separately approved"). No SQL is proposed here.

**Coupled to it:** tightening `channel_connections_provider_check` from `('channex','hospitable','beds24')` to `('beds24')` **cannot** be done while those two rows exist — the constraint would fail validation. It is blocked behind P-3, not independently schedulable.

### P-4 · Dropping the dead `channel_hospitable_property_mappings` table — **destructive DDL**

**Scope:** 1 table, **0 rows on production, 0 rows on staging**, created by migration 044, carrying the only remaining `*_property_*` columns named after a removed provider (`hospitable_property_id`, `hospitable_property_name`) plus 4 indexes and 6 named constraints — i.e. **11 of the 16 catalog objects** found in §6.1/§6.2. Zero references in `src/` (`git grep` → 0).

**Why not executed:** a `DROP TABLE` is destructive DDL, not a rename. It is also not covered by any of the three explicitly-listed pending items, so it is surfaced here as a fourth. Renaming it instead would be pointless — the table has no meaning without Hospitable.

```sql
-- ============================================================
--  057c · PROPOSAL ONLY — drop the dead Hospitable mapping table.
--  DESTRUCTIVE DDL. Requires Ronen's explicit approval.
--  Verified empty on production AND staging before proposing:
--    SELECT count(*) FROM guesthub.channel_hospitable_property_mappings; -- 0 / 0
--  Verified unreferenced: git grep 'channel_hospitable_property_mappings' -- src/ → 0
--  Removes 1 table, 2 hospitable_* columns, 4 indexes, 6 named constraints.
--  Gate the drop on emptiness so it can never destroy data.
-- ============================================================
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM guesthub.channel_hospitable_property_mappings;
  IF n <> 0 THEN
    RAISE EXCEPTION 'refusing to drop channel_hospitable_property_mappings: % row(s) present', n;
  END IF;
  DROP TABLE guesthub.channel_hospitable_property_mappings;
END $$;
```

### P-5 · `/rates` grid reads the dead Channex mappings — **behaviour change, out of rename scope**

**Scope:** `src/lib/rates/grid-state.ts:178-201`. The three queries are tenant-scoped; they must be **connection-scoped to the active connection**, and the mapping table must be the provider's own (`channel_beds24_room_mappings` for Beds24), otherwise the grid keeps sourcing "mapped" from 13 dead Channex rows and renders 66 permanently-`pending` ranges. Evidence and reasoning in §0.1.

**Why not executed:** this is a behaviour fix, and the EXECUTE mandate for this branch is *rename only, zero behaviour change*. It also overlaps the channel/inventory area that `fix/beds24-checkin-cancellation-guard` (PR #112) is working in. Needs its own branch after #112 merges.

**Note:** P-3 (deleting the rows) would mask P-5's symptom without fixing the query. P-5 should be fixed on its own merits regardless of P-3.

### P-6 · Dry-run validation of P-1 / P-2(b) / P-4 — **already done, on staging, rolled back**

The three SQL proposals above were executed **on staging inside a single transaction and rolled back**, so their syntax and their post-conditions are proven rather than asserted, and staging was left byte-identical to how it was found. Production was never involved.

```
BEGIN
ALTER INDEX  (×4)
--- after P-1 rename, indexes still matching %channex% (expect 0) ---
 channex_indexes_left
----------------------
                    0

 indexname
----------------------------------
 uq_crm_external_room_type
 uq_crpm_external_id
 uq_crrm_external_rate_plan
 uq_crtm_external_id
 …(and the 4 pre-existing external_* indexes)

--- P-2 variant (b): widen the source CHECK ---
 CHECK ((source = ANY (ARRAY['channex_verified'::text, 'beds24_verified'::text])))

--- P-4: gated drop of the dead hospitable table ---
DO
 should_be_null
----------------
                       ← to_regclass() returned NULL: the table was dropped

--- ROLLING BACK: staging is left exactly as found ---
ROLLBACK
--- post-rollback verification: everything is back ---
 channex_indexes                                   → 4
 table_restored        guesthub.channel_hospitable_property_mappings
 source_check_restored CHECK ((source = 'channex_verified'::text))
```

**Result: after P-1, `SELECT count(*) FROM pg_indexes WHERE schemaname='guesthub' AND indexname ILIKE '%channex%'` returns 0 — that is the whole of "zero-trace" in the catalog, four `ALTER INDEX` statements.** The gated `DROP` in P-4 fires cleanly against an empty table and would have raised an exception against a non-empty one.

---

## 9. Verification — printed output

Cold run (`rm -rf .next` first) in `/var/www/wt-channex` on the **committed** `stab/channex-zero-trace` tree, after all three documentation rewrites.

```
> guesthub@0.1.0 typecheck /var/www/wt-channex
> tsc --noEmit

=== TYPECHECK EXIT: 0 ===
```

```
✖ 31 problems (0 errors, 31 warnings)

=== LINT EXIT: 0 ===
```

All 31 are pre-existing warnings (`no-unused-expressions` in `scripts/check-*.mjs`, `no-unused-vars` in `scripts/db/migrate.mjs` and `src/lib/channel/booking-import.ts`) — **0 errors**, none introduced by this branch, none suppressed or weakened.

```
├ ƒ /channels                                 7.59 kB         201 kB
├ ƒ /rates                                    14.1 kB         208 kB
…
+ First Load JS shared by all                  151 kB
ƒ Middleware                                  93.5 kB

> guesthub@0.1.0 postbuild /var/www/wt-channex
> tsc -p tsconfig.worker.json

=== BUILD EXIT: 0 ===
```

**typecheck 0 · lint 0 · build 0.** No assertion was weakened; no check was disabled.

---

## 10. Safety attestation

* Production runtime `/var/www/guesthub` was **never** used as a working tree. All work happened in the throwaway worktree `/var/www/wt-channex` on `stab/channex-zero-trace`.
* Production DB access was **read-only** — every psql session ran with `PGOPTIONS='-c default_transaction_read_only=on'` and issued `SELECT` only. Zero writes, zero DDL, zero row deletions on production.
* The only DDL executed anywhere was the P-6 dry run, **on staging, inside `BEGIN … ROLLBACK`**, verified afterwards to have left staging byte-identical (4 channex indexes back, table back, original CHECK back). No row was inserted, updated or deleted on any database.
* No deploy, no `PROD_DEPLOY_OK`, no `pm2 restart` of anything. No merge to and no push to `main`.
* No secret value was printed, logged or written — only variable **names** (`DATABASE_URL`, `STAGING_DATABASE_URL`, `CARD_VAULT_KEY`, `CHANNEL_SECRETS_KEY`, …) and non-secret host/port/database identifiers. No card data, no Beds24 token, no scope was read or touched. `.env*` files were sourced into a subshell and never emitted.
* No file belonging to `fix/beds24-checkin-cancellation-guard` (PR #112) was modified — in particular `DECISIONS.md` and `package.json` are untouched. `git status --porcelain` showed no foreign modification on any file staged by this branch.
* No migration number was consumed. `055`/`056` are held by night branches; the proposals above are quoted SQL inside this document, not files on disk.
