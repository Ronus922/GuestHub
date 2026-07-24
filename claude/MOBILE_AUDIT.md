# דוח מוכנות למובייל — GuestHub PMS

**Viewport יעד:** 390px (Android, מכשיר אמיתי) · **מצב:** READ‑ONLY, לא שונה שום קוד/CSS/config · **תאריך:** 2026‑07‑19

---

## 0. תקציר מנהלים

האפליקציה **desktop‑first**. ה‑chrome (מעטפת) כבר מותאם למובייל; **התוכן של המסכים אינו**.

- **ה‑chrome תקין** — `Shell.tsx` מכיל מגירת off‑canvas אמיתית (רקע כהה, ESC, מלכודת פוקוס, breakpoint ב‑`md`/767px), `SidePanel` עובר לרוחב מלא במובייל (`max-sm:w-full`), ו‑`TopBar` כולל כפתור המבורגר עובד.
- **התוכן שבור** — כמעט כל טבלה/גריד רחבה כופה `min-width` קבוע וגוללת אופקית ללא חלופת כרטיסים: guests `1240px`, permissions `860px`, reservations `1150px`, calendar `1280px`, staff `880px`, communications `1040px`, WorkflowStatus `830px`, rate‑grid `250px+N×46`.
- **שורש הבעיה אחד וחוזר:** טבלאות עטופות ב‑`overflow-x-auto`/`overflow:auto` + `min-width` קבוע, בלי fallback ל‑stacked‑cards מתחת ל‑`md`. `calendar.css` בכלל ללא ולו `@media` אחד.
- **מטרות מגע:** `.btn` ו‑`.field-input` = 44px ✓. אבל `.icon-btn` (36px), Tabs (36px), `.chip` (28px), ותאי מטריצת ההרשאות (24px) — כולם **מתחת** לכלל #6 (44px).

**ספירה:** 4 BROKEN · 6 DEGRADED · 4 OK (מתוכם dashboard = placeholder).

---

## 1. טבלת סיכום

| Route | קבצים מרכזיים | תבנית פריסה | פסק דין | תבנית מובייל מומלצת | מאמץ |
|---|---|---|---|---|---|
| **/rates** (bulk‑update/yield) | `rates/RateGrid.tsx`, `RateToolbar.tsx`, `RateGridScreen.tsx`, `styles/rate-grid.css` | day‑grid | **BROKEN** | פחות ימים גלויים + עמודה ראשונה sticky (קיימת) + drill‑in ליום; toolbar → sheet מתקפל | **L** |
| **/permissions** | `permissions/PermissionsMatrix.tsx` | matrix | **BROKEN** | בורר‑תפקיד (select/tabs) + רשימת הרשאות של תפקיד יחיד עם toggles מתחת `md` | **M** |
| **/guests** | `guests/GuestsScreen.tsx`, `styles/guests.css` | data‑table | **BROKEN** | טבלה רחבה → כרטיסי אורח נערמים מתחת `md` | **M** |
| **/staff** | `staff/StaffTable.tsx`, `StaffScreen.tsx`, `PermissionsByModule.tsx` | data‑table + SidePanel | **BROKEN** | טבלה → כרטיסי עובד נערמים מתחת `md` | **M** |
| **/calendar** | `calendar/CalendarGrid.tsx`, `CalendarScreen.tsx`, `styles/calendar.css` | grid‑calendar | **DEGRADED** | ברירת‑מחדל שבוע במובייל + הורדת `min-width` ב‑`@media`; עמודה ראשונה sticky קיימת | **M** |
| **/reservations** 🔒 | `reservations/ReservationsScreen.tsx`, `styles/reservations-list.css` | data‑table | **DEGRADED** | טבלה → כרטיסי הזמנה מתחת `md`; 13 טאבים → chip‑sheet (נעול — ראה §2) | **L** (gated) |
| **/settings** | `settings/SettingsShell.tsx`, `WorkflowStatusSection.tsx` + sections, `styles/status-settings.css`, `check-in-check-out.css` | two‑pane + forms (+ 1 טבלה) | **DEGRADED** (סקשן אחד BROKEN) | WorkflowStatus grid → כרטיסי סטטוס נערמים; שאר הסקשנים כבר קורסים דרך `xl:hidden` select | **M** |
| **/channels** | `channels/page.tsx` + 10 sections (`ChannexRoomTypesSection.tsx` וכו') | settings‑sections + טבלאות אבחון | **DEGRADED** | טבלאות אבחון → כרטיסי label:value מתחת `md`; שורות `dl` בכפייה `grid-cols-3` → `grid-cols-1 sm:grid-cols-3` | **M** |
| **/communications** | `components/communications/CommunicationsShell.tsx`, `TemplateEditor.tsx`, `styles/communications.css` | tabs + KPI + grid‑tables | **DEGRADED** | `.gc-row` grid‑tables → כרטיסים נערמים מתחת `md`; tabs/KPI כבר reflow | **M** |
| **/rate-plans** | `rate-plans/RatePlanWizard.tsx`, `SimulatorPanel.tsx`, `RatePlansScreen.tsx` | card‑board + wizard | **DEGRADED** | steps strip → מספרים/`overflow-x`; NightsTable → כרטיסי לילה מתחת `md` | **S/M** |
| **/rooms** | `rooms/RoomsScreen.tsx`, `RoomWizard.tsx`, `AreaPanel.tsx`, `styles/rooms.css` | card‑board + wizard | **OK (גבולי)** | לתקן רק את ה‑steps strip (`.rm-steps` ללא wrap) | **S** |
| **/tasks** | `tasks/page.tsx`, `housekeeping/TasksBoard.tsx` | cards | **OK** | (אופציונלי) chip‑sheet לבר הפילטרים | S (אופ') |
| **/housekeeping** | `housekeeping/page.tsx`, `TasksBoard.tsx` | cards | **OK** | — | — |
| **/dashboard** | `dashboard/page.tsx` | placeholder | **OK** | — (placeholder ריק) | — |
| **chrome** | `layout/Shell.tsx`, `Sidebar.tsx`, `TopBar.tsx`, `ui/SidePanel.tsx`, `ui/Tabs.tsx` | מעטפת | **OK (מותאם)** | לתקן מטרות מגע (icon‑btn/tabs 36px) | S |

> **הערת scope:** ה‑brief ציין 17 מודולים; באפליקציה בפועל **14** אחרים. לא קיימים בקוד: automations, billing, bulk-update, documents, finance, maintenance, reports, suppliers. קיימים ולא בבריף: communications, rates, tasks. מיפוי: "bulk-update / yield / rate-grid" של הבריף = מודול **`rates`**. תועד ב‑`DECISIONS.md`.

---

## 2. ממצאים למסכים BROKEN / DEGRADED (עד 5 שורות כל אחד)

### BROKEN

**/rates** — `RateGrid.tsx:118-121` כופה `minWidth: calc(250px + N×46px)` (‏894px לשבועיים, ‏1630px לחודש) בתוך `.rg-scroll{overflow:auto}` (`rate-grid.css:79`). עמודת התווית 250px (`--rg-label`, `rate-grid.css:44`) מותירה ~140px → **~2 עמודות יום** בלבד. `RateToolbar.tsx:45,67` הן שתי שורות `flex-wrap` שנערמות ל‑~50% מגובה ה‑viewport. ללא כל `@media`.

**/permissions** — `PermissionsMatrix.tsx:144` טבלה `w-full min-w-[860px]` בתוך `overflow-auto` (`:143`) → עמודות התפקידים נחתכות. תאי ה‑toggle `h-6 w-6` = **24px** (`:324`, מתחת ל‑44px). מקרא תחתון `flex-wrap flex-none` (`:239`) עולה לכמה שורות ואוכל את גובה אזור הגלילה.

**/guests** — `guests.css:13-17` גריד 12 עמודות; `@media (max-width:1200px)` פשוט כופה `min-width:1240px` (`:48-51`) → גלילה אופקית של כל הטבלה. עמודת האימייל `minmax(170px,1fr)` נחתכת עם ellipsis → ".com" (`guests.css:31-39`). אין fallback לכרטיסים.

**/staff** — `StaffTable.tsx:158-159` `overflow-x-auto` + `<table class="w-full min-w-[880px]">`, 7 עמודות → גלילה אופקית ללא חלופה נערמת (זהה ל‑guests/permissions). ה‑header והפילטרים כן responsive (`StaffScreen.tsx:87,95`). `PermissionsByModule.tsx:61-62` `min-w-[420px]` — גלילה מינורית (~30px).

### DEGRADED

**/calendar** — `calendar.css:288-290` `.cb-calin{width:100%; min-width:1280px}` בתוך `.cb-calwrap{overflow:auto}` → ~3‑4 עמודות יום. **אפס `@media`** בקובץ. מרוכך: עמודה ראשונה + כותרת sticky (`calendar.css:465,326`), שורת KPI `grid-cols-2 xl:grid-cols-4` (`CalendarScreen.tsx:157`), ומגע שומר על גלילה טבעית (`CalendarGrid.tsx:783`). `cb-seg` 36px.

**/reservations** 🔒 — הטבלה `.rv-tbl` נשארת `min-width:1150px` בכל breakpoint (`reservations-list.css:340,528-532`) וגוללת אופקית. אבל המעטפת כן קורסת: פילטרים `repeat(7,1fr)→4→2→1` עד 440px (`:533-569`), search לרוחב מלא ב‑900px (`:538`), בר טאבים גולל בתוך עצמו (`:304-323`). כפתורי pagination 36px (`:500`).

**/settings** — המעטפת two‑pane קורסת נכון: nav `hidden ... xl:block` + select חלופי `field xl:hidden` (`SettingsShell.tsx:79-99`). **BROKEN בתוכה:** `WorkflowStatusSection.tsx:158` מרנדר גריד `.ws-tbl{min-width:830px}` (`status-settings.css:73-85`) + חצי סידור 22×16px (`:123`). עורכי מדיניות `grid-cols-2 sm:grid-cols-4` (`CancellationSection.tsx:288`) צפופים.

**/channels** — טבלאות אבחון עם `min-width` קבוע ב‑`overflow-x-auto`: `ChannexRoomTypesSection.tsx:381-382` `min-w-[1080px]` (הגרוע), `ChannexPropertySection.tsx:495` `720px`, `page.tsx:366` `560px`. שורות `dl` בכפייה `grid-cols-3` ב‑390px (`ChannexRoomTypesSection.tsx:279,341`) → ~110px/עמודה, צפוף. Stat cards כן `grid-cols-2 lg:*` (`page.tsx:286`).

**/communications** — כל רשימת נתונים היא grid‑table עם `min-width` שגולל אופקית: `communications.css:228-234` `.gc-row{min-width:1040px}`, ועוד inline `760px`/`980px` (`CommunicationsShell.tsx:317,492`). המעטפת תקינה: tabs גוללים (`communications.css:48`), KPI cards `flex-wrap flex:1 1 170px` (`:84-90`). עורך התבנית 3 עמודות קורס לעמודה אחת רק ב‑`max-width:1100px` (`:875`).

**/rate-plans** — הבורד card‑list תקין (`RatePlansScreen.tsx:107,113,169`). כאב: (1) ה‑steps strip `.rm-steps` ללא wrap/scroll + תוויות `nowrap` (`rooms.css:15-24,52`) → גלישה בתוך הפאנל; (2) `SimulatorPanel.tsx:167-168` `NightsTable` `min-w-[860px]` — טבלה שגוללת (כלי אבחון משני). עורכים ב‑SidePanel נערמים דרך `.rm-frow → 1fr` ב‑640px.

**/rooms (גבולי)** — הבורד `.rm-grid` הוא `auto-fill minmax(276px,1fr)` (`rooms.css:700`) → עמודה יחידה ב‑390px, וכל שורות הטופס קורסות ל‑`1fr` ב‑640px (`rooms.css:110-115`). הכשל היחיד: אותו `.rm-steps` strip (RoomWizard `:1088`). מטרות: `.rm-stopt` 36px, chips פילטר < 44px. הפאנלים כן עוברים לרוחב מלא (`max-sm:w-full` גובר על `w-[60vw]`).

---

## 3. סדר עדיפויות לפאזות התיקון (קריטי‑שימוש קודם)

1. **פאזה A — לב התפעול היומי (BROKEN + שימוש כבד):**
   `/calendar` (הלוח — מסך הבית התפעולי) · `/rates` (רשת התעריפים) · `/guests` (כרטיסי אורח).
   *מדוע ראשון:* אלה המסכים שמנהל בית‑מלון פותח על הטלפון תוך כדי תנועה. calendar כבר מרוכך (sticky) אז מהיר; rates הכי שבור וכולל toolbar כבד.

2. **פאזה B — זרימות ההזמנה:**
   `/reservations` 🔒 (טבלה→כרטיסים; **נעול** — דורש 10‑point regression check לפני נגיעה) · עורך ההזמנה (`EditReservationPanel`) כבר ב‑SidePanel רוחב‑מלא, לוודא שהתוכן הפנימי לא גולש.

3. **פאזה C — ניהול צוות והרשאות (BROKEN, שימוש ניהולי):**
   `/staff` (טבלה→כרטיסים) · `/permissions` (מטריצה→בורר‑תפקיד + toggles).

4. **פאזה D — משק‑בית ומשימות במובייל (כבר OK, לחדד):**
   `/housekeeping` + `/tasks` כבר stacked‑cards — רק לצמצם את בר הפילטרים ל‑chip‑sheet ולהגדיל מטרות מגע. עבודה קטנה, ערך תפעולי גבוה (צוות ניקיון עובד מהנייד).

5. **פאזה E — הגדרות ואינטגרציות (DEGRADED, שימוש נדיר יותר):**
   `/settings` (סקשן WorkflowStatus) · `/channels` · `/communications` · `/rate-plans` (wizard steps + NightsTable) · `/rooms` (steps strip).

---

## 4. תיקונים רוחביים/גלובליים (מרוויחים כמה מסכים בבת אחת)

לפי כלל ברזל #8 (DRY — מבנה חוזר → קומפוננטה רוחבית):

1. **`ResponsiveTable` — קומפוננטה רוחבית אחת (הרווח הגדול ביותר).**
   שורש הכשל זהה ב‑8 מסכים: `overflow-x` + `min-width` קבוע בלי חלופת כרטיסים. קומפוננטה אחת שמעל `md` מרנדרת טבלה, ומתחת `md` מרנדרת שורה‑ככרטיס (label:value), פותרת בבת אחת את guests, staff, permissions‑by‑module, channels (×3 טבלאות), communications (`.gc-row`), WorkflowStatus, ו‑NightsTable. **מסך אחד נעול (reservations `.rv-tbl`) — להחיל רק אחרי 10‑point regression check.**

2. **`ResponsiveToolbar` / filter‑sheet רוחבי.**
   בר פילטרים צפוף חוזר ב‑rates, reservations (13 טאבים), tasks, channels, rate‑plans. Sheet מתקפל אחד (או שורת chips גוללת) מונע מה‑toolbar לאכול ~50% מגובה ה‑viewport — הבעיה המרכזית ב‑/rates.

3. **תיקון מטרות מגע ב‑design‑system.css (כלל #6, 44px).**
   נקודה אחת: `.icon-btn` (36px→44px), Tabs button (`h-9`→`h-11`), `.chip.clickable` כשהוא כפתור, ותאי `.cb-seg`/`.rm-stopt`/`.ws-ord`/pagination. תיקון בטוקנים מטפל בכל המסכים.

4. **תבנית day‑grid משותפת (calendar + rates).**
   שניהם: עמודת תווית sticky קבועה + N עמודות יום עם `min-width` שגולש. Mixin/hook אחד שמוריד את מספר הימים הגלויים ואת `min-width` מתחת ל‑`640px` (calendar כבר עם sticky, rates צריך רק את ה‑`@media`) — משרת את שני המסכים הקריטיים ביותר.

5. **`.rm-steps` (stepper) — תיקון אחד, שני מסכים.**
   אותו strip משמש RoomWizard ו‑RatePlanWizard; `flex-wrap`/`overflow-x` + הסתרת תוויות מתחת sm מתקן את שניהם.

6. **מדיניות `@media` ל‑`calendar.css`.**
   הקובץ היחיד עם אפס `@media` — כל שאר קבצי ה‑styles כבר מכילים breakpoints. פער עקבי שכדאי לסגור.
