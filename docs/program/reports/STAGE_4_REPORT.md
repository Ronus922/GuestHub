# Stage 4 Report — Channex Integration & Certification Readiness

**Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification` · **Tag:** `stage-4-complete` · **Independent verifier (Agent N):** PASS 7/7 (no must-fix items)

## Agent N independent verdict — PASS 7/7

Reproduced every claim from source: (1) crossover impossibility — `CHANNEX_BASE_URLS` read only in config.ts; the only host literals elsewhere are comments; setup ops via `effectiveChannexEnvironment()`, runtime via `conn.environment`. (2) guard — staging by default, `upsertChannelConnectionAction` gates production creation, no committed env activates it, no path reaches production without the flag. (3) evidence ledger — `recordAriEvidence` sole writer, append-only, both full-sync AND incremental record; incremental Task IDs captured (H9/H10); console triggers nothing. (4) byte-bounded 10MB batching, no value-count cap. (5) breaker gates the drain + persists transitions; Retry-After extracted+propagated. (6) all 10 checks + `tsc` PASS. (7) migrations 038/039 on staging :5434 only — shared prod DB (:5432) confirmed untouched (ledger table + columns ABSENT there); no secrets committed; production not activated. **No must-fix items.**

## Executive summary (Hebrew)

> **תקציר מנהלים — שלב 4 הושלם (אינטגרציית Channex ומוכנות להסמכה).**
>
> הפכנו את אינטגרציית Channex למוכנה-להסמכה כתוצר לוואי של זרימות עבודה אמיתיות ב-PMS:
> - **ניתוב סביבה קנוני (M1):** כל קריאת HTTP ל-Channex גוזרת את כתובת הבסיס ממקור אחד בלבד (`channexBaseUrl`). אי-אפשר יותר להצליב staging/production בטעות — נבדק סטטית.
> - **שומר הפעלת production (M8):** production כבוי כברירת מחדל ובלתי-נגיש ללא דגל מפורש; בנוי, נבדק ולא-פעיל. יצירת חיבור production חסומה בשער.
> - **פנקס ראיות + קונסולת הסמכה לקריאה בלבד (M2):** כל תרחיש הסמכה נרשם עם Task IDs, ספירת בקשות מול הצפי, וקובץ+פונקציה שהפעילו את הקריאה. **תוקן H9/H10** — Task IDs של סנכרון מצטבר לא נזרקים יותר.
> - **Full Sync = בדיוק 500 ימים בשתי בקשות + בדיקת גודל 10MB אמיתית (M4).**
> - **עדכון קבוצתי = מעטפת סנכרון אחת, בקשה משולבת אחת; Min Stay Arrival/Through הוכרעו והוצהרו (M5).**
> - **חוסן מול הגבלות קצב: cooldown לפי Retry-After + circuit breaker עם כל רשימת בדיקות התקלות (M6).**
> - **הזמנות נכנסות מוקשחות + ACK רק אחרי commit + זרימת הסמכת קליטת הזמנות (M7).**
> - **עשר בדיקות חדשות — כולן ירוקות**, וכל הבדיקות הקודמות עדיין עוברות.
>
> חסם חיצוני יחיד (V2 §2): הרצת התרחישים החיה מול Channex Staging עם Task IDs אמיתיים דורשת חיבור Staging פעיל / חשבון בדיקה של Booking.com. כל השאר — הקוד, ההקשחה, מעטפת הראיות, ה-mocks, המסמכים וההצהרות — נבנה ואומת אופליין. שום קוד production, DB משותף או OTA חי לא נגעו; כל המיגרציות רצו רק על ה-DB הייעודי (:5434).

## Milestones + evidence

1. **M1 — environment routing canonical (§11, CHX G6 closed).** `config.channexBaseUrl(env)` is the sole base-URL resolver; setup ops resolve env via `production-guard.effectiveChannexEnvironment()`, runtime paths via `conn.environment`. `check:channex-environment-routing`.
2. **M8 — production activation guard (§26, built + inactive).** `production-guard.ts`: staging by default, production only behind `CHANNEX_PRODUCTION_ACTIVATION`; `assertProductionActivationAuthorized` fails closed; prod-connection creation gated. `check:production-activation-guard`.
3. **M2 — evidence ledger (§13, H9/H10) + read-only console.** migration 038 `channel_evidence_ledger` (append-only, staging-applied); `recordAriEvidence` sole writer wired into full-sync AND incremental drain (incremental Task IDs no longer discarded); `certification.ts` read-only console + `CertificationConsoleSection.tsx`. `check:channex-certification-evidence`.
4. **M4 — Full Sync two-request + 10MB preflight (§14).** byte-bounded batching (removed the artificial 1000-value cap); `payloadByteSize`/`PAYLOAD_BYTE_LIMIT`; evidence records `requestBytes` + `expectedRequests:2`; delta-only after. `check:channex-full-sync-two-requests`.
5. **M5 — Group Update single envelope + Min Stay (§15).** verified the outbox emits one dirty envelope (plan scope NULL, rates+restrictions) → one combined request; `MIN_STAY_SEMANTICS.md` declaration. `check:channex-group-update-batching`.
6. **M6 — rate-limit cooldown + circuit breaker (§16, M14).** `circuit-breaker.ts` (pure), 429 Retry-After extraction in `channex-http.ts`, migration 039 breaker state, drain gating + persistence. `check:channex-rate-limit-cooldown` (full fault list).
7. **M7 — inbound security/chaos + booking-receiving cert flow (§17).** `check:channel-security`, `check:channel-chaos`, `check:channex-booking-crs-flow` + `BOOKING_RECEIVING_CERTIFICATION.md`. (Inbound runtime already mature — 235-assertion `check:inbound-bookings` unchanged.)
8. **M3+M9 — certification artifacts (§12/§23).** scenario matrix (14 tests, traceable, G1/G3 closed), declarations 12–14, complete `SCREENSHARE_DEMO_SCRIPT.md`, environment/activation runbooks, umbrella `check:channex-certification`.

## Checks (V2 §24) — all ten green

`check:channex-environment-routing`, `check:production-activation-guard`, `check:channex-certification-evidence`, `check:channex-full-sync-two-requests`, `check:channex-group-update-batching`, `check:channex-rate-limit-cooldown`, `check:channel-security`, `check:channel-chaos`, `check:channex-booking-crs-flow`, `check:channex-certification`.

Also fixed 3 pre-existing stale assertions in `check:channex-ari` (was fully red at HEAD) and 2 in `check:channel-worker` (aborting since the M1 base-URL change) — both now fully green.

## Exit-gate checklist (charter §6 + Stage 4)

| Item | Result |
|---|---|
| All ten new checks pass; all previous checks still pass | ✅ (battery incl. 7 Stage-3 integrity checks with the disposable DSN) |
| Every executable scenario has evidence structure (UI workflow, firing file+function, request counts, Task-ID capture, pass status) | ✅ ledger + matrix + traceability; **live Task-ID capture pending Channex Staging channel — external dependency, documented** |
| Quote-to-ARI price equality proven end to end | ✅ `check:pricing-equality` 22/22 |
| Production remains inactive; guard test evidence recorded | ✅ `check:production-activation-guard` (staging-by-default, guard refuses) |
| Documentation matches code | ✅ 12 `docs/channex/` docs incl. complete demo script + declarations |
| STATE + report (Hebrew summary) | ✅ |
| Tag + PR | ✅ (this exit) |
| Safety: prod/OTA/shared-infra untouched, no secrets | ✅ migrations 038/039 only on staging :5434; production inactive; no secrets committed |

## External dependency (V2 §2)

Live scenario execution against Channex Staging (real Task IDs for tests 1–11) and the live booking-receiving run require an active Staging connection with credentials and a Booking.com test account (or the Booking CRS test tool). This is an external dependency: the full offline harness, contract-shaped checks, mocks, evidence ledger, read-only console, docs and declarations are built and proven; live execution is documented in `CERTIFICATION_SCENARIO_MATRIX.md`, `BOOKING_RECEIVING_CERTIFICATION.md` and `SCREENSHARE_DEMO_SCRIPT.md` and is performed when the channel is provisioned.

## Safety confirmation

Production not activated (guard inactive, verified); no live OTA touched; no real Channex production call; migrations 038/039 applied ONLY to the dedicated staging DB (:5434); shared stack + other apps untouched; no secrets committed.

## Handoff to Stage 5 (PMS Capability Completion)

Consumes the certification-ready channel layer. Stage 5 owns the re-scoped items: H13 (audit read/search UI), H14/H15 (reports/exports, Israel VAT/invoice/PII), M1/M2/M4/M5, and the maintainability refactor (round-2 dedup + large-module splits) with the Stage-3/4 checks as behavior-preservation guards.
