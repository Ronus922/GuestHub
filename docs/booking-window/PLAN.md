# PLAN — Booking Window V2 (סוכן PLANNER)

תאריך: 2026-07-26 · בסיס: origin/main = `939f888` (אחרי מיזוג ‎#121 → הענף נגזר מ-main).
עוגן עובדות: `docs/PRICING_AUDIT.md` (committed בענף). ‏SPEC: `SPEC.md` (רונדר אמיתי).

## מיפוי SPEC→קוד וסדר העבודה שבוצע

| Phase | תוכן | קומיט |
|---|---|---|
| 0 | עוגנים (רפרנס+ביקורת) → git; רנדור הרפרנס; SPEC שדה-שדה + 7 סטיות מוכרעות | `docs(booking-window): הרפרנס וביקורת…`, `SPEC שדה-שדה…` |
| 1 | הצלת LOS: cherry-pick ‏eb5dbe4 בלבד; קונפליקטים הוכרעו לטובת main (D99/D100); מיגרציה 057 + seeds ‏7→15/30→30; אי-הערמה D105; badges | `feat(pricing): הנחות אורך שהייה…` |
| 2a | `totals.ts` טהור-איזומורפי; seam ‏price_mode/manual_total; ‏resolveStayPrice; equality 25/25 | `feat(pricing): computeReservationTotals…` |
| 2b | מיגרציה 058 additive + שער parity על עותק פרודקשן (42/42 בייט-זהות) | `feat(db): מיגרציה 058…` |
| 2c | החלפת 6 אתרי שרת + כלל ledger + מטבע D107 + עדכון מודע לשומר הטקסטואלי | `refactor(pricing): כל כותבי הכסף…` |
| 3 | UI: ‏PricingControls משותף (מצבים/הנחות/מע״מ/יתרה/מטבע), עריכה=יצירה, PDF, הגדרות מטבעות | `feat(reservations): כרטיס התמחור…` |
| 2d | אתר ציבורי מצטט מהמנוע (ESS = סינון בלבד) | `fix(public-booking): המחיר שמצוטט…` |
| 4 | D108 צימוד method→כרטיס; פגמי §9; ‏role=alert; ‏059 הגירת הערות (+רדקציית CVV); סדר כרטיסים; מדיניות ביצירה; ‏check:card-save-flow | `fix(cards): אמצעי תשלום פותח…` |
| 5 | בירור Beds24 קריאה-בלבד → D110 הודעה מדויקת; SECURITY.md; ‏D106-D110 | `docs(decisions): D106-D110…` |
| 6 | ‏check:public-quote; רנדור ראיות; TESTS.md; UX.md | `test(booking-window): שומר public-quote…` |
| 7 | typecheck+lint+build; סריקת כל השומרים מול הבסיס; SIGNOFF; PR | (סגירה) |

## החלטות פתוחות שהוכרעו תוך כדי (רשומות ב-DECISIONS.md)

D104 (הצלת LOS + seeds) · D105 (אי-הערמה על derived; tier מפורש כן; derived_fixed יורש)
· D106 (מקור יחיד; מצב מחיר פר-חדר; discount_mode פר-הזמנה; discount_percent
תוסר בנפרד; אגורות שלמות) · D107 (מטבע: enabled_currencies, בלי המרה, ידני-בלבד
מחוץ לבסיס, Beds24 לא נגוע) · D108 (צימוד חד-כיווני) · D109 (הגירת הערות חיוב +
רדקציית CVV) · D110 (הערוץ לא מוסר כרטיסים ב-API — נמדד; הודעה מדויקת במקום חיווט).

## מה נשאר מחוץ להיקף (מתועד)

בסיס אירוח (ס-1, אין מודל) · התמדת אמצעי-תשלום בלי סכום (payments.method נכתב
רק כשכסף זז — תועד ב-SPEC) · הסרת discount_percent ו-billing_notes (מיגרציות
עתידיות אחרי חלון אימות) · PSP ("סלוק עכשיו" נשאר disabled — תחום ‎#60) ·
קליק-תרו מאומת בדפדפן (session — צ׳קליסט רונן ב-SIGNOFF).
