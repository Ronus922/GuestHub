# GUARD GAPS — פערי שומרים שנחשפו בסגירת 1318

> **הפערים האלה חייבים להיטמע ב-`docs/GUARD_INTEGRITY.md` על ידי רונן אחרי שפאזה 2 נסגרת.** הקובץ ההוא לא נגע בריצה הזו — פאזה 2 רצה עליו במקביל.

ריצה 2026-07-25, worktree `/var/www/wt-1318`. **אפס מחיקות. אפס תיקוני קוד.** כל פער: קובץ:שורה · ראיה מודפסת · תיקון מוצע.
ההקשר המלא ב-`docs/CLOSE_1318.md`.

שלושה פערים הוגדרו מראש; פער #4 נחשף תוך כדי האימות של STEP 4 והוא החמור מביניהם מבחינה תפעולית.

---

## פער #1 — `unmappedRooms` עיוור לחדר שאין לו שורת מיפוי בכלל

**קובץ:שורה:** `src/lib/channel/beds24-ari-payloads.ts:196-199`

```ts
for (const m of mappings) {
  if (!m.localRatePlanId) {
    unmapped.add(m.roomId);
    continue;
  }
```

הלולאה רצה על `mappings` — האוסף שמגיע מ-`loadBeds24Mappings` (`beds24-ari-sync.ts:172-177`), שמסנן `status = 'mapped'`. חדר בלי שורת מיפוי כלל אינו קיים באוסף, ולכן **בלתי-נראה למונה לחלוטין**. המונה סופר רק מיפויים שקיימים וחסר להם `local_rate_plan_id`.

### ראיה

חדר 1318 היה לא-ממופה מ-20/07 עד 25/07 11:58:29. במהלך כל התקופה הזו:

```
=== full_sync evidence ===
 created_at                      │ outcome   │ context
 '2026-07-24 05:39:12.841785+00' │ 'success' │ {"rooms": 14, "unmappedRooms": 0, "blocked": 500, …}
 '2026-07-23 18:39:48.863727+00' │ 'success' │ {"rooms": 14, "unmappedRooms": 0, "blocked": 500, …}
```

`unmappedRooms: 0` בזמן שחדר אמיתי, פעיל, עם שתי הזמנות מאושרות, לא הופץ לאף ערוץ. `rooms:14` הוא היחיד שרומז על משהו — אבל רק אם מישהו יודע בעל-פה שאמורים להיות 15.

### תיקון מוצע

אסרשן כיסוי מיפוי, שמשווה מול מקור האמת ולא מול אוסף המיפויים:

```sql
SELECT r.room_number
FROM guesthub.rooms r
WHERE r.tenant_id = $1 AND r.is_active
  AND NOT EXISTS (
    SELECT 1 FROM guesthub.channel_beds24_room_mappings m
    WHERE m.room_id = r.id AND m.connection_id = $2 AND m.status = 'mapped')
```

`assert.equal(rows.length, 0, "<n> חדרים פעילים ללא מיפוי Beds24 — הם אינם מופצים")`.
במקביל: להוסיף `mappedRooms` / `activeRooms` ל-context של `recordAriEvidence`, כדי ש-`rooms:14` מול `rooms:15` יהיה קריא בלי ידע חיצוני.

---

## פער #2 — `check:beds24-ari` עובר על טווחים שנסגרו `synced` בלי לשלוח כלום

**קובץ:שורה:** `scripts/check-beds24-ari.mjs:19-26` (ו-`:53-56` לשורת ה-note)
**המדיניות שמייצרת את הטווחים:** `src/lib/channel/beds24-ari-sync.ts:523-525` → הסגירה עצמה ב-`:575`

הבדיקה מודדת רק `dr.status <> 'synced'`. טווח שהגיע ל-`synced` יוצא מרדאר הבדיקה — **גם אם אף בקשת HTTP לא נשלחה עבורו**, כי `buildBeds24CalendarRequests` החזיר אפס בקשות והקוד נפל ישירות ל-`UPDATE … SET status='synced'`.

### ראיה

22 טווחים של 1318, revisions 834→1606, כולם `synced`, `attempts=0`, אפס בקשות:

```
=== 1318 ranges on the beds24 connection, split at the mapping timestamp ===
 after_mapping │ c  │ min_rev │ max_rev │ first                           │ last
 false         │ 22 │ '834'   │ '1606'  │ '2026-07-20 12:06:24.410885+00' │ '2026-07-24 06:37:36.138037+00'
```

`check:beds24-ari` עבר ירוק לאורך כל התקופה. בנוסף, הסינון `cc.state = 'active'` (שורות 22, 27, 37) מוריד 66 טווחי `pending` של channex לשורת "note" אינפורמטיבית:

```
=== non-synced ranges tenant-wide ===
 provider  │ state    │ status    │ c
 'channex' │ 'paused' │ 'pending' │ 66
```

שילוב שני הדברים: הבדיקה עוברת גם כשחדר שלם לא מופץ, וגם כש-66 טווחים תקועים לנצח.

### תיקון מוצע

לפצל את המדד: מצב סופי (`synced`) אינו מספיק — צריך גם עדות שנשלח משהו.
בשלב ראשון, בלי מיגרציה, ניתן להישען על ה-ledger:

```sql
SELECT count(*)::int FROM guesthub.channel_evidence_ledger
WHERE scenario_key = 'incremental_sync'
  AND (context->>'claimed')::int > 0
  AND COALESCE((context->>'sentValues')::int, 0) = 0
  AND created_at > now() - interval '24 hours'
```

`assert.equal(c, 0, "<n> ניקוזים תבעו טווחים ולא שלחו דבר")`.
בנוסף, להעלות את 66 טווחי channex משורת note לאסרשן משלו (או לארכב אותם — ראה ממצא 3 ב-`CLOSE_1318.md`).

---

## פער #3 — "ממופה אך שקט": אין שומר שמזהה `succeeded` בלי `sentValues`

**קובץ:שורה:** `src/lib/channel/worker.ts:156-160`

```ts
if (jobType === "sync_ari_range") {
  if (!(await isBeds24Drainable(connectionId))) return { sentValues: 0 };
  const summary = await drainBeds24AriDirtyRanges(sql, conn);
  return { sentValues: summary.sentValues };
}
```

מסלול נוסף באותה משמעות: `beds24-ari-sync.ts:464` — `if (rows.length === 0) return summary;`.
שני המסלולים מחזירים הצלחה. העבודה נרשמת `status='succeeded'`. אין ערוץ שבו "רצתי ולא שלחתי כלום" מובחן מ-"רצתי ושלחתי".

### ראיה

שתי הצורות זו לצד זו ב-`channel_evidence_ledger`, אותו חיבור, אותה דקה:

```
 created_at                      │ outcome   │ requests │ claimed │ sentValues
 '2026-07-25 12:19:14.086424+00' │ 'success' │ 1        │ '1'     │ '1'
 '2026-07-25 12:19:06.903048+00' │ 'success' │ 0        │ '1'     │ '0'
 '2026-07-25 12:19:00.416016+00' │ 'success' │ 0        │ '1'     │ '0'
 '2026-07-25 12:18:51.699010+00' │ 'success' │ 0        │ '1'     │ '0'
```

שלוש שורות `claimed:1, sentValues:0` — טווחים נתבעו, מוצו, ואפס בייטים יצאו. `outcome:'success'` בכולן.
זו בדיוק התסמונת שהוצגה בפרומפט כ"3 מחזורי `sync_ari_range` succeeded בזמן שאפס טווחים זזו".

### תיקון מוצע

1. **בקוד** (לא בוצע): להחזיר סיבה ולא רק מספר — `{ sentValues: 0, reason: 'not_drainable' | 'nothing_due' }` — ולשמור אותה ב-`payload` של `channel_sync_jobs`.
2. **בשומר** (ניתן מיידית, בלי שינוי סכימה): אסרשן על יחס — אם היו טווחים dirty ב-24 השעות האחרונות, חייב להתקיים לפחות ניקוז אחד עם `sentValues > 0`; ורצף של `claimed>0 AND sentValues=0` מעל ספק אחד הוא כשל, לא רעש.

---

## פער #4 — מד הקרדיטים של Beds24 מת. שם ה-header שגוי (נחשף בריצה הזו)

**קובץ:שורה:** `src/lib/channel/beds24-http.ts:74-79`

```ts
function readCreditsRemaining(headers: Headers): number | null {
  const raw = headers?.get?.("x-fivemincreditlimit-remaining") ?? null;
  if (raw === null) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}
```

ההערה מעליו מצהירה: *"The remaining 5-minute-window credit counter is the ONE header value ever surfaced"*. הוא מעולם לא צף.

### ראיה

קריאה חיה ל-`GET /inventory/rooms/calendar` עם wrapper שמדפיס את כל ה-headers שחזרו:

```
X-FiveMinCreditLimit-Remaining (as the code reads it): (header absent)
credit/cost headers Beds24 actually returned:
  x-five-min-limit-remaining=96.8  ·  x-five-min-limit-resets-in=255  ·  x-request-cost=1
```

השם שהקוד מחפש (`x-fivemincreditlimit-remaining`) אינו קיים. השם האמיתי הוא `x-five-min-limit-remaining` — עם מקפים. תוצאה מצטברת:

```
evidence rows: {"total":220,"nonnull":0}
```

**220 רשומות ראיות בטננט. אפס מהן נשאו אי-פעם ערך קרדיט.** בנוסף, `x-request-cost` — עלות הבקשה הבודדת — לא נקרא בשום מקום בקוד, כך שאין מדידה של צריכת קרדיטים לאורך זמן.

זה מבטל בשקט את שכבת ה-observability שעליה נשענת מדיניות ה-PACING כולה (`beds24-ari-sync.ts:52-56`: *"the remaining-credits header is surfaced into the evidence context on every run"*). כל שומר עתידי על תקציב קרדיטים ייבנה מעל שדה שהוא תמיד `null`.

### תיקון מוצע

1. לתקן את שם ה-header ל-`x-five-min-limit-remaining`, ורצוי לקרוא את שניהם (fallback) כדי לשרוד שינוי צד-שרת.
2. לקרוא גם `x-request-cost` ו-`x-five-min-limit-resets-in`, ולהעביר אותם ל-`recordAriEvidence` לצד `creditsRemaining`.
3. שומר: `assert` שלפחות רשומת ראיות אחת ב-24 שעות נושאת `creditsRemaining` לא-null — בדיוק כדי ש-regression כזה לא ישרוד שוב 220 רשומות.

**מדידה ידנית לפרוטוקול (2026-07-25 12:4x):** עלות קריאת GET אחת = 1 קרדיט; נותרו 96.8 מתוך תקרת 100 בחלון 5 הדקות; איפוס בעוד 255 שניות. הרחק מהתקרה — אבל המערכת לא יודעת את זה על עצמה.
