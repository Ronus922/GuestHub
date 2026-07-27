# ביקורת תמחור — מה מתוך המפרט כבר קיים ב-GuestHub

> **ביקורת קריאה בלבד.** אפס שינויי קוד, אפס מיגרציות, אפס קומיטים, אפס דפלוי.
> נבדק הריפו `Ronus922/GuestHub` בעץ `/var/www/guesthub` בלבד — **לא** `/var/www/pms`.
> בסיס: `main` = `87f0434`. תאריך: 2026-07-26.
> כל שורת ממצא נשענת על `file:line` שנקרא, או על שאילתת `SELECT` בלבד מול
> ה-DB החי. כל מספר שמסומן «נמדד» הגיע משאילתה, לא מהיסק.

---

## 0. תקציר

| # | דרישה | מצב |
|---|-------|-----|
| 1 | LOS discounts applied when pricing (7+/28+) | 🔴 **MISSING** |
| 2 | Price modes: system / manual per-night / manual total | 🟡 **PARTIAL** (1.5 מתוך 3) |
| 3 | Discount modes (5 מצבים) | 🟡 **PARTIAL** (1 מתוך 5) |
| 4 | Balance-due when partially paid | 🟡 **PARTIAL** (עריכה כן, יצירה לא) |
| 5 | VAT toggle · inclusive by default · rate not hardcoded | 🟡 **PARTIAL** (ה-toggle חסר; השיעור *בפועל* מקובע) |
| 6 | Currency selector sourced from settings | 🔴 **MISSING** (אין בורר; ההזמנה כותבת `'ILS'` קשיח) |
| 7 | אותן בקרות תמחור בעריכת חדר/יחידה בודדת | 🔴 **MISSING** |
| 8 | שדות אשראי ניתנים לעריכה במסך עריכת ההזמנה | 🟢 **EXISTS** |
| 9 | פרטי כרטיס נשמרים בהזמנות מערוץ (Booking.com) | 🟢 **EXISTS** (הזנה ידנית) · הערוץ עצמו לא שולח כרטיס |
| 10 | שדה «הערות חיוב» | 🟢 **EXISTS** (ברמת הכרטיס, לא ברמת ההזמנה) |
| 11 | כרטיס מדיניות ביטול + מיקומו מול כרטיס ההערות | 🟢 **EXISTS** — **מעל** כרטיס ההערות |
| 12 | כרטיס גבייה מהערוץ עם CVC | 🟡 כרטיס הגבייה **קיים** · **CVC בערוץ לא קיים ולא ייתכן** |

---

## 1 · LOS discounts actually applied when pricing — 🔴 MISSING

**במנוע אין ולו ענף אחד שתלוי באורך השהייה לצורך מחיר.**

`src/lib/pricing/engine.ts` — לולאת ההרכבה לחדר ([engine.ts:263-516](../src/lib/pricing/engine.ts#L263-L516))
ולולאת הלילות ([engine.ts:423-486](../src/lib/pricing/engine.ts#L423-L486)) לא מסתכלות על
`nights.length` בשום מקום פרט ל:

- [engine.ts:156](../src/lib/pricing/engine.ts#L156) — חלון התמחור (`QUOTE_WINDOW_EXCEEDED`)
- [engine.ts:489](../src/lib/pricing/engine.ts#L489) — הכפלת חיוב אורח נוסף `per_night`

הסכימה הסופית ([engine.ts:518-523](../src/lib/pricing/engine.ts#L518-L523)) היא
`Σ roomSubtotal` בלבד. אין בסיס «לינה בלבד», אין ניכוי, אין הסבר.

**מיגרציה 055 — אין כזו ב-main.** `db/migrations/055_booking_com_channel_reports.sql`
הוא ה-055 של `main`. מיגרציית ה-LOS
(`055_length_of_stay_discounts.sql`, טבלת `guesthub.length_of_stay_discounts`)
קיימת **רק** על ענף מקומי — ראה §ט' למטה.

**נמדד ב-DB החי:** `SELECT to_regclass('guesthub.length_of_stay_discounts')` → **`null`**.
הטבלה לא קיימת בפרודקשן.

### מה כן קיים במקומה, ולמה זה לא עונה על הדרישה

נמדד ב-`guesthub.pricing_plans` (הדייר היחיד):

| code | name | plan_kind | adjustment | default_min_stay |
|---|---|---|---|---|
| `No_Refuneble` | ללא החזר | `base` | — | 1 |
| `Weekly-rate` | תעריף שבועי | `derived_percentage` | **−15** | 7 |
| `Monthly-rate` | תעריף חודשי | `derived_percentage` | **−30** | 30 |
| `BG` | ביטול גמיש | `derived_percentage` | +5 | 1 |

שתי «הנחות אורך השהייה» אכן קיימות — אבל כ**תוכניות תעריף שהמפעיל חייב לבחור
ידנית**. `default_min_stay` הוא **הגבלה**, לא טריגר: הוא נאכף ב-
`planStayRuleViolation` ([resolve.ts](../src/lib/pricing/resolve.ts)) וקורא
`MIN_STAY_NOT_MET` כשהשהות קצרה מדי — הוא לעולם אינו *מפעיל* הנחה.

**המשמעות בפועל:** שהות של 10 לילות שנפתחה על מחיר בסיס (`ratePlanId = null`,
שהוא ברירת המחדל בשני הפאנלים) מקבלת **0 הנחה**. הדרישה «7+ / 28+ מופעל
אוטומטית בתמחור» אינה מתקיימת בשום מסלול.

בנוסף, לפי **D102** ([DECISIONS.md:1203](../DECISIONS.md#L1203)) שלוש התוכניות
המוזלות אינן מתפרסמות לערוצים בכלל — מיפוי Beds24 נושא תוכנית אחת לכל חדר.

---

## 2 · Price modes: system / manual per-night / manual total — 🟡 PARTIAL

| מצב | קיים? | ראיה |
|---|---|---|
| **system price** | 🟢 | המנוע. `calculateReservationPrice` ([engine.ts:124](../src/lib/pricing/engine.ts#L124)) |
| **manual per-night** | 🟡 **רק במסך יצירה** | קלט: [BookingPanel.tsx:698-720](../src/components/reservations/BookingPanel.tsx#L698-L720) |
| **manual total** | 🔴 **לא קיים כלל** | אין שדה, אין מפתח סכימה, אין עמודה |

**manual per-night — הפרטים.** הקלט מוגן הרשאה `reservations.price_override`
([layout.tsx:48](<../src/app/(dashboard)/layout.tsx#L48>) → `canPriceOverride`), ונאכף בשרת
ב-[actions.ts:218](<../src/app/(dashboard)/reservations/actions.ts#L218>) (יצירה) ו-
[actions.ts:405](<../src/app/(dashboard)/reservations/actions.ts#L405>) (עריכה).
המנוע מכבד אותו כמחיר לילה סופי ומדלג על חישוב אורח נוסף
([engine.ts:371-375](../src/lib/pricing/engine.ts#L371-L375), [engine.ts:429-449](../src/lib/pricing/engine.ts#L429-L449)).

**החור: מסך העריכה אינו יכול לקבוע מחיר ידני.** ב-
[EditReservationPanel.tsx:846-848](../src/components/reservations/EditReservationPanel.tsx#L846-L848)
המחיר ללילה מוצג כטקסט לקריאה בלבד, עם תווית «· מחיר ידני» כשקיים. אין `<input>`.
מחיר ידני קיים אמנם **נשמר** בשרת ([actions.ts:418](<../src/app/(dashboard)/reservations/actions.ts#L418>)),
אבל אי אפשר לקבוע אותו, לשנות אותו או לבטל אותו מהמסך שבו עורכים הזמנה קיימת —
כפתור «חזרה למחיר אוטומטי» קיים רק ביצירה ([BookingPanel.tsx:722-736](../src/components/reservations/BookingPanel.tsx#L722-L736)).

**manual total.** `reservation_rooms` מחזיקה `rate_per_night` + `price_total`
([000_init_schema.sql:260-261](../db/migrations/000_init_schema.sql#L260)), אבל
`price_total` תמיד נגזר (לילות × תעריף, או `roomSubtotal` מהמנוע) —
`resolveStayPrice` ב-`lib/rates/rules.ts`. אין נתיב שבו מפעיל מזין סכום כולל.

**אין מושג של «מצב תמחור»** בשום מקום — אין enum, אין בורר, אין עמודה. יש רק
דגל בוליאני `is_manual_rate`.

---

## 3 · Discount modes (5) — 🟡 PARTIAL: 1 מתוך 5

| מצב מבוקש | מצב |
|---|---|
| full price | 🟢 טריוויאלי (הנחה = 0) — אך אין מצב מפורש |
| **amount per reservation** | 🟢 **קיים — היחיד** |
| percent per reservation | 🔴 עמודה מתה (ראה למטה) |
| amount per night | 🔴 לא קיים |
| percent per night | 🔴 לא קיים |

**amount per reservation:**
סכימה [validation/reservation.ts:83](../src/lib/validation/reservation.ts#L83) ו-[:102](../src/lib/validation/reservation.ts#L102) —
`discountAmount: z.number().min(0).max(1_000_000).optional()`.
עמודה [000_init_schema.sql:230](../db/migrations/000_init_schema.sql#L230).
קלט: [BookingPanel.tsx:836-845](../src/components/reservations/BookingPanel.tsx#L836-L845) ו-
[EditReservationPanel.tsx:935-938](../src/components/reservations/EditReservationPanel.tsx#L935-L938) («הנחה (₪)»).
חישוב: `reservationTotal(roomsTotal, discountAmount, extraCharges)` —
[reservation-pricing.ts:314-320](../src/lib/pricing/reservation-pricing.ts#L314-L320), רצפה אחת ב-0.

**`discount_percent` היא עמודה מתה.** קיימת ב-
[000_init_schema.sql:231](../db/migrations/000_init_schema.sql#L231), ו-
`grep -rn discount_percent` על כל הריפו (למעט `node_modules`/`.git`) מחזיר בדיוק
**שני** קבצים: המיגרציה עצמה ו-`PROJECT_OVERVIEW.md`. **אפס קוראים, אפס כותבים**
ב-`src/`, ב-`scripts/` ובשאר `db/`.
**נמדד:** 0 מתוך 38 הזמנות עם `discount_percent > 0` (וגם 0 עם `discount_amount > 0`
ו-0 עם `extra_charges > 0` — מנגנון ההנחה מעולם לא הופעל בפרודקשן).

> ענף ה-LOS (§ט') מוסיף `percent` / `amount_per_night` / `amount_per_stay`,
> אך **רק כסוגי מדרגת LOS** — לא כמצבי הנחה של הזמנה.

---

## 4 · Balance-due field when partially paid — 🟡 PARTIAL

| מסך | מצב | ראיה |
|---|---|---|
| **עריכת הזמנה** | 🟢 קיים, מוצג תמיד | [EditReservationPanel.tsx:1070-1087](../src/components/reservations/EditReservationPanel.tsx#L1070-L1087) |
| **הזמנה חדשה** | 🔴 **חסר** | [BookingPanel.tsx:1016-1026](../src/components/reservations/BookingPanel.tsx#L1016-L1026) — «סה״כ» + `PaymentBadge` בלבד |
| הדפסה / PDF | 🟢 קיים | [print/page.tsx:233-236](<../src/app/reservations/[id]/print/page.tsx#L233-L236>) |

במסך העריכה שלוש קופסאות: «סה״כ» / «שולם» / «יתרה לתשלום». היתרה מחושבת ב-
`formatBalance` ([inventory-rules.ts:105](../src/lib/inventory-rules.ts#L105)) ו**אינה מרוצפת** —
יתרה שלילית מוצגת כ«זיכוי ללקוח» ([EditReservationPanel.tsx:1082-1085](../src/components/reservations/EditReservationPanel.tsx#L1082-L1085)).
מצב התשלום עצמו נגזר ב-`paymentState` ([inventory-rules.ts:67](../src/lib/inventory-rules.ts#L67)) ומוצג
כ-chips ([EditReservationPanel.tsx:883-913](../src/components/reservations/EditReservationPanel.tsx#L883-L913)).

במסך היצירה יש שדה «סכום ששולם» ([BookingPanel.tsx:822-835](../src/components/reservations/BookingPanel.tsx#L822-L835))
ותג מצב — אבל **אין שורת יתרה**. מי שיוצר הזמנה עם תשלום חלקי לא רואה כמה נשאר.

---

## 5 · VAT toggle · inclusive by default · rate NOT hardcoded — 🟡 PARTIAL

### א. inclusive — כן, אבל כי אין חלופה

`priceIncludesVat: true` הוא **ליטרל קשיח** בשתי נקודות היציאה של המנוע:
[engine.ts:107](../src/lib/pricing/engine.ts#L107) ו-[engine.ts:558](../src/lib/pricing/engine.ts#L558).
המע״מ תמיד **מחולץ** מהברוטו ([engine.ts:521](../src/lib/pricing/engine.ts#L521) → `includedVatAmount`).
אין מצב exclusive בשום מקום. «inclusive by default» מתקיים — אך לא כברירת מחדל
הניתנת לשינוי.

### ב. השיעור לא מקובע *בקוד* — אבל **בפועל הוא כן**

הצנרת נכונה: המנוע קורא `settings->>'vat_rate'`
([engine.ts:138](../src/lib/pricing/engine.ts#L138), [engine.ts:145](../src/lib/pricing/engine.ts#L145)),
וכך גם `getTenantVatRate` ([settings.ts:11-16](../src/lib/settings.ts#L11-L16)).
מסך ההגדרות שומר אותו ([VatSection.tsx:30-38](<../src/app/(dashboard)/settings/VatSection.tsx#L30-L38>)),
בטווח 0–50 עם עד שתי ספרות ([vat.ts:6-24](../src/lib/vat.ts#L6-L24)).

**🔴 נמדד בפרודקשן: המפתח `vat_rate` פשוט לא קיים.**
`SELECT jsonb_object_keys(settings) FROM guesthub.tenants` מחזיר בדיוק שלושה מפתחות:
`extra_guest`, `business_profile`, `ops_notification_email`.
`settings->>'vat_rate'` → **`NULL`**.

לכן כל ציטוט מחיר בפרודקשן נופל ל-`?? DEFAULT_VAT_RATE`
([engine.ts:145](../src/lib/pricing/engine.ts#L145)), כלומר לקבוע
`DEFAULT_VAT_RATE = 18` ב-[vat.ts:8](../src/lib/vat.ts#L8).
מיגרציה [007_phase3_tenant_settings.sql:19-20](../db/migrations/007_phase3_tenant_settings.sql#L19-L20)
אמורה הייתה לזרוע 18 — המפתח אינו שם היום. **השיעור החי הוא קבוע קוד, לא הגדרה.**
מסך ההגדרות עדיין יכתוב אותו בשמירה ראשונה, אך עד אז «ניתן להגדרה» הוא דקורטיבי.

### ג. Toggle — 🔴 לא קיים

- **אין** מתג מע״מ ברמת ההזמנה בשום פאנל. חיפוש `tax_exempt`/`taxExempt` ב-`src/`
  מחזיר ארבעה קבצים בלבד, אף אחד מהם אינו רכיב UI.
- העמודה `reservations.tax_exempt` קיימת ([000_init_schema.sql:233](../db/migrations/000_init_schema.sql#L233)),
  והפונקציה הנכונה קיימת: `includedVatForReservation(gross, rate, taxExempt)`
  ([vat.ts:41-43](../src/lib/vat.ts#L41-L43)).
- **הכותב היחיד** של העמודה הוא [israel-market/actions.ts:33](../src/lib/israel-market/actions.ts#L33) —
  ול-`src/lib/israel-market/` **אפס מייבאים** בכל `src/`. קוד מת, בלתי נגיש מה-UI.
- **וגם אילו הדגל היה נדלק, המסכים היו מתעלמים ממנו:** שלושת משטחי התצוגה קוראים
  ל-`includedVatAmount` הישיר ולא ל-`includedVatForReservation` —
  [EditReservationPanel.tsx:871](../src/components/reservations/EditReservationPanel.tsx#L871),
  [BookingPanel.tsx:753](../src/components/reservations/BookingPanel.tsx#L753),
  [booking-doc-data.ts:186](../src/lib/pdf/booking-doc-data.ts#L186).
  הזמנה פטורת-מע״מ עדיין תציג מע״מ בפאנל, בכרטיס וב-PDF.
- **נמדד:** 38/38 הזמנות עם `tax_exempt = false`. הנתיב מעולם לא הופעל.

### ד. מתג מע״מ שכן קיים — ולא מחובר לכלום

`extra_guest.tax_mode` («כולל מע״מ» / «לפי הגדרת המע״מ») —
[ExtraGuestSection.tsx:118-128](<../src/app/(dashboard)/settings/ExtraGuestSection.tsx#L118-L128>),
נשמר ומאומת ([validation/commercial.ts:30](../src/lib/validation/commercial.ts#L30),
[commercial/extra-guest.ts:128](../src/lib/commercial/extra-guest.ts#L128)),
וערכו בפרודקשן `"inclusive"`.
`grep tax_mode` על `src/lib/pricing/` ועל `src/lib/commercial/room-pricing.ts` → **אפס תוצאות**.
המתג נשמר ואינו נקרא בשום חישוב.

---

## 6 · Currency selector sourced from settings — 🔴 MISSING

**מקור האמת קיים ונקרא; הבורר לא קיים; וההזמנה עוקפת את שניהם.**

- המנוע קורא `tenants.currency` ([engine.ts:136-144](../src/lib/pricing/engine.ts#L136-L144))
  ופוסל אי-התאמה עם `CURRENCY_MISMATCH` ([engine.ts:150-151](../src/lib/pricing/engine.ts#L150-L151)).
  `getTenantCurrency` — [settings.ts:20-24](../src/lib/settings.ts#L20-L24).
- **אין בורר מטבע בשום מסך.** `grep "מטבע"` על כל `src/**/*.tsx` מחזיר תצוגות בלבד:
  [ExtraGuestSection.tsx:82](<../src/app/(dashboard)/settings/ExtraGuestSection.tsx#L82>)
  («המטבע נקבע לפי הגדרת המטבע הקנונית של הנכס»),
  [SimulatorPanel.tsx:392](<../src/app/(dashboard)/rate-plans/SimulatorPanel.tsx#L392>) (תווית),
  [Beds24Section.tsx:413,436](<../src/app/(dashboard)/channels/Beds24Section.tsx#L413>) (התאמה לספק).
  אין `updateCurrencyAction`, אין select, אין שדה.
- **🔴 ההזמנה כותבת `'ILS'` קשיח:** [actions.ts:265](<../src/app/(dashboard)/reservations/actions.ts#L265>)
  — `INSERT ... currency ... VALUES (..., 'ILS', ...)`, ולא `tenant.currency`.
  דייר במטבע אחר יקבל שורות ILS.
- **נמדד:** `tenants.currency = 'ILS'`, וכל 38 ההזמנות ב-ILS. הפער לא נצפה בשטח.

---

## 7 · אותן בקרות תמחור בעריכת חדר/יחידה בודדת — 🔴 MISSING

**`StayEditor.tsx` — עורך החדר הבודד, המשמש את *שני* המסלולים — אינו מכיל
ולו בקרת תמחור אחת.**
([StayEditor.tsx](../src/components/reservations/StayEditor.tsx), 339 שורות: תאריכים,
מונים לתפוסה, בורר חדר, אורח לחדר.) משטח המחיר היחיד שלו הוא שורת ציטוט
**לקריאה בלבד**: [StayEditor.tsx:235-242](../src/components/reservations/StayEditor.tsx#L235-L242).

הבקרות יושבות בכרטיס התמחור של הפאנל העוטף, והן **אינן זהות בין המסלולים**:

| בקרה | הזמנה חדשה | עריכת הזמנה | עורך חדר בודד |
|---|---|---|---|
| בורר תוכנית תעריף | 🟢 [BookingPanel.tsx:676-696](../src/components/reservations/BookingPanel.tsx#L676-L696) | 🟢 [EditReservationPanel.tsx:826-845](../src/components/reservations/EditReservationPanel.tsx#L826-L845) | 🔴 |
| מחיר ידני ללילה | 🟢 [BookingPanel.tsx:698-720](../src/components/reservations/BookingPanel.tsx#L698-L720) | 🔴 קריאה בלבד | 🔴 |
| חזרה למחיר אוטומטי | 🟢 [BookingPanel.tsx:722-736](../src/components/reservations/BookingPanel.tsx#L722-L736) | 🔴 | 🔴 |
| הנחה | 🟢 [BookingPanel.tsx:836-845](../src/components/reservations/BookingPanel.tsx#L836-L845) | 🟢 [EditReservationPanel.tsx:935-938](../src/components/reservations/EditReservationPanel.tsx#L935-L938) | 🔴 |

הערה: החלפת תוכנית התעריף ביצירה מאפסת מחיר ידני
([BookingPanel.tsx:685](../src/components/reservations/BookingPanel.tsx#L685)); בעריכה היא רק מסמנת
לתמחור-מחדש בשרת ([EditReservationPanel.tsx:826-827](../src/components/reservations/EditReservationPanel.tsx#L826-L827)).

---

## 8 · שדות אשראי ניתנים לעריכה במסך עריכת ההזמנה — 🟢 EXISTS

הרכיב הקנוני היחיד `CardFields` נטען ממסך העריכה ב-
[EditReservationPanel.tsx:1001-1067](../src/components/reservations/EditReservationPanel.tsx#L1001-L1067).

**מה ניתן לעריכה** ([CardFields.tsx:310-426](../src/components/reservations/CardFields.tsx#L310-L426)):
שם בעל הכרטיס · מספר כרטיס · תוקף · **CVV** · תעודת זהות · **הערות חיוב**.

**מתי:** מוכרע ב-`resolveCardMode` ([card-rules.ts:226-238](../src/lib/card-rules.ts#L226-L238)) —

| מצב | עריכה |
|---|---|
| `fresh` (הזמנה פנימית, אין כרטיס) | 🟢 ישירות |
| `manual` (בחירה מפורשת «החלף כרטיס» / «הזנת כרטיס ידנית במקום») | 🟢 |
| `existing` (כרטיס שמור / ערבות ערוץ) | קריאה בלבד עד לחיצה על ה-toggle ([CardFields.tsx:492-497](../src/components/reservations/CardFields.tsx#L492-L497)) |
| `external_unavailable` | קריאה בלבד + אותו toggle |

**הרשאה:** `payments.card_manage` → `canManageCard` (`canSaveCard && canEditNow`),
[EditReservationPanel.tsx:436](../src/components/reservations/EditReservationPanel.tsx#L436), ונאכף בשרת ב-
[card-actions.ts:122](<../src/app/(dashboard)/reservations/card-actions.ts#L122>).
הזמנה מבוטלת = היסטוריה, לקריאה בלבד ([EditReservationPanel.tsx:421](../src/components/reservations/EditReservationPanel.tsx#L421)).
כפתור השמירה מופיע רק בשני המצבים הניתנים לעריכה
([EditReservationPanel.tsx:1053-1065](../src/components/reservations/EditReservationPanel.tsx#L1053-L1065)).

**הערה:** בורר «מקור פרטי הכרטיס» מוזכר בתיעוד הרכיב
([card-rules.ts:112-113](../src/lib/card-rules.ts#L112-L113)) אך **אינו מרונדר** —
`CardDraft.source` נשאר תמיד `"back_office"` ([CardFields.tsx:75](../src/components/reservations/CardFields.tsx#L75)).

---

## 9 · פרטי כרטיס נשמרים בהזמנות מערוץ (Booking.com) — 🟢 EXISTS (ידנית)

**שמירה ידנית על הזמנת OTA — עובדת, ואין שום חסימה.**
`saveReservationCardAction` אינה בודקת מקור הזמנה: היא מאמתת הרשאה, מאמתת PAN/תוקף,
מצפינה ומבצעת upsert על `reservation_id`
([card-actions.ts:162-205](<../src/app/(dashboard)/reservations/card-actions.ts#L162-L205>)).
נשמרים: `pan_encrypted`, `cvv_encrypted`, `holder_id_number`, `billing_notes`
([card-actions.ts:147](<../src/app/(dashboard)/reservations/card-actions.ts#L147>),
[:157](<../src/app/(dashboard)/reservations/card-actions.ts#L157>),
[:173](<../src/app/(dashboard)/reservations/card-actions.ts#L173>)).
הנתיב מה-UI: הזמנת ערוץ ללא כרטיס → `external_unavailable`
([card-rules.ts:290-310](../src/lib/card-rules.ts#L290-L310)) → toggle «הזנת כרטיס ידנית במקום»
→ «שמירת כרטיס».

**🔴 אבל הערוץ עצמו מעולם לא שלח פרטי כרטיס. נמדד:**

| מדד | ערך |
|---|---|
| כרטיסים שמורים ב-`reservation_cards` | 12 |
| מתוכם `source = 'channel'` | **0** (back_office 3, website 9) |
| שורות `channel_booking_revisions` | 15 |
| מתוכן עם `card_meta` | **0** |
| הזמנות `booking_origin = 'ota'` | 7 |

כלומר: המסלול `ingestChannelCard` ([card-ingest.ts](../src/lib/channel/card-ingest.ts))
קיים ומחווט, אך לא רץ מעולם בפרודקשן. לא נבדק כאן מדוע — ייתכן שהחשבון אינו
מקבל PAN מ-Beds24, וייתכן ש`CARD_VAULT_KEY` לא היה קיים בזמן קליטה (הפונקציה
נכשלת שקט עם `vault_unconfigured`, [card-ingest.ts:37](../src/lib/channel/card-ingest.ts#L37)).

### שני פגמים סמויים באותה טבלה (טרם התממשו — 0 כרטיסי ערוץ)

1. **CVV ישן נשאר צמוד ל-PAN חדש.** `ingestChannelCard` מבצע
   `ON CONFLICT (reservation_id) DO UPDATE` ומחליף `pan_encrypted`, `last4`, `exp_*`,
   `brand`, `source` — אך **אינו נוגע ב-`cvv_encrypted`**
   ([card-ingest.ts:58-74](../src/lib/channel/card-ingest.ts#L58-L74)).
   קליטת ערוץ מעל כרטיס שהוזן ידנית תשאיר את ה-CVV הישן על כרטיס אחר לגמרי.
2. **חלון חיוב ישן שורד החלפה ידנית.** `saveReservationCardAction` מאפסת
   `source_channel` ו-`is_virtual` ([card-actions.ts:186-187](<../src/app/(dashboard)/reservations/card-actions.ts#L186-L187>))
   אך משאירה `available_from`/`available_until` — שיוצגו כ«חלון חיוב» של הכרטיס החדש
   ([card-rules.ts:337](../src/lib/card-rules.ts#L337) → [CardFields.tsx:436-444](../src/components/reservations/CardFields.tsx#L436-L444)).

---

## 10 · שדה «הערות חיוב» — 🟢 EXISTS

| שכבה | ראיה |
|---|---|
| UI (textarea, 500 תווים, 3 שורות) | [CardFields.tsx:412-426](../src/components/reservations/CardFields.tsx#L412-L426) |
| טיוטה | `CardDraft.billingNotes` — [CardFields.tsx:66](../src/components/reservations/CardFields.tsx#L66) |
| מודל תצוגה | [card-rules.ts:179](../src/lib/card-rules.ts#L179), [:276](../src/lib/card-rules.ts#L276), [:332](../src/lib/card-rules.ts#L332) |
| שרת | [card-actions.ts:137](<../src/app/(dashboard)/reservations/card-actions.ts#L137>), [:174](<../src/app/(dashboard)/reservations/card-actions.ts#L174>), [:188](<../src/app/(dashboard)/reservations/card-actions.ts#L188>) |
| DB | `reservation_cards.billing_notes` |

**נמדד:** 2 מתוך 12 כרטיסים נושאים הערות חיוב — השדה בשימוש בפועל.

**סייג היקף:** ההערה שייכת ל**כרטיס**, לא להזמנה. כרטיס אחד לכל הזמנה
(`ON CONFLICT (reservation_id)`), ולכן בפועל יש הערת חיוב אחת להזמנה — אבל היא
נעלמת יחד עם הכרטיס אם הוא נמחק, ואינה קיימת כלל בהזמנה בלי כרטיס.
ערבות ערוץ מרונדרת עם `billingNotes: ""` ([card-rules.ts:362](../src/lib/card-rules.ts#L362)).

---

## 11 · כרטיס מדיניות ביטול — 🟢 EXISTS · יושב **מעל** כרטיס ההערות

סדר הכרטיסים בעמודה הראשית של מסך העריכה:

```
…
BookingCard  "תמחור ותשלום"            EditReservationPanel.tsx:809-1102
BookingCard  "מדיניות ביטול (בעת ההזמנה)"  EditReservationPanel.tsx:1107-1111   ← כאן
BookingCard  "הערות להזמנה"             EditReservationPanel.tsx:1115-1139
```

- הכרטיס: [EditReservationPanel.tsx:1104-1111](../src/components/reservations/EditReservationPanel.tsx#L1104-L1111),
  מרונדר דרך `CancellationSnapshotView` ([EditReservationPanel.tsx:1291-1297](../src/components/reservations/EditReservationPanel.tsx#L1291-L1297))
  ו-`describeCancellationTier` ([EditReservationPanel.tsx:11](../src/components/reservations/EditReservationPanel.tsx#L11)).
- המקור הוא **תצלום קפוא בזמן ההזמנה**: `reservations.cancellation_policy_snapshot`
  (מיגרציה 034), נכתב ב-`resolveCancellationSnapshot`
  ([actions.ts:250-254](<../src/app/(dashboard)/reservations/actions.ts#L250-L254>)), נקרא ב-
  [actions.ts:1461](<../src/app/(dashboard)/reservations/actions.ts#L1461>) ו-[:1590](<../src/app/(dashboard)/reservations/actions.ts#L1590>).
  עריכת התבנית בהגדרות אינה משנה הזמנות קיימות.
- **נמדד:** 38/38 הזמנות נושאות snapshot — הכרטיס יופיע תמיד בפועל.
- שני סייגים: הרינדור מותנה (`detail.cancellation_policy &&`), והכרטיס קיים
  **רק במסך העריכה** — במסך ההזמנה החדשה אין כרטיס מדיניות ביטול כלל.

---

## 12 · כרטיס גבייה מהערוץ + CVC — 🟡

### הכרטיס קיים — ובכוונה בלי שום נתון כרטיס

«**גבייה מהערוץ**» — [EditReservationPanel.tsx:945-993](../src/components/reservations/EditReservationPanel.tsx#L945-L993),
מוצג רק כשיש `detail.ota`. שדותיו: מספר הזמנה ב-GuestHub · קוד ההזמנה של ה-OTA ·
«קוד סודי מהערוץ» (תמיד «לא התקבל קוד סודי מהערוץ», [:964-966](../src/components/reservations/EditReservationPanel.tsx#L964-L966)) ·
אמצעי תשלום · מי גובה · מצב גבייה · תג תשלום.

ההערה בקוד עצמו קובעת זאת מפורשות
([EditReservationPanel.tsx:941-944](../src/components/reservations/EditReservationPanel.tsx#L941-L944)):
*«NO card data lives here — brand/number/expiry/holder belong to the one card
section below, and nowhere else»* (D86).

### 🔴 CVC של ערוץ — לא קיים, ולא ייתכן במימוש הנוכחי

| שכבה | מה נקבע | ראיה |
|---|---|---|
| מודל תצוגה | ערבות ערוץ מחזירה `cvv: ""` תמיד | [card-rules.ts:363](../src/lib/card-rules.ts#L363) — «a channel guarantee never carries a CVV» |
| קליטה | כל CVV נכנס מושלך, לא מוצפן, לא נשמר, לא נרשם (D52 §2) | [card-ingest.ts:8-14](../src/lib/channel/card-ingest.ts#L8-L14) |
| DB | `channel_booking_revisions.card_cvv_encrypted` נשארה **מוסרת** | [047:17-19](../db/migrations/047_restore_stored_cvv.sql#L17-L19) |

### היכן CVC כן קיים, ומהיכן הוא נקרא

- **עמודה:** `reservation_cards.cvv_encrypted`, הוחזרה ב-**D87** —
  [047_restore_stored_cvv.sql:30-31](../db/migrations/047_restore_stored_cvv.sql#L30-L31).
  (הוסרה ב-D52/מיגרציה 018, הוחזרה בהחלטת בעלים מפורשת עם תקרת תאימות מוצהרת:
  אחסון CVV לאחר authorization הוא הפרת **PCI-DSS Req. 3.2** —
  [047:9-15](../db/migrations/047_restore_stored_cvv.sql#L9-L15), [card-vault.ts:47-49](../src/lib/card-vault.ts#L47-L49).)
- **כתיבה:** רק הזנה ידנית. `encryptCvv` ב-
  [card-actions.ts:147](<../src/app/(dashboard)/reservations/card-actions.ts#L147>) →
  [:173](<../src/app/(dashboard)/reservations/card-actions.ts#L173>).
- **`CARD_VAULT_KEY` נקרא בדיוק במקום אחד:** [card-vault.ts:19](../src/lib/card-vault.ts#L19)
  (`cardVaultConfigured`) ו-[card-vault.ts:22-26](../src/lib/card-vault.ts#L22-L26) (`key()`),
  `sha256(CARD_VAULT_KEY)` → AES-256-GCM, פורמט `v1.<iv>.<tag>.<data>`, IV אקראי לכל ערך,
  **fail-closed** — מפתח חסר זורק, אין נפילה ל-plaintext.
  `encryptCvv`/`decryptCvv` הם aliases לאותה קריפטוגרפיה ([card-vault.ts:50-51](../src/lib/card-vault.ts#L50-L51)).
- **פענוח — שתי נקודות בלבד:**
  1. חשיפה מבוקרת ומתועדת, מוגנת הרשאה —
     [card-actions.ts:258](<../src/app/(dashboard)/reservations/card-actions.ts#L258>) (כפתור «הצגת פרטי אשראי»,
     [CardFields.tsx:457-461](../src/components/reservations/CardFields.tsx#L457-L461));
  2. מסלול הסליקה — [card-actions.ts:346](<../src/app/(dashboard)/reservations/card-actions.ts#L346>),
     **בלתי נגיש היום**: כפתור הסליקה מרונדר `disabled` עם «לא מוגדר ספק סליקה פעיל»
     ([CardFields.tsx:464-480](../src/components/reservations/CardFields.tsx#L464-L480)).
- **UI:** שדה ה-CVV מרונדר במצבי עריכה ועל כרטיס שמור
  ([CardFields.tsx:231](../src/components/reservations/CardFields.tsx#L231), [:365-387](../src/components/reservations/CardFields.tsx#L365-L387)).
  על כרטיס שמור הוא ריק עד החשיפה — CVV לעולם אינו מוצג ממוסך-בנקודות כמו ה-PAN.
- **נמדד:** 10 מתוך 12 כרטיסים נושאים `cvv_encrypted` (back_office 2/3, website 8/9).
  0 כרטיסי ערוץ, ולכן 0 CVV ממקור ערוץ.

> **חוב תיעוד:** הכותרת של [card-rules.ts:1-7](../src/lib/card-rules.ts#L1-L7) עדיין מצהירה
> ש-CVV «נעדר בכוונה מכל טיפוס, ולידטור ופורמטר במודול הזה» — הצהרה שהתיישנה עם D87
> וסותרת את [:50-57](../src/lib/card-rules.ts#L50-L57), [:161](../src/lib/card-rules.ts#L161)
> ו-[:174-177](../src/lib/card-rules.ts#L174-L177) באותו קובץ.
> גם [card-actions.ts:42-44](<../src/app/(dashboard)/reservations/card-actions.ts#L42-L44>) ו-[:78](<../src/app/(dashboard)/reservations/card-actions.ts#L78>) עדיין אומרים «אין CVV, אין עמודה».

---

## ז' · היכן מחושב מחיר הזמנה — כל המיקומים

### מנוע יחיד — קיים, והוא באמת יחיד לכל *הכרעה* מסחרית

`calculateQuote` / `calculateReservationPrice` —
[engine.ts:124-131](../src/lib/pricing/engine.ts#L124-L131). שלושה קוראים ישירים בלבד:

| קורא | קובץ:שורה | תפקיד |
|---|---|---|
| `getStayQuoteAction` | [reservations/actions.ts:1288](<../src/app/(dashboard)/reservations/actions.ts#L1288>) | תצוגה חיה בפאנלים |
| `simulateQuoteAction` | [rate-plans/actions.ts:560](<../src/app/(dashboard)/rate-plans/actions.ts#L560>) | סימולטור תוכניות תעריף |
| `priceReservationStays` | [reservation-pricing.ts:253](../src/lib/pricing/reservation-pricing.ts#L253) | **תפר השמירה** (D51) |

ו-`priceReservationStays` עצמו נקרא משני מקומות בלבד:
[reservations/actions.ts:120](<../src/app/(dashboard)/reservations/actions.ts#L120>) (יצירה/עריכה/הזזה)
ו-[public-booking/create-booking.ts:103](../src/lib/public-booking/create-booking.ts#L103).

**שיתוף אמיתי, לא שכפול:** `resolveChainNightPrice`
([resolve.ts:164](../src/lib/pricing/resolve.ts#L164)) נקרא מילה במילה גם מהמנוע
([engine.ts:454](../src/lib/pricing/engine.ts#L454)) וגם מהקרנת ה-ARI ל-Beds24
([beds24-ari-projection.ts:282](../src/lib/channel/beds24-ari-projection.ts#L282)) —
מה שהמלון מוכר פנימית ומה שנדחף לערוץ נגזרים מאותה פונקציה.

### 🔴 אבל יש חמישה חישובי מחיר/סה״כ נוספים, מחוץ למנוע

| # | מיקום | מה מחושב שם | הסיכון |
|---|---|---|---|
| 1 | [reservations/actions.ts:1236-1254](<../src/app/(dashboard)/reservations/actions.ts#L1236-L1254>) | `avg_price` לבורר החדרים, דרך `planNightlyPrice` על ARI בסיס בלבד | בלי שרשרת תוכניות, בלי אורח נוסף, בלי הגבלות. מוצג למפעיל כ«₪X/לילה» ב-[StayEditor.tsx:198](../src/components/reservations/StayEditor.tsx#L198) ו-[:227](../src/components/reservations/StayEditor.tsx#L227). ההערה ב-[actions.ts:16-18](<../src/app/(dashboard)/reservations/actions.ts#L16-L18>) מודה שזה display-only |
| 2 | [public-booking/availability.ts:136-172](../src/lib/public-booking/availability.ts#L136-L172) | `totalPrice` שמצוטט לאורח באתר, מסכימת `effective_sell_state` | **מחיר אחר מזה שנשמר**: ההזמנה עצמה מתומחרת מחדש דרך המנוע ב-[create-booking.ts:103](../src/lib/public-booking/create-booking.ts#L103). שני חישובים שונים לאותה עסקה |
| 3 | [reservations/actions.ts:1005-1015](<../src/app/(dashboard)/reservations/actions.ts#L1005-L1015>) | `total_price = GREATEST(0, rooms_total − discount + extra)` ב-SQL, בהזזת חדר | העתק ידני של `reservationTotal` ([reservation-pricing.ts:314-320](../src/lib/pricing/reservation-pricing.ts#L314-L320)). ההערה בקוד מודה שהם חייבים להתאים |
| 4 | [channel/booking-import.ts:424](../src/lib/channel/booking-import.ts#L424) | אותה נוסחה שוב, ב-SQL, בקליטת הזמנת ערוץ | עותק שלישי |
| 5 | [BookingPanel.tsx:225-230](../src/components/reservations/BookingPanel.tsx#L225-L230) · [EditReservationPanel.tsx:279-282](../src/components/reservations/EditReservationPanel.tsx#L279-L282) | `roomsTotal` ו-`total` נגזרים **בדפדפן** | עותקים רביעי וחמישי. הלקוח לא מקבל סה״כ מהשרת אלא מחשב `max(0, rooms − discount + extra)` בעצמו |

**וגם המע״מ מחושב פעמיים:** המנוע כבר מחזיר `vatAmount`
([engine.ts:521](../src/lib/pricing/engine.ts#L521)), אבל שלושת משטחי התצוגה מחשבים אותו
מחדש עם `includedVatAmount` ([EditReservationPanel.tsx:871](../src/components/reservations/EditReservationPanel.tsx#L871),
[BookingPanel.tsx:753](../src/components/reservations/BookingPanel.tsx#L753),
[booking-doc-data.ts:186](../src/lib/pdf/booking-doc-data.ts#L186)) — ואף אחד מהם אינו קורא
ל-`includedVatForReservation`, ולכן `tax_exempt` מתעלמים ממנו בכל התצוגות (ראה §5.ג).

**מסקנה:** יש מנוע יחיד להכרעה המסחרית (מחיר לילה, שרשרת תוכניות, הגבלות,
אורח נוסף) — וזה מוצק. **אין** מקור יחיד ל**סה״כ ההזמנה** ולמע״מ: אותה נוסחה
כתובה חמש פעמים בשלוש שפות (TS שרת, SQL, TS לקוח).

---

## ח' · שיעור המע״מ: גלובלי או פר-הזמנה? האם השתנה 17→18?

### גלובלי — עם תצלום פר-שהות

- **ערך גלובלי יחיד:** `tenants.settings->vat_rate` (דייר אחד במערכת).
  **אין עמודת `vat_rate` על `reservations`** — נבדק מול `information_schema.columns`.
- **אבל כן נשמר תצלום:** `reservation_rooms.pricing_snapshot.vatRate`, נכתב ב-
  [reservation-pricing.ts:160](../src/lib/pricing/reservation-pricing.ts#L160) יחד עם
  `priceIncludesVat: true` ([:161](../src/lib/pricing/reservation-pricing.ts#L161)).
  התצלום חסין: שהות מאושרת שלא נגעו בה שומרת על מחירה ואינה מתומחרת מחדש
  ([reservation-pricing.ts:211-215](../src/lib/pricing/reservation-pricing.ts#L211-L215)).
  מסך ההגדרות אומר זאת למפעיל במפורש ([VatSection.tsx:54](<../src/app/(dashboard)/settings/VatSection.tsx#L54>)).

### האם השתנה 17→18? **לא — לא בקוד הזה.**

`git log -S "DEFAULT_VAT_RATE = " -- src/lib/vat.ts` מחזיר **קומיט אחד בלבד**:
`0f07800 feat(settings): tenant VAT setting`, שהכניס את הקבוע כבר כ-**18**.
מיגרציה [007:19-20](../db/migrations/007_phase3_tenant_settings.sql#L19-L20) זורעת 18.
המופעים היחידים של 17 בריפו הם פיקסצ'רים של בדיקות
([check-check-in-check-out-db.mjs:75,153](../scripts/check-check-in-check-out-db.mjs#L75),
[check-pricing-engine.mjs:562-564](../scripts/check-pricing-engine.mjs#L562)).
המערכת נבנתה אחרי המעבר של ישראל ל-18% — היא מעולם לא הכירה 17.

### האם יש הזמנות חיות שנמכרו בשיעור הישן? **לא.**

נמדד — `SELECT pricing_snapshot->>'vatRate', count(*) FROM guesthub.reservation_rooms GROUP BY 1`:

| vatRate בתצלום | שורות |
|---|---|
| `18` | **35** |
| כל ערך אחר | **0** |

מתוך 41 שורות `reservation_rooms`, ל-35 יש תצלום. **6 שורות ללא תצלום כלל** —
שורות שקדמו לתפר D51; הן אינן נושאות הקשר מע״מ בכלל, לא ישן ולא חדש.
(סה״כ הזמנות: 23 `confirmed`, 15 `cancelled`; טווח `2026-06-22` → `2027-06-30`.)

### ⚠️ הסייג שמבטל חצי מהתשובה

השיעור 18 בפרודקשן **אינו מגיע מההגדרה** — המפתח `vat_rate` לא קיים ב-`settings`
(ראה §5.ב). הוא מגיע מקבוע הקוד `DEFAULT_VAT_RATE`. כלומר: היום השיעור **כן**
מקובע בפועל, גם אם הצנרת לקריאתו מההגדרות תקינה.

---

## ט' · `check:pricing-engine` — מה הוא באמת בודק, ולאן הוא מכוון

### 🟢 ה-ROOT תוקן — הוא מכוון לעץ שבו הוא חי

```js
// scripts/check-pricing-engine.mjs:27
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);
```

ההערה שמעליו ([:22-26](../scripts/check-pricing-engine.mjs#L22-L26)) מתעדת את הפגם הישן —
`ROOT` היה מקובע ל-`"/var/www/guesthub"`, כלומר לעץ הפרודקשן, ולכן ריצה מכל
worktree קימפלה את ה-`src/` של הפרודקשן ודיווחה ירוק על קוד שהמחבר לא כתב.
תוקן בקומיט **`6e4a1c5` (D101)**. אותו תיקון ב-
[check-pricing-equality.mjs:24](../scripts/check-pricing-equality.mjs#L24).
`check:guard-roots` ([scripts/check-guard-roots.mjs](../scripts/check-guard-roots.mjs))
אוסר מעתה נתיב checkout מוחלט בכל שומר, עם מנגנון opt-out גלוי בשורה אחת.

### מה הוא בודק — 34 טענות בשני חלקים

**Part A — טהור, בלי DB.** מקמפל את `src/lib/pricing` + `src/lib/rates` ב-`tsc`
לתיקייה זמנית ומריץ את המודולים האמיתיים ([:52-86](../scripts/check-pricing-engine.mjs#L52-L86)):
`applyPlanAdjustment` (אחוז/קבוע, עיגול אגורות) · קדימויות `resolveNightPrice`
(override > התאמת שיוך > התאמת תוכנית; תוכנית עצמאית לעולם לא נופלת לבסיס) ·
`resolveParentChain` (שרשרת, מעגל, תוכנית חסרה) · `mergeRestrictionRows`
(המחמיר גובר; תוכנית מהדקת ולעולם לא פותחת את הבסיס) · `planStayRuleViolation`
(תוקף, חלון הזמנה מראש, יום הגעה, min/max stay של תוכנית) · שקילות הוולידטור
המובנה למעטפת העברית · `planFormulaLabel`.

**Part B — מול DB מבודד.** מריץ את שרשרת המיגרציות המלאה על `guesthub-testdb`
ב-`:5433` ([:42-50](../scripts/check-pricing-engine.mjs#L42-L50)), עם **סירוב fail-closed**
אם `TEST_DATABASE_URL` מכיל סמן פרודקשן ([:35-41](../scripts/check-pricing-engine.mjs#L35-L41)).
בונה פיקסצ'ר זמני ומריץ `calculateQuote` בתוך **טרנזקציה אחת שמתגלגלת לאחור**
(savepoints לכל תרחיש משנה; שום דבר לא נכתב): תמחור תוכנית בסיס ולילה יציאה שלא
מחויב · נפילה ל-`room_types.base_price` עם מקור כן · `derived_percentage` /
`derived_fixed` · תוכנית עצמאית + `NO_PRICE_FOR_DATE` בלי fallback שקט ·
override מדויק `(plan,unit,date)` · התאמת שיוך · min-stay של שכבת הבסיס ·
`stop_sell` ברמת תוכנית · CTA/CTD · תקרות תפוסה לפי קטגוריה · אורחים נוספים
ותצורה חסרה שנכשלת סגור · זמינות/סגירה/OOO/לא-פעיל · חדר כפול · סכימת רב-חדרים ·
**מע״מ מהגדרות הדייר כולל שיעור 0** · יציבות ה-fingerprint · בידוד בין דיירים ·
**חלון תמחור ניתן להגדרה** (נדחה ב-`ceiling+1`, עובר בדיוק ב-`ceiling`).

### מה הוא **לא** בודק

הנחות אורך שהייה (אין קוד כזה ב-main) · `tax_exempt` · מטבע שאינו של הדייר ·
מצב «סה״כ ידני».

> **לא הרצתי אותו.** Part B דורש את קונטיינר ה-docker `guesthub-testdb` וכותב
> אליו את כל שרשרת המיגרציות — מחוץ לגבולות ביקורת קריאה בלבד.
> `check:pricing-equality` ([scripts/check-pricing-equality.mjs](../scripts/check-pricing-equality.mjs), 23 טענות)
> מוכיח בנפרד שהסימולטור וההזמנה מייצרים סכומים, פירוט לילות ו-fingerprint זהים.

---

## י' · מצב ענף ה-LOS ומיגרציה 055

### הענף

| | |
|---|---|
| שם | `fix/quote-window-long-stay` |
| HEAD | `eb5dbe4` |
| **מרוחק** | **לא קיים** — אין `origin/fix/quote-window-long-stay`, אין PR |
| worktree | `/home/ubuntu/worktrees/quote-window` |
| בסיס משותף | `5b171bd` (מיזוג PR #102) — `main` מאז התקדם ל-`87f0434` |
| היקף | 26 קבצים, +1323 / −86 |

שני קומיטים:
1. `f03c911` — «long stays price… (D94)» — **כבר מיושן**: main פתר את אותה בעיה
   אחרת בקומיט `5ce0280` תחת **D100**.
2. `eb5dbe4` — «max_stay is the only ceiling… and length-of-stay discounts price
   in the engine (D95)» — **זה החלק היחיד שעדיין חדש**.

מה שהוא מוסיף: [`055_length_of_stay_discounts.sql`](#) (91 שורות, טבלת
`length_of_stay_discounts` עם `discount_kind ∈ {percent, amount_per_night, amount_per_stay}`,
CHECKים שאחוז ≤ 100 וערך > 0, אינדקסים ייחודיים נפרדים ל-scope תוכנית ול-scope
דייר) · `src/lib/pricing/los.ts` (101 שורות, טהור: `tiersForPlan`, `selectTier`
— ה-`min_nights` הגבוה גובר, `applyTier` עם הסבר עברי וקאפ לגובה הלינה) ·
חיווט במנוע (+59, בסיס = הלינה בלבד, override ידני **פטור** מההנחה) ·
`LosDiscountsPanel.tsx` (263 שורות) · תצוגה ב-StayEditor/BookingPanel/EditReservationPanel ·
תוספות ל-`check-pricing-engine` / `check-pricing-equality` / `check-rates-ui`.

### התנגשות 055 — ומה שמסוכן בה יותר

`git merge-tree main fix/quote-window-long-stay` מדווח **6 התנגשויות תוכן**:

```
DECISIONS.md
db/migrations/manifest.txt
scripts/check-pricing-engine.mjs
src/app/(dashboard)/rates/GroupUpdatePanel.tsx
src/lib/pricing/engine.ts
src/lib/pricing/types.ts
```

**🔴 התנגשות המיגרציה עצמה אינה ברשימה — וזו הבעיה.**
הענף מוסיף `055_length_of_stay_discounts.sql`; main הוסיף בינתיים
`055_booking_com_channel_reports.sql`. **שמות קבצים שונים**, ולכן git ימזג אותם
בשקט לשני קבצים שנושאים שניהם את המספר 055. `manifest.txt` מתנגש רק במקרה —
כי שניהם הוסיפו שורה בסוף. הרַצָּה ממיינת לפי שם קובץ
([check-pricing-engine.mjs:44](../scripts/check-pricing-engine.mjs#L44)), ולכן הסדר
דטרמיניסטי (`booking_com` לפני `length_of_stay`) — אבל **המספר מפסיק להיות זהות**.
main כבר ב-`056_source_system.sql`, ולכן מיגרציית ה-LOS צריכה מספור מחדש ל-**057**.

**🔴 התנגשות `types.ts` היא מהותית, לא טקסטואלית.**
הענף מחליף `MAX_QUOTE_NIGHTS = 90` בקבוע `1830`.
main פתר את אותה בעיה תחת **D100** בצורה טובה יותר: `DEFAULT_MAX_QUOTE_NIGHTS = 400`
+ `resolveMaxQuoteNights(settings.pricing)` הניתן להגדרה פר-דייר
([types.ts:21-39](../src/lib/pricing/types.ts#L21-L39)).
**מיזוג נאיבי של הענף יבטל את ההגדרה הפר-דיירית** ויחזיר קבוע קשיח. זו נסיגה.

**🔴 התנגשות מספר החלטה.** הענף מסמן את עצמו **D95** (בקומיט ובכותרת המיגרציה),
אבל D95 ב-main ([DECISIONS.md:896](../DECISIONS.md#L896)) הוא ההחלטה על קריאה
חוזרת של ה-ARI. עבודת ה-LOS צריכה מספר חדש (main עומד על **D102**).

### מה בפרודקשן

הטבלה `length_of_stay_discounts` **לא קיימת** (`to_regclass` → `null`).
שום דבר בפרודקשן אינו תלוי בענף, והמיגרציה מעולם לא הורצה. אין חוב נתונים.

---

## יא' · ממצא נלווה שנתקלתי בו ורלוונטי לתמחור

**בורר החדרים עדיין נעצר ב-90 לילות, אחרי ש-D100 הרים את המנוע ל-400.**

```js
// src/app/(dashboard)/reservations/actions.ts:1198
if (nightsBetween(args.checkIn, args.checkOut) > 90) return fail("טווח ארוך מדי");
```

`StayEditor` מסתמך על `getAvailableRoomsAction` כדי למלא את ה-`<select>` של החדר
([StayEditor.tsx:87-100](../src/components/reservations/StayEditor.tsx#L87-L100)).
בכישלון הוא **אינו מנקה את הרשימה ואינו מציג שגיאה** — התנאי הוא
`if (alive && res.success && res.data) setRooms(...)`. לכן לטווח של 91+ לילות:
או שהרשימה נשארת ריקה (אם זו השאילתה הראשונה לשהות) ואי אפשר לבחור חדר,
או שהיא נשארת עם **התוצאה הישנה של טווח אחר** — כולל דגלי `free` ומחירי `avg_price`
שאינם שייכים לטווח שעל המסך. שקט בשני המקרים.

טבלת החסמים ב-[docs/LONG_STAY_FIX.md](LONG_STAY_FIX.md) (§G.2) **אינה מונה את נקודת
הקריאה הזו**. הממצא נקרא מהקוד ולא אומת בהרצת UI.

---

## נספח · מה נמדד מול ה-DB החי (SELECT בלבד)

| שאילתה | תוצאה |
|---|---|
| `tenants` | דייר אחד · `currency = ILS` · `settings->>'vat_rate'` = **NULL** · `settings->'pricing'` = NULL (⇒ חלון תמחור = 400 ברירת מחדל) |
| מפתחות `settings` | `extra_guest`, `business_profile`, `ops_notification_email` |
| הזמנות | 23 `confirmed` · 15 `cancelled` · כולן `ILS` · כולן `tax_exempt = false` |
| מקור הזמנה | `back_office` 22 · `direct_website` 9 · `ota` 7 |
| `pricing_snapshot.vatRate` | `18` × 35 · שום ערך אחר |
| שורות `reservation_rooms` | 41, מתוכן 35 עם תצלום, 3 עם `manualOverride` |
| הנחות בשימוש | `discount_amount>0`: **0** · `discount_percent>0`: **0** · `extra_charges>0`: **0** |
| `to_regclass('…length_of_stay_discounts')` | **NULL** |
| `reservation_cards` | 12 · `back_office` 3 (2 עם CVV) · `website` 9 (8 עם CVV) · **`channel` 0** · 2 עם `billing_notes` |
| `channel_booking_revisions` | 15 שורות · **0 עם `card_meta`** |
| `cancellation_policy_snapshot` | **38/38** הזמנות |
| `pricing_plans` (רמת דייר) | 4 — ראה §1 |
