# Stage 3 Report — Core Domain Integrity

**Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification` · **Tag:** `stage-3-complete` · **Independent verifier (Agent N):** spot-review PASS 5/5

## Executive summary (Hebrew)

> **תקציר מנהלים — שלב 3 הושלם (ליבת שלמות הנתונים, מוכח).**
>
> הפכנו את לב ה-PMS לבטוח ברמת בסיס הנתונים:
> - **כפל-הזמנות (double booking) הפך לבלתי-אפשרי ברמת ה-DB** — אילוץ exclusion שמונע שתי שהיות חופפות באותו חדר, מוכח תחת ריצה מקבילה אמיתית (לא רק בדיקת קוד). זו ההגנה שחסרה קודם.
> - **פנקס התשלומים הושלם**: זיכויים וביטולים (refund/void) עם מניעת זיכוי-יתר ומניעת רישום כפול; כל יתרה נגזרת מנוסחה אחת בלבד.
> - **תיקון דליפת התאמות מקומיות** בעדכוני OTA (הנחות/תוספות נשמרות).
> - **בידוד דיירים** הוכרע ומגובה בבדיקה אוטומטית; **איחוד אורחים כפולים** בייבוא OTA לפי אימייל.
> - **7 בדיקות שלמות חדשות — כולן ירוקות**, ו-7 מסמכי ארכיטקטורת דומיין הושלמו.
>
> מאמת בלתי-תלוי (Agent N) שחזר את ההוכחות עצמאית ואישר הכול. פריטים חוצי-שלבים (רענון PCI, ניקוי לוגים, מסך היסטוריית audit) הועברו רשמית עם נימוק לשלבים 5/6 — לא הושמטו. שום קוד production, DB או OTA חי לא נגעו; כל העבודה על בסיסי הנתונים הייעודיים (staging/disposable).

## Milestones + evidence

1. **Double-booking prevention (H1/H2/M3, ADR-0003)** — migration 037: `rr_no_double_booking` EXCLUDE constraint (gist, room + `daterange(check_in,check_out,'[)')`, `WHERE is_blocking`) + trigger-maintained `is_blocking` + `reservations_status_check`. `check:reservation-concurrency` proves: concurrent overlapping blocking inserts → one rejected; concurrent draft→confirmed → second rejected; adjacent stays allowed. Replay-from-zero 39/39.
2. **Payment ledger (H7/M6/M7)** — `src/lib/payments/mutations.ts`: `recordRefund` (negative contra 'paid' row, over-refund fails closed, idempotent) + `voidPayment` (status flip, idempotent); `refundPaymentAction`/`voidPaymentAction` (perm `payments.refund`, audited). External recorder now sets a reference idempotency key (M6). Reschedule uses canonical `recomputePaymentAggregates` (M7). Proven by `check:payment-ledger-integrity` + `check:payment-refund-void`.
3. **H6** — OTA modify folds channel total through local discount/extra_charges; balance recomputed from ledger.
4. **H3 (ADR-0006)** — server-side scoping canonical; `check:pms-domain-invariants` is the data backstop; RLS deferred with explicit re-eval triggers.
5. **Guest dedup seam (ADR-0005)** — `upsertChannelGuest` reuses on unique normalized-email match; no silent wrong merges.
6. **§18** — `docs/payments/PAYMENT_ARCHITECTURE.md` + `TOKENIZATION_AND_PCI_BOUNDARIES.md`; provider-neutral model + CVV-never/PAN-vault/PCI-scope boundaries.
7. **7 domain docs** (§23) completed with Mermaid diagrams.

## Checks (V2 §24) — all green

`check:pms-domain-invariants`, `check:reservation-concurrency`, `check:inventory-integrity`, `check:pricing-equality` (22/22), `check:payment-ledger-integrity`, `check:background-job-recovery`, `check:timezone-and-money-invariants` (+ bonus `check:payment-refund-void`). Full battery run: 10/10 pass (incl. `check:db-isolation` + typecheck regression).

## Exit-gate checklist (charter §6 + Stage 3)

| Item | Result |
|---|---|
| All 7 new checks pass; Stage 2 checks still pass | ✅ (10/10 battery) |
| Double-booking proven at DB-constraint level | ✅ (Agent N reproduced independently) |
| Quote/calendar/grid price equality proven | ✅ (`check:pricing-equality` 22/22) |
| Every Stage-3 Critical/High closed or re-scoped w/ justification | ✅ H1/H2/H3/H6/H7 closed; H8/H11/H13 re-scoped w/ justification (STATE re-scoping log) |
| Scoped regression (reservations/calendar/rates/payments/permissions) | ✅ typecheck clean; pricing-equality green; no unrelated `balance=` writer (Agent N grep) |
| Documentation matches code | ✅ 7 domain docs + 2 payment docs + 2 ADRs |
| STATE + report (Hebrew summary) | ✅ |
| Tag + PR | ✅ (this exit) |
| Safety: prod/OTA/shared-infra untouched, no secrets | ✅ all schema work on staging/disposable; secrets only in gitignored files |

## Agent N spot-review verdict
PASS 5/5 — double-booking constraint enforced even on raw-SQL bypass; concurrency harness is real (3 connections, overlapping txns); ledger single-sourced through `recomputePaymentAggregates`; refund/void/over-refund/H6/M7 all confirmed; typecheck clean. Minor notes: scenario-A uses a 300ms timing stash (functional); `check:payment-refund-void` mirrors ledger SQL rather than importing the TS (proves the model; noted).

## Re-scoped (with justification — see STATE re-scoping log)
- H8 PAN purge job + full PCI review → Stage 6.
- H11 quarantine error-log retention/dedup → Stage 6.
- H13 audit read/search UI → Stage 5.
- Maintainability refactor (round2 dedup, large-module splits) + M1/M2/M4/M5 → Stage 5/6.

## Handoff to Stage 4 (Channex Integration & Certification Readiness)
Begins from ADR-0004 (sync-outbox seam). Consumes: the transactional `markAriDirty` outbox, the durable queue (crash-recovery proven), the canonical pricing/ARI projection (equality proven), and the reservation services (double-booking-safe). Stage 4 owns environment routing (remove hardcoded staging URL), the evidence ledger (Task IDs — H9/H10), Full Sync two-request semantics, Group Update batching, rate-limit cooldown/circuit-breaker (M14), booking receiving + ACK, and the production activation guard (built, disabled).

## Safety confirmation
Production not activated; no live OTA touched; no real reservation created/changed/cancelled; production DB cutover NOT executed; shared stack + other apps untouched; no secrets committed. All migrations/tests ran only on the dedicated staging (:5434) and disposable (:5433) databases.
