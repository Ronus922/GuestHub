# Stage 5 Report — PMS Capability Completion

**Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification` · **Tag:** `stage-5-complete` · **Independent verifier (Agent N):** PASS 6/6 (no must-fix items)

## Agent N independent verdict — PASS 6/6

Reproduced from source + databases: (1) lifecycle — checkout fires the idempotent cleaning-task INSERT with no outbox marking; all three availability functions filter `kind='ooo'` and only OOO closures conflict-check/sync. (2) safety — staging :5434 has the new columns; prod :5432 confirmed ABSENT of all three (untouched, read-only queries only). (3) Israel — VAT zero-rating, anonymize is UPDATE-not-DELETE + idempotent + names-only audit, invoice seam fails closed. (4) reports — all pure SELECT, tenant-scoped, canonical statuses; CSV injection-hardened. (5) all check suites + tsc + design PASS. (6) no parallel task table — single unified store. **No must-fix items.**

## Executive summary (Hebrew)

> **תקציר מנהלים — שלב 5 הושלם (השלמת יכולות ה-PMS).**
>
> השלמנו את היכולות התפעוליות של PMS בוגר, כולן מחוברות למחזור החיים האמיתי של ההזמנה — לא מסכים דקורטיביים:
> - **תקשורת בשפת האורח:** אוטומציות שולחות תבנית בשפת האורח (עם נפילה חזרה ישרה), לא רק תבנית ברירת המחדל.
> - **מודול משק בית:** יציאת אורח מייצרת אוטומטית משימת ניקיון (אידמפוטנטי); זרימת מנקה (ממתין→בניקיון→נוקה→נבדק); מסך "המשימות שלי" אמיתי. ניקיון אינו מוריד זמינות (חדר מלוכלך עדיין למכירה).
> - **תחזוקה OOO/OOS מוקלדת:** חסימת "מחוץ לשירות מלא" (OOO) מורידה זמינות ומסתנכרנת לערוץ; "מלוכלך אך למכירה" (OOS) לעולם לא מוריד זמינות.
> - **מערכת משימות אחת מאוחדת** (ללא מערכת מקבילה per-module).
> - **דוחות בטוחים בצד-שרת** (הגעות/עזיבות/בבית, תפוסה, הכנסה+ADR, יתרות, קופה, ערוצים) + ייצוא CSV מוקשח נגד הזרקת-נוסחאות.
> - **מוכנות ישראל:** אפס-מע"מ לתייר (הופעל את `tax_exempt` שהיה מת), אנונימיזציית אורח (תיקון 13 — מוחק PII, שומר את השורה והרשומות הפיננסיות), ותפר חשבוניות חיצוני שנכשל-סגור עד חיבור ספק אמיתי.
> - **מטריצת יכולות** מתעדת מומש מול נדחה עם נימוק.
>
> כל הבדיקות החדשות ירוקות וכל הקודמות עדיין עוברות. מיגרציות 040-042 רצו רק על ה-DB הייעודי (:5434); ה-DB המשותף לא נגע. אין סודות ב-commits.

## Milestones + evidence

1. **Communications — guest language (§10/§21):** `resolveVersion(automation, guestLanguage)` prefers a published sibling template (same category, guest's language) with honest fallback; locked policy never overridden. `check:guest-communications-automation` (11 groups).
2. **Housekeeping (§7):** checkout auto-generates a cleaning task (idempotent); `housekeeping/actions.ts` cleaner flow + manager assign/inspect; real my-tasks screen. `check:housekeeping` (static + DB idempotency proof).
3. **Maintenance OOO/OOS (§8):** migration 040 (`kind`/`category` + 3 availability functions filter `kind='ooo'`); OOO blocks+syncs, OOS dirty-but-sellable. `check:maintenance-closures` (DB proof OOS stays / OOO −1).
4. **Operational tasks (§9):** unified `housekeeping_tasks.task_type` store (migration 041) — no parallel system; `createOperationalTaskAction`. `check:housekeeping`.
5. **Reports + exports (§11/§1):** `reports/queries.ts` (7 reports over canonical data) + `reports/csv.ts` (injection-hardened) + `reports/export.ts` (reservation/guest CSV). `check:reports`.
6. **Israel-market (§21):** tourist VAT zero-rating (`includedVatForReservation` + `setReservationTaxExemptAction`); guest anonymization (migration 042, `anonymizeGuestAction`); fail-closed invoice seam. `check:israel-market`.
7/8. **Completeness + matrix:** data export; `PMS_CAPABILITY_MATRIX.md` (implemented vs deferred with justification).

New migrations (staging :5434 only): 040 typed closures, 041 operational tasks, 042 guest anonymization. New checks: `check:housekeeping`, `check:maintenance-closures`, `check:reports`, `check:israel-market` (+ extended `check:guest-communications-automation`).

## Checks — coverage grew (charter §Stage-5)

New: housekeeping, maintenance-closures, reports, israel-market. Extended: guest-communications-automation (guest-language). Full battery (new + prior integrity/channel/channex) all green; `check:design` clean; `tsc` clean.

## Exit-gate checklist (charter §6 + Stage 5)

| Item | Result |
|---|---|
| Every stage-assigned gap item implemented or deferred w/ justification | ✅ `PMS_CAPABILITY_MATRIX.md` |
| New modules proven connected to the real lifecycle | ✅ checkout→cleaning task (`check:housekeeping`); OOO→availability −1 + outbox (`check:maintenance-closures`) |
| RTL + Hebrew correctness on new/touched screens | ✅ `check:design` clean; my-tasks is RTL Hebrew |
| All previous checks still pass | ✅ full battery green |
| STATE + report (Hebrew summary) | ✅ |
| Tag + PR | ✅ (this exit) |
| Safety: prod/shared-infra untouched, no secrets | ✅ migrations 040-042 on staging :5434 only; no secrets committed |

## Deferred (see PMS_CAPABILITY_MATRIX.md)

Report UI surfaces, real invoice provider wiring (external dependency), bulk data import, maintenance ticketing, multi-property permissions, audit read UI — each with justification and target.

## Safety confirmation

No production/shared-DB writes; migrations 040/041/042 applied only to the dedicated staging DB (:5434); no live OTA/Channex action; no secrets committed.

## Handoff to Stage 6 (Security, Performance & Observability)

Consumes the completed PMS. Stage 6 owns: full red-team/threat-model execution, the re-scoped H8 (PAN purge + PCI review) and H11 (log retention/dedup), performance/load, observability/metrics/alerting, Kong gateway hardening (Stage-2 deferral), and the maintainability refactor round-2 with the accumulated checks as behavior-preservation guards.
