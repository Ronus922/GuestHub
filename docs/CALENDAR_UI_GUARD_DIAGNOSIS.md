# אבחון: `check:calendar-ui` אדום על main — שורת הערוץ בכרטיס ההזמנה

**סטטוס: אבחון בלבד. שום תיקון לא הוחל.** המסמך הזה לא משנה אף קובץ מקור, אף
סקריפט ואף assertion. התיקון המוצע (§5) כתוב כ‑diff מוכן להחלה, **ולא הוחל**.

- בסיס האבחון: `origin/main` = `5b171bd` (Merge PR #102), עץ עבודה נקי.
- הרצה ב‑worktree מבודד: `/home/ubuntu/worktrees/night-t5-calendar-diag`.
- הבדיקה נכשלת גם ללא שום שינוי מקומי — זו כשלות של `main` עצמו.

---

## 1. שחזור

```bash
git -C /var/www/guesthub worktree add <wt> -b <branch> origin/main
cd <wt> && pnpm install --frozen-lockfile
pnpm check:calendar-ui
```

פלט מדויק (exit code 1):

```
> guesthub@0.1.0 check:calendar-ui /home/ubuntu/worktrees/night-t5-calendar-diag
> node scripts/check-calendar-ui.mjs

node:internal/modules/run_main:123
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: the channel row is CONDITIONAL — an internal reservation gets no row, not an empty one
    at file:///home/ubuntu/worktrees/night-t5-calendar-diag/scripts/check-calendar-ui.mjs:372:8 {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: false,
  expected: true,
  operator: '=='
}

Node.js v20.20.1
 ELIFECYCLE  Command failed with exit code 1.
```

**נקודת כשל יחידה.** כל 200+ ה‑assertions שלפניה עוברות; זו הראשונה שנופלת,
והריצה נעצרת בה (אין assertions נוספות אחריה שנבדקו).

---

## 2. מה השומר דורש מול מה הקוד מרנדר

### הדרישה — `scripts/check-calendar-ui.mjs:372-373`

```js
assert.ok(/\{channel && \(\s*<p className="cb-pl">/.test(body),
  "the channel row is CONDITIONAL — an internal reservation gets no row, not an empty one");
```

ההקשר שמעליה (`scripts/check-calendar-ui.mjs:360-365`) מסביר את הכוונה:

```js
// The channel row CONSOLIDATED the old free-text "מקור" row (it sits between
// nights and money, per the channel-badge spec) — the normalized channel name +
// the SAME <ChannelBadge> the pill wears, so the card can never show a second,
// diverging source. It renders ONLY for a visible external/site channel: an
// internal reservation (phone/walk_in/unknown/NULL) shows a three-row body
// with no empty row or gap. The forbidden-row assertions below are unchanged.
```

כלומר: הבדיקה דורשת ליטרלית את התבנית `{channel && (<p className="cb-pl">` —
רינדור מותנה, כי `channel` יכול להיות `null`.

### המצב בפועל — `src/app/(dashboard)/calendar/ReservationTooltip.tsx`

שורות 93-94 — הערוץ נפתר דרך `resolveChannelBadge`, שלעולם אינו מחזיר `null`:

```tsx
  // every reservation shows a channel row: external channel, or the manual pencil
  const channel = resolveChannelBadge(stay.source_key);
```

שורות 188-196 — השורה מרונדרת **ללא תנאי**:

```tsx
        {/* the channel row CONSOLIDATES the old free-text "מקור" row: one
            normalized name + the same badge the pill wears (md, no ring). */}
        <p className="cb-pl">
          <Icon name="hub" size={17} className="cb-pli" />
          <span>
            ערוץ: <b>{CHANNEL_CONFIG[channel].name}</b>
          </span>
          <ChannelBadge channel={channel} size="md" />
        </p>
```

והפונקציה עצמה — `src/lib/colors.ts:123-130`:

```ts
// EVERY reservation gets a pill badge: its external channel, or the "manual"
// pencil for internal/unknown sources. Use this for the badge; keep
// normalizeVisibleChannel for the "is this an OTA booking?" semantic check.
export function resolveChannelBadge(
  sourceKey: string | null | undefined,
): BadgeChannel {
  return normalizeVisibleChannel(sourceKey) ?? "manual";
}
```

**הפער:** השומר מחפש `{channel && (` על ערך שכבר לא יכול להיות falsy. הרינדור
המותנה לא רק שלא קיים — הוא הפך למיותר לוגית.

שאר ה‑assertions של אותו בלוק עדיין עוברות: גוף הכרטיס מצהיר בדיוק ארבע שורות
(`rows.length === 4`), וסדר השורות (`rowOrder`, כולל שורת ה‑`hub` עם
`CHANNEL_CONFIG[channel].name` ו‑`<ChannelBadge channel={channel} size="md" />`)
תואם. נופל **רק** תנאי ה‑`{channel && (`.

---

## 3. הקומיט השובר

| | |
|---|---|
| SHA | `2ab6ae1010cff3ac9dd80f2f585e3ac563cdec41` |
| תאריך | 2026-07-21 (מוזג ל‑main ב‑2026-07-24 18:05 UTC, merge `900bed7`) |
| כותרת | `feat(calendar): pixel-fix desktop toolbar + net-new mobile timeline (D107)` |
| PR | [#95 — feat(calendar): pixel-fix desktop toolbar + net-new mobile timeline (D107)](https://github.com/Ronus922/GuestHub/pull/95) |

### ה‑hunk שגרם לסטייה

```diff
diff --git a/src/app/(dashboard)/calendar/ReservationTooltip.tsx b/src/app/(dashboard)/calendar/ReservationTooltip.tsx
@@ -90,8 +90,8 @@ export function ReservationTooltip({
   const { stay, room } = target;
-  // null for internal reservations → the card simply has no channel row
-  const channel = normalizeVisibleChannel(stay.source_key);
+  // every reservation shows a channel row: external channel, or the manual pencil
+  const channel = resolveChannelBadge(stay.source_key);
@@ -186,17 +186,14 @@
         {/* the channel row CONSOLIDATES the old free-text "מקור" row: one
-            normalized name + the same badge the pill wears (md, no ring).
-            Rendered ONLY for a visible channel — no empty row, no gap. */}
-        {channel && (
-          <p className="cb-pl">
-            <Icon name="hub" size={17} className="cb-pli" />
-            <span>
-              ערוץ: <b>{CHANNEL_CONFIG[channel].name}</b>
-            </span>
-            <ChannelBadge channel={channel} size="md" />
-          </p>
-        )}
+            normalized name + the same badge the pill wears (md, no ring). */}
+        <p className="cb-pl">
+          <Icon name="hub" size={17} className="cb-pli" />
+          <span>
+            ערוץ: <b>{CHANNEL_CONFIG[channel].name}</b>
+          </span>
+          <ChannelBadge channel={channel} size="md" />
+        </p>
```

`2ab6ae1` נגע ב‑16 קבצים — **ואף אחד מהם אינו `scripts/check-calendar-ui.mjs`**
(וגם לא `scripts/check-channels-badge.mjs`, וגם לא `DECISIONS.md`). המוצר זז,
השומר נשאר במקום.

### הוכחה (bisect ידני, worktree detached עם אותו `node_modules`)

```
### at 2ab6ae1 (D107):
AssertionError [ERR_ASSERTION]: the channel row is CONDITIONAL — an internal reservation gets no row, not an empty one
### at 2ab6ae1^ (parent):
check-calendar-ui: all interaction/geometry rules hold ✔
```

ההורה ירוק, הקומיט אדום — סטייה חד‑משמעית ב‑`2ab6ae1`. בנוסף, זהו הקומיט
**האחרון** שנגע ב‑`ReservationTooltip.tsx` (`git log --follow`), ולכן שום קומיט
מאוחר יותר לא יכול היה להחזיר את התנאי.

### מי כתב את ה‑assertion, ולמה

`scripts/check-calendar-ui.mjs:372` נולד ב‑`1933e78`
(`fix(calendar): show the channel badge only for external/site channels`,
2026-07-17), ארבעה ימים לפני D107. גוף הקומיט ההוא:

> Internal reservations (phone/walk_in/manual/NULL/unknown source) wear NO
> badge anywhere: the pill starts with the VIP star or the guest name, the
> popover simply has no channel row, and the legend carries exactly four
> entries… `normalizeChannel` became `normalizeVisibleChannel` →
> `VisibleChannel | null`…

כלומר: ה‑assertion מקודדת **מודל מוצר קודם**, ש‑D107 החליף במפורש.

---

## 4. ההכרעה: **שומר מיושן (stale check)** — לא רגרסיה

התיקון הנכון הוא לעדכן את `check-calendar-ui.mjs`, לא להחזיר את התנאי לרכיב.
הראיות:

1. **הכוונה מוצהרת בגוף ה‑PR ובגוף הקומיט.** PR #95, סעיף "Channel badges
   (app-wide)": *"`resolveChannelBadge()` → site = globe, manual = pencil;
   `normalizeVisibleChannel` kept null-returning so the `EditReservationPanel`
   OTA check is unaffected. Legend stays 4 channels."* זו החלטת מוצר מפורשת,
   רוחבית, לא תופעת לוואי של ריפקטור.

2. **הרפרנס של הבעלים מחייב את התג הידני.** `ref/screens/GuesthubCalandrFix.png`
   (התמונה ש‑D107 מומש לפיה, במפורש בגוף ה‑PR) מציגה פסים עם **תג עיפרון אפור**
   על הזמנות פנימיות (למשל שרה גולן / חדר 103, תום שגב / חדר 202), לצד המקרא
   שנשאר בדיוק ארבעה ערוצים. המודל "לכל הזמנה יש זהות ערוץ נראית" הוא מה
   שהבעלים אישר; המודל "הזמנה פנימית בלי תג" הוא מה שהוחלף.

3. **המודל החדש מיושם באופן עקבי בכל חמשת המשטחים** — לא נקודתית בטולטיפ:
   - `CalendarGrid.tsx:1550,1584` — הפס בדסקטופ (`resolveChannelBadge` + תג ללא תנאי)
   - `CalendarGrid.tsx:972,1150` — רוח הגרירה (drag ghost)
   - `MobileCalendar.tsx:142,159` — ציר הזמן במובייל
   - `MobileDetailSheet.tsx:52,104` — גיליון הפרטים במובייל
   - `ReservationTooltip.tsx:94,190` — כרטיס ההזמנה

   רגרסיה מקרית לא מתפרסת באופן זהה על חמישה משטחים ועל שכבת הטוקנים
   (`BadgeChannel`, `CHANNEL_CONFIG.manual`, `ChannelBadge` שמקבל `BadgeChannel`).

4. **הדאגה שה‑assertion נועדה למנוע כבר לא קיימת.** הנוסח שלה —
   *"an internal reservation gets no row, not an empty one"* — מגן מפני **שורה
   ריקה / רווח**. תחת D107 השורה לעולם אינה ריקה: היא מציגה
   `ערוץ: הזמנה ידנית` + תג עיפרון (`CHANNEL_CONFIG.manual`, `src/lib/colors.ts:95`).
   הנחת היסוד של השומר (ש‑`channel` יכול להיות `null`) בטלה, לא מופרת.

5. **אין החלטה חיה שסותרת.** `DECISIONS.md` (עד D93), `STATE.md` ו‑
   `PROJECT_OVERVIEW.md` אינם מזכירים כלל את כלל "אין תג להזמנה פנימית" ואינם
   מזכירים `ChannelBadge`. הסמכות היחידה לכלל הישן הייתה גוף הקומיט `1933e78`,
   ש‑D107 (מאוחר יותר, ומול רפרנס מאושר של הבעלים) מחליף.

**הסתייגות שכן קיימת, ואינה משנה את ההכרעה:** ל‑D107 **אין רשומה ב‑`DECISIONS.md`**
— הקובץ מסתיים ב‑D93, בעוד מספרי D94+ (D107 כאן, D108 ב‑`docs/BEDS24_COMPLETION_PLAN.md`)
מוזכרים בקומיטים ובמסמכים. זהו פער תיעוד אמיתי, וההמלצה בסוף §5 מטפלת בו. הוא
לא הופך את השינוי לרגרסיה: כוונת המוצר מתועדת בגוף ה‑PR, ברפרנס המאושר ובקוד.

---

## 5. התיקון המוצע — **NOT APPLIED**

הכיוון: לנעול את המודל של D107 במקום את המודל שקדם לו — ולנעול אותו **חזק**,
כך שהשורה לא תוכל לחזור להיות מותנית או ריקה.

```diff
--- a/scripts/check-calendar-ui.mjs
+++ b/scripts/check-calendar-ui.mjs
@@ -358,13 +358,22 @@
 // The channel row CONSOLIDATED the old free-text "מקור" row (it sits between
 // nights and money, per the channel-badge spec) — the normalized channel name +
 // the SAME <ChannelBadge> the pill wears, so the card can never show a second,
-// diverging source. It renders ONLY for a visible external/site channel: an
-// internal reservation (phone/walk_in/unknown/NULL) shows a three-row body
-// with no empty row or gap. The forbidden-row assertions below are unchanged.
+// diverging source. D107 (PR #95, ref/screens/GuesthubCalandrFix.png) made the
+// row UNCONDITIONAL: every reservation resolves to a badge channel — an external
+// channel or the "manual" pencil — so the card always states its origin and the
+// row can never come out empty. The forbidden-row assertions below are unchanged.
 const rowOrder = [
   ["stay dates", /name="calendar"[\s\S]*?hebDayMonth\(stay\.check_in\)/],
   ["nights + room + status", /name="moon"[\s\S]*?<b>\{nights\}<\/b> לילות · חדר/],
   ["channel", /name="hub"[\s\S]*?CHANNEL_CONFIG\[channel\]\.name[\s\S]*?<ChannelBadge channel=\{channel\} size="md" \/>/],
   ["total + balance", /name="finance"[\s\S]*?total_price\.toLocaleString\(\)/],
 ];
-assert.ok(/\{channel && \(\s*<p className="cb-pl">/.test(body),
-  "the channel row is CONDITIONAL — an internal reservation gets no row, not an empty one");
+// D107: the row is unconditional, and it is SAFE only because the channel is
+// resolved through resolveChannelBadge() — which never returns null. Bringing
+// back the null-returning normalizeVisibleChannel() here would render
+// `ערוץ: undefined` (or crash on CHANNEL_CONFIG[null]) instead of a manual
+// pencil, so both halves are locked together.
+assert.ok(/const channel = resolveChannelBadge\(stay\.source_key\)/.test(tooltip),
+  "the card resolves its channel with resolveChannelBadge — never null, so the row is never empty");
+assert.ok(!/normalizeVisibleChannel/.test(tooltip),
+  "the null-returning normalizer must NOT be used for the card badge (that is what needed a conditional)");
+assert.ok(!/\{channel && \(/.test(body),
+  "the channel row is UNCONDITIONAL (D107) — external channel or the manual pencil, never a hidden row");
 assert.ok(!/source_label|מקור:/.test(tooltip), "the old free-text source row is consolidated, not duplicated");
```

שלוש הצהרות במקום אחת, ואף אחת מהן אינה מוחלשת: הקיום והסדר של השורה כבר נעולים
ב‑`rows.length === 4` וב‑`rowOrder`, והתוספת נועלת גם את המקור שממנו מגיע הערך.

שלוש ההצהרות הורצו כ‑dry‑run מול המקור הנוכחי (סקריפט חד‑פעמי מחוץ לריפו, שמשכפל
את הפשטת ההערות וחיתוך ה‑`body` של השומר) והחזירו ירוק — בלי לגעת ב‑
`scripts/check-calendar-ui.mjs`.

**ניקוי נלווה (אופציונלי, לא נדרש לירוק).** הערת ה‑JSX ב‑
`src/app/(dashboard)/calendar/ReservationTooltip.tsx:166-170` נשארה מהמודל הישן
וסותרת את הקוד שמתחתיה:

```tsx
      {/* the approved body: compact rows — dates, nights+room, channel (only
          for a visible external/site channel; an internal reservation has no
          channel row at all), money. …
```

הסקריפט מפשיט הערות לפני הבדיקה, ולכן זה לא משפיע על אדום/ירוק — אבל זו הערה
שקרית בקוד, וכלל הברזל של הריפו הוא שהערה שגויה גרועה מאין הערה.

**המלצה משלימה:** לפתוח רשומת `DECISIONS.md` שמתעדת את D107 (או לחלופין לרשום
במפורש שהמספור D94+ חי בגוף ה‑PRs), כדי שלשומר תהיה סמכות כתובה לצטט. אחרת
התרחיש הזה יחזור: שני שומרים ננעלו על החלטה שלא נכתבה מעולם.

---

## 6. רדיוס פגיעה של התיקון המוצע

1. **`pnpm check:channels-badge` אדום על main מאותה סיבה בדיוק, ולא ייפתר מהתיקון הזה.**
   פלט נוכחי:

   ```
   AssertionError [ERR_ASSERTION]: exactly four visible channel definitions — no manual entry
   actual: [ 'airbnb', 'booking', 'expedia', 'manual', 'site' ]
   expected: [ 'airbnb', 'booking', 'expedia', 'site' ]
       at scripts/check-channels-badge.mjs:22:8
   ```

   הוא נופל בהצהרה הראשונה, ולכן לפחות שלוש הצהרות נוספות שם ידועות כמיושנות
   ויתגלו רק אחרי שהראשונה תתוקן:
   - `CHANNEL_CONFIG.site` נבדק כ‑`{ glyph: "S", … }` — היום `{ icon: "globe", … }` (D107).
   - `ChannelBadge` נבדק כ‑`channel: VisibleChannel;` — היום `channel: BadgeChannel;`.
   - `assert.doesNotMatch(badge, /name="edit"|Icon/)` — היום הרכיב מרנדר `<Icon>`
     עבור site/manual.

   מה שכן נשאר תקף שם ואסור לגעת בו: כל נתיבי ה‑`null` של
   `normalizeVisibleChannel` (phone/walk_in/manual/unmapped/null/undefined),
   ו‑`CHANNEL_ORDER` בן ארבעת האיברים — המקרא באמת נשאר ארבעה ערוצים
   (`ref/screens/GuesthubCalandrFix.png`). כל עדכון שם חייב לשמור על ההפרדה:
   `normalizeVisibleChannel` = "האם זו הזמנת OTA?" (מותר `null`),
   `resolveChannelBadge` = "איזה תג להציג?" (לעולם לא `null`).

2. **תלות שקטה שנשענת על `normalizeVisibleChannel`:** בדיקת ה‑OTA ב‑
   `EditReservationPanel` (מצוין במפורש ב‑PR #95). כל ניסיון "לפשט" ולאחד את שתי
   הפונקציות ישבור אותה — התיקון המוצע דווקא מקבע את ההפרדה.

3. **מה עדיין לא ייתפס אחרי התיקון:** ההצהרות הן טקסטואליות על המקור (regex),
   לא רינדור אמיתי. מחיקה מוחלטת של השורה עדיין תיתפס (`rows.length === 4` +
   `rowOrder`), אבל שינוי סמנטי בתוך `resolveChannelBadge` עצמה (למשל החזרת
   `null`) ייתפס רק ע"י `check:channels-badge` — עוד סיבה לתקן את שניהם באותה
   נשימה.

4. **אין השפעה על build/typecheck/lint.** התיקון המוצע נוגע רק בקובץ בדיקה, ואינו
   משנה קוד רץ. אין `check:*` מצרפי שמריץ את השניים יחד ב‑`package.json`, ולכן
   כל אחד מהם צריך להיות מורץ במפורש בסוף השלב.

5. **הקשר סביבתי (לא קשור לשומר הזה):** `pnpm check:design` אדום גם הוא על main
   — 6 הפרות, כולן ב‑`src/app/housekeeping/**` (המודול המוקפא לפי `STATE.md`).
   אין לזה קשר לכרטיס ההזמנה ולא לשינוי המוצע; מצוין כאן רק כדי שלא ייחשב
   בטעות כנזק נלווה.

---

## 7. סיכום בשורה אחת

`2ab6ae1` (D107, PR #95) הפך את שורת הערוץ בכרטיס ההזמנה לבלתי‑מותנית — במכוון,
מול רפרנס מאושר של הבעלים, ובאופן אחיד על חמישה משטחים — ולא עדכן את שני
השומרים שקודדו את המודל הקודם. **השומר מיושן; המוצר תקין.** התיקון שייך ל‑
`scripts/check-calendar-ui.mjs` (ולאחיו `scripts/check-channels-badge.mjs`),
ולא ל‑`ReservationTooltip.tsx`.
