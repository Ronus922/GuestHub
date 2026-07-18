# Stage 2 Report — Dedicated Database Infrastructure

**Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification` · **Tag:** `stage-2-complete` · **Independent verifier (Agent N):** PASS (8/8)

## Executive summary (Hebrew)

> **תקציר מנהלים — שלב 2 הושלם (בסיס נתונים ייעודי, בלי לגעת ב-production או בתשתית המשותפת).**
>
> **מיטגנו מיד את הפרצה הקריטית C2:** פורטי ה-DB (5432/6543/5433) היו חשופים לאינטרנט כי Docker עוקף את חומת האש. חסמנו גישה חיצונית בשכבת הרשת (רק דרך הממשק הציבורי), עם התמדה שורדת-אתחול — בלי לעצור אף קונטיינר ובלי לפגוע באפליקציות אחרות. אומת: בדיקות חיצוניות עכשיו נחסמות, ה-app ממשיך לעבוד (0 ריסטארטים).
>
> **הקמנו בסיס נתונים ייעודי ל-GuestHub** (נפרד לגמרי מה-DB המשותף), עם 4 תפקידים בהרשאות מינימום, גיבוי אוטומטי מוצפן שכולל גם את סכימת ההתחברות (auth) — תיקון לגיבוי הישן שאיבד את כל המשתמשים בשחזור — ותרגיל שחזור שעבר בהצלחה (14 משתמשים שוחזרו). הוכחנו שאפשר לבנות את כל הסכימה מאפס (38 מיגרציות, זהה למבנה ה-production) והשלמנו את המיגרציה החסרה (021) ופנקס מיגרציות.
>
> **לא בוצע מעבר production** — הוא מוכן במלואו (runbook + כלים + rollback) ומחכה לאישורך. התשתית המשותפת וכל שאר האפליקציות נבדקו ונשארו ללא שינוי (uptime 9 ימים, 0 ריסטארטים).
>
> פריט פתוח יחיד שדורש אותך: יעד גיבוי מחוץ-לשרת (off-host) — הכלי בנוי ומחכה ליעד+הרשאה שתספק.

## Milestones + evidence

1. **C2 mitigation (Critical, immediate):** interface-scoped DROP in `DOCKER-USER` (v4+v6) on `ens3` for tcp/5432 + tcp/6543; persisted via idempotent `scripts/ops/guesthub-db-firewall.sh` + `guesthub-db-firewall.service` (After/PartOf docker). Evidence: external check-host.net probes time out; DROP counter caught real external SYNs; localhost + prod app unaffected (0 PM2 restarts). Runbook: `docs/database/DB_EXPOSURE_MITIGATION.md`. Kong 8000/8443 hardening deferred to Stage 6 (documented, would risk auth ingress).
2. **H5 — migration integrity:** recovered `021_room_inventory_cleanup.sql` from orphan commit `597801a` (md5 verified); `db/migrations/manifest.txt` (38, 009 tie = phase4a→phase4); `scripts/db/migrate.mjs` runner + `guesthub.schema_migrations` ledger, fail-closed against :5432. Replay-from-zero: 38/38, schema structurally identical to prod (61 = 60 + ledger; column structure byte-identical).
3. **Dedicated staging (ADR-0002):** `guesthub-staging-db` (`supabase/postgres:15.8.1.085`, 127.0.0.1:5434, volume, 2g/2cpu); `db/roles/roles.sql` — 4 least-privilege roles; ownership verified (all 61 tables → `guesthub_owner`, app owns 0, DDL denied); data-copy validated (`validate-copy.mjs`: 58/59 content-identical, 1 volatile heartbeat drift, 0 mismatch); app+worker smoke PASSED (`smoke-staging.mjs`).
4. **H4 — backups:** `guesthub-backup.sh` (guesthub+**auth**, AES-256, retention, off-host hook) + `guesthub-restore-drill.sh`; systemd timers (nightly/weekly); old auth-less cron superseded. Restore drill PASSED (0 errors, 60+20 tables, 81 reservations, **14 auth.users recovered**).
5. **check:db-isolation:** `npm run check:db-isolation` PASSES on staging, FAILS on shared DB (detects `marketpilot`/`sea_tower`/22 public tables).
6. **Cutover prepared, not executed:** `MIGRATION_AND_CUTOVER_RUNBOOK.md` + rollback + the four `docs/database/` docs.

## Exit-gate checklist (charter §6 + Stage 2)

| Item | Result |
|---|---|
| Assigned items implemented with evidence | ✅ |
| `check:db-isolation` passes; previous checks pass | ✅ (typecheck + lint clean; db-isolation PASS) |
| Scoped regression (no product behavior change) | ✅ no `src/` changed since `b78650c` |
| App + worker smoke pass against staging | ✅ `smoke-staging.mjs` PASSED |
| Restore drill evidence | ✅ PASSED (14 auth.users) |
| Other apps on shared infra untouched & functioning | ✅ shared containers up 9d (not restarted); 5 PM2 apps online, restart counts flat; `marketpilot`+`sea_tower` intact; prod `/login` 200 |
| Cutover runbook reviewed by Agent N; cutover NOT executed | ✅ Agent N PASS 8/8; no cutover |
| STATE + report (Hebrew summary) | ✅ |
| Docs match code | ✅ four `docs/database/` docs + mitigation runbook |
| Tag + PR updated | ✅ (this exit) |
| Safety: prod not activated, live OTA untouched, no real reservation affected, shared infra untouched, no secrets committed | ✅ (secrets only in gitignored `.env.staging` + host key file) |

## Agent N verdict
PASS — all 8 claims CONFIRMED. One wording nuance: the app root `/` returns 307→`/login` (D77), `/login` returns 200; liveness uses `/login`.

## Deferred / blockers
- Off-host backup destination + credential (user-provided; hook built, warns when unset).
- Kong gateway external hardening → Stage 6.
- Production cutover execution → post-program, user-approved.

## Handoff to Stage 3 (Core Domain Integrity)
Begins from ADR-0001 (canonical sources) and ADR-0003 (double-booking exclusion constraint). Owns H1, H2, H3, H6, H7, H8, H11, H13 and the domain-integrity checks. Stage 3 runs migrations/tests against the **disposable** (:5433) and **staging** (:5434) DBs — never the shared :5432. The `guesthub_app` role model and the `check_room_availability` function are the runtime contract to preserve.

## Safety confirmation
Production not activated; no live OTA touched; no real reservation created/changed/cancelled; production DB cutover NOT executed; shared database stack and all other applications untouched (verified); no secrets committed.
