# ביקורת שלמות השומרים — כמה נבדקו, כמה שיקרו, ומה הבסיס החדש

> **שני שומרים קראו את עץ הפרודקשן וסימנו ירוק על קוד שהמחבר לא כתב.**
> שניהם נתפסו במדידה, לא בהיסק: הוזרקה לעץ העבודה בדיוק התקלה שכל שומר קיים
> כדי לתפוס, ושניהם נשארו ירוקים. אחד מהם גם **כתב לתוך עץ הפרודקשן**.

נמדד 2026-07-25 · ענף `phase/guard-integrity-audit` · בסיס `origin/main` = **`ca0a9a3`**
אפס נגיעה בפרודקשן כעץ עבודה. כל הרצה מול DB התבצעה על `:5433` המתכלה.

---

## 1.1 — הסריקה: מה נסרק בפועל

| | |
|---|---|
| רשומות `check:*` ב-package.json | **73** (מהן 2 ללא קובץ: `check:beds24` צובר, `check:agents-concurrency` grep inline) |
| קבצי `scripts/*.mjs` על הדיסק | **82** — מתוכם **73 מחווטים** לרשומת `check:*`, **9 לא מחווטים** |
| נסרקו לנתיבים מוחלטים / תלות ב-cwd | **82** (כל הקבצים, לא רק המחווטים) |

תבניות שחיפשתי: מחרוזת מוחלטת ל-`/var/www` · `/home` · `/opt` · `/srv` ·
`process.cwd()` · `__dirname` מול `import.meta.url` · `process.env.X || "<נתיב מוחלט>"`.

---

## 1.2 — הסיווג: כל שומר בדיוק בקטגוריה אחת

### (א) קורא עץ פרודקשן — **2 שומרים. כל תוצאה שלהם עד היום בטלה.**

| שומר | שורה | הנתיב | מה טען |
|---|---|---|---|
| `check-messaging.mjs` | 16 | `const ROOT = "/var/www/guesthub"` | טען שהסודות מוצפנים ב-AES-256-GCM, שהמפתח ייעודי, שהכשל סגור, ושהמסכות אינן דולפות — **על קבצי פרודקשן**, מכל worktree |
| `check-channels-fullsync-ui.mjs` | 25 | `const ROOT = "/var/www/guesthub"` | טען שכל מחלקת צבע במסך `/channels` באמת נוצרת ב-Tailwind — **על רכיבי פרודקשן**. בנוסף **כתב** את תיקיית ה-scratch שלו לתוך `node_modules/.cache` של פרודקשן |

**ההוכחה — התנהגותית, לא סטטית.** מוטציה בעץ העבודה בלבד, פרודקשן נשאר נקי:

| מוטציה (בעץ העבודה) | לפני התיקון | אחרי התיקון |
|---|---|---|
| `aes-256-gcm` → `aes-128-ecb-BROKEN` ב-`src/lib/messaging/secrets.ts` | 🟢 **GREEN — שיקר** | 🔴 RED: *"secrets use authenticated AES-256-GCM"* |
| הזרקת `bg-brand text-brandish` ל-`channels/ConfirmDialog.tsx` | 🟢 **GREEN — שיקר** | 🔴 RED: *"classes that resolve to NO generated CSS rule (invisible styling): ConfirmDialog.tsx: bg-brand, ConfirmDialog.tsx: text-brandish"* |

**הכתיבה לפרודקשן נצפתה חיה**, לא הוסקה מקריאת הקוד: סקר במקביל להרצה תפס את
`/var/www/guesthub/node_modules/.cache/fullsync-ui-check/input.css` נוצר תוך כדי,
ונמחק בסיום ע"י הניקוי של השומר עצמו (שורה 104). זו כתיבה לתוך עץ הריצה של
פרודקשן, מכל worktree, ללא ידיעת המפעיל.

### (ב) יחסי/מקומי — **80 שומרים. תקין.**

מתוכם 10 מחזיקים `const ROOT = process.cwd()` ו-~12 קוראים בנתיב יחסי חשוף
(`readFileSync("src/...")`). **שתי הצורות נפתרות לעץ שממנו הורץ `pnpm check:*`,
ולכן הן נכונות** — ההזמנה הקנונית היא היחידה בשימוש, והיא תמיד מריצה מ-root של
החבילה. הן **לא** תוקנו: זו נגיעה ב-~22 קבצים בלי פגם נמדד, והכלל החדש
(`check:guard-roots`) חוסם את הצורה המסוכנת בלבד.

ההבדל בין (א) ל-(ב) הוא מהותי ולא סגנוני: נתיב מוחלט **תמיד שגוי** מ-worktree
ובלתי נראה; `cwd` שגוי רק אם קוראים לשומר בנתיב מוחלט מתיקייה אחרת — מה שנראה
בשורת הפקודה ואיש אינו עושה.

### (ג) תלוי-סביבה — **הנחת "שלושה" מופרכת. הם 15.**

התבקשתי לאמת שאין יותר משלושה. **יש 15**, וכולם נמדדו שם-בשם. שלושת המוכרים:

| השלושה שהיו ידועים | מה חסר |
|---|---|
| `check:pricing-engine` | סכימה **מחוקה** (הוא פורס את שרשרת המיגרציות בעצמו) |
| `check:pricing-equality` | סכימה **מחוקה** |
| `check:reservation-concurrency` | `CHECK_CONCURRENCY_DB_URL` |

**עוד 12 שלא היו ברשימה:**

| שומר | מה חסר | אומת |
|---|---|---|
| `check:rate-plans` | סכימה מחוקה | 🟢 ירוק אחרי DROP |
| `check:su-lifecycle` | סכימה מחוקה | 🟢 ירוק אחרי DROP |
| `check:room-identity` | סכימה מחוקה | 🟢 ירוק אחרי DROP |
| `check:background-job-recovery` | `CHECK_CONCURRENCY_DB_URL` | 🟢 ירוק עם ה-URL |
| `check:payment-refund-void` | `CHECK_CONCURRENCY_DB_URL` | הודעת exit=2 מפורשת |
| `check:db-isolation` | `CHECK_DB_URL` / `STAGING_DATABASE_URL` | exit=2 מפורש |
| `check:inventory-integrity` | `CHECK_DB_URL` / `STAGING_DATABASE_URL` | exit=2 מפורש |
| `check:payment-ledger-integrity` | `CHECK_DB_URL` / `STAGING_DATABASE_URL` | exit=2 מפורש |
| `check:pms-domain-invariants` | `CHECK_DB_URL` / `STAGING_DATABASE_URL` | exit=2 מפורש |
| `check:hydration-browser` | `HYDRATION_BASE_URL` + כרום | exit=1 מפורש |
| `check:booking-com-reports` | סכימה **קיימת** בבעלות התפקיד שלו | `permission denied for schema guesthub` |
| `check:guest-communications-db` | סכימה **קיימת** בבעלות התפקיד שלו | `must be owner of table reservations` |

> **מלכודת שנמדדה:** שתי הקבוצות סותרות. `pricing-engine` דורש סכימה **מחוקה**;
> `guest-communications-db` דורש סכימה **קיימת**. אי אפשר לרצות את שתיהן בהרצה
> אחת — ולכן הסדרה המלאה תמיד תציג חלק מהאדומים האלה, בכל מצב קוד.

---

## 1.3 / 1.4 — התיקונים

| שומר | מה תוקן | הוכחה |
|---|---|---|
| `check-messaging.mjs` | ROOT נפתר מ-`import.meta.url`; מדפיס `# tree under test: <path>` בזמן ריצה | המוטציה שלא נתפסה לפני — נתפסת |
| `check-channels-fullsync-ui.mjs` | אותו דבר; ובנוסף `postcss` נפתר דרך `@tailwindcss/postcss` | המוטציה נתפסת. `postcss` הוא תלות **טרנזיטיבית** — `require("postcss")` חשוף הסתמך על ה-node_modules ה**מושטח** של פרודקשן, ונשבר ב-worktree של pnpm ברגע שה-ROOT תוקן. אדום מהסיבה הלא נכונה **לא התקבל** |
| `check-pricing-engine.mjs` | הוסף `# tree under test` | תוקן ב-D100 אבל לא הכריז על העץ. **`check:guard-roots` תפס את זה מיד** |
| `check-background-job-recovery.mjs` | `const LEASE=10` הוחלף בקריאה של `JOB_LEASE_MINUTES` מ-`queue.ts`, + שני צדי הגבול | הזזת הקבוע ל-30 ⟹ השומר עובר לבדוק **29/31**. הישן היה ממשיך לבדוק 9/11 ועובר לשווא |
| **`check-guard-roots.mjs` (חדש)** | אוסר נתיב checkout מוחלט בכל 83 השומרים; opt-out מפורש שחייב להכריז על עצמו בפלט | ראה A/B2 למטה |

**1.4 — היקף מלא:** נסרקו כל הקבועים המספריים המוצהרים בתוך שומרים.
**מקרה אחד בלבד** הוא שכפול של קבוע מוצר (`LEASE`); כל השאר הם ערכי פיקסצ'ר
(`PRICE=480`, `SPAN=6`, `B24_ROOM=708100`). אסרשנים מהצורה
`assert.equal(mod.CONST, 14)` **אינם** שכפול — הם מייבאים את הערך ונופלים כשהוא
זז. הם הושארו בכוונה.

### A / B2 של השומר החדש

| רגל | מה נעשה | תוצאה |
|---|---|---|
| **A** | הורץ מול `scripts/` של `origin/main` ב-worktree נפרד. זהות אומתה: `git diff origin/main -- scripts/` = **0 שורות** | 🔴 **RED** — ונקב בשני העבריינים בשמם ובשורתם: `check-channels-fullsync-ui.mjs:25`, `check-messaging.mjs:16` |
| **B2a** | הביטוי המאתר נוטרל (`/(?!)/g`), כל סימן מבני נשאר | 🔴 RED |
| **B2b** | הביטוי **שלם**, איסוף העבריינים רוקן | 🔴 RED — אבל בדיקה 1 **עברה בריק על כל 83 השומרים**. רק הקנרית תפסה |

B2b הוא הסיבה שהקנרית עוברת דרך **אותה פונקציה** שהסריקה האמיתית משתמשת בה,
ומאמתת את **מספר השורה** ולא רק שנמצא משהו. קנרית שאינה חולקת קוד עם מה שהיא
מאשרת — אינה מאשרת דבר.

> `git checkout … -- src/` לא שימש באף שלב בזרימה הזו. רגל A רצה ב-worktree
> נפרד על `origin/main`, וכל תיקון קומט לפני הרצת מוטציה.

---

## 1.5 — הסדרה המלאה, שם-בשם

הבסיס נמדד **באותו רגע, באותה סביבה, על אותה מכונה** — worktree נפרד על
`origin/main` — ולא נלקח מזיכרון. זה היה הכרחי: פרסתי את שרשרת המיגרציות על
ה-DB המתכלה תוך כדי הפאזה, וזה לבדו מזיז שומרים.

| | עובר | נכשל | סה"כ |
|---|---|---|---|
| `origin/main` (`ca0a9a3`), אותו רגע | 50 | 23 | 73 |
| הענף הזה | **51** | **23** | **74** |

**שומרים שהתהפכו: אפס.** ההפרש היחיד הוא `check:guard-roots` — חדש, ועובר.
לכן השאלה "הקוד היה שבור, או השומר שיקר" אינה נדרשת לאף פריט בסדרה.

**היא כן נדרשת לשני שומרי (א), ושם התשובה חד-משמעית: השומר שיקר כל הזמן.**
הם לא התהפכו רק משום שעץ הפרודקשן ועץ העבודה החזיקו **אותו קומיט**, ולכן הירוק
שלהם היה נכון **במקרה**. כל ירוק שהם הדפיסו אי-פעם מ-worktree עם שינוי מקומי —
חסר משמעות.

### הבסיס החדש — **51 עוברים / 23 נכשלים מתוך 74**

23 האדומים, שם-בשם, זהים לחלוטין לבסיס:

**תלויי-סביבה (15) — אינם אמירה על הקוד:**
`background-job-recovery` · `booking-com-reports` · `db-isolation` ·
`guest-communications-db` · `hydration-browser` · `inventory-integrity` ·
`payment-ledger-integrity` · `payment-refund-void` · `pms-domain-invariants` ·
`pricing-engine` · `pricing-equality` · `rate-plans` · `reservation-concurrency` ·
`room-identity` · `su-lifecycle`

**אדומי קוד/נתונים (8) — כולם קיימים על main מלפני הפאזה:**

| שומר | על מה הוא נופל |
|---|---|
| `check:beds24-ari` | 28 טווחי ARI pending מעל שעתיים |
| `check:beds24` | צובר — נופל בגלל `beds24-ari` |
| `check:calendar` | `reservations/actions.ts` מייבא את שכבת ה-HTTP של הערוץ |
| `check:calendar-ui` | שורת הערוץ אינה מותנית |
| `check:cards` | `PSP_PROVIDER` לא מוגדר (תחום **#60**, מחוץ להיקף) |
| `check:channels-badge` | לא בדיוק ארבע הגדרות ערוץ גלויות |
| `check:design` | 6 הפרות ב-`housekeeping/my-tasks` — **מסך קפוא** (STATE.md) |
| `check:supply-chain` | 5 התרעות high פתוחות |

---

## 1.7 — השער

| שאלה | תשובה | ראיה |
|---|---|---|
| נמצא שומר מקבוצה (א)? | **כן, שניים** | §1.2 |
| תוקנו? | **כן** | המוטציות נתפסות |
| מה הבסיס הקובע? | **51/23 מתוך 74** | נמדד באותו רגע מול `origin/main` |
| **האם קוד המוצר נגוע?** | **לא** | שני שומרי (א) **ירוקים מול המקור האמיתי של main** אחרי התיקון (`# tree under test: /var/www/wt-guard`). אפס שומרים התהפכו. אף אחד מ-8 אדומי הקוד אינו בתחום שהשומרים העיוורים כיסו (messaging, `/channels`) |

**השער עבר. מותר להיכנס לחלק 2.**

---

## מה לא מוכח

- **`check-background-job-recovery` מעתיק את פרדיקט ה-claim עצמו** מ-`queue.ts`,
  לא רק את הקבוע. הקבוע תוקן; ה-SQL עדיין עותק, ולכן השומר מוכיח שה-**עותק**
  מתנהג נכון, לא שקוד המוצר מתנהג נכון. תיקון אמיתי דורש לייצא את הפרדיקט
  ממודול אחד — לא בוצע, מחוץ להיקף הפאזה.
- **9 קבצי `scripts/*.mjs` אינם מחווטים** לאף `check:*`. לא נבדק מה הם ואם הם
  חיים.
- **B2 לא הורץ על 80 השומרים בקבוצה (ב)** בפאזה הזו. §9 של GUARD_INTEGRITY.md
  עדיין עומד.
- **שאריות ב-`node_modules/.cache` של פרודקשן**: עשרות תיקיות
  `check-guest-communications-*` שלא נוקו. לא נגעתי בהן.
- **אין CI.** אף אחד מ-74 השומרים אינו רץ אוטומטית. `check:guard-roots` יתפוס
  נסיגה רק אם מישהו יריץ אותו.
