# GuestHub PMS — מסמך מרוכז

> נכון ל-17/09/2026. מרכז את הזיכרון, קבצי הפרויקט והשיחות האחרונות.
> פריטים שמסומנים **⚠ לאמת** מבוססים על מידע ישן או סותר. יש לבדוק מול הריפו לפני שמסתמכים עליהם.
> מקורות האמת המחייבים נשארים בריפו: `DECISIONS.md`, `CLAUDE.md`, `AGENTS.md`, `STATE.md`, `DESIGN_SYSTEM.md`, `GUIDELINES.md`.

---

## 1. זהות הפרויקט

| | |
|---|---|
| מה | PMS מרובה-דיירים (multi-tenant), עברית/RTL, לניהול מלון דירות |
| לקוח ראשון | Sea Tower (מגדל הים), חיפה — כ-13 יחידות |
| בעלים | רונן (r@bios.co.il) — מאשר כל merge וכל deploy |
| משתמשת פעילה נוספת | אפרת מקס (efratmax76@gmail.com), super_admin |
| כתובת חיה | `https://guesthub.bios.co.il` |
| דומיין עתידי | `stayme.co.il` (החלפה מלאה — ראו §9) |
| ריפו | `github.com/Ronus922/GuestHub` |
| נתיב בשרת | `/var/www/guesthub` (ה-runtime החי) |
| סוכן ביצוע | Fable (Claude Code), skills ב-`~/.claude/skills/` |

**אסור לגעת:**
- `/var/www/pms` — נטוש. לעולם לא לגעת.
- Channex — הוסר לגמרי (D91). אסור שיופיע בקוד חדש.
- Stripe — הוסר.
- `/var/www/guesthub-production` — הוסר. **⚠ לאמת:** `CLAUDE.md` ו-`docs/PRODUCTION_RUNTIME.md` עדיין מזכירים אותו.

---

## 2. ארכיטקטורה

### 2.1 סטאק

| שכבה | בפועל |
|---|---|
| Framework | Next.js 15.5 (App Router, RSC + Server Actions) · React 19 |
| שפה | TypeScript strict · Node 20 · pnpm 10 |
| UI | Tailwind v4 (`@theme` ב-`src/app/styles/`, אין `tailwind.config`) · lucide-react דרך mapper יחיד · framer-motion · sonner |
| טפסים / state | react-hook-form + Zod · nuqs · @tanstack/react-table |
| DB | PostgreSQL, סכימת `guesthub`, דרך porsager `postgres` (`src/lib/db.ts`) |
| Auth | Supabase Auth (GoTrue) self-hosted — **אימות בלבד**, לא DB |
| Runtime | PM2 (`ecosystem.config.cjs`): `guesthub` (`next start`) + `guesthub-channel-worker` · פורט 3007 · nginx · Ubuntu VPS |
| גיבוי | Backblaze B2, מוצפן ב-age דרך rclone · restore drill שבועי ב-systemd · מפתח פרטי ב-`~/.guesthub-backup-age.key` |
| ניטור | GlitchTip/Sentry webhook |
| CI | GitHub Actions + חבילת guards (`run-checks.mjs`) |

### 2.2 מבנה תיקיות

```text
src/
  app/
    (dashboard)/   calendar · channels · communications · dashboard · guests ·
                   housekeeping (קפוא) · maintenance · permissions · rate-plans ·
                   rates · reservations · rooms · settings · staff
    api/           Route Handlers (כולל /api/public — הזמנות ציבוריות)
    styles/        globals.css = @imports בלבד; design-system.css קנוני
  components/      reservations/ · calendar/ · shared/ · layout/ · ui/
  lib/             pricing/ · rates/ · channel/ (beds24-*) · payments/ ·
                   public-booking/ · validation/ · db.ts · vat.ts · card-vault.ts
db/migrations/     קבצים ממוספרים + manifest.txt
scripts/           deploy-production.sh · apply-pending-migrations.mjs · check-*.mjs
docs/              architecture/ · audit/ · database/ · payments/ · security/ · proof/
```

### 2.3 מודל מסחרי ותמחור

- **יחידת מלאי מול ערוץ = חדר פיזי** (D64/D68). מיפויים ב-`channel_room_mappings`, dirty ranges לפי `room_id`.
- **Sellable Units (SU)** — יחידת מכירה עם חדרים חברים (`sellable_unit_rooms`) ותוכנית בסיס.
- **`pricing_plan_rates`** — המאגר היחיד שניתן לכתוב אליו מצב מסחרי: `price`, `min_stay_through`, `min_stay_arrival`, `max_stay`, `closed_to_arrival`, `closed_to_departure`, `stop_sell`. שורה אחת לכל plan/date.
- **`effective_sell_state()`** — פונקציית SQL שמחזירה מחיר + זמינות + sellable לכל SU/יום. צירי המחיר והזמינות עצמאיים.
- **מנוע תמחור אחד** (D42/D51): `calculateReservationPrice` ב-`src/lib/pricing/engine.ts`. שלושה קוראים בלבד:
  - `priceReservationStays` — שמירת הזמנה (יצירה/עריכה/הזזה/הזמנה ציבורית), כותב `pricing_snapshot`
  - `getStayQuoteAction` — ציטוט חי
  - `simulateQuoteAction` — סימולטור
- דחיפת ARI ל-Beds24 חולקת את `resolveChainNightPrice` — מה שנמכר ומה שמתפרסם נגזרים מאותה פונקציה.
- **תמחור לפי לילה, לא לפי יום** (20→21 = לילה אחד, כמו Booking.com).
- מע"מ כלול במחירים שנשלחים ל-Booking.com (**⚠ החלטה פתוחה** אם לשנות).
- Weekly/Monthly של Booking.com מנוהלים באקסטרנט של Booking — מחוץ לסקופ.

### 2.4 אינטגרציות

| ספק | תפקיד | מצב |
|---|---|---|
| Beds24 API V2 (property 342449) | מנהל ערוצים יחיד — inbound ב-poll, ARI outbound דרך ה-worker | פעיל. Booking.com ו-Expedia פעילים |
| GREEN-API | WhatsApp יוצא (D53); webhook מטפל רק בסטטוסים | **⚠ לאמת:** המנוי פג ב-02/09 — שליחה לא פעילה עד חידוש |
| PayPlus | תשלומים — hosted payment page בלבד, בלי CVV, PCI SAQ-A (D108) | פעיל |
| TTLock (`euapi.ttlock.com`) | מנעולים חכמים | פעיל עם quota circuit breaker; 3 מנעולים בלי gateway: 1042, 1102, 1424 |
| Google Maps | מסך פרופיל עסק (D175) | מפתח ה-API חוסם localhost — אימות רק על הדומיין החי |

### 2.5 משתני סביבה (שמות בלבד)

`DATABASE_URL`, `SUPABASE_*`, `CARD_VAULT_KEY`, `CHANNEL_SECRETS_KEY`, `MESSAGING_SECRETS_ENCRYPTION_KEY`, `GOOGLE_MAPS`, `NEXT_PUBLIC_APP_URL`, `APP_PORT`

---

## 3. מערכת עיצוב (תקציר)

- פונט יחיד: **Assistant**. RTL. מספרים, תאריכים, כסף, טלפון — תמיד LTR (`.ltr-num`).
- JetBrains Mono לא נטען.
- **צבעים:** brand `#2540C8` · brand-hover `#1C2E9A` · ink `#1B2233` · muted `#6B7385` · faint `#9AA1B4` · line `#E7EAF1` · bg `#F1F3F8` · field `#F7F8FB` · ok `#16A34A` · danger `#E5484D` · warn `#EA9314` · info `#8B5CF6` · vip `#F5B04C`
- **סקאלת פונט סגורה:** 12 · 13.5 · 14 · 15 · 17 · 19 · 21 · 32px
- **Radius:** 16 (card/panel) · 12 · 8 · 7
- **Shadows:** שניים בלבד — card ו-float
- **Padding מינימלי:** Button `px-4 py-2` · Card `p-4` · Input `px-3 py-2` · Badge `px-2 py-0.5` · Table cell `px-4 py-3` · Modal `p-6`
- Touch target ≥ 44×44
- אייקונים דרך `src/components/shared/Icon.tsx` בלבד
- כל primitive (button/field/chip/card) קנוני ב-`design-system.css`; מסכים לא מגדירים אותו מחדש.
- **חוק flex-card-shrink:** `.card` בתוך `flex-column` גולל חייב `flex: none` או `min-height: 0`. נאכף ע"י `check:flex-card-shrink`.
- **⚠ לאמת:** יש אי-התאמה בין ערכי `DESIGN_SYSTEM.md` (radius 9–20, פונט 30/20.5) לבין `design-system.css`/`GUIDELINES.md`. הקוד הקנוני הוא `design-system.css`.

---

## 4. תהליך עבודה

### 4.1 מחזור משימה

1. Claude כותב פרומפט מדויק
2. רונן מדביק ל-Fable
3. Fable מבצע ומחזיר דוח
4. רונן מדביק את הדוח לכאן
5. Claude מנתח וממליץ על הצעד הבא

- משימה אחת בכל פעם. אחרי כל משימה מחכים לתוצאה.
- כשיש כמה פריטים פתוחים קטנים — עדיף פרומפט batch מרכזי אחד עם דוח מאוחד בסוף.
- החלטות: שאלה אחת בכל פעם, עם המלצה מסומנת.
- פרומפטים נמסרים בתיבת העתקה, מלאים, בלי צורך בעריכה.
- תשובות בעברית; קוד, קבצים ופקודות באנגלית.
- קבצים מצורפים הגיעו ריקים שוב ושוב — להדביק תוכן ישירות.
- הפרויקט הזה הוא GuestHub בלבד. חומר מפרויקט אחר (almog וכו') — להצביע על כך ולא לענות.

### 4.2 מבנה פרומפט ל-Fable

```text
ENTRY GATE      git status נקי, ענף ו-SHA מאומתים
PART 0          אודיט read-only
PART 1..N       ביצוע סדרתי
HARD STOP       תנאי עצירה מפורשים
REPORT          דוח יחיד בסוף הריצה
```

### 4.3 PR → Merge → Deploy

```bash
# merge (רונן, מהשרת)
gh pr merge N --merge

# אם GraphQL נכשל עם request ID — בעיה בצד GitHub:
gh pr view N --json mergeable,mergeStateStatus,statusCheckRollup
gh api -X PUT repos/Ronus922/GuestHub/pulls/N/merge -f merge_method=merge

# deploy (רונן בלבד, מתוך /var/www/guesthub)
PROD_DEPLOY_OK=1 bash scripts/deploy-production.sh
```

- הסקריפט fail-closed: מסרב לענף שאינו main, לעץ מלוכלך, ולקומיט שלא reachable מ-`origin/main`.
- מיגרציות רצות ב-deploy דרך `apply-pending-migrations.mjs`.
- מאז D185 הסקריפט מתקין תלויות כש-lockfile משתנה; מאז D191 בסיס ה-diff נשמר בקובץ state (חסין ל-git pull ידני).
- PR תיעוד בלבד (`DECISIONS.md` בלי קוד) — לא דורש deploy.
- **⚠ לאמת:** בזיכרון מופיע גם `npm run deploy:prod`. הפקודה שאומתה לאחרונה היא `bash scripts/deploy-production.sh`.

---

## 5. כללי ברזל

1. **רונן ממזג כל PR ומאשר כל deploy.** Fable לא ממזג ולא פורס בעצמו.
2. **Rule 12:** הסוכן לא מחליף החלטת בעלים בחלופה בשקט — עוצר, מתעד, מחכה.
3. **כתיבה ל-DB בפרודקשן:** בפרומפט נפרד משלה, עם assertion מפורש על rowcount בתוך הטרנזקציה, ואחרי אודיט read-only.
4. **`git add -A` אסור** — stage רק לקבצים שנמנו במפורש.
5. **אסור ב-`/var/www/guesthub`:** `next dev`, `pnpm build`, `pm2 restart` חשוף. רק סקריפט ה-deploy.
6. **בלי git worktrees** אלא אם רונן ביקש במפורש בהודעה הנוכחית. **⚠ לאמת:** `PROJECT_OVERVIEW.md` (יולי) אומר "עבודה ב-worktrees בלבד" — הכלל העדכני הוא ללא worktrees.
7. **אימות לפני deploy:** `tsc --noEmit` + lint + הוכחת code-trace.
8. **Rollback קנוני = revert commit על main + deploy.** `git reset --hard` לא תקף (D180).
9. **אימות CDP ב-390×844 לפני merge** לכל layout שנוגע בפאנל או flex container.
10. **כל guard חדש חייב הוכחת B2 אדברסרית:** נטרול סמנטי של הפרדיקט המרכזי תוך שמירת המבנה חייב להחזיר exit 1.
11. **אין לעקוף guard** עם הערת opt-out או allowlist. מתקנים את ה-classifier, לא עוקפים.
12. כל החלטה או סטייה נרשמת ב-`DECISIONS.md` כ-D ממוספר.

---

## 6. לקחים שנלמדו בדרך הקשה

- **אודיט לפני תכנון, תמיד.** הנחות שגויות על types/actions/migrations בזבזו כמה מחזורים.
- **כלי מדידה שיקרו שוב ושוב** (ענף שגוי, טבלה שגויה, תהליך שגוי). כשמספר לא מסתדר — הכלי טועה קודם.
- **Job שדיווח succeeded עם `sentValues: 0` הוא כישלון.**
- **Guards מבוססי grep שבירים.** refactor לגיטימי יוצר false positive (סיווג B). הפתרון: הרצה התנהגותית.
- **`alertOnce` בדיכוי קבוע** קבר התראות שבועות. הוחלף ב-`occurrence_count` + `last_seen_at` + auto-closer.
- **הזמנה ב-Beds24 גוברת על דחיפת מלאי.** `numAvail=1` נבלע בשקט כשיש שם הזמנה. העברת חדר דורשת הזזה ידנית ב-Beds24 עד שיבנה P3-1.
- **טווח תאריכים:** inclusive מול exclusive גרם לעדכון קבוצתי של שני לילות במקום אחד (D182).
- **min stay:** נשלח מהעמודה הלא נכונה (`min_stay_arrival` במקום `min_stay_through`) ומחק את כל חוקי המינימום (D183).
- **תלויות:** הסקריפט לא התקין חבילות כש-lockfile השתנה (nodemailer 9.0.3 במקום 9.1.1) — תוקן ב-D185.

---

## 7. ציר זמן אחרון (ספטמבר 2026)

| D / PR | מה | סטטוס |
|---|---|---|
| D175 · #235–#237 | מסך פרופיל עסק; הכרעות טאבי הגדרות | נפרס; רוב ההחלטות נסגרו (**⚠ לאמת** 2, 8, 9, 11 ואימות Maps בדומיין) |
| D176 | ניקוי תשלומי מזומן פנטומים — 38 בוטלו, 2 תוקנו | הושלם ואומת |
| D177 · #242 | עיצוב מחדש של תעריפים ב-CellDetailPanel | נפרס ואומת |
| D178 · #244→#245→#248 | פאנל שליחת הודעות: נפרס, באג חיתוך כרטיסים, revert, הוחזר עם תיקון | הושלם |
| #246 | guard גנרי `check:flex-card-shrink` | מוזג |
| #247 | תיקון flex במסכי ביטול ודוחות Booking.com | נפרס |
| D178 follow-up | textarea בכתיבה חופשית ל-RTL; "הודעה חדשה" מאפסת גוף ונושא | הושלם |
| D179 | שדרוג `check:manual-send-render` מ-regex לבדיקה התנהגותית | **⚠ לאמת** אם הושלם |
| D180 | rollback קנוני = revert commit | מתועד |
| D182 | תיקון טווח עדכון קבוצתי (לילות) | הושלם |
| D183 | min stay נשלח מהעמודה הנכונה ל-Beds24 | הושלם |
| D184 | הצגת הפרות הגבלות OTA בפאנל דשבורד | הושלם |
| D185 | deploy מתקין תלויות כש-lockfile משתנה | הושלם |
| D186 | שמירת payloads יוצאים של ARI לביקורת | הושלם |
| D187 | שינויי הגבלות ביומן audit של עדכון קבוצתי | הושלם |
| D188 | toast תוצאה לעדכון קבוצתי | הושלם |
| D189–D190 | גלישת טבלאות ברוחב טאבלט (אמצעי תשלום, סטטוסים, מנעולים) | הושלם |
| D191 | בסיס diff של deploy בקובץ state | הושלם |
| D192 · #263 | הסרת ווידג'ט "דורש טיפול" מהדשבורד (HEAD `5c14f82`) | נפרס ואומת |

**השלכה פתוחה של D192:** בריאות חיבור Beds24 (D133) נשארה בלי UI. `AlertsWindow.tsx`, `dashboardAlerts` וה-guards הקשורים נשארו בקוד במכוון.

---

## 8. פתוח — לפי דחיפות

### דחוף / תפעולי
1. **GREEN-API** — חידוש מנוי אצל הספק (פג 02/09). **⚠ לאמת** אם חודש.
2. **UI לבריאות חיבור Beds24** — חסר מאז D192.
3. **מע"מ במחירים ל-Booking.com** — החלטה פתוחה.

### פיצ'רים / אינטגרציות
4. **Airbnb דרך Beds24** — שלב OAuth ממתין, אחריו החלטת מיפוי listings.
5. **Google Hotels דרך Beds24** — מסלול free booking links, בלי שינויי קוד.
6. **P3-1 העברת חדר** — שחרור חדר המקור ותפיסת היעד ב-Beds24. גדול, סיכון echo-loop.
7. **זיהוי orphans מ-Beds24** — הזמנות שקיימות שם ולא הגיעו מקומית. אין מסלול קוד.
8. **WhatsApp נכנס** (הוצע 16/09) — webhook ל-`incomingMessageReceived`, זיהוי אורח לפי טלפון, תפריט יתרה/תקלה. טרם הוחלט.
9. **מעבר דומיין ל-stayme.co.il** — פרומפט אודיט מוכן. נוגע ב-`NEXT_PUBLIC_APP_URL`, nginx, certbot, GoTrue `SITE_URL`, כתובות webhook.

### אבטחה ונתונים
10. **נתוני כרטיס אשראי בהערות** — לבדוק אם `reservation_cards` (D52) כבר נותן חלופה מאובטחת: גלוי ב-UI, מוחרג מ-PDF/מייל/הדפסה.

### חוב טכני
11. **react-pdf** — RTL שבור, קריסה בהורדה שנייה, חורים בפונט. הסרה לא הוכרעה.
12. **`migrate.mjs` שבור מאז מיגרציה 064** — deploy לא מושפע, replay מאפס שבור.
13. **CI:** 9 guards יוצאים בלי לרוץ כש-`CHECK_*_DB_URL` חסרים.
14. **חדר 926** — מלאי שלילי 0 (-1), כנראה הגדרת מלאי בסיס שבורה.
15. **דוח תפעול שבועי** — msmtp מותקן ולא מוגדר; בחירה בין Brevo SMTP לקובץ מקומי. SPF כבר תוקן ל-`v=spf1 include:_spf.google.com -all`.
16. **מסמכי runtime** — `CLAUDE.md` ו-`docs/PRODUCTION_RUNTIME.md` עדיין מפנים ל-`/var/www/guesthub-production`.
17. **mobile-audit** — 74 ממצאים נותרו מתוך 92.

### סביבה משותפת בשרת
- marketpilot: ה-crons הושבתו בניקוי; מנוי GREEN-API שם עדיין פעיל.

---

## 9. מסמכי מקור בריפו

| מסמך | תפקיד |
|---|---|
| `DECISIONS.md` | יומן ההחלטות המחייב (עד D192) |
| `CLAUDE.md` | כללי ברזל, עובדות פרויקט, production runtime |
| `AGENTS.md` | מדיניות פעולה אוטונומית של סוכנים |
| `STATE.md` | מה קפוא (housekeeping/tasks ועוד) |
| `DESIGN_SYSTEM.md` + `GUIDELINES.md` | עיצוב מחייב |
| `PROJECT_OVERVIEW.md` | סקירת ריפו (עודכן לאחרונה 26/07 — חלקית מיושן) |
| `docs/architecture/` | דומיין, תמחור, תשלומים, ערוצים, פריסה |
