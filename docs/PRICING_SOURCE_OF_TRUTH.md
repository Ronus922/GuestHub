# PRICING — מקור אמת של תמחור

**מקור האמת הוא `guesthub.pricing_plan_rates.price` על תוכנית הבסיס (`is_base`) של יחידת המכירה, שנפתרת דרך `resolveChainNightPrice`. שני מקורות מציגים מספר שאינו משתתף בחישוב: ה-₪850 שבכרטיסי "עדכון קבוצתי" (`room_types.base_price`) — משתתף רק כ-fallback לתאריכים שאין להם שורה יומית, ולכן ל-1318 אינו משתתף כלל; ו-`price1` שמוצג היום ב-Beds24 לחדר 1042 (593.18) — ערך היסטורי תקוע שאינו נגזר מאף שורה קיימת.**

ריצה 2026-07-25, worktree `/var/www/wt-pricing` (ענף `diag/pricing-max-stay`). אבחון קריאה-בלבד: **אפס שינוי קוד, אפס שינוי מחירים.** `tenant_id = 68139d06-58c4-4043-b256-4691f83e1556` בכל שאילתה.

---

## הטבלה

| # | מקור | קובץ:שורה | ערך ל-1318 | משתתף בתמחור |
|---|---|---|---|---|
| 1 | `room_types.base_price` — המספר בכרטיס "עדכון קבוצתי" | קריאה: `src/lib/rates/grid-state.ts:101` · תצוגה: `src/app/(dashboard)/rates/GroupUpdatePanel.tsx:300` | **850** | **לא** — רק fallback לתאריך בלי שורה יומית. ל-1318 יש שורות ב-23/07/2026→30/04/2027, ולכן בטווח הזה 850 לעולם אינו משתתף |
| 2 | `pricing_plan_rates.price` על תוכנית הבסיס `eea48ca8` | כתיבה: `src/lib/rates/service.ts:170-183` · קריאה: `src/lib/rates/effective-state.ts:64-73` | **4,880** | **כן — זהו מקור האמת** |
| 3 | `pricing_plan_unit_rates.price` — overlay של תוכנית tenant × יחידה | `src/lib/channel/beds24-ari-projection.ts:196-206` | **אין שורות** (0 בטננט כולו) | לא — אין מה לקרוא |
| 4 | `pricing_plans.adjustment_value` — תוכניות נגזרות (BG +5%, שבועי −15%, חודשי −30%) | `src/lib/pricing/resolve.ts` דרך `resolveParentChain` | לא רלוונטי | כן, אך רק דרך שרשרת שמתחילה בתוכנית **משויכת** ליחידה |
| 5 | `pricing_plan_units` — שיוך תוכנית ליחידה | בדיקה: `src/lib/channel/beds24-ari-projection.ts:224` | **אין אף שורה** | **חוסם הכל** — `RATE_PLAN_NOT_ASSIGNED` קודם לכל פתרון מחיר |
| 6 | `price1` שנשלח ל-Beds24 | `src/lib/channel/beds24-ari-payloads.ts:219-227` | **לא נשלח** (המטען חסר `price1`) | לא — החדר חסום |
| 7 | `price1` שמוצג היום ב-Beds24 | — (מצב אצל הספק) | **אין** ל-1318 · **593.18** ל-1042 | לא — ערך תקוע משליחה קודמת |

---

## 1. מאיזה שדה נשלף המחיר בכרטיסי "עדכון קבוצתי"

**התשובה: `guesthub.room_types.base_price`.**

השאילתה, `src/lib/rates/grid-state.ts:101`:

```sql
SELECT …, COALESCE(rt.base_price, 0)::float8 AS base_price, …
FROM guesthub.sellable_units su
…
LEFT JOIN guesthub.room_types rt ON rt.id = su.room_type_id
```

הערך זורם `base_price` → `RateGridUnit.basePrice` (`types.ts:130`) → `SuCard.basePrice` (`GroupUpdatePanel.tsx:27,61`) → התצוגה ב-`GroupUpdatePanel.tsx:300`:

```tsx
<span className="gu-price ltr-num">₪{Math.round(c.basePrice)}</span>
```

הערך ל-1318 ומקורו:

```
 room_number │ type                │ card_price │ base_plan  │ assignments
 '1006'      │ '2 חדרי שינה וסלון' │ 850        │ 0a69b523…  │ 4
 '1042'      │ 'חדר שינה וסלון'    │ 680        │ b7e936ae…  │ 0
 '1318'      │ '2 חדרי שינה וסלון' │ 850        │ eea48ca8…  │ 0
 '1329'      │ '2 חדרי שינה וסלון' │ 850        │ 78098606…  │ 4
```

**850 אינו מחיר של 1318.** הוא מחיר הבסיס של **סוג החדר** "2 חדרי שינה וסלון", משותף ל-1006, 1318 ו-1329:

```
 id         │ name                │ base_price │ created_at                      │ updated_at                      │ rooms
 4e7d4b7a…  │ '2 חדרי שינה וסלון' │ 850        │ '2026-07-24 07:03:13.111062+00' │ '2026-07-24 07:03:13.111062+00' │ 3
```

נכתב פעם אחת, 2026-07-24 07:03:13, ולא שונה מאז.

## 2. מה מחזיק את המחיר היומי בפועל

**הטבלה:** `guesthub.pricing_plan_rates` · **העמודה:** `price` · **השיוך:** `pricing_plan_id` → התוכנית שבה `sellable_unit_id = <היחידה> AND is_base` — כלומר תוכנית הבסיס הפרטית של היחידה, לא תוכנית tenant.

הכתיבה: `writeRateCells`, `src/lib/rates/service.ts:170-183` (`INSERT … ON CONFLICT (pricing_plan_id, date) DO UPDATE`).
הקריאה לתמחור: `getRoomPlanRates`, `src/lib/rates/effective-state.ts:64-73` — מאתר את התוכנית ב-`:53-54` (`bp.sellable_unit_id = sur.sellable_unit_id AND bp.is_base AND bp.is_active`).

**ל-1318 יש שורות. הנה כל 30 הימים** (תוכנית `eea48ca8`):

| תאריך | מחיר | max_stay | min_stay_arrival | min_stay_through | stop_sell |
|---|---|---|---|---|---|
| 2026-07-25 → 2026-08-22 (29 ימים) | **4,880** | NULL | NULL | 1 | true |
| 2026-08-23 | **4,880** | NULL | NULL | NULL | true |

כל 30 השורות נושאות `updated_at = 2026-07-25 12:14:52.307687+00` (המחיר) — ו-`stop_sell=true` נכתב מאוחר יותר באותו יום, 12:43:29, בריצת `CLOSE_1318`. הטווח המלא של השורות: 2026-07-23 → 2027-04-30, 282 שורות.

לשם השוואה, 1329 באותם תאריכים:

```
 d            │ price │ max_stay │ min_stay_arrival │ min_stay_through │ stop_sell
 '2026-07-25' │ 800   │ 31       │ null             │ 1                │ false
 … (זהה עד 2026-07-31)
```

## 3. שלושה מספרים לאותו חדר

| מספר | מאיפה | מי כתב | מתי | איזו תוכנית | משתתף בחישוב? |
|---|---|---|---|---|---|
| **850** | `room_types.base_price` של סוג "2 חדרי שינה וסלון" | הגדרת סוג החדר (`room_types`), לא מסך התעריפים | 2026-07-24 07:03:13 | **אף אחת** — זו רמת סוג-חדר, לא תוכנית | **לא**, כל עוד קיימת שורה יומית. משמש כ-fallback ב-`rules.ts:37` וב-`grid-state.ts:216` בלבד |
| **610** | `pricing_plan_rates.price` — הערך **הקודם** | user `db214c1c`, מסך תעריפים → עדכון קבוצתי. `bulk_rate_update_logs` id `702f798c-5d45-4d7b-92bc-f988f27e09e5`, `{"mode":"replace","amount":610}`, 16 יחידות, 24/07→31/12 | 2026-07-24 06:37:34 | `eea48ca8` (בסיס של 1318) | **לא עוד** — נדרס |
| **4,880** | `pricing_plan_rates.price` — הערך **הנוכחי** | אותו user `db214c1c`, אותו מסך. `bulk_rate_update_logs` id `e60f5412-97ca-43ae-82cd-688e4febc277`, `{"mode":"percent_add","amount":700}`, **יחידת 1318 בלבד**, 25/07/2026→28/02/2027 | 2026-07-25 12:14:52 | `eea48ca8` | **כן — זה המספר שמנוע התמחור יפתור**, אילו החדר לא היה חסום |

**איך 610 הפך ל-4,880:** `applyPriceMode` (`src/lib/rates/rules.ts:301-315`):

```ts
const cur = current == null ? basePrice : current;   // current=610 ⇒ 850 לא נכנס
… mode === "percent_add" ? cur * (1 + amount / 100)  // 610 × (1 + 700/100) = 4,880
```

`basePrice` (850) הוא הפרמטר הרביעי ומשמש **רק** כש-`current` הוא `null`. כאן `current=610`, ולכן 850 לא השתתף גם בחישוב הזה. 610 × 8 = 4,880 — מדויק.

## 4. מה מגיע ל-Beds24 כ-`price1`

**המקור המדויק:** `projectBeds24Ari` בונה `rates: [{ occupancy: 1, rate: round2(nightly) }]`, כאשר `nightly` מגיע מ-`resolveChainNightPrice` שמוזן ב-`basePriceRaw`:

```ts
const basePriceRaw =
  baseRow?.price != null ? Number(baseRow.price)                    // pricing_plan_rates.price
  : base && base.basePrice > 0 ? base.basePrice : null;             // ← room_types.base_price כ-fallback
```
(`src/lib/channel/beds24-ari-projection.ts:271-274`)

הבנאי מתרגם ל-`price1` ב-`src/lib/channel/beds24-ari-payloads.ts:219-227`, ומשמיט אותו לחלוטין כשהתא חסום.

**מה נשלח היום ל-1318:** כלום. הרצת הבנאי האמיתי על 30 הימים:

```
blocked reasons over the window: {"RATE_PLAN_NOT_ASSIGNED":30}
requests: 1 · bytes: 97
[{"roomId":710488,"calendar":[{"from":"2026-07-25","to":"2026-08-23","numAvail":0,"minStay":1}]}]
```

אין `price1`. קריאה חיה מ-Beds24 מאשרת: `price1 = null` על כל 30 הימים.

**מה יישלח אם תשויך תוכנית:** `RATE_PLAN_NOT_ASSIGNED` ייעלם, `resolveChainNightPrice` יפתור את `baseRow.price` — ו-**`price1 = 4880` יפורסם ל-Beds24 ולכל ה-OTAs**, על התאריכים שבהם `numAvail=1`. הרשת היחידה שמונעת זאת כרגע היא `stop_sell=true` שנכתב ב-12:43 (219 ימים, עד 28/02/2027) — ומעבר לתאריך הזה אין רשת.

## 5. אותה בדיקה על חדר תקין — 1329

| שלב | מקור | ערך ל-1329 | מקור ל-1318 להשוואה |
|---|---|---|---|
| כרטיס עדכון קבוצתי | `room_types.base_price` | 850 | 850 (זהה — אותו סוג חדר) |
| תוכנית בסיס של היחידה | `pricing_plans` `is_base` | `78098606` | `eea48ca8` |
| מחיר יומי | `pricing_plan_rates.price` | **800** | 4,880 |
| שיוך תוכנית ליחידה | `pricing_plan_units` | **4 שיוכים** | **0 — חוסם** |
| הכרעת הפרויקציה | `beds24-ari-projection.ts:224` | לא חסום | `RATE_PLAN_NOT_ASSIGNED` × 30 |
| `price1` על החוט | `beds24-ari-payloads.ts:221` | **800** | לא נשלח |
| מה Beds24 מציג בפועל | קריאה חיה | **`price1=800`, `numAvail=1`, `maxStay=31`** | `price1=null`, `numAvail=0`, `maxStay=365` |

הקריאה החיה ל-1329 (Beds24 room 707490):

```
 from         │ to           │ numAvail │ price1 │ minStay │ maxStay
 '2026-07-25' │ '2026-08-05' │ 1        │ 800    │ 1       │ 31
 '2026-08-06' │ '2026-08-06' │ 0        │ 800    │ 1       │ 31
 '2026-08-07' │ '2026-08-22' │ 1        │ 800    │ 1       │ 31
 '2026-08-23' │ '2026-08-23' │ 1        │ 610    │ 1       │ 31
```

השרשרת שלמה ומאומתת מקצה לקצה: `pricing_plan_rates.price = 800` → `price1 = 800` אצל הספק. 850 שבכרטיס אינו מופיע בשום מקום בשרשרת — הוכחה ישירה שהוא אינו משתתף.

**ממצא נלווה — מחיר תקוע אצל הספק.** חדר 1042 (Beds24 room 707487) חסום בדיוק כמו 1318 (0 שיוכים), ולכן איננו שולחים לו `price1` כלל. ובכל זאת:

```
 from         │ to           │ numAvail │ price1 │ minStay │ maxStay
 '2026-07-25' │ '2026-08-23' │ 0        │ 593.18 │ 1       │ 365
```

`593.18` אינו נגזר מאף שורה קיימת — המחיר היומי המקומי של 1042 הוא **700**. זהו ערך שנשלח בעבר ונשאר תקוע: **Beds24 שומר את `price1` האחרון עד שנדרס; `numAvail=0` אינו מנקה אותו.** 1318 לא מציג מחיר תקוע רק במקרה — הוא נוצר ב-Beds24 היום ומעולם לא קיבל `price1`.

## 6. היקף — יחידות ללא שיוך `pricing_plan_units`

```
 unit   │ assignments
 '1042' │ 0
 '1318' │ 0
```

**שתי יחידות מתוך 16.** כל 14 האחרות מחזיקות 4 שיוכים כל אחת (BG, שבועי, חודשי, ללא-החזר). אישור עצמאי מ-`channel_evidence_ledger`: ה-full sync של 11:58:39 דיווח `blocked: 1000` = 2 יחידות × 500 ימי אופק.

---

## מסקנות

1. **מקור האמת יחיד:** `pricing_plan_rates.price` על תוכנית הבסיס של היחידה. כל השאר הוא נגזרת, fallback או תצוגה.
2. **הכרטיס ב"עדכון קבוצתי" מציג מספר מטעה.** ₪850 הוא מחיר סוג-החדר, לא מחיר החדר, וכשקיימות שורות יומיות הוא אינו משתתף בשום חישוב — לא בהצעת מחיר, לא ב-`price1`, ולא באחוזים של העדכון הקבוצתי עצמו. מפעיל שמסתכל על הכרטיס ומריץ "+700%" מצפה ל-6,800 ומקבל 4,880.
3. **השיוך `pricing_plan_units` הוא שער חוסם, לא פרמטר.** בהיעדרו שום מחיר אינו נפתר — לא משנה מה כתוב בטבלת התמחור.
4. **Beds24 שומר ערכים ישנים.** `price1` תקוע ב-1042 מוכיח שהמטענים שלנו הם עדכון חלקי: מה שלא נשלח — לא נמחק.

**לא שונה שום מחיר. לא בוצע שיוך. אפס שינוי קוד.**
