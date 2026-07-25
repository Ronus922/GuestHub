# NIGHT_AUDIT — ביקורת ריצת הלילה 2026-07-24/25

בסיס הביקורת: `origin/main` = `5b171bd`. ארבעה סוכנים קראו בלבד — **אפס שינויי קוד, אפס מחיקות, אפס דפלוי**.
כל ממצא כולל `file:line`, ראיה, ותיקון מוצע. תיקון לא בוצע לאף אחד מהם.

- **9א — אבטחה**: 17 ממצאים (3 חמור · 7 בינוני · 7 קל)
- **9ב — ביקורת קוד**: 22 ממצאים (4 חמור · 9 בינוני · 9 קל)
- **9ג — קוד מת וזומבים**: 18 ממצאים (5 חמור · 8 בינוני · 5 קל)
- **9ד — אדוורסרי על עבודת הלילה**: 15 ממצאים (4 חמור · 6 בינוני · 5 קל)

**סה"כ 72 ממצאים, מהם 16 חמור.**

---

## החמורים — תקציר מנהלים

מסודר לפי דחיפות תפעולית, לא לפי סוכן. הפירוט המלא בגוף הדוח.

| # | ממצא | סוכן | ראיה | פעולה |
|---|------|------|------|--------|
| 1 | **`cvv_encrypted` חי בפרודקשן** — ה-API הציבורי כותב CVV ללא תנאי, `revealReservationCardAction` מפענח אותו חזרה לדפדפן. 8 מתוך 10 כרטיסים נושאים CVV, 7 מהאתר, החדש נוצר 2026-07-24. **הפרת PCI-DSS Req. 3.2.** `check-cards.mjs:180-187` **אוכף** את ההתנהגות ולכן CI נועל את ההפרה במקום להתריע | 9א + 9ג (אישור עצמאי כפול) | `create-booking.ts:193`, `card-actions.ts:258/283`, שאילתת פרודקשן | החלטת בעלים — לא נגענו |
| 2 | **מפתחות הצפנה חיים בגיבויי `.env` בעץ הפרודקשן** — `.env.local.bak-roles-2026-07-19` ו-`.env.local.pre-merge.bak` מחזיקים את אותו `CARD_VAULT_KEY` (מפענח כל PAN וכל CVV), `SUPABASE_SERVICE_ROLE_KEY`, ו-DSN של תפקיד `postgres`. `.gitignore` על `.env*` הופך את `check:no-secrets` לעיוור מבנית | 9א | השוואת SHA-256, ללא הדפסת ערכים | מחיקה/רוטציה — החלטת בעלים |
| 3 | **מרוץ over-refund מקלקל את ספר התשלומים** — הוכח על staging: שני החזרים ₪60 במקביל על גבייה ₪100 → `SUM(paid) = −20`, `paid_amount = 40`. `recomputePaymentAggregates` מאבד עדכונים בנפרד (50+70 על 100 → ספר 220, `paid_amount` 170) | 9ב (הוכח אמפירית) | `mutations.ts:62-77`, `ledger.ts:31-41` | לא נשך עדיין: **אפס החזרים בפרודקשן אי פעם** |
| 4 | **ביטול OTA נכנס משחרר חדר של אורח בצ'ק-אין** — `applyCancellation` הוא מסלול השחרור **היחיד** בריפו ללא שומר `checked_in`. `check:beds24-cancellation-sync` בודק רק את מסלול ה-reconciliation, לעולם לא את ה-poll הרגיל של 5 דקות | 9ב | `booking-import.ts:583-622` מול `applyLiveRevision:407` | מחלקת הכשל של D93, עדיין פתוחה במסלול שהשומר שלה לא מכסה |
| 5 | **PR #104 בולע כשל ספק אמיתי** — `if (creditPause && warnings.length === 0)` לא בודק `failure === null`. הוכח בזמן ריצה עם 500 + `remaining: 8.0`: `attempts: 0`, `last_error: null`. טווח שגוי לצמיתות **מנסה שוב לנצח ולא מגיע ל-dead-letter** — רגרסיה מול main | 9ד | הרצה בזמן ריצה | **חוסם מיזוג של #104** |
| 6 | **#104 + #110 = build שבור** — `beds24-booking-reports.ts:152` קורא `r.creditsRemaining` ש-#104 מוחק → `TS2339`. כל PR ירוק לבד; המיזוג השני חוסם `deploy:prod` | 9ד | typecheck על עץ ממוזג | תיקון שורה אחת, אומת |
| 7 | **#104 + #105 = שומר אדום לצמיתות** — #105 מקבע `x-fivemincreditlimit-remaining`, header שהוכח כלא קיים על החוט; #104 מוחק אותו | 9ד | `GET /v2/properties` חי | תיקון לפני מיזוג |
| 8 | **`check:channel-chaos` מאשר את שער ה-ACK על סמך הערה** — `booking-import.ts:42` בתוך בלוק `INVARIANTS`, לא קריאה. מחיקת ההערה שוברת את הבדיקה; מחיקת הפונקציה לא | 9ג | `grep -i acknowled` מחזיר רק שורות הערה | שומר ירוק-שקרי |
| 9 | **`/api/public/*` חשוף לאינטרנט** בניגוד להערה "over loopback" ב-`middleware.ts:45-46`. האימות תקין ואין IDOR, אבל rate-limit הוא דלי גלובלי יחיד 60/דקה על תהליך fork יחיד; `/api/public/availability` ללא הגבלה כלל; `create-booking.ts` לא קורא `writeAudit` | 9א | `HTTP 401` חי מ-`guesthub.bios.co.il` | |
| 10 | **שבירת שכבות `check:calendar`** — `reservations/actions.ts:37` באמת מייבא `beds24Request` (הגיע עם escape hatch של D93/PR #102). קריאת רשת 12 שניות בתוך Server Action, ללא breaker וללא הגבלת לחיצות | 9ב + 9ד | | הבדיקה האדומה **אינה** מיושנת |

---

## שתי בדיקות חדשות יצאו VACUOUS

הסוכן האדוורסרי שבר בכוונה את הקוד שכל שומר חדש טוען לשמור עליו. ארבעה מתוך שישה יצאו אדומים כמצופה. שניים לא:

| שומר | מה נשבר | תוצאה |
|------|---------|--------|
| `check:beds24-credit-backoff` (#104) | מחיקת `if (gate.pause) break` ב-`sendCalendarRequests` **וגם** כל ענף השהיית-הקרדיט ב-`drainBeds24AriDirtyRanges` (1,921 תווים) | **"all 11 assertions passed"** — שלושת התרחישים DB-backed נכנסים בלבד; ה-drain של 144 קרדיטים לריצה, שהוא המניע של כל ה-PR, אינו שמור |
| `check:beds24-ari-readback` (#106) | בקשה ל-500 יום תוך השארת `BEDS24_READBACK_DAYS = 14` | **"all 11 assertions passed"** — התקרה נטענת כקבוע, אף פעם לא על החוט |

`check:beds24-ari-drain`, `check:beds24-quarantine-selfheal`, `check:reservation-source-system`, `check:booking-com-reports` — כולם יצאו אדומים על כל שבירה. **PROVEN.**

---

## הצלבות ותיקונים למה שדווח קודם

- **`D108` אינו קיים.** `DECISIONS.md` מסתיים ב-D93. כלל "אפס נתוני כרטיס" שמשימה 8 נשענה עליו אינו רשום. גם **D78 אינו קיים** — עקבותיו היחידים הם `045_beds24_provider.sql:2` ו-~20 הערות בקוד. חסרים גם D71–D75, D79–D86, D107.
- **הנחת המשימה על `cvv_encrypted` ("5 שורות של בדיקה מבוטלת") הופרכה** משני כיוונים בלתי תלויים.
- **`check:calendar-ui` — פסק הדין "בדיקה מיושנת" אושר עצמאית** ע"י 9ד: `resolveChannelBadge` אף פעם לא מחזיר null, חמישה משטחים מסכימים, וצילום הייחוס של הבעלים אכן מראה תג עיפרון אפור על הזמנות פנימיות.
- **אין `.github/` ואין `check:all`** — 90+ שומרים מורצים ידנית. זו הסיבה המבנית שארבע בדיקות אדומות הגיעו ל-main.

---


---

## 9א — אבטחה

> ביקורת קריאה-בלבד על `origin/main = 5b171bd`, נקראה מ-`/home/ubuntu/worktrees/wt-night`.
> אף קובץ בעץ העבודה או בפרודקשן לא שונה. שאילתות DB — `SELECT` בלבד.
> תאריך: 2026-07-25. סה"כ ממצאים: **17** (3 חמור · 7 בינוני · 7 קל).

---

### תוצאות ה-`check:*` של הריפו (פלט אמיתי)

| script | תוצאה | פלט |
|---|---|---|
| `check:no-secrets` | ✅ PASS | `✓ no .env* file is tracked` · `✓ no .env* file was ever committed (history clean)` · `✓ no secret material in 431 tracked text files` · `✓ encryption env vars are read from process.env, never hardcoded` |
| `check:db-isolation` | ✅ PASS | `✓ no foreign application schemas` · `✓ guesthub schema present (65 tables)` |
| `check:channel-security` | ✅ PASS | `✓ no api-key / ciphertext / token reaches a log or an audit payload` · `✓ api-key travels only in the user-api-key header` · `✓ channel admin actions enforce canManageChannels server-side` |
| `check:retention` | ✅ PASS | `✓ purge_expired_cards present (H8 PCI-scope reduction)` · `✓ expired card (>90d post-stay) purged` |
| `check:e2e-safety` | ✅ PASS | `ALL 9 E2E/DEPLOY SAFETY CHECKS PASSED` (מטריצת ה-deploy-guard חוסמת נכון בכל 5 התרחישים) |
| `check:supply-chain` | ❌ **FAIL (1)** | `✗ unresolved high/critical advisories: 5 high, 0 critical` — ראה ב3 |

**מגבלות `check:no-secrets` שמצאתי (מעבר למה שהוא בודק):** סורק רק קבצים **tracked**; בודק hardcode רק ל-`CHANNEL_SECRETS_KEY` ו-`CARD_VAULT_KEY` (לא `MESSAGING_SECRETS_ENCRYPTION_KEY` ולא `PUBLIC_BOOKING_API_SECRET`); לא בודק את ה-bundle של הלקוח; לא בודק קבצי `.env*.bak` על הדיסק — וזה בדיוק החור שממצא **ח2** נופל בו.

---

## ⛔ חמור

### ח1 — `reservation_cards.cvv_encrypted` **חי בפרודקשן**: שני מסלולי כתיבה פעילים + מסלול קריאה מפורש (הפרת PCI-DSS Req. 3.2)

**הטענה שנשלחה לאימות — "אפס קוד חי כותב או קורא מהעמודה; ~5 השורות הן ניסוי נטוש/מושבת" — מופרכת.** העמודה הוחזרה במיגרציה 047 (D87) והקוד משתמש בה בכל שלושת הכיוונים.

**עדות — כתיבה #1 (API ציבורי, לא-אופציונלית):**
`src/lib/public-booking/create-booking.ts:187-196`
```
    INSERT INTO guesthub.reservation_cards
      (tenant_id, reservation_id, holder_name, holder_id_number,
       pan_encrypted, cvv_encrypted, key_version, brand, last4, exp_month, exp_year,
       source, received_at, created_by, updated_by)
    VALUES (..., ${encryptPan(pan)}, ${encryptCvv(input.card.cvv)}, ...)
```
ה-CVV הוא **שדה חובה** במסלול הזה — `src/app/api/public/bookings/route.ts:129-130` דוחה בקשה בלי CVV תקין (`cardFail("קוד האבטחה (CVV) אינו תקין")`).

**עדות — כתיבה #2 (Back-office, אופציונלי):**
`src/app/(dashboard)/reservations/card-actions.ts:145-147, 170-179`
```
    const cvvRaw = String(raw.cvv ?? "").trim();
    if (cvvRaw && !cvvValid(cvvRaw)) return fail("קוד אבטחה (CVV) אינו תקין");
    const cvvEncrypted = cvvRaw ? encryptCvv(cvvRaw) : null;
    ...
    ON CONFLICT (reservation_id) DO UPDATE SET ... cvv_encrypted = EXCLUDED.cvv_encrypted,
```

**עדות — קריאה + פענוח (חשיפה למסך):**
`src/app/(dashboard)/reservations/card-actions.ts:250-258, 283`
```
      SELECT id, reservation_id, pan_encrypted, cvv_encrypted, ...
    const cvv = row.cvv_encrypted ? decryptCvv(row.cvv_encrypted) : null;
    ...  return { success: true, data: { pan, ..., cvv, ... } };
```
ומסלול חיוב שני: `card-actions.ts:321, 346` (`chargeReservationCardAction`).
ה-UI מרנדר אותו: `src/components/reservations/CardFields.tsx:365-383` (`view.cvv`, כולל `CopyBtn`).

**עדות — DB פרודקשן (read-only, `SELECT` בלבד):**
```
 total_cards | with_cvv |   first    |    last
          10 |        8 | 2026-07-20 | 2026-07-24

   source    | n | with_cvv | first_created | last_created
 back_office | 2 |        1 | 2026-07-20    | 2026-07-20
 website     | 8 |        7 | 2026-07-20    | 2026-07-24
```
8 שורות (לא ~5) נושאות CVV מוצפן; 7 מהן מהאתר החי; **האחרונות נוצרו 2026-07-24** — לא ניסוי נטוש אלא זרם פעיל. (כל השורות עם CVV יושבות היום על הזמנות `cancelled`, כך שהנתונים עצמם נראים בדיקתיים — אבל *מסלול הקוד* חי ולא-מותנה, וכל הזמנת אתר אמיתית הבאה תאחסן CVV.)

**עדות — התיעוד סותר את הקוד:** `card-actions.ts:42-44` עדיין קובע
`"CVV/CVC is NEVER accepted, stored, encrypted, revealed, logged or audited (D52 §2) … no cvv_encrypted column exists (dropped in migration 018)"`,
ו-`card-actions.ts:215-216` מכריז `"Returns the full PAN and other stored card fields (NEVER a CVV — none is stored)"` — שורה אחת מעל הקוד שמחזיר CVV. סוקר אבטחה שקורא את הקובץ מלמעלה יסיק את ההפך מהמצב.
`src/lib/card-vault.ts:47-49` הוא המקום היחיד שאומר את האמת: `"ponytail: PCI-DSS Req. 3.2 forbids retaining a CVV after authorization"`.

**חומרה:** אחסון CVV אחרי אוטוריזציה אסור בפירוש ב-PCI-DSS Req. 3.2 — גם מוצפן. `db/migrations/047_restore_stored_cvv.sql:9` מסמן זאת בעצמו כ-`⚠️ COMPLIANCE CEILING`. הצירוף עם ח2 (המפתח שמפענח אותו יושב בשלושה קבצים) הוא מה שהופך את זה לחמור ולא לבינוני.

**תיקון מוצע (החלטת בעלים — לא לבצע בלי אישור, ובוודאי לא כמחיקה):**
1. **מיידי, ללא מחיקת נתונים:** להפוך את `encryptCvv(input.card.cvv)` ב-`create-booking.ts:193` ל-`NULL` ולהסיר את חובת ה-CVV מ-`bookings/route.ts:129-130` — האתר ממשיך לאסוף CVV לצורך אוטוריזציה חד-פעמית אך לא מתמיד אותו.
2. להסיר את `cvv` מה-payload של `revealReservationCardAction` (`card-actions.ts:283`) ומ-`CardFields.tsx:365-383`.
3. לתקן את ההערות ב-`card-actions.ts:42-44` ו-`:215-216` כך שיתארו את המצב בפועל (D87), בלי קשר להחלטה — הערה שקרית בקובץ כרטיסים היא סיכון בפני עצמה.
4. רק לאחר החלטת בעלים: מיגרציה 048 בתבנית 018 שמאפסת את הערכים (`UPDATE … SET cvv_encrypted = NULL` + `RAISE NOTICE` על ספירה בלבד) — **לא נעשה כאן, אין מחיקות בביקורת.**
5. לעדכן את `scripts/check-cards.mjs:180-187` בהתאם — היום הוא *אוכף* את התנהגות ה-CVV (`assert.ok(/cvv_encrypted/.test(cardActions))`), כלומר בדיקת ה-CI נועלת את ההפרה במקום להתריע עליה.

---

### ח2 — עותקי גיבוי לא-מנוהלים של `.env.local` בעץ הפרודקשן מחזיקים את **מפתח כספת הכרטיסים החי**, את `SUPABASE_SERVICE_ROLE_KEY` ואת ה-DSN של תפקיד `postgres`

**קובץ:** `/var/www/guesthub/.env.local.bak-roles-2026-07-19` ו-`/var/www/guesthub/.env.local.pre-merge.bak`

**עדות (השוואת SHA-256 מקוצר, ללא הדפסת ערכים):**
```
.env.local.bak-roles-2026-07-19 CARD_VAULT_KEY            bak=d6a5881d3ffa live=d6a5881d3ffa *** SAME AS LIVE ***
.env.local.bak-roles-2026-07-19 SUPABASE_SERVICE_ROLE_KEY bak=5761d5dda96f live=5761d5dda96f *** SAME AS LIVE ***
.env.local.bak-roles-2026-07-19 CHANNEL_SECRETS_KEY       bak=00cfa72272c5 live=00cfa72272c5 *** SAME AS LIVE ***
.env.local.pre-merge.bak        CARD_VAULT_KEY            bak=d6a5881d3ffa live=d6a5881d3ffa *** SAME AS LIVE ***
.env.local.pre-merge.bak        SUPABASE_SERVICE_ROLE_KEY bak=5761d5dda96f live=5761d5dda96f *** SAME AS LIVE ***
```
```
live DSN role: guesthub_app.bios-vps@localhost:5432/postgres
bak  DSN role: postgres.bios-vps@localhost:5432/postgres      ← בעל הסכימה guesthub
```
```
ls -la /var/www/guesthub/.env*
-rw-rw----+ 1 ubuntu devops-www 1426 Jul 20 18:20 .env.local
-rw-rw----+ 1 ubuntu devops-www 1230 Jul 19 19:53 .env.local.bak-roles-2026-07-19
-rw-rw----+ 1 ubuntu devops-www  991 Jul 19 19:26 .env.local.pre-merge.bak
```
```
psql -c "SELECT nspname, pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='guesthub'"
 guesthub | postgres
```

**למה זה חמור:** `CARD_VAULT_KEY` הוא המפתח היחיד שמפענח כל `pan_encrypted` **וכל `cvv_encrypted`** במערכת (`src/lib/card-vault.ts:50-51` — `encryptCvv = encryptPan`). כל קריאת-קובץ שרירותית אחת על המכונה (traversal, גיבוי שגוי, `rsync` רחב מדי, חבר קבוצת `devops-www`) מקבלת אותו — ועכשיו משלושה מקומות במקום אחד. ה-DSN של `postgres` בגיבוי הוא התפקיד שמחזיק בבעלות על סכימת `guesthub` — כלומר `DROP`/`ALTER` על כל הטבלאות. `.gitignore:37` (`.env*`) מונע commit, ולכן `check:no-secrets` ירוק ועיוור לזה. **לא בדקתי אם סיסמת `postgres` שבגיבוי עדיין תקפה** — לא ניסיתי להתחבר איתה (`pg_roles` מראה ש-`postgres` קיים, `rolcanlogin=t`, `rolsuper=f`).

**תיקון מוצע:** להעביר את שני קבצי ה-`.bak` אל מחוץ ל-`/var/www/guesthub` (או `shred -u` אחרי אישור), ולסובב את `CARD_VAULT_KEY`/`CHANNEL_SECRETS_KEY`/`MESSAGING_SECRETS_ENCRYPTION_KEY`/service-role בהתאם למדיניות — **סיבוב `CARD_VAULT_KEY` מחייב re-encrypt של `pan_encrypted`+`cvv_encrypted` דרך `key_version`, ולכן זו משימה מתוכננת ולא פעולה לילית.** להוסיף ל-`scripts/check-no-secrets.mjs` בדיקה חמישית: `readdir` על שורש הפרויקט ועל `/var/www/guesthub`, כשל אם קיים `.env*` שאינו `.env.local`/`.env.staging`/`*.example`.

---

### ח3 — `POST /api/public/bookings` (ה-sink לכרטיסים) חשוף לאינטרנט הפתוח בניגוד למתועד, ללא allow-list, **ללא audit**, ועם דלי rate-limit גלובלי יחיד

**מה הקוד מבטיח:** `src/middleware.ts:45-47`
```
  // Public booking API (sea-tower): server-to-server over loopback, no user
  // session. Authenticated inside the route via the x-booking-secret header
```
ו-`src/app/api/public/bookings/route.ts:18` — `"website checkout (sea-tower, server-to-server)"`.

**מה קורה בפועל:** `/etc/nginx/sites-enabled/guesthub.bios.co.il` מכיל `location / { proxy_pass http://127.0.0.1:3007; }` **בלי** בלוק `location /api/public/` ובלי `allow 127.0.0.1; deny all;`. אימות חי:
```
curl https://guesthub.bios.co.il/api/public/availability?check_in=... → HTTP 401 {"ok":false,"code":"unauthorized"}
curl -H "x-booking-secret: wrong" …                                   → HTTP 401
```
כלומר הנתיב **מגיע מהאינטרנט אל ה-handler**; מה שעוצר הוא רק הסוד היחיד.

**האימות עצמו תקין ולא מצאתי עקיפה:** `src/lib/public-booking/config.ts:23-29` משתמש ב-`timingSafeEqual` עם בדיקת אורך, והסוד בפרודקשן הוא 64 תווי hex (256 ביט). זה לא הממצא.

**הממצא הוא שלושה חוסרים סביבו:**

1. **אין allow-list ברמת ה-proxy.** הסוד הוא נקודת כשל יחידה, סטטית, ללא מנגנון סיבוב, שמגן על endpoint שמקבל PAN+CVV מלאים ומאחסן אותם לצמיתות (ראה ח1). דליפה שלו (log של sea-tower, env dump, PR) הופכת את המערכת ל-**PAN storage sink** וכן ל-oracle לבדיקת כרטיסים (`panValid`+Luhn ב-`bookings/route.ts:128`).
2. **אפס audit על הזמנת אתר.** `src/lib/public-booking/create-booking.ts` (262 שורות) **אינו קורא ל-`writeAudit` אפילו פעם אחת** — בניגוד למסלול הצוות (`card-actions.ts:196-201` כותב `card_save`). ה-DB מאשר:
   ```
    booking_origin | total | without_any_audit
    back_office    |    20 |                 0
    direct_website |     8 |                 5
    ota            |     5 |                 0
   ```
   ```
    reservation_card | card_save | 5     ← מול 10 כרטיסים בטבלה
   ```
   כלומר 5 מתוך 8 הזמנות האתר קיימות בלי שום רשומת audit, וכרטיסי האתר אף פעם לא נרשמים. ה-IP וה-User-Agent נשמרים רק כטקסט חופשי בתוך `reservations.notes` (`create-booking.ts:146-151`) — לא ניתן לשאילתה, לא חתום, ונמחק עם עריכת הערות.
3. **דלי rate-limit יחיד וגלובלי.** `src/app/api/public/bookings/route.ts:26-38`
   ```
   let windowStart = 0;
   let windowCount = 0;
   ...
   if (now - windowStart > 60_000) { windowStart = now; windowCount = 0; }
   if (++windowCount > 60) return fail(429, "rate_limited", "יותר מדי בקשות");
   ```
   מונה ברמת המודול, לא per-IP ולא per-guest. `pm2` מריץ את `guesthub` ב-`fork_mode` עם instance אחד, כך שזה דלי אחד ל**כל** התנועה: **כל מבקר באתר sea-tower יכול להשבית את משפך ההזמנות לכולם ב-60 בקשות/דקה.** ההערה בשורה 25 מודה בכך (`"real per-visitor limiting lives in sea-tower"`) — אבל אין אכיפה בצד הזה של הגבול. `GET /api/public/availability` (השאילתה הכבדה יותר — `effective_sell_state` על כל היחידות × כל הלילות) **חסר rate-limit לחלוטין**.

**IDOR — נבדק ונקי.** `PUBLIC_TENANT_ID` קבוע ב-`config.ts:12-13` ולעולם לא מגיע מהלקוח; `publicAvailability` מסנן `su.tenant_id = ${PUBLIC_TENANT_ID}` (`availability.ts:100`) ו-`effective_sell_state(${PUBLIC_TENANT_ID}, …)` (`:107`); `roomTypeId` מהלקוח נבדק מול `guesthub.rooms WHERE tenant_id = ${tenantId} AND room_type_id = …` (`create-booking.ts:71-73`); `preferredUnitId` חייב להופיע ברשימה המסוננת (`:82-89`). החלפת מזהה לא מגיעה לדייר אחר.

**דליפת מידע בשגיאות — נבדק ונקי ברובו.** `availability/route.ts:51-54` מחזיר `{ok:false, code:"internal"}` ומלוגג רק `e.message`. `bookings/route.ts:65-79` ממפה `23P01` ל-409 ידידותי ומחזיר `code:"internal"` על השאר. מה שכן עובר ללקוח: `PublicBookingError.message` ו-`StayPricingError.message` — מחרוזות עברית שלנו ממנוע התמחור, לא הודעות ספק/DB.

**תיקון מוצע:**
1. nginx: `location /api/public/ { allow 127.0.0.1; allow ::1; deny all; proxy_pass http://127.0.0.1:3007; }` — sea-tower יושב על אותה מכונה (:3005), אז זה שינוי חסר-סיכון שמצמצם את משטח התקיפה לאפס.
2. להוסיף `writeAudit`/`writeAuditRecord` ל-`create-booking.ts` בתוך אותה טרנזקציה: `entityType:'reservation' action:'public_booking_create'` + `entityType:'reservation_card' action:'card_save'` עם `ip`/`userAgent` בשדות ייעודיים ולא ב-`notes`.
3. להחליף את המונה הגלובלי ב-rate-limit לפי `meta.ip` (שכבר מגיע ב-body, `bookings/route.ts:160`) עם דלי משני גלובלי גבוה יותר; להוסיף גג דומה ל-`availability/route.ts`.
4. לתקן את ההערות ב-`middleware.ts:45-47` וב-`bookings/route.ts:18` — "loopback" אינו נכון היום ומטעה כל החלטת הקשחה עתידית.

---

## ⚠️ בינוני

### ב1 — אפס כותרות אבטחה ב-HTTP על אפליקציה שחושפת PAN מלא

**עדות (תגובה חיה מהפרודקשן):**
```
curl -sI https://guesthub.bios.co.il/login
HTTP/1.1 200 OK
Server: nginx/1.28.0 (Ubuntu)
X-Powered-By: Next.js
Cache-Control: no-store, must-revalidate
```
אין `Strict-Transport-Security`, אין `X-Frame-Options`/`Content-Security-Policy: frame-ancestors`, אין `X-Content-Type-Options: nosniff`, אין `Referrer-Policy`, אין CSP. `next.config.ts` (14 שורות, מצורף במלואו למטה) לא מגדיר `headers()` כלל:
```ts
const nextConfig: NextConfig = {
  experimental: { middlewareClientMaxBodySize: "18mb" },
};
```
המסך `/reservations` מריץ `revealReservationCardAction` שמחזיר PAN מלא (+CVV, ח1) ל-DOM; ללא `frame-ancestors` הוא ניתן למסגור. `X-Powered-By: Next.js` מפרסם את ה-framework לצד גרסה פגיעה (ב3).

**תיקון מוצע:** להוסיף ל-`next.config.ts`:
```ts
async headers() {
  return [{ source: "/:path*", headers: [
    { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  ]}];
}
```
ולכבות `poweredByHeader: false`. CSP מלא (`script-src`) דורש עבודה נפרדת מול Next inline scripts — לא לנסות בלילה.

### ב2 — `defaultWorkflowStatusId` מיוצא ממודול `"use server"` ⇒ Server Action ללא שום שער הרשאה

**קובץ:** `src/app/(dashboard)/reservations/actions.ts:144-155` (הקובץ פותח ב-`"use server";` בשורה 1)
```ts
export async function defaultWorkflowStatusId(
  db: TransactionSql,
  tenantId: string,
): Promise<string | null> {
  const [row] = await db<{ id: string }[]>`
    SELECT id FROM guesthub.lookup_items
    WHERE tenant_id = ${tenantId} AND category = 'workflow_statuses' ...`;
```
ב-App Router **כל** export אסינכרוני ממודול `"use server"` הופך ל-endpoint RPC עם action-id יציב. זו פונקציית עזר פנימית שנקראת גם מ-`booking-import.ts`, אבל היא נרשמת כ-action.

**ספירה מלאה:** סרקתי את 26 מודולי `"use server"` האמיתיים (מודול 27 — `src/lib/channel/beds24-token.ts` — הופיע ב-grep רק בגלל אזכור בהערה בשורה 12, ואין לו directive; אימתתי). **122 server actions מיוצאים סה"כ.** מתוכם `defaultWorkflowStatusId` הוא ה**יחיד** ללא שום שער; `loginAction` (`src/app/login/actions.ts:11`) ו-`logoutAction` (`src/lib/auth/actions.ts:6`) חסרי-שער בכוונה. שאר 119 עוברים `getActor()` + `requirePermission`/`hasPermission`/guard תפקיד.

**ניצולות בפועל: נמוכה.** הארגומנט הראשון הוא `TransactionSql`; לקוח לא יכול לשלוח פונקציה דרך ה-serialization של Next, ולכן `db\`…\`` יזרוק לפני כל גישה ל-DB. זו חשיפת משטח, לא דליפה מוכחת — אבל היא מבטלת את ההנחה ש"כל action בקובץ הזה מוגן".

**תיקון מוצע:** להסיר את `export` ולהעביר את הפונקציה ל-`src/lib/reservations/workflow.ts` (מודול רגיל), ולייבא משם בשני הצרכנים. להוסיף ל-`scripts/` בדיקה שסורקת מודולי `"use server"` ומוודאת ש-כל `export async function` מכיל `getActor(`/`require*` בגוף — הסקריפט שכתבתי לביקורת עושה בדיוק את זה ואפשר לאמץ אותו כ-`check:action-guards`.

### ב3 — `check:supply-chain` נכשל: 5 advisories ברמת high, אחד מהם **חל על הפריסה הזו**

**פלט אמיתי:** `✗ unresolved high/critical advisories: 5 high, 0 critical` → `check:supply-chain — FAIL (1)`

| חבילה | Advisory | vulnerable | patched | חל כאן? |
|---|---|---|---|---|
| `next` | **DoS in App Router using Server Actions** | `>=13.0.0 <15.5.21` | `>=15.5.21` | ✅ **כן** — 122 server actions, `next@15.5.20` מותקן |
| `next` | SSRF in Server Actions on **custom servers** | `>=14.1.1 <15.5.21` | `>=15.5.21` | ❌ לא — `pm2` מריץ `npm start` → `next start` (שרת סטנדרטי, אומת ב-`pm2 jlist`) |
| `next` | SSRF in **rewrites** via attacker-controlled destination host | `>=12.0.0 <15.5.21` | `>=15.5.21` | ❌ לא — `next.config.ts` לא מגדיר `rewrites` |
| `sharp` | libvips CVE-2026-33327/33328/35590/35591 | `<0.35.0` | `>=0.35.0` | ❌ לא נגיש — `next/image` **אינו בשימוש** בשום מקום ב-`src/` (grep על `next/image`/`<Image` החזיר רק קומפוננטה מקומית `<ImagesSection`), כך ש-sharp לא מעבד קלט משתמש |
| `brace-expansion` ×2, `postcss` | DoS / path-traversal ב-source-map | — | — | ❌ dev-only (`@eslint/eslintrc`, `@tailwindcss/postcss`), לא ב-runtime |

**תיקון מוצע:** שדרוג `next` ל-`15.5.21` (patch, ללא שינוי API) סוגר את היחיד שחל ואת שני האחרים כביטוח. `sharp` נגרר מ-`next` ויעלה איתו. השאר — dev-only, אפשר `pnpm.overrides` בעדכון תחזוקה מתוכנן.

### ב4 — סחיפה במודל ההרשאות: 18 מפתחות ב-`guesthub.permissions` שאף שורת קוד לא אוכפת

**מתודולוגיה:** חילצתי כל מפתח שמופיע ב-`requirePermission(actor, "…")`/`hasPermission(actor, "…")` ב-`src/` (**42** ייחודיים) והשוויתי מול `SELECT key FROM guesthub.permissions` בפרודקשן (**60**).

**נקי בכיוון אחד:** אפס מפתחות בקוד שאינם ב-DB — אין typo שיגרום לדחייה תמידית.

**הפער בכיוון השני — 18 מפתחות שמופיעים במטריצת ההרשאות אך אינם נאכפים בשום מקום:**
```
audit.view                          payments.create        roles.edit
communications.credentials.replace  payments.view          roles.view
communications.messages.resend      reports.view           users.create
dashboard.view                      reservations.delete    users.delete
guests.create                       lookups.edit           users.edit
guests.edit                         lookups.view           users.view
```
**המסוכן שבהם:** `payments.create` ו-`payments.view` קיימים במסך ההרשאות, אבל רישום תשלום חיצוני נאכף בפועל תחת מפתח אחר — `src/app/(dashboard)/reservations/card-actions.ts:437`:
```
export async function recordExternalPaymentAction(input: {   // :421
    requirePermission(actor, "payments.card_charge");         // :437
```
כלומר מנהל שמסיר `payments.create` ממשתמש מקבל משוב חיובי מהמסך והמשתמש ממשיך לרשום תשלומים. אותו דפוס ב-`reports.view` (`src/lib/reports/export.ts:21,52` אוכף `reservations.view`/`guests.view`), וב-`guests.create`/`guests.edit` (`guests/actions.ts:57` אוכף רק `guests.view`).

**תיקון מוצע:** לכל מפתח — או לחבר אותו לאכיפה אמיתית, או להסתיר אותו ממטריצת ההרשאות (`is_active=false` / סינון ב-`permissions/page.tsx:21`). להוסיף `check:permission-keys` שמשווה את שתי הקבוצות ונכשל על מפתח DB לא-נאכף.

### ב5 — 22 server actions עוקפים לגמרי את מודל ההרשאות של ה-DB (שער לפי `roleKey` בלבד)

**רשימה מלאה (מודול → actions):**
- `src/lib/channel/beds24-admin.ts` — 9: `getBeds24ConnectionAction:251`, `setupBeds24Action:332`, `testBeds24ConnectionAction:504`, `listBeds24PropertiesAction:562`, `mapBeds24RoomAction:591`, `unmapBeds24RoomAction:711`, `enableBeds24InboundAction:753`, `disableBeds24InboundAction:799`, `runBeds24FullSyncAction:844`
- `src/app/(dashboard)/settings/messaging-actions.ts` — 9: `getMessagingSettingsAction:95`, `saveGmailSettingsAction:165`, `saveGreenApiSettingsAction:215`, `saveTwilioSettingsAction:252`, `setActiveWhatsAppProviderAction:295`, `testProviderConnectionAction:310`, `sendTestMessageAction:345`, `disconnectProviderAction:396`, `rotateWebhookTokenAction:412`
- `src/lib/channel/external-changes-admin.ts` — 3: `:107`, `:137`, `:165`
- `src/lib/channel/admin.ts` — 1: `getChannelStatusAction:34`
- (+ `src/app/api/messaging/gmail/oauth/route.ts:28` ו-`callback/route.ts:52` בודקים `actor.roleKey !== "super_admin"` ישירות)

**העדות שזה מכוון ולא באג:** `src/lib/auth/guards.ts:124-140`
```ts
// ONLY super_admin may touch connections, credentials, mappings, sync or
// webhook configuration. admin does NOT qualify (unlike requirePermission's
// generic bypass) — integration secrets outrank ordinary full access.
export function canManageChannels(actor: GuardActor): GuardResult {
  if (actor.roleKey === "super_admin") return ok;
```
ההיגיון תקף: `requirePermission` נותן bypass גורף ל-`admin` (`permission-check.ts:15-17`), כך ש-`admin` היה מקבל את סודות האינטגרציה "בחינם".

**הבעיה:** 22 הפעולות הרגישות ביותר במערכת אינן נראות ואינן ניתנות לניהול ממסך ההרשאות; אין דרך להעניק גישה לערוצים בלי להעניק super_admin מלא; ואין רשומה ב-`guesthub.permissions` שתעיד עליהן ב-audit של הרשאות.

**תיקון מוצע:** להוסיף מפתחות `channels.manage` ו-`messaging.manage` ל-`guesthub.permissions` עם `PROTECTED_ROLE_KEYS` שמתיר רק `super_admin` להעניק אותם, ולהחליף את `canManageChannels/canManageMessaging` ב-`requirePermission` + בדיקת דרגה. מעבר מדורג — לא שינוי לילי.

### ב6 — הערות אבטחה שקובעות את **ההפך** מהקוד (3 מוקדים)

| קובץ:שורה | ההערה | המצב בפועל |
|---|---|---|
| `src/app/(dashboard)/reservations/card-actions.ts:42-44` | `"CVV/CVC is NEVER accepted, stored, encrypted… no cvv_encrypted column exists (dropped in migration 018)"` | מיגרציה 047 החזירה את העמודה; שורות 147/173/179 כותבות אליה |
| `src/app/(dashboard)/reservations/card-actions.ts:215-216` | `"Returns the full PAN and other stored card fields (NEVER a CVV — none is stored)"` | שורה 283 מחזירה `cvv` |
| `src/middleware.ts:45-46` | `"Public booking API (sea-tower): server-to-server over loopback"` | nginx חושף `/api/public/` לאינטרנט (ח3) |

**למה זה בינוני ולא קל:** הריפו הזה מסתמך על הערות-כותרת ככלי בקרה (`check:code-documentation` הוא script אמיתי), ושלושת המוקדים הם בדיוק המקומות שסוקר יקרא ראשונים. הערה שקרית כאן היא הסיבה שהטענה "אפס קוד חי נוגע ב-CVV" הגיעה לביקורת הזו מלכתחילה.

**תיקון מוצע:** לעדכן את שלוש ההערות למצב D87/D91 בפועל, ולהוסיף ל-`check:cards.mjs` assertion הפוך: שאם `cvv_encrypted` מופיע בקוד אז ההערה **לא** מכילה `"no cvv_encrypted column exists"`.

### ב7 — `GET /api/events` (SSE) מוגן באימות בלבד, ללא בדיקת הרשאה

**קובץ:** `src/app/api/events/route.ts:25-28`
```ts
export async function GET(request: Request) {
  const actor = await getActor();
  if (!actor) return new Response("unauthorized", { status: 401 });
  const tenantId = actor.tenantId;
```
זהו ה-route handler היחיד מתוך 10 שיש בו `getActor()` בלי `requirePermission` כלשהו. הזרם מקבל כל `DomainEvent` של הדייר — `reservation.created/updated/cancelled` עם `reservationId`, `roomIds`, `dateFrom/dateTo`, `lifecycle`, ו-`inventory.changed`. משתמש בתפקיד `cleaner` (שה-layout מנתב אותו ל-`/housekeeping/my-tasks` וחוסם ממנו את `reservations.view`) יכול לפתוח `EventSource('/api/events')` ולקבל את זרם ההזמנות המלא במטא-דאטה.

הבידוד לפי דייר תקין (`subscribeTenantEvents(tenantId, …)` ב-`:45`, ה-`tenantId` מהשרת ולא מהלקוח) והמטען מוגבל ל-whitelist — אין כאן דליפת נתוני אורח/כרטיס.

**תיקון מוצע:** `if (!hasPermission(actor, "calendar.view") && !hasPermission(actor, "reservations.view")) return new Response("forbidden", { status: 403 });` — או סינון האירועים לפי הרשאה בתוך ה-callback.

---

## ℹ️ קל

### ק1 — `deleteRoomAction`: מונה תלויות חוצה-דיירים (oracle קיום/שימוש)
`src/app/(dashboard)/rooms/actions.ts:457-465`
```
      SELECT
        (SELECT COUNT(*)::int FROM guesthub.reservation_rooms WHERE room_id = ${roomId}) AS reservations,
        (SELECT COUNT(*)::int FROM guesthub.housekeeping_tasks WHERE room_id = ${roomId}) AS housekeeping,
        (SELECT COUNT(*)::int FROM guesthub.room_closures      WHERE room_id = ${roomId}) AS closures,
        (SELECT COUNT(*)::int FROM guesthub.rates              WHERE room_id = ${roomId}) AS rates,
        (SELECT COUNT(*)::int FROM guesthub.bulk_rate_update_items WHERE room_id = ${roomId}) AS bulk`;
```
חמש תת-שאילתות על `roomId` מהלקוח **לפני** כל בדיקת בעלות, ותוצאתן חוזרת ללקוח כטקסט (`"לא ניתן למחוק חדר עם היסטוריה — הזמנות (כולל היסטוריה) (7), …"`, `:474-478`). המחיקה עצמה מוגנת (`:496` `WHERE id = ${roomId} AND tenant_id = ${actor.tenantId}` אחרי `SELECT … FOR UPDATE` תחום-דייר ב-`:482-485`), אז אין כתיבה חוצה-דיירים — רק חשיפת ספירות. היום יש דייר יחיד בפרודקשן, ולכן ההשפעה תיאורטית.
**תיקון:** להעביר את מונה התלויות אל תוך ה-`sql.begin` שאחרי בדיקת `FOR UPDATE`, או להוסיף `AND EXISTS (SELECT 1 FROM guesthub.rooms r WHERE r.id = ${roomId} AND r.tenant_id = ${actor.tenantId})`.

### ק2 — פרימיטיב אבטחה מת: `generateWebhookToken` השני
`src/lib/channel/crypto.ts:43-50`
```ts
// Webhook tokens are stored hashed only (§Y).
export function sha256Hex(value: string): string { … }
export function generateWebhookToken(): string {
  return randomBytes(32).toString("base64url"); // 256-bit, unguessable
}
```
grep על כל הריפו: **אפס קוראים** לשתי הפונקציות. העמודה `guesthub.channel_connections.webhook_token_hash` קיימת (אומת ב-`\d`) ואינה נכתבת בשום מקום. `docs/BEDS24_COMPLETION_PLAN.md:46` (P1-1) מסתמך על קיומן. ה-`generateWebhookToken` ה**פעיל** הוא אחר לגמרי — `src/lib/messaging/store.ts:19-21` (`randomBytes(24)`, 192 ביט) — ו-`scripts/check-messaging.mjs:89` בודק דווקא אותו.
**סיכון:** שם זהה בשני מודולים עם אורכים שונים ואחד מהם מת = מלכודת בזמן מימוש P1-1.
**תיקון:** למחוק את הפונקציות המתות מ-`channel/crypto.ts` (או לתעד במפורש שהן שמורות ל-P1-1 ולנמק את הפער 24↔32 בייט).

### ק3 — `GET /api/public/availability` ללא שום rate-limit
`src/app/api/public/availability/route.ts:15-38` — בין `requireBookingSecret` ל-`publicAvailability` אין מונה כלשהו, בניגוד ל-`bookings/route.ts:26-38`. השאילתה כבדה יותר (`effective_sell_state(tenant, from, to+1)` על כל היחידות × עד 30 לילות, `availability.ts:102-107`) ונקראת בכל חיפוש תאריכים באתר.
**תיקון:** לחלץ את הדלי מ-`bookings/route.ts` ל-`config.ts` ולהפעיל אותו בשני ה-endpoints (עם תקרות שונות).

### ק4 — ה-scopes של טוקן Beds24 נמשכים אך לא נקראים, לא נשמרים ולא מאומתים
`src/lib/channel/beds24-admin.ts:455-470` קורא `GET /authentication/details` תחת ההערה `"1) token validity/scopes — proves the credential authenticates at all"`, אך בודק רק `details.status !== 200` וזורק את הגוף. `\d guesthub.channel_connections` (36 עמודות) — **אין עמודת scopes**.
**תוצאה:** אין דרך לדעת מהמערכת אילו הרשאות הוענקו בפועל, ואין מי שיתריע כשמצמצמים אותן (P3-2).
**תיקון:** לפרסר את שדה ה-scopes מהתשובה, לשמור ב-`external_property_snapshot` או בעמודה חדשה, ולהציג ב-`/channels`; ואז `check:beds24-connection` יכול לאכוף שהסט המוענק ⊆ הסט הנדרש.

### ק5 — גוף webhook לא-מאומת נשמר verbatim ללא רדקציה וללא תקרת גודל
`src/lib/messaging/messages.ts:116-123` — `recordMessageEvent` כותב `${sql.json(args.raw)}` אל `message_events.raw`. הקורא: `src/app/api/messaging/webhook/green-api/[token]/route.ts:86-95` עם `raw: body` — הגוף המלא כפי שהגיע מהאינטרנט (GREEN-API לא חותם בקשות; רק ה-token מגן). nginx מתיר `client_max_body_size 18m`.
**גבולות ההשפעה:** התוקף חייב token תקף (192 ביט), `idMessage` קיים ששייך לאותו דייר (`:72`), ו-`status` מתוך 6 ערכים ממופים (`:22-37`) — כך שמספר השורות חסום. הנזק המקסימלי הוא ניפוח JSONB.
**תיקון:** להעביר את `body` דרך `redactPayload()` (קיים ב-`src/lib/channel/payloads.ts:20` וכבר חוסם `cvv|cvc|pan|security_code`) ולחתוך ל-64KB לפני האחסון.

### ק6 — `error_detail` של הספק חוזר verbatim ללקוח
`src/app/(dashboard)/communications/actions.ts:264-266`
```ts
    const [failure] = await sql<{ error_detail: string | null }[]>`
      SELECT error_detail FROM guesthub.outbound_messages WHERE id = ${row.id}`;
    return { success: false, error: failure?.error_detail || "שליחת הבדיקה נכשלה" };
```
`error_detail` נכתב מתשובת הספק (`src/lib/communications/delivery.ts:210`), כך ששגיאת Gmail/Twilio גולמית מגיעה למסך. נגיש רק למחזיק `communications.test.send`, וניתן לטעון שזה מכוון (אופרטור צריך את השגיאה כדי לתקן).
**תיקון:** אם משאירים — להוסיף הערה מפורשת שזו חשיפה מכוונת; אחרת למפות לקטגוריות קבועות כמו ב-`beds24-http.ts:40-51`.

### ק7 — `readCreditsRemaining` קורא שם-כותרת שאינו על החוט (הצלבה עם night-t2)
`src/lib/channel/beds24-http.ts:74-79`
```ts
function readCreditsRemaining(headers: Headers): number | null {
  const raw = headers?.get?.("x-fivemincreditlimit-remaining") ?? null;
```
הכותרות החיות הן `x-request-cost` / `x-five-min-limit-remaining` / `x-five-min-limit-resets-in`, ולכן הפונקציה מחזירה `null` תמיד ו-`creditsRemaining` לעולם לא מוצג ב-`/channels`. הזווית האבטחתית: מיצוי מכסה מול Beds24 = השבתה שקטה של סנכרון המלאי, בלי אינדיקציה. הממצא בבעלות `night-t2-credits`; מצוין כאן להצלבה בלבד.

---

## מה נבדק ונמצא **נקי** (תוצאה, לא שתיקה)

**1. Middleware ורשימת הפטורים.** `src/middleware.ts:37-62` — 4 פטורים מפורשים בלבד: `/login`, `/auth/callback`, `/api/messaging/webhook/*`, `/api/public/*`. כל אחד מנומק ומאומת:
- `/auth/callback` — `src/app/auth/callback/route.ts:73-98`: חילוף PKCE + אימות `amr==="oauth"` + זהות Google + שער `is_active AND allow_google_auth` תחום-דייר; כל הכשלונות מתמזגים להודעה ניטרלית אחת (`google_not_allowed`) — לא oracle לקיום אימייל. הפניות נבנות מ-`NEXT_PUBLIC_APP_URL` ולא מ-`request.url` — אין open-redirect.
- `/api/messaging/webhook/twilio/[token]` — **שתי** שכבות: token אטום + `X-Twilio-Signature` (HMAC-SHA1, `timingSafeEqual`) מעל ה-URL הקנוני מ-`NEXT_PUBLIC_APP_URL` ולא מ-`Host` שנשלט ע"י תוקף (`:78-83`). בדיקת `message.tenantId !== conn.tenantId` (`:88`).
- `/api/messaging/webhook/green-api/[token]` — token אטום בלבד (הספק לא חותם, מתועד ב-`:13-15`); `generateWebhookToken` = `randomBytes(24)` base64url = 192 ביט CSPRNG (`src/lib/messaging/store.ts:19-21`); בדיקת דייר ב-`:72`; אידמפוטנטי דרך `dedupKey`.
- `/api/public/*` — ראה ח3 (האימות עצמו תקין; ההערות והחשיפה הן הממצא).

**2. פטור סמוי אחד שמצאתי ואימתתי כשפיר.** ה-matcher עצמו (`middleware.ts:71`) מחריג כל נתיב שמסתיים ב-`.svg|.png|.jpg|.jpeg|.gif|.webp|.ico`. בפועל זה פוטר מאימות שני route handlers אמיתיים: `src/app/uploads/rooms/[roomId]/[name]/route.ts` ו-`src/app/uploads/logos/[tenantId]/[name]/route.ts`. שניהם מוגשים בכוונה ללא session (מתועד: `"Logos are public brand assets; access relies on UUID-unguessable filenames"`). Path traversal חסום — `ROOM_ID_RE = /^[0-9a-f-]{36}$/i` ו-`IMAGE_NAME_RE = /^[0-9a-f-]{36}\.(jpg|png|webp)$/i` (`src/lib/rooms/uploads.ts:16-17`) לא מתירים `.` או `/`, ולכן `path.join` לא יכול לצאת מ-`UPLOADS_DIR`. **הפער היחיד: הפטור הסמוי הזה לא מוזכר בהערת רשימת הפטורים** — כדאי להוסיף שורה.

**3. כל 10 ה-route handlers תחת `src/app/api/` — טבלת שערים מלאה.**

| route | שער | מסקנה |
|---|---|---|
| `branding/logo/route.ts:19-21` | `getActor` + `requirePermission("settings.edit")` | ✅ |
| `events/route.ts:26-27` | `getActor` בלבד | ⚠️ ב7 |
| `messaging/gmail/oauth/route.ts:27-30` | `getActor` + `roleKey==="super_admin"` | ✅ |
| `messaging/gmail/oauth/callback/route.ts:41-54` | CSRF state cookie (httpOnly/secure/lax, 600s) + `getActor` + super_admin + התאמת `tenantId` | ✅ |
| `messaging/webhook/green-api/[token]:65-75` | token אטום 192-ביט + בדיקת דייר | ✅ |
| `messaging/webhook/twilio/[token]:65-91` | token + HMAC + בדיקת דייר | ✅ |
| `public/availability:16-18` | `requireBookingSecret` (`timingSafeEqual`) | ✅ (ק3) |
| `public/bookings:30-38` | secret + `cardVaultConfigured()` fail-closed + דלי 60/דק' | ✅ (ח3) |
| `reservations/[id]/pdf:19-20` | `loadBookingDocData` → `getActor` + `hasPermission("reservations.view")` + `getReservationAction` תחום-דייר | ✅ |
| `rooms/images:20-36` | `getActor` + `requirePermission("rooms.edit")` + בדיקת בעלות על החדר + magic-bytes + תקרת גודל | ✅ |

**4. שערי הרשאה ברמת המסך — אחידים ומלאים.** כל 13 מסכי הדשבורד המכילים נתונים בודקים `getActor()` → `redirect("/auth/signout")` ואז `hasPermission(actor, "<screen>.view")` → `redirect("/dashboard")`: `calendar:21-22`, `channels:107-110` (`canManageChannels`), `communications/[section]:24-26`, `guests:20-21`, `housekeeping:14-15`, `maintenance:13-14`, `permissions:11-12`, `rate-plans:11-12`, `rates:21-22`, `reservations:48-49`, `rooms:23-24`, `settings:24-25`, `staff:17-18`. שני המסכים ללא שער הם `communications/page.tsx` (5 שורות, `redirect` בלבד) ו-`dashboard/page.tsx` (empty-state סטטי) — אין להם נתונים.

**5. `tenant_id` — סריקה ממצה של 533 SQL literals.** כתבתי סורק שמחלץ כל tagged-template (`sql`/`tx`/`db`) ב-`src/` שנוגע ב-`guesthub.*`:
```
TOTAL guesthub.* SQL literals scanned: 533
WITH tenant_id: 406
WITHOUT tenant_id: 127
  ├─ נוגעים רק בטבלאות חסרות tenant_id (tenants / permissions / roles /
  │  role_permissions / users): 48  →  כולם מסננים ב-WHERE id = ${actor.tenantId}
  └─ נוגעים בטבלאות תחומות-דייר: 79
```
סיווג ידני של כל 79:
- **~45** — worker/ingest פנימי, תחום ב-`connection_id` שנטען משאילתה תחומת-דייר (`channel/queue.ts`, `beds24-ari-sync.ts`, `beds24-booking-import.ts`, `outbox.ts`, `revisions.ts`, `rates-sync.ts`, `worker.ts`, `beds24-token.ts:164`, `beds24-admin.ts:179/285/652/659/768/774/805/857/882/897`).
- **~26** — קדם להם `SELECT … WHERE id = ? AND tenant_id = ${actor.tenantId} FOR UPDATE` באותה טרנזקציה. אומת אחד-אחד: `api/rooms/images:37` (מוגן ב-`:34-36`), `communications/actions:153` (מוגן ב-`:148-151`), `communications/actions:264` (`row.id` של ה-INSERT עצמו), `rate-plans/actions:390/402/403` (מוגן ב-`:384-388`), `commercial-actions:282/284` (מוגן ב-`:257-262`), `rooms/actions:400` (מוגן ב-`:351-354`), `messaging/messages:50/79` (נקרא רק אחרי `message.tenantId !== conn.tenantId`).
- **5** — קריאות לפונקציות set-returning שמקבלות `tenantId` כפרמטר ראשון: `inventory.ts:68`, `rates/grid-state.ts:125,132`, `public-booking/availability.ts:102`, `reports/queries.ts:64`.
- **2 false-negatives של הסורק** — `reservations/data.ts:197` בונה `WHERE ${where}` כאשר `where` מתחיל ב-`res.tenant_id = ${tenantId}` (`:155-156`), ו-`data.ts:253` מסנן `WHERE res.tenant_id = ${tenantId}`.
- **1 ממצא אמיתי** — `rooms/actions.ts:457` (ק1).

**מסקנה: אפס דליפות `tenant_id` הניתנות לניצול.** `getActor()` (`src/lib/auth/actor.ts:87-103`) פותר `tenant_id` מ-`auth_user_id` של הסשן, ולעולם לא מקלט לקוח — ההערה בשורה 7 (`"Never trust a client-supplied tenantId"`) נאכפת בפועל בכל 122 ה-actions.

**6. סודות ב-bundle של הלקוח.** ארבעה משתני `NEXT_PUBLIC_*` בלבד בכל הריפו, כולם ציבוריים לגיטימית: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`. כל שאר 12 משתני הסביבה (`CARD_VAULT_KEY`, `CHANNEL_SECRETS_KEY`, `MESSAGING_SECRETS_ENCRYPTION_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `PUBLIC_BOOKING_API_SECRET`, `GOOGLE_OAUTH_CLIENT_SECRET`, `DATABASE_URL`, …) נקראים אך ורק בקבצים עם `import "server-only"` או במודולי `"use server"`. הרצתי מעקב גרף-ייבוא על **67** קומפוננטות `"use client"` בעומק 4; כל מסלול שהגיע למודול נושא-סוד עובר דרך גבול `"use server"` (ש-Next חותך ל-RPC stub) או דרך `import type` בלבד (אומת ידנית ב-`ReservationsScreen.tsx:12`, `GuestsScreen.tsx:12`, `rates/CellDetailPanel.tsx:8-9`, `settings/CancellationSection.tsx`).

**7. סודות בלוגים.** 40 קריאות `console.*` ב-`src/`, כולן `console.error`/`console.warn` (אפס `console.log`, בהתאם לכלל ברזל #3). 30 מהן מעבירות אובייקט שגיאה גולמי (`console.error("[reservation-cards]", e)` — `card-actions.ts:57`). **בדקתי אמפירית מול staging** האם דרייבר `postgres` מצרף פרמטרי-שאילתה לשגיאה:
```
error keys: name, severity_local, severity, code, file, line, routine
has .query? true | has .parameters? true
serialized (getOwnPropertyNames) contains the secret literal? true
util.inspect output contains secret? false          ← מה ש-console.error מדפיס
```
`query`/`parameters` הם own-properties **לא-enumerable**, ולכן `util.inspect` (וממילא `console.error`) אינו מדפיס אותם. **נקי — עם אזהרה:** כל מעבר עתידי ל-logger שמסדר JSON (`pino`, `winston` עם `errors({stack:true})`, או `JSON.stringify(e, Object.getOwnPropertyNames(e))`) יתחיל לדלוף ciphertext ו-PII (`holder_name`, `holder_id_number`) לקבצי הלוג. שווה הערת-כותרת ב-`audit.ts`.

**8. תקינות מפתחות ההרשאה.** אפס מפתחות בקוד שאינם בטבלת `guesthub.permissions` — אין `requirePermission` עם typo שיידחה תמיד. הפער ההפוך מדווח ב-ב4.

**9. חוזק הסודות בפרודקשן (אורך/charset בלבד, ללא הדפסת ערכים):**
```
PUBLIC_BOOKING_API_SECRET        len=64 charset=hex        (256 ביט)
CHANNEL_SECRETS_KEY              len=64 charset=hex        (256 ביט)
CARD_VAULT_KEY                   len=44 charset=base64ish  (256 ביט)
MESSAGING_SECRETS_ENCRYPTION_KEY len=44 charset=base64ish  (256 ביט)
```
כולם באורך תקין. אין fallback hardcoded לאף אחד מהם (אומת ידנית ב-`card-vault.ts`, `channel/crypto.ts`, `messaging/secrets.ts`, `public-booking/config.ts:24`).

**10. הפרדת DB.** `check:db-isolation` ירוק: אין סכימות אפליקציה זרות, `public` ריקה מטבלאות זרות, `guesthub` עם 65 טבלאות. `DATABASE_URL` החי משתמש ב-`guesthub_app` (לא `postgres`) — הפרדת התפקידים בוצעה. `check:retention` ירוק: `purge_expired_cards` קיים ומוכח שמוחק כרטיס >90 יום אחרי השהות ומשמר כרטיס בחלון.

---

## מפת ה-scopes של Beds24 — הכנה ל-P3-2

**מתודולוגיה:** חילצתי כל קריאת HTTP יוצאת ל-Beds24 מ-`src/lib/channel/` (grep על `beds24Request(`/`beds24AuthRequest(` → 9 אתרי קריאה; grep על `method: "` → 7 מתודות מפורשות). זו הרשימה **המלאה** — אין בנייה דינמית של host/endpoint.

| endpoint | method | אתרי קריאה (`file:line`) | scope שנדרש בפועל | מטרה |
|---|---|---|---|---|
| `/authentication/setup` | GET | `beds24-admin.ts:343-346` (header `code`) | — (endpoint אימות) | חילוף invite-code חד-פעמי → refresh token |
| `/authentication/token` | GET | `beds24-admin.ts:160-163`, `beds24-token.ts:143-146` (header `refreshToken`) | — (endpoint אימות) | הנפקת access token ל-24 שעות |
| `/authentication/details` | GET | `beds24-admin.ts:456-460` | — (introspection) | בדיקת תקפות טוקן ב-probe |
| `/properties` (+`?id=`, `?includeAllRooms=true`, `?page=`) | GET | `beds24-admin.ts:474-478`, `beds24-properties.ts:121-124`, `beds24-properties.ts:142-145` | **`read:properties`** | רשימת נכסים/חדרים למסך המיפוי |
| `/bookings?…&includeGuests=true&includeInvoiceItems=true&page=` | GET | `beds24-booking-import.ts:144-146` (בונה ב-`:481` ו-`:496`) | **`read:bookings`** + **`read:bookings-personal`** (בגלל `includeGuests`) + **`read:bookings-financial`** (בגלל `includeInvoiceItems`) | משיכת הזמנות OTA נכנסות (`modifiedFrom` אינקרמנטלי + `arrivalFrom` backfill) |
| `/inventory/rooms/calendar` | **POST** | `beds24-ari.ts:114-120` | **`write:inventory`** | דחיפת ARI יוצאת (מחירים/זמינות/מגבלות) |

### scopes שאין להם שום צרכן בקוד

| scope | הוכחת אי-שימוש | הערה |
|---|---|---|
| **`all:accounts`** | grep על `"/accounts` בכל `src/` — **0 תוצאות**. אין קריאה, אין תכנון ב-`docs/BEDS24_COMPLETION_PLAN.md`. | מועמד ראשון להסרה — הרחב ביותר, שימוש אפסי |
| **`write:properties`** (החלק הכותב של `all:properties`) | כל 3 קריאות `/properties` הן `method: "GET"`. `beds24-admin.ts:37-38` מצהיר במפורש: `"READ-ONLY PHASE… A write to Beds24 is NEVER issued from this module."` | להצר ל-`read:properties` |
| **`write:bookings`** (החלק הכותב של `all:bookings`) | הקריאה היחידה ל-`/bookings` היא `method: "GET"` (`beds24-booking-import.ts:146`) | מוצדק **רק** אם P3-1 (דחיפת הזמנות ל-Beds24) יאושר; היום מיותר |
| **`all:channels`** | grep על `"/channels` בכל `src/` — **0 תוצאות** | להסיר |
| **`read:inventory`** | לא נדרש בנפרד — `write:inventory` מספיק ל-POST היחיד; אין GET על `/inventory` | — |

### הסט המינימלי המומלץ
```
read:properties
read:bookings  +  read:bookings-personal  +  read:bookings-financial
write:inventory
```
זה תואם את מה ש-`docs/BEDS24_COMPLETION_PLAN.md:61` (P3-2) כבר מציע, ומאושש כאן מול הקוד בפועל ולא מול הזיכרון.

### שני חסמים תפעוליים לפני ביצוע
1. **ה-scopes ננעלים בזמן יצירת ה-invite-code** — צמצום מחייב הנפקת invite-code חדש בממשק Beds24 והרצת `setupBeds24Action` מחדש (`beds24-admin.ts:332`), כלומר חלון השבתה קצר של הסנכרון. `check:beds24-connection` צריך לרוץ מיד אחרי.
2. **המערכת לא יודעת מהם ה-scopes הנוכחיים** (ק4) — אין עמודה, אין פרסור. לפני צמצום כדאי להוסיף את הרישום, אחרת אין דרך לאמת שהצמצום הצליח חוץ מלחכות לשגיאת 403. `beds24-http.ts:42` כבר ממפה 403 להודעה `"הגישה נאסרה (403) — לטוקן Beds24 אין הרשאה (scope) מתאימה"`, כך שהכשל יהיה קריא — אבל בדיעבד.

**⚠️ לא נגעתי בטוקן ולא ב-scopes.** כל האמור לעיל הוא מיפוי סטטי מהקוד; לא בוצעה שום קריאה ל-Beds24 ולא שונתה שום הרשאה.

---

## מה לא הצלחתי לאמת

1. **האם סיסמת `postgres` שב-`.env.local.bak-roles-2026-07-19` עדיין תקפה.** לא ניסיתי להתחבר איתה — התחברות כבעל-סכימה לפרודקשן חורגת ממנדט "SELECT בלבד". ידוע: התפקיד `postgres` קיים, `rolcanlogin=t`, `rolsuper=f`, והוא בעל `guesthub`.
2. **האם `sea-tower` קורא ל-`/api/public/*` דרך loopback או דרך `https://guesthub.bios.co.il`.** לא קראתי את הקוד/קונפיג של sea-tower (מחוץ לתחום המשימה). זה משנה רק את קלות התיקון של ח3 §1, לא את הממצא.
3. **האם ה-8 שורות עם CVV הן באמת בדיקות.** כולן יושבות על הזמנות `cancelled`, מה שמרמז על בדיקות — אבל לא בדקתי את התוכן המפוענח (לא ארצה, ולא צריך: הממצא הוא שמסלול הקוד חי ולא-מותנה, לא זהות הנתונים).
4. **האם `check:calendar-ui`/בדיקות DB-backed אחרות עוברות** — לא הרצתי אותן; הן דורשות `guesthub-testdb` ואינן בתחום 9א (ידוע כשל קיים מ-MEMORY.md).
5. **בדיקת CSP/headers ב-bundle שנבנה** — לא בניתי את הפרויקט (prebuild-guard + עץ משותף עם 3 סוכנים במקביל). ההסקה על ה-bundle נעשתה מגרף הייבוא הסטטי, לא מהפלט.


---

## 9ב — ביקורת קוד

**סוכן:** AUDIT AGENT 9b (code review) · ריצת לילה אוטונומית
**בסיס:** `/home/ubuntu/worktrees/wt-night` @ `5b171bd` (= origin/main) · READ-ONLY
**תאריך:** 2026-07-25
**היקף:** `src/`, `db/migrations/`, `scripts/`

> כל ממצא כאן הוא **שורה בדוח בלבד** — לא בוצע ולו שינוי קוד אחד, מחיקה אחת או דפלוי אחד.
> שתי בדיקות מסד־נתונים והוכחת־מירוץ אחת הורצו מול **staging** (`127.0.0.1:5434`) עם
> tenant חד־פעמי שנוצר ונמחק ע"י התסריט עצמו — בדיוק כמו תסריטי `check:*` של הריפו.
> על מסד הפרודקשן לא בוצעה כל כתיבה.

---

## תקציר מנהלים

| חומרה | כמות |
|-------|------|
| חמור   | 4 |
| בינוני | 9 |
| קל     | 9 |
| **סה"כ** | **22** |

שלושת החמורים הכי דחופים:

1. **F1** — מנגנון "אין החזר מעבר לגבייה" ב-`recordRefund` הוא read-then-write ללא נעילה. **הוכח אמפירית** על staging: שני החזרים במקביל הפילו את הספר ל-‎−20 ואת ה-cache ל-40.
2. **F2** — `recomputePaymentAggregates` מאבד עדכון (lost update) כששני תשלומים נכנסים במקביל. **הוכח אמפירית**: ספר=220, `paid_amount`=170, `balance`=130.
3. **F3** — ביטול OTAנכנס משחרר חדר של אורח **בצ'ק-אין**. `applyCancellation` הוא היחיד בכל המערכת בלי שומר `checked_in` — בניגוד ל-`applyLiveRevision`, ל-reconciliation ול-`releaseChannelReservationAction`.

---

## 0. פלט אמיתי של בדיקות הריפו

> שים לב: `check:pms-domain-invariants`, `check:inventory-integrity` ו-`check:payment-ledger-integrity`
> נופלים בברירת מחדל על `STAGING_DATABASE_URL` (`scripts/check-payment-ledger-integrity.mjs:22`
> וכו'), **לא** על פרודקשן. אימתתי שהתסריטים SELECT-only בלבד (אפס
> `INSERT/UPDATE/DELETE/DDL`) והרצתי אותם **גם** מול מסד הפרודקשן עם `CHECK_DB_URL` — קריאה בלבד.

| בדיקה | תוצאה (staging) | תוצאה (פרודקשן, SELECT-only) | הערה |
|-------|------|------|------|
| `check:pms-domain-invariants` | ✅ PASSED (7 ✓) | ✅ PASSED (7 ✓) | |
| `check:inventory-integrity` | ✅ PASSED (6 ✓) | ✅ PASSED (6 ✓) | `rr_no_double_booking` קיים, אפס חפיפות בנתונים החיים |
| `check:payment-ledger-integrity` | ✅ PASSED (5 ✓) | ✅ PASSED (5 ✓) | **`captured contra/refund entries (negative 'paid'): 0`** — מעולם לא נרשם החזר בפרודקשן. זו הסיבה היחידה ש-F1 עוד לא נשך. |
| `check:timezone-and-money-invariants` | ✅ PASSED (5 קבוצות) | — | סריקת float-money דולגה (אין `CHECK_DB_URL` בריצה הראשונה) |
| `check:reservation-concurrency` | ⚠️ `exit=2` בלי DB → הורץ מול staging: **✅ PASSED** | A/B/C כולם ✓ — ה-DB באמת מונע double-booking |
| `check:background-job-recovery` | ⚠️ `exit=2` בלי DB → הורץ מול staging: **✅ PASSED** (9 ✓) | כולל §24 rollback ו-dead-letter |
| `check:payment-refund-void` | ⚠️ `exit=2` בלי DB → הורץ מול staging: **✅ PASSED** (5 ✓) | **בודק רק סדרתית** — ראה F1 |
| `check:calendar` | ❌ **FAILED** | `src/app/(dashboard)/reservations/actions.ts must not import the channel HTTP layer (@/lib/channel/beds24-http)` — ראה F4 |
| `check:design` | ❌ FAILED (6 הפרות) | ידוע מראש — `src/app/housekeeping/my-tasks/MyTasksScreen.tsx:160,166,170,180,183,193` |
| `check:calendar-ui` | ❌ FAILED | `the channel row is CONDITIONAL — an internal reservation gets no row, not an empty one` (`scripts/check-calendar-ui.mjs:372`) |
| `check:channels-badge` | ❌ FAILED | `exactly four visible channel definitions — no manual entry`; בפועל `['airbnb','booking','expedia','manual','site']` |
| `check:db-isolation`, `check:channel-security`, `check:beds24*`, `check:performance`, `check:code-documentation`, `check:status-default`, `check:reservation-snapshot`, `check:inventory`, `check:e2e-safety`, `check:no-secrets`, `check:retention`, `check:payments`, `check:housekeeping`, `check:maintenance-closures`, `check:reports` | ✅ PASSED | |

**ממצא־על:** אין `.github/`, אין סקריפט אגרגטיבי (`check:all` / `ci` / `verify`) ב-`package.json`.
90+ בדיקות ה-`check:*` מורצות **ידנית בלבד**. זה בדיוק המנגנון שאיפשר ל-`check:calendar`
להישאר אדום על main. ראה K3.

---

## חמור

### F1 · מרוץ over-refund: ההגנה "אי אפשר להחזיר יותר ממה שנגבה" נשברת בהחזרים במקביל  🔴 הוכח

**קובץ:** `src/lib/payments/mutations.ts:62-77`
**קורא:** `src/app/(dashboard)/reservations/card-actions.ts:551-557` (`refundPaymentAction`)

**EVIDENCE** — `mutations.ts:61-77`:
```ts
  // net captured so far (paid contra entries already netted)
  const [{ paid: netPaid }] = await tx<{ paid: number }[]>`
    SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)::float8 AS paid
    FROM guesthub.payments
    WHERE reservation_id = ${args.reservationId} AND tenant_id = ${args.tenantId}`;
  if (amount > netPaid + 1e-9) {
    throw new Error(`refund ${amount} exceeds net captured ${netPaid}`);
  }

  // idempotent: a retry with the same key inserts nothing
  const inserted = await tx`
    INSERT INTO guesthub.payments ... VALUES (..., ${-amount}, ..., 'paid', ...)
```
ה-JSDoc מעל (שורה 43) מבטיח: *"Fails closed if it would drive net captured below zero."*
אין `FOR UPDATE`, אין נעילה על שורת ההזמנה, ואין אילוץ DB שאוסר סכום שלילי.
`refundPaymentAction` פותח `sql.begin` וקורא ישירות ל-`recordRefund` — גם הוא בלי נעילה.

**FAILURE SCENARIO (interleaving):** להזמנה יש גבייה של ₪100. שני פקידים (או קליק כפול
שעקף debounce) מבצעים החזר של ₪60 כל אחד:

| זמן | T1 | T2 |
|-----|----|----|
| t0 | `SELECT SUM → 100`; 60 ≤ 100 ✔ | |
| t1 | | `SELECT SUM → 100` (T1 עוד לא commit); 60 ≤ 100 ✔ |
| t2 | `INSERT −60` | |
| t3 | | `INSERT −60` |
| t4 | `UPDATE res …` COMMIT | |
| t5 | | `UPDATE res …` COMMIT |

**הוכחה אמפירית (staging, tenant חד־פעמי):**
```
R1 concurrent refund 60+60 over a 100 capture:
   second tx: SUCCEEDED (no guard)
   ledger SUM(paid) = -20   reservations.paid_amount = 40  balance = 260
   => *** OVER-REFUND: net captured went NEGATIVE ***
   => *** CACHE DRIFT: paid_amount != ledger SUM ***
```
זה שובר **שתי** אמירות של `check:payment-ledger-integrity` בבת אחת
(`paid_amount == SUM(paid payments)` ו-`balance == total_price - paid_amount`),
ומחזיר ללקוח ₪120 על גבייה של ₪100.

מדוע `check:payment-refund-void` לא תופס: הוא מריץ capture→refund→refund→void **סדרתית**
בתוך תהליך אחד (`scripts/check-payment-refund-void.mjs`) ולא בודק במקביל כלל.

**PROPOSED FIX** — לנעול את שורת ההזמנה כמשפט הראשון של `recordRefund`, לפני קריאת האגרגט:
```ts
await tx`SELECT 1 FROM guesthub.reservations
         WHERE id = ${args.reservationId} AND tenant_id = ${args.tenantId} FOR UPDATE`;
```
ב-READ COMMITTED, אחרי שהנעילה משתחררת המשפט **הבא** מקבל snapshot חדש שרואה את ה-commit.
**אומת אמפירית על staging:**
```
FIXED R1: second tx -> GUARD: refund 60 exceeds net captured 40; ledger=40 cache=40  OK
```
בנוסף מומלץ (הגנת עומק): `CHECK`/טריגר שאוסר `SUM(amount) FILTER (status='paid') < 0`
לכל `reservation_id`, ותוספת תרחיש מקבילי ל-`scripts/check-payment-refund-void.mjs`.

---

### F2 · `recomputePaymentAggregates` — lost update: `paid_amount` נכתב על בסיס snapshot ישן  🔴 הוכח

**קובץ:** `src/lib/payments/ledger.ts:31-41`

**EVIDENCE:**
```ts
  const [row] = await tx<{ paid: number; balance: number; total: number }[]>`
    UPDATE guesthub.reservations res SET
      paid_amount = x.paid,
      balance = res.total_price - x.paid
    FROM (
      SELECT COALESCE(SUM(amount) FILTER (WHERE status = ${COLLECTED_PAYMENT_STATUS}), 0) AS paid
      FROM guesthub.payments
      WHERE reservation_id = ${reservationId} AND tenant_id = ${tenantId}
    ) x
    WHERE res.id = ${reservationId} AND res.tenant_id = ${tenantId}
```
נעילת השורה שה-`UPDATE` לוקח **אינה** מגנה על תת־השאילתה `x`: היא כבר חושבה תחת ה-snapshot
של תחילת המשפט. טרנזקציה שממתינה על הנעילה מתעוררת ומרססת ערך שחושב לפני ה-commit של השנייה.

**קוראים שאינם מחזיקים `FOR UPDATE` על ההזמנה לפני הקריאה:**

| קובץ:שורה | פעולה | נעילה? |
|-----------|-------|--------|
| `src/app/(dashboard)/reservations/card-actions.ts:389` | `chargeReservationCardAction` (חיוב כרטיס אשראי) | ❌ אין |
| `src/app/(dashboard)/reservations/card-actions.ts:552→mutations.ts:80` | `refundPaymentAction` | ❌ אין |
| `src/app/(dashboard)/reservations/card-actions.ts:586→mutations.ts:36` | `voidPaymentAction` | ❌ (נועל רק את שורת ה-payment) |
| `src/lib/channel/booking-import.ts:499` | ייבוא OTA (הזמנה חדשה) | חלקי — רק במסלול `existing` |
| `src/app/(dashboard)/reservations/card-actions.ts:472` | `recordExternalPaymentAction` | ✅ יש (שורה 447) |
| `src/app/(dashboard)/reservations/actions.ts:574` | `updateReservationAction` | ✅ יש (שורה 370) |

מספיק שצד **אחד** לא נועל כדי לאבד עדכון — גם כשהצד השני נועל.

**FAILURE SCENARIO:** פקיד A מחייב כרטיס ב-₪70 (`chargeReservationCardAction`, בלי נעילה)
בזמן שפקיד B רושם תשלום חיצוני של ₪50 (`recordExternalPaymentAction`, עם נעילה).
B תופס את הנעילה; A מכניס שורת תשלום (לא דורש נעילה), ואז נחסם ב-`UPDATE`.
B מסיים; A מתעורר וכותב `paid_amount` שמחושב מ-snapshot שלא ראה את ₪50 של B.

**הוכחה אמפירית (staging):**
```
R2 concurrent payments 50 & 70 over a 100 capture (expected ledger 220):
   ledger SUM(paid) = 220   reservations.paid_amount = 170  balance = 130
   => *** LOST UPDATE: paid_amount cache != ledger SUM ***
```
תוצאה עסקית: האורח מוצג כחייב ₪50 שכבר שילם; `check:payment-ledger-integrity` ייפול.

**PROPOSED FIX** — לנעול בתוך `recomputePaymentAggregates` עצמה, כך שכל קורא מוגן:
```ts
await tx`SELECT 1 FROM guesthub.reservations
         WHERE id = ${reservationId} AND tenant_id = ${tenantId} FOR UPDATE`;
```
**אומת אמפירית:** `FIXED R2: ledger=220 cache=220  OK`.

---

### F3 · ביטול OTA נכנס משחרר חדר של אורח שנמצא בצ'ק-אין  🔴

**קובץ:** `src/lib/channel/booking-import.ts:583-622` (`applyCancellation`)

**EVIDENCE** — `booking-import.ts:583-608`:
```ts
  if (existing.status !== "cancelled") {
    const origin = existing.external_cancellation_requested_at ? "invalid_card" : "ota_revision";
    await tx`
      UPDATE guesthub.reservations SET
        status = 'cancelled', ...
      WHERE id = ${existing.id} AND tenant_id = ${conn.tenant_id}`;
    // same release semantics as the local cancel action: the status change
    // frees the nights; republish those rooms/dates
    await markAriDirty(tx, { tenantId: conn.tenant_id, roomIds: oldRoomIds, ... });
```
אין שום התייחסות ל-`PRESERVED_STATUSES`. באותו קובץ, שורה 325 + 407:
```ts
const PRESERVED_STATUSES = new Set(["checked_in", "checked_out"]);
...
const status = PRESERVED_STATUSES.has(existing.status) ? existing.status : "confirmed";
```
כלומר מסלול ה-**modify** כן שומר `checked_in`; מסלול ה-**cancel** לא.
ושני מסלולים אחרים מגנים במפורש על אותו מצב:
* `src/lib/channel/beds24-booking-import.ts:586-599` — *"the guest is physically in the room — releasing would erase a live stay"* → `alerts += 1`, בלי שחרור.
* `src/app/(dashboard)/reservations/actions.ts:797-798` — `if (res.status === "checked_in") return fail("האורח בצ'ק-אין — שחרור אוטומטי חסום…")`.

**FAILURE SCENARIO (interleaving):**
1. יום א' — אורח Booking.com עושה צ'ק-אין לחדר 12 עד יום ה'. `status='checked_in'`, `is_blocking=true`.
2. יום ב' — Booking.com/האורח מבטל את ההזמנה בערוץ (no-show דיווח, מחלוקת, ביטול שגוי).
3. תוך ≤5 דקות ה-poll (`runBeds24InboundPull`, `LOOKBACK_DAYS=7`, `BEDS24_STATUS_FILTER` כולל `status=cancelled`) מושך את הרוויזיה המבוטלת.
4. `importNormalizedRevision` → `norm.kind === "cancelled"` → `applyCancellation` → `status='cancelled'`.
5. הטריגר `res_propagate_blocking` (`db/migrations/037_double_booking_guard.sql`) מוריד `is_blocking=false` בכל שורות ה-`reservation_rooms`.
6. `markAriDirty` + `inventory.changed` מפרסמים את הלילות ג'–ה' כזמינים בערוץ.
7. הזמנה חדשה נכנסת לחדר 12 בזמן שהאורח הקודם עדיין ישן בו. **overbooking פיזי.**

`rr_no_double_booking` **אינו** עוצר את זה: השורה הישנה כבר `is_blocking=false`, ולכן החדשה לא מתנגשת.

**מדוע `check:beds24-cancellation-sync` עובר:** התסריט (`scripts/check-beds24-cancellation-sync.mjs:193-207`)
מריץ את תרחיש ה-`checked_in` **רק** דרך `runBeds24BookingReconciliation` (עם
`hiddenFromWindows = true`), לעולם לא דרך `runBeds24InboundPull` → `applyCancellation`.
מסלול ה-poll הרגיל — הנתיב הנפוץ בהרבה — אינו מכוסה.

**PROPOSED FIX** — ליישר את `applyCancellation` עם שאר המערכת:
```ts
if (PRESERVED_STATUSES.has(existing.status)) {
  await logChannelError(tx, { tenantId: conn.tenant_id, connectionId: conn.id,
    code: "cancelled_at_source_checked_in",
    message: `הזמנה ${existing.reservation_number} בוטלה בערוץ אבל האורח ${existing.status} — נדרשת החלטת מפעיל`,
    context: { reservation_id: existing.id, booking_id: norm.bookingId } });
  await tx`UPDATE guesthub.reservations
             SET external_revision_id = ${norm.revisionId},
                 external_cancellation_requested_at = COALESCE(external_cancellation_requested_at, now())
           WHERE id = ${existing.id} AND tenant_id = ${conn.tenant_id}`;
  return existing.id;   // לסמן את הרוויזיה כמיובאת, בלי לשחרר מלאי
}
```
ולהוסיף ל-`scripts/check-beds24-cancellation-sync.mjs` תרחיש `checked_in` שעובר דרך
`runBeds24InboundPull` (בלי `hiddenFromWindows`).

---

### F4 · שבירת שכבות: `reservations/actions.ts` מייבא את שכבת ה-HTTP של הספק ומבצע קריאת רשת בתוך בקשת web  🔴

**קובץ:** `src/app/(dashboard)/reservations/actions.ts:36-40, 779-859`
**הבדיקה שנופלת:** `scripts/check-calendar.mjs:143-150`

**EVIDENCE** — `actions.ts:36-40`:
```ts
import { getBeds24AccessToken } from "@/lib/channel/beds24-token";
import { beds24Request } from "@/lib/channel/beds24-http";
import { beds24BaseUrl } from "@/lib/channel/config";
import { beds24BookingIdentity } from "@/lib/channel/beds24-normalize";
import { asObj } from "@/lib/channel/channel-http";
```
`actions.ts:814-823` (בתוך Server Action):
```ts
    const access = await getBeds24AccessToken(sql, conn);
    if (!access.ok) return fail(access.error);
    const r = await beds24Request({
      token: access.token, baseUrl: beds24BaseUrl(), method: "GET",
      path: `/bookings?id=${encodeURIComponent(res.external_booking_id)}`,
    });
```
`scripts/check-calendar.mjs:127-150` — האינווריאנט המפורש:
```js
// no module a canonical save imports may reach the network, and the outbox
// itself performs no HTTP call. Only the PM2 worker talks to the channel provider.
  const HTTP_MODULES = /channel-http|beds24-http|beds24-ari-sync|beds24-properties|channel\/worker/;
  ...
      assert.ok(!HTTP_MODULES.test(spec), `${f} must not import the channel HTTP layer (${spec})`);
```
פלט אמיתי:
```
AssertionError [ERR_ASSERTION]: src/app/(dashboard)/reservations/actions.ts must not import
the channel HTTP layer (@/lib/channel/beds24-http)
    at file:///home/ubuntu/worktrees/wt-night/scripts/check-calendar.mjs:148:14
```

**מתי נכנס:** `git log -S 'from "@/lib/channel/beds24-http"'` על הקובץ מחזיר קומיט **אחד**:
`3e9a451 fix(channel): OTA cancellations reach the import — explicit status filter, reconciliation, supervised release (D93)`
(שורות 36 **ו-**37 שתיהן מ-3e9a451). כלומר ההפרה נולדה ב-D93 והוכנסה ל-main ב-PR #102.

**האם זו שבירת שכבות אמיתית? כן — בשני מובנים, ולא בשלישי:**

1. **חבילת הלקוח — לא.** ניתוח גרף ייבוא מלא (274 קבצים) מראה ש-`actions.ts` הוא `"use server"`,
   ולכן כל 26 מודולי ה-UI שמגיעים אליו טרנזיטיבית עוברים גבול Server Action.
   בדיקה ייעודית: *"(none: every client→db path crosses a 'use server' boundary)"*.
   `check:db-isolation` ו-`check:channel-security` עוברים.
2. **מסלול השמירה הקנוני — כן.** `actions.ts` מכיל את `createReservationAction`,
   `updateReservationAction`, `rescheduleReservationRoomAction` — בדיוק המסלולים שהאינווריאנט
   נועד להגן עליהם. מודול השמירה מושך עכשיו `fetch` טרנזיטיבית דרך **שני** נתיבים:
   `actions.ts → beds24-http` (ישיר) ו-`actions.ts → beds24-token → beds24-http`.
   הערה: הרגקס `HTTP_MODULES` **לא** כולל `beds24-token`, כך שהנתיב השני יישאר חבוי גם אחרי
   תיקון נאיבי שרק מסיר את שורה 37.
3. **התנהגות זמן־ריצה — כן, וזה החמור.** `releaseChannelReservationAction` מבצע קריאת HTTP
   סינכרונית ל-Beds24 בתוך בקשת משתמש:
   * timeout `DEFAULT_TIMEOUT_MS = 12_000` (`src/lib/channel/channel-http.ts:49`) — 12 שניות של Server Action תלוי.
   * ללא circuit-breaker (`src/lib/channel/circuit-breaker.ts` משמש רק את ה-worker), ללא lease, ללא pacing.
   * צורך קרדיטים של Beds24 (`x-fivemincreditlimit-remaining`) מנתיב שהמשתמש יכול להקליק שוב ושוב —
     שום דבר לא מונע 20 קליקים = 20+ קריאות (כל `getBeds24AccessToken` עלול גם למַנְפִּיק טוקן, שעולה קרדיטים נוספים).
     מיצוי הקרדיטים משתק את ה-worker (ARI + import) לכל הדיירים על אותו חיבור.

**PROPOSED FIX** — להחזיר את הקריאה החוצה מהבקשה, לפי המודל שהמערכת כבר מיישמת:
הפעולה כבר מסתיימת ב-`enqueueChannelJob(..., "pull_booking_revisions")`. במקום לאמת מול Beds24
בתוך הבקשה, להוסיף `ChannelJobType` חדש (`verify_cancellation_at_source`) שה-worker מריץ —
עם ה-circuit-breaker וה-pacing הקיימים — ולסמן את התוצאה על ההזמנה
(`external_cancellation_requested_at` + שורת `channel_sync_errors`) שה-UI מציג.
כך `actions.ts` חוזר להיות נטול־רשת, `check:calendar` חוזר לירוק, וה-TOCTOU של F12 נעלם.
בנוסף — להוסיף `beds24-token` ל-`HTTP_MODULES` ב-`scripts/check-calendar.mjs:142`.

---

## בינוני

### F5 · Reconciliation: חלון עיוור קבוע של 50 + הודעת הגבול נזרקת לפח (הפוך מהמתועד)

**קובץ:** `src/lib/channel/beds24-booking-import.ts:534-565`, `src/lib/channel/worker.ts:161-169`

**EVIDENCE** — `beds24-booking-import.ts:534-565`:
```ts
// bounded per cycle (one GET per reservation); the bound is REPORTED, never silent
const RECONCILE_LIMIT = 50;
...
    WHERE tenant_id = ${conn.tenant_id} AND channel_connection_id = ${conn.id}
      AND external_booking_id IS NOT NULL
      AND status IN ('confirmed', 'checked_in')
      AND check_out >= CURRENT_DATE
    ORDER BY check_in
    LIMIT ${RECONCILE_LIMIT}`;
  if (rows.length === 0) return summary;
  if (rows.length === RECONCILE_LIMIT) {
    pushError(summary, `reconciliation checked only the first ${RECONCILE_LIMIT} reservations`);
  }
```
`worker.ts:161-169`:
```ts
    if (jobType === "reconcile_inventory") {
      ...
      const summary = await runBeds24BookingReconciliation(sql, inbound);
      if (summary.errors.length > 0 && summary.checked === 0) {
        throw Object.assign(new Error(summary.errors[0]), { code: "network_error" });
      }
      return { sentValues: summary.released };
    }
```

**FAILURE SCENARIO:** לנכס עם 70 הזמנות OTA פעילות (`confirmed`/`checked_in`, `check_out >= היום`)
— תרחיש רגיל למלון דירות בעונה — ה-reconciliation בודק **תמיד את אותן 50 המוקדמות לפי `check_in`**.
20 ההזמנות עם ה-`check_in` הרחוק ביותר לא ייבדקו לעולם, עד שקודמותיהן יעזבו.
אין cursor, אין `last_reconciled_at`, אין OFFSET מתגלגל.
זהו בדיוק סוג הפער ש-D93 בא לסגור (ה-reconciliation הוא ה-safety-net מעל תיקון ה-status filter).

**ובנוסף:** ההודעה `"reconciliation checked only the first 50 reservations"` נדחפת ל-`summary.errors`,
אבל `checked > 0` תמיד במקרה הזה — לכן ה-`throw` לא מופעל, `summary` נזרק, `completeChannelJob`
מסמן הצלחה ולא כותב דבר, ואין `logChannelError`. התיעוד קובע *"the bound is REPORTED, never silent"* —
**בפועל הוא silent.**

**PROPOSED FIX:**
1. cursor מתגלגל: `last_reconciled_at timestamptz` על `reservations`, `ORDER BY last_reconciled_at NULLS FIRST, check_in`, ועדכון אחרי כל בדיקה. כך התור מסתובב וכל הזמנה נבדקת בתוך `ceil(N/50)·20` דקות.
2. לכתוב את הגבול לתוך `channel_sync_errors` (`logChannelError(code:"reconcile_bound_reached")`) במקום לסמוך על `summary.errors` שנזרק.

---

### F6 · כישלון עמוד ב-pull נכנס מדווח כהצלחה של ה-job, בלי שום רשומת שגיאה

**קובץ:** `src/lib/channel/beds24-booking-import.ts:405-416`, `src/lib/channel/worker.ts:141-145`

**EVIDENCE:**
```ts
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetchBookingsPage(creds, filters, page);
    if (!res.ok) {
      pushError(summary, res.message);
      break;
    }
```
```ts
      const summary = await runBeds24InboundPull(sql, inbound, bookingId ? { bookingId } : undefined);
      if (summary.errors.length > 0 && summary.fetched === 0 && summary.imported === 0 && summary.inserted === 0) {
        throw Object.assign(new Error(summary.errors[0]), { code: "network_error" });
      }
      return { sentValues: summary.imported };
```

**FAILURE SCENARIO:** משיכה של חלון גדול (יום ראשון אחרי סוף שבוע עמוס, או ריצה ראשונה עם
`BACKFILL_PAST_DAYS=30` + `FORWARD_DAYS=ARI_HORIZON_DAYS`). עמוד 1 מחזיר 20 הזמנות בהצלחה,
עמוד 2 מקבל HTTP 429 (מיצוי קרדיטים) → `pushError` + `break`.
כיוון ש-`summary.fetched = 20 > 0`, ה-`throw` לא קורה: ה-job מסומן `succeeded`,
`last_inbound_import_at` מתעדכן, ואין שום שורה ב-`channel_sync_errors` — בניגוד ל-`unmapped_room`,
`inbound_quarantine` ו-`inbound_import_failed` שכן נכתבות.
הזמנות מעמודים 2+ (כולל ביטולים!) פשוט לא נכנסות. ההתכנסות מסתמכת על ה-poll הבא
(`modifiedFrom = -7 ימים`) — כלומר עד 7 ימים של חלון־החלמה, ואם ה-429 מתמיד (מכסת קרדיטים
שנצרכת ע"י F4/F10) הפער נשאר פתוח ללא כל התראה.

**PROPOSED FIX:** להוסיף `await logChannelError(db, { code: "inbound_page_failed", ... })`
ליד ה-`break` בשורה 408-409, ולהחזיר בסיכום `pagesFailed: number`. ב-`worker.ts` —
לזרוק (retry עם backoff) כש-`pagesFailed > 0`, כדי שהעמודים החסרים יימשכו מיד ולא בעוד 5 דקות.

---

### F7 · N+1 חמור ב-`markAriDirty` — עד ~12,000 שאילתות בטרנזקציית שמירה אחת

**קובץ:** `src/lib/channel/outbox.ts:58-103`

**EVIDENCE:**
```ts
  for (const conn of connections) {
    for (const roomId of roomIds) {
      for (const kind of kinds) {
        const scopes: (string | null)[] = kind === "availability" ? [null] : planScopes;
        for (const planId of scopes) {
          const existing = await tx<...>`SELECT id, date_from, date_to
            FROM guesthub.channel_dirty_ranges WHERE ... FOR UPDATE`;
          ...
          if (absorbedIds.length > 0) { await tx`DELETE FROM guesthub.channel_dirty_ranges ...`; }
          await tx`INSERT INTO guesthub.channel_dirty_ranges ...`;
```
**3 שאילתות** בכל איטרציה של הלולאה הפנימית ⇒ `3 · C · R · K · P` round-trips.

**הקורא הכי כבד** — `src/app/(dashboard)/rate-plans/actions.ts:66-87` (`markPlansDirty`):
```ts
  const family = await expandPlanFamily(tx, tenantId, planIds);           // כל צאצאי התוכנית
  const roomIds = [...new Set([...(await roomsForPlans(tx, tenantId, family)), ...extraRoomIds])];
  ...
  await markAriDirty(tx, { tenantId, roomIds, ratePlanIds: family,
    dateFrom: today, dateTo: addDays(today, ARI_HORIZON_DAYS), kinds: ["rates", "restrictions"] });
```

**ספירת פריטים ריאליסטית:** מלון דירות בינוני = 60 חדרים; משפחת Rate-Plan של 6 תוכניות;
`kinds = ["rates","restrictions"]` (K=2); חיבור Beds24 יחיד (C=1).
`3 · 1 · 60 · 2 · 6 = 2,160` round-trips **בתוך טרנזקציית השמירה**, בזמן שהיא מחזיקה
`FOR UPDATE` על שורות `channel_dirty_ranges` והמפעיל מסתכל על ספינר.
נכס גדול (200 חדרים, 10 תוכניות): `3 · 200 · 2 · 10 = 12,000`.
קורא נוסף באותה קטגוריה: `src/lib/rates/service.ts:196-203` (Bulk Update — `roomIds` = כל חדרי
היחידות שנגעו, `kinds:["rates","restrictions"]`, `planScopes=[null]` ⇒ `3·R·2`).

**PROPOSED FIX:** להחליף את הלולאה המקוננת ב-CTE יחיד: `unnest(roomIds) × unnest(kinds) × unnest(plans)`
→ `SELECT … FOR UPDATE` על כל המפתחות בבת אחת, `DELETE … WHERE id = ANY(absorbed)` אחד,
ו-`INSERT … SELECT` אחד עם `ON CONFLICT` על מפתח ה-`(connection_id, room_id, kind, local_rate_plan_id)`.
זה מוריד את התמונה ל-3 שאילתות סה"כ ומעלים גם את חלון הנעילות הארוך.

---

### F8 · תקלת tick של מודול התקשורת נבלעת: רק `e.name` נרשם, וה-summary נזרק

**קובץ:** `src/lib/channel/worker.ts:263-267` (+ `src/lib/communications/worker.ts:48-54`)

**EVIDENCE** — `worker.ts:263-267`:
```ts
  try {
    await runCommunicationTick(workerId, log);
  } catch (e) {
    log(`communications tick failed: ${e instanceof Error ? e.name : "error"}`);
  }
```
`e.name` הוא כמעט תמיד המחרוזת `"Error"`. **תוכן** התקלה (`e.message`, ה-stack, קוד ה-PG)
נזרק לגמרי. בנוסף `runCommunicationTick` מחזיר `CommunicationTickSummary` ובו
`eventsFailed`, `failed`, `ambiguous` — והערך המוחזר מושלך (אישור מהסורק הסטטי:
`src/lib/channel/worker.ts:264 runCommunicationTick(…) -> object with {failed}`).
מטה, `heartbeat(opts.workerId, summary.sentValues > 0, lastError)` מקבל `lastError = null`
כי החריגה נתפסה בפנים — אז מסך /channels מציג "תקין".
אותה תבנית ב-`src/lib/communications/worker.ts:53`:
`log(\`… preparation failed (${error instanceof Error ? error.name : "error"})\`)`.

**FAILURE SCENARIO:** עמודה חסרה/הרשאה חסרה/`connection terminated` ב-`claimCommunicationEvents`
גורמת ל-`runCommunicationTick` לזרוק בכל tick (כל 20 שניות). אף אורח לא מקבל אישור הזמנה,
`communication_events` נערמים, `/channels` ירוק, וב-pm2 log יש `communications tick failed: Error`
חוזר — ללא שום דרך לדעת מה נשבר.

**PROPOSED FIX:** לרשום `e.message` (הוא כבר לא מכיל תוכן אורח — `failCommunicationEvent`
מקבל קוד קבוע `"event_preparation_failed"`), להחזיק את הכישלון ב-`lastError` שנשלח ל-`heartbeat`,
ולכתוב שורת `channel_worker_state.last_error` / `channel_sync_errors` אחת עם קוד
`communications_tick_failed`. בנוסף — לצרוך את ה-summary: `if (s.eventsFailed > 0) …`.

---

### F9 · N+1 בלולאת האוטומציות: `resolveConnectedEmailChannel` ו-`resolveVersion` נקראים פר-אוטומציה

**קובץ:** `src/lib/communications/automation.ts:446-556`, `:257-306`

**EVIDENCE** — הלולאה ב-`automation.ts:468`:
```ts
  for (const automation of automations) {
    ...
      const version = await resolveVersion(automation, reservation.guest_language);   // 475/478/481/483
      ...
      const emailChannel = await resolveConnectedEmailChannel(event.tenant_id);        // 496
```
`resolveConnectedEmailChannel` (`:296-306`) הוא SELECT יחיד שתלוי **רק ב-`tenantId`** —
אותו ערך בכל איטרציה. `resolveVersion` (`:257-…`) הוא 1-2 SELECT-ים ומופיע 6 פעמים
בענפי ה-skip השונים (שורות 447, 463, 475, 478, 481, 483) בלי memoization.
בנוסף בענפי skip נפוצים הוא נקרא כארגומנט **וגם** מוקצה מחדש.

**ספירת פריטים ריאליסטית:** `runCommunicationTick` תופס 10 אירועים לכל tick
(`src/lib/communications/worker.ts:38`), tick כל 20 שניות
(`src/lib/channel/worker.ts:40 DEFAULT_INTERVAL_MS = 20_000`).
דייר עם 5 אוטומציות פעילות ⇒ `10 × 5 = 50` איטרציות × (‎1 עד 3 שאילתות) ≈ 100-150 round-trips
בכל tick, כלומר ~450 שאילתות מיותרות לדקה, לנצח.

**PROPOSED FIX:** להרים את `resolveConnectedEmailChannel(event.tenant_id)` מחוץ ללולאה
(ערך אחד לכל האירוע), ולעטוף את `resolveVersion` ב-`Map` מקומי בקנה־מידה של האירוע
עם המפתח `${automation.id}|${normalizeLanguage(guestLanguage)}`.

---

### F10 · N+1 עם HTTP: reconciliation שולח GET נפרד לכל הזמנה (עד 50 קריאות כל 20 דקות)

**קובץ:** `src/lib/channel/beds24-booking-import.ts:575-577`

**EVIDENCE:**
```ts
  for (const r of rows) {
    const res = await fetchBookingsPage(creds, `id=${encodeURIComponent(r.external_booking_id)}`, 1);
```
`fetchBookingsPage` בונה `/bookings?id=<one>&includeGuests=true&includeInvoiceItems=true&page=1`
— בקשת רשת מלאה, ללא pacing (בניגוד ל-`sendCalendarRequests` ב-`beds24-ari-sync.ts:203-205`
שכן מחכה `PACE_MS` בין קריאות).

**ספירת פריטים:** `RECONCILE_LIMIT = 50`, `RECONCILE_MINUTES = 20`
(`src/lib/channel/worker.ts:236`) ⇒ עד **150 קריאות Beds24 לשעה** רק ל-reconciliation,
פר חיבור, בנוסף ל-12 pull-ים בשעה (`INBOUND_POLL_MINUTES = 5`) ולתעבורת ה-ARI.
Beds24 מודד בקרדיטים ב-חלון 5 דקות (`x-fivemincreditlimit-remaining`) — 50 קריאות ברצף
ללא pacing הן דחיפה ישירה לכיוון 429, שגורר את F6.

**PROPOSED FIX:** Beds24 `/bookings` מקבל פרמטרי `id` **חוזרים** (בדיוק כמו
`BEDS24_STATUS_FILTER` שמנצל את זה עבור `status`): לאגד את 50 המזהים לבקשה אחת
(`id=1&id=2&…`, בחלוקה לקבוצות של ~25 כדי לא לחרוג מאורך URL), לקרוא `nextPageExists`,
ולהוסיף `sleep(PACE_MS)` בין הקבוצות — 2 קריאות במקום 50.

---

### F11 · התראות שינוי חיצוני: at-least-once (מייל כפול) + `resolveEmailProvider` בתוך הלולאה

**קובץ:** `src/lib/channel/external-changes.ts:120-195`

**EVIDENCE:**
```ts
  const rows = await db<PendingEmailRow[]>`
    SELECT ... FROM guesthub.channel_external_changes
    WHERE tenant_id = ${tenantId} AND email_status = 'pending'
    ORDER BY created_at LIMIT 20`;
  ...
  for (const row of rows) {
    ...
    const provider = await resolveEmailProvider(tenantId);        // :147 — פר-שורה, אותו tenant
    ...
    const [msg] = await db<{ id: string }[]>`INSERT INTO guesthub.outbound_messages ... 'submitting' ...`;
    try {
      const result = await provider.sendEmail({ ... });           // :170 — המייל יוצא כאן
      ...
    }
    await db`UPDATE guesthub.channel_external_changes
             SET email_status = ${sent ? "sent" : "failed"}, ... WHERE id = ${row.id} AND email_status = 'pending'`;
```
ההערה בשורות 118-119 מודה בחצי מזה: *"single-worker claim (the singleton PM2 channel worker is
the only dispatcher); move to UPDATE-claim rows if a second dispatcher ever appears."*

**FAILURE SCENARIO (א' — כפילות):** אין claim: השורה נשארת `'pending'` מהרגע ש-`SELECT` קרא אותה
ועד ה-`UPDATE` בסוף — כלומר **לרוחב קריאת ה-SMTP/Gmail API**. אם ה-worker מקבל SIGKILL
(או PM2 restart, או deploy) אחרי `provider.sendEmail` שהצליח ולפני ה-`UPDATE`:
`channel_external_changes.email_status` נשאר `'pending'`, `outbound_messages` נשאר `'submitting'`,
והמחזור הבא של `runBeds24InboundPull` → `dispatchExternalChangeEmails` שולח את **אותה** ההתראה שוב.
זה אינו תלוי בכלל בקיומו של dispatcher שני.

**FAILURE SCENARIO (ב' — N+1):** 20 שורות × `resolveEmailProvider(tenantId)` = עד 20 קריאות
זהות (כל אחת קוראת את `messaging_provider_connections` ומפענחת `secret_ciphertext`) לכל pull.

**PROPOSED FIX:**
1. claim אטומי: `UPDATE … SET email_status='sending', claimed_at=now() WHERE id=ANY(…) AND email_status='pending' RETURNING …`, ואז לשלוח רק על מה שנתפס; recovery של `'sending'` ישן מ-lease נפרד — בדיוק התבנית שכבר קיימת ב-`claimChannelJobs`.
2. להרים את `resolveEmailProvider(tenantId)` מעל הלולאה.

---

### F12 · `releaseChannelReservationAction` — TOCTOU: הסטטוס נקרא ללא נעילה, לפני קריאת רשת של שניות

**קובץ:** `src/app/(dashboard)/reservations/actions.ts:784-852`

**EVIDENCE:**
```ts
    const [res] = await sql<...>`
      SELECT id, reservation_number, status, channel_connection_id, external_booking_id
      FROM guesthub.reservations
      WHERE id = ${id} AND tenant_id = ${actor.tenantId}`;          // ← אין FOR UPDATE, אין טרנזקציה
    ...
    if (res.status === "checked_in")
      return fail("האורח בצ'ק-אין — שחרור אוטומטי חסום…");
    ...
    const r = await beds24Request({ ... });                          // ← עד 12 שניות
    ...
    await enqueueChannelJob(sql, { ..., jobType: "pull_booking_revisions",
      payload: { booking_id: res.external_booking_id }, idempotencyKey: `manual_release_${res.external_booking_id}` });
```
ה-job נדחף **ללא תנאי** על בסיס `res.status` שנקרא לפני קריאת ה-HTTP.

**FAILURE SCENARIO (interleaving):**
1. t0 — מנהל לוחץ "שחרור מפוקח". `res.status = 'confirmed'` ⇒ עובר את השומר בשורה 797.
2. t0+0.3s..t0+12s — הקריאה ל-Beds24 בדרך.
3. t0+2s — פקיד הקבלה עושה צ'ק-אין לאותה הזמנה (`updateReservationAction`, `status='checked_in'`).
4. t0+3s — Beds24 מחזיר `cancelled` ⇒ הפעולה מדפיסה audit ודוחפת `pull_booking_revisions`.
5. ה-worker מריץ pull ממוקד → `applyCancellation` → **בגלל F3 אין שומר `checked_in`** →
   ההזמנה מבוטלת והחדר משוחרר בזמן שהאורח בפנים.

F12 ו-F3 מרכיבים יחד מסלול overbooking שלם שאף אחד מהשומרים הקיימים לא חוסם.

**PROPOSED FIX:** לעטוף את הקריאה החוזרת + ה-enqueue בטרנזקציה עם `SELECT … FOR UPDATE`
ולוודא מחדש `status !== 'checked_in'` **אחרי** תשובת ה-HTTP; ולהעביר את המזהה של הסטטוס
שנצפה ל-payload של ה-job (`expected_status`) כך שה-worker יכול לוותר אם המצב השתנה.
(התיקון של F4 — העברת האימות ל-worker — מייתר את זה לגמרי.)

---

### F13 · `.then()` ללא מטפל דחייה בשבעה מסכים — הבטחה צפה + UI תקוע

**קבצים (כל אחד `.then(...)` בלי `.catch` ובלי `onRejected`):**

| קובץ:שורה | קריאה |
|-----------|-------|
| `src/components/reservations/StayEditor.tsx:90` | `getAvailableRoomsAction({...}).then(...)` |
| `src/components/reservations/StayEditor.tsx:109` | `getStayQuoteAction({...}).then(...)` |
| `src/components/reservations/BookingPanel.tsx:209` | `getStayQuoteAction({...}).then(...)` |
| `src/components/reservations/EditReservationPanel.tsx:129` | `getReservationAction(id).then(...)` |
| `src/components/reservations/EditReservationPanel.tsx:364` | `getReservationAction(reservationId).then(...)` |
| `src/components/reservations/BookingActions.tsx:124` | `getMessagingContextAction(reservationId).then(...)` |
| `src/app/(dashboard)/guests/GuestsScreen.tsx:100` | `getGuestProfileAction(profileId).then(...)` |

**EVIDENCE** — `StayEditor.tsx:90-96`:
```tsx
    getAvailableRoomsAction({
      checkIn: value.checkIn, checkOut: value.checkOut, excludeReservationId,
    }).then((res) => {
      if (alive && res.success && res.data) setRooms(res.data);
    });
```
Server Action ב-Next 15 **דוחה** (ולא מחזיר `{success:false}`) כשה-fetch עצמו נכשל:
ניתוק רשת, 502 מה-proxy, deploy באמצע, redeploy של Server-Action id.

**FAILURE SCENARIO:** מפעיל פותח את חלונית ההזמנה בזמן `deploy:prod`. `getReservationAction`
נדחה. אין `.catch` ⇒ (א) `unhandledrejection` בקונסולה, (ב) `setLoadError` לעולם לא נקרא ולכן
המשתמש רואה שלד/ספינר לנצח בלי הסבר, (ג) ב-`EditReservationPanel.tsx:129` גם `dirtyRef`
ומצב הטופס נשארים במצב ביניים. `BookingPanel.tsx:209` גרוע במיוחד: הוא בתוך `for` על כל
ה-stays, כך שדחייה אחת משאירה את `quotes[s.key]` ריק ואת `roomsTotal` מחושב כ-0 —
כלומר **מחיר שגוי מוצג למשתמש** (`total = Math.max(0, roomsTotal - discount)`, שורה 230).

**PROPOSED FIX:** להוסיף `onRejected` שני לכל `.then` (התבנית כבר קיימת בריפו —
`src/app/(dashboard)/settings/LocationPicker.tsx:137` עושה `.then(ok, () => {})`),
או להעביר ל-`async` IIFE עם `try/catch` שקורא ל-`setLoadError`/`toast.error`.
מומלץ גם להפעיל `@typescript-eslint/no-floating-promises` ב-`eslint.config.mjs`
(היום הוא כבוי — `next/typescript` לא מפעיל כללי type-aware).

---

## קל

### K1 · שתי מעגליות ייבוא אמיתיות (value imports) בין קומפוננטות

**מעגל 1:** `src/app/(dashboard)/calendar/CalendarGrid.tsx:74` → `./ReservationTooltip`
⇄ `src/app/(dashboard)/calendar/ReservationTooltip.tsx:10` → `import { PAY_STYLE } from "./CalendarGrid";`
(`PAY_STYLE` מיוצא ב-`CalendarGrid.tsx:108`, נצרך ב-`ReservationTooltip.tsx:97`).

**מעגל 2:** `src/app/(dashboard)/rooms/RoomsScreen.tsx:18` → `./AreaPanel`
⇄ `src/app/(dashboard)/rooms/AreaPanel.tsx:11` → `import { AREA_TYPE_LABEL, AREA_STATUS_META } from "./RoomsScreen";`
(מיוצאים ב-`RoomsScreen.tsx:55,62`, נצרכים ב-`AreaPanel.tsx:67,179,306`).

**FAILURE SCENARIO:** היום שני המעגלים **בטוחים** כי הצריכה מתרחשת בזמן render, אחרי
שכל המודולים אותחלו. הם ייהרסו ברגע שמישהו יעביר את הצריכה ל-module scope — למשל
`const PAY_KEYS = Object.keys(PAY_STYLE)` ברמת המודול ב-`ReservationTooltip.tsx`.
אם ה-bundler ייכנס ל-`ReservationTooltip` ראשון (למשל אחרי code-split או שינוי סדר ייבוא),
`PAY_STYLE` יהיה ב-TDZ ⇒ `Cannot access 'PAY_STYLE' before initialization` בזמן טעינת דף
לוח־השנה. באג שמתגלה רק בפרודקשן, כי סדר ההערכה תלוי-bundler.
(9 מעגלים נוספים קיימים דרך ייבוא `type`-only בלבד — אלה נמחקים בקומפילציה ואינם ממצא.)

**PROPOSED FIX:** להוציא את הקבועים המשותפים למודול עלה:
`PAY_STYLE` → `src/app/(dashboard)/calendar/types.ts` (או `@/lib/status-colors`, שם כבר יושב
`STATUS_COLORS`); `AREA_TYPE_LABEL`/`AREA_STATUS_META` → `src/app/(dashboard)/rooms/types.ts`.

---

### K2 · תשעה מודולי שרת בלי `import "server-only"` — כולל `src/lib/db.ts` עצמו

**קבצים** (משתמשים ב-`sql`/`postgres`/`TransactionSql`, ללא `"server-only"` וללא `"use server"`):
`src/lib/db.ts:1`, `src/lib/audit.ts:1`, `src/lib/audit-write.ts:1`, `src/lib/settings.ts:1`,
`src/lib/check-in-check-out-mutation.ts:1`, `src/lib/auth/actor.ts:1`, `src/lib/business/store.ts:1`,
`src/lib/channel/external-changes.ts:1`, `src/lib/channel/beds24-token.ts:1`.

**EVIDENCE** — `src/lib/db.ts:1`:
```ts
import postgres from "postgres";
```
לעומת התקן בשאר `src/lib/channel/` (`booking-import.ts:1`, `outbox.ts:1`, `queue.ts:1`,
`worker.ts:1`, `payments/ledger.ts:1` — כולם `import "server-only";`).

**FAILURE SCENARIO:** נכון להיום **אין דליפה בפועל** — ניתוח הגרף המלא מחזיר
*"(none: every client→db path crosses a 'use server' boundary)"* ו-`check:db-isolation` עובר.
אבל השומר אינו קיים: מפתח שמוסיף ל-קומפוננטת `"use client"` שורת
`import { sql } from "@/lib/db"` (למשל כדי לשלוף טיפוס, ומשאיר בטעות ייבוא ערך)
לא יקבל שגיאת build; במקום זה `postgres` ייכנס ל-bundle של הדפדפן, ו-`DATABASE_URL`
עלול להישאב ל-JS צד־לקוח. `server-only` נועד להפוך את זה לשגיאת קומפילציה.

**PROPOSED FIX:** להוסיף `import "server-only";` כשורה ראשונה בכל תשעת הקבצים
(build ה-worker כבר יודע לטפל בזה — `scripts/server-only-stub.cjs` קיים ומופעל מ-`tsconfig.worker.json`),
ולהוסיף ל-`scripts/check-db-isolation.mjs` אמירה שכל קובץ ב-`src/lib` שמייבא `@/lib/db`
או `postgres` חייב `"server-only"` או `"use server"`.

---

### K3 · אין ריצת בדיקות אגרגטיבית — 90+ שומרים תלויים בזיכרון אנושי

**EVIDENCE:** `package.json` מכיל `prebuild`, `postbuild`, `lint`, `typecheck`, `build` בלבד —
אין `check`, `check:all`, `verify`, `test` או `ci`. אין ספריית `.github/`.
**FAILURE SCENARIO:** בדיוק מה שקרה: `check:calendar` (F4), `check:calendar-ui`,
`check:channels-badge` ו-`check:design` אדומים על `main` הנקי אחרי PR #101/#102, וה-merge עבר.
**PROPOSED FIX:** `"check:all": "node scripts/run-all-checks.mjs"` שמריץ כל `check:*` ומדפיס
מטריצת PASS/FAIL (עם רשימת exclusions מפורשת ל-בדיקות שדורשות DB/דפדפן), ולקרוא לו מ-
`pnpm typecheck && pnpm lint && pnpm build` כפי ש-`CLAUDE.md` כבר מחייב בסוף כל שלב.

---

### K4 · `lockRooms` במסלול ה-import נועל רק את החדרים החדשים, לא את הישנים

**קובץ:** `src/lib/channel/booking-import.ts:380-381` מול `src/app/(dashboard)/reservations/actions.ts:463-469`

**EVIDENCE** — import:
```ts
  const roomIds = [...new Set(stays.map((s) => s.roomId))];
  await lockRooms(tx, conn.tenant_id, roomIds);
```
עריכה מקומית (הדיסציפלינה הנכונה):
```ts
      const allRoomIds = [
        ...new Set([
          ...input.rooms.map((s) => s.roomId),
          ...oldRows.map((r) => r.room_id).filter((x): x is string => !!x),
        ]),
      ];
      await lockRooms(tx, actor.tenantId, allRoomIds);
```
**FAILURE SCENARIO:** רוויזיית OTA מעבירה הזמנה מחדר A לחדר B. ה-import נועל רק את B.
במקביל, `createReservationAction` מקומי מנסה להזמין את חדר A ללילות שה-OTA עומד לפנות:
הוא נועל את A (פנוי), מריץ `check_room_availability`, רואה את שורת ה-`reservation_rooms`
הישנה של ה-OTA (המחיקה טרם commit) ⇒ `"קיימת הזמנה חופפת בחדר בטווח המבוקש"` — **התנגשות
מדומה** שנעלמת בניסיון חוזר. **לא** double-booking: `rr_no_double_booking` הוא ה-backstop
(אומת: `check:reservation-concurrency` PASSED מול staging).
**PROPOSED FIX:** `await lockRooms(tx, conn.tenant_id, [...new Set([...oldRoomIds, ...roomIds])]);`
— זהה לדיסציפלינה של המסלול המקומי. `oldRoomIds` כבר זמין מ-`lockExternalReservation`.

---

### K5 · `sweepUnimportedRows` — הרעבה ע"י שורות quarantine שלא ניתן לתקן

**קובץ:** `src/lib/channel/beds24-booking-import.ts:99, 353-363`
**EVIDENCE:**
```ts
const SWEEP_LIMIT = 200;
...
    WHERE connection_id = ${conn.id}
      AND import_status IN ('pending', 'quarantined', 'failed')
    ORDER BY created_at
    LIMIT ${SWEEP_LIMIT}`;
```
**FAILURE SCENARIO:** מיפוי חדר Beds24 נמחק/`status<>'mapped'`. כל booking שמכיל אותו חדר
עובר quarantine (`beds24RoomResolver`, שורה 226). אחרי 200+ הזמנות כאלה, ה-`ORDER BY created_at`
מחזיר תמיד את אותן 200 השורות הישנות שלעולם לא ייפתרו, ושורה חדשה במצב `'pending'`
(קריסה בין `insertRevisionRow` ל-`importRevisionRowBeds24`) לא תיסחף לעולם.
עלות נוספת: 200 ניסיונות ייבוא כושלים לכל pull, כל 5 דקות.
**PROPOSED FIX:** להוסיף `sweep_attempts` + `next_sweep_at` עם backoff ל-`channel_booking_revisions`
ולסנן `next_sweep_at <= now()`, או לפחות `ORDER BY (import_status='pending') DESC, created_at`
כדי ש-`pending` (התאוששות מקריסה) תמיד יקדם `quarantined`.

---

### K6 · שש קריאות Supabase Auth admin עם `.catch(() => {})`

**קובץ:** `src/app/(dashboard)/staff/actions.ts:184, 190-192, 299-304, 324-329, 365-369, 540-544`
**EVIDENCE** — `:184`:
```ts
      await admin.auth.admin.deleteUser(authUserId).catch(() => {});
```
`:365-369`:
```ts
    // Ban/unban stays best-effort: getActor's is_active=true filter is the hard
    // backstop (D17), so a transient failure here cannot re-admit a disabled user.
    if (target.auth_user_id && data.is_active !== target.is_active)
      await admin.auth.admin
        .updateUserById(target.auth_user_id, { ban_duration: data.is_active ? "none" : BAN_DURATION })
        .catch(() => {});
```
**הערכה:** ה-ban/unban (‎:190, :365, :540) הוא **מקובל** — ההערה מציינת backstop אמיתי
(`getActor` מסנן `is_active=true`), וזה אומת: אף אחת מהקריאות אינה השער היחיד לאבטחה.
שתי ה-rollback-ים של אימייל (‎:299-304, :324-329) פחות בטוחים: אם ה-rollback נכשל בשקט,
`auth.users.email` ו-`guesthub.users.email` מתפצלים והמשתמש לא יוכל להתחבר, בלי שאיש יידע.
`:184` (ניקוי auth-user יתום) בטוח — משתמש auth ללא שורת `guesthub.users` ממילא נדחה ב-`getActor`.
**PROPOSED FIX:** להחליף `.catch(() => {})` בשני מקרי ה-rollback ב-
`.catch((e) => writeAudit(actor, { entityType:"user", entityId:data.id, action:"auth_rollback_failed", after:{ reason: String(e?.message ?? e) } }))`,
כדי שהפיצול יהיה גלוי במסך הפעילות.

---

### K7 · שגיאות `signOut` נזרקות בחמישה מקומות

**קבצים:** `src/app/auth/callback/route.ts:81`, `:96`, `src/app/auth/signout/route.ts:28`,
`src/app/login/actions.ts:43`, `src/lib/auth/actions.ts:8`.
**EVIDENCE:** `await supabase.auth.signOut();` — הטיפוס המוחזר הוא `{ error: AuthError | null }`
וה-`error` לא נבדק באף אחד מהחמישה.
**FAILURE SCENARIO:** `signOut` נכשל (Supabase self-hosted לא זמין רגעית) ⇒ הקוד ממשיך
ל-redirect כאילו התנתקנו. עוגיית ה-session עדיין תקפה בצד השרת. בשלושה מהמקרים
העוגיות נמחקות מקומית ולכן ההשפעה מוגבלת, אבל refresh-token שלא בוטל נשאר חי בצד Supabase.
**PROPOSED FIX:** `const { error } = await supabase.auth.signOut(); if (error) console.error("[auth] signOut", error.message);`
ולוודא שמחיקת העוגייה המקומית מתבצעת בכל מקרה (היא כבר כן — `route.ts` מבצע staging של מחיקות).

---

### K8 · `void Promise.all(...).then(...)` בתוך `try/catch` שלא תופס אותו — המפה נשארת ריקה בשקט

**קובץ:** `src/app/(dashboard)/settings/LocationPicker.tsx:165-179`
**EVIDENCE:**
```tsx
    try {
      const maps = window.google?.maps;
      if (!maps) return;
      void Promise.all([importMaps(maps), importMarker(maps)]).then(([mapsLib, markerLib]) => {
        if (!mapHostRef.current) return;
        if (!mapRef.current) mapRef.current = renderMap(mapsLib, mapHostRef.current, center);
        ...
      });
    } catch (e) {
      reportError(e, "MAP_RENDER_FAILED");
    }
```
**FAILURE SCENARIO:** `importLibrary("maps")` נכשל (חסימת רשת, מפתח Google Maps פג, CSP).
ה-`try/catch` תופס רק זריקות סינכרוניות; דחיית ה-Promise חומקת לגמרי ⇒ `reportError`
לעולם לא נקרא, `MAP_RENDER_FAILED` לא מדווח, והמפעיל רואה מלבן ריק בלי הודעה.
אותה תבנית בשורה 98: `void reverseGeocode(geo, at).then((p) => setResolvedAddress(...))` — בלי `catch`.
לשם השוואה, שורה 137 באותו קובץ **כן** עושה נכון: `importGeocoding(maps).then(ok, () => {})`.
**PROPOSED FIX:** להוסיף `, (e) => reportError(e, "MAP_RENDER_FAILED")` כארגומנט השני של `.then`
בשורה 169, ו-`, () => setResolvedAddress(null)` בשורה 98.

---

### K9 · TODO / FIXME / HACK / XXX — אין אף אחד אמיתי בקוד

סריקה מלאה של `src/`, `db/`, `scripts/` (רגישה ולא־רגישה לרישיות) החזירה **7 התאמות, כולן שווא**:

| קובץ:שורה | טקסט | שיפוט |
|-----------|------|-------|
| `src/app/(dashboard)/settings/types.ts:46` | `"••••••••XXXX" hint per field` | **לא סמן** — מסכת תצוגה של סוד. תקין. |
| `src/lib/messaging/store.ts:186` | `"••••••••XXXX" hint per known secret field` | **לא סמן** — זהה. תקין. |
| `db/migrations/031_cancellation_history_realtime.sql:94,95,96` | `) todo` / `la.entity_id = todo.id` / `WHERE r.id = todo.id` | **לא סמן** — שם alias של CTE (`todo`). תקין. |
| `scripts/check-rates-ui.mjs:10` | `parked on wip/rates-superseded-flex-attempt` | **לא סמן** — הערת תיעוד; הענף המוזכר עדיין קיים. עדיין רלוונטי. |

מספר `@ts-ignore`: **0**. מספר `@ts-expect-error`: **0**.
`eslint-disable`: 11 מופעים, כולם `react-hooks/exhaustive-deps` (6), `@next/next/no-img-element` (4)
ו-`@typescript-eslint/no-unused-vars` (2) — כולם מקומיים ומוצדקים במקום.
**זו הקטגוריה הנקייה ביותר בביקורת.**

---

## מה נבדק ונמצא נקי

| תחום | מה נבדק | תוצאה |
|------|---------|-------|
| **הגנת DB מפני double-booking** | `db/migrations/037_double_booking_guard.sql` במלואו + הרצת `check:reservation-concurrency` מול staging | ✅ נקי. `rr_no_double_booking` (GiST, `daterange '[)'`), `trg_rr_set_blocking` (BEFORE INSERT/UPDATE OF room_id, reservation_id, check_in, check_out), `trg_res_propagate_blocking` (AFTER UPDATE OF status) — שלושת התרחישים (חפיפה במקביל / אישור שני drafts / סמיכות) עוברים. `reservations_status_check` קיים. |
| **תור העבודות הרקעי** | `src/lib/channel/queue.ts` במלואו + `check:background-job-recovery` מול staging | ✅ נקי. `FOR UPDATE SKIP LOCKED`, lease של 10 דק', one-live-job-per-connection, dead-letter, rollback אטומי באמצע claim — 9/9 ✓. |
| **סדר נעילות / deadlock** | השוואת סדר הנעילה בכל מסלולי ההזמנה | ✅ נקי. הסדר עקבי בכל מקום: `reservations FOR UPDATE` → `rooms FOR UPDATE` (`lockRooms`) → `tenants FOR UPDATE` (`allocateReservationNumber`). `createReservationAction` מדלג על השלב הראשון (אין עוד שורה) אך שומר `rooms → tenants`. לא נמצא היפוך. |
| **מספור הזמנות** | `actions.ts:157-163` + `booking-import.ts:137-143` | ✅ נקי. `SELECT id FROM tenants … FOR UPDATE` מסדר את ההקצאות; אינדקס ייחודי הוא ה-backstop; שתי המימושים זהים תו-בתו. |
| **`saveCheckInCheckOutSettingsCore`** | `src/lib/check-in-check-out-mutation.ts:73-82` — הענף `"begin" in db` | ✅ נקי. אומת מול staging: בתוך טרנזקציה postgres.js חושף `savepoint` בלבד (`begin=undefined`), מחוצה לה `begin` בלבד. שני הענפים חיים ונכונים. |
| **מודל הקריאה של לוח־השנה** | `src/app/(dashboard)/calendar/data.ts` במלואו | ✅ נקי. 6 שאילתות קבועות + KPI אחד, `MAX_DAYS=62`, tenant-scoped, אפס N+1. גבול ה-DRAW (`check_out >= from`) עקבי בין stays/closures/holds. |
| **מודל הקריאה של רשימת ההזמנות** | `src/app/(dashboard)/reservations/data.ts` | ✅ נקי. שאילתת עמוד אחת + אגרגט tabs אחד, `LIST_LIMIT=300`, `tabPredicates` מוגדר פעם אחת ומשמש גם ל-WHERE וגם ל-`COUNT(*) FILTER`. |
| **`catch` בולעים** | סריקה ממצה: אפס בלוקי `catch {}` ריקים ב-`src/` | ✅ נקי. שלושת ה-`catch` עם הערה בלבד (`CalendarScreen.tsx:413`, `booking-import.ts:690`, `RoomWizard.tsx:906`) מתעדים למה, וכולם fallback לגיטימי. |
| **`catch` שמחזיר ערך "מוצלח"** | סריקה של כל `catch` + `return` בטווח 4 שורות | ✅ נקי. `rooms/actions.ts:708` (`orphanFile: true`) מכוון ומתועד; `auth/callback:37`, `business/profile:305`, `google-place:63`, `renderer:96`, `realtime/events:96` כולם fail-closed. |
| **טיפול בשגיאות HTTP של הספק** | כל 10 אתרי `beds24Request`/`beds24AuthRequest` | ✅ נקי. כולם עושים `if ("ok" in r)` לפני שימוש, ומפרידים `status !== 200` בנפרד. `beds24-http.ts` לא מדליף טוקן/גוף (הודעות קבועות לפי קטגוריה בלבד), ניסיון יחיד, `AbortController` תחום. |
| **דליפה לחבילת הלקוח** | גרף ייבוא מלא של 274 קבצים | ✅ נקי. אפס קשתות `"use client"` → `server-only`. כל נתיב client→`@/lib/db` חוצה גבול `"use server"`. |
| **בידוד דיירים** | `check:pms-domain-invariants` + סקירת שאילתות | ✅ נקי. `tenant_id` מופיע בכל `WHERE` שנבדק ב-`actions.ts`, `card-actions.ts`, `booking-import.ts`, `data.ts`. |
| **דדופליקציה בייבוא** | `upsertChannelGuest` (`booking-import.ts:188-206`) | ✅ נקי. רק התאמת email **יחידה** ממוזגת; 0 או >1 נופלים לרשומה חדשה — fail-visible, לא מיזוג שגוי. |
| **`refundPaymentAction`/`voidPaymentAction` סדרתית** | `check:payment-refund-void` מול staging | ✅ 5/5 ✓ סדרתית. הכשל הוא **רק** תחת מקביליות (F1/F2). |
| **מעגליות בין מודולי `src/lib`** | ניתוח SCC מלא | ✅ נקי. אפס מעגלים בתוך `src/lib`; שני המעגלים היחידים הם בין קומפוננטות UI (K1). |

---

## מה לא הצלחתי לאמת

1. **מתי F1/F2 יתפוצצו בפרודקשן.** ההוכחה בוצעה על staging (tenant חד־פעמי שנוצר ונמחק).
   הרצתי `check:payment-ledger-integrity` **גם** מול פרודקשן (SELECT-only) והוא עובר:
   הנתונים החיים עדיין נקיים, ו-`captured contra/refund entries (negative 'paid'): 0`
   מסביר למה — **מעולם לא נרשם החזר בפרודקשן**, ולכן F1 לא נבחן בשטח.
   F2 (חיוב כרטיס במקביל לרישום תשלום חיצוני) כן ניתן להפעלה עם הפיצ'רים הקיימים; העובדה
   שהוא טרם קרה היא מזל תזמון, לא הגנה. לא קראתי היסטוריית `audit_logs` בפרודקשן כדי
   לחפש עקבות של תיקון ידני קודם (אפשרי כ-READ-ONLY, מחוץ להיקף שהוגדר).
2. **F3 מקצה-לקצה.** ניתחתי סטטית את `applyCancellation` והצלבתי מול שלושת המסלולים
   שכן שומרים על `checked_in`. לא הרצתי pull חי עם רוויזיה מבוטלת מול הזמנה `checked_in`
   (זה דורש harness עם fetch מוזרק, בדומה ל-`scripts/check-beds24-cancellation-sync.mjs`).
   הממצא הוא **provably-inconsistent** (אסימטריה מוכחת בקוד), לא **provably-exploited**.
3. **סדר הנעילה בתוך `lockRooms`.** `WHERE id = ANY($1) FOR UPDATE` — סדר נעילת השורות
   בפועל נקבע ע"י ה-planner (index scan על ה-PK ⇒ סדר uuid; seq scan ⇒ סדר פיזי).
   בשני המקרים הוא דטרמיניסטי ולכן לא יוצר deadlock, אבל לא הרצתי `EXPLAIN` על עומסי אמת
   כדי לשלול תוכנית בלתי צפויה (למשל `BitmapOr`).
4. **ספירות פריטים אמיתיות (F7/F9/F10).** השתמשתי בהערכות מפורשות (60/200 חדרים,
   6/10 תוכניות, 5 אוטומציות) ולא בשאילתת `COUNT(*)` על פרודקשן.
5. **`check:calendar-ui` ו-`check:channels-badge`.** דיווחתי את הפלט האמיתי אבל לא חקרתי
   את שורש הכשל (מחוץ להיקף — הוקצה לסוכן אחר).
6. **`check:effective-state`, `check:reservations-ui`, `check:hydration-browser`** לא הורצו:
   הראשון דורש `.env.local` (פרודקשן), השניים האחרים דורשים שרת Next חי.


---

## 9ג — קוד מת וזומבים

> **Read-only audit.** אף שורת קוד לא שונתה, לא נמחקה ולא הועברה. כל ממצא כאן הוא **הצעה** בלבד.
> בסיס: `/home/ubuntu/worktrees/wt-night` @ `5b171bd` (origin/main). תאריך: 2026-07-25.
> תקן ההוכחה ל"מת": חיפוש הפניות בכל `src/`, `scripts/`, `db/`, `package.json`, `ecosystem.config.cjs`,
> `next.config.ts`, `eslint.config.mjs`, `postcss.config.mjs` + הפניות דינמיות (`import()`, `next/dynamic`,
> מחרוזות, קונבנציות ניתוב של Next, SQL).

---

## תקציר מספרי

| קטגוריה | כמות | הערה |
|---------|------|------|
| Exports עם **אפס** הפניות בכל הריפו (כולל בקובץ עצמו) | **26 ערכים + 33 טיפוסים** | מועמדים חזקים למחיקה |
| Exports המשמשים **רק בתוך הקובץ שלהם** (over-export) | 58 ערכים + 141 טיפוסים | לא קוד מת — `export` מת |
| Exports שמופנים **רק מ-`scripts/`** | 42 | מתוכם **2 הם פרודקשן** (PM2 worker), 25 test-only מורצים, 15 grep-only |
| API routes ללא קורא בריפו | 2 | שניהם **externally reachable** (public API) — לא מתים |
| קומפוננטות React שלא מרונדרות | **1** | `ConfirmDialog.tsx` |
| מודולים שלמים ללא נקודת כניסה | **1** | `src/lib/reports/queries.ts` |
| שרשראות פיצ'ר שלמות ללא נקודת כניסה | **1** | refund/void |
| `channex` / `hospitable` / `stripe` ב-`src/` | **0** | D91 נסגר נקי בקוד |
| תלויות npm לא בשימוש | **0** | כל 31 התלויות בשימוש אמיתי |
| דגלי פיצ'ר מתים (env) | 0 | seam יחיד עם ענף אחד: `getPaymentGateway()` (מכוון) |
| סקריפטי `check-*` יתומים (לא ב-`package.json`) | **5** | |
| קבצי `src/` שהתיעוד מפנה אליהם ואינם קיימים | **11** | שאריות D91 |

**הכרעה על `card-ingest.ts`:** **DELETE** (המלצה, לא בוצעה) — זהו כפיל זומבי של `attachStagedCard` ב-`revisions.ts`; היכולת נשמרת שם, והספק היחיד (Beds24) אינו יכול מבנית לספק נתוני כרטיס. פירוט מלא ב-§2.

**אימות שתי הטענות מהערב:** שתיהן **אוששו** — פירוט ב-§1 ו-§4.

---

## חמור

### 1. `check:channel-chaos` מאשר את שער ה-ACK על סמך **הערה**, לא קריאה — שער בטיחות ירוק-שקרי

**חומרה:** חמור · **קובץ:** `scripts/check-channel-chaos.mjs:34`

הבדיקה קוראת את `src/lib/channel/booking-import.ts` לתוך `importSrc` (שורה 17) ואז:

```js
// scripts/check-channel-chaos.mjs:34
if (!/markRevisionAcknowledged/.test(importSrc)) flag("no post-commit ack gate");
else pass("acknowledgement only after the import transaction commits");
```

**EVIDENCE — כל ההופעות של `markRevisionAcknowledged` בריפו (grep ללא `node_modules`/`.git`/`dist`):**

```
src/lib/channel/revisions.ts:247        export async function markRevisionAcknowledged(   ← ההגדרה
src/lib/channel/booking-import.ts:42    //    clause of markRevisionAcknowledged is the...  ← הערה בלבד
scripts/check-channel-chaos.mjs:34      if (!/markRevisionAcknowledged/.test(importSrc))   ← ה-grep
DECISIONS.md:729 · docs/audit/RESERVATIONS_INVENTORY_AUDIT.md:38,62,118 · docs/audit/WORKFLOW_INVENTORY.md:27
```

ההופעה היחידה ב-`booking-import.ts` היא שורה 42, בתוך בלוק ההערה `INVARIANTS` (שורות 36–43).
`grep -n -i "acknowled" src/lib/channel/booking-import.ts` מחזיר **אך ורק** שורות 41, 42, 43 — כולן הערות.
אין שום קריאה ל-`markRevisionAcknowledged` בשום מקום בקוד ריצה. **אפס קוראי runtime.**

**מסקנה:** הבדיקה עוברת כל עוד ההערה קיימת. מחיקת ההערה תפיל את הבדיקה; מחיקת הפונקציה עצמה **לא** תפיל אותה.
היא לא מוכיחה דבר על ההתנהגות. הטענה מהערב **אוששה במלואה**.

**סיבת השורש:** ל-Beds24 אין endpoint ל-ACK. `insertRevisionRow`
(`src/lib/channel/beds24-booking-import.ts:182`) כותב `ack_status` ו-`acknowledged_at` מראש בשורת ה-INSERT:

```sql
-- beds24-booking-import.ts:200-206
payload, import_status, ack_status, acknowledged_at)
VALUES (..., 'pending', 'acknowledged', now())
```

ההערה בקובץ מצהירה זאת מפורשות: *"ack columns pre-set (no ack semantics upstream)"*. כלומר שער ה-ACK
נעקף לחלוטין בארכיטקטורת Beds24 — לא "קיים ולא נקרא", אלא **לא רלוונטי**.

בנוסף: התיעוד מפנה לפונקציות שכבר **אינן קיימות** — `acknowledgeBookingRevision` ו-`reacknowledgeImported`
(מוזכרות ב-`docs/audit/WORKFLOW_INVENTORY.md:27` ו-`docs/audit/RESERVATIONS_INVENTORY_AUDIT.md:38`)
מחזירות **0 תוצאות** ב-grep על כל הריפו. גם ההפניות ל-`booking-import.ts:963-1002` שגויות — הקובץ באורך 707 שורות.

**PROPOSED:**
1. להחליף את `scripts/check-channel-chaos.mjs:34` בבדיקה שמוכיחה התנהגות ולא נוכחות מחרוזת — למשל
   assert ברמת DB ש-`UPDATE ... SET ack_status='acknowledged'` דורש `import_status='imported'`,
   או לכל הפחות לחלץ את גוף הפונקציה ולוודא קריאה אמיתית (`/markRevisionAcknowledged\s*\(/`).
2. להכריע במפורש: או להסיר את `markRevisionAcknowledged` + את בדיקת §4 (Beds24 אינו זקוק ל-ACK),
   או לתעד אותה כ-**dormant seam** ולסמן את הבדיקה כ-`skip` עם נימוק.
3. לתקן את `docs/audit/WORKFLOW_INVENTORY.md:27` ו-`docs/audit/RESERVATIONS_INVENTORY_AUDIT.md:38,62,118`
   — הם מתארים ארכיטקטורה (ACK אחרי commit, sweep מחדש) שאינה קיימת בקוד.

---

### 2. `card-ingest.ts` + מקטע ה-PAN staging — אשכול זומבי; הכרעה: **DELETE**

**חומרה:** חמור · **קבצים:** `src/lib/channel/card-ingest.ts:25` · `src/lib/channel/revisions.ts:66,111,152`

**EVIDENCE — מפת ההפניות המלאה:**

| סימבול | file:line | קוראי runtime | קוראי scripts |
|--------|-----------|---------------|---------------|
| `ingestChannelCard` | `card-ingest.ts:25` | **0** | `check-channel-card-ingest.mjs:146` (מורץ בפועל) |
| `ChannelCardIngestResult` | `card-ingest.ts:21` | 0 (self=2) | — |
| `persistBookingRevision` | `revisions.ts:111` | **0** | `check-channel-card-ingest.mjs:92` (מורץ) |
| `stageCard` (private) | `revisions.ts:66` | רק מ-`persistBookingRevision` | — |
| `attachStagedCard` (private) | `revisions.ts:152` | מ-`markRevisionImported` — **ענף שלא נלקח** | — |

grep מלא: `grep -rn "persistBookingRevision" --include='*.ts' --include='*.mjs' src scripts db` מחזיר
`revisions.ts:9` (הערה), `revisions.ts:111` (הגדרה), `scripts/check-channel-card-ingest.mjs:92`,
ו-`scripts/check-channel-chaos.mjs:29` (regex בלבד). **אין קורא ייצור.**

**ההוכחה ש-`attachStagedCard` בלתי-נגיש בייצור:** הוא רץ רק אם
`rev.card_pan_encrypted && rev.card_meta` (`revisions.ts:233`). הכותב **היחיד** של שתי העמודות האלה הוא
`persistBookingRevision` (`revisions.ts:121`) — שאין לו קורא ייצור. המסלול החי,
`runBeds24InboundPull` → `insertRevisionRow` (`beds24-booking-import.ts:182`), **אינו כולל את העמודות בכלל**
ב-INSERT, וההערה בשורה 179 מצהירה: *"NO card staging — Beds24 booking payloads are fetched without card
data (cards need a dedicated scope + endpoint that this import never requests)"*.
`grep -n -i "card" src/lib/channel/beds24-booking-import.ts` מחזיר **רק** את שורות ההערה 179–180.

**נזק נלווה — קריאה מתה בייצור:** `src/lib/payments/collection.ts:108-129` (בתוך `loadCollectionView`,
שנטען חי מ-`src/app/(dashboard)/reservations/actions.ts:29`) עושה
`SELECT ... card_meta FROM guesthub.channel_booking_revisions` ובונה ממנו `guarantee`.
מאחר שאיש אינו כותב `card_meta` בייצור, ענף ה-`guarantee` הוא **תמיד NULL** — ה-UI של פרטי הערבות
לעולם אינו מוצג עבור הזמנות OTA.

**כפילות:** `ingestChannelCard` (`card-ingest.ts:48-87`) ו-`attachStagedCard` (`revisions.ts:161-201`)
הם אותו `INSERT INTO guesthub.reservation_cards ... ON CONFLICT (reservation_id) DO UPDATE` עם אותה
רשימת `COALESCE` ואותו `INSERT INTO guesthub.audit_logs ... 'card_import_channel'`.
הפרש יחיד: `ingestChannelCard` מצפין בעצמו (`encryptPan`), `attachStagedCard` מעתיק ciphertext מוכן.
זו הפרה של כלל ברזל #8 (DRY).

**הקשר תומך:**
- `docs/BEDS24_COMPLETION_PLAN.md:71` — `| P4-5 | **card-ingest.ts** dead-code decision (pre-existing
  candidate, outside D91) | Keep-or-delete call for the owner | S | none |` — כלומר זו החלטה פתוחה ומוכרת.
- `docs/BEDS24_COMPLETION_PLAN.md:75-76` — *"**Anything card-data** (endpoints, scopes, payload fields) —
  D108. The token carries no card scope and none will be requested or mapped."*
- ההערה ב-`revisions.ts:22-24` **מיושנת**: *"no live poller calls these yet (no revision→reservation
  importer runs in the app today) ... the app-level chain activates when the Phase-4 importer lands"*.
  היבואן **נחת** (D76/Beds24) — אבל הוא עוקף את המקטע הזה לחלוטין.

**הכרעה: DELETE** (המלצה בלבד — לא בוצעה). נימוק כתוב:

זו **אינה** יכולת שנשמרה בכוונה לפיצ'ר PSP/CVV עתידי, אלא **כפיל זומבי**:
1. היכולת עצמה אינה אובדת במחיקה — `stageCard` + `attachStagedCard` ב-`revisions.ts` מממשים בדיוק את
   אותו דבר, ויושבים על מסלול הייבוא **החי** (`markRevisionImported` נקרא מ-`booking-import.ts:669`).
   אם ספק עתידי יביא כרטיסים, המקטע הנכון להחיות הוא זה שב-`revisions.ts`, לא הכפיל.
2. הספק היחיד לא יכול מבנית לספק את הקלט — Beds24 מצריך scope ייעודי שהתוכנית קובעת שלעולם לא יתבקש.
3. עבודת ה-PSP האמיתית (Cardcom/Tranzila) חיה על מסלול נפרד לגמרי — `wip/psp-beds24`
   (`docs/BEDS24_COMPLETION_PLAN.md:79`) — ומשתמשת ב-seam אחר (`src/lib/payments/gateway.ts`).
4. ההצדקה מעגלית: הראיה היחידה ש"משתמשים בו" היא סקריפט שנכתב אך ורק כדי לכסות אותו.
5. שיקול אבטחה: קוד מת שמצפין וכותב PAN הוא משטח סיכון — נתיב שאינו נבדק בייצור אך יודע לכתוב לכספת.

**PROPOSED (רצף בטוח, דורש אישור בעלים — P4-5):**
1. תחילה לתקן את הקריאה המתה: או להסיר את בלוק `card_meta` מ-`collection.ts:119-130`, או להחיות את
   ה-staging. אין להשאיר קריאה שתמיד NULL.
2. למחוק את `src/lib/channel/card-ingest.ts` **יחד עם** `scripts/check-channel-card-ingest.mjs` בחלקו
   שנוגע ל-`ingestChannelCard`, תוך שמירת חלק ה-`persistBookingRevision` (הוא מכסה את
   `redactPayload`/`encryptPan` — משמעת אמיתית שכדאי לשמר).
3. לעדכן את ההערה המיושנת ב-`revisions.ts:22-24` שתשקף את המצב: יבואן קיים, מקטע הכרטיס רדום.
4. לתקן את `scripts/check-cards.mjs:230,244` שמניחים ששני הקבצים קיימים.

---

### 3. `src/lib/reports/queries.ts` — מודול שלם ללא נקודת כניסה (8 exports)

**חומרה:** חמור · **קובץ:** `src/lib/reports/queries.ts`

**EVIDENCE:** לכל אחת מ-7 פונקציות הדוח יש **הופעה אחת בלבד בכל הריפו** — ההגדרה עצמה
(`grep -rn "\b<name>\b" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist`):

| file:line | סימבול | סה"כ הופעות בריפו |
|-----------|--------|-------------------|
| `src/lib/reports/queries.ts:22` | `arrivalsReport` | 1 |
| `src/lib/reports/queries.ts:26` | `departuresReport` | 1 |
| `src/lib/reports/queries.ts:30` | `inHouseReport` | 1 |
| `src/lib/reports/queries.ts:63` | `occupancyReport` | 1 |
| `src/lib/reports/queries.ts:83` | `revenueReport` | 1 |
| `src/lib/reports/queries.ts:106` | `balancesDueReport` | 1 |
| `src/lib/reports/queries.ts:127` | `cashUpReport` | 1 |
| `src/lib/reports/queries.ts:142` | `channelProductionReport` | 1 |

אין מסך דוחות: `find src -ipath '*report*'` מחזיר **רק** את `src/lib/reports/` עצמו — אין
`src/app/(dashboard)/reports/`, אין route, אין `import()` דינמי.

הסיבה גלויה ב-`src/components/layout/nav-items.ts:57` — פריט הניווט "דוחות" נמצא בסקשן
`ניהול עסקי` שכולו `hidden: true`, **וללא `href` כלל**.

`scripts/check-reports.mjs` אינו מריץ את הקוד הזה: שורה 20 היא
`const q = read("src/lib/reports/queries.ts")` — קריאת **טקסט** לצורך assertions על המקור.
רק `csv.ts` מקומפל ומורץ בפועל (שורות 41–47). כלומר `queries.ts` הוא **grep-only**, לא test-only.

באותו מודול: `exportReservationsCsvAction` / `exportGuestsCsvAction` (`src/lib/reports/export.ts:18,49`)
מופנים אך ורק מ-`scripts/check-reports.mjs:62` — גם שם ב-regex בלבד, לא בהרצה.

**PROPOSED:** להכריע כמודול: או לחבר מסך `/reports` ולהסיר את `hidden: true` (הרשאה `reports.view`
כבר קיימת בקטלוג), או להעביר את כל `src/lib/reports/queries.ts` + `export.ts` ל-attic/למחוק, יחד עם
התאמת `scripts/check-reports.mjs`. **אין למחוק** בלי הכרעה מוצרית — הקוד נראה שלם ותקין, רק לא מחובר.

---

### 4. שרשרת refund/void שלמה ללא נקודת כניסה — ובדיקה שאינה נוגעת בה

**חומרה:** חמור · **קבצים:** `src/app/(dashboard)/reservations/card-actions.ts:532,577`

**EVIDENCE:**

```
grep -rn "\brefundPaymentAction\b" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist
  docs/payments/PAYMENT_ARCHITECTURE.md:28
  docs/program/STATE.md:133
  docs/program/reports/STAGE_3_REPORT.md:21
  src/app/(dashboard)/reservations/card-actions.ts:532   ← ההגדרה
```

זהה עבור `voidPaymentAction` (`card-actions.ts:577`). **אפס קוראים בקוד.** אין כפתור, אין טופס, אין
Server-Action reference מ-UI כלשהו: חיפוש `refund` בכל `*.tsx` תחת `src/` מחזיר 24 תוצאות, כולן שמות
מחלקות CSS (`chip-refunded`), מחרוזות בקטלוג הרשאות (`PermissionsMatrix.tsx:16`), ותכונת
`isRefundable` של תוכניות תעריף — אף אחת אינה קריאה לפעולה.

מכאן שגם `recordRefund` / `voidPayment` (`src/lib/payments/mutations.ts:46,25`) מתים בפועל — הקוראים
היחידים שלהם הם שתי הפעולות המתות (`card-actions.ts:552,586`).

**והבדיקה שאמורה לכסות אותם אינה נוגעת בהם:** `scripts/check-payment-refund-void.mjs` הוא בדיקת SQL
גולמית מול DB חד-פעמי. `grep -c 'refundPaymentAction' scripts/check-payment-refund-void.mjs` = **0**;
`mutations.ts` מוזכר שם רק בהערה בשורה 3. הבדיקה **משכפלת** את לוגיקת ה-ledger inline (הפונקציה
`recompute` בשורות 15–20) ומאמתת את המודל — לא את הקוד. שלושה מסמכים
(`docs/payments/PAYMENT_ARCHITECTURE.md:28`, `docs/program/STATE.md:133`,
`docs/program/reports/STAGE_3_REPORT.md:21`) מצהירים *"Proven by check:payment-refund-void"* — הצהרה שאינה מדויקת.

אותה תבנית חוזרת ב-`setReservationTaxExemptAction` (`src/lib/israel-market/actions.ts:24`) ו-
`anonymizeGuestAction` (`src/lib/israel-market/actions.ts:55`): שניהם ללא קורא בקוד, ושניהם מוצהרים
כמכוסים ע"י `check:israel-market` — אך `grep` על `scripts/check-israel-market.mjs` מראה שהוא מריץ רק
`includedVatForReservation` (שורות 33,36) ו-`issueTaxDocument` (שורות 63,70), ולא נוגע בשתי הפעולות.

**PROPOSED:**
1. להכריע: לחבר UI ל-refund/void (ההרשאה `payments.refund` כבר קיימת ונאכפת בקוד), או להסיר את
   השרשרת כולה.
2. לתקן את שלושת המסמכים — "proven by" הוא מונח חזק; כרגע הוא לא נכון.
3. להוסיף ל-`check-payment-refund-void.mjs` ייבוא אמיתי של `mutations.ts` (במתכונת
   `check-channel-card-ingest.mjs`, שכן מקמפל ומריץ), אחרת הבדיקה תישאר ירוקה גם אם הקוד יימחק.

---

### 5. `docs/payments/TOKENIZATION_AND_PCI_BOUNDARIES.md` סותר את המציאות בנקודה רגישת-PCI

**חומרה:** חמור (תיעוד, אך בעל השלכות ציות) · **קובץ:** `docs/payments/TOKENIZATION_AND_PCI_BOUNDARIES.md:7`

המסמך קובע:
> *"**CVV is never accepted, stored, encrypted, revealed, logged or audited.** No `cvv_encrypted` column
> exists (added in 010, permanently dropped in 018)."*

**EVIDENCE שזה לא נכון היום:**
- `db/migrations/047_restore_stored_cvv.sql:31` — `ADD COLUMN IF NOT EXISTS cvv_encrypted text;`
  (המיגרציה מופיעה ב-`db/migrations/manifest.txt:55`).
- `src/app/(dashboard)/reservations/card-actions.ts:147` — `const cvvEncrypted = cvvRaw ? encryptCvv(cvvRaw) : null;`
- `card-actions.ts:170,173,179` — כתיבה לעמודה ב-INSERT/`ON CONFLICT DO UPDATE`.
- `card-actions.ts:250,258` — קריאה ופענוח: `const cvv = row.cvv_encrypted ? decryptCvv(row.cvv_encrypted) : null;`
- `src/components/reservations/CardFields.tsx:370` — הצגה ב-UI: `{revealed && view.cvv && <CopyBtn value={view.cvv} label="CVV" />}`
- `DECISIONS.md:792` מכיר בכך במפורש: *"⚠️ **PCI-DSS Req. 3.2 ceiling:** retaining a CVV after
  authorization is a violation. This is accepted ONLY because no PSP authorizes inside GuestHub."*

**זו גם הפרכה של הנחה שהועברה אליי:** `reservation_cards.cvv_encrypted` **אינו** ניסוי מושבת — הוא
נתיב חי ומודע (D87 + מיגרציה 047). מה שכן נשאר מוסר לצמיתות הוא
`channel_booking_revisions.card_cvv_encrypted` (`047_restore_stored_cvv.sql:18`).

אותה טעות מופיעה גם ב-`docs/audit/PMS_GAP_MATRIX.md:50` (*"CVV never stored (column dropped, migration 018)"*).

**PROPOSED:** לעדכן את שני המסמכים כך שישקפו את D87 + מיגרציה 047, כולל תנאי הביטול שכבר כתוב
ב-`DECISIONS.md:792` ("ברגע שגייטוויי אמיתי מחווט — להפיל את העמודה"). **המיגרציות עצמן (010, 018, 047)
הן היסטוריה ונשארות כמות שהן.**

---

## בינוני

### 6. 26 exports ללא **אף** הפניה בריפו

**חומרה:** בינוני · **EVIDENCE:** לכל אחד מהם `grep -rn "\b<name>\b" . --exclude-dir=node_modules
--exclude-dir=.git --exclude-dir=dist` מחזיר **הופעה אחת** (ההגדרה), למעט 4 שיש להם אזכורי תיעוד בלבד (מסומנים †).
אף אחד אינו export של קונבנציית Next (page/layout/route/metadata/GET/POST…).

| file:line | סימבול | הערה |
|-----------|--------|------|
| `src/app/(dashboard)/channels/ConfirmDialog.tsx:11` | `ConfirmDialog` | §9 |
| `src/app/(dashboard)/reservations/card-actions.ts:532` | `refundPaymentAction` † | §4 |
| `src/app/(dashboard)/reservations/card-actions.ts:577` | `voidPaymentAction` † | §4 |
| `src/app/(dashboard)/rooms/actions.ts:71` | `saveRoomOccupancyAction` | Server Action ללא טופס |
| `src/lib/audit.ts:23` | `writeSystemAudit` | audit של המערכת — אף כותב |
| `src/lib/channel/channel-http.ts:118` | `channelRequest` | §7 |
| `src/lib/channel/crypto.ts:44` | `sha256Hex` | |
| `src/lib/commercial/service.ts:154` | `listRooms` | |
| `src/lib/commercial/service.ts:192` | `resolveEffectiveExtraGuestPricing` | |
| `src/lib/dates.ts:112` | `formatDayMonth` | |
| `src/lib/housekeeping/actions.ts:166` | `listOpenTasksAction` | |
| `src/lib/inventory.ts:79` | `getRoomCapacities` | |
| `src/lib/israel-market/actions.ts:24` | `setReservationTaxExemptAction` † | §4 |
| `src/lib/israel-market/actions.ts:55` | `anonymizeGuestAction` † | §4 |
| `src/lib/israel-market/invoice.ts:59` | `setInvoiceProvider` | §8 |
| `src/lib/israel-market/invoice.ts:63` | `getInvoiceProvider` | §8 |
| `src/lib/messaging/messages.ts:128` | `listReservationMessages` | |
| `src/lib/payments/collection-labels.ts:44` | `cardBrandLabel` | |
| `src/lib/reports/queries.ts:22,26,30,63,83,106,127,142` | 8 פונקציות דוח | §3 |

בנוסף **33 טיפוסים** ללא אף הפניה (self=1), רובם `z.infer` שנוצרו ולא נצרכו — למשל
`src/lib/validation/user.ts:83,84` (`CreateUserInput`, `UpdateUserInput`),
`src/lib/validation/rooms.ts:33,78,101,109,115,123` (6 טיפוסים),
`src/lib/validation/commercial.ts:34,64,97,111`, `src/lib/communications/styles.ts` (11 טיפוסים).

**PROPOSED:** לעבור סימבול-סימבול ולסווג ל-{מחיקה / חיבור ל-UI / סימון `@internal`}. אין למחוק כמקשה
אחת — `writeSystemAudit` ו-`getRoomCapacities` נראים כמו seams שנועדו להיקרא ופשוט לא חוברו.
מומלץ להוסיף `knip` או `ts-prune` ל-devDependencies + סקריפט `check:dead-exports` כדי שהרשימה לא תגדל.

---

### 7. `channelRequest` / `isAmbiguous` — שרידי שכבת ה-HTTP הגנרית שקדמה ל-Beds24

**חומרה:** בינוני · **קובץ:** `src/lib/channel/channel-http.ts:118` (`channelRequest`), `:83` (`isAmbiguous`)

**EVIDENCE:** `grep -rn "\bchannelRequest\b" . --exclude-dir=node_modules --exclude-dir=.git
--exclude-dir=dist` → **הופעה אחת**, ההגדרה. כל צרכני `channel-http.ts` מייבאים ממנו **רק** את
העוזרים הקטנים: `asObj`, `asStr`, `asInt`, `mapErrorStatus`, `fail`, `DEFAULT_TIMEOUT_MS` — ראה
`beds24-http.ts:25`, `beds24-token.ts:6`, `beds24-admin.ts:12`, `beds24-ari.ts:33`,
`beds24-properties.ts:29`, `beds24-booking-import.ts:5`, `reservations/actions.ts:40`.
ה-HTTP בפועל עובר דרך `beds24Request` ב-`src/lib/channel/beds24-http.ts`.

`isAmbiguous` (`channel-http.ts:83`) — 2 הופעות בלבד: ההגדרה, ו-`scripts/check-channel-chaos.mjs:45`
בתוך regex (`/ambiguous|isAmbiguous|retr/i.test(importSrc)`) — כלומר grep-only, ומכיוון שה-regex
מכיל גם `retr` הוא יעבור על כל אזכור של "retry" בקובץ. גם זה שער חלש.

**PROPOSED:** למחוק את `channelRequest` (הפונקציה, ~35 שורות) ולהשאיר את `channel-http.ts` כמודול
העוזרים שהוא בפועל. להכריע לגבי `isAmbiguous` יחד עם §1. לחדד את ה-regex בשורה 45.

---

### 8. seam ספק החשבוניות — הוזרק פעם, אף פעם לא נצרך

**חומרה:** בינוני · **קובץ:** `src/lib/israel-market/invoice.ts:59,63`

**EVIDENCE:** `setInvoiceProvider` ו-`getInvoiceProvider` — הופעה אחת כל אחד בכל הריפו (ההגדרה).
הפונקציה שכן מורצת מהבדיקה היא `issueTaxDocument` (`invoice.ts:69`, מורצת מ-
`scripts/check-israel-market.mjs:63,70`), אך היא אינה עוברת דרך ה-getter/setter הללו.

**PROPOSED:** או לחווט את `issueTaxDocument` דרך `getInvoiceProvider()` (כך ה-seam יקבל משמעות),
או להסיר את שתי הפונקציות ולהשאיר את הספק כקבוע מודול.

---

### 9. `ConfirmDialog.tsx` — קומפוננטת React שלא מרונדרת מעולם

**חומרה:** בינוני · **קובץ:** `src/app/(dashboard)/channels/ConfirmDialog.tsx:11`

**EVIDENCE:** `grep -rn "ConfirmDialog" --include='*.ts' --include='*.tsx' src` מחזיר 4 שורות; שלוש מהן
נוגעות ל-**קומפוננטה אחרת** — `MoveConfirmDialog` (`src/app/(dashboard)/calendar/MoveConfirmDialog.tsx:84`,
מיובאת ומרונדרת ב-`CalendarGrid.tsx:63,1272`). לקובץ `channels/ConfirmDialog.tsx` עצמו **אין ולו ייבוא אחד**.
סריקה שיטתית של כל 274 קבצי `.ts`/`.tsx` (כל קומפוננטה מיוצאת שאינה קונבנציית Next, מול קורפוס
`src` + `scripts`) העלתה שזו **הקומפוננטה הבלתי-מרונדרת היחידה** בכל הפרויקט.

מקור: `git log --oneline -- 'src/app/(dashboard)/channels/ConfirmDialog.tsx'` → קומיט יחיד
`da3fb3a feat(design-system): enforce GUIDELINES.md across the entire application (D89)` — כלומר
נוצרה בגל אכיפת עיצוב ומעולם לא חוברה.

**PROPOSED:** למחוק, או להשתמש בה במקום דיאלוגי האישור המקומיים במסך `/channels` (זו הזדמנות DRY —
כלל ברזל #8). לבדוק גם CSS יתום נלווה (כלל ברזל #9).

---

### 10. 5 סקריפטי `check-*` שאינם מחווטים ל-`package.json`

**חומרה:** בינוני · **EVIDENCE:** הצלבה תוכניתית של `fs.readdirSync('scripts')` מול
`JSON.stringify(pkg.scripts)` (78 סקריפטים). אין runner שמבצע glob — כל הסקריפטים המצרפיים
(`check:beds24`, `check:guest-communications`) מונים קבצים מפורשות.

| קובץ | הפניה יחידה |
|------|-------------|
| `scripts/check-guards.mjs` | `DECISIONS.md:183,233,383` + `docs/audit/ARCHITECTURE_INVENTORY.md:208` |
| `scripts/check-rates-date-policy.mjs` | `docs/audit/ARCHITECTURE_INVENTORY.md:218` |
| `scripts/check-room-deletion.mjs` | `docs/audit/ARCHITECTURE_INVENTORY.md:219` |
| `scripts/check-rooms-module.mjs` | `docs/audit/ARCHITECTURE_INVENTORY.md:219` |
| `scripts/check-seed-safety.mjs` | `docs/audit/ARCHITECTURE_INVENTORY.md:208` |

הכיוון ההפוך נקי: אפס סקריפטים ב-`package.json` מפנים לקובץ שאינו קיים.

הערה: `docs/audit/ARCHITECTURE_INVENTORY.md:218` מזכיר גם `check-rates-sync.mjs` — קובץ שאינו קיים בעץ.

**PROPOSED:** לחווט את החמישה ל-`package.json` (במיוחד `check-guards.mjs` ו-`check-seed-safety.mjs` —
שניהם שומרי בטיחות, ו-`check-guards.mjs` מריץ בפועל את `isSensitivePermission`), או להסירם במפורש.
סקריפט בטיחות שאיש אינו מריץ הוא הגרוע משני העולמות. שקלו `check:scripts-wired` שיאכוף את ההצלבה.

---

### 11. 11 קבצי `src/` שהתיעוד מפנה אליהם ואינם קיימים — שאריות D91

**חומרה:** בינוני · **EVIDENCE:** חילוץ כל נתיבי `src/**` מ-`docs/` ומקבצי ה-md בשורש, ואז בדיקת קיום:

```
src/app/api/channel/webhook/[token]/route.ts     src/lib/channel/provider.ts
src/lib/channel/ari-payloads.ts                  src/lib/channel/rate-plan-admin.ts
src/lib/channel/ari-progress.ts                  src/lib/channel/reconcile.ts
src/lib/channel/ari-sync.ts                      src/lib/channel/room-type-admin.ts
src/lib/channel/connection-test.ts               src/lib/channel/inbound-admin.ts
src/lib/channel/payments-admin.ts
```

בנוסף `CertificationConsoleSection.tsx` (`docs/program/STATE.md:120`,
`docs/program/reports/STAGE_4_REPORT.md:29`) — `find src -iname '*ertification*'` מחזיר ריק.

אלה מחיקות D91 לגיטימיות; מה שנשאר מאחור הוא **התיעוד**, שמתאר ארכיטקטורה שאינה קיימת.

**PROPOSED:** לסמן את המסמכים ההיסטוריים (`docs/program/reports/STAGE_*.md`, `docs/program/STATE.md`)
בכותרת "מצב היסטורי — נכון לשלב N" כדי שלא ייקראו כתיעוד חי. את מסמכי הארכיטקטורה החיים
(`docs/architecture/*`, `docs/audit/*`) לעדכן בפועל. **`DECISIONS.md` ו-`db/migrations/` הם רשומה
היסטורית ונשארים ללא שינוי.**

---

### 12. `loadEvidenceLedger` — אפס קוראים; הקונסולה נעלמה עם D91

**חומרה:** בינוני · **קובץ:** `src/lib/channel/evidence.ts:91`

**EVIDENCE:** `grep -rn "loadEvidenceLedger" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist`
מחזיר **3 שורות**: `src/lib/channel/evidence.ts:11` (הערה), `:91` (ההגדרה),
ו-`docs/program/STATE.md:120` (תיעוד). **אפס קוראים בקוד.** הטענה מהערב **אוששה.**

הצרכן שלה, `CertificationConsoleSection.tsx`, אינו קיים (§11), וכך גם `certification.ts`.

**חשוב — הכותב עדיין חי:** `recordAriEvidence` (`evidence.ts:44`) נקרא שלוש פעמים ממסלול ה-ARI החי —
`src/lib/channel/beds24-ari-sync.ts:262,382,534`. הטבלה `guesthub.channel_evidence_ledger` **מתמלאת
בייצור** אך אין דרך בקוד לקרוא ממנה. זהו append-only ledger שנכתב לתוך חלל ריק.

`scripts/check-channel-chaos.mjs:85` מוודא שהטבלה נשארת immutable — בדיקה שעדיין רלוונטית לכותב.

**PROPOSED:** להכריע: אם ה-ledger נדרש לתחקור — לבנות קורא מינימלי (או להשאיר את
`loadEvidenceLedger` ולתעדו כ-"ops query helper", בשימוש ידני דרך `psql`/סקריפט). אם אינו נדרש —
לשקול הסרת הכותב וה-ledger גם יחד, כולל מדיניות retention (הטבלה גדלה ללא הגבלה).
**מיגרציה 038 היא היסטוריה ונשארת.**

---

### 13. `STATE.md` ו-`CLAUDE.md` מתארים הקפאה שכבר בוטלה

**חומרה:** בינוני · **קבצים:** `STATE.md:17-23`, `CLAUDE.md` (טבלת המסכים)

`STATE.md:17-18` (מתוארך 2026-07-18): *"הוסתרו מהתפריט הצדדי בלבד: **ניקיון** (`/housekeeping`)
ו**משימות** (`/tasks`) — דרך `hidden: true` ב-`src/components/layout/nav-items.ts`"*.
`CLAUDE.md` מצהיר *"(+housekeeping/tasks — קפואים, ראה STATE.md)"*.

**EVIDENCE שההקפאה בוטלה:** `src/components/layout/nav-items.ts:44-45` —
`{ label: "ניקיון", ..., href: "/housekeeping", permission: "housekeeping.view" }` ו-
`{ label: "תחזוקה", ..., href: "/maintenance", permission: "housekeeping.view" }`, **שניהם ללא `hidden: true`**,
עם הערת D88 מעליהם (שורות 38–43). שני המסלולים קיימים:
`src/app/(dashboard)/housekeeping/page.tsx` ו-`src/app/(dashboard)/maintenance/page.tsx`.

הצלבתי את כל 14 ה-`href` בניווט מול תיקיות המסלולים בפועל — **כולם קיימים**, אין קישור שבור.
המסלול `/tasks` שמוזכר ב-`STATE.md` אכן אינו קיים (אין `src/app/(dashboard)/tasks/`), אך גם אינו מוזכר בניווט.

**PROPOSED:** לעדכן את `STATE.md` ואת טבלת המסכים ב-`CLAUDE.md` — housekeeping ו-maintenance חיים
(D88), ו-`/tasks` בוטל. `CLAUDE.md` מונה "14 מסכי dashboard"; בפועל יש 15 תיקיות מסלול.

---

## קל

### 14. Over-export: 58 ערכים + 141 טיפוסים מיוצאים ונצרכים רק בקובץ שלהם

**חומרה:** קל · **EVIDENCE:** סריקה תוכניתית — הסימבול מופיע ≥2 פעמים בקובץ שלו ו-**0** פעמים בכל
קורפוס `src` + `scripts` + `db` + קבצי הקונפיג.

זה **אינו קוד מת** — הקוד רץ. ה-`export` הוא המת, והוא מרחיב את משטח ה-API של כל מודול שלא לצורך
ומחליש את יכולת ה-tree-shaking וה-refactor. דוגמאות בולטות:
`src/lib/communications/renderer.ts:32` (`escapeHtml`, 18 שימושים פנימיים, אפס חיצוניים),
`src/lib/auth/guards.ts:82` (`PROTECTED_ROLE_KEYS`), `src/lib/channel/worker.ts:40,209,236,258`
(`DEFAULT_INTERVAL_MS`, `INBOUND_POLL_MINUTES`, `RECONCILE_MINUTES`, `runTick`),
`src/lib/communications/schemas.ts` (6 סכמות), `src/lib/validation/*` (7 סכמות).

**PROPOSED:** נמוך-עדיפות. להסיר `export` היכן שאין צורך. שימו לב: חלק מהם נקראים ע"י בדיקות
בעתיד או משמשים לתיעוד — לא למחוק אוטומטית.

---

### 15. `getPaymentGateway()` — ענף יחיד נגיש, אך seam מכוון

**חומרה:** קל · **קובץ:** `src/lib/payments/gateway.ts:39-47`

`getPaymentGateway()` מחזיר `return null;` ללא תנאי. לכן `paymentGatewayConfigured()` תמיד `false`,
וכל ענף ה-`if (gateway)` ב-`card-actions.ts:339` ואילך **בלתי-נגיש**.

**זה אינו דגל מת** אלא seam מתועד היטב (D46), עם קוראים חיים בשני מקומות
(`card-actions.ts:29,327` ו-`collection.ts:3,152`) שמטפלים ב-`null` כראוי — fail-closed.
`scripts/check-cards.mjs:267-277` אוכף את החוזה.

**PROPOSED:** להשאיר. מומלץ להוסיף `// eslint-disable-next-line` או הערת `@remarks` שתסביר שהענף
מכוון, כדי שסורק קוד-מת עתידי לא יסמן אותו.

---

### 16. תלויות npm — אפס מתות

**חומרה:** קל (מידע) · **EVIDENCE:** הצלבה תוכניתית של 21 `dependencies` + 10 `devDependencies`
מול `from '<dep>'` / `require('<dep>')` / `import('<dep>')` / `@import` בכל `src`, `scripts` וקבצי הקונפיג.

כל 21 תלויות הריצה **מיובאות בפועל**, כולל אלה שנראות "standard stack ולא בשימוש":

| תלות | שימוש אמיתי |
|------|-------------|
| `@dnd-kit/core` · `/sortable` · `/utilities` | `src/app/(dashboard)/housekeeping/TaskDispatchBoard.tsx` |
| `@react-pdf/renderer` | `src/app/api/reservations/[id]/pdf/route.ts` |
| `@tanstack/react-table` | `src/app/(dashboard)/staff/StaffTable.tsx` |
| `@hookform/resolvers` · `react-hook-form` | `src/app/(dashboard)/staff/EmployeeSidePanel.tsx` |
| `nuqs` | `src/app/(dashboard)/settings/SettingsShell.tsx` |
| `framer-motion` | `src/components/ui/SidePanel.tsx` |
| `@hebcal/core` | `src/lib/check-in-check-out.ts` |
| `nodemailer` | `src/lib/messaging/email/gmail.ts` |

`server-only` נצרך כ-side-effect import (`import "server-only";`) ב-**54** קבצים.
`@tailwindcss/postcss` נצרך ב-`postcss.config.mjs`. `@types/*`, `eslint`, `eslint-config-next`,
`typescript`, `tailwindcss` — tooling/config-only, **אינם** תלויות מתות.

**PROPOSED:** אין פעולה. `@tanstack/react-query`, `zustand`, `cmdk` וכו' מ"ה-standard stack" של
`CLAUDE.md` **אינם מותקנים כלל** — כלומר אין כאן חוב "מותקן ולא בשימוש".

---

### 17. `channex` / `hospitable` / `stripe` — הקוד נקי, מה שנותר הוא היסטוריה

**חומרה:** קל (מידע) · **EVIDENCE:** `grep -rni "channex\|hospitable\|stripe" src | wc -l` → **0**.
גם `package.json` נקי (`grep -i` מחזיר exit 1). `AGENTS.md`, `CLAUDE.md`, `README.md`,
`GUIDELINES.md`, `DESIGN_SYSTEM.md` — 0 אזכורים.

161 האזכורים שנותרו מתחלקים כך:

| מיקום | כמות | סיווג |
|-------|------|-------|
| `db/migrations/*.sql` + `manifest.txt` | 160 | **רשומה היסטורית — חייבים להישאר.** מיגרציה היא רשומה של מה שקרה; שכתובה שוברת את שרשרת ההרצה. כולל `005`, `022`–`027`, `029`–`033`, `035`, `038`, `039`, `044_hospitable_provider.sql`, `045_beds24_provider.sql`, `051_psp_readiness.sql`, `054_external_column_rename.sql` |
| `scripts/check-beds24-jobs.mjs:43` | 1 | הערה המתעדת את חתך D91 — **להשאיר**, היא מסבירה למה הבדיקה קיימת |
| `DECISIONS.md` | 64 | **רשומה היסטורית — להשאיר** (D91 הוא בדיוק ההחלטה שהסירה אותם) |
| `docs/**` | ~250 | מעורב — ראה §11. דוחות שלב = היסטוריה; מסמכי ארכיטקטורה חיים = לעדכן |

הערה על `044` מול `045`: שתי המיגרציות קיימות ושתיהן נחוצות —
`044_hospitable_provider.sql:35` מרחיב את ה-CHECK ל-`('channex','hospitable')`, ו-
`045_beds24_provider.sql:25` מרחיב אותו ל-`('channex','hospitable','beds24')`. `045` מסתמכת על מצב
הביניים ש-`044` יצרה. **אין כאן כפילות ואין מה למחוק.**
`054_external_column_rename.sql` השלים את שינוי השם `channex_*` → `external_*`, ואכן **אין ולו
עמודה אחת** בשם `channex_*` שמוזכרת ב-`src/`.

**PROPOSED:** אין פעולה על קוד או מיגרציות. הפעולה היחידה היא סניטציית תיעוד (§11).

---

### 18. `D108` — הפניה להחלטה שאינה קיימת

**חומרה:** קל · **קובץ:** `docs/BEDS24_COMPLETION_PLAN.md:75`

המסמך מסתמך על *"**Anything card-data** (endpoints, scopes, payload fields) — D108"*, אך
`DECISIONS.md` מסתיים ב-**D93** (`## D93 — ביטולי OTA...`, שורה 872). חיפוש `D108` ב-`DECISIONS.md`
מחזיר ריק. רצף ההחלטות הקיים: …D89, D90, D91, D92, D93.

זה מהותי כי §2 (הכרעת `card-ingest.ts`) נשענת חלקית על האיסור הזה.

**PROPOSED:** או לתעד את D108 ב-`DECISIONS.md` (האיסור עצמו נשמע נכון ומחייב), או לתקן את ההפניה
במסמך התוכנית למספר ההחלטה האמיתי. כרגע זהו איסור אבטחה ללא בית קנוני.

---

## נספח א' — סיווג 42 ה-exports שמופנים רק מ-`scripts/`

**לא כולם "test-only".** שלוש קטגוריות:

**א. פרודקשן (2)** — נקראים ע"י worker ה-PM2, לא ע"י בדיקה. **אינם מתים בשום מובן:**
`src/lib/channel/worker.ts:309` `runChannelWorker` ו-`:54` `resolveIntervalMs`, נצרכים ב-
`scripts/channel-worker.cjs:46,64,66`, שהוא ה-`script` של `guesthub-channel-worker` ב-
`ecosystem.config.cjs:16`.

**ב. test-only אמיתי — מקומפל ומורץ (25):** `isSensitivePermission`, `mapsErrorMessage`,
`resolveSelectedPlace`, `luhnValid`, `maskedPan`, `ingestChannelCard`, `classifyIsraelDate`,
`resolveScheduleForDate`, `resolveStaySchedule`, `evaluateSameDayCheckInCutoff`, `isExtraGuestConfigured`,
`classifyEmailFailure`, `cancelIneligibleDeliveries`, `claimDeliveries`, `getVariableDefinition`,
`extractVariableKeys`, `balanceOf`, `issueTaxDocument`, `isIsraeliMobile`, `greenApiChatId`,
`calculateQuote`, `resolveNightPrice`, `classifySellState`, `includedVatForReservation`,
`stayRestrictionViolation`.

**ג. grep-only — הבדיקה קוראת את המקור כטקסט ומריצה regex (15):** ההוכחה שהם "מכוסים" חלשה מהותית,
כמו במקרה §1. בולטים: `exportReservationsCsvAction` / `exportGuestsCsvAction`
(`check-reports.mjs:62`), `isAmbiguous` (`check-channel-chaos.mjs:45`), `PaymentGateway`
(`check-cards.mjs:267`), `BEDS24_STATUS_FILTER` (`check-beds24-cancellation-sync.mjs:43,47`),
`defaultWorkflowStatusId` (`check-status-default.mjs:50,52`), `snapIconSize`
(`check-design-system.mjs:233`), `DRAG_THRESHOLD_PX` (`check-calendar-ui.mjs:21`),
`COLLECTED_PAYMENT_STATUS` (`check-payments.mjs:19,21`), `EXTRA_GUEST_UNCONFIGURED`,
`MAPS_ERROR_CODES`, `BUILDING_ZOOM`, `CardMode`, `VisibleChannel`, `failureNotificationSchema`.

> אזהרת שיטה: הסיווג ב-(ג) התבצע בהיוריסטיקה (האם הסימבול מופיע רק בתוך literal של regex /
> `.test(` / `read(`). ייתכנו 1–2 סיווגי-שווא כשסימבול מופנה מכמה סקריפטים —
> `stayRestrictionViolation` למשל הוא grep-only ב-`check-calendar.mjs:84` אך כן מורץ מ-
> `check-pricing-engine.mjs`. אימות מדויק דורש מעבר ידני על 15 השורות.

---

## נספח ב' — מה לא הצלחתי לאמת

1. **הרצת הבדיקות בפועל.** האודיט כולו סטטי. לא הרצתי `pnpm typecheck`/`lint`/`build` ולא אף
   `check:*` — הרצת בדיקות DB דורשת `guesthub-testdb` ואת התפקיד `guesthub_app` (ראה זיכרון
   "testdb env quirks"), והעץ משותף לשלושה סוכנים במקביל. **המשמעות:** טענות "אפס קוראים" חסינות
   (הן grep), אך טענות "הענף בלתי-נגיש" (§2, §15) הן מסקנה מקריאת קוד, לא מ-coverage מדוד.
2. **קוראים חיצוניים לריפו.** `/api/public/availability` ו-`/api/public/bookings` — אין להם קורא
   בריפו (`grep` על כל הקבצים מחזיר רק הערות ב-`route.ts` ו-`lib/public-booking/availability.ts:8`),
   אך `bookings/route.ts:18` מתעד *"website checkout (sea-tower, server-to-server)"* והם מוגנים
   ב-`PUBLIC_BOOKING_API_SECRET`. **סיווג: externally reachable, no in-repo caller — לא מתים.**
   אישור סופי דורש לוגים של פרודקשן. אותו סיווג ל-webhooks של green-api/twilio
   (יש להם בונה-URL ב-`MessagingSection.tsx:506,631` אך הקורא הוא הספק החיצוני).
3. **האם `card_meta` ריק בייצור בפועל.** הסקתי זאת מהקוד (§2). אימות ודאי = שאילתת קריאה בלבד
   `SELECT count(*) FROM guesthub.channel_booking_revisions WHERE card_meta IS NOT NULL` —
   לא הרצתי, כדי לא לגעת ב-DB של פרודקשן.
4. **`hidden: true` דינמי.** `Sidebar.tsx` מסנן לפי הרשאות בזמן ריצה; לא אימתתי שכל 14 פריטי
   הניווט אכן מוצגים למשתמש אמיתי — רק שה-`href` מצביע למסלול קיים.
5. **`docs/` מלא.** סרקתי אזכורי `channex|hospitable|stripe` ונתיבי `src/**` בכל `docs/`, אך לא
   קראתי את ~46 המסמכים במלואם. ייתכנו טענות מיושנות נוספות מסוגי §5/§11 שלא נתפסו.


---

## 9ד — ביקורת אדוורסרית על עבודת הלילה

**מבקר:** AUDIT AGENT 9d. לא כתבתי אף שורה מהקוד הזה ולא קיבלתי גישה לנימוקים שהובילו אליו.
**בסיס:** `origin/main = 5b171bd`. שמונה PRs פתוחים (103–110), אף אחד לא מוזג.
**שיטה:** קריאת diff אדוורסרית → שבירה מכוונת של קוד הפרודקשן ב-worktrees משלי (`/home/ubuntu/worktrees/audit9d-*`) → הרצת השומר → תיעוד אדום/ירוק. בנוסף: מדידה חיה קריאה-בלבד מול `api.beds24.com`, הרצת מיגרציות על testdb (:5433), ומיזוג אמיתי של כל השמונה ב-worktree גרוד.
**לא בוצע:** שום deploy, שום כתיבה ל-Beds24, שום `POST /channels/booking`, שום מחיקת שורות. הפעולה החיה היחידה: `GET /v2/properties` אחת עם טוקן מטמון קיים (בלי חידוש טוקן).

---

### 1. פסק דין לכל PR

| PR | פסק | למה — בשורה אחת |
|----|-----|------------------|
| **103** docs(channel) | **SOUND** | הערות בלבד; מדויקות מול `main` — פרט לכך שההצהרה החדשה ב-`evidence.ts` ("קורא יחיד: `beds24-ari-sync.ts`") נהיית שקרית ברגע ש-106 נכנס. |
| **104** credit-backoff | **BROKEN** | הענף החדש ב-`drainBeds24AriDirtyRanges` **בולע כשל ספק אמיתי** ומונע לצמיתות dead-letter (הוכחתי בריצה); השומר שלו **ירוק לגמרי** גם כשכל השער היוצא נמחק; ומתנגש קשה עם 105 ועם 110. הנחת ה-headers עצמה — **נכונה, אימתתי חי**. |
| **105** fixture guards | **BROKEN** | שני השומרים עצמם מצוינים ומוכחים — אבל טענת ה-static הראשונה של `check:beds24-ari-drain` **נועלת שם header שלא קיים על החוט** (`x-fivemincreditlimit-remaining`), כלומר מקבעת את הבאג ש-104 מתקן. ברגע ש-104 נכנס, השומר נופל בטענה הראשונה. |
| **106** ARI read-back | **CONCERNS** | "קריאה בלבד" — **מוכח** גם מול POST מוסווה; האריתמטיקה של הקרדיטים אומתה חיה (`x-request-cost: 1`). אבל: ההתראה היא **חד-פעמית לכל החיים** (אין שום מסלול שפותר `channel_sync_errors`), וחלון ה-14 יום **אינו נאכף על החוט** ע"י השומר (הוכחתי: 500 יום עוברים בירוק). |
| **107** calendar diagnosis | **SOUND** | אימתתי עצמאית: `resolveChannelBadge` לעולם לא `null`, המודל אחיד על 5 משטחים, ו**רפרנס הבעלים** (`ref/screens/GuesthubCalandrFix.png`) באמת מציג תג עיפרון אפור על הזמנות פנימיות + מקרא של 4 ערוצים. ההכרעה "שומר מיושן" נכונה. מסמך בלבד — לא נוגע בקוד. |
| **108** rooms "סגור" | **CONCERNS** | ה-SQL **נכון ותואם בדיוק** את הקוראים הקנוניים (`grid-state.ts`, `effective-state.ts`): base plan לכל SU, `pricing_plan_rates`, tenant-scoped, ותאריך הלוח הוא `todayInTz(tenant.timezone)`. חדר↔SU הוא 1:1 בכפייה (unique constraint), אז התקפת ה-multi-SU מתה. נשארו בעיות UX: יחידה מאוגדת צובעת את כל חדריה, ואין דרך לנקות "סגור" מהלוח. |
| **109** source "מהמערכת" | **SOUND** | השומר מוכח (שברתי → אדום); הרצתי את 056 פעמיים על testdb — עובר, אידמפוטנטי, ה-unique constraint קיים ו-`sort_order` הוא `NOT NULL DEFAULT 0` כך ש-`MAX+1` בטוח. חסרון: השומר **לא מריץ** את המיגרציה, ו-manifest מתנגש עם 110. |
| **110** Booking.com reports | **CONCERNS** | טענת `waivedFees` — **מוכחת** גם מול מוטציה אחרי בנייה עם שם שנבנה בזמן ריצה. בידוד טננט — מוכח. אבל: **שובר typecheck** מול 104, אין שום מנגנון שמונע דיווח בלתי-הפיך פעמיים, והשעון בדפדפן הוא קבוע אפליקטיבי בעוד השרת קורא `tenants.timezone`. |

---

### 2. כל שומר חדש — PROVEN או VACUOUS

| שומר (PR) | פסק | השבירה שהחלתי | הפלט |
|-----------|-----|----------------|------|
| `check:beds24-credit-backoff` (104) — **חצי נכנס** | **PROVEN** | מחיקת `if (gate.pause) break` ב-`pullWindow` (`beds24-booking-import.ts`) | אדום: `actual: 50, expected: 1` — "low credits must stop the page walk after ONE call" |
| `check:beds24-credit-backoff` (104) — **חצי יוצא** | **VACUOUS** | מחיקת `if (gate.pause) {...break}` ב-`sendCalendarRequests` **וגם** מחיקת כל ענף ה-credit-pause (1,921 תווים) ב-`drainBeds24AriDirtyRanges` — כולל ה-UPDATE ל-`channel_dirty_ranges`, ה-`logChannelError` ופתיחת ה-breaker | **ירוק: "all 11 assertions passed"** (tsc עבר נקי — זו רגרסיה שמתקמפלת) |
| `check:beds24-ari-drain` (105) | **PROVEN** | (א) הסרת ה-past-date clamp: `const from = rawFrom;` (ב) `if (o.success === false && o.errors === undefined)` — רק success:false ערום נחשב כשל | (א) אדום: `5 !== 0` — "no date before today may ever leave the process" (ב) אדום: `'partial_warnings' !== 'validation'` |
| `check:beds24-quarantine-selfheal` (105) | **PROVEN** | (א) הצרת ה-sweep ל-`IN ('pending','failed')` (ב) הרחבת הסקופ ל-`(connection_id = $1 OR true)` | (א) אדום: `0 !== 1` — הרוויזיה החנוטה לא נרפאה (ב) אדום: `2 !== 1` — הרוויזיה של הטננט השכן נגררה פנימה |
| `check:beds24-ari-readback` (106) — קריאה-בלבד | **PROVEN** | POST אמיתי ששומר ליטרל `method: "GET"` דמה כדי לעבור את ה-grep הסטטי (`String.fromCharCode(80,79,83,84)`) | אדום: `actual: ['POST /v2/inventory/rooms/calendar'], expected: []` |
| `check:beds24-ari-readback` (106) — חלון 14 יום | **VACUOUS** | `endDate=${addDays(args.toInclusive, 486)}` — הבקשה החיה מבקשת 500 יום; הקבוע `BEDS24_READBACK_DAYS` נשאר 14 | **ירוק: "all 11 assertions passed"** — ה-mock לא בודק את טווח ה-`startDate`/`endDate` שהתקבל |
| `check:reservation-source-system` (109) | **PROVEN** | `case "system":` נוסף ל-switch של `normalizeVisibleChannel` | אדום: `actual: 'booking', expected: null` |
| `check:booking-com-reports` (110) | **PROVEN** (3 שבירות) | (א) `note: "fee waiver applied"` בגוף (ב) מוטציה אחרי בנייה: `(wireBody[0] as ...).waivedFees = true` תוך שמירת הליטרל (ג) אותו דבר עם `["waived"+"Fees"]` — מתחמק משני ה-greps הסטטיים (ד) הסרת `AND r.tenant_id = ...` | (א) אדום בטענה הסטטית (ב) אדום בטענה `!/waivedFees/` (ג) **אדום ב-runtime**: `actual: ['action','bookingId','waivedFees']` (ד) אדום: הניסיון החוצה-טננט הגיע לשומר מאוחר יותר |

**סיכום:** שישה שומרים, שני חורי ריק — שניהם באותה מחלקה: **טענה על קבוע במקום על התנהגות**.

---

### 3. ממצאים — הקשים ראשונים

#### 🔴 חמור 1 — 104 בולע כשל ספק אמיתי והופך טווח לנצחי
`src/lib/channel/beds24-ari-sync.ts:591-627` (ענף ה-credit-pause) לפני `:629` (ענף הכשל).

**EVIDENCE.** התנאי הוא `if (creditPause && warnings.length === 0)` — הוא **אינו בודק `failure === null`**. `sendCalendarRequests` מחזירה על הכשל הראשון, ומזינה את אותה תשובה גם ל-gate. אם התשובה נושאת גם כשל וגם מונה נמוך — הענף הראשון תופס.

הרצתי את זה על testdb דרך מודולי ה-dist האמיתיים (מוק שמחזיר HTTP 500 עם `x-five-min-limit-remaining: 8.0`):

```
AUDIT 9d — server_error(500) + remaining 8.0:
  summary          : {"claimed":1,"synced":0,"retried":1,"failed":0,"requests":1,"sentValues":0,"creditPausedMs":137000}
  range.attempts   : 0        ← הכשל מעולם לא נספר
  range.status     : pending
  range.last_error : null     ← ה-500 לא נרשם על הטווח
  conn.last_error  : null     ← ה-chip ב-/rates לעולם לא יראה "הסנכרון נכשל"
  sync_error code  : credit_paused
  sync_error msg   : מכסת הקרדיטים של Beds24 קרובה למיצוי (8/100) — האטה ל-137 שניות
  evidence code    : credit_paused / outcome partial
  circuit opens for: 137 s    ← במקום ה-backoff האקספוננציאלי של server_error
```

**FAILURE SCENARIO.** החשבון כבר קרוב לתקרה (ה-poll, ה-reconcile, ה-read-back של 106 וכל צרכן אחר חולקים את אותם 100 קרדיטים). Beds24 דוחה payload קבוע — `validation` על 400, או `success:false` על 200. הטווח **לא מגדיל `attempts`**, ולכן לעולם לא מגיע ל-`max_attempts` ולעולם לא עובר ל-`failed`. על `main` הוא היה מת אחרי 5 ניסיונות ומגיע ל-review; אחרי 104 הוא **חוזר לנצח** כל 137 שניות, והמפעיל רואה "מכסת קרדיטים" במקום "Beds24 דחה את המחיר". זו רגרסיה שה-PR מכניס, לא באג קיים.

**PROPOSED FIX.** להצר את התנאי ל-`if (creditPause && !failure && warnings.length === 0)`, ולהוסיף לשומר תרחיש DB-backed מפורש: 500/validation עם `remaining` מתחת לסף → `attempts` עלה ב-1, `last_error_code = 'server_error'/'validation'`, `conn.last_error` מלא.

---

#### 🔴 חמור 2 — 104 + 110 מזוג = typecheck שבור
`src/lib/channel/beds24-booking-reports.ts:152`.

**EVIDENCE.** 104 מחליף את `Beds24Response.creditsRemaining?: number` ב-`credits: Beds24CreditSnapshot`. 110 (שנכתב מול `main`) קורא `r.creditsRemaining`. מיזוג שמונה ה-PRs ב-worktree שלי:

```
src/lib/channel/beds24-booking-reports.ts(152,30):
  error TS2339: Property 'creditsRemaining' does not exist on type 'Beds24Response'.
 ELIFECYCLE  Command failed with exit code 2.
```

**FAILURE SCENARIO.** כל אחד מהשניים ירוק לבדו, ולכן CI לכל PR בנפרד לא יראה כלום. המיזוג השני שובר את `pnpm typecheck` ואת `pnpm build` על main — כלומר `deploy:prod` נחסם.

**PROPOSED FIX.** שורה אחת: `const creditsRemaining = r.credits?.remaining ?? null;`. אימתתי — אחרי התיקון `pnpm typecheck` ו-`pnpm build` עוברים נקי על העץ המזוג (build exit=0). מי שממזג שני ל-main חייב להחיל אותה.

---

#### 🔴 חמור 3 — 105 מקבע header שלא קיים; 104 מוחק אותו → השומר נופל
`scripts/check-beds24-ari-drain.mjs:82-83`, מול `src/lib/channel/beds24-http.ts`.

**EVIDENCE — מדידה חיה שלי** (קריאה-בלבד, `GET /v2/properties`, טוקן מטמון, 2026-07-25):

```
x-five-min-limit-remaining: 97.8
x-five-min-limit-resets-in: 86
x-request-cost: 1
...
get("X-RequestCost")                    = null
get("X-FiveMinCreditLimit-Remaining")   = null
get("x-fivemincreditlimit-remaining")   = null
```

הטענה של 104/106 **נכונה**. הטענה של 105 —
`assert.match(httpSrc, /"x-fivemincreditlimit-remaining"/, "the credit-window counter is read from the real header name")` —
נועלת שם שאינו על החוט, כלומר מקבעת את הבאג. על העץ המזוג:

```
expected: /"x-fivemincreditlimit-remaining"/   → AssertionError (טענה #1)
```
ואחרי שנטרלתי אותה, הטענה הבאה נופלת גם היא:
```
null !== 4900   ("X-FiveMinCreditLimit-Remaining is carried into the evidence context")
```
כי ה-mock של 105 מגיש את שמות ה-headers הישנים.

**FAILURE SCENARIO.** 104 ו-105 מוזגים בכל סדר → `check:beds24-ari-drain` אדום לתמיד. מי שמתקן אותו "כדי להחזיר לירוק" עלול להחזיר את השם המת ל-`beds24-http.ts` ובכך לבטל את 104.

**PROPOSED FIX.** לפני מיזוג: להחליף ב-105 את שמות ה-headers ב-mock (`x-five-min-limit-remaining` וכו'), להחליף את הטענה הסטטית ב-`assert.ok(!httpSrc.includes("fivemincreditlimit"))`, ולעדכן את `ev.context.creditsRemaining` בהתאם.

---

#### 🔴 חמור 4 — השומר של 104 ריק בדיוק בלולאה היקרה ביותר
`scripts/check-beds24-credit-backoff.mjs` — כל שלושת התרחישים ה-DB-backed הם **נכנסים בלבד** (`runBeds24InboundPull` × 2, `runBeds24BookingReconciliation` × 1).

**EVIDENCE.** מחקתי את `if (gate.pause) break` מ-`sendCalendarRequests` **ואת כל ענף ה-credit-pause** מ-`drainBeds24AriDirtyRanges` — ההרצה חזרה `all 11 assertions passed`.

**FAILURE SCENARIO.** ה-DECISIONS של 104 עצמו קובע שה-drain היוצא הוא הצרכן הגדול: `MAX_REQUESTS_PER_RUN = 120 × 1.2 = 144` קרדיטים = **144% מהחלון**. זה בדיוק החלק שאין עליו שומר. רגרסיה שם (או merge שמפיל את הענף בטעות — ראו §4) עוברת ירוקה.

**PROPOSED FIX.** להוסיף שני תרחישים DB-backed על `drainBeds24AriDirtyRanges` עם `fetchImpl` מוזרק: (א) `remaining` נמוך אחרי הבקשה הראשונה → `requests === 1`, `next_attempt_at` נדחף, `attempts` **לא** עלה, `circuit_open_until ≈ resets-in`; (ב) 429 → אותו דבר עם `Retry-After`.

---

#### 🟠 בינוני 5 — 106: ההתראה על overbooking היא חד-פעמית לכל חיי החיבור
`src/lib/channel/beds24-ari-readback.ts:311-327` (`alertOnce`).

**EVIDENCE.** `alertOnce` מדלגת כשקיימת שורה `resolved_at IS NULL` באותו `(connection, code)`. סרקתי את כל הריפו: **אין שום `UPDATE guesthub.channel_sync_errors`** בשום מקום ב-`src/`, `scripts/` או `db/`. `resolved_at` נכתב רק בפיקסצ'ר של `check-retention.mjs`. אין UI לפתירה.

**FAILURE SCENARIO.** מחזור ראשון מגלה oversell בלילה X → נרשמת שורה. המפעיל מריץ Full Sync ומתקן. השורה נשארת פתוחה לנצח. חודש אחר כך Beds24 מוכר לילה Y שתפוס — `alertOnce` רואה את השורה הישנה ו**לא מתריעה**. `/channels` מציג הודעה בת חודש עם ספירה מיושנת. האזעקה שהיא כל הפואנטה של D95 מושתקת אחרי ההפעלה הראשונה.

**PROPOSED FIX.** או (א) לסגור אוטומטית: כשמחזור מסתיים ללא drift — `UPDATE channel_sync_errors SET resolved_at = now() WHERE connection_id = $1 AND error_code IN ('ari_readback_oversell','ari_readback_drift') AND resolved_at IS NULL`; או (ב) upsert על השורה הפתוחה כדי לרענן את ה-context והספירה. עדיף שניהם. וגם: כפתור "טופל" ב-`/channels`.

---

#### 🟠 בינוני 6 — 104: 429 ב-poll הנכנס מקבל ניסיון-חוזר-עיוור ברמת הג'וב
`src/lib/channel/worker.ts:171` + `src/lib/channel/ranges.ts:48`.

**EVIDENCE.** 429 בעמוד הראשון של ה-poll → `res.ok === false`, `gate.pause` נקבע, `pushError`, `break`. אז `fetched === 0 && imported === 0 && inserted === 0`, ולכן:
`throw Object.assign(new Error(summary.errors[0]), { code: "network_error" })`.
`failChannelJob` מקבל `network_error` (לא `rate_limited`) ומחשב `backoffMs(1)` = `5000/2 + rand*2500` = **2.5–5 שניות**. ה-`retryAfterMs` ש-104 טרח להבטיח שלעולם לא יהיה `undefined` על 429 — פשוט לא מגיע לכאן.

**FAILURE SCENARIO.** Beds24 מחזיר 429 עם `resets-in: 137`. ה-worker חוזר אחרי ~4 שניות, סופג 429 נוסף, וכן הלאה עד `max_attempts` — בערך 5 קריאות מבוזבזות בתוך החלון שבו כבר אין קרדיטים. זה בדיוק "ניסיון חוזר עיוור" ש-D94 מצהיר שסולק.

**PROPOSED FIX.** להעביר את הסיבה: `throw Object.assign(new Error(...), { code: summary.creditPause ? "rate_limited" : "network_error", retryAfterMs: summary.creditPause?.waitMs })`, ולתת ל-`failChannelJob` להעדיף `retryAfterMs` על `backoffMs`.

---

#### 🟠 בינוני 7 — 110: אין שום מנגנון שמונע דיווח בלתי-הפיך פעמיים
`src/lib/channel/booking-com-reports-core.ts::submitBookingComReport` + `src/components/reservations/BookingComReports.tsx::buildActions`.

**EVIDENCE.** `stampReservation` משתמש ב-`COALESCE(...)` כדי לשמור את החותמת הראשונה — אבל שום שומר לא בודק את החותמת **לפני** השליחה. `buildActions` מחשב `reportedAt` ומציג אותו כ-chip, אבל `blocked` נגזר רק מ-cancelled + חלון + תנאי מוקדם — **לא** מ-`reportedAt`. `submittedRef` מגן רק בתוך מופע דיאלוג אחד; סגירה ופתיחה מחדש מאפסת אותו.

**FAILURE SCENARIO.** מפעיל לוחץ "דיווח No-Show", מקבל טוסט הצלחה, ואז — כי הכפתור עדיין פעיל — לוחץ שוב. שני `reportNoShow` יוצאים ל-Booking.com. אותו דבר ל-`reportCancel`: אפשר לשלוח בקשת ביטול שוב ושוב. ה-DECISIONS של 110 מדגיש "בלתי הפיך" חמש פעמים; זה בדיוק המקרה שמחייב שומר.

**PROPOSED FIX.** בשרת: אחרי guard 4, לדחות אם החותמת המתאימה כבר קיימת (או אם יש `booking_channel_reports` עם `status='success'` לאותה `(reservation, action)`), עם הודעה "כבר דווח ב-…". בלקוח: `blocked = reportedAt ? "דווח כבר ב-…" : ...`. השומר צריך טענה שמוכיחה ששני דיווחים ברצף מייצרים **קריאת רשת אחת**.

---

#### 🟠 בינוני 8 — 106: חלון ה-14 יום אינו נבדק על החוט
`scripts/check-beds24-ari-readback.mjs` (ה-mock ב-`globalThis.fetch`).

**EVIDENCE.** הרחבתי את הבקשה ל-500 יום (`endDate=${addDays(toInclusive, 486)}`) בלי לגעת בקבוע — `all 11 assertions passed`. ה-mock קורא `startDate`/`endDate` ומשתמש בהם, אבל לא מאמת אותם, ו-`expandBeds24Calendar` ממילא חותך לחלון המקומי, כך שהתוצאה זהה.

**FAILURE SCENARIO.** רגרסיה שמרחיבה את הבקשה מייצרת תשובות גדולות בהרבה, סביר שתחצה את `nextPageExists` ותיתקל בגבול 3 העמודים → `truncated: true` בכל מחזור, כלומר השוואה חלקית תמידית — והשומר שותק. גם החשבון "3 קרדיטים למחזור" מפסיק להיות נכון.

**PROPOSED FIX.** ב-mock: `must(startDate === TODAY && endDate === addDays(TODAY, 13), ...)` — ולהחזיר 400 אחרת, כמו שהוא כבר עושה ל-CSV של `roomId`.

---

#### 🟠 בינוני 9 — 104 + 106 מתנגשים סמנטית ב-`worker.ts`, ופתרון תמים מוחק מדידה
`src/lib/channel/worker.ts`, ענף `jobType === "reconcile_inventory"`.

**EVIDENCE.** git מסמן CONFLICT על הקטע. 104 מוסיף `await recordJobCredits(jobId, summary.credits, ...)` מיד אחרי `runBeds24BookingReconciliation`; 106 **כותב מחדש את כל הבלוק** (`let released`, `let reconcileError`, `if (inbound) {...}`) ולא כולל את הקריאה הזאת. פתרון "קח את הצד של 106" מתקמפל, עובר את שני השומרים — ומוחק בשקט את המדידה מסבב ה-reconcile, כלומר את מחצית מקור הנתונים של פאנל `/channels` שב-104.

**FAILURE SCENARIO.** הפאנל "מכסת קרדיטים · Beds24" מציג רק מדידות מה-poll. אם ה-poll נכשל או מושהה, הפאנל מציג נתון מיושן בלי שום סימן.

**PROPOSED FIX.** מיזוג ידני מפורש שמשלב את שניהם (עשיתי זאת ב-worktree שלי ואימתתי שהעץ המזוג מתקמפל ונבנה):
```ts
if (inbound) {
  const summary = await runBeds24BookingReconciliation(sql, inbound);
  await recordJobCredits(jobId, summary.credits, summary.creditPause?.reason ?? null);
  released = summary.released;
  if (summary.errors.length > 0 && summary.checked === 0) reconcileError = summary.errors[0];
}
```

---

#### 🟠 בינוני 10 — האריתמטיקה של D94: הרזרבה נגזרת מנפח עסקי של היום, לא מגבול הקוד
`src/lib/channel/beds24-credits.ts:1030-1052` (בלוק ה-derivation).

**EVIDENCE.**
1. **הרזרבה.** `reserve = poll(1) + reconcile(4) + 2 in-flight = 7 calls`. ה-4 הוא "מספר הזמנות ה-OTA הפתוחות היום". אבל `RECONCILE_LIMIT = 50` — ולכן הסבב הנכנס יכול לדרוש עד **60 קרדיטים**, פי חמישה מהסף כולו. הסף מגן על ~10 קריאות; מה ש"אסור להרעיב" יכול לדרוש 50.
2. **העלות דינמית באמת.** 104 מודד 1.2 (`GET /bookings` עם `includeGuests` + `includeInvoiceItems`); 106 מודד 1; אני מדדתי **1** ל-`GET /properties`. שלוש מדידות, שני ערכים. `BEDS24_MEASURED_CALL_COST = 1.2` הוא לא קבוע — הוא דגימה. הסף `12` בנוי עליו.
3. **השער תגובתי, לא תקציבי.** `gate.observe` קורא את המונה **אחרי** שהקריאה כבר עלתה. בין 12.0 ל-0 יש בדיוק קריאה אחת יקרה.
4. **השערים לא מדברים ביניהם.** כל ריצה יוצרת `createBeds24CreditGate()` משלה. drain, poll, reconcile ו-read-back הם ארבעה שערים נפרדים על **חשבון אחד**.

**FAILURE SCENARIO — התבנית שמפילה את הסף.** נכס עסוק: drain יוצא מתחיל על חלון מלא, שולח ~73 בקשות (88 קרדיטים) ונעצר בדיוק בסף. נשארו 12. ה-poll לוקח 1.2. נשארו 10.8. סבב ה-reconcile מגיע עם 30 הזמנות OTA פתוחות (לא 4): הקריאה הראשונה מורידה ל-9.6 → **מתחת לסף → הסבב נעצר אחרי הזמנה אחת**. רשת הביטחון של D93 בדיוק לא רצה. ובמחזור הבא — אותו דבר, כי ה-drain תמיד קם ראשון.

**PROPOSED FIX.** לגזור את הרזרבה מ**גבולות הקוד** ולא מנפח היום: `reserve = 1 (poll) + RECONCILE_LIMIT + 2`, או — פשוט וטוב יותר — לתת ל-drain היוצא סף **נפרד וגבוה בהרבה** (למשל 40% מהתקרה) ולעבודה הנכנסת סף נמוך, כך שהיוצא נסוג הרבה לפני שהנכנס מרגיש. בנוסף: לקצוב את ה-drain בקרדיטים מצטברים (`Σ cost`) ולא רק ב-`MAX_REQUESTS_PER_RUN`.

---

#### 🟡 קל 11 — 109 + 110: `manifest.txt` מתנגש, וההצלה התמימה מפרה סדר
`db/migrations/manifest.txt`.

**EVIDENCE.** שניהם מוסיפים שורה מיד אחרי `054_external_column_rename.sql` (109 → `056`, 110 → `055`). git: CONFLICT. איחוד תמים נותן:
```
054_external_column_rename.sql
056_source_system.sql
055_booking_com_channel_reports.sql
```
**FAILURE SCENARIO.** שתי המיגרציות עצמאיות, ולכן הרצה בסדר הזה עוברת (אימתתי ש-056 רץ פעמיים על testdb). אבל כל runner או check עתידי שמסתמך על סדר ה-manifest יקבל 056 לפני 055, ובן אדם שקורא את הקובץ יניח שהמספור הוא הסדר. **PROPOSED FIX:** לתקן ידנית ל-`055` ואז `056` בזמן המיזוג השני. עדיף: לתת ל-109 את `057`.

#### 🟡 קל 12 — 110: שעון הלקוח והשרת יכולים להתפצל
`src/components/reservations/BookingComReports.tsx` — `todayInTz(CHECK_IN_CHECK_OUT_TIMEZONE)`, מול `booking-com-reports-core.ts` — `todayInTimezone(now, res.timezone || "Asia/Jerusalem")`. ה-PR מצהיר "כפתור מושבת ודחיית שרת לא יסתרו"; לטננט שאינו באזור הזמן הקבוע של האפליקציה הם כן יסתרו. בנוסף הלקוח לוקח `detail.rooms[0].checkIn` בעוד השרת לוקח `reservations.check_in` — בהזמנה רב-חדרית עם תאריכי כניסה שונים אלה שני ערכים. **FIX:** להעביר את `tenants.timezone` ל-props ולהשתמש באותו שדה `check_in` בשני הצדדים.

#### 🟡 קל 13 — 108: "סגור" נכון אבל אין ממנו יציאה, והוא בולע מצבי משק בית
`src/lib/rooms/service.ts:259-266`. חדר במצב `closed` פותח את חלונית הסטטוס ו**אף אחת** משש האפשרויות אינה מסומנת כנוכחית; לחיצה על "פנוי" קוראת `updateRoomBoardStatusAction` שמשנה את `rooms.status` — והכרטיס נשאר "סגור", כי `stop_sell` גובר. אין רמז שהניקוי נעשה ב-`/rates`. בנוסף `closed` נמצא מעל `cleaning`/`dirty`, כך שחדר מלוכלך שסגור למכירה נעלם ממשק הבית. ויחידה מאוגדת (`sellable_unit_rooms` מרשה מספר חדרים ל-SU) צובעת את **כל** חדריה. ולבסוף — כותרת ה-PR אומרת "לפי תאריך", אך אין בורר תאריך בלוח: זה תמיד `today`. **FIX:** להוסיף לחלונית שורה מושבתת "סגור — נקבע ב-/rates" עם קישור, ולשקול להציג "סגור" כתג משני לצד מצב משק הבית.

#### 🟡 קל 14 — 103 סותר את 106 ברגע שהם מוזגים
`src/lib/channel/evidence.ts` — 103 כותב "ONE WRITER, ONE CALLING MODULE ... `beds24-ari-sync.ts` is its only caller". 106 מוסיף `recordAriEvidence` ב-`beds24-ari-readback.ts:972`. זו בדיוק סוג ההערה השקרית ש-103 בא לחסל. **FIX:** מי שממזג שני יעדכן את הפסקה ל-שני קוראים.

#### 🟡 קל 15 — 110: סדר השומרים בהערה אינו סדר השומרים בקוד
`src/lib/channel/booking-com-reports-core.ts` — ההערה מכריזה 1→2→3→4→5→6; הקוד מריץ 1, 2, 3, cancelled, **6**, **5**, **4**. ההבדל משמעותי: guard 6 (דיווח קודם) רץ לפני guard 5 (חלון), כך שבקשת ביטול ללא דיווח קודם מקבלת את ההודעה על התנאי המוקדם ולא על החלון — סביר, אבל ההערה משקרת. **FIX:** ליישר את ההערה לקוד.

---

### 4. הפרעה בין PRs — מה בדקתי בפועל

worktree: `/home/ubuntu/worktrees/audit9d-merge`, מ-`origin/main`, מיזוג רציף של כל שמונת ה-branches.

| שילוב | תוצאה אמיתית |
|-------|--------------|
| מיזוג רציף של כל השמונה | **103 ✓, 104 ✓, 105 CONFLICT (`package.json`), 106 CONFLICT (`DECISIONS.md`, `package.json`, `src/lib/channel/worker.ts`), 107 ✓, 108 ✓, 109 ✓, 110 CONFLICT (`DECISIONS.md`, `db/migrations/manifest.txt`, `package.json`)** |
| `package.json` / `DECISIONS.md` | התנגשויות טריוויאליות (כולם מוסיפים בסוף אותו בלוק). איחוד פשוט פותר. |
| `src/lib/channel/worker.ts` (104↔106) | **התנגשות סמנטית אמיתית** — ראו ממצא 9. פתרון תמים מוחק את `recordJobCredits`. |
| `db/migrations/manifest.txt` (109↔110) | התנגשות; איחוד תמים נותן 056 לפני 055 — ממצא 11. |
| **typecheck על העץ המזוג** | ❌ `beds24-booking-reports.ts(152,30): TS2339 Property 'creditsRemaining' does not exist` — ממצא 2. אחרי תיקון שורה אחת: ✅ נקי. |
| **build על העץ המזוג** | ✅ `build exit=0` (כולל `postbuild: tsc -p tsconfig.worker.json`). |
| `check:beds24-ari-drain` על העץ המזוג | ❌ נופל בטענה #1, ואחרי נטרולה נופל שוב על `null !== 4900` — ממצא 3. |
| `check:beds24-credit-backoff` על המזוג | ✅ 11/11 |
| `check:beds24-ari-readback` על המזוג | ✅ 11/11 |
| `check:beds24-quarantine-selfheal` על המזוג | ✅ 5/5 |
| `check:booking-com-reports` על המזוג | ✅ 18/18 |
| `check:reservation-source-system` על המזוג | ✅ 4/4 |

**ידועי-אדום מלפני הלילה — אף PR לא מחמיר אותם.** הריצו על `main` (`wt-night`, `5b171bd`) ועל העץ המזוג, פלט זהה:

| שומר | main | מזוג | הערה |
|------|------|------|------|
| `check:design` | 6 הפרות | **6 הפרות, אותן שורות בדיוק** ב-`src/app/housekeeping/my-tasks/MyTasksScreen.tsx` | 108 ו-110 מוסיפים UI חדש ולא מוסיפים ולו הפרה אחת. |
| `check:calendar-ui` | אדום | אדום, **אותה טענה** | 107 מאבחן, לא מתקן — לפי הצהרתו. |
| `check:channels-badge` | אדום | אדום, אותה טענה | — |
| `check:calendar` | אדום | אדום, אותה טענה | **הערה חשובה:** זו **אינה** שומר מיושן. `src/app/(dashboard)/reservations/actions.ts:37` באמת מייבא `beds24Request` (הגיע עם ה-escape hatch של D93). זו הפרת גבול חיה שאיש לא אבחן. 110 שומר על הגבול הזה ואינו מחמיר — הטענה שלו על כך אמיתית. |

---

### 5. מה לא הצלחתי לאמת, ולמה

1. **האם Beds24 באמת דוחה/מתעלמת מ-`waivedFees`.** דורש `POST /channels/booking` — כתיבה אמיתית ל-Booking.com, אסורה עליי מפורשות. מה שכן הוכחתי: השדה לא יכול להגיע לחוט מהקוד הזה. הטענה שהוא לא קיים בספק מבוססת על סריקת `apiV2.yaml` שהם עשו, שלא שחזרתי מקצה לקצה.
2. **`x-request-cost` של `POST /inventory/rooms/calendar` ושל `GET /bookings` עם `includeGuests`+`includeInvoiceItems`.** מדדתי רק `GET /properties` (עלות **1**). לא הרצתי GET נוסף כדי לא לבזבז קרדיטים על חשבון פרודקשן חי. לכן ה-1.2 של 104 לא אושר ולא הופרך — רק הוצג כלא-יציב.
3. **התנהגות Beds24 מעבר לעמוד אחד, ועם 14+ פרמטרי `roomId` חוזרים.** נבדקה רק מול ה-mock. אם מספר החדרים הממופים יגדל משמעותית, אורך ה-query string של 106 לא מוגבל בשום מקום — לא הצלחתי לקבוע איפה Beds24 חותכת.
4. **staging DB (:5434).** `STAGING_DATABASE_URL` קיים ב-`.env.staging` אך ההתחברות דרשה סיסמה שלא סופקה בסביבה; לא ניסיתי לעקוף. כל התרחישים ה-DB-backed רצו על testdb (:5433) כמתוכנן.
5. **מספרי התעבורה של D94** (287 ג'ובים/24h, חלון עמוס של 43 בקשות, p50=1/p95=3). לא הרצתי מחדש את שאילתות הפרודקשן שמאחוריהם — קיבלתי אותם כנתון וקטלתי את ה**גזירה** מהם, לא את המדידה.
6. **רינדור אמיתי של המסכים.** לא הרצתי את האפליקציה. הממצאים על 108 ו-110 בשכבת ה-UI נקראו מהמקור בלבד.
7. **`check:calendar-ui` / `check:channels-badge` אחרי התיקון המוצע ב-107.** ה-PR מצהיר שהריץ dry-run; לא שחזרתי — התיקון לא הוחל בשום מקום, כפי שה-PR מצהיר.

---

**ניקוי:** כל ה-worktrees שיצרתי (`audit9d-104/105/106/109/110/merge`) הוסרו ונגרסו. שום שינוי לא נדחף לשום branch. `/var/www/guesthub` נקרא בלבד. `/home/ubuntu/worktrees/wt-night` לא נגעתי.
