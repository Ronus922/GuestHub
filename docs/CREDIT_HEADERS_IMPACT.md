# CREDIT HEADERS — מה התיקון חושף על הענפים הפתוחים

**שתי הנחות הפתיחה של STEP 5 נשללו בראיות. #104 אינו מקצב לפי הכותרת השגויה — הוא תיקן אותה בעצמו ב-2026-07-24. P0-3 (#106) אינו נשען על מדידה מתה — הוא מדד את אותן שלוש הכותרות חי, באותו יום. הענף היחיד שבו מד הקרדיטים מת הוא `main`, ושלושה תיקונים בלתי-תלויים כבר קיימים לו.**

דיווח בלבד. **לא תוקן דבר בענפים האלה, לא בוצע checkout אליהם, ולא נגעתי ב-#104 / #106 / #110 / #112.** כל הראיות נקראו דרך `git show <ref>:<file>` על ה-refs המרוחקים.

---

## 1. #104 — `night/p0-4-credit-backoff`

> feat(channel): Beds24 credit-window backoff — measured headers, derived threshold, real slowdown (D94)

### ההנחה שנבדקה
*"#104 מקצב את ה-worker לפי הכותרת השגויה, ולכן ה-backoff שלו לא יכול להיות מופעל בשום תרחיש."*

### הראיה — ההנחה שגויה

`git show origin/night/p0-4-credit-backoff:src/lib/channel/beds24-credits.ts`, שורות 9-19:

```
//   x-five-min-limit-remaining : 97.6   credits left in this window (FRACTIONAL)
//   x-five-min-limit-resets-in : 155    seconds until the window resets
//   x-request-cost             : 1.2    what THIS call cost
//
// HEADER NAMES ARE MEASURED, NOT GUESSED. Captured live from api.beds24.com on
// 2026-07-24 with the production token (GET /bookings, the poll's own filter
// shape). The name this file used to read — `x-fivemincreditlimit-remaining` —
// does not exist on the wire, which is why every persisted creditsRemaining in
// the evidence ledger was NULL (192 incremental_sync rows + 9 full_sync rows,
// 100% null). Note also that /authentication/details returns NO credit headers
// at all: a missing meter is normal and must never be read as "no credits".
```

וה-diff על ליבת ה-HTTP מסיר את הקורא השגוי לגמרי:

```diff
-function readCreditsRemaining(headers: Headers): number | null {
-  const raw = headers?.get?.("x-fivemincreditlimit-remaining") ?? null;
```

`git diff --stat main origin/night/p0-4-credit-backoff` — 14 קבצים, 885 תוספות, כולל `src/lib/channel/beds24-credits.ts` חדש (208 שורות) ו-`scripts/check-beds24-credit-backoff.mjs` (300 שורות).

### מסקנה
**ה-backoff של #104 קורא את השמות הנכונים ולכן כן יכול להיות מופעל.** הוא אף מגיע לאותה מסקנה על `/authentication/details` שהגעתי אליה עצמאית ב-STEP 1, ומגזר סף מפורש מהמדידה (`reserve = poll(1) + reconcile(4) + 2 in-flight`).

**הסבר חלופי לתופעה שהוצגה** ("השומר של #104 נשאר ירוק אחרי מחיקת כל שער הקרדיטים היוצא"): אם זה נצפה, הסיבה אינה שהשער היה מת מלכתחילה. יש לבדוק את השומר עצמו — אבל **זה בתחומה של פאזה 3 ולא נגעתי בו.** מה שכן ניתן לומר מהראיה: `check-beds24-credit-backoff.mjs:56-58` נשען על אסרשן סטטי

```js
assert.ok(!httpSrc.includes("fivemincreditlimit"),
  "the header name that never existed on the wire is gone from the HTTP core");
```

— grep על שם הכותרת. אסרשן כזה נשאר ירוק כל עוד המחרוזת נעדרת, גם אם השער עצמו הוסר. **זה מועמד ההסבר הסביר, והוא בדיוק סוג האסרשן שהמשימה הזו אסרה על השומר שלי.** לשומר של #104 יש גם רגליים התנהגותיות (stubs עם הכותרות האמיתיות, שורות 81-83 ו-173-175); הבעיה היא באסרשן הסטטי הבודד הזה.

---

## 2. P0-3 / #106 — `night/p0-3-ari-readback`

### ההנחה שנבדקה
*"הקצב שלו נקבע לפי X-RequestCost שלא נקרא. האם גם הוא נשען על מדידה שאינה קיימת?"*

### הראיה — לא. הוא מדד בעצמו

`git show origin/night/p0-3-ari-readback:src/lib/channel/beds24-ari-readback.ts`, שורות 47-55:

```
// CREDITS — the cadence is DERIVED, not chosen (measured live 2026-07-24
//     x-request-cost: 1        x-five-min-limit-remaining: 97.8 → 96.8 → 95.8
//     x-five-min-limit-resets-in: 288
//   NOTE the documented apiV2.yaml spellings (X-RequestCost /
//   X-FiveMinCreditLimit-Remaining) are NOT what the server sends — three
//   consecutive probes moved `x-five-min-limit-remaining` by exactly 1.0 each,
```

והשומר שלו קובע את המספרים כאסרשנים:

```
BEDS24_READBACK_REQUEST_COST = 1        "measured x-request-cost of one read-back call"
BEDS24_CREDIT_CEILING        = 100      "100 credits per rolling 5 minutes"
BEDS24_READBACK_BURST_CREDITS = 3       "page bound × cost = worst case per cycle"
beds24ReadbackCreditsPerWindow(20)      = 0.75   "3 × (5/20) per rolling 5-min window"
```

### מסקנה
**P0-3 נשען על מדידה אמיתית, לא על מדידה חסרה.** יתרה מזו — המדידה שלו מאשרת את שלי באופן בלתי-תלוי: שלוש קריאות רצופות הזיזו את `x-five-min-limit-remaining` ב-1.0 בדיוק כל אחת, וזה בדיוק מה שראיתי בין שתי ההרצות של השומר שלי (97.8 → 96.8). **שתי מדידות עצמאיות, יום זו מזו, מסכימות.** ARI read-back כל 20 דקות = 0.75% מהתקרה — אין חסם קרדיטים.

---

## 3. #110 ו-#112 — נבדקו ונוקו

- **#110** (`night/p2-2-booking-com-reports`) — worktree הטריאז' שלו נקרא `fix/booking-com-reports-credit-meter`, שם שרומז לתלות. **לא נגעתי בענף** בהתאם לחוק ברזל 6. אם הטריאז' שלו נשען על מד קרדיטים, הוא יורש את אותה תלות בסדר המיזוג שבסעיף 4.
- **#112** — מחוץ לתחום במפורש. לא נבדק, לא נגע.

---

## 4. אילו ענפים נשענים על מדידה מתה — התשובה המלאה

| ענף / מצב | קורא את הכותרות הנכונות? | נשען על מדידה מתה? |
|---|---|---|
| **`main`** (פרודקשן היום) | **לא** — `x-fivemincreditlimit-remaining` | **כן.** 223 רשומות ראיות, 0 עם ערך |
| #104 `night/p0-4-credit-backoff` | כן (מדד 24/07) | לא |
| #106 `night/p0-3-ari-readback` | כן (מדד 24/07) | לא |
| `fix/beds24-credit-headers` (ה-PR הזה) | כן (מדד 25/07) | לא |

**אף ענף פתוח אינו נשען על מדידה מתה. main כן.** התיקון קיים בשלושה עותקים בלתי-תלויים ובאף אחד מהם הוא לא הגיע לפרודקשן.

---

## 5. הסדר הנכון

התיקון של הכותרות חייב לקדום לכל בנייה של מקצב מעליו — לא כי המקצב שבור, אלא כדי שההחלטה על ההאטה תישען על מדידה שכבר רצה בפרודקשן ולא על מדידה שנצפתה בענף.

1. **קודם: להחזיר את המדידה ל-main.** בין דרך ה-PR הזה (מינימלי, קריאה ורישום בלבד, שומר נטול-grep) ובין דרך חלקו של #104. ברגע שזה בפרודקשן, `channel_evidence_ledger` מתחיל לצבור `creditsRemaining` ו-`requestCost` אמיתיים.
2. **אחר כך: לבנות את המקצב מחדש על המדידה האמיתית.** הסף של #104 נגזר מ-`k = 1.2` שנמדד בבדיקה חד-פעמית אחת. אחרי שבוע של ראיות בפרודקשן יהיה התפלגות אמיתית — ואפשר יהיה לגזור סף מנתונים ולא ממדגם.
3. **ורק אז: להכריע על webhook (P1-1) ועל קצב ה-read-back.** שני אלה נשענים על תקציב הקרדיטים, וכרגע התשובה מ-STEP 6 היא שהצריכה השוטפת היא 1.5%–2.2% — כלומר **הקרדיטים אינם החסם**, והנימוק חייב להיות השהיה או נכונות, לא מכסה.

**אזהרת מיזוג:** ה-PR הזה ו-#104 נוגעים באותם שלושה קבצים (`beds24-http.ts`, `beds24-ari.ts`, `beds24-ari-sync.ts`) ויתנגשו. אין למזג את שניהם כפי שהם — ההכרעה בסדר שייכת לפאזה 3, שמחזיקה את הטריאז' של #104.
