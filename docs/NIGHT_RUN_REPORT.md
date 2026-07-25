# NIGHT_RUN_REPORT — ריצת לילה אוטונומית 2026-07-24 → 2026-07-25

**P0-1 ✅ | P0-4 ❌ | P0-2 ✅ | P0-3 ⚠️ | calendar-ui ✅ | closed ⚠️ | system ⚠️ | booking-reports ⚠️ | audit ✅**

מקרא: ✅ נמסר ועומד בביקורת · ⚠️ נמסר, יש פער מתועד שדורש החלטה · ❌ נמסר אך **הוכח שבור** — אסור למזג כמו שהוא.

- בסיס: `origin/main` = `5b171bd`. בנייה נקייה על הבסיס אומתה **ירוקה** לפני תחילת העבודה.
- **עץ הפרודקשן `/var/www/guesthub` נקי ולא נגע בו איש כל הלילה** — עדיין `5b171bd`, `git status --porcelain` ריק.
- אפס דפלוי. אפס `pm2 restart`. אפס מחיקת שורות DB. כל עבודה ב-worktree נפרד.
- 9 PRs פתוחים (#103–#110 + דוח זה), **אף אחד לא מוזג**.

---

## 1. מה קרה בכל משימה

### משימה 1 — P0-1: ניקוי הערות מטעות ✅ · PR [#103](https://github.com/Ronus922/GuestHub/pull/103)

**קבצים:** `src/lib/channel/revisions.ts`, `queue.ts`, `evidence.ts` (הנתיבים תחת `src/`, לא `lib/`).

**ראיה:** אימות diff-הערות-בלבד — 146 שורות שהשתנו, **0** שאינן הערה:
```
git diff -U0 <3 files> | grep '^[+-]' | grep -v '^[+-][+-]' | sed 's/^[+-]//' | sed 's/^[[:space:]]*//' | grep -v '^//' | wc -l
NON-COMMENT changed lines: 0
```
`typecheck` נקי · `lint` 0 errors · `build` exit 0 · `check:code-documentation` PASS · `check:channel-chaos` PASS.

**נשאר פתוח:** התגלה ש-**D78 אינו קיים ב-`DECISIONS.md`** — הכותרות קופצות D77 → D87. עקבותיו היחידים: `045_beds24_provider.sql:2` ו-~20 הערות בקוד. גם D71–D75 ו-D79–D86 חסרים.

**שלושה ממצאים שנחשפו תוך כדי הקריאה** (לא תוקנו, זו הייתה משימת הערות):
`persistBookingRevision` ללא קורא בפרודקשן · `markRevisionAcknowledged` ללא קוראים בכלל · `loadEvidenceLedger` ללא קוראים בכלל. 9ג אישר את כל השלושה עצמאית.

---

### משימה 2 — P0-4: credit-window backoff ❌ · PR [#104](https://github.com/Ronus922/GuestHub/pull/104)

**קבצים:** חדשים `src/lib/channel/beds24-credits.ts`, `scripts/check-beds24-credit-backoff.mjs`; שונו `beds24-http/-ari/-ari-sync/-booking-import`, `circuit-breaker`, `worker`, `admin`, `beds24-admin`, `ari-projection`, `channels/page.tsx`, `package.json`, `DECISIONS.md` (D94).

**מה שכן הושג, וזה אמיתי וחשוב:** ההנחה בטקסט המשימה הייתה שגויה. `beds24-http` **לא** קרא `X-RequestCost`, וה-header שכן קרא — `X-FiveMinCreditLimit-Remaining` — **אינו קיים על החוט**. מדידה חיה (GET בלבד, טוקן קיים, אפס כתיבות):
```
x-request-cost: 1.2   x-five-min-limit-remaining: 97.6   x-five-min-limit-resets-in: 155
```
`creditsRemaining` היה NULL ב-**100%** מ-201 רשומות ledger. **שני סוכנים בלתי תלויים הגיעו לאותה מסקנה** (משימה 4 מדדה שוב, קיבלה `x-request-cost: 1`, ו-`get("x-fivemincreditlimit-remaining")` = null בשלוש קריאות). מד הקרדיטים של Beds24 **מעולם לא עבד** ב-main.

**למה ❌ בכל זאת — שני ממצאים של הסוכן האדוורסרי:**

1. **הענף החדש בולע כשל ספק אמיתי.** `if (creditPause && warnings.length === 0)` לא בודק `failure === null`. הוכח בזמן ריצה עם תשובת 500 + `remaining: 8.0`: `attempts: 0`, `last_error: null`, `conn.last_error: null`, breaker נפתח ל-137 שניות במקום backoff של שגיאת שרת. **טווח שגוי לצמיתות מנסה שוב לנצח ולא מגיע ל-dead-letter — רגרסיה מול main.**
2. **השומר שלו VACUOUS בדיוק בלולאה היקרה.** נמחקו `if (gate.pause) break` ב-`sendCalendarRequests` **וגם** כל ענף השהיית-הקרדיט ב-`drainBeds24AriDirtyRanges` (1,921 תווים) → **"all 11 assertions passed"**. שלושת התרחישים DB-backed הם נכנסים בלבד; ה-drain של 144 קרדיטים לריצה — המניע של כל ה-PR — אינו שמור.

הסוכן המקורי כן הוכיח אדום על שלוש שבירות, אבל כולן בחצי הנכנס. **תיקון נדרש לפני מיזוג.**

**עלות אמיתית:** שתי קריאות GET חיות לפרודקשן Beds24 (~2.4 קרדיטים מתוך 100). אפס כתיבות, אפס מינטינג טוקן.

---

### משימה 3 — P0-2: השלמת שומרי fixture ✅ · PR [#105](https://github.com/Ronus922/GuestHub/pull/105)

**קבצים:** `scripts/check-beds24-ari-drain.mjs` (חדש, 10 טענות), `scripts/check-beds24-quarantine-selfheal.mjs` (חדש, 5 טענות), `package.json`. **אפס שינוי בקוד פרודקשן.**

**ראיה — 13 שבירות מכוונות, כל אחת אדומה ואז ירוקה.** דוגמאות מהפלט האמיתי:
```
AssertionError: no date before today may ever leave the process — Beds24 rejects them per value
  (leaked: 2026-07-14 … 2026-07-18)   5 !== 0
AssertionError: a drain issued a request while the circuit was OPEN   1 !== 0
AssertionError: price1 is MAJOR currency units (a /100 regression yields 5.125)   51250 !== 512.5
AssertionError: only the mapped booking imports   2 !== 1   ← דליפת טננט
```
**הסוכן האדוורסרי אישר עצמאית: שני השומרים PROVEN** — יצאו אדומים על כל שבירה שהוא ניסה.

**נשאר פתוח:** טענה סטטית #1 מקבעת את `x-fivemincreditlimit-remaining` — ה-header שהוכח כלא קיים. היא ירוקה היום כי הקוד קורא את השם הזה, ו**נופלת ברגע ש-#104 ימוזג**. תיקון שורה אחת, אבל חייב להיעשות בתיאום.

---

### משימה 4 — P0-3: ARI read-back reconciliation ⚠️ · PR [#106](https://github.com/Ronus922/GuestHub/pull/106)

**קבצים:** חדשים `src/lib/channel/beds24-ari-readback.ts`, `scripts/check-beds24-ari-readback.mjs`; שונו `worker.ts` (רוכב על ג'וב `reconcile_inventory` הקיים), `beds24-ari-sync.ts` (שני exports), `package.json`, `DECISIONS.md` (D95).

**קצב — גזירה ממדידה, לא בחירה:** עלות `GET /inventory/rooms/calendar` = **1** קרדיט; קריאה אחת מכסה כל 14 החדרים × 14 הימים (`nextPageExists=false`, 3,750 בתים); תקרה 3 בקשות → 3 קרדיטים למחזור = 3% מהתקרה; ב-20 דקות → 0.75 קרדיטים לחלון = 0.75%. **20 דקות אפשריות בפער פי 30 — אין צורך בקצב חדש.**

**קריאה-בלבד הוכחה, כולל נגד תקיפה:** הסוכן האדוורסרי הבריח POST ששומר את הליטרל `"GET"` — נתפס: `READ-ONLY VIOLATED: POST /v2/inventory/rooms/calendar`. 7 שבירות מכוונות, כולן אדומות.

**למה ⚠️:**
- **ההתראה על overbooking חד-פעמית לכל חיי החיבור** — שום קוד בריפו לא סוגר `channel_sync_errors`. סחיפה שנייה אחרי שהראשונה נרשמה לא תייצר התראה חדשה.
- **השומר VACUOUS על תקרת 14 הימים** — בקשה ל-500 יום תוך השארת `BEDS24_READBACK_DAYS = 14` עברה: **"all 11 assertions passed"**. התקרה נטענת כקבוע, אף פעם לא על החוט.
- `minStay`/`maxStay` לא מושווים (ה-API מחזיר ערך ברמת החדר בהיעדר ערך ביומן — אי-אפשר להבחין בין סחיפה לברירת מחדל).

---

### משימה 5 — אבחון `check:calendar-ui` ✅ · PR [#107](https://github.com/Ronus922/GuestHub/pull/107)

**קובץ יחיד:** `docs/CALENDAR_UI_GUARD_DIAGNOSIS.md` (357 שורות). `git status` הוכיח שרק הוא השתנה. **אפס תיקון**, כנדרש.

**שחזור:**
```
AssertionError: the channel row is CONDITIONAL — an internal reservation gets no row, not an empty one
  at scripts/check-calendar-ui.mjs:372   actual: false, expected: true
```

**הקומיט השובר:** `2ab6ae1` · 2026-07-21 · `feat(calendar): pixel-fix desktop toolbar + net-new mobile timeline (D107)` · PR #95. הוא נגע ב-16 קבצים ו**לא** באחד מהם `scripts/check-calendar-ui.mjs`. bisect ידני: `2ab6ae1^` ירוק, `2ab6ae1` אדום.

**פסק דין: בדיקה מיושנת, לא רגרסיה** — צילום הייחוס של הבעלים מראה תג עיפרון אפור על הזמנות פנימיות, השינוי מוצהר ב-PR #95, ומוחל זהה על חמישה משטחים. **הסוכן האדוורסרי אישר עצמאית.**

**תוצר לוואי:** `check:channels-badge` אדום מאותו קומיט, ו**אינו** נפתר ע"י התיקון המוצע — לפחות 3 טענות מיושנות נוספות מוסתרות מאחוריו.

---

### משימה 6 — display_state "סגור" ⚠️ · PR [#108](https://github.com/Ronus922/GuestHub/pull/108)

**כל נתיב בטקסט המשימה היה שגוי.** המיפוי האמיתי: אין `src/lib/constants/room-display.ts`, אין `ROOM_STATE_DISPLAY`, אין `rooms-status.ts`, אין `getRoomsWithDerivedStatus`. הנגזרת היחידה בריפו היא `listBoardRooms()` ב-`src/lib/rooms/service.ts`; המפה היא `STATUS_META` ב-`RoomsScreen.tsx`; "עדכון קבוצתי" הוא פאנל בתוך `/rates`.

**STEP 0 — היכן נשמרת סגירה:** `guesthub.pricing_plan_rates`, עמודת תאריך `date`, עמודת סגירה **`stop_sell boolean NOT NULL DEFAULT false`**, מפתח על `sellable_unit_id` (לא `room_id` ולא `room_type_id`), `tenant_id NOT NULL` קיים ומאונדקס. ה-lead `040_typed_room_closures.sql` **נבדק ונדחה** — `room_closures.kind='ooo'` הוא חסימה פיזית שכבר מוצגת "חסום".

**קבצים:** `src/lib/rooms/service.ts`, `src/app/(dashboard)/rooms/RoomsScreen.tsx`. אפס מיגרציה, אפס שינוי סכימה.

**טוקן:** `STATUS_COLORS.cancelled` (`#F1F3F6/#C9D0DA/#5B6478/#9AA1B4`, `.chip-cancelled`). לא הומצא טוקן. **"ניטרלי-אדמדם" לא כובד** — שתי המשפחות האדמדמות תפוסות ("חסום", "תחזוקה"); שימוש חוזר היה הופך את "סגור" לבלתי-מובחן מחסימה פיזית.

**ראיה על staging (הרצה של `listBoardRooms` האמיתי מול DB 5434):**
```
2026-12-13  room 1000  closed       chip="סגור"       ← (א) סגור בתאריך X
2026-12-14  room 1000  free         chip="פנוי"       ← (א) פנוי בתאריך אחר
2026-12-13  room 1102  occupied     chip="תפוס"       ← (ב) תפוס+סגור → תפוס גובר
2026-12-13  room 1006  maintenance  chip="תחזוקה"     ← (ג)
listBoardRooms(<foreign tenant>) → 0 rooms
```
ניקוי אומת: `stop_sell_true=0`, `total_ppr=6633` ללא שינוי, אפס שורות קיימות נמחקו.

**❗ אין צילום מסך.** `ref/proof/room-closed-state.png` לא נוצר. `/rooms` מאחורי `getActor()`, `HYDRATION_EMAIL`/`PASSWORD` לא מוגדרים, ומינטינג session היה כתיבה ל-Supabase auth של **פרודקשן**. הסוכן סירב ולא זייף תמונה.

**נשאר פתוח:** אין דרך לנקות "סגור" מה-UI; המצב מסתיר מצבי משק בית; רק ה-base plan נבדק; ממצא צדדי — `listBoardRooms` לא מסנן `kind='ooo'`, ולכן סגירת OOS צובעת "חסום" בטעות.

---

### משימה 7 — מקור "מהמערכת" ⚠️ · PR [#109](https://github.com/Ronus922/GuestHub/pull/109)

**טקסט המשימה נכתב מול קוד-בסיס אחר.** אומת ב-`git log --all --diff-filter=A` על 200 רוויזיות בכל הענפים: `SourceBadge.tsx`, `lib/constants/reservation.ts`, `reservation-edit-store.ts`, `lib/types/lookup.ts`, `lib/reports/categories.ts`, `demo-data.ts` — **מעולם לא היו קיימים**. המזהים `SOURCE_MAP`, `BOOKING_SOURCE_OPTIONS`, `SOURCE_LABELS`, `EXTERNAL_SOURCES`, `isExternalSource` — **אפס מופעים אי פעם**.

**מה כן קיים:** הקטגוריה היא `booking_sources` (לא `reservation_source` — לזו אפס שורות), העמודה היא `key` (לא `value`). 7 שורות, טננט אחד. `direct` **אינו** נושא icon `phone` — לא בקוד ולא בנתונים. `handshake` ו-`edit_note` **אינם** במפת `ICONS` הסגורה של `Icon.tsx`.

**מה נמסר:** הדרופדאון מונע-DB, ולכן **ה-seed הוא הפיצ'ר**. מיגרציה `056_source_system.sql` + `manifest.txt` + `scripts/check-reservation-source-system.mjs` + הערה ב-`colors.ts`.

**ראיה — הופעל פעמיים על staging:**
```
BEGIN / INSERT 0 1 / COMMIT     ← ריצה ראשונה
BEGIN / INSERT 0 0 / COMMIT     ← חזרה: אידמפוטנטי
system | מהמערכת | edit_note | #7C3AED | sort_order 23 | t
```
7 השורות הקיימות זהות בית-בית. אילוץ `lookup_items_tenant_id_category_key_key` אומת קיים.

**הוכחה ש-`system` אינו external:** `normalizeVisibleChannel` פוגע ב-`default: return null` → `externalReservation === false`. בנוסף `canEditNow` **בכלל לא מתייעץ** עם `externalReservation`. הסוכן האדוורסרי ניסה למצוא מסלול הפוך ולא מצא — **SOUND**.

**נשאר פתוח:** STEP 1 ו-STEP 4 הם no-op (אין SourceBadge, אין reports UI). `#7C3AED` **אינו** טוקן מאושר (הוויולט של מערכת העיצוב הוא `--info` `#8B5CF6`) — אינרטי היום כי הצבע לא מרונדר, אבל כדאי להחליף.

---

### משימה 8 — דיווחי Booking.com ⚠️ · PR [#110](https://github.com/Ronus922/GuestHub/pull/110)

**13 קבצים, +1755.** מיגרציה `055_booking_com_channel_reports.sql` + manifest; `src/lib/channel/beds24-booking-reports.ts` (הלקוח היחיד), `booking-com-reports-core.ts`, `booking-com-report-rules.ts`, `booking-com-reports.ts` (`"use server"`); `src/components/reservations/BookingComReports.tsx`; `scripts/check-booking-com-reports.mjs` (18 טענות).

**STEP 0 — המזהה:** `guesthub.reservations.external_booking_id` (text), נולד ב-`029_inbound_booking_identity.sql:37-51` — **לא** במיגרציה 054. אומת בשאילתה read-only מול הנתונים החיים (`external_booking_id=90381357`). **תיקון חשוב:** `ota_name` הוא `'booking'`, לא `'Booking.com'` — ולכן `CancelReservationDialog.tsx:163` שמשווה ל-`"BookingCom"` הוא **קוד מת מול נתונים אמיתיים**.

**פער החוזה — טופל נכון.** `waivedFees` **אינו קיים באף מקום ב-apiV2.yaml** (אימתי בעצמי: `grep -i waive` → אפס). סכימת הבקשה = `bookingId` + `action` בלבד. הוחלט: הטוגל נשמר עם תיוג אמת — *"רישום מקומי בלבד… אינו נשלח ל-Booking.com"*. שני שומרים: איסור על השם בנתיב החוט **וגם** אימות בזמן ריצה ש-`Object.keys` = `["action","bookingId"]` בדיוק.

**הסוכן האדוורסרי תקף את זה ונכשל:** הוא ניסה מוטציה אחרי בנייה עם מפתח שנבנה בזמן ריצה — **נתפס**. הטענה מוכחת.

**ראיה — 5 שבירות מכוונות אדומות:**
```
the wire enum contains reportCancel                    ← שם פעולה שגוי
body is an ARRAY of exactly { bookingId, action }      ← waivedFees על החוט
got {"bookingId":…,"action":…,"reason":"operator"}     ← שדה עודף בשם תמים
הזמנה לא נמצאה → חיבור הערוץ… אינו פעיל                 ← ביטול סינון טננט: טננט זר הגיע לשורה
the refused attempt is still ledgered: 0 !== 1         ← ביטול כתיבת היומן
```
→ 18/18 ירוק אחרי שחזור. **הסוכן האדוורסרי אישר: PROVEN.**

**מיגרציה 055 על staging:** staging היה מפגר ב-043; הובא ל-055 → `Done: 12 applied, 57 total.` שני אילוצי CHECK מדויקים, 3 FKs, אינדקס, הרשאה `reservations.channel_report` ל-`super_admin/admin/manager`.

**למה ⚠️:**
- **`#104 + #110 = build שבור.** `beds24-booking-reports.ts:152` קורא `r.creditsRemaining` ש-#104 מוחק → `TS2339`. כל אחד ירוק לבד; המיזוג השני חוסם `deploy:prod`.
- **אין שום מנגנון שמונע דיווח בלתי-הפיך פעמיים.** לחיצה כפולה = שני `reportCancel` ל-Booking.com.
- אין צילום מסך אמיתי; יש רינדור SSR מבודד של הקומפוננטה האמיתית מול ה-CSS ש-`pnpm build` הפיק, ב-7 מצבים, ב-900px ו-390px.
- **אף `POST /channels/booking` חי לא נשלח מעולם** — זו כתיבה אמיתית ל-Booking.com. כל הקריאות בכל הריצות היו מזויפות.

---

## 2. DECISIONS.md מהלילה

שלוש רשומות חדשות, כל אחת בענף אחר → **יתנגשו במיזוג**. הפירוט המלא בענפים.

| D | PR | נושא |
|---|-----|------|
| **D94** | #104 | חלון הקרדיטים: שמות ה-headers נמדדו, הסף נגזר, ה-worker מאט במקום לנסות שוב |
| **D95** | #106 | קריאה חוזרת של ARI: מזהים סחיפה, לא מתקנים; הקצב נגזר ממדידה |
| **D96** | #110 | דיווחי מצב ל-Booking.com: שלוש פעולות, יומן לכל ניסיון, פער חוזה מוצהר |

**משימות 6 ו-7 לא כתבו ל-DECISIONS.md** — במכוון, כדי לא לייצר התנגשות D-number מובטחת בשישה PRs במקביל. הנימוקים שלהן חיים בכותרות המיגרציות, בהערות הקוד ובגוף ה-PR.

**חורים בתיעוד שהתגלו:** D78, D107 ו-**D108 אינם קיימים** ב-`DECISIONS.md` (שמסתיים ב-D93). D71–D75 ו-D79–D86 חסרים גם הם. D108 הוא הכלל שמשימה 8 נשענה עליו לאיסור נתוני כרטיס.

---

## 3. מה דורש החלטה שלך

לפי דחיפות.

1. **`cvv_encrypted` — הפרת PCI-DSS Req. 3.2 חיה בפרודקשן.** ה-API הציבורי כותב CVV **ללא תנאי**, ו-`revealReservationCardAction` מפענח אותו חזרה לדפדפן. 8 מתוך 10 כרטיסים נושאים CVV, 7 מהאתר, החדש נוצר 2026-07-24. `check-cards.mjs:180-187` **אוכף** את זה — CI נועל את ההפרה. שני סוכנים בלתי תלויים הגיעו לזה. **ההנחה בטקסט המשימה ("5 שורות של בדיקה מבוטלת") הופרכה.** לא נגענו.
2. **מפתחות חיים בגיבויי `.env` בעץ הפרודקשן.** `.env.local.bak-roles-2026-07-19` ו-`.env.local.pre-merge.bak` מחזיקים את אותו `CARD_VAULT_KEY` (מפענח כל PAN וכל CVV), `SUPABASE_SERVICE_ROLE_KEY`, ו-DSN של `postgres`. מחיקה בעץ הפרודקשן היא מחוץ למה שהריצה הזו מורשית לעשות. **צריך מחיקה + רוטציה.**
3. **PR #104 אסור למיזוג כמו שהוא** — בולע כשלי ספק אמיתיים והשומר שלו ריק בחצי היוצא.
4. **ביטול OTA משחרר חדר של אורח בצ'ק-אין** (`booking-import.ts:583-622`) — מחלקת הכשל של D93, במסלול שהשומר של D93 לא מכסה.
5. **ספר התשלומים מתקלקל בהחזרים במקבילים** — הוכח על staging. לא נשך רק כי **אף החזר מעולם לא נרשם בפרודקשן**.
6. **`/api/public/*` חשוף לאינטרנט** בניגוד למתועד, עם דלי rate-limit גלובלי יחיד; `create-booking.ts` לא כותב audit.
7. **`check:calendar` אינו בדיקה מיושנת** — `reservations/actions.ts:37` באמת מייבא את שכבת ה-HTTP, עם קריאת רשת 12 שניות בתוך Server Action ללא breaker. הגיע עם D93/PR #102.
8. `#7C3AED` במיגרציה 056 — טוקן לא מאושר, להחליף ל-`--info` `#8B5CF6`?
9. **אין `.github/` ואין `check:all`.** 90+ שומרים ידניים — הסיבה המבנית שארבע בדיקות אדומות הגיעו ל-main.

---

## 4. NIGHT_AUDIT.md — רק החמורים

72 ממצאים, 16 חמור. הפירוט המלא ב-`docs/NIGHT_AUDIT.md`. העשרה הדחופים:

| # | ממצא | מקור |
|---|------|------|
| 1 | `cvv_encrypted` חי — הפרת PCI-DSS 3.2, ו-CI נועל אותה | 9א + 9ג |
| 2 | מפתחות הצפנה חיים בגיבויי `.env` בעץ הפרודקשן | 9א |
| 3 | מרוץ over-refund — הוכח: `SUM(paid) = −20` | 9ב |
| 4 | `recomputePaymentAggregates` lost update — הוכח | 9ב |
| 5 | ביטול OTA משחרר חדר של אורח בצ'ק-אין | 9ב |
| 6 | #104 בולע כשל ספק אמיתי, טווח נצחי | 9ד |
| 7 | #104 + #110 = `TS2339`, build שבור | 9ד |
| 8 | #104 + #105 = שומר אדום לצמיתות | 9ד |
| 9 | `check:channel-chaos` מאשר שער ACK על סמך **הערה** | 9ג |
| 10 | `/api/public/*` חשוף, DoS בדלי גלובלי יחיד | 9א |

**שתי בדיקות חדשות יצאו VACUOUS:** `check:beds24-credit-backoff` (החצי היוצא) ו-`check:beds24-ari-readback` (תקרת 14 הימים). הארבע האחרות — PROVEN.

---

## 5. פקודות דפלוי לפרודקשן

> ⚠️ **אל תריץ את זה לפני שמחליטים על #104.** מיזוג #104 ו-#110 יחד בלי תיקון = `TS2339` → `deploy:prod` נחסם ב-build.

**סדר מיזוג מומלץ.** גל א' בטוח כמו שהוא; גל ב' דורש תיקון קודם.

**גל א' — בטוח למיזוג עכשיו:** #103 · #107 · #108 · #109 · #105
**גל ב' — רק אחרי תיקון:** #104 (בולע כשלים + שומר ריק) → ואז #110 (`creditsRemaining`) → ואז #106

### שלב 0 — לפני הכל
```bash
cd /var/www/guesthub && git status --porcelain          # חייב להיות ריק
git log --oneline -1                                     # רשום את ה-SHA הזה — הוא ה-rollback
docker exec supabase-db pg_dump -U supabase_admin -d postgres -n guesthub \
  > ~/backups/guesthub-$(date +%F-%H%M).sql              # גיבוי לפני מיגרציות
```
**אמת:** `git status` ריק, קובץ הגיבוי > 0 בתים.
**סימן rollback:** אם `git status` אינו ריק — עצור, יש עבודה לא מקומטת בעץ הפרודקשן.

### שלב 1 — מזג את גל א' ב-GitHub
מזג #103, #107, #108, #109, #105 (בסדר הזה). **פתור התנגשויות `package.json` / `manifest.txt` ידנית** — אל תיתן ל-GitHub לבחור.
**אמת אחרי כל מיזוג:** ה-PR הבא עדיין `MERGEABLE`.
**סימן rollback:** `manifest.txt` איבד שורה → `scripts/db/migrate.mjs` יעצור עם `ABORT: <file> is on disk but missing from manifest.txt`.

### שלב 2 — מיגרציה 056 (לפני הדפלוי)
לפרודקשן אין טבלת `guesthub.schema_migrations`; המיגרציות הוחלו ידנית. שתי המיגרציות אידמפוטנטיות.
```bash
cd /var/www/guesthub && git fetch origin && git checkout main && git merge --ff-only origin/main
docker exec -i supabase-db psql -U supabase_admin -d postgres < db/migrations/056_source_system.sql
```
**אמת:**
```bash
docker exec supabase-db psql -U supabase_admin -d postgres -tAc \
  "select key,label,sort_order from guesthub.lookup_items where category='booking_sources' order by sort_order;"
```
צריך להופיע `system|מהמערכת|23` **בנוסף** ל-7 השורות הקיימות, שלא השתנו.
**סימן rollback:** אם שורה קיימת השתנתה או נעלמה — שחזר מהגיבוי. (המיגרציה `INSERT … ON CONFLICT DO NOTHING` בלבד, אז זה לא אמור לקרות.)

### שלב 3 — דפלוי
```bash
cd /var/www/guesthub && PROD_DEPLOY_OK=1 npm run deploy:prod
```
הסקריפט עצמו fail-closed: מוודא `.production-runtime`, ענף `main`, עץ נקי, HEAD = `origin/main`, אפס מיגרציות מחוץ לריליז המאושר, בונה, מפעיל מחדש `guesthub` + `guesthub-channel-worker`, מוודא `pm2 cwd`, שה-worker שורד 6 שניות, שפורט 3007 עונה, ושלוש נתיבים מחזירים < 500.
**אמת:** השורה האחרונה `✓ DEPLOYED commit=… build=… port=3007` ואחריה `pm2: guesthub=online guesthub-channel-worker=online`.
**סימן rollback:** כל `✗ DEPLOY FAILED` — הסקריפט עוצר לפני שהוא נוגע ב-`.next` החי. אם הוא נכשל **אחרי** ה-build:
```bash
cd /var/www/guesthub && git reset --hard <SHA משלב 0> && PROD_DEPLOY_OK=1 npm run build && pm2 restart guesthub guesthub-channel-worker
```

### שלב 4 — אימות אחרי דפלוי
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3007/login    # < 500
pm2 logs guesthub-channel-worker --nostream --lines 60                   # אין crash loop
docker exec supabase-db psql -U supabase_admin -d postgres -tAc \
  "select status,count(*) from guesthub.channel_sync_jobs where created_at > now()-interval '15 min' group by status;"
```
**אמת:** ג'ובים ממשיכים להצליח בקצב הרגיל (poll כל 5 דקות).
**סימן rollback:** עלייה ב-`failed`, או `channel_sync_errors` חדשים — החזר לפי שלב 3.

### שלב 5 — גל ב' (רק אחרי תיקון #104)
מיגרציה 055 מגיעה עם #110:
```bash
docker exec -i supabase-db psql -U supabase_admin -d postgres < db/migrations/055_booking_com_channel_reports.sql
docker exec supabase-db psql -U supabase_admin -d postgres -tAc "select to_regclass('guesthub.booking_channel_reports');"
docker exec supabase-db psql -U supabase_admin -d postgres -tAc \
  "select r.key from guesthub.role_permissions rp
     join guesthub.roles r on r.id=rp.role_id
     join guesthub.permissions p on p.id=rp.permission_id
    where p.key='reservations.channel_report';"
```
**אמת:** הטבלה קיימת; ההרשאה קיימת ל-`super_admin`, `admin`, `manager`.
**סימן rollback:** אחרי #104 — `channel_sync_jobs` שנתקעים ב-`attempts: 0` עם `last_error: null` הם **בדיוק** החתימה של הבאג שהסוכן האדוורסרי הוכיח. אם זה מופיע, החזר את #104.

---

## 6. ניקוי

worktrees של הלילה נשארו לבדיקה שלך:
```
/home/ubuntu/worktrees/{wt-night,night-t1-comments,night-t2-credits,night-t3-fixtures,
                        night-t4-readback,night-t5-calendar-diag,night-t6-closed,
                        night-t7-system-source,night-t8-bcom,night-docs}
```
אחרי המיזוג: `git worktree remove <path>` לכל אחד, ואז `git worktree prune`.
