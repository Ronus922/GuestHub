# FIX — שמות כותרות הקרדיטים של Beds24

**כותרות שגויות שנמצאו: 1 שם שגוי + 2 כותרות שלא נקראו כלל = 3 ליקויים · תוקנו: 3 · שומר עובר A/B2: כן (שניהם אדומים, exit 1) · עלות ממוצעת לבקשה: 1 קרדיט (נמדד חי; 1.2 נמדד ב-#104 על `GET /bookings`) · צריכה ל-24ש': ~442–622 קרדיטים מתוך 28,800 = 1.5%–2.2% מהתקציב**

ריצה 2026-07-25, worktree `/var/www/wt-credit-headers`, ענף `fix/beds24-credit-headers`. אפס מיגרציה · אפס דפלוי · אפס מיזוג · אפס נגיעה בטוקן/סקופים · אפס שינוי מחירים או זמינות · אפס נגיעה ב-`GUARD_INTEGRITY.md` / `DECISIONS.md` / ענפים פתוחים. `tenant_id` בכל שאילתה.

> **ממצא שמשנה את ההמלצה: התיקון הזה כבר קיים בשני ענפים פתוחים.** #104 תיקן את שמות הכותרות ב-2026-07-24, יום לפני שהמשימה הזו נוסחה, ו-#106 מדד אותם באופן עצמאי באותו יום. הפירוט וההשלכות ב-`docs/CREDIT_HEADERS_IMPACT.md`. ה-PR הזה נשאר מינימלי ובר-מיזוג-עצמאי, אבל **אין למזג אותו לצד #104 בלי הכרעה** — ראה "ממתין להחלטת רונן".

---

## STEP 1 — טבלת האמת מהחוט

קריאה חיה אחת דרך המסלול הקנוני (טוקן גישה 24h מהמטמון; שום סוד לא הודפס). כל כותרות התגובה, כפי שהגיעו:

### `GET /authentication/details` → HTTP 200

| # | שם הכותרת (כפי שהתקבל) | ערך |
|---|---|---|
| 1 | `connection` | `Keep-Alive` |
| 2 | `content-length` | `383` |
| 3 | `content-type` | `application/json` |
| 4 | `date` | `Sat, 25 Jul 2026 13:31:06 GMT` |
| 5 | `keep-alive` | `timeout=5, max=100` |
| 6 | `server` | `Apache` |
| 7 | `x-xss-protection` | `1; mode=block` |

**סה"כ 7 כותרות. משפחת קרדיטים: 0.** נקודה קריטית בפני עצמה — **לא כל endpoint ממודד**, ולכן "אין מדידה" הוא מצב לגיטימי שחייב להישאר מובחן מערך.

### `GET /inventory/rooms/calendar?roomId=710488&…` → HTTP 200

| # | שם הכותרת (כפי שהתקבל) | ערך |
|---|---|---|
| 1 | `connection` | `Keep-Alive` |
| 2 | `content-length` | `195` |
| 3 | `content-type` | `application/json` |
| 4 | `date` | `Sat, 25 Jul 2026 13:31:20 GMT` |
| 5 | `keep-alive` | `timeout=5, max=100` |
| 6 | `server` | `Apache` |
| 7 | **`x-five-min-limit-remaining`** | **`97.8`** |
| 8 | **`x-five-min-limit-resets-in`** | **`146`** |
| 9 | **`x-request-cost`** | **`1`** |
| 10 | `x-xss-protection` | `1; mode=block` |

`GET /properties?includeAllRooms=false&page=1` החזירה את אותן שלוש הכותרות (`96.8` / `120` / `1`) — כלומר המדידה אינה ייחודית ל-endpoint אחד.

**הערה על אותיות:** ה-runtime (undici) מנרמל את מפת הכותרות ל-lowercase, ולכן האותיות שמופיעות למעלה הן של ה-runtime ולא בהכרח של החוט. זו בדיוק הסיבה שההשוואה בתיקון היא case-insensitive בשני הכיוונים ואינה סומכת על נרמול של אף צד. **הבאג עצמו אינו באותיות — הוא בשם.**

לא נעשה שימוש ב-apiV2.yaml (ואין כזה בריפו). הערה חשובה שנמצאה ב-#106: המפרט מתעד `X-RequestCost` / `X-FiveMinCreditLimit-Remaining` — **ואלה אינם מה שהשרת שולח.** התיעוד שגוי; החוט הוא הסמכות.

---

## STEP 2 — אודיט כל קריאות הכותרות בריפו

סריקה על כל הקוד (`src/`, `scripts/`), לא רק על `beds24-http`. קריאות של כותרות **תגובה** בלבד (כותרות בקשה נכללו ונוטרלו: `x-twilio-signature`, `x-forwarded-for`, `x-real-ip`, `x-booking-secret`).

| קובץ:שורה | השם שהקוד מחפש | קיים בטבלת האמת? | פסק דין |
|---|---|---|---|
| `src/lib/channel/beds24-http.ts:75` | `x-fivemincreditlimit-remaining` | **לא** | **שגוי** — תוקן ל-`x-five-min-limit-remaining` |
| `src/lib/channel/beds24-http.ts:130` | `retry-after` | לא (לא הופיע ב-200) | **לא ניתן לאמת** — מופיע רק ב-429, ואסור לייצר 429 בכוונה. שם תקני (RFC 9110); הושאר כמות שהוא ומכוסה בשומר דרך stub |
| `src/lib/channel/channel-http.ts:148` | `retry-after` | לא (כנ"ל) | **לא ניתן לאמת** — לקוח רב-ספקי מהתקופה שלפני D91; זהה ל-`beds24-http`. לא שונה |
| — | `x-request-cost` | **כן** | **לא נקרא בשום מקום** — נוסף |
| — | `x-five-min-limit-resets-in` | **כן** | **לא נקרא בשום מקום** — נוסף |

**מסקנה: זו מחלקת באגים בת שלושה ליקויים, לא באג בודד** — שם אחד שגוי ושתי כותרות שקיימות על החוט ומעולם לא נקראו. כל שלושתם בתיקון.

**היקף הנזק:**

```
ledger totals: {"total":223,"measured":0}
```

223 רשומות ראיות בטננט. **אפס** מהן נשאו אי-פעם ערך קרדיט. המד לא נשבר — הוא מעולם לא עבד.

---

## STEP 3 — התיקון

`src/lib/channel/beds24-http.ts` — שלושה שמות מדודים בקבועים, וקורא אחד:

```ts
const CREDITS_REMAINING_HEADER = "x-five-min-limit-remaining";
const CREDITS_RESET_HEADER = "x-five-min-limit-resets-in";
const REQUEST_COST_HEADER = "x-request-cost";

export function readBeds24Credits(headers: HeaderBag): Beds24CreditReading {
  …
  return { remaining, resetsInSec, requestCost,
           measured: remaining !== null || resetsInSec !== null || requestCost !== null };
}
```

- **case-insensitive בשני הצדדים.** `Headers.get` כבר כזה לפי מפרט Fetch, אבל `fetchImpl` מוחלף עשוי להחזיר אובייקט רגיל שהמפתחות בו באותיות כלשהן — ולכן `readHeaderNumber` מנרמל בעצמו במקום לסמוך על אחד הצדדים.
- **`x-request-cost` נקרא** ועובר דרך `pushBeds24Calendar` אל `Beds24SendOutcome.requestCost`, **מסוכם** לאורך הריצה (הצריכה האמיתית של ריצה היא סכום הקריאות, לא האחרונה), ונרשם ב-`context` של הראיות לצד `creditsRemaining`.
- **קריאה שנדחתה עדיין שורפת קרדיט**, ולכן 429 ו-`success:false` מדווחים את העלות שלהם. 429 שנראה חינם הוא בדיוק המדידה שמעודדת לנסות שוב מיד.
- **מצב "לא נמדד" מובחן.** ערך חסר מוחזר כ-`null` ולעולם לא כ-0 — 0 ב-`remaining` נקרא "אין קרדיטים", 0 ב-`requestCost` נקרא "הקריאה הייתה חינם". `measured:false` אומר זאת במפורש לצרכן שאחרת היה מכווץ ל-0. נבדק ב-`?? 0` על פני כל הצינור: לא נמצא אף ברירת-מחדל שמסתירה כותרת חסרה — ה-UI (`Beds24Section.tsx:144`) כבר משמיט את הביטוי כש-null, ולא מציג 0.

**אפס שינוי במקצב, ב-backoff או במפסק.** `PACE_MS`, `MAX_REQUESTS_PER_RUN` ו-`circuit-breaker.ts` לא נגעו. התיקון מחזיר מדידה לחיים; הוא אינו בונה מנגנון מעליה.

---

## STEP 4 — השומר, לפי תקן B2

`check:beds24-credit-headers` (`scripts/check-beds24-credit-headers.mjs`). **אף אסרשן אינו grep על שם כותרת** — כל אסרשן הוא על **ערך** שחזר דרך הלקוח האמיתי. השומר מקמפל את `src` בעצמו לתיקייה זמנית, כך ש-`dist/` ישן לא יכול להסתיר רגרסיה.

שש רגליים: stub ממודד · stub לא-ממודד (nulls, לא אפסים) · כותרות באותיות גדולות · 429 שעדיין מדווח עלות · קריאה חיה אחת ל-Beds24 · round-trip דרך כותב וקורא הראיות האמיתיים בתוך טרנזקציה שמתגלגלת לאחור.

### פלט A — מול `origin/main` נקי

```
=== LEG A — restore origin/main src/ ===
--- identity verification: src/ vs origin/main ---
diff-vs-origin/main-src: EMPTY (byte-identical)
--- per-file hash equality on the touched files ---
src/lib/channel/beds24-http.ts      worktree=2387ce35…  origin/main=2387ce35…  MATCH
src/lib/channel/beds24-ari.ts       worktree=b01b7e15…  origin/main=b01b7e15…  MATCH
src/lib/channel/beds24-ari-sync.ts  worktree=439d0e66…  origin/main=439d0e66…  MATCH

BEDS24 CREDIT HEADERS FAILED: creditsRemaining must be a NUMBER — the header name
the client reads does not match what Beds24 sends
+ actual - expected
+ 'object'
- 'number'

LEG A exit code = 1 (non-zero = RED, as required)
```

### פלט B2 — השם השגוי מוחזר, כל סימן סטרוקטורלי נשאר

```
=== B2 mutation — the ONLY change vs the fix ===
 src/lib/channel/beds24-http.ts | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
-const CREDITS_REMAINING_HEADER = "x-five-min-limit-remaining";
+const CREDITS_REMAINING_HEADER = "x-fivemincreditlimit-remaining";

structural signs still present (readBeds24Credits / measured / requestCost / readHeaderNumber): 20

BEDS24 CREDIT HEADERS FAILED: creditsRemaining must be a NUMBER — the header name
the client reads does not match what Beds24 sends
LEG B2 exit code = 1
```

`readBeds24Credits`, `measured`, `requestCost` והעוזר ה-case-insensitive כולם נשארו במקומם — 20 אזכורים — ובכל זאת השומר אדום. **B2 אדום = השומר אינו נשען על grep.**

### פלט ירוק אחרי התיקון

```
  ✓ metered response → creditsRemaining=97.8, requestCost=1
  ✓ unmetered response → nulls, not zeros (not-measured stays distinguishable)
  ✓ upper-cased headers still parse (case-insensitive lookup)
  ✓ 429 still reports remaining + cost (a rejected call is not a free call)
  ✓ live Beds24 read → remaining=97.8, cost=1, resetsIn=287s
  ✓ ledger round-trip (rolled back) → creditsRemaining=97.8, requestCost=1
  ✓ no trace left in the production ledger

BEDS24 CREDIT HEADERS: 7 PASSED     (exit 0)
```

### פלט ירוק בהרצה חוזרת — יציבות

```
  ✓ live Beds24 read → remaining=96.8, cost=1, resetsIn=286s
  ✓ ledger round-trip (rolled back) → creditsRemaining=96.8, requestCost=1
  ✓ no trace left in the production ledger

BEDS24 CREDIT HEADERS: 7 PASSED
```

`remaining` ירד מ-97.8 ל-96.8 בין ההרצות — בדיוק קרדיט אחד, שהוא מה שהקריאה החיה של השומר עצמה עלתה. **המד לא רק חי, הוא מדויק.**

---

## STEP 5 — מה שהתיקון חושף על #104 ועל P0-3

הפירוט המלא ב-**`docs/CREDIT_HEADERS_IMPACT.md`**. בתמצית, **שתי הנחות הפתיחה של השלב הזה נשללו בראיות**: #104 אינו מקצב לפי הכותרת השגויה — הוא תיקן אותה בעצמו ב-24/07; ו-P0-3 אינו נשען על מדידה מתה — הוא מדד חי באותו יום. הענף היחיד שבו המד מת הוא **main**.

---

## STEP 6 — כמה קרדיטים אנחנו באמת שורפים

### הנתונים (24 שעות אחרונות, מדודים)

```
=== succeeded jobs, last 24h ===          === evidence ledger requests, last 24h ===
 pull_booking_revisions  287               incremental_sync  35 rows  30 requests
 reconcile_inventory      50               full_sync          1 row    1 request
 sync_ari_range           35
 full_sync                 1

=== busiest 5-min window (all succeeded jobs) ===
 2026-07-25T09:40Z → 6 jobs      2026-07-25T12:15Z → 6 jobs
```

### החישוב

```
תקציב         C = 100 קרדיטים לכל חלון מתגלגל של 5 דקות
                288 חלונות ביממה → 28,800 קרדיטים/יום כתקרה תיאורטית

עלות לקריאה   k = 1     — נמדד היום על GET /inventory/rooms/calendar ועל GET /properties
                k = 1.2 — נמדד ב-#104 על GET /bookings (זהו הצינור הכבד)
                שמרני: k = 1.2 לכל הקריאות

קריאות ביממה
  pull_booking_revisions   287 ג'ובים × 1 קריאה                    = 287
  reconcile_inventory       50 ג'ובים × 1..4 קריאות                =  50 .. 200
  sync_ari_range            30 בקשות (נמדד ישירות ב-request_count) =  30
  full_sync                  1 בקשה                                =   1
  מינציית טוקן               מטמון 24h                              ≈   1
                                                              רצפה = 369  ·  שמרני = 519

צריכה ליממה   רצפה   369 × 1.2 = 442.8 קרדיטים  →  442.8 / 28,800 = 1.5%
              שמרני  519 × 1.2 = 622.8 קרדיטים  →  622.8 / 28,800 = 2.2%

חלון שיא      6 ג'ובים בחלון של 5 דקות ≈ 7 קריאות × 1.2 = 8.4 קרדיטים = 8.4% מ-C
חלון חציוני   1 קריאה = 1.2 קרדיטים = 1.2% מ-C
```

**אימות עצמאי מהחוט:** בכל הקריאות החיות של הריצה הזו `x-five-min-limit-remaining` נע בין 96.8 ל-97.8 מתוך 100 — כלומר בחלון הנוכחי נצרכו 2–3 קרדיטים, מהם 1 היה הקריאה שלי עצמה. תואם לחלוטין לחלון החציוני שחושב.

### מה זה אומר להחלטות הפתוחות

- **webhook (P1-1): לא מוצדק בקרדיטים.** ה-poll צורך ~1.5% מהתקציב. אם webhook מוצדק — זה בגלל **השהיה** (עד 5 דקות עד שביטול נקלט, כפי שנמדד באירוע Moti Grosman: 11:57:43 → 12:02:40), לא בגלל לחץ קרדיטים. אין לתלות את ההצדקה במכסה.
- **ARI read-back כל 20 דקות: אפשרי בנוחות.** #106 גזר 3 קרדיטים למחזור = 0.75 קרדיטים לחלון של 5 דקות = **0.75% מהתקרה**. בתוספת ל-8.4% של חלון השיא הנוכחי — עדיין מתחת ל-10%. אין חסם קרדיטים.
- **הסיכון האמיתי אינו הצריכה השוטפת אלא הפרץ.** `MAX_REQUESTS_PER_RUN = 120` פירושו שריצת drain אחת יכולה לבקש 120 קריאות ≈ 144 קרדיטים — **144% מהחלון**, פי 17 מחלון השיא שנצפה בפועל. זה בדיוק מה ש-#104 בא לפתור, וזה גם מה שהופך את סדר המיזוג לחשוב.

---

## STEP 7 — סיום

| בדיקה | תוצאה |
|---|---|
| `pnpm typecheck` | ✅ נקי |
| `pnpm lint` | ✅ 0 errors (31 warnings, כולן קיימות מראש ב-main) |
| `pnpm build` | ✅ ירוק, כולל `postbuild` (`tsc -p tsconfig.worker.json`) |
| `check:beds24-credit-headers` | ✅ 7 PASSED · A אדום · B2 אדום · ירוק פעמיים |
| קריאה חיה מול הספק | ✅ `remaining` ירד ב-1.0 בדיוק בין הרצות |
| `channel_sync_errors` ב-2 השעות האחרונות | ✅ **0** |
| השומר משאיר עקבות ב-ledger | ✅ **0** (רגל 6 מתגלגלת לאחור ומאמתת זאת) |

לא בוצע דפלוי, לא בוצע מיזוג, לא בוצע `pm2 restart`. פרודקשן לא נגע.

---

## מה ממתין להחלטת רונן

1. **סדר המיזוג מול #104 — ההכרעה החשובה.** #104 מכיל את אותו תיקון כותרות **ועוד** את מנגנון המקצב. ה-PR הזה הוא תת-קבוצה שלו. שתי אפשרויות, ושתיהן קבילות:
   · **למזג את #104 ולסגור את ה-PR הזה** — פחות עבודה, אבל התיקון בן-השורה-אחת נשאר תלוי באישור מנגנון שלם;
   · **למזג את ה-PR הזה קודם ולבצע rebase ל-#104 מעליו** — מפריד "החזרת מדידה" מ"בניית מקצב", כך שהמדידה נכנסת לפרודקשן היום וההחלטה על ההאטה נשארת פתוחה.
   **אין למזג את שניהם כפי שהם** — הם נוגעים באותם שלושה קבצים ויתנגשו. פאזה 3 מחזיקה את הטריאז' של #104; ההכרעה שלה.
2. **התנגשות מספור D94.** #104 מתעד את עצמו כ-D94, ואותו מספר נתפס ע"י `diag/pricing-max-stay` (ריצת maxStay, לא ממוזגת). שני ענפים לא-ממוזגים תובעים את אותו מספר החלטה — צריך למספר מחדש לפני מיזוג.
3. **`channel-http.ts:148`** — קורא `retry-after` בלקוח הרב-ספקי מלפני D91. לא ניתן לאמת בלי 429 מכוון, ולא שונה. אם השכבה הזו מתה לגמרי (D91 הסיר את channex ו-hospitable), מחיקתה היא ניקיון נפרד.
4. **`beds24-admin.ts:498`** — נשען על `details.creditsRemaining` כ-fallback. עכשיו ידוע ש-`/authentication/details` **לעולם** אינו שולח כותרות קרדיט, ולכן ה-fallback הזה מת מעצם הגדרתו. לא הוסר (מינימליות); מועמד לניקוי.

## מה חייב לקרות לפני שפאזה 3 מכריעה על #104

1. **להכריע בסדר המיזוג (סעיף 1 למעלה) לפני כל בדיקה נוספת של #104** — כל טריאז' שמניח ש-#104 בנוי על מדידה מתה יגיע למסקנה שגויה. הוא אינו.
2. **לתקן את מספור D94 בשני הענפים.**
3. **להעריך מחדש את `MAX_REQUESTS_PER_RUN = 120` מול המספרים של STEP 6** — פרץ של 144% מהחלון הוא הסיכון האמיתי, בעוד הצריכה השוטפת היא 1.5%–2.2%. זה משנה את סדר העדיפויות של #104: הערך שלו הוא בהגנה מפרץ, לא בחיסכון שוטף.
4. **לקבל החלטה על השומר של #104**: `check-beds24-credit-backoff.mjs:56-58` נשען בין השאר על `!httpSrc.includes("fivemincreditlimit")` — אסרשן grep על שם הכותרת, בדיוק סוג השומר שלא תפס את הבאג הזה במשך 223 רשומות. הרגליים ההתנהגותיות שלו תקינות; האסרשן הסטטי הזה עדיף שיוחלף.
