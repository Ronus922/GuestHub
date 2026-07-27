# SIGNOFF — Booking Window V2 (סוכן SUPERVISOR)

תאריך: 2026-07-26 · ענף `feat/booking-window-v2` · בסיס origin/main = `939f888`.
PASS רק עם ראיה committed: שומר שרץ (שם + תוצאה), מסמך, או צילום בענף.

| # | דרישה | סטטוס | ראיה |
|---|---|---|---|
| 1 | LOS אוטומטי לפי לילות + badge | **PASS** | `check:pricing-engine` 36/36 (#34: בחירה/קדימות/בסיס-לינה/פטור-ידני/cap/D105) · seeds 7→15%,30→30% במיגרציה 057 (הוחלה על העותק) · badge: הסבר המנוע בשני הפאנלים + StayEditor (`LosDiscountsPanel`, `explanation`) · `check:pricing-equality` #3b — נחתם ב-snapshot |
| 2 | 3 מצבי מחיר, זהים ביצירה ובעריכה | **PASS** | רכיב משותף אחד `PricingControls.StayPriceModeControls` נטען משני הפאנלים (BookingPanel + EditReservationPanel — העריכה יכולה סוף-סוף לקבוע/לשנות/לבטל) · seam: `check:pricing-equality` #22-23 (manual_night, manual_total מדויק לאגורה, LOS פטור) · צילום `shots/impl-pricing-controls-desktop.png` |
| 3 | 5 מצבי הנחה | **PASS** | `computeReservationTotals` — none/₪ ללילה/% ללילה/₪ להזמנה/% להזמנה · `check:pricing-equality` #18b (מספרים מפורשים לכל מצב + ולידציות fail-closed) · UI: ‏DiscountControls ‏4 יחידות + "מחיר מלא"=0 (SPEC ס-2) |
| 4 | יתרה — גם ביצירה | **PASS** | BookingPanel: שדה "יתרה לתשלום" בכרטיס התשלום + ‏BalanceBoxes בשלב 4 (זיכוי בירוק, `formatBalance`) · `check:pricing-equality` #18b — balance ≡ ledger (לא מרוצף) · צילום impl (קופסת יתרה ₪618 אדומה) |
| 5 | טוגל מע״מ, ברירת מחדל כולל, שיעור מההגדרות | **PASS** | ‏VatToggleRow (ברירת מחדל דלוק) כותב `tax_exempt`; כל התצוגות + PDF דרך `includedVatForReservation` (‏pin ב-`check:cards`) · מיגרציה 058 זורעת `vat_rate=18` (אינרטי) · #18b: פטור ⇒ VAT=0 בלי להזיז את המחיר |
| 6 | בורר מטבע מההגדרות, בלי ILS קשיח | **PASS** | `settings.enabled_currencies` (seed ILS) + ‏CurrenciesSection בהגדרות + ‏CurrencySelector בכרטיס התמחור · `reservations.currency` נכתב מהקלט המאומת; אפס ליטרל ILS ב-INSERTים (create/create-booking) · D107: לא-בסיס ⇒ חובה ידני (שרת) + `exchange_rate` snapshot |
| 7 | בקרות תמחור בעריכת חדר (StayEditor) | **PASS** | בלוק פר-חדר בכרטיס התמחור (מיקום הרפרנס — SPEC שלב 3): mode+ערכים+תוכנית פר-חדר בשני המסלולים; StayEditor מציג ציטוט חי + badge ‏LOS. הסכימה נשארת מהמנוע (`getStayQuoteAction`) |
| 8 | אמצעי תשלום פותח שדות כרטיס להקלדה | **PASS** | יצירה: ‏§15 (קיים) · עריכה: D108 — ‏credit_card נכנס להזנה ידנית כשאין כרטיס/ערבות · `check:card-save-flow` #1 (כולל אי-נעילה ואי-דריסה) |
| 9 | כרטיס+הערות נשמרים בהזמנת ערוץ, כשל גלוי | **PASS** | שמירה ידנית על OTA — מסלול פתוח (audit §8-9) + ‏D108 מסיר את מחסום ה-toggle · כשל שמירה inline ‏`role="alert"` + הודעת vault מפורשת (`check:card-save-flow` #2) · ingest מוצפן מכוסה `check:channel-card-ingest` · אימות קליק-תרו סופי — צ׳קליסט רונן (למטה) |
| 10 | הערות חיוב הוסרו, תוכן הועבר להערות הזמנה | **PASS** | מיגרציה 059 (idempotent, prefix ‏[הערת חיוב], רדקציית CVV) — הוחלה על העותק: 2/2 שורות עברו, 0 תבניות CVV · UI הוסר · `check:card-save-flow` #4 |
| 11 | הערות להזמנה מעל מדיניות ביטול | **PASS** | סדר הוחלף בעריכה + כרטיס מדיניות חדש ביצירה (מתחת להערות) · `check:card-save-flow` #5 (‏pin סדר בשני המסלולים) |
| 12 | קוד סודי מהערוץ: מוצג מאובטח, או סיבה מדויקת | **PASS** | נמדד (D110, קריאה-בלבד): ה-API לא מוסר כרטיסים/טוקנים לחשבון ⇒ אין מה להציג; ההודעה מפרטת את הסיבה לפי מצב (ערוץ-בלי-CVC מול חשבון-בלי-כרטיסים) + הפניה להזנה ידנית · `SECURITY.md` §1 |
| F | נאמנות לרפרנס — 4 שלבים, שדה-שדה | **PASS** | `SPEC.md` (רנדור אמיתי, שדה-שדה, 7 סטיות מוכרעות) · `UX.md` השוואה פר-שלב · צילומי רפרנס step1-4 + צילומי מימוש impl-* — כולם committed |
| R | רגרסיה: הזמנות בייט-זהות + כל השומרים | **PASS** | `check:totals-parity` COPY: ‏**42/42 בייט-זהות** (עלה מ-38 — פרודקשן זז מאז הביקורת) + replay + ledger — ‏`parity-run-2026-07-26.txt` · סריקת כל השומרים מול בסיס 51/23: ראו טבלת הסריקה למטה |

## אימותי SUPERVISOR נוספים

- **אין חישוב סה״כ מחוץ למקור היחיד** — pins טקסטואליים ב-`check:pricing-equality`
  (‏resolveTotals בכל אתרי הפעולות, computeReservationTotals בערוץ/ציבורי, איסור
  `GREATEST(0…discount_amount`) — ירוק.
- **אין deploy, אין pm2, אין נגיעה בפרודקשן** — כל DB על :5433; פרודקשן SELECT/pg_dump
  בלבד; ה-API של Beds24 — ‏GET בלבד בלי mint.
- **commits מבודדים** — ‏12 קומיטים, אחד לכל phase, אפס `git add -A`.
- **מספרי D חדשים בלבד** — ‏D104-D110 (אחרי D103 של ‎#120; D95 של הענף הישן מוספר).
- **typecheck / lint / build** — ירוקים (‏lint: ‏0 שגיאות; 34 אזהרות — כולן קדם-ענף).

## סריקת השומרים (מול הבסיס 51✅/23❌ מתוך 74 — GUARD_AUDIT.md)

הסריקה המלאה (79 שומרים, כולל 4 החדשים) — `guard-sweep-2026-07-26.tsv` committed.

- **אפס רגרסיות**: כל שומר שהיה ירוק בבסיס — ירוק גם עכשיו (שומרי ה---env-file
  הורצו עם עותק הפרודקשן על :5433 + מפתחות, כפי שרצו בבסיס).
- **שיפורים מול הבסיס**: pricing-engine, pricing-equality, rate-plans,
  su-lifecycle, room-identity, commercial-db, room-db, check-in-check-out-db —
  אדומי-סביבה בבסיס, ירוקים בריצה הזו (testdb זמין).
- **אדומים שנשארו** — כולם מהבסיס המתועד או קדם-ענף:
  ‏15 תלויי-סביבה (hydration-browser, db-isolation, reservation-concurrency,
  guest-communications-db, booking-com-reports, inventory-integrity,
  payment-ledger-integrity, payment-refund-void, pms-domain-invariants,
  background-job-recovery…) · אדומי-קוד/נתונים מהבסיס: beds24-ari (28 טווחים
  תקועים — verbatim מ-GUARD_AUDIT), beds24 (צובר), calendar, calendar-ui,
  cards (PSP, תחום ‎#60), channels-badge, design (housekeeping הקפוא),
  supply-chain.
- **שני מקרים מנומקים**: `beds24-maxstay-no-limit` — נכשל **זהה על origin/main**
  (התיקון ב-PR ‎#115 הלא-ממוזג; השומר צעיר מהבסיס) · `beds24-revisions` — מוניטור
  טריות תפעולי (מודד דקות-מאז-משיכה; אדום בהגדרה מול snapshot קפוא).
- **החדשים ירוקים**: totals-parity ‏4/4 · public-quote ‏3/3 · card-save-flow ‏6/6 ·
  channel-card-ingest (self-sufficient) · room-picker-window (מ-#121).

## צ׳קליסט רונן אחרי מיזוג+דיפלוי (2 דקות, הפריט הלא-אוטומטי היחיד)

1. הזמנה חדשה: 4 שלבים, שלב 3 — לבחור "כרטיס אשראי" → השדות נפתחים; להזין
   כרטיס בדיקה + הערה → צור הזמנה → לפתוח שוב → הכרטיס וההערה שם.
2. הזמנת OTA קיימת: לבחור "כרטיס אשראי" → להקליד → שמירת כרטיס → רענון (F5)
   → הכרטיס מוצג ממוסך. אם משהו נכשל — תופיע שורת שגיאה אדומה ליד השדות.
3. שהות 7+ לילות על מחיר בסיס → ההנחה מופיעה לבד עם משפט ההסבר.
