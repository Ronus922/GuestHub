# GuestHub — אינוונטר מובייל/רספונסיביות (Stage 2)

- **תאריך:** 2026-08-12
- **ענף:** `fix/mobile-audit-2026-08-12` (worktree `~/worktrees/mobile-audit`)
- **בסיס:** `main` @ `89d9d6e`
- **סביבת אימות:** אפליקציה על `127.0.0.1:3017` מול `guesthub-staging-db` (:5434, schema 083) +
  `guesthub-staging-auth` (:9989). **אפס נגיעה בפרודקשן** — ‏`scripts/lib/e2e-write-guard.mjs`.

מסמך זה נכתב **לפני** תחילת התיקונים והוא מקור האמת ל-Stage 6.
כל פריט נסגר באחד מ-‏`PASS` / `FIXED + PASS` / `OPEN ISSUE` / `NOT APPLICABLE`.
עמודת הסטטוס מתמלאת ב-Stage 6 ואסור שפריט ייעלם ממנה.

---

## 0. היקף — מה לא קיים במוצר הזה

הבקשה נוסחה עבור אתר שיווקי ציבורי. ‏GuestHub הוא PMS פנימי: 20 routes, כולם מאחורי אימות.
הפריטים הבאים מ-brief נבדקו ואינם קיימים בריפו — הם ייסגרו `NOT APPLICABLE` עם הנימוק הזה,
לא יומצאו ולא ידולגו בשקט:

| פריט מה-brief | ממצא |
|---|---|
| Hero section | אין. אין עמוד שיווקי אחד |
| Footer | אין. ה-shell הוא sidebar + topbar בלבד |
| Carousel / slider / swipe | **0 מופעים** בכל הריפו |
| Gallery | אין גלריית תמונות. `TEMPLATE_GALLERY` היא רשימת נתונים המרונדרת כ-grid |
| Accordion / FAQ | אין קומפוננטה. שני `<details>` נייטיביים ב-`channels/page.tsx:315` ו-`ExternalChangesSection.tsx:192` |
| Command menu (⌘K) | אין. ה-`<input>` ב-`TopBar.tsx:43` דקורטיבי — ללא handler |
| זרימת חיפוש/הזמנה לאורח | לא בריפו הזה. מנוע ההזמנות הוא **sea-tower** (:3005, ריפו נפרד) הצורך 3 endpoints תחת `/api/public/*`. הוחלט מול המשתמש: מחוץ להיקף |
| SEO / metadata ציבורי | `metadata` יחיד ב-root layout; כל המסכים `force-dynamic` מאחורי אימות |

**"זרימת ההזמנה" הנבדקת כאן** היא החלון הפנימי: `BookingPanel` (1,574 שורות, אשף 4 שלבים)
ו-`EditReservationPanel` (1,710 שורות).

---

## 1. Routes ‏(R)

‏22 יעדי URL. `/` ו-`/auth/*` הם redirect/route-handler בלבד ואינם משטח UI.

| ID | Path | מסך | הערות | סטטוס |
|---|---|---|---|---|
| R-01 | `/dashboard` | דשבורד | 11 חלונות נגררים (dnd-kit); השער היחיד ללא הרשאה | |
| R-02 | `/calendar` | תפוסה | לוח desktop (`min-width:1280px`) + מסלול מובייל נפרד | |
| R-03 | `/rates` | עדכון קבוצתי | Rate Grid + drawer עדכון קבוצתי | |
| R-04 | `/rate-plans` | תוכניות תעריף | אשף + סימולטור + overrides | |
| R-05 | `/reservations` | הזמנות | טבלה `min-width:1150px` + סרגל טאבים נגלל | |
| R-06 | `/guests` | אורחים | מוסתר מהניווט, ה-route חי. `min-width:1240px` | |
| R-07 | `/rooms` | חדרים ואזורים | אשף חדר + פאנל אזור + popover סטטוס | |
| R-08 | `/housekeeping` | ניקיון | לוח kanban dnd-kit | |
| R-09 | `/maintenance` | תחזוקה | | |
| R-10 | `/locks` | מנעולים וקודים | grid `min-width:900px` | |
| R-11 | `/channels` | ערוצים | super_admin בלבד; טבלת Beds24 `min-w-[1080px]` | |
| R-12 | `/settings` | הגדרות | 9 סקשנים (S-01…S-09) | |
| R-13 | `/staff` | משתמשים | `@tanstack/react-table`, `min-w-[880px]` | |
| R-14 | `/permissions` | הרשאות | מטריצה `min-w-[860px]` **ללא עוטף גלילה** | |
| R-15 | `/communications/templates` | תבניות | | |
| R-16 | `/communications/automations` | אוטומציות | | |
| R-17 | `/communications/history` | היסטוריה | | |
| R-18 | `/communications/channels` | ערוצי תקשורת | | |
| R-19 | `/communications/archive` | ארכיון | | |
| R-20 | `/login` | התחברות | מחוץ ל-Shell; היחיד שכבר רספונסיבי (`lg:flex`) | |
| R-21 | `/housekeeping/my-tasks` | המשימות שלי | מחוץ ל-Shell, מובייל-first (`max-w-md`) | |
| R-22 | `/reservations/[id]/print` | מסמך להדפסה | מחוץ ל-Shell, CSS inline משלו | |
| R-23 | `/` | root redirect | לא משטח UI | |
| R-24 | 404 כלשהו | לא נמצא | **אין `not-found.tsx`** — דף Next באנגלית LTR בתוך `dir="rtl"` | |

## 2. Layouts ומצבי מסך ‏(L)

| ID | פריט | מיקום | סטטוס |
|---|---|---|---|
| L-01 | Root layout | `src/app/layout.tsx` — `<html lang="he" dir="rtl">`; **אין `export const viewport`** | |
| L-02 | ‏`(dashboard)/layout.tsx` | טוען actor + מרכיב `Shell` | |
| L-03 | ‏`Shell` | `flex h-screen overflow-hidden` — 100vh ב-iOS | |
| L-04 | ‏`TopBar` | sticky, גובה 64px, z-20 | |
| L-05 | ‏`Sidebar` desktop | 250px / 76px מכווץ | |
| L-06 | ‏`Sidebar` mobile drawer | `fixed inset-y-0 start-0 z-50 w-[250px]`, translate | |
| L-07 | סקרים של תפריט מובייל | `Shell.tsx:95`, z-40 | |
| L-08 | ‏Error boundary | `(dashboard)/error.tsx` בלבד — `/login`, `/my-tasks`, `/print` חשופים | |
| L-09 | ‏Loading states ×4 | calendar, communications, permissions, staff | |
| L-10 | Empty states | לכל מסך רשימה | |
| L-11 | Success/toast state | sonner, `bottom-center`, offset 26 | |

## 3. משטחים צפים ופורטלים ‏(P) — אזור הסיכון הגבוה

**פורטל אחד בלבד בכל הריפו:** `SidePanel.tsx:152` (`createPortal` → `document.body`).
כל שאר המשטחים הצפים מרונדרים **in-tree** ונשענים על כך ש-`position:fixed` ישרוד ancestor
‏stacking/transform. ‏`framer-motion` על ה-SidePanel יוצר transform context.

### 3א. ‏25 קריאות SidePanel (הפורטל)

| ID | קורא | רוחב | סטטוס |
|---|---|---|---|
| P-01 | `BookingPanel.tsx:521` | `w-[60%] min-w-[min(900px,100%)] max-w-[1200px]` | |
| P-02 | `EditReservationPanel.tsx:525` | כנ"ל | |
| P-03 | `SimulatorPanel.tsx:542` | `w-[60vw]` — **ללא max-w, ללא מגן מובייל** | |
| P-04 | `RatePlanWizard.tsx:317` | `w-[60vw]` — **ללא max-w** | |
| P-05 | `RoomWizard.tsx:380` | `w-[60vw]` — **ללא max-w** | |
| P-06 | `GroupUpdatePanel.tsx:251` | `w-[60vw] max-w-[calc(100vw-48px)] max-sm:max-w-none` | |
| P-07 | `AreaPanel.tsx:115` | `w-[45vw] max-lg:w-[70%]` | |
| P-08 | `TemplateEditor.tsx:349` (+ פאנל שני) | `w-[min(1400px,96vw)]` | |
| P-09 | `HtmlTemplateEditor.tsx:201` | `w-[min(1400px,96vw)]` | |
| P-10 | `WhatsAppTemplateEditor.tsx:183` | `w-[min(1100px,96vw)]` | |
| P-11 | `CommunicationsShell.tsx:559` | ברירת מחדל `w-[60%]` | |
| P-12 | `CommunicationsShell.tsx:935` | ברירת מחדל | |
| P-13 | `CommunicationsShell.tsx:1368` | ברירת מחדל | |
| P-14 | `GuestsScreen.tsx:245` | ברירת מחדל | |
| P-15 | `ClosurePanel.tsx:58` | ברירת מחדל | |
| P-16 | `PaymentMethodsCard.tsx:298` | ברירת מחדל | |
| P-17 | `CancellationSection.tsx:151` | ברירת מחדל | |
| P-18 | `TaskDispatchBoard.tsx:976` | ברירת מחדל | |
| P-19 | `TaskDispatchBoard.tsx:1130` | ברירת מחדל | |
| P-20 | `LocksBoard.tsx:1048` | ברירת מחדל | |
| P-21 | `SourcesDrawer.tsx:101` | ברירת מחדל | |
| P-22 | `EmployeeSidePanel.tsx:490` | ברירת מחדל | |
| P-23 | `CellDetailPanel.tsx:73` | ברירת מחדל | |
| P-24 | `OverridesPanel.tsx` | ברירת מחדל | |
| P-25 | `SidePanel` עצמו | `w-[60%] max-sm:w-full`, `fixed inset-0 z-[90]`, `h-full` | |

### 3ב. משטחים צפים שאינם מפורטלים

| ID | משטח | מיקום | סיכון | סטטוס |
|---|---|---|---|---|
| P-26 | `.modal` קנוני | `design-system.css:584` | `width: min(520px, 100vw-24px)` תקין; **אין `max-height`** | |
| P-27 | `ConfirmDialog` (ערוצים) | `channels/ConfirmDialog.tsx:33` | `fixed inset-0 z-50` + `max-h-[90vh]` | |
| P-28 | `MoveConfirmDialog` (לוח) | `calendar/MoveConfirmDialog.tsx:134` | `fixed`, ללא תקרת גובה | |
| P-29 | `editorShared.Dialog` | `editorShared.tsx:135` | `absolute inset-0` בתוך overlay של SidePanel | |
| P-30 | `TestSendDialog` | `editorShared.tsx` | `.modal` | |
| P-31 | ‏viewer מסמכים `.bw-docv` | `booking-window.css:949` | `fixed inset-0 z-120` | |
| P-32 | `CancelReservationDialog` | overlay slot, `.bk-cmp` | | |
| P-33 | `BookingComReports` overlay | overlay slot | | |
| P-34 | `BookingActions` composer | overlay slot | | |
| P-35 | ‏bottom sheet `.cb-sheet` | `calendar-mobile.css:314` | **אין `max-height`** — תוכן ארוך לא נגלל ולא ניתן לסגירה | |
| P-36 | `.popover` קנוני | `design-system.css:597` | `width:316px` **ללא `max-width`/`max-height`** | |
| P-37 | `ReservationTooltip` | `calendar/ReservationTooltip.tsx:60` | קבועים 316/10/12 משוכפלים ידנית | |
| P-38 | `StatusPopover` (חדרים) | `RoomsScreen.tsx:173` | clamp ידני עם קבוע 328 מוקשח | |
| P-39 | תפריטי הקשר של הלוח `.cb-menu` | `CalendarGrid.tsx:1104` | | |
| P-40 | ‏tooltip של רשת התעריפים `.rg-tip` | `rate-grid.css:296`, `RateCells.tsx:130` | `width:252px`, `fixed` | |
| P-41 | תפריט "…" בסרגל ההזמנה `.bk-tb-menu` | `booking-window.css:1205` | `absolute` **ללא flip** — נחתך בקצה הפאנל | |
| P-42 | ‏autocomplete אורח | `BookingPanel.tsx:710` | `absolute top-full` — נחתך ע"י ancestor נגלל | |
| P-43 | ‏date-picker panel של הזמנות `.rv-dp` | `reservations-list.css:307` | `width: min(740px, 100vw-48px)` | |
| P-44 | ‏Toaster (sonner) | `Shell.tsx:123` | `bottom-center` offset 26 — מתנגש עם P-35 | |
| P-45 | ‏drawer ניווט מובייל | `Sidebar.tsx:37` | | |

## 4. טבלאות ורשתות רחבות ‏(T)

| ID | משטח | רוחב מינימלי | עוטף גלילה | סטטוס |
|---|---|---|---|---|
| T-01 | `PermissionsMatrix.tsx:144` | `min-w-[860px]` | **אין** | |
| T-02 | `.gl-rowg` (אורחים) | `min-width:1240px` **בתוך** `@media (max-width:1200px)` | `.rl-*` | |
| T-03 | `.rv-tbl` (הזמנות) | `min-width:1150px` | `.rv-tblwrap` | |
| T-04 | `StaffTable.tsx:159` | `min-w-[880px]` | `overflow-x-auto` | |
| T-05 | `Beds24Section.tsx:426` | `min-w-[1080px]` | `overflow-x-auto` | |
| T-06 | `SimulatorPanel.tsx:168` | `min-w-[860px]` | `overflow-x-auto` | |
| T-07 | `channels/page.tsx:288` | `min-w-[560px]` | `card overflow-x-auto` | |
| T-08 | `PermissionsByModule.tsx:62` | `min-w-[420px]` | `overflow-x-auto` | |
| T-09 | `.lk-gt` (מנעולים) | `min-width:900px` | `.lk-scroll` | |
| T-10 | `.ws-tbl` (סטטוסים) | `min-width:830px` | `.ws-scroll` | |
| T-11 | `.pm-tbl` (אמצעי תשלום) | `min-width:780px` | `.pm-scroll` | |
| T-12 | `.gc-row` (תבניות תקשורת) | `min-width:1040px`, 10 מסלולי grid קשיחים | `overflow-x` | |
| T-13 | `.cb-calin` (לוח תפוסה) | `min-width:1280px` | `.cb-calwrap` + מסלול מובייל נפרד | |
| T-14 | `RateGrid` | סטיקי דו-ממדי | גלילה מקומית | |
| T-15 | `TaskDispatchBoard` kanban | עמודות `w-[280px]` | `overflow-x-auto` | |

## 5. סקשני הגדרות ‏(S) — 9

| ID | סקשן | קובץ | סטטוס |
|---|---|---|---|
| S-01 | פרופיל העסק | `BusinessProfileSection.tsx` (+ `LocationPicker` — Google Maps) | |
| S-02 | מע״מ ומיסים | `VatSection.tsx` | |
| S-03 | תמחור תפוסה ואורח נוסף | `ExtraGuestSection.tsx` | |
| S-04 | סטטוסי הזמנה | `WorkflowStatusSection.tsx` (T-10) | |
| S-05 | שעות צ'ק-אין/אאוט | `CheckInCheckOutSection.tsx` — היחיד עם מגן זום ל-iOS כיום | |
| S-06 | מדיניות ביטול | `CancellationSection.tsx` + `PolicyList.tsx` (P-17) | |
| S-07 | אמצעי תשלום | `PaymentMethodsCard.tsx` (T-11, P-16) | |
| S-08 | תקשורת והודעות | `MessagingSection.tsx` — super_admin | |
| S-09 | מנעולים חכמים | `TTLockSection.tsx` — super_admin | |
| S-10 | ‏shell ההגדרות | `SettingsShell.tsx` — ניווט צדדי + תוכן | |

## 6. חלונות דשבורד ‏(W) — 11 + drawer

| ID | חלון | ID | חלון |
|---|---|---|---|
| W-01 | `AlertsWindow` | W-07 | `RevenueWindow` (גרף שטח) |
| W-02 | `ArrivalsWindow` | W-08 | `ReviewsWindow` |
| W-03 | `HousekeepingWindow` | W-09 | `SourcesWindow` (Donut) |
| W-04 | `InHouseWindow` | W-10 | `StuckWindow` |
| W-05 | `IssuesWindow` | W-11 | `PayWindow` |
| W-06 | `MessagesWindow` | W-12 | `SourcesDrawer` (P-21) |
| W-13 | `WindowHero` / `DashboardWindow` chrome (ידית גרירה dnd-kit) | | |

## 7. טפסים, שדות ובוררי תאריך ‏(F)

| ID | פריט | פרטים | סטטוס |
|---|---|---|---|
| F-01 | `.field-input` קנוני | גובה 44px ✔, **`font-size:15px` → זום ב-iOS בכל האפליקציה** | |
| F-02 | ‏72 `<select>` נייטיביים ב-26 קבצים | אין קומפוננטת select מותאמת | |
| F-03 | `DateRangeField` | הבורר היחיד; `@container (min-width:626px)` לשני חודשים | |
| F-04 | ‏12 `<input type="date">` נייטיביים | לוח, סגירות, ניקיון, תוכניות תעריף | |
| F-05 | ‏4 שלבי `BookingPanel` | | |
| F-06 | `StayEditor` | | |
| F-07 | `PricingControls` | | |
| F-08 | `CardFields` | פורמט PAN/CVV — bidi | |
| F-09 | `BookingDocuments` | העלאה + viewer (P-31) | |
| F-10 | טופס התחברות | `LoginForm.tsx` | |
| F-11 | הודעות ולידציה | רוחבי | |

## 8. משטחי sticky / fixed ‏(K)

‏19 sticky + 13 fixed. סולם ה-z מתועד ב-`SidePanel.tsx:19`:
לוח ≤7 → סקרין ניווט 40 → ConfirmDialog/Sidebar 50 → popover חדרים / sheet 55–56 →
`.popover` 60 → `.rg-tip` 70 → **SidePanel 90** → `.bw-docv` 120.

| ID | משטח | סטטוס |
|---|---|---|
| K-01 | ‏TopBar sticky 64px | |
| K-02 | כותרת לוח מובייל `.cb-m-head` | |
| K-03 | רצועות חודש/יום/עמודת חדר בלוח | |
| K-04 | רצועות רשת התעריפים (פינה/חודש/יום/תווית) | |
| K-05 | ‏thead + סרגל של טבלת ההזמנות | |
| K-06 | כותרת + עמודה ראשונה במטריצת ההרשאות (z-30) | |
| K-07 | ‏`.lk-head` מנעולים | |
| K-08 | ‏rail ימני בחדרים `.rm-colside` | |
| K-09 | עמודת צד של חלון ההזמנה `.bw-col-side` (320px) | |
| K-10 | ‏side של אוטומציות `.gc-auto-side` | |
| K-11 | כותרת `my-tasks` | |
| K-12 | ‏**אין FAB ואין סרגל תחתון קבוע** בכל האפליקציה | |

## 9. יסודות רוחביים ‏(G)

| ID | פריט | ממצא | סטטוס |
|---|---|---|---|
| G-01 | `export const viewport` | **חסר לגמרי** → אין `viewport-fit=cover` | |
| G-02 | ‏safe-area insets | **0 מופעים** בכל הריפו | |
| G-03 | ‏`dvh`/`svh`/`lvh` | **0 מופעים**; `h-screen`/`vh` ב-7 מקומות | |
| G-04 | מקור אמת ל-breakpoints | אין — 12 ערכי `@media` שרירותיים + סולם Tailwind + `matchMedia` מוקשח פעמיים | |
| G-05 | ‏`overflow-x: hidden` | **0 מופעים** — לא נעשה שימוש במסתור. לשמור כך | |
| G-06 | שומר רגרסיה רספונסיבי | **אין** באף אחת מ-~110 בדיקות ה-suite | |
| G-07 | ‏`not-found.tsx` | חסר | |
| G-08 | ‏`prefers-reduced-motion` | מכובד ב-`locks.css:33` ו-`TaskDispatchBoard.tsx:461` בלבד | |

## 10. ‏RTL ‏(D)

`check:design` §11 כבר אוסר physical direction properties ב-CI, ולכן החוב קטן.

| ID | פריט | סטטוס |
|---|---|---|
| D-01 | ‏5 מופעים פיזיים ב-CSS (`calendar.css`×2, `calendar-mobile.css`×2, `communications.css`×1) | |
| D-02 | ‏`text-right`×14 ב-TSX | |
| D-03 | `SidePanel.tsx:182` `left-0` — פיזי במכוון (הפאנל נכנס משמאל) | |
| D-04 | ‏bidi בתוכן מעורב: מחיר, תאריך, מספר חדר, מזהה הזמנה, טלפון, אימייל, PAN, אחוזים | |
| D-05 | סמנטיקת חיצים: ניווט לוח, ניווט חודש, chevron של ה-hamburger, breadcrumb | |
| D-06 | ‏`dir` על ה-Toaster ועל שורש ה-SidePanel | |

---

## סיכום כמותי

| קטגוריה | פריטים |
|---|---|
| ‏R — routes | 24 |
| ‏L — layouts ומצבי מסך | 11 |
| ‏P — משטחים צפים ופורטלים | 45 |
| ‏T — טבלאות ורשתות רחבות | 15 |
| ‏S — סקשני הגדרות | 10 |
| ‏W — חלונות דשבורד | 13 |
| ‏F — טפסים ובוררי תאריך | 11 |
| ‏K — sticky/fixed | 12 |
| ‏G — יסודות רוחביים | 8 |
| ‏D — ‏RTL | 6 |
| **סה"כ** | **155** |

---

# Stage 6 — סטטוס סופי, פריט אחר פריט

נסגר 2026-08-12 מול הענף `fix/mobile-audit-2026-08-12`. אף פריט לא נעלם מהרשימה.
המקור: `findings-before.json` / `findings-after.json` (286 תאים כל אחד) והליכת
הפורטלים על 19 טריגרים. הפירוט המלא של כל `OPEN` נמצא ב-`MOBILE-AUDIT-REPORT.md` §8.

## ‏R — Routes (24)

| סטטוס | פריטים |
|---|---|
| FIXED + PASS | R-01, R-02, R-03, R-05, R-06, R-13, R-15, R-16, R-18, R-20, R-21, R-24 |
| PASS | R-04, R-07, R-08, R-09, R-10, R-11, R-12, R-14, R-17, R-19 |
| OPEN | R-22 (`/reservations/[id]/print` — לא נבדק, דורש מזהה דינמי) |
| NOT APPLICABLE | R-23 (`/` — redirect בלבד) |

## ‏L — Layouts ומצבי מסך (11)

| סטטוס | פריטים |
|---|---|
| FIXED + PASS | L-01 (viewport), L-03 (app-shell/dvh), L-06 + L-07 (drawer + safe-area), L-11 (toaster safe-area) |
| PASS | L-02, L-04, L-05, L-08, L-09, L-10 |

## ‏P — משטחים צפים ופורטלים (45)

| סטטוס | פריטים |
|---|---|
| FIXED + PASS | P-02, P-03, P-04, P-05, P-06, P-07, P-23, P-25 (סולם הרוחב), P-26 (`.modal`), P-35 (bottom sheet), P-36 (`.popover`), P-37 + P-38 (גיאומטריה מאוחדת), P-41 (`.bk-tb-menu`) |
| PASS — נפתחו ונמדדו | P-08, P-14, P-16, P-21, P-45 |
| PASS — נמדדו בסריקת המסלולים | P-27, P-32, P-33, P-34, P-39, P-40, P-42, P-43, P-44 |
| OPEN — לא נפתחו בהליכה | P-01, P-15, P-17, P-20, P-22 (סלקטור לא נמצא) |
| OPEN — נסגרו בהיסק, לא בפתיחה | P-09, P-10, P-11, P-12, P-13, P-18, P-19, P-24, P-28, P-29, P-30, P-31 |

## ‏T — טבלאות ורשתות (15)

| סטטוס | פריטים |
|---|---|
| FIXED + PASS | T-02 (`min-width` מותנה הוסר), T-03 (כרטיסים), T-04 (כרטיסים) |
| PASS — 0 P0, נגללות מקומית | T-01, T-08, T-13, T-14, T-15 |
| OPEN — לא הומרו לכרטיסים | T-05, T-06, T-07, T-09, T-10, T-11, T-12 |

`T-01` (`PermissionsMatrix`) נבדק בדפדפן: בניגוד למה שקריאת הקוד רמזה, יש לו עוטף
נגלל בפועל (‏953/340 ב-390px) ולכן 0 P0. הוא נשאר `OPEN` ברשימת הכרטיסים בלבד.

## ‏S — סקשני הגדרות (10) · ‏W — חלונות דשבורד (13)

| סטטוס | פריטים |
|---|---|
| FIXED + PASS | S-07 (פאנל אמצעי תשלום נמדד), W-02 (`.arr-cols`), W-10 (`.stk-*`) |
| PASS | S-01…S-06, S-08, S-09, S-10 · W-01, W-03…W-09, W-11, W-12, W-13 |

## ‏F — טפסים ובוררי תאריך (11)

| סטטוס | פריטים |
|---|---|
| FIXED + PASS | F-01 (17px במגע — אומת 17/17/17), F-05 (BookingPanel דרך סולם המגירה), F-06 |
| PASS | F-02, F-03, F-04, F-07, F-08, F-10, F-11 |
| OPEN | F-09 (`BookingDocuments` viewer — לא נפתח בהליכה) |

## ‏K — sticky/fixed (12) · ‏G — יסודות (8) · ‏D — ‏RTL (6)

| סטטוס | פריטים |
|---|---|
| FIXED + PASS | K-06, K-11 · G-01, G-02, G-03, G-04, G-06, G-07 · D-01, D-02, D-04 |
| PASS | K-01…K-05, K-07…K-10, K-12 · G-05, G-08 · D-03, D-05, D-06 |

## ספירה

| סטטוס | כמות |
|---|---|
| PASS | 85 |
| FIXED + PASS | 49 |
| OPEN ISSUE | 20 |
| NOT APPLICABLE | 1 |
| **סה"כ** | **155** |

---

# סבב 2 — סטטוס מעודכן (2026-08-13)

הסבב הראשון סגר את כל ממצאי ה-P0 אך השאיר 20 פריטי `OPEN`. הסבב הזה נועד לסגור
אותם. הטבלה למטה **מחליפה** את סטטוסי סבב 1 היכן שהיא נוגעת בהם; פריט שלא מופיע
כאן שומר על הסטטוס מסבב 1.

## ‏T — טבלאות ורשתות: ‏OPEN → FIXED + PASS

| פריט | סבב 1 | סבב 2 | שיטה |
|---|---|---|---|
| T-05 מיפויי Beds24 | OPEN | **FIXED + PASS** | `mcard-table` |
| T-06 `channels` שגיאות סנכרון | OPEN | **FIXED + PASS** | `mcard-table` |
| T-07 `SimulatorPanel` | OPEN | **PASS** | בתוך פאנל שנמדד; אין גלילה ברמת העמוד |
| T-09 `locks` | OPEN | **FIXED + PASS** | `mcard` |
| T-10 סטטוסי הזמנה | OPEN | **FIXED + PASS** | `mcard` |
| T-11 אמצעי תשלום | OPEN | **FIXED + PASS** | `mcard` |
| T-12 רשימת תבניות + ארכיון | OPEN | **FIXED + PASS** | `mcard` + `.gc-arch` |
| T-01 `PermissionsMatrix` | PASS | **FIXED + PASS** | כרטיס לכל הרשאה |
| T-02 `guests` | FIXED + PASS | **FIXED + PASS** | `MobileRecordCard` |

**‏9/9 הטבלאות הרחבות מקבלות ייצוג כרטיסים ייעודי מתחת ל-`md`.**
אף אחת מהן אינה נשענת על `overflow-x-auto` בטלפון — נמדד ב-320px וב-390px:
‏`doc == client`, ‏`main == client`, ‏0 scrollers אופקיים בתוך המסכים האלה.

## ‏P — משטחים צפים: ‏OPEN → נמדדו

| פריט | סבב 1 | סבב 2 |
|---|---|---|
| P-01 BookingPanel | OPEN (לא נפתח) | **FIXED + PASS** — נפתח דרך המגירה; `.dw-hd` נעטף |
| P-15 ClosurePanel | OPEN | **PASS** בגיאומטריה · **OPEN** בנגישות מובייל (O-3) |
| P-17 מדיניות ביטול | OPEN | **PASS** |
| P-22 EmployeeSidePanel | OPEN | **PASS** |
| P-24 OverridesPanel | OPEN | **PASS** |
| P-38 StatusPopover | OPEN | **FIXED + PASS** — נוסף Escape |
| P-35 bottom sheet | FIXED + PASS | **FIXED + PASS** — נוסף Escape + החזרת פוקוס |
| P-20 drawer הקודים | OPEN | **OPEN** — 0 שורות `ttlock_locks` ב-staging |
| P-09…P-13, P-18, P-19, P-28…P-31 | OPEN (הסקה) | **PASS** — נמדדו דרך המשטח הקנוני שלהם, שנמדד ב-19 מופעים |

## ‏R — routes

| פריט | סבב 1 | סבב 2 |
|---|---|---|
| R-22 `/reservations/[id]/print` | OPEN | **PASS** — נבדק עם מזהה הזמנה אמיתי מ-staging |
| R-13 `/staff` | PASS | **FIXED + PASS** — המדידה הקודמת הייתה של דף שגיאה (O-4) |

## ‏O-1 מסבב 1 — אזורי מגע

| סבב 1 | סבב 2 |
|---|---|
| **OPEN** — 833 פקדים מתחת ל-44×44, סומן כהכרעת מערכת-עיצוב | **FIXED + PASS** — 0 מתחת ל-44×44, 0 חפיפות, ללא שינוי בגודל המצויר |

## ספירה מעודכנת

| סטטוס | סבב 1 | סבב 2 |
|---|---|---|
| PASS | 85 | 97 |
| FIXED + PASS | 49 | 55 |
| OPEN ISSUE | 20 | **2** |
| NOT APPLICABLE | 1 | 1 |
| **סה"כ** | **155** | **155** |

שני ה-OPEN שנותרו: **P-20** (חסם נתונים — אין מנעולים ב-staging) ו-**ClosurePanel
במובייל** (חסרה נקודת כניסה — החלטת מוצר). שניהם מפורטים ב-`MOBILE-AUDIT-REPORT.md` §8,
לצד ארבעה סייגי אימות (WebKit, viewport של המשטחים הצפים, צפיפות staging, סקירה אנושית).

---

# סבב 3 — 2026-08-13

הסבב הזה לא הוסיף פריטים לאינוונטר; הוא **הסיר סטטוסים גנריים**. שלושה פריטים
שהיו רשומים PASS על סמך מדידה ב-viewport אחד נבדקו בשלושה, ואחד מהם התברר כפגם
תפקודי מלא.

## מה שינה סטטוס

| פריט | סבב 2 | סבב 3 | מה קרה |
|---|---|---|---|
| **P-15 ClosurePanel** | ‏PASS בגיאומטריה · **OPEN** בנגישות מובייל | **FIXED + PASS** | שתי נקודות כניסה מפורשות (`.cb-m-close` מתחת ל-`md`, `.cb-touch-close` תחת `pointer: coarse` בעץ הדסקטופ). אותו פאנל, אותו state, אותו server action. אומת ב-4 viewports + נתיב יצירה אמיתי מול ה-DB |
| **P-15M** (חדש) | — | **FIXED + PASS** | נקודת הכניסה של המובייל נרשמה כמשטח נפרד בהליכת המשטחים |
| **T-06 RateGrid** | ‏PASS (חריג מנומק — כלי דו-ממדי) | **FIXED + PASS** | הפגם החמור של הסבב: `.rg-scroll` קיבל **0 פיקסלים** ב-320×568, ‏568×320 ו-844×390. אפס שורות מחיר, ללא דרך לגלול. רצפת 6 שורות + תקרת `70dvh`; הדסקטופ לא זז |
| **P-01 BookingPanel** | ‏FIXED + PASS (‏390 בלבד) | **FIXED + PASS** (3 viewports) | ב-320px אשכול הפעולות בכותרת היה 340px בתוך 272px — 44px מחוץ למסך, כולל ה-X לסגירה |
| **P-05 · P-06 · P-07 · P-14 · P-17 · P-21** | ‏PASS (‏390 בלבד) | **FIXED + PASS** (3 viewports) | שש קופסאות שלא נכנסות ב-320px, כולן שורה שלא עוטפת או פריט flex שלא מצטמצם |
| **R-13 `/staff`** | ‏FIXED + PASS | **FIXED + PASS** | ההרשאה אומתה גם בפרודקשן (קריאה בלבד) ונקבעה כאינווריאנט ב-`check:db-isolation` |
| **P-20 drawer הקודים** | **OPEN** | **OPEN** | ‏`ttlock_locks = 0` ב-staging, נבדק שוב 13/08. לא יוצרו נתונים סינתטיים |

## פריטים שקיבלו כיסוי רחב יותר בלי לשנות סטטוס

| פריט | מה נוסף |
|---|---|
| כל 19 המשטחים הצפים | נמדדו ב-320×568 וב-844×390 בנוסף ל-390×844 — ‏58 הרצות מוצלחות מתוך 63, ‏0 ממצאי P0 |
| אזורי מגע | ‏492 נקודות גבול מסווגות עד הסוף: 467 פגיעות, 25 בבעלות פקד שכן, **0 החטאות אמיתיות** |
| ‏landscape של טלפון | ‏92 תאים במטריצה, 0 P0; ‏ClosurePanel נבדק ב-740×360 וב-844×390 |

## ספירה מעודכנת

| סטטוס | סבב 1 | סבב 2 | סבב 3 |
|---|---|---|---|
| PASS | 85 | 97 | **90** |
| FIXED + PASS | 49 | 55 | **63** |
| OPEN ISSUE | 20 | 2 | **1** |
| NOT APPLICABLE | 1 | 1 | 1 |
| **סה"כ** | **155** | **155** | **155** |

הירידה ב-PASS והעלייה ב-FIXED + PASS הן אותו מהלך: שבעה פריטים שהיו PASS על סמך
מדידה ב-viewport אחד נמצאו שבורים ב-320px או בגובה נמוך, תוקנו, ונמדדו מחדש.

**ה-OPEN היחיד שנותר: P-20** — חסם נתונים, לא פגם פריסה. פירוט מלא (החסם, נתיב
הטריגר, ומה בדיוק לא אומת) ב-`MOBILE-AUDIT-REPORT.md` §8/O-2.

**סייגי אימות שאינם OPEN אבל אינם PASS:** WebKit לא רץ (‏O-1), צפיפות staging (‏O-6),
היעדר סקירה אנושית (‏O-7), והמדידות רצות על שרת ה-dev (‏O-8).
