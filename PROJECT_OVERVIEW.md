# GuestHub PMS — PROJECT_OVERVIEW.md

סקירה עדכנית של הריפו **הזה** (`Ronus922/GuestHub`), נכון ל-2026-07-26.

> **הגרסה הקודמת של הקובץ (2026-07-03) הייתה ספסיפיקציית הבנייה המייסדת** —
> נכתבה לפני הפיצול מ-`/var/www/pms`, ולכן תיארה עץ `app/` + `lib/` (היום
> `src/`), Channex כמנהל ערוצים עתידי (הוסר ב-D91), ו-`pnpm build` ידני כמסלול
> דפלוי (היום חסום ב-prebuild-guard). היא שמורה במלואה בהיסטוריה:
> `git show 468be74b` (blob `468be74baa8a0c5ee0ecf4c78edb7d72512135c3`).
> הפניות היסטוריות לסעיפיה — `DESIGN_SYSTEM.md` ו-`DECISIONS.md` אל §16,
> `scripts/seed.mjs` אל §20 — מתייחסות לגרסה ההיא.

---

## 1. זהות ותשתית

|  |  |
| --- | --- |
| דומיין | `guesthub.bios.co.il` → nginx → `localhost:3007` (`docs/PRODUCTION_RUNTIME.md`; מופיע כסמן-פרודקשן בשומרי ה-DB, למשל `scripts/check-pricing-engine.mjs:34`) |
| פורט | **3007** (`scripts/deploy-production.sh:14`, `APP_PORT` ב-env) |
| תהליכים | PM2: `guesthub` (‎`next start`) + `guesthub-channel-worker` — שניהם מ-`/var/www/guesthub` |
| עץ רץ | `/var/www/guesthub` הוא **ה-runtime החי**, מסומן `.production-runtime` (מאז `6862f36`; ‎`/var/www/guesthub-production` הוסר). אסור לפתח בו — עבודה ב-worktrees בלבד |
| מנהל ערוצים | **Beds24 בלבד** (D91) — inbound ב-poll, ARI outbound דרך ה-worker. אפס Channex, אפס Stripe |
| סטאק | Next.js 15.5 (App Router, RSC + Server Actions) · React 19 · TypeScript strict · Tailwind v4 · PostgreSQL (סכימת `guesthub`) דרך porsager `postgres` · Supabase Auth self-hosted = אימות בלבד |

טבלת העובדות המלאה (ספריות, env, בדיקות): `CLAUDE.md` («GuestHub — עובדות
פרויקט»). מפת ארכיטקטורה עמוקה: `docs/architecture/SYSTEM_OVERVIEW.md`.

> הערת אי-התאמה ידועה: `docs/PRODUCTION_RUNTIME.md` וטבלת העובדות ב-`CLAUDE.md`
> עדיין מזכירות `/var/www/guesthub-production` — נכון להיום ה-cwd של שני תהליכי
> ה-PM2 הוא `/var/www/guesthub` (אומת מול `pm2 jlist`).

## 2. מבנה תיקיות

```text
src/
  app/
    (dashboard)/        14 מסכים: calendar · channels · communications · dashboard ·
                        guests · housekeeping (קפוא, STATE.md) · maintenance ·
                        permissions · rate-plans · rates · reservations · rooms ·
                        settings · staff
    api/                Route Handlers (כולל /api/public — שכבת ההזמנות הציבורית)
    auth/ · reservations/[id]/print · styles/   (globals.css = @imports בלבד)
  components/           reservations/ · calendar/ · shared/ · layout/ · ui/ …
  lib/                  pricing/ · rates/ · channel/ (beds24-*) · payments/ ·
                        public-booking/ · commercial/ · validation/ · db.ts · vat.ts ·
                        card-vault.ts · inventory.ts …
db/migrations/          000–056 + manifest.txt (מספר קובץ = זהות; הבא פנוי: 057)
scripts/                deploy-production.sh · seed.mjs · 74 שומרי check-*.mjs
docs/                   architecture/ · audit/ · database/ · payments/ · program/ ·
                        security/ · proof/ + דוחות נקודתיים (PRICING_MODEL, GUARD_AUDIT…)
```

## 3. היכן מחושב מחיר הזמנה

**מנוע מרכזי אחד** (D42/D51): `calculateReservationPrice` (= `calculateQuote`)
ב-`src/lib/pricing/engine.ts` — שרשרת תוכניות תעריף, הגבלות, תפוסה ואורח נוסף,
מע״מ כלול. שלושה קוראים בלבד:

| קורא | תפקיד |
| --- | --- |
| `src/lib/pricing/reservation-pricing.ts` (`priceReservationStays`) | **תפר השמירה** — יצירה/עריכה/הזזה (`reservations/actions.ts`) וההזמנה הציבורית (`public-booking/create-booking.ts`); כותב `pricing_snapshot` חסין לכל שהות |
| `getStayQuoteAction` (`reservations/actions.ts`) | ציטוט חי בפאנלים |
| `simulateQuoteAction` (`rate-plans/actions.ts`) | סימולטור תוכניות תעריף |

דחיפת ה-ARI ל-Beds24 (`src/lib/channel/beds24-ari-projection.ts`) חולקת את
`resolveChainNightPrice` מ-`src/lib/pricing/resolve.ts` מילה במילה — מה שנמכר
פנימה ומה שמתפרסם לערוץ נגזרים מאותה פונקציה. סה״כ ההזמנה:
`reservationTotal` ב-`reservation-pricing.ts` (rooms + extra − discount, רצפה ב-0).
שומרים: `check:pricing-engine`, `check:pricing-equality`.

## 4. מסלול דפלוי

```text
worktree  →  PR ל-main  →  בעץ המסומן:  PROD_DEPLOY_OK=1 npm run deploy:prod
```

`scripts/deploy-production.sh` הוא הדרך היחידה: fail-closed — מסרב לענף שאינו
main, לעץ מלוכלך ולקומיט שאינו reachable מ-`origin/main`; בונה, מריץ typecheck,
ומאתחל אך ורק את שני תהליכי ה-PM2 של guesthub. `pnpm build` ידני בעץ המסומן
נחסם בכוונה (prebuild-guard). פירוט: `docs/PRODUCTION_RUNTIME.md`.

## 5. יומן ההחלטות ומקורות אמת

| מסמך | תפקיד |
| --- | --- |
| **`DECISIONS.md`** (שורש הריפו) | יומן ההחלטות המחייב — D1 עד **D102** נכון להיום. כל סטייה/הכרעה נרשמת שם |
| `CLAUDE.md` | כללי ברזל, עובדות פרויקט, כללי concurrency ו-production-runtime |
| `STATE.md` | מה קפוא (housekeeping/tasks ועוד) |
| `DESIGN_SYSTEM.md` + `GUIDELINES.md` | עיצוב מחייב |
| `docs/architecture/` | מודל דומיין, תמחור, תשלומים, ערוצים, פריסה |
