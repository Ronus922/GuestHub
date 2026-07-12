# GuestHub — הנחיות עיצוב מחייבות (מקור אמת יחיד)

מסמך זה מחייב לכל מסך קיים וחדש. כל ערך שלא מופיע כאן — אסור.
המטרה: מבנה אחיד אחד לכל רכיב, ללא וריאציות פר-מסך.

---

## 0. עקרון-על

1. כל הצבעים, הגדלים והמרווחים נלקחים **רק** מהטוקנים בסעיף 1–2. אין ערכים "כמעט דומים" (‎#E4E8F0 לצד ‎#E7EAF1 — אסור; יש טוקן קו אחד).
2. כל רכיב (צ'יפ, שדה, כפתור, כרטיס…) ממומש עם **מחלקת CSS אחת גלובלית** — לא סטיילים מקומיים פר-מסך.
3. font-size מותר **רק** מתוך הסקאלה בסעיף 2. כל ערך אחר (12.5, 13, 14.5, 16, 22, 24…) — לתקן לערך הקרוב בסקאלה.

---

## 1. טוקנים — CSS Variables (להגדיר פעם אחת ב-:root)

```css
:root {
  /* מותג */
  --brand:        #2540C8;   /* כחול ראשי */
  --brand-hover:  #1C2E9A;
  --brand-soft:   #EEF1FD;   /* רקע כחלחל: כפתור "היום", אווטאר, עמודת היום */
  --brand-line:   #DFE5FB;

  /* בסיס */
  --ink:          #1B2233;   /* טקסט ראשי */
  --muted:        #6B7385;   /* טקסט משני */
  --faint:        #9AA1B4;   /* טקסט חלש: רמזים, placeholders */
  --line:         #E7EAF1;   /* כל המסגרות והקווים — טוקן יחיד */
  --bg:           #F1F3F8;   /* רקע אפליקציה */
  --surface:      #FFFFFF;   /* רקע כרטיסים */
  --field-bg:     #F7F8FB;   /* רקע קוד / שורות משנה */

  /* סטטוס בסיס */
  --ok:           #16A34A;
  --danger:       #E5484D;
  --warn:         #EA9314;
  --info:         #8B5CF6;
  --vip:          #F5B04C;

  /* צל — שני צללים בלבד בכל המערכת */
  --shadow-card:  0 6px 20px rgba(16,24,40,.03);
  --shadow-float: 0 24px 60px rgba(16,24,40,.26);  /* פופאובר, מודאל, Drawer */

  /* רדיוסים — ארבעה בלבד */
  --r-lg: 16px;   /* כרטיסים, מודאלים, Drawer */
  --r-md: 12px;   /* כפתורים, שדות, קופסאות */
  --r-sm: 8px;    /* צ'יפים, תגיות, באדג'ים */
  --r-xs: 7px;    /* תגיות-מיני בתוך רכיבים */
}
```

**אסור:** להמציא צבע, צל או רדיוס חדשים. גוונים ל-hover נגזרים מהטוקן (למשל `color-mix`).

---

## 2. טיפוגרפיה — סקאלה סגורה

פונט יחיד: **Assistant** (Google Fonts, 400–800). מונו לקוד/HEX בלבד: **JetBrains Mono**.
חובה `font-family:inherit` על `button`, `input`, `select`, `textarea`.

| תפקיד | גודל/משקל | שימוש |
|---|---|---|
| H1 | **32px / 800** | כותרת עמוד ראשית |
| H2 | **21px / 800** | כותרת Drawer ומודאל (לבן על פס כחול) |
| H3 | **19px / 800** | כותרת סרגל עליון, מספר חדר |
| H4 | **17px / 800** | כותרת כרטיס / סקשן |
| Base | **15px** | גוף 400 · ניווט 500 · כפתורים 700 · שדות קלט 400 |
| Secondary | **14px / 600** | טקסט משני, תת-כותרת |
| Chip | **13.5px / 700** | כל הצ'יפים, התגיות והבאדג'ים — ללא יוצא מן הכלל |
| Label | **12px / 700** | תוויות שדה, רמזים, מטא — **המינימום המוחלט** |

חוקים:
- **אין** 12.5 / 13 / 14.5 / 16 / 18 / 20 / 22 / 24. מוצאים → מעגלים לערך הקרוב בסקאלה.
- מספרים, תאריכים, מחירים, טלפון, מייל: `direction:ltr` + `font-variant-numeric:tabular-nums`.
- line-height: כותרות 1.15, גוף 1.6.

---

## 3. תגית / צ'יפ / באדג' — מבנה אחיד אחד

**כל** התגיות במערכת (סטטוס תשלום, סטטוס שהות, סינון, ספירה, VIP, "12 יחידות") — מבנה זהה:

```css
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 10px;
  border-radius: var(--r-sm);
  font-size: 13.5px; font-weight: 700; white-space: nowrap;
  border: 1.5px solid transparent;
}
.chip .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.chip.clickable { cursor: pointer; }                    /* צ'יפ סינון */
.chip.clickable.on { background:#fff; box-shadow: inset 0 0 0 1.5px var(--brand); color: var(--ink); }
```

- גובה **28px תמיד**. נקודה **8px תמיד**. אין תגיות בגובה 26 או נקודות 6/7px.
- תגית ניטרלית (ספירה): רקע ‎#E9ECF3, טקסט var(--muted), בלי מסגרת.
- תגית סטטוס: שלישיית רקע/מסגרת/טקסט מטבלה 3.1 + נקודה.

### 3.1 צבעי סטטוס תשלום (רקע / מסגרת / טקסט / נקודה)

| סטטוס | bg | border | text | dot |
|---|---|---|---|---|
| לא שולם | #FDEBEC | #EFA3A9 | #B4232D | #E5484D |
| שולם חלקית | #EAF7EE | #93D3A5 | #1F7A3D | #48B865 |
| שולם מלא | #DFF2E7 | #4FB47E | #0F6B3C | #16A34A |
| ממתין להעברה | #F2ECFD | #BCA1F1 | #6B27D6 | #8B5CF6 |
| ממתין לאישור | #FDF2E1 | #EBC078 | #8A5207 | #EA9314 |
| נכשל | #FBE7EB | #E58BA0 | #A3123B | #C81E3C |
| הוחזר | #EAEEF4 | #AEBACB | #3C4A5E | #475569 |
| בוטל | #F1F3F6 | #C9D0DA | #5B6478 | #9AA1B4 |

אותה שלישייה משמשת את פס ההזמנה ביומן, את התג בפופאובר ואת הצ'יפ בסינון — אין גרסאות נפרדות.

---

## 4. כפתורים — שלושה סוגים, מידה אחת

```css
.btn { height: 44px; padding: 0 22px; border-radius: var(--r-md);
       font-size: 15px; font-weight: 700; font-family: inherit;
       display: inline-flex; align-items: center; justify-content: center; gap: 8px;
       cursor: pointer; border: none; }
.btn-primary   { background: var(--brand); color: #fff; box-shadow: 0 4px 12px rgba(37,64,200,.2); }
.btn-primary:hover { background: var(--brand-hover); }
.btn-secondary { background: #fff; color: var(--ink); border: 1.5px solid var(--line); }
.btn-tertiary  { background: transparent; color: var(--muted); }
.btn-sm { height: 36px; padding: 0 14px; }   /* רק בתוך פופאוברים/שורות טבלה */
```

- גובה **44px** בכל מקום; **36px** רק בתוך פופאובר/שורה. אין 40/38/42.
- כפתור-אייקון: 36×36, radius 10, אייקון 20px.

---

## 5. שדות קלט — אנטומיה אחידה

```css
.field       { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; font-weight: 700; color: var(--muted); }
.field-input { height: 44px; padding: 0 14px; border: 1.5px solid var(--line);
               border-radius: var(--r-md); font-size: 15px; font-family: inherit;
               background: #fff; color: var(--ink); }
.field-input:focus { outline: none; border-color: var(--brand);
                     box-shadow: 0 0 0 3px rgba(37,64,200,.12); }
.field-input::placeholder { color: var(--faint); }
.field-error { border-color: var(--danger); }
.field-hint  { font-size: 12px; font-weight: 600; color: var(--faint); }
```

- גובה שדה **44px אחיד** (גם select וגם date). textarea: min-height 88px, padding 12px 14px.
- תווית **תמיד מעל** השדה, 12px/700 — לא בתוך השדה, לא לצדו.

---

## 6. כרטיס (Card) — אנטומיה אחידה

```css
.card    { background: var(--surface); border: 1px solid var(--line);
           border-radius: var(--r-lg); box-shadow: var(--shadow-card); overflow: hidden; }
.card-hd { display: flex; align-items: center; gap: 10px; padding: 15px 20px;
           border-bottom: 1px solid var(--line); font-size: 17px; font-weight: 800; }
.card-bd { padding: 18px 20px; }
```

אין כרטיסים עם radius 12/14, מסגרת ‎#E4E8F0 או padding אחר.

---

## 7. חלון צד (Drawer) — מבנה קבוע

- נפתח **משמאל**, רוחב **60%** מהמסך (prop ‎drawerWidth), overlay מטושטש, נסגר ב-Esc ובלחיצה על הרקע.
- **פס כותרת:** רקע **var(--brand) מלא**. כותרת 21px/800 לבן · תת-כותרת 14px ‎rgba(255,255,255,.75)‎ · אייקון כותרת 40×40 על רקע ‎rgba(255,255,255,.16)‎ radius 12.
- **כפתור סגירה:** 36×36, רקע ‎rgba(255,255,255,.16)‎ (hover ‎.3), אייקון close לבן.
- **גוף:** padding 24px, גלילה פנימית, סקשנים כ-`.card`.
- **פוטר:** border-top ‎var(--line)‎, padding 16px 24px. **כפתור ראשי צמוד לקצה השמאלי, "ביטול" מימינו** (btn-secondary).

## 8. מודאל / פופאובר

- מודאל: רוחב לפי תוכן (מקס 520px), radius var(--r-lg), צל var(--shadow-float), אותו מבנה כותרת-כחולה/גוף/פוטר כמו Drawer.
- פופאובר (כמו ביומן): רוחב 316px, radius var(--r-lg), צל var(--shadow-float), נפתח בנקודת הלחיצה ומוצמד לגבולות המסך (מרווח 12px), overlay שקוף שסוגר בלחיצה.

## 9. Toast

ממורכז תחתון (bottom 26px) · רקע var(--ink) · טקסט לבן 15px/700 · radius var(--r-md) · אייקון check_circle ‎#7CE3A8 · נעלם אחרי 2.8s. **מבנה יחיד לכל המערכת.**

## 10. אייקונים

**Material Symbols Outlined בלבד**, משקל 400, `direction:ltr`.
גדלים מותרים: **24** (כותרות/ניווט) · **20** (כפתורים) · **17** (שורות מידע) · **13.5** (בתוך צ'יפים). אין גדלים אחרים.

## 11. RTL / LTR

- כל המסמך `direction:rtl`. משתמשים ב-logical properties: `margin-inline-start`, `border-inline-end`, `inset-inline` — לא left/right פיזיים (חוץ מגאומטריית פסי היומן המחושבת).
- LTR מפורש: מספרים, תאריכים, טווחי תאריכים, טלפון, מייל, HEX, קוד.

---

## 12. צ'קליסט תיקון ל-Claude Code (להריץ על כל הקבצים)

1. **פונטים:** grep ‎`font-size:` — כל ערך שאינו {12, 13.5, 14, 15, 17, 19, 21, 32}px → עגל לערך הקרוב בסקאלה. (חריג יחיד: טקסט בתוך פסי יומן/תאים צפופים — מינימום 12px.)
2. **קווים:** החלף כל ‎#E4E8F0 / #EEF0F5 / #F2F4F8 / #EDF0F5 בטוקן `var(--line)` (קווי גריד פנימיים ביומן — ‎#F3F5F9 — מותר להשאיר).
3. **צ'יפים:** אחד כל תגית ל-`.chip` — גובה 28, radius 8, ‏13.5px/700, נקודה 8px.
4. **כפתורים:** גובה 44 (או 36 בפופאובר בלבד), radius 12, ‏15px/700. אין 40px.
5. **שדות:** גובה 44, radius 12, תווית 12px/700 מעל, פוקוס כחול + טבעת.
6. **כרטיסים:** radius 16, מסגרת var(--line), כותרת 17px/800 עם padding ‎15px 20px, גוף ‎18px 20px.
7. **צללים:** רק שני הטוקנים. **רדיוסים:** רק {16, 12, 8, 7}.
8. **Drawer/מודאל:** ודא פס כותרת כחול מלא + פוטר עם ראשי-שמאל.
9. **אייקונים:** ודא Material Symbols Outlined בלבד ובגדלים {24, 20, 17, 13.5}.
10. ודא `font-family:inherit` על כל האלמנטים הטפסיים ו-`tabular-nums` על כל המספרים.
