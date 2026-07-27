# SECURITY — Booking Window V2 (סוכן SECURITY)

תאריך: 2026-07-26 · ענף `feat/booking-window-v2` · כל מדידה קריאה-בלבד.

## 1 · מה Beds24 באמת מעביר לחשבון הזה (PHASE 5, נמדד)

**מתודולוגיה.** בדיקה חיה, קריאה-בלבד: הטוקן המוצפן נקרא מהחיבור (SELECT בלבד;
בלי mint — סקריפט שמסרב לרענן), ושתי קריאות GET ל-API הרשמי
(`/v2/authentication/details`, `/v2/bookings`). אפס כתיבות לפרודקשן ול-Beds24.

**ממצאים (26/07/2026):**

| מדד | ערך |
|---|---|
| scopes של הטוקן | `all:bookings`, `all:bookings-personal`, `all:bookings-financial`, `all:inventory`, `all:properties`, `all:accounts`, `all:channels` |
| שדות כרטיס בתשובת `/bookings` | **אין** — אף שדה שם/מספר/תוקף/CVC של כרטיס |
| `stripeToken` | קיים כשדה, **ריק בכל ההזמנות** שנבדקו |
| `pcibookingToken` | קיים כשדה, **ריק בכל ההזמנות** שנבדקו |
| קוד הייבוא | `beds24-booking-import.ts` — "NO card staging — Beds24 booking payloads are fetched without card data" (מפורש בקוד) |
| revisions עם `card_meta` בפרודקשן | 0 מ-15 (ביקורת §9) |

**מסקנה.** ה-API של Beds24 אינו מוסר פרטי כרטיס גולמיים כלל; מסירת כרטיסים
דרך ה-API אפשרית רק כטוקן (Stripe / PCI Booking) — ולחשבון הזה שני הטוקנים
ריקים. צפיית הכרטיסים של רונן נעשית בלוח Beds24 עצמו (הרשאת הכרטיסים שלהם) —
משם הגיעה ההדבקה הידנית שנמצאה (ראה §2). לכן **מסלול "אם מגיעים פרטי כרטיס —
לחווט ingest כולל CVC" אינו רלוונטי היום**: אין מה לחווט אליו. מומש המסלול
השני של ההנחיה — הודעה מדויקת לפי הסיבה (D110).

**מה נדרש כדי שכרטיסים יגיעו ב-API (להכרעת רונן, מול Beds24):** הפעלת
אינטגרציית PCI Booking (שירות vault חיצוני עם הסמכת PCI) או מנגנון טוקן אחר
בצד Beds24. אם יופעל — נקודת הכניסה המחווטת כבר קיימת:
`persistBookingRevision` (stage מוצפן) → `markRevisionImported` →
`attachStagedCard`, מכוסה ב-`check:channel-card-ingest`.

## 2 · ממצא חמור שטופל: CVV גלוי בתוך הערת חיוב בפרודקשן

בהרצת מיגרציה 059 על עותק הפרודקשן התגלה שאחת משתי הערות החיוב מכילה בלוק
שלם שהודבק מלוח הערוץ — כולל **`Cvv: NNN` בטקסט גלוי** (כרטיס וירטואלי של
Expedia). CVV בטקסט גלוי מחוץ ל-vault הוא הפרת PCI-DSS Req. 3.2 שכבר קיימת
בפרודקשן היום (בעמודת `billing_notes`).

**טיפול:** מיגרציה 059 מבצעת רדקציה בזמן ההעברה — כל תבנית `cvv/cvc/cvv2 +
3-4 ספרות` הופכת ל-`Cvv: [הוסר]` לפני הכתיבה להערות ההזמנה, והמקור מרוקן.
אומת על העותק: 0 תבניות CVV בהערות אחרי ההרצה. ה-CVV האמיתי, אם נדרש, מוזן
בשדות הכרטיס (D87) ומוצפן. **לתשומת לב רונן:** ההרגל להדביק בלוקים מהערוץ
לתוך הערות עלול להחזיר CVV גלוי — השדה הנכון הוא כרטיס האשראי בפאנל.

## 3 · פגמי הביקורת §9 — נסגרו

1. **CVV ישן על PAN חדש** — `ingestChannelCard` וגם `attachStagedCard`
   (revisions.ts) מנקים `cvv_encrypted` בכל החלפת PAN. כיסוי:
   `check:channel-card-ingest` (תרחיש re-ingest) + pin ב-`check:card-save-flow`.
2. **חלון חיוב זר שורד החלפה ידנית** — `saveReservationCardAction` מנקה
   `available_from`/`available_until`/`provider_reservation_ref`. כיסוי: pin.

## 4 · תלונה 8 ("כרטיס לא נשמר") — ניתוח וכיסוי

- מסלול השמירה הידני על הזמנת OTA תקין ומכוסה (`external_unavailable` →
  הזנה ידנית ← עכשיו גם דרך בחירת "כרטיס אשראי", D108).
- כשל שמירה מוצג עכשיו **inline עם `role="alert"`** ליד השדות, בנוסף ל-toast;
  vault חסר מוחזר כהודעה מפורשת (`CARD_VAULT_KEY חסר`) — לא נבלע.
- `CARD_VAULT_KEY` קיים היום בפרודקשן (נבדק, נוכחות בלבד). בליעת ה-ingest
  (`vault_unconfigured` שקט ב-card-ingest.ts:37) אינה ברת-הפעלה בפועל על
  Beds24 — המסלול לא מוזן (אין כרטיסים ב-API); ההודעה המדויקת בכרטיס הגבייה
  (D110) סוגרת את פער ה"לא ידוע למה".
- E2E על העותק (PHASE 6): הזמנת OTA → הזנת כרטיס → שמירה → רענון → הכרטיס מוצג.

## 5 · הרשאות וחשיפה (ללא שינוי מדיניות)

- `payments.card_manage` נאכף בשרת (save/delete), `payments.card_reveal`
  לחשיפה (audit לפני ואחרי, כולל דחייה — `card_reveal_denied`), tenant-scoped.
- לרונן (r@bios.co.il, super_admin) יש את כולן.
- אין cache/log/console של ערכי כרטיס; audit נושא מטא-דאטה ממוסך בלבד.

## 6 · חוב תיעוד שנסגר

כותרות `card-rules.ts` ו-`card-actions.ts` שהצהירו "אין CVV בכלל" (סתירה ל-D87)
עודכנו לתאר את המצב האמיתי: CVV ידני מוצפן קיים (D87), ערוץ לעולם לא.
