# CLOSE 1318 — סגירת פינת חדר 1318 + סגירת אירוע Moti Grosman

**שורש הטווחים התקועים: לא א/ב/ג/ד — ארבעת הטווחים כלל אינם על חיבור Beds24 אלא על חיבור channex המושהה · stop_sell יצא: כן · 1318 סגור בכוונה: כן · Moti: אין באג · פערי שומרים: 4 (3 שהוגדרו + 1 שנחשף בריצה)**

---

ריצה 2026-07-25, worktree `/var/www/wt-1318` (ענף `fix/room-1318-beds24-mapping`). אפס שינוי קוד · אפס מיגרציה · אפס מיזוג · אפס דפלוי · אפס `pm2 restart` · אפס נגיעה בטוקן או בסקופים · אפס שינוי מחיר · אפס שינוי במיפוי.
הכתיבה היחידה בריצה: `stop_sell = true` על תוכנית הבסיס של 1318, דרך `writeRateCells`. פירוט ב-STEP 4.
DB נקרא דרך `DATABASE_URL` מ-`.env.local`; קריאות Beds24 חיות דרך מסלול ה-auth הקנוני (טוקן גישה 24h מטמון, AES-256-GCM תחת `CHANNEL_SECRETS_KEY`). שום סוד לא הודפס. `tenant_id = 68139d06-58c4-4043-b256-4691f83e1556` בכל שאילתה.

**ישויות:** חיבור Beds24 `8365fdc8-b8b6-4db3-9ca7-62db2f1d18e8` · חדר 1318 `6653f7e6-a58e-45d4-9e5e-4e775cff4067` · sellable unit `b4b9a377-289d-46d3-9317-51f4185f8843` · מיפוי `74773074` → property 342449 / room 710488 / rate plan `fee07a5b` (ללא החזר) · תוכנית בסיס `eea48ca8` (`is_base`, unit-scoped).

---

## STEP 1 — למה הטווחים לא מתנקזים

### שאילתת הבחירה של ה-drain, כפי שהיא בקוד

`src/lib/channel/beds24-ari-sync.ts:456-463`:

```sql
SELECT id, room_id, local_rate_plan_id, kind,
       date_from::text AS date_from, date_to::text AS date_to,
       attempts, max_attempts
FROM guesthub.channel_dirty_ranges
WHERE connection_id = ${conn.id} AND status = 'pending' AND next_attempt_at <= now()
ORDER BY revision
LIMIT 500
```

### היא לא בוחרת את ארבעת הטווחים. הפרדיקט המדויק שמוציא אותם: `connection_id`

הרצה מסוננת ל-1318 מול חיבור Beds24 מחזירה **אפס שורות**, כי אין מה לבחור:

```
=== dirty ranges summary on active beds24 conn (8365fdc8) ===
 status   │ c   │ min_rev │ max_rev │ due_now
 'synced' │ 552 │ '693'   │ '1760'  │ 552
```

אפס `pending`. ארבעת הטווחים ה"תקועים" יושבים על חיבור אחר:

```
=== the 4 pending 1318 rows — which connection ===
 id         │ kind           │ date_from    │ date_to      │ status    │ provider  │ state    │ is_active_provider
 3267c699…  │ 'availability' │ '2026-07-08' │ '2026-07-31' │ 'pending' │ 'channex' │ 'paused' │ false
 1dd4e4a3…  │ 'availability' │ '2026-08-06' │ '2026-08-14' │ 'pending' │ 'channex' │ 'paused' │ false
 c3eb3536…  │ 'rates'        │ '2026-07-23' │ '2027-05-01' │ 'pending' │ 'channex' │ 'paused' │ false
 cae65aac…  │ 'restrictions' │ '2026-07-23' │ '2027-05-01' │ 'pending' │ 'channex' │ 'paused' │ false
```

כולם `connection_id = 5e6dba4e-339e-4ab8-bfb0-d37d96b6d8a8` — חיבור **channex**, `state='paused'`, `is_active_provider=false`. סה"כ 66 טווחי channex pending בטננט, הישן מ-20/07 12:06.

הם לא ינוקזו לעולם, בשני מנעולים בלתי-תלויים:
- `ensureDrainJobs` (`worker.ts:187`) מייצר `sync_ari_range` רק עבור `loadDrainableBeds24Connections` — שאילתה שמסננת `provider='beds24' AND is_active_provider`. חיבור channex לא נכנס, ולכן אף עבודה לא נוצרת עבורו.
- גם אילו נוצרה, `runJob` (`worker.ts:175`) זורק `"הספק הוסר מהמערכת — רק Beds24 נתמך"` לכל ספק שאינו beds24 (D91).

**ארבעת הטווחים אינם עדות לתקלה ב-drain. הם שאריות מתקופת Channex.** ראה "ממצא 3" בהמשך.

### חיתוך בין ארבעת החשודים — כל אחד נשלל בנפרד

**א. אי-התאמת rate plan — נשללת.**
בשאילתת הבחירה אין שום פרדיקט על `local_rate_plan_id` ואין join לטבלת המיפוי. הטווח נבחר ללא קשר לתוכנית התעריף שלו. יתרה מזו, הערת המיזוג בקוד (`beds24-ari-sync.ts:475-479`) מצהירה מפורשות שהמיזוג "kind- and plan-insensitive".
עם זאת, אי-ההתאמה **קיימת בפועל** והיא מהותית לסיפור אחר (STEP 4):

| תוכנית | id | סוג | היכן היא חיה |
|---|---|---|---|
| `base` — מחיר בסיס | `eea48ca8` | `is_base`, unit-scoped ל-1318 | מחזיקה את התמחור ב-`pricing_plan_rates` |
| `No_Refuneble` — ללא החזר | `fee07a5b` | `base`, tenant-level | **זו שהמיפוי מצביע עליה** |
| `BG` / `Weekly-rate` / `Monthly-rate` | `8d4c2e8a` / `d71e8c1f` / `f0a97bb8` | `derived_percentage`, בנות של `fee07a5b` | — |

ארבעת הטווחים המלוכלכים נושאים `local_rate_plan_id` שנקבע ע"י ה-outbox, לא ע"י המיפוי; המיפוי דורש `fee07a5b`. אי-ההתאמה לא חוסמת את ה-drain — היא חוסמת את **התמחור** (STEP 4).

**ב. מיפויים בזיכרון התהליך — נשללת.**
`loadBeds24Mappings` נקראת בתוך כל מחזור: `beds24-ari-sync.ts:497` (drain) ו-`:295` (full sync). אין cache, אין משתנה מודול, אין memoization.
אימות מול התהליך הרץ, לא מול ה-DB: ה-worker עלה **2026-07-24 21:02** ולא הופעל מחדש מאז (`pm2 describe`, uptime 15h). המיפוי נוצר **11:58:29** היום. ה-full sync שרץ **11:58:39** — 10 שניות אחריו, באותו תהליך, בלי restart — דיווח `rooms: 15`:

```
=== full_sync evidence ===
 created_at                      │ outcome   │ requests │ context
 '2026-07-25 11:58:39.344743+00' │ 'success' │ 1        │ {"rooms": 15, "blocked": 1000, "sentRanges": 89, …}
 '2026-07-24 05:39:12.841785+00' │ 'success' │ 4        │ {"rooms": 14, "blocked": 500,  "sentRanges": 346, …}
```

התהליך הרץ רואה 15 מיפויים. **לא נדרשת הפעלה מחדש של ה-worker.**

**ג. מדיניות ה-synced-בלי-לשלוח — קיימת, אך אינה הסיבה לתקיעות.**
`beds24-ari-sync.ts:523-525` אכן מסמן טווחים של חדר לא-ממופה כ-`synced` בלי לשלוח. אבל המדיניות פועלת **אחרי** התביעה, על שורות שכבר נבחרו — היא לא מקצרת את הנתיב ולא מונעת בחירה. היא נשענת על `loadBeds24Mappings` שנטענת באותו מחזור (ראה ב'), לא על אוסף ישן. **היא כן הסיבה ל-STEP 2.**

**ד. חותמות זמן — נשללת.**
אין `updated_at` ואין חלון זמן בשאילתה. הפרדיקט הזמני היחיד הוא `next_attempt_at <= now()`, וגם הוא מתקיים בכל ארבעת הטווחים (`due_now = true` בכולם, `attempts = 0`, `last_error_code = null`). הם דחופים לניקוז — רק לא ע"י ה-drain של Beds24.

### "succeeded בלי sentValues" — איך זה נראה מבפנים

שני מסלולים נפרדים מחזירים הצלחה בלי שליחה, ושניהם נרשמים `succeeded`:
1. `worker.ts:157` — `if (!(await isBeds24Drainable(connectionId))) return { sentValues: 0 };` — בשקט, בלי שגיאה.
2. `beds24-ari-sync.ts:464` — `if (rows.length === 0) return summary;` — summary ריק.

ראיות חיות מ-`channel_evidence_ledger` (12:18-12:19 היום), שתי הצורות זו לצד זו:

```
 created_at                      │ outcome   │ requests │ claimed │ sentValues
 '2026-07-25 12:19:14.086424+00' │ 'success' │ 1        │ '1'     │ '1'
 '2026-07-25 12:19:06.903048+00' │ 'success' │ 0        │ '1'     │ '0'
 '2026-07-25 12:19:00.416016+00' │ 'success' │ 0        │ '1'     │ '0'
 '2026-07-25 12:18:51.699010+00' │ 'success' │ 0        │ '1'     │ '0'
```

`claimed:1, sentValues:0` = טווח נתבע, מוצה, ולא נשלח דבר. אף שומר לא מבחין בין השורה הזו לשורה שמעליה. ראה `docs/GUARD_GAPS_1318.md` פער #3.

---

## STEP 2 — 22 הטווחים המסומנים synced כשקר

**מצבם עכשיו:** 22 טווחים של 1318 על חיבור Beds24, revisions 834→1606, כולם `status='synced'`, `attempts=0`, בין 20/07 12:06 ל-24/07 06:37 — כלומר כולם **לפני** יצירת המיפוי ב-11:58:29 היום.

```
=== 1318 ranges on beds24 conn, split at the mapping timestamp ===
 after_mapping │ c  │ min_rev │ max_rev │ first                           │ last
 false         │ 22 │ '834'   │ '1606'  │ '2026-07-20 12:06:24.410885+00' │ '2026-07-24 06:37:36.138037+00'
 true          │ 2  │ '1754'  │ '1755'  │ '2026-07-25 12:14:52.560116+00' │ '2026-07-25 12:14:52.560116+00'
```

כולם נסגרו דרך `beds24-ari-sync.ts:523-525`: החדר לא היה ממופה, `builderMappings` היה ריק, `built.requests.length === 0`, ולכן הקוד נפל ישירות ל-`UPDATE … SET status='synced'` בשורה 575 בלי בקשת HTTP אחת.

**האם המדיניות עדיין חלה עליהם אחרי שהמיפוי קיים:** לא. המדיניות חלה בזמן העיבוד, לא רטרואקטיבית. מאז 11:58:29 כל טווח חדש של 1318 עובר את המסלול המלא — הוכחה בשורות 1754/1755 (`claimed:2, sentValues:1`) ובשורות 1761/1762 של הריצה הזו.

**האם הם ייכנסו אי-פעם לתור:** לא. `status='synced'` הוא מצב סופי; שאילתת התביעה דורשת `status='pending'`. הם לא יחזרו.

**האם זה חוב דאטה:** **לא — החוב כבר נפרע.** ה-full sync של 11:58:39 פרסם מחדש את **כל** אופק ה-500 הימים של 1318 (`rooms:15`, `sentRanges:89`), כך שכל תאריך שאותם 22 טווחים היו אמורים לכסות פורסם מחדש 10 שניות אחרי יצירת המיפוי. אין פער נתונים ואין פעולת תיקון נדרשת.

היקף מדויק לפרוטוקול: 22 טווחים · 11 זוגות rates+restrictions · טווחי תאריכים מ-08/07/2026 עד 01/05/2027 · אפס בקשות HTTP נשלחו · אפס נזק שנותר.

---

## STEP 3 — טבלת המכירה. הצג, אל תשנה

16 הלילות הזמינים פיזית (`sellable_unit_inventory`, `availability=1`), עם המחיר הפנימי ומול מה שהערוץ מפרסם בפועל:

| # | תאריך | יום | מחיר פנימי (תוכנית `base`) | תוכנית שמפורסמת לערוץ | minStay | maxStay | מה Beds24 מקבל |
|---|---|---|---|---|---|---|---|
| 1 | 2026-07-31 | ו׳ | 4,880 | `fee07a5b` (ללא החזר) | 1 | — | `numAvail:0`, ללא מחיר |
| 2 | 2026-08-01 | ש׳ | 4,880 | `fee07a5b` | 1 | — | `numAvail:0`, ללא מחיר |
| 3 | 2026-08-02 | א׳ | 4,880 | `fee07a5b` | 1 | — | `numAvail:0`, ללא מחיר |
| 4 | 2026-08-03 | ב׳ | 4,880 | `fee07a5b` | 1 | — | `numAvail:0`, ללא מחיר |
| 5 | 2026-08-04 | ג׳ | 4,880 | `fee07a5b` | 1 | — | `numAvail:0`, ללא מחיר |
| 6 | 2026-08-05 | ד׳ | 4,880 | `fee07a5b` | 1 | — | `numAvail:0`, ללא מחיר |
| 7 | 2026-08-14 | ו׳ | 4,880 | `fee07a5b` | 1 | — | `numAvail:0`, ללא מחיר |
| 8 | 2026-08-15 | ש׳ | 4,880 | `fee07a5b` | 1 | — | `numAvail:0`, ללא מחיר |
| 9 | 2026-08-16 | א׳ | 4,880 | `fee07a5b` | 1 | — | `numAvail:0`, ללא מחיר |
| 10 | 2026-08-17 | ב׳ | 4,880 | `fee07a5b` | 1 | — | `numAvail:0`, ללא מחיר |
| 11 | 2026-08-18 | ג׳ | 4,880 | `fee07a5b` | 1 | — | `numAvail:0`, ללא מחיר |
| 12 | 2026-08-19 | ד׳ | 4,880 | `fee07a5b` | 1 | — | `numAvail:0`, ללא מחיר |
| 13 | 2026-08-20 | ה׳ | 4,880 | `fee07a5b` | 1 | — | `numAvail:0`, ללא מחיר |
| 14 | 2026-08-21 | ו׳ | 4,880 | `fee07a5b` | 1 | — | `numAvail:0`, ללא מחיר |
| 15 | 2026-08-22 | ש׳ | 4,880 | `fee07a5b` | 1 | — | `numAvail:0`, ללא מחיר |
| 16 | 2026-08-23 | א׳ | 4,880 | `fee07a5b` | 1 | — | `numAvail:0`, ללא מחיר |

14 הלילות החסומים: 25/07–30/07 ו-06/08–13/08 — תואמים במדויק להזמנות **1004** (08/07→31/07) ו-**1006** (06/08→14/08), שתיהן `booking_origin='back_office'`, `status='confirmed'`, `external_booking_id=NULL`, `channel_connection_id=NULL`. Beds24 אינו מצביע עליהן — מאושר.

### מה שנראה לא-מכוון — סימון מפורש

1. **מחיר אחיד לסופי שבוע ולימי חול.** 4,880 זהה בשישי-שבת ובאמצע השבוע. אין תמחור סופ"ש. `min_stay_arrival = NULL` בכל 30 הימים; `min_stay_through = 1` (ב-23/08 גם הוא `NULL`).
2. **`maxStay` לא הוגדר אצלנו — ו-Beds24 מחיל 365 משלו.** אנחנו לא שולחים `maxStay` (הבנאי משמיט אותו כשאין ערך, `beds24-ari-payloads.ts:238`), והקריאה החיה מחזירה `maxStay:365` — ברירת מחדל של Beds24, לא החלטה שלנו. בפועל: אין תקרת שהייה.
3. **המחיר 4,880 עצמו — ראה "ממצא 1" למטה. שונה לפני 20 דקות ולא נדון.**

**לא שונו מחירים. החדר לא נפתח למכירה. זו החלטה של רונן.**

---

## STEP 4 — הפוך את המצב למכוון

### ההנחה שהתהפכה: `numAvail=0` לא היה תאונה

הפרומפט הניח ש"החדר פשוט מעולם לא קיבל ARI". **הוא כן קיבל.** ה-full sync של 11:58:39 כלל אותו (`rooms:15`) ופרסם אותו סגור — בכוונת הקוד, לא בהיעדרו.

הרצה של `projectBeds24Ari` האמיתי (מהעץ המהודר `dist/worker`) על 1318 לחלון 30 הימים:

```
blocked reasons over the window: {"RATE_PLAN_NOT_ASSIGNED":30}
commercial rows: 30 · availability rows: 30 · planId projected: fee07a5b-8d74-4f5a-9466-c6f7818afb8f
```

כל 30 התאריכים: `rates:null`, `stopSell:true`, `blockedReason:'RATE_PLAN_NOT_ASSIGNED'`.

**הסיבה השורשית:** ל-sellable unit של 1318 אין **אף שורה** ב-`guesthub.pricing_plan_units`.

```
=== plan→unit assignments per unit ===
 unit                                             │ assignments
 '1042'                                           │ 0
 '1318'                                           │ 0
 '1006 - Two Bedroom Apartment'                   │ 4
 … (12 יחידות נוספות)                              │ 4
```

`beds24-ari-projection.ts:224` — `else if (!assignment || !assignment.isActive) planBlock = "RATE_PLAN_NOT_ASSIGNED";` — קודם לכל ניסיון לפתור מחיר. לכן המחיר לעולם לא נבדק, לעולם לא נשלח.
אישור עצמאי מה-ledger: `blocked` קפץ מ-500 ל-1000 בדיוק כשמספר החדרים עלה מ-14 ל-15 — שתי יחידות × 500 ימים = שתי היחידות חסרות-השיוך.

**מסקנה: `numAvail=0` היה יציב ודטרמיניסטי, לא מקרי — אבל מהסיבה הלא-נכונה.** זה fail-closed של הקוד, לא כוונה של מפעיל. וה-fail-closed הזה נעלם ברגע שמישהו ישייך תוכנית ליחידה.

### הכתיבה שבוצעה

דרך `writeRateCells` (`src/lib/rates/service.ts:100`) — **אותה פונקציה בדיוק** ש-`bulkUpdateRatesAction` קוראת לה (`src/app/(dashboard)/rates/actions.ts:184`) — בתוך `sql.begin` יחיד:

- יחידה `b4b9a377` · תוכנית **`eea48ca8`** (`is_base`) · **2026-07-25 → 2027-02-28 כולל, 219 תאים**
- patch: `{ stop_sell: true }` **בלבד**. `merge()` (`service.ts:92`) משמר כל שדה שאינו ב-patch.

ההיקף הרחב (ולא 30 יום) אושר ע"י רונן: הוא תואם לטווח שכבר לוכלך ב-12:14 ומונע פער אחרי 23/08.

```
base plan: eea48ca8-885e-4882-ab8e-8b6666d329a4 (base) · unit b4b9a377…
BEFORE: {"rows":219,"stop_sell_true":0,"min_price":4880,"max_price":6400}
cells: 219 (2026-07-25 .. 2027-02-28)
patch keys (must be exactly ['stop_sell']): ["stop_sell"]

WRITTEN. changes: 219 · rows whose price changed: 0
AFTER:  {"rows":219,"stop_sell_true":219,"min_price":4880,"max_price":6400}

dirty ranges created by this write:
 id         │ kind           │ date_from    │ date_to      │ status    │ revision │ created_at
 527cdb3d…  │ 'rates'        │ '2026-07-25' │ '2027-03-01' │ 'pending' │ '1761'   │ '2026-07-25 12:43:29.862016+00'
 3fabd6ff…  │ 'restrictions' │ '2026-07-25' │ '2027-03-01' │ 'pending' │ '1762'   │ '2026-07-25 12:43:29.862016+00'
```

**מה זה שינה על החוט: כלום — וזה מדויק ומכוון.** המטען שה-drain בונה זהה לפני ואחרי, כי `RATE_PLAN_NOT_ASSIGNED` כבר כפה `numAvail:0` ללא מחיר. הרצת `buildBeds24CalendarRequests` האמיתי:

```
requests: 1 · unmapped: 0 · invalidRoomIds: 0 · bytes: 97
[{"roomId":710488,"calendar":[{"from":"2026-07-25","to":"2026-08-23","numAvail":0,"minStay":1}]}]
```

**הערך של הכתיבה הוא בדיוק זה: היא מעבירה את הסגירה מהקוד לנתונים.** היום `stop_sell` מיותר; ביום שבו מישהו ישייך תוכנית ליחידה — הפעולה הטבעית שתפתח את החדר — `stop_sell=true` יחזיק אותו סגור, ופתיחה תהיה פעולה מודעת. הפעולה הפיכה באותו מסלול בדיוק (`stop_sell:false`).

**השמטה מתועדת:** לא נכתבה שורת `bulk_rate_update_logs` / `bulk_rate_update_items`. אלה נכתבים בשכבת ה-action (יחד עם auth ו-`tenantWritableWindow`), לא בשכבת ה-service. השינוי לא יופיע בהיסטוריית "עדכון קבוצתי" במסך התעריפים — הרשומה שלו היא המסמך הזה.

### אימות — שלושתם

**1. קריאה חיה מ-Beds24 (`GET /inventory/rooms/calendar`, room 710488):**

```
### LIVE BEDS24 READ (AFTER) — room 710488, 2026-07-25..2026-08-23
HTTP status: 200
 from         │ to           │ numAvail │ price1 │ minStay │ maxStay
 '2026-07-25' │ '2026-08-23' │ 0        │ null   │ 1       │ 365
days covered: 30 (2026-07-25..2026-08-23) · numAvail=0 on 30/30
NON-ZERO DAYS: none
```

זהה לקריאת ה-BEFORE. `numAvail=0` על 30/30 — מאומת מול המקור, לא מוסק.

**מדידת קרדיטים מול תקרת 100/5min:**

```
x-request-cost=1  ·  x-five-min-limit-remaining=96.8  ·  x-five-min-limit-resets-in=255
```

עלות הקריאה: 1 קרדיט. נותרו 96.8 מתוך 100 בחלון, איפוס בעוד 255 שניות. הרחק מהתקרה.
**אזהרה:** הערך הזה נמדד ע"י wrapper אד-הוק, לא ע"י הקוד. הקוד קורא שם header אחר — ראה "ממצא 4" ו-`GUARD_GAPS_1318.md` פער #4.

**2. הטווחים עברו ל-synced עם sentValues > 0:**

```
 kind           │ status   │ rev    │ updated_at
 'rates'        │ 'synced' │ '1761' │ '2026-07-25 12:43:30.071667+00'
 'restrictions' │ 'synced' │ '1762' │ '2026-07-25 12:43:30.071667+00'

 created_at                      │ outcome   │ requests │ claimed │ sentValues
 '2026-07-25 12:43:30.075760+00' │ 'success' │ 1        │ '2'     │ '1'
```

נוקזו תוך **210 מילישניות**. `claimed:2, sentValues:1` — טווח דחוס אחד יצא בפועל.
**ארבעת טווחי channex נשארו `pending` — זו התנהגות נכונה, לא כשל.** אין להם ואף פעם לא יהיה להם מנקז.

**3. אפס שינוי במחירים ובשאר החדרים:**

```
rows whose price changed: 0
1318 base-plan rows (all dates): {"rows":282,"stop_sell_true":219,"min_price":580,"max_price":6400}
ranges created since rev 1760, by room:  1318 → 2   (אין אף חדר אחר)
dirty ranges on the beds24 connection:   synced → 554,  pending → 0
```

282 שורות תמחור קיימות ל-1318; בדיוק 219 — חלון הכתיבה — נושאות `stop_sell=true`. 63 השורות שמחוץ לחלון לא נגעו. טווח המחירים לא זז.

---

## STEP 5 — סגירת אירוע Moti Grosman

**אין באג. המערכת התנהגה נכון.**

```
 reservation_number │ status      │ check_in     │ check_out    │ cancelled_at │ cancellation_origin
 '1026'             │ 'confirmed' │ '2026-07-28' │ '2026-07-29' │ null         │ null
 external_booking_id │ external_revision_id             │ ota_name  │ total_price
 '90359426'          │ '90359426:2026-07-25T11:57:43Z'  │ 'booking' │ 488
```

ההזמנה מעולם לא בוטלה. הדיווח המקורי נשען על הנחה שגויה: המערכת לא פינתה חדר של הזמנה פעילה — וזו בדיוק ההתנהגות הנכונה.

**הראיה החיה שהנתיב הנכנס עובד**, על אותה הזמנה עצמה:

| שעה | מה קרה |
|---|---|
| 11:57:43 | `modifiedTime` השתנה ב-Beds24 (חתום בתוך `external_revision_id`) |
| 12:02:40.359 | הרוויזיה נקלטה — `reservations.updated_at`, `total_price=488` |
| 12:02:40.359 | הקליטה לכלכה `1130 availability 2026-07-28→2026-07-29` (revision 1751) |
| 12:02:40.546 | ה-drain ניקז אותו — `outcome:'success', claimed:1, sentValues:1` |

מקצה לקצה: **~5 דקות** — בדיוק מרווח ה-poll (`INBOUND_POLL_MINUTES = 5`, `worker.ts:209`) — ועוד 187 מילישניות עד שהזמינות יצאה החוצה.

הפירוט המלא נמצא ב-`docs/DIAG_MOTI_CANCELLATION_CLOSURE.md`, שסוגר את `docs/DIAG_MOTI_CANCELLATION.md` שב-`/var/www/wt-stab`.

---

## STEP 6 — פערי שומרים

נכתבו בקובץ נפרד: **`docs/GUARD_GAPS_1318.md`**. לא נגעתי ב-`docs/GUARD_INTEGRITY.md` ולא ב-`DECISIONS.md` — פאזה 2 רצה עליהם.
שלושת הפערים שהוגדרו מראש + פער רביעי שנחשף בריצה (מד הקרדיטים המת).

---

## שלושה ממצאים — דווחו, לא תוקנו

### ממצא 1 — המחיר 4,880 שנקבע לפני 20 דקות

| | |
|---|---|
| מי | user `db214c1c-ad87-435e-a962-a31b09b1fec4` (אותו חשבון מפעיל שביצע את כל עדכוני 24/07) |
| מתי | **2026-07-25 12:14:52** — 20 דקות לפני תחילת הריצה הזו |
| רשומה | `bulk_rate_update_logs` id `e60f5412-97ca-43ae-82cd-688e4febc277` |
| תוכנית | `eea48ca8` — תוכנית הבסיס של יחידת 1318 |
| היקף | יחידת 1318 **בלבד**, 2026-07-25 → 2027-02-28 |
| הפעולה | `{"price": {"mode": "percent_add", "amount": 700}}` — כלומר **+700%** |
| לפניו | **610** — `bulk_rate_update_logs` id `702f798c-5d45-4d7b-92bc-f988f27e09e5`, 24/07 06:37, `{"mode":"replace","amount":610}`, 16 יחידות |

610 × 8 = 4,880. הדוח הקודם מדד 610 ל-30/30 ימים והמדידה הייתה נכונה — עד 12:14:52 היום.

**זה שינוי שלא נדון.** כרגע הוא בלתי-מזיק בדיוק מסיבה אחת: `RATE_PLAN_NOT_ASSIGNED` מונע מכל מחיר להתפרסם. אם תשויך תוכנית ליחידה — והשיוך הוא הפעולה הטבעית שמישהו יעשה כדי "לתקן" את 1318 — **4,880 ללילה יתפרסם ל-Beds24 ולכל ה-OTAs. זו תקרית תמחור.** ה-`stop_sell` שנכתב ב-STEP 4 הוא הרשת שמונעת בדיוק את זה, אבל הוא נשלט ידנית ואפשר לבטלו באותה קלות.
לא תוקן. החלטת רונן.

### ממצא 2 — חוסר השיוך ב-`pricing_plan_units` הוא השורש

ליחידת 1318 (וליחידת 1042) אין אף שורה ב-`pricing_plan_units`, בעוד 14 היחידות האחרות מחזיקות 4 כל אחת. זה — ולא היעדר ARI — מה שמחזיק את `numAvail=0`.
המיפוי מצביע על `fee07a5b`, שאינה משויכת ליחידה; התמחור יושב על `eea48ca8`, שאינה תוכנית tenant-level ולכן לא נטענת ע"י `projectBeds24Ari` (`beds24-ari-projection.ts:155` — `WHERE … sellable_unit_id IS NULL`).
**לא שייכתי, לא תיקנתי, ולא נגעתי במיפוי — גם כשהוכח ששיוך התעריף בו לא תואם את מקור התמחור.** זו החלטת רונן.

### ממצא 3 — טווחי channex מזהמים את האבחון

66 טווחי `pending` על חיבור channex המושהה (`5e6dba4e`), הישן מ-20/07 12:06. ארבעה מהם על 1318 — והם אלה שהוצגו בפרומפט כ"טווחים תקועים ב-drain של Beds24".
הם מזהמים כל אבחון ARI: `check:beds24-ari` מסנן `cc.state='active'` ולכן מוריד אותם לשורת "note" אינפורמטיבית, בעוד שאילתה ידנית ללא הסינון הזה מציגה אותם כתקלה חיה.
**חומר ל-P4-1 ול-4.4 (Channex zero-trace). נרשם, לא נמחק.**

### ממצא 4 — מד הקרדיטים של Beds24 מת (נחשף בריצה הזו)

`beds24-http.ts:75` קורא `headers.get("x-fivemincreditlimit-remaining")`. Beds24 מחזיר בפועל `x-five-min-limit-remaining` (עם מקפים), לצד `x-request-cost` ו-`x-five-min-limit-resets-in`. שמות שונים ⇒ `readCreditsRemaining` מחזיר `null` תמיד.

```
evidence rows: {"total":220,"nonnull":0}
```

**220 רשומות ראיות בטננט. אפס מהן נשאו אי-פעם ערך קרדיט.** ההערה בקוד מצהירה שזה "the ONE header value ever surfaced" — והוא אף פעם לא צף. `x-request-cost` לא נקרא כלל, ולכן אין מדידה של עלות בקשה בשום מקום. פירוט ב-`GUARD_GAPS_1318.md` פער #4.

---

## 1. מה ממתין להחלטת רונן

1. **טבלת המחירים של STEP 3 — אישור או תיקון.** 4,880 ללילה, אחיד לסופ"ש ולחול, ללא `maxStay` (Beds24 מחיל 365 משלו), `minStay=1`. במיוחד: האם +700% מ-12:14:52 היה מכוון (ממצא 1).
2. **שיוך `pricing_plan_units` ליחידת 1318 — כן או לא.** זה השורש. שיוך יפתח את מסלול התמחור; בלי לתקן קודם את המחיר, הוא יפרסם 4,880. (יחידת 1042 באותו מצב בדיוק.)
3. **פתיחת 1318 למכירה.** `stop_sell=true` על 219 ימים היא כעת סגירה מכוונת. הסרתה = פתיחה. לא בוצעה ולא הומלצה.
4. **תוכנית התעריף במיפוי.** המיפוי מצביע על `fee07a5b` בעוד התמחור על `eea48ca8`. הוכח כממצא, לא תוקן — שינוי מיפוי היה מחוץ לתחום.
5. **66 טווחי channex.** מחיקה / ארכוב / השארה. חומר ל-P4-1 ו-4.4.
6. **הטמעת ארבעת פערי השומרים ב-`GUARD_INTEGRITY.md`** — אחרי שפאזה 2 נסגרת. הקובץ לא נגע בריצה הזו.
7. **הפעלה מחדש של ה-worker: לא נדרשת.** נבדק ונשלל (STEP 1ב). נרשם כאן רק כדי לסגור את השאלה.

## 2. מה נדרש כתיקון קוד ואינו מכוסה בפאזה 5.2

1. **`beds24-http.ts:75` — שם ה-header של הקרדיטים שגוי.** `x-fivemincreditlimit-remaining` → `x-five-min-limit-remaining`; בנוסף לקרוא `x-request-cost`. תיקון של שורה אחת שמחזיר לחיים מד קרדיטים שמעולם לא עבד (220 רשומות, אפס ערכים). **בעל העדיפות הגבוהה ביותר ברשימה** — הוא חוסם כל שומר עתידי על תקציב הקרדיטים.
2. **`worker.ts:157` — `isBeds24Drainable` שקר מוצלח.** החזרת `{sentValues:0}` בשקט כשחיבור אינו drainable אינה מובחנת מניקוז אמיתי. צריך לפחות `logChannelError` ברמת מידע או שדה ייעודי ב-payload של העבודה.
3. **`beds24-ari-sync.ts:575` — סגירה כ-synced בלי שליחה.** צריך להבחין בין "נשלח" ל-"לא היה מה לשלוח", למשל `status='skipped'` או `sent_values` על השורה. (משנה סכימה — דורש מיגרציה, ולכן מחוץ לריצה הזו.)
4. **`beds24-ari-payloads.ts:196-199` — `unmappedRooms` עיוור לחדר בלי שורת מיפוי.** המונה סופר רק מיפויים קיימים חסרי תוכנית. חדר שאינו ב-`mappings` כלל אינו נספר. צריך מונה כיסוי מול `rooms` הפעילים.
5. **`beds24-ari-projection.ts:224` — `RATE_PLAN_NOT_ASSIGNED` נבלע.** הוא נרשם ב-`projection.blocked` ומגיע ל-ledger כמספר מצרפי (`blocked:1000`) בלי לציין אילו חדרים. חדר שלם שנחסם ל-500 יום נראה זהה ל-500 תאריכים מפוזרים. צריך פירוט לפי חדר.

**אף אחד מחמשת אלה לא בוצע בריצה הזו — אפס שינוי קוד, כמתחייב.**
