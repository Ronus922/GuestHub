# ‏RESPONSIVE-INVENTORY — מיפוי מלא לפני תיקונים

- **בסיס:** `origin/main` @ `7844321` · ענף `fix/responsive-rtl-2026-08-12` · worktree `~/worktrees/guesthub-responsive`
- **סביבה:** Next.js 15.5.20 (App Router) · React 19.1 · **Tailwind 4.3.2** · TypeScript strict
- **ספריית רכיבים:** **אין.** ‏0 חבילות Radix/shadcn/MUI/Headless — שכבת רכיבים מקומית.
  משמעות: אין `DirectionProvider` ואין `theme.direction` להגדיר; ה-portal היחיד מנוהל ידנית.
- **בסיס הכיוון:** `<html lang="he" dir="rtl">` — האפליקציה **RTL-first מלידה**, לא LTR שמומר.

> **הקשר קריטי למי שקורא את הדוח הזה:** ‏PR #199 (מוזג ל-`main` ב-13/08, **טרם נפרס**)
> כבר ביצע מעבר רספונסיביות ו-RTL מלא: יסודות viewport/dvh/safe-area, ‏9/9 טבלאות
> לכרטיסי מובייל, תקרות למשטחים צפים, ‏Escape+פוקוס, יעדי מגע 44×44, והמרה של **כל**
> ה-CSS לתכונות לוגיות. המיפוי כאן נעשה על העץ שאחרי #199, ולכן הוא מתאר את מה
> ש**נשאר**, לא את המצב ההתחלתי.

---

## 1 · ראוטים (20 עמודים + 3 קבצי מצב)

| # | ראוט | auth | state שנדרש כדי להגיע |
|---|---|---|---|
| R-01 | `/` | — | redirect ל-`/dashboard` או `/login` |
| R-02 | `/login` | **ציבורי** | הקשר דפדפן **לא-מחובר**; מחובר → middleware מחזיר ל-`/` |
| R-03 | `/(dashboard)/dashboard` | ✔ | — |
| R-04 | `/(dashboard)/calendar` | ✔ | — |
| R-05 | `/(dashboard)/rates` | ✔ | — |
| R-06 | `/(dashboard)/rate-plans` | ✔ | — |
| R-07 | `/(dashboard)/reservations` | ✔ | — |
| R-08 | `/(dashboard)/guests` | ✔ | — |
| R-09 | `/(dashboard)/rooms` | ✔ | — |
| R-10 | `/(dashboard)/housekeeping` | ✔ | — |
| R-11 | `/(dashboard)/maintenance` | ✔ | — |
| R-12 | `/(dashboard)/locks` | ✔ | — |
| R-13 | `/(dashboard)/channels` | ✔ | — |
| R-14 | `/(dashboard)/settings` | ✔ | סקשן נבחר ב-`?section=` (‏10 סקשנים) |
| R-15 | `/(dashboard)/staff` | ✔ | דורש הרשאת `auth.users` — ראה §5 |
| R-16 | `/(dashboard)/permissions` | ✔ | — |
| R-17 | `/(dashboard)/communications` | ✔ | redirect לסקשן ברירת מחדל |
| R-18 | `/(dashboard)/communications/[section]` | ✔ | **5 ערכים**: `templates` · `automations` · `history` · `channels` · `archive` |
| R-19 | `/housekeeping/my-tasks` | ✔ | מסך **קפוא** (STATE.md) — נמצא ריק בצפיפות staging |
| R-20 | `/reservations/[id]/print` | ✔ | **מזהה הזמנה אמיתי** — לא ניתן להמצאה |
| R-21 | `not-found` (‏404) | — | כל כתובת שאינה קיימת |
| R-22 | `(dashboard)/error.tsx` | ✔ | error boundary — דורש זריקה |
| R-23 | ‏3 × `loading.tsx` | ✔ | ‏calendar · communications · permissions · staff |

**‏API/uploads (‏17 `route.ts`)** — ללא UI, מחוץ להיקף.

---

## 2 · משטחים צפים — 27 (**אלה שנופלים, ולא מופיעים ברשימת ראוטים**)

**מנגנון ה-portal היחיד:** `src/components/ui/SidePanel.tsx` → `createPortal`.
שורש ה-portal נושא **`dir="rtl"` מפורש** — זה התחליף המקומי ל-`DirectionProvider`.

| קבוצה | רכיב | סוג | איך מגיעים |
|---|---|---|---|
| מגירות | `SidePanel` (בסיס משותף) | drawer + portal | כל הפאנלים למטה עוברים דרכו |
| | `BookingPanel` | drawer | `/reservations` → "הזמנה חדשה" |
| | `EditReservationPanel` | drawer | `/reservations` → שורה/כרטיס |
| | `ClosurePanel` | drawer | `/calendar` → קליק ימני (דסקטופ) · כפתור "חסימת חדר" (מגע) |
| | `RoomWizard` · `AreaPanel` | drawer | `/rooms` |
| | `RatePlanWizard` · `SimulatorPanel` · `OverridesPanel` | drawer | `/rate-plans` |
| | `GroupUpdatePanel` · `CellDetailPanel` | drawer | `/rates` |
| | `EmployeeSidePanel` | drawer | `/staff` |
| | `TemplateEditor` · `HtmlTemplateEditor` · `WhatsAppTemplateEditor` | drawer | `/communications/templates` |
| | `SourcesDrawer` | drawer | `/dashboard` |
| | `PaymentMethodsCard` panel · `CancellationSection` panel | drawer | `/settings` |
| | `LocksBoard` code drawer | drawer | `/locks` — **BLOCKED**: ‏0 שורות `ttlock_locks` ב-staging |
| דיאלוגים | `MoveConfirmDialog` | modal | גרירת הזמנה בלוח |
| | `ConfirmDialog` (channels) | modal | `/channels` |
| | `CancelReservationDialog` | modal | פאנל עריכה → "בטל הזמנה" |
| | `BookingActions` · `BookingComReports` · `BookingDocuments` | modal | פאנל עריכה → כותרת |
| | `editorShared` dialog | modal | עורכי תבניות |
| | `RoomsScreen` dialog | modal | `/rooms` |
| גיליון | `MobileDetailSheet` | bottom sheet | `/calendar` מתחת ל-`md` |
| פופאוברים | `ReservationTooltip` | tooltip | ריחוף על הזמנה בלוח |
| | `StatusPopover` (‏`RateCells`) | popover | `/rates` → תא |
| | `DateRangeField` | popover | כל בורר תאריכים |
| | `ChannelBadge` | tooltip | תגי ערוץ |
| | `LocationPicker` | popover | `/settings` |
| | תפריט הפעולות (`.bk-tb-menu`) | menu | פאנל עריכה → "פעולות" |
| | מגירת ניווט מובייל | drawer | המבורגר מתחת ל-`md` |
| toasts | `sonner` | toast | ‏20+ מסכים |

---

## 3 · טבלאות, גרידים וטפסים

| סוג | כמות | הערה |
|---|---|---|
| `<table>` אמיתי | **7** | channels ×2 · permissions · rate-plans simulator · reservations · staff ×2 |
| רשתות CSS-grid בתפקיד טבלה | **48 הצהרות `display:grid`** | לוח התעריפים, מטריצת ההרשאות, לוחות הניקיון |
| `<form>` | **6** | שאר הטפסים מנוהלים ב-state בלי אלמנט form |
| ‏`<input>` / `<textarea>` | **197** | ראה §4 — פער `dir` |

---

## 4 · ‏fixed / sticky — 23 הצהרות

| קובץ | מה |
|---|---|
| `rate-grid.css` (5) | כותרות חודש/יום דביקות + עמודת התווית + פופאובר `fixed` |
| `calendar.css` (3) · `calendar-mobile.css` (3) | כותרות הלוח, גיליון תחתון `fixed` |
| `booking-window.css` (3) | כותרת/פוטר המגירה + overlay |
| `reservations-list.css` (2) · `rooms.css` (2) · `locks.css` · `communications.css` · `group-update.css` | כותרות טבלה דביקות |
| `design-system.css` · `responsive.css` | ‏overlay בסיסי + תיעוד ה-`dvh` |

---

## 5 · פריטים חסומים (לא מדולגים בשקט)

| פריט | חסם |
|---|---|
| `/locks` code drawer | ‏0 שורות `ttlock_locks` ב-staging. אין דרך לפתוח אותו בלי להמציא נתונים |
| `/reservations/[id]/print` | דורש מזהה הזמנה אמיתי מ-staging |
| `/staff` | דורש `GRANT SELECT (id, last_sign_in_at, created_at) ON auth.users` — בלעדיו הראוט מרנדר error boundary |
| `(dashboard)/error.tsx` | דורש זריקת שגיאה מכוונת |
| ‏WebKit/iOS אמיתי | דורש התקנת תלויות מערכת ב-`sudo` על מארח משותף שמריץ פרודקשן |
