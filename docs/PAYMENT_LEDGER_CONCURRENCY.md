# ספר התשלומים תחת מקביליות (B5.1)

מקור: `docs/NIGHT_AUDIT.md` ממצא חמור #3 (ענף `origin/night/night-run-report`, PR #111).
הבאג הוכח על staging לפני התיקון, וההוכחה משוחזרת בכל ריצה של השומר
`scripts/check-payment-ledger-concurrency.mjs`.

## מה היה שבור

`guesthub.payments` הוא ספר החשבונות הסמכותי; `reservations.paid_amount` /
`balance` הם מטמון נגזר (D51/D52). שתי הפעולות היו נכונות **רק** כשכותב אחד
מזיז כסף בכל רגע:

| # | מסלול | מה קרה בפועל (מספרים אמיתיים מ-`gh_payment_race`) |
|---|-------|--------------------------------------------------|
| 1 | שני החזרים במקביל | גבייה 100, שני החזרים של 60 בו-זמנית → **שניהם** עברו את שומר ה-over-refund (כל אחד קרא "נגבה נטו = 100") → `SUM(amount) = -20`, `paid_amount = 40`. הוחזר כסף שמעולם לא נגבה. |
| 2 | שתי גביות במקביל | 100 גבוי, ועוד 50 ו-70 במקביל → הספר 220 אבל `paid_amount = 150`. `recomputePaymentAggregates` מחשב את הסכום מ-**תצלום המשפט**: כשכותב שני נחסם על שורת ההזמנה, PostgreSQL מריץ EvalPlanQual על שורת היעד אבל **לא** מחשב מחדש את תת-השאילתה `FROM (SELECT SUM …)`. עדכון אבוד. |
| 3 | החזר + ביטול במקביל | הספר 0 אבל `paid_amount = 100`. |

## התיקון

`lockReservationForPaymentWrite()` ב-`src/lib/payments/ledger.ts` — נעילת שורת
ההזמנה **במשפט נפרד, לפני** כל קריאה שהחלטת כתיבה נשענת עליה. ב-READ COMMITTED
המשפט הבא מקבל תצלום חדש, ולכן רואה כל מה שהמחזיק הקודם הספיק לקמט.
נקרא מ-`recomputePaymentAggregates`, מ-`recordRefund` ומ-`voidPayment`.

**`FOR NO KEY UPDATE` ולא `FOR UPDATE`** — הכנסת שורת תשלום נועלת את אותה שורת
הזמנה ב-`FOR KEY SHARE` (מפתח זר `payments → reservations`). `FOR UPDATE` מתנגש
עם KEY SHARE, ולכן שתי טרנזקציות שמכניסות תשלום ואז נועלות נכנסות ל-deadlock.
זה לא ניתוח תיאורטי: הגרסה הראשונה של התיקון השתמשה ב-`FOR UPDATE` והשומר
החזיר `worker 2 rejected: deadlock detected` בתרחיש B. `NO KEY UPDATE` מתנגש עם
עצמו (כותבי כסף עדיין מודרים הדדית) אבל לא עם KEY SHARE.

## איך מריצים את השומר (בסיס נתונים חד-פעמי)

```bash
node scripts/check-payment-ledger-concurrency.mjs
```

בלי שום הגדרה מוקדמת השומר **מקים לעצמו** בסיס נתונים חד-פעמי: הוא קורא
`STAGING_ADMIN_URL` מ-`.env.staging` (gitignored, `127.0.0.1:5434`), יוצר
`CREATE DATABASE gh_payment_race` אם אינו קיים, ומריץ לתוכו את כל
`db/migrations/*.sql`. שום דבר אחר על המכונה לא נוגע. לניקוי:

```bash
psql "$STAGING_ADMIN_URL" -c 'DROP DATABASE gh_payment_race;'
```

זהו **בדיוק** ה-DB החד-פעמי ששני השומרים הקיימים מבקשים ולא מקבלים
(`check:payment-refund-void`, `check:reservation-concurrency` יוצאים עם קוד 2 בלי
`CHECK_CONCURRENCY_DB_URL`). אחרי שהשומר החדש הרים אותו:

```bash
export CHECK_CONCURRENCY_DB_URL="postgresql://<staging-admin>@127.0.0.1:5434/gh_payment_race"
pnpm check:payment-refund-void        # עובר
pnpm check:reservation-concurrency
```

השומר מסרב לרוץ מול פורט 5432, מול סמני פרודקשן ב-DSN, ומול בסיס נתונים שאינו
חד-פעמי (`guesthub`, `guesthub_staging`, `postgres`). הוא **אינו מוחק שורות** —
הבסיס כולו חד-פעמי.

## חסם פתוח — השומר לא רשום כ-`check:*`

`package.json` שייך לענף `fix/beds24-checkin-cancellation-guard` (PR #112)
שממתין למיזוג, וכלל הברזל אוסר לגעת בקבצים שלו. לכן **לא הוספתי**
`"check:payment-ledger-concurrency": "node scripts/check-payment-ledger-concurrency.mjs"`
ל-`scripts` — צריך להוסיף אותו אחרי מיזוג #112, אחרת השומר לא ירוץ ב-CI.
מאותה סיבה הממצא הזה לא נרשם ב-`DECISIONS.md` (גם הוא בבעלות #112).

## מה עוד פתוח

- מסלולים שכותבים תשלום ואז קוראים ל-`recomputePaymentAggregates` יורשים את
  הנעילה דרך ה-recompute, אבל **קוראים** את הספר לפניה רק אם הם עצמם נועלים.
  `recordExternalPayment` (`card-actions.ts:451`) כבר נועל `FOR UPDATE` בעצמו;
  מסלול חיוב הכרטיס (`card-actions.ts:380`), `booking-import.ts:504` ו-
  `create-booking.ts:198` מכניסים שורה ואז נגזרים — נכון היום, אבל כל החלטה
  עתידית שתישען על קריאת ספר לפני הכתיבה חייבת לקרוא ל-
  `lockReservationForPaymentWrite` תחילה. אסרטציה F בשומר שומרת על השם הזה.
- `refundPaymentAction` עדיין מחזירה שגיאה טכנית באנגלית (`refund 60 exceeds net
  captured 40`) למשתמש בעברית — לא שונה כאן כדי לא לגעת בהתנהגות שאין לה שומר.
