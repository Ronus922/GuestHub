# GuestHub PMS — PROJECT_OVERVIEW.md

Read this first.

מסמך זה הוא מקור האמת היחיד לבנייה מחדש של המערכת: מה היא עושה, הישויות, הלוגיקה העסקית, סדר הבנייה, וכללי העיצוב והטכניקה.

Do not start coding before understanding: project purpose, business flow, DB entities, permissions model, reservation logic, calendar behavior, phased build order.

---

# 1. מה הפרויקט עושה

מערכת PMS מרובת-דיירים (multi-tenant) לניהול מלון דירות / חדרים / יחידות אירוח.

מנהלת: חדרים ויחידות, אזורים, סוגי חדרים, אורחים, הזמנות, זמינות, יומן חדרים, מחירים יומיים, תשלומים, משתמשים והרשאות, סטטוסים, ניקיון, דשבורד, דוחות בסיסיים, והכנה לאינטגרציות עתידיות.

המערכת עסקית ואמיתית — לא דמו, לא mock, לא UI בלבד. RTL-first, עברית, דסקטופ + מובייל.

# 2. קהל יעד

בעלים/מנהל עסק, מנהל נכס, פקיד קבלה, צוות תפעול, צוות ניקיון, אדמין. כל משתמש רואה ופועל לפי הרשאותיו בלבד. אין להסתמך על הסתרת כפתורים בלקוח — כל פעולה עסקית עוברת בדיקת הרשאה בשרת.

# 3. סטאק טכני

| שכבה | בחירה |
|------|--------|
| Framework | Next.js (App Router, RSC + Server Actions) |
| שפה | TypeScript strict |
| עיצוב | Tailwind v4 — טוקנים ב-`@theme inline` בתוך `app/styles/base.css`. **אין** tailwind.config |
| Design System | Azure Ethos — primary `#1e40af`, active light `#eff6ff`, track/hover `#f4f2fc`, border `#dad9e3` |
| State לקוח | Zustand · טפסים: react-hook-form + Zod (סכמות משותפות) · URL state: nuqs |
| טבלאות | @tanstack/react-table · DnD: @dnd-kit · אנימציה: framer-motion · Toast: sonner |
| אייקונים | lucide-react דרך mapper יחיד `components/shared/Icon.tsx` · פונט: Noto Sans Hebrew בלבד |
| Auth | Supabase Auth (self-hosted) — אימות בלבד. DB = PostgreSQL דרך porsager `postgres` (`lib/db.ts`) |
| Deploy | `pnpm build` חובה בסוף כל שלב; production רץ `next start` תחת PM2 |

# 4. כללי ברזל (חלים על הכל)

1. **tenant isolation** — כל Query/Server Action עם scope לפי `actor.tenantId` מהשרת. אין hardcoded tenantId.
2. **השרת הוא הסמכות** — `requirePermission(actor, "module.action")` בתחילת כל Server Action. בדיקות UI קוסמטיות בלבד.
3. **אין מודאלים ממורכזים** — טפסים/פרטים/אשפים = `SidePanel` (נגלש משמאל ב-RTL, 55% דסקטופ / 100% מובייל).
4. **סטטוס = `border-r-4`** בצבע הסטטוס. לא נקודות/badges.
5. **ערכי lookup** ב-`lookup_items`, נצרכים דרך `useLookup(category)`. אין enums קשיחים ב-UI.
6. **RTL מקורי** — logical properties. אין codemod היפוך.
7. Touch target מינימלי 44×44px.
8. Server Actions מחזירות `{ success, error }`. שגיאה → toast.
9. אין mock data במסכים עסקיים. אין שינוי לוגיקה עסקית בשביל עיצוב.

# 5. ישויות

```text
tenant
 ├── users
 ├── roles / permissions / role_permissions
 ├── areas
 ├── room_types ── base_price
 ├── rooms
 ├── rates
 ├── guests
 ├── reservations
 │    ├── reservation_rooms
 │    ├── payments
 │    └── status → lookup_items
 ├── lookup_items
 ├── housekeeping_tasks
 └── audit_logs
```

# 6. סכימת בסיס נתונים

מיגרציה **אחת** בשלב 1 יוצרת את כל הטבלאות + seed. אין מיגרציות מתקנות באמצע. אסור קוד שתלוי בעמודות שלא קיימות.

## 6.1 tenants
id, name, slug, timezone, currency, created_at, updated_at

## 6.2 users
id, tenant_id, auth_user_id, username, full_name, email, phone, role_id, allow_google_auth, is_active, created_at, updated_at

## 6.3 roles
id, tenant_id, name, key, description, is_system, created_at, updated_at

תפקידי מערכת (seed): `super_admin`, `admin`, `manager`, `receptionist`, `staff`, `cleaner`.
cleaner מנותב אוטומטית ל-`/housekeeping/my-tasks` (מסך מובייל בלי sidebar/topbar).

## 6.4 permissions
id, key, description, category, created_at, updated_at
(מפתחות בסגנון `reservations.create`, `rooms.edit`, `calendar.view`…)

## 6.5 role_permissions
id, role_id, permission_id, created_at

## 6.6 areas
id, tenant_id, name, description, sort_order, is_active, created_at, updated_at

## 6.7 room_types
id, tenant_id, name, description, base_price, max_occupancy, max_adults, max_children, max_infants, single_beds, double_beds, queen_beds, sofa_beds, cribs, is_active, created_at, updated_at

## 6.8 rooms
id, tenant_id, area_id, room_type_id, room_number, floor, name, status, is_active, max_occupancy, max_adults, max_children, max_infants, single_beds, double_beds, queen_beds, sofa_beds, cribs, notes, created_at, updated_at

סטטוסי חדר: `available`, `inactive`, `out_of_order`, `maintenance`. חדר לא פעיל / תקול / בתחזוקה אינו זמין למכירה.

## 6.9 guests
id, tenant_id, first_name, last_name, full_name, phone, email, id_number, country, city, address, company, language, is_vip, is_blocked, notes, created_at, updated_at

## 6.10 lookup_items
id, tenant_id, category, key, label, color, icon, sort_order, is_active, metadata, created_at, updated_at

קטגוריות seed: `reservation_statuses`, `payment_statuses`, `payment_methods`, `booking_sources`, `room_statuses`, `guest_types`, `currencies`, `languages`, `cancellation_policies`.

## 6.11 reservations
id, tenant_id, reservation_number (רץ פר-tenant), primary_guest_id, source_id, status, check_in, check_out, check_in_time (ברירת מחדל 15:00), check_out_time (11:00), adults, children, infants, accessible, early_check_in, late_check_out, special_requests, discount_amount, discount_percent, extra_charges, tax_exempt, deposit, total_price, paid_amount, balance, currency, is_vip, notes, internal_notes, created_by, created_at, updated_at

## 6.12 reservation_rooms (הזמנה מרובת חדרים)
id, tenant_id, reservation_id, room_id, check_in, check_out, adults, children, infants, rate_per_night, price_total, created_at, updated_at

## 6.13 rates
id, tenant_id, room_id, room_type_id, date, price, min_nights, max_nights, closed, closed_to_arrival, closed_to_departure, created_at, updated_at

כלל: rate יכול להיות לפי חדר ספציפי או לפי סוג חדר; חדר גובר על סוג; אם אין rate — `base_price` של room_type.

## 6.14 payments
id, tenant_id, reservation_id, amount, method, status, paid_at, reference, notes, created_at, updated_at

## 6.15 housekeeping_tasks
id, tenant_id, room_id, reservation_id, checkout_time, status, assigned_to, priority, notes, created_at, completed_at, updated_at

## 6.16 audit_logs
id, tenant_id, user_id, entity_type, entity_id, action, before_data, after_data, created_at

## 6.17 bulk_rate_update_logs / bulk_rate_update_items
לוג לעדכוני מחירים קבוצתיים (מי, מתי, טווח, ערכים) + שורות פירוט.

# 7. חלון הזמנה (Booking Window)

SidePanel מרכזי, 4 שלבים. נבנה לפי הרפרנסים ב-`docs/design/screens/booking-window-step-*.png`.

**שלב 1 — שהות וחדרים:** תאריכי כניסה/יציאה + שעות, מספר לילות (מחושב), בחירת חדר(ים) — רק פנויים בטווח, בחירת סוג חדר, תצוגת מחיר בסיסית, הודעת שגיאה כשאין זמינות.

**שלב 2 — אורחים:** מבוגרים/ילדים/תינוקות + **בדיקת קיבולת חדר (אין חריגה)**, חיפוש אורח קיים / יצירה: שם פרטי, משפחה, טלפון, אימייל, ת"ז/דרכון, מדינה, שפה, VIP, הערות.

**שלב 3 — מחיר ותשלום:** פירוט מחיר לפי לילות, הנחה (סכום/אחוז), חיובים נוספים, מע"מ (אלא אם tax_exempt), סה"כ, שולם, יתרה, אמצעי תשלום, סטטוס תשלום, פרטי תשלום לפי צורך. תשלומים נרשמים בטבלת `payments`.

**שלב 4 — סיכום ואישור:** סיכום מלא (אורח, חדרים, תאריכים, לילות, מחיר, תשלום, יתרה, סטטוס) + יצירה/שמירה + ביטול.

**כללי חובה:** כל בדיקת זמינות בשרת · אין הזמנה בלי חדר פנוי · אין חריגה מקיבולת · אין checkout לפני checkin · עריכת הזמנה קיימת **לא חוסמת את עצמה** בבדיקת הזמינות · כל שינוי עובר Zod validation.

# 8. בדיקת זמינות

חדר פנוי בטווח ⇔ אין הזמנה חופפת באותו חדר:

```sql
existing.check_in < requested.check_out
AND existing.check_out > requested.check_in
```

סטטוסים שלא חוסמים: `cancelled`, `draft`. חוסמים: `confirmed`, `checked_in`, `blocked`.

רצה בשרת ב-3 מקומות לפחות: יצירת הזמנה · שינוי חדר (גרירה) · שינוי תאריכים (הארכה/קיצור).

# 9. מחיר הזמנה

לכל לילה: rate לחדר ספציפי → אם אין, rate לסוג החדר → אם אין, `base_price`.
עדכון מחירים קבוצתי כותב ל-`rates` בלבד — לא נוגע בהזמנות קיימות.

# 10. יומן חדרים

Grid: שורות = חדרים (מקובצים לפי אזור), עמודות = תאריכים, פסים = הזמנות. תצוגות שבוע / שבועיים / חודש + ניווט + "היום".

## 10.1 אינטראקציות

| פעולה | התנהגות |
|--------|----------|
| לחיצה על פס | SidePanel צפייה/עריכה |
| Hover | tooltip read-only בלי קריאת שרת: אורח, חדר, תאריכים, לילות, סטטוס, מחיר, שולם, יתרה |
| גרירה חדר→חדר | preview → בשחרור בדיקת זמינות בשרת → פנוי: עדכון DB · תפוס: הפס חוזר + toast |
| הארכה/קיצור מקצה | **delta-only**: הפס המקורי לא נמתח בזמן גרירה; רק שכבת overlay של הדלתא; commit ל-DB רק בשחרור |
| תא ריק (לחיצה/גרירה) | פותח חלון הזמנה עם חדר + תאריכים ממולאים |

## 10.2 שורת KPI (מימין לשמאל) — הכל מה-DB, אין mock

| כרטיס | הגדרה |
|--------|--------|
| הגעות היום | `check_in = today AND status != cancelled` |
| יציאות היום | `check_out = today AND status != cancelled` |
| אורחים בבית | Σ אורחים כאשר `check_in <= today AND check_out > today AND status IN (confirmed, checked_in)` |
| תפוסה היום | חדרים תפוסים היום ÷ חדרים זמינים למכירה |
| תפוסה החודש | occupied room-nights ÷ sellable room-nights בחודש הנוכחי |

## 10.3 כללי עיצוב ליומן

אסור: טבלת Excel מעוך · דחיסת 21/30 ימים לעמודות לא קריאות · חיתוך תאריכים בכותרת · overflow שחותך תוכן · `transform: scale` · הקרבת קריאוּת בשביל "אין גלילה".
מותר: גלילה פנימית מוכלת בלוח · range מותאם לרוחב מסך · תצוגה קומפקטית אך קריאה · truncation לטקסטים משניים בלבד.

Priority: ‎1. התאמה לרפרנס → 2. לוח שמיש וקריא → 3. מניעת overflow של כל הדף → 4. הימנעות מגלילה אופקית → 5. אם מניעת גלילה מכערת — contained board scroll.

# 11. עדכון מחירים קבוצתי

בחירת טווח תאריכים + חדרים/סוגי חדרים → קביעת מחיר, min/max nights, closed, CTA, CTD → כתיבה ל-`rates` + רישום ב-`bulk_rate_update_logs/items`.

# 12. ניקיון / Housekeeping

- לאחר checkout החדר "מלוכלך" עד סימון ידני כנקי; ביום checkout נוצרת משימת ניקיון אוטומטית.
- מנהל: Kanban מלא (ממתין לשיבוץ / בתהליך / הושלם) + שיוך לעובדים.
- cleaner: רואה רק את המשימות שלו במסך מובייל `/housekeeping/my-tasks`.

# 13. Dashboard

כרטיסים: תפוסה היום, הגעות היום, יציאות היום, אורחים בבית, הכנסות חודשיות, הזמנות פתוחות, חדרים לא נקיים, חדרים בתחזוקה.
רשימות: הגעות היום, יציאות היום, משימות ניקיון, הזמנות אחרונות. הכל מה-DB.

# 14. הגדרות

ניהול `lookup_items` לפי קטגוריות (סעיף 6.10) — LookupTable גנרית: הוספה, עריכה, צבע, אייקון, סדר, הפעלה/השבתה + הגדרות tenant בסיסיות. הטבלה + seed קיימים משלב 1; כאן נבנה רק ה-UI.

# 15. אינטגרציות עתידיות

לא בונים עכשיו — רק שומרים מבנה נקי: Channel Manager / Channex, WhatsApp, SMS, Email templates, Booking engine, ייצוא הנה"ח, ספק סליקה, OTA.

# 16. עקרונות UX/UI

RTL-first, עברית. נקי ויוקרתי, לא צבעוני מדי, לא Excel. spacing נכון, hierarchy ברור, קצוות מעוגלים, צללים עדינים. מובייל + דסקטופ. לכל מסך: loading / empty / error / hover / focus / active states. טוקנים עקביים.

תבניות Azure Ethos:
- KPI card: `bg-white border border-[#dad9e3] rounded-xl p-6 min-h-[140px]`, אייקון 48px עם רקע accent.
- Tabs (Variation 3): track `bg-[#f4f2fc] p-1 rounded-xl`; פעיל `bg-white text-[#1e40af] shadow-sm font-semibold rounded-lg`.
- כפתורים: `.btn .btn-primary` (שטוח `#1e40af`), `.btn-outline`, `.btn-filter`.
- SidePanel: כותרת `#1e40af`, slide-in משמאל.

# 17. מקורות עיצוב

```text
docs/design/screens/     ← צילומי מסך PNG — מקור האמת הוויזואלי הראשי
docs/design/html/        ← קבצי HTML — מקור עזר, רק אם מרונדרים בפועל
docs/proof/              ← צילומי proof של התוצאה בסוף כל מסך
```

## 17.1 כלל שימוש

עדיפות: ‎1. Screenshot מרונדר → 2. HTML מרונדר → 3. HTML לא-מרונדר / bundle — לא מספיק → 4. MD — לא מספיק.

אם HTML הוא bundle (למשל Claude Design): להריץ בדפדפן, להמתין לטעינה מלאה (מעבר ל-`Unpacking...`), לצלם reference, ולבנות לפי הצילום. **אסור לבנות לפי thumbnail / loading shell / placeholder. אסור להמציא עיצוב בלי reference ברור.**

# 18. עקרונות טכניים

TypeScript strict · Server Actions · Supabase Auth · tenant isolation · הרשאות בשרת · RTL-first · mobile-first · אין mock במסכים עסקיים · אין hardcoded tenantId · אין שינוי לוגיקה בשביל עיצוב · אין בניית 8 מסכים במכה · כל שלב עובר build לפני שממשיכים · אין דיווח "done" בלי בדיקות וצילום proof.

# 19. סדר בנייה מחייב

```text
שלב 1  — DB מלא + Auth + Shell
שלב 2  — משתמשים והרשאות
שלב 3  — חדרים ואזורים
שלב 4  — הזמנות בטבלה + חלון הזמנה
שלב 5  — יומן חדרים
שלב 6  — עדכון מחירים קבוצתי
שלב 7  — הגדרות
שלב 8  — Housekeeping
שלב 9  — Dashboard
שלב 10 — אינטגרציות עתידיות
```

- **שלב 1:** כל הסכימה (16+ טבלאות) + seed, Supabase Auth, middleware/session, actor context, Shell (Sidebar + TopBar ריקים יחסית). אין מסכים עסקיים.
- **שלב 2:** מסך משתמשים, ניהול תפקידים, מטריצת הרשאות, `requirePermission` על כל Action.
- **שלב 3:** CRUD אזורים / סוגי חדרים / חדרים, סטטוס, קיבולת, base_price. אין מחיקת סוג/אזור עם חדרים; אין מחיקת חדר עם הזמנות עתידיות.
- **שלב 4:** טבלת הזמנות + פילטרים, חלון הזמנה 4 שלבים, זמינות, מחיר, תשלומים, ביטול לפי הרשאות.
- **שלב 5:** יומן מלא (סעיף 10) — כולל KPI מה-DB.
- **שלב 6:** מסך מחירים קבוצתי (סעיף 11).
- **שלב 7:** מסך הגדרות (סעיף 14).
- **שלב 8:** Housekeeping (סעיף 12).
- **שלב 9:** Dashboard (סעיף 13).
- **שלב 10:** הכנת מבנה לאינטגרציות בלבד.

# 20. נתוני Demo Seed (שלב 1)

tenant אחד · 4 משתמשים (אחד לכל תפקיד מרכזי) · roles + permissions מלאים · 2 אזורים · 3 סוגי חדרים · 12–15 חדרים (כולל אחד בתחזוקה ואחד לא פעיל) · 20 אורחים (כולל VIP וחסום) · 30–40 הזמנות סביב החודש הנוכחי ±חודש — **כולל חפיפות** ובכל הסטטוסים (confirmed / checked_in / checked_out / cancelled) · rates חלקיים (חלק מהתאריכים בלי rate — לבדיקת fallback) · תשלומים חלקיים עם יתרות · lookup_items מלאים.

היומן והזמינות נבדקים על דאטה אמיתי מהרגע הראשון.

# 21. בדיקות בסוף כל שלב

```bash
tsc --noEmit && pnpm lint && pnpm build
```

חובה לוודא: אין שגיאות TS/lint · build עובר · המסך נטען בפועל · אין console errors · אין שגיאות hydration · אין mock · הרשאות עובדות · tenant isolation עובד · צילום proof נשמר ב-`docs/proof/`.

# 22. Definition of Done

מסך גמור רק אם: ‎1. מחובר ל-DB אמיתי ‎2. tenantId אמיתי ‎3. בודק הרשאות ‎4. נראה לפי reference ‎5. עובד בדסקטופ ‎6. עובד במובייל ‎7. loading state ‎8. empty state ‎9. error state ‎10. אין console errors ‎11. אין TS errors ‎12. build עובר ‎13. צילום proof ב-`docs/proof/` ‎14. אין mock ‎15. אין שינוי לוגיקה בשביל עיצוב.

# 23. אסור

להמציא דאטה או עיצוב · לבנות לפי thumbnail/loading shell · לשנות לוגיקה בשביל CSS · overflow שחותך תוכן · `transform: scale` לפתרון layout · טבלת Excel מעוך · לדווח done בלי proof · לבנות הכל במכה בלי checkpoints · hardcoded tenantId · mock במסכים עסקיים · לדלג על הרשאות שרת · קוד שתלוי בעמודות שלא קיימות · refactor לא קשור · לשבור flows בשביל עיצוב · `git add -A` (קומיטים מבודדים בלבד).
