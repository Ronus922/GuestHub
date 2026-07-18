# Stage 1 Report — Foundation, System Audit and Target Architecture

**Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification` · **Tag:** `stage-1-complete`

## Executive summary (Hebrew)

> **תקציר מנהלים — שלב 1 הושלם (audit וארכיטקטורה, ללא שינוי התנהגות).**
>
> ביצענו מיפוי מלא של מערכת GuestHub וקבענו את ארכיטקטורת היעד לכל התוכנית — בלי לגעת בקוד המוצר, בסביבת ה-production או בתשתית המשותפת. נלקח גיבוי טרי ואומת בשחזור מלא (60 מתוך 60 טבלאות זהות). נפתח branch ייעודי ו-draft PR ‏(#92), וקבצי התוכנית עברו ל-`docs/program/`.
>
> **הממצא החמור ביותר:** סביבת הפיתוח וה-production מצביעות כרגע על אותו בסיס נתונים משותף — זה יטופל שורשית בשלב 2 (בסיס נתונים ייעודי ל-GuestHub). ממצא נוסף: בסיס הנתונים חשוף מעבר לחומת האש של השרת (Docker עוקף את UFW) — גם זה לשלב 2/6. **לא נמצאו ליקויים קריטיים בלוגיקת המוצר עצמה** — מנוע התמחור, פנקס התשלומים, מניעת הכפילויות ותור העבודה נמצאו איתנים; הליקויים הם בעיקר בתשתית (DB ייעודי, גיבוי off-host) ובהשלמות (דוחות, מע"מ תיירים, ראיות certification).
>
> המערכת "בנויה נכון" לצורך certification של Channex — יש זיהוי-שינוי, outbox, תור עמיד ו-batching, ואף אחד מהדפוסים הפסולים של Channex לא קיים. מה שחסר הוא שכבת ראיות (Task IDs) והתאוששות מ-rate limit — שלב 4.
>
> אין צורך בפעולה שלך כרגע. כשתהיה מוכן — קרא דוח זה והפעל את שלב 2.

## Entry gate results (charter §5 + Stage-1 additions)

| Step | Result |
|---|---|
| Read charter + V2 + Stage 1 doc | ✅ |
| Phase 0 — DB identity of every environment resolved & printed | ✅ Dev + prod both resolve to shared `supabase-db :5432` schema `guesthub` (**Critical C1** recorded); disposable test DB = `guesthub-testdb :5433` |
| No process in this program can reach production DB | ✅ Enforced: no migrations/seeds/tests via dev env; all read-only work used the restore snapshot on :5433 |
| Verified backup + restore proof | ✅ `pg_dump --schema=guesthub` (6.0 MB) + uploads tar; restored into scratch DB `guesthub_stage1_restore` on :5433 with 0 errors; **60/60 tables row-count identical** |
| Host headroom recorded | ✅ 109 GB disk free, 13 GB RAM available, 8 cores, load ~1.0 |
| Git safety + integration branch + draft PR | ✅ branch from `origin/main`@`b78650c`; PR #92 (draft); ~40 old branches reviewed, none conflict |
| Program files committed to `docs/program/` + STATE.md | ✅ commit `dada08e` |
| Shared infra / prod PM2 untouched | ✅ Confirmed (read-only `pm2 ls`/`describe` only) |

## Milestones delivered

1. **Program files + STATE** — `docs/program/` (charter, V2, 7 stage docs, README, STATE.md). Commit `dada08e`.
2. **Channex versioned requirements** — `docs/channex/PMS_CERTIFICATION_REQUIREMENTS.md`, fetched live 2026-07-18 (process, pre-flight, anti-patterns, tests 1–14, rate limits, booking flow). Commit `e522e9c`.
3. **Audit inventories (10)** — `docs/audit/{ARCHITECTURE,DOMAIN,CODEBASE,RESERVATIONS_INVENTORY,PRICING,PAYMENTS,WORKFLOW,OPERATIONS_OBSERVABILITY}_*.md`, `CHANNEX_CERTIFICATION_MAPPING.md`, `PMS_GAP_MATRIX.md`, and `docs/security/THREAT_MODEL.md`. Commit `c7eb46e`. Produced by 10 parallel read-only agents (roles A/B/C/D/E/F/G/H/I/K per V2 §5).
4. **Consolidated defect matrix** — `docs/audit/DEFECT_MATRIX.md`: 2 Critical, 15 High, 27 Medium, ~11 Low/Info; **every Critical/High has an owning stage**. Commit (defect matrix).
5. **Target architecture + 5 ADRs** — `docs/architecture/TARGET_ARCHITECTURE.md` + `adr/ADR-0001..0005` (sources of truth, DB topology, double-booking exclusion constraint, sync-outbox seam, guest model). Commit (architecture).
6. **Architecture/Channex/security document skeletons** — the V2 §23 set, current-state filled from the audit, target-state from the ADRs, completion checklists per owning stage.

## Defect summary (see DEFECT_MATRIX.md)

- **Critical (2):** C1 dev↔prod shared DB (→Stage 2); C2 DB exposed past UFW via Docker (→Stage 2 design/Stage 6 verify).
- **High (15):** no DB double-booking guard (H1→S3), no status CHECK (H2→S3), no tenant DB backstop/RLS (H3→S3), backup omits auth + no off-host (H4→S2), migration history unreconstructable (H5→S2), OTA modify wipes local money adj (H6→S3), refunds unimplemented (H7→S3), full PAN vault=PCI scope (H8→S3/S6), incremental Task IDs discarded (H9→S4), no evidence ledger (H10→S4), quarantine re-import unbounded errors (H11→S3), no dead-letter/heartbeat alerting (H12→S6), audit write-only (H13→S3), reports/exports missing (H14→S5), Israel VAT/invoice/PII gaps (H15→S5).
- **No Critical defects in product domain logic.** Confirmed strengths recorded to guard against regression.

## Exit-gate checklist (charter §6)

| Item | Result |
|---|---|
| Every assigned item implemented with evidence or re-scoped | ✅ (audit + architecture; no implementation items in Stage 1) |
| Checks introduced this stage pass | ✅ (none added — Stage 1 adds no product code) |
| Previous checks still pass (regression guard) | ✅ `npm run typecheck` clean, `npm run lint` clean |
| Documentation exists and matches code | ✅ audit sourced from code/snapshot; skeletons cross-reference audit |
| STATE file + stage report written (incl. Hebrew summary) | ✅ |
| Milestone commits pushed, tag created, PR updated | ✅ (this exit) |
| Safety: production not activated, live OTA untouched, no real reservation affected, shared infra untouched, no secrets committed | ✅ (secret scan of all docs passed — only env-var *names* appear) |
| All audit artifacts under `docs/audit/`, internally consistent | ✅ |
| Every Critical/High has an owning stage | ✅ |
| Every gap-matrix item classified + owning stage | ✅ (`PMS_GAP_MATRIX.md`) |
| ADRs approved by Agent A; disagreements resolved | ✅ (5 ADRs Accepted) |
| Diff = documentation/program/audit tooling only | ✅ |

## Handoff to Stage 2

Stage 2 (Dedicated Database Infrastructure) begins from ADR-0002. Prerequisites recorded: recover migration 021 into the branch + add a migration ledger (H5) before replay-from-zero; include the `auth` schema in backups (H4); provision two dedicated clusters + per-env GoTrue + four roles; build cutover/rollback tooling; **do not execute the production cutover**.

## Safety confirmation

Production was not activated; no live OTA channel was touched; no real reservation was created, changed or cancelled; the shared database stack and all other PM2 apps were left exactly as found; no production DB cutover was executed; no secrets were committed (scanned); the verified backup + restore proof exist on the disposable instance.
