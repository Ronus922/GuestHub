# פערי שומרים — להטמעה ב-GUARD_INTEGRITY.md

> **קובץ נפרד בכוונה.** `docs/GUARD_INTEGRITY.md` אינו על `main` — הוא tracked על
> הענף `stab/guard-integrity-sweep` (worktree `/var/www/wt-g28`), שהוא עבודה של
> פאזה מקבילה. הריצה הזו **לא נגעה בו**. ההטמעה באחריות רונן, אחרי שפאזות 2/5/6
> נסגרות.

נמדד 2026-07-25 מול `main = 84943858`.

---

## 1. `unmappedRooms` עיוור לחדר בלי שורת מיפוי

**קובץ:** [beds24-ari-payloads.ts:196-199](src/lib/channel/beds24-ari-payloads.ts#L196-L199)

המונה סופר מיפויים **קיימים** שחסרה להם תוכנית תעריף. חדר שאין לו שורה ב-
`channel_beds24_room_mappings` כלל אינו נכנס למערך `mappings`, ולכן אינו נספר,
ואינו מופיע בשום סיכום. חדר שמעולם לא מופה נראה בדיוק כמו חדר שאין מה לפרסם לו.

**ראיה:** 1318 היה החדר האמיתי היחיד שלא הופץ עד 25/07 11:58 — `unmappedRooms`
דיווח 0 לאורך כל התקופה.

**תיקון מוצע:** אסרשן כיסוי — כל `rooms` פעיל של החיבור חייב שורת מיפוי, או
להיספר במפורש כ-`roomsWithNoMapping`.

---

## 2. `check:beds24-ari` עובר על 22 טווחים `synced` שלא שלחו כלום

**קובץ:** [scripts/check-beds24-ari.mjs:19-26](scripts/check-beds24-ari.mjs#L19-L26)

22 טווחים של 1318 (revisions 834→1606) נסגרו `synced` לפני שהחדר מופה — כלומר
בלי שנשלח בייט אחד. השומר עובר. בנוסף הוא מסנן `cc.state = 'active'`, ולכן
**66 טווחי channex pending** על חיבור מושהה יורדים לשורת "note" אינפורמטיבית
במקום להיספר.

**תיקון מוצע:** אסרשן על `status = 'synced'` יחד עם `sent_values = 0`.
(`check:beds24-payload-integrity` שנכנס ב-#114 כבר מכסה את המקרה החי —
"no range is synced by a drain that sent nothing" — אבל לא את החוב ההיסטורי.)

---

## 3. אין שומר על `succeeded` בלי `sentValues` — "ממופה אך שקט"

**קובץ:** [worker.ts:157](src/lib/channel/worker.ts#L157)

`runJob` מחזיר `{ sentValues: 0 }` **בשקט** כשהחיבור אינו drainable, ו-
`drainBeds24AriDirtyRanges` מחזיר summary ריק כשאין שורות. שתי הדרכים נרשמות
כ-`succeeded` והן בלתי-מבחינות זו מזו בדיעבד.

**ראיה:** ראיות ledger מ-25/07 12:18–12:19 מראות `claimed:1, sentValues:0` לצד
`claimed:1, sentValues:1` — שתיהן `succeeded`.

**תיקון מוצע:** אסרשן מול `channel_evidence_ledger` על `claimed > 0 AND
sentValues = 0` בלי סיבה מוצהרת.

---

## 4. השומר של #104 נשען על grep — **תוקן בריצה הזו**

**קובץ:** `scripts/check-beds24-credit-backoff.mjs:56-58` (הגרסה הישנה)

```js
assert.ok(!httpSrc.includes("fivemincreditlimit"),
  "the header name that never existed on the wire is gone from the HTTP core");
```

grep סטטי על **קובץ אחד**. הוא נשאר ירוק לאורך 223 שורות ראיות עם
`creditsRemaining = NULL`, ולא יכול היה לתפוס העברה של השם לקובץ אחר.

**סטטוס:** ✅ הוחלף בארבע אסרשנות התנהגותיות דרך `beds24Request` האמיתי. מוכח
ב-B2: החזרת השמות הישנים כ-aliases **בקובץ אחר** (`beds24-credits.ts`) מאדימה את
הגרסה החדשה — ולא הייתה מאדימה את ה-grep.

---

## 5. השומר של #110 אינו עצמאי — חוק ברזל 11

**קובץ:** [scripts/check-booking-com-reports.mjs:194](scripts/check-booking-com-reports.mjs#L194)

השומר מחיל את מיגרציה `055` בלבד ומניח ששאר הסכימה כבר קיימת, שהיא בבעלות
תפקיד שמאפשר ל-`postgres` ליצור בה, ושהטבלה שהוא יוצר תהיה בבעלותו.

**ראיה — נכשל פעמיים בריצה הזו, שתיהן סביבתיות:**
```
ERROR:  permission denied for schema guesthub
ERROR:  must be owner of table booking_channel_reports
```
בשתיהן הקוד של #110 תקין; מה שהשתנה הוא בעלות התפקיד ב-DB המשותף אחרי ששומר אחר
רץ לפניו. אחרי שחזור השרשרת תחת תפקיד אחיד — 18/18 ירוק.

**המשמעות:** תוצאת השומר תלויה בסדר ההרצה של שומרים אחרים. ירוק אינו מוכיח
שהמיגרציה אידמפוטנטית; הוא מוכיח שהתפקיד במקרה התאים.

**תיקון מוצע:** DB ייעודי + `ensureSchema()` שמשחזר את `db/migrations` בסדר
`manifest.txt`, כמו `check:beds24-payload-integrity` ב-#114.

---

## 6. `ref/` הוא gitignored ומרעיל בנייה מקומית

**קובץ:** [.gitignore:54](.gitignore#L54) — `/ref/`

בנייה של #110 ב-`/home/ubuntu/worktrees/night-t8-bcom` נכשלה עם
`Type error: Property 'externalUniqueId' is missing` בקובץ
`ref/proof/render/entry.tsx` — קובץ **untracked, gitignored**, שריר מ-24/07 23:58,
שאינו חלק מ-#110 ואינו בריפו. Next מרים אותו כי הוא בתוך עץ הפרויקט.

בעץ נקי #110 נבנה ירוק. **מסקנה תפעולית:** בנייה מקומית ב-worktree שמישהו עבד
בו אינה ראיה — בדיוק כמו שכתוב ב-CLAUDE.md על אימות ב-worktree מבודד.

**תיקון מוצע:** או להוציא את `ref/` מ-`tsconfig`/`next` include, או להריץ את
בניית האימות ב-worktree טרי בלבד.

---

## מה **לא** נמצא

**אף שומר לא נכשל ב-B2.** שבע מוטציות B2 הופעלו על שישה שומרים; כולן החזירו
אדום. אין ברשימה הזו שומר שנמצא "ירוק אך ריק".
