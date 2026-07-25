# דוח סגירה — 2026-07-25

> **ערך ללא-הגבלה על החוט: לא קיים** · PRs: מוכנים **9** / לתיקון **0** / לסגירה **2** · #104 מוכן: **כן** · שומרים שנכשלו ב-B2: **0** · תוצרים חולצו: **כן**

`main = 84943858` · אפס מיזוג · אפס דפלוי · אפס `pm2 restart` · אפס מיגרציה חדשה.

---

## פאזה 0 — ספירת מלאי

### הרץ בפרודקשן

| | |
|---|---|
| `main` | `84943858c46bb5486d907df03d7af0d032d84e2e` — "Merge pull request #114" · 2026-07-25 17:37 |
| `/var/www/guesthub` | נקי, על `main`, זהה ל-`origin/main` |
| `guesthub` | online · ↺ **42** · uptime מ-2026-07-25 14:40:04 |
| `guesthub-channel-worker` | online · ↺ **14** · uptime מ-2026-07-25 14:40:05 |
| מקסימום D על main | **94** (`## D94` — שער הצ'ק-אין, #112). `D88.1` הוא תת-מספר תקין, לא כפילות. |

### PRs פתוחים — 11, לא 10

| # | ענף | ראש | תאריך | קבצים | קונפליקטים מול main |
|---|---|---|---|---|---|
| 111 | `night/night-run-report` | `beb329ea` | 25/07 | 2 | 0 |
| 110 | `night/p2-2-booking-com-reports` | `94a42cd1` | 25/07 | 13 | 2 |
| 109 | `night/reservation-source-system` | `c29bf004` | 24/07 | 5 | 0 |
| 108 | `night/room-display-state-closed` | `74ec2d41` | 24/07 | 2 | 0 |
| 107 | `night/calendar-ui-guard-diagnosis` | `2c330297` | 24/07 | 1 | 0 |
| 106 | `night/p0-3-ari-readback` | `b7719ba4` | 24/07 | 6 | 2 |
| 105 | `night/p0-2-fixture-guards` | `3ca6b351` | 24/07 | 3 | 1 |
| 104 | `night/p0-4-credit-backoff` | `c2a76378` | 24/07 | 14 | 5 |
| 103 | `night/p0-1-channel-comments` | `3a57f393` | 24/07 | 3 | 0 |
| 60 | `feat/reservation-defaults-policy-snapshot` | `ed1bf939` | 11/07 | 36 | 21 |
| **23** | `feat/room-configuration-and-inventory-cleanup` | `597801a5` | **08/07** | 5 | 3 |

**הפער:** הרשימה שנמסרה מנתה 10. **#23 חסר ממנה.** נבדק, מסומן לסגירה (§PR_TRIAGE_FINAL).

### פאזות 2/5/6 — כנראה הסתיימו, אך לא נגענו

אפס שינוי קובץ ב-worktrees שלהן ב-30 הדקות שקדמו לספירה; הכתיבה האחרונה
ל-`STABILIZATION_REPORT.md` הייתה ב-14:25. **שתי סשן-קלוד אחרות עדיין חיות**
(pid 2938245, 3465239), ולכן הקבצים שלהן טופלו כעבודה זרה: **הועתקו, לא נערכו.**

| מסמך | איפה | מצב |
|---|---|---|
| `PR_TRIAGE.md` | `stab/pr-triage` (+`wt-adv-merge`) | tracked · דחוף ל-origin |
| `GUARD_INTEGRITY.md` | `stab/guard-integrity-sweep` | tracked · דחוף ל-origin |
| `STAB_ADVERSARIAL.md` | `stab/adversarial` | tracked · דחוף ל-origin |
| `STABILIZATION_REPORT.md` | `/var/www/wt-stab` | ⚠️ **untracked** |
| `DIAG_MOTI_CANCELLATION.md` | `/var/www/wt-stab` | ⚠️ **untracked** |

### 0.4 — חילוץ תוצרים (בוצע ראשון)

שני המסמכים ה-untracked היו נמחקים עם `git worktree remove`. הועתקו **בייט-בייט**
(md5 אומת משני הצדדים) לענף `rescue/untracked-artifacts` (`f45e3c9`, דחוף ל-origin),
יחד עם patch של סימולציית מיזוג לא-מקומטת מ-`wt-triage-sim3`. **המקורות לא נערכו
ולא נמחקו.**

בנוסף נדחפו ל-origin שני ענפים שהיו מקומיים בלבד: `fix/room-1318-beds24-mapping`
(היה `b70c930` ברמוט מול `fa0cb11` מקומי) ו-`diag/pricing-max-stay` (ללא רמוט כלל).

---

## פאזה A — `maxStay`: המדידה

**חדר הניסוי:** 1318 · `numAvail = 0` · 0 שיוכי `pricing_plan_units` · 7/7 ימים
`stop_sell` · **0 הזמנות בחלון** — מאומת ב-DB לפני הכתיבה הראשונה.
**חלון:** `2027-02-01..2027-02-07` — 7 ימים, **191 יום קדימה**.
**שיטה:** לפני כל וריאנט נכתב **סמן `maxStay = 5`** ואומת בקריאה חוזרת, כדי
ש"התעלמו" ו"נמחק" לא יתבלבלו. הוולידטור שלנו נעקף בסקריפט חד-פעמי;
**בונה המטען לא שונה, ואף עקיפה לא נשארה בקוד.**

### A.1 — חמשת הניסויים, במלואם

```
BASELINE   GET  → 200  cost=1  remaining=95.8
           7 cells → numAvail=0  price1=null  minStay=1  maxStay=365
```

**וריאנט א — `maxStay: 0`**
```
POST [{"roomId":710488,"calendar":[{"from":"2027-02-01","to":"2027-02-07","maxStay":0}]}]
→ 201  cost=1  remaining=91.8
  [{"success":true,
    "warnings":[{"action":"process inventory rooms calendar","message":"maxStay capped to 1"}],
    "modified":{"roomId":710488,"calendar":[{"from":"2027-02-01","to":"2027-02-07","maxStay":1}]}}]
read-back → maxStay=1                    ✗ התהפך למגבלה חמורה יותר: לילה אחד
```

**וריאנט ב — `maxStay: null` (מפורש בגוף ה-JSON)**
```
POST [{"roomId":710488,"calendar":[{"from":"2027-02-01","to":"2027-02-07","maxStay":null}]}]
→ 201  cost=1  remaining=87.8   [{"success":true}]      ← בלי modified, בלי warning
read-back → maxStay=5                    ✗ התעלמות שקטה — הסמן שרד
```

**וריאנט ג — `maxStay: ""`**
```
POST [{"roomId":710488,"calendar":[{"from":"2027-02-01","to":"2027-02-07","maxStay":""}]}]
→ 201  cost=1  remaining=83.8   [{"success":true}]
read-back → maxStay=5                    ✗ התעלמות שקטה
```

**וריאנט ד — `maxStay: 3650`**
```
POST [{"roomId":710488,"calendar":[{"from":"2027-02-01","to":"2027-02-07","maxStay":3650}]}]
→ 201  cost=1  remaining=79.8
  [{"success":true,
    "warnings":[{"action":"process inventory rooms calendar","message":"maxStay capped to room maxStay 365"}],
    "modified":{"roomId":710488,"calendar":[{"from":"2027-02-01","to":"2027-02-07","maxStay":"365"}]}}]
read-back → maxStay=365                  → הודק לתקרת החדר
```

**וריאנט ה — השמטה מלאה (בקרה)**
```
POST [{"roomId":710488,"calendar":[{"from":"2027-02-01","to":"2027-02-07","numAvail":0}]}]
→ 201  cost=1  remaining=75.8   [{"success":true}]
read-back → maxStay=5                    ✗ התעלמות — מאשר עדכון חלקי
```

### המסקנה

**אין ערך שמייצג "ללא הגבלה" ברמת הלוח היומי.** הטווח הקביל הוא
`[1, maxStay ברמת החדר]`; `null` / `""` / השמטה הם **אותה פעולה** — no-op;
**אין פעולת מחיקה בכלל**; ו-`0` הוא המסוכן שבחמישה כי הוא נראה כמו "בלי הגבלה"
ומתפרש כ"לילה אחד".

**A.2 — מי גובר.** `GET /properties` → כל 15 החדרים `maxStay = 365` ברמת החדר.
**זו תקרה קשיחה:** ערך יומי ≤ 365 גובר; מעליו — מהודק; מתחת ל-1 — מהודק ל-1.
"ללא הגבלה" אינו בר-השגה מהקוד מעבר ל-365.

**A.3 — ניקוי.** `POST maxStay=365` → 201 **בלי warning**.
```
DIFF baseline vs restored: NONE — 7/7 cells identical on all four fields
```
סייג מוצהר: הקריאה מדווחת ערך **אפקטיבי** ואינה מבחינה בין ירושה לדריסה. מכיוון
שאין פעולת מחיקה, השחזור זהה-בערך ולא בהכרח זהה-במבנה.

**A.4/A.5** — `docs/MAXSTAY_NO_LIMIT_SPEC.md` (ענף `spec/maxstay-no-limit`).
דירוג הסיכון: **פתיחה לא מכוונת גרועה מחסימה** — חסימה מתגלה מהר ומתקנת את עצמה
בדחיפה אחת; הזמנה של 300 לילות שהתקבלה אינה חוזרת לאחור בקוד.

**קרדיטים:** 25 קריאות · ~25.1 קרדיטים · שפל `remaining = 69.7/100` — **שיא
ניצול 21% מחלון 5 הדקות**. התקרה לא התקרבה להיות חסם.

---

## פאזה B — הטריאז'

מלא ב-**`docs/PR_TRIAGE_FINAL.md`**. בקצרה:

- 9 מוכנים, 0 לתיקון, 2 לסגירה (#23 · #60 חסום).
- **7 מוטציות B2 על 6 שומרים — כולן אדומות. אפס כשלי B2.**
- #105 היה **אדום על main**: grep שדורש את שם ה-header **השגוי** שמחק #113.
  תוקן ע"י בליעת `fix/ari-drain-guard-measured-credit-headers` — שמוחק את ה-grep
  הכפול במקום לתקן את המחרוזת.
- #110 בנייה נכשלה ב-worktree של הלילה בגלל `ref/proof/render/entry.tsx` —
  קובץ **gitignored, untracked**, שאינו שלו. בעץ נקי: ירוק.

---

## פאזה C — #104

**מוכן.** שלושה תיקונים + מיזוג סמנטי מול #112/#113/#114.

**C.1 — בליעת השגיאה.** השער היה `creditPause && warnings.length === 0` — בדק
`warnings`, **לא `failure`**. ריצה עם כשל אמיתי *וגם* מונה נמוך נכנסה לענף
ההשהיה ו**חזרה ממנו מוקדם**, ולכן דילגה על נתיב הכשל: `attempts` נשאר 0,
`last_error_code` נשאר null, וטווח שלעולם לא יצליח ניסה שוב לנצח.
**הצלבה מול #114:** #114 הפך את `logChannelError` ללא-מותנה **בנתיב הכשל** —
הנתיב נכון, אבל ענף ההשהיה הוא `return` מוקדם **חדש שעוקף אותו**. #114 לא פתר
את זה ולא יכול היה. השער עכשיו `!failure`, וההשהיה שורדת כ-cooldown:
`failRanges` לוקח את **הארוך** מבין ה-backoff לאיפוס החלון.

**C.2 — השומר.** שלוש אסרשנות grep הוסרו והוחלפו ב-4 אסרשנות התנהגותיות דרך
`beds24Request` האמיתי. B2 מוכיח את ההבדל: החזרת השמות הישנים כ-aliases **בקובץ
אחר** מאדימה את הגרסה החדשה — ולא הייתה מאדימה את ה-grep.

**C.3 — מספרי D.** מקסימום על main = 94. ההקצאה:

| מספר | בעלים | סטטוס |
|---|---|---|
| D94 | #112 — שער הצ'ק-אין | ✅ על main, לא נגענו |
| D95 | #106 | תבע כדין |
| D96 | #110 | תבע כדין |
| **D97** | **#104** ← היה D94 | ✅ מוטמע בענף |
| **D98** | **`diag/pricing-max-stay`** ← היה D94 | ✅ מוטמע בענף |

*(ההטמעה היא **בענפים עצמם** — כל רשומה נוסעת עם ה-PR שלה. כתיבתן ל-`DECISIONS.md`
של main עכשיו הייתה מייצרת כפילות ברגע המיזוג. ההפניה הפנימית של #106 ל-D94 עודכנה
ל-D97.)*

**`MAX_REQUESTS_PER_RUN`** — 120 היה שרירותי, וההערה "never exhausts the window"
שגויה: `120 × 1.2 = 144` קרדיטים = **144% מהחלון**. נגזר עכשיו מהקבועים:
```
floor((BEDS24_CREDIT_CEILING − BEDS24_LOW_CREDIT_THRESHOLD) / BEDS24_MEASURED_CALL_COST)
= floor((100 − 12) / 1.2) = floor(73.33) = 73
```
הקרדיטים מעולם לא היו החסם על נפח (1.5–2.2% ליום, שיא חלון 8.4%) — **הפרץ** היה.

---

## רצף מיזוג-ודפלוי — פעם אחת

תשעת ה-PRs הובאו למצב **מוערם**. **הרצף הזה אומת בסימולציה מלאה: 9 מיזוגים,
0 קונפליקטים.**

```bash
# גל יחיד. בדיוק בסדר הזה.
gh pr merge 107 --merge   # docs — אבחון check:calendar-ui
gh pr merge 111 --merge   # docs — דוח הלילה (אומת: אפס קוד)
gh pr merge 103 --merge   # הערות בלבד
gh pr merge 108 --merge   # UI — מצב "סגור" בלוח החדרים
gh pr merge 106 --merge   # D95 · ARI read-back
gh pr merge 110 --merge   # D96 · מיגרציה 055
gh pr merge 109 --merge   # מיגרציה 056
gh pr merge 104 --merge   # D97 · credit backoff
gh pr merge 105 --merge   # fixture guards

# דפלוי אחד, בסוף.
cd /var/www/guesthub && PROD_DEPLOY_OK=1 npm run deploy:prod
```

**סדר 5→9 מחייב.** 1–4 עצמאיים לגמרי וניתן למזג בכל סדר.

### לאמת אחרי הדפלוי

```bash
pm2 list                              # guesthub + guesthub-channel-worker = online
git -C /var/www/guesthub log -1 --format='%h'   # = ראש ה-main החדש
grep -c 'x-five-min-limit-remaining' /var/www/guesthub/dist/worker/lib/channel/beds24-credits.js   # ≥1
grep -c 'fivemincreditlimit'          /var/www/guesthub/dist/worker/lib/channel/beds24-*.js        # 0
```

ואז ב-DB, בתוך ~10 דקות:

| בדיקה | ציפייה |
|---|---|
| `channel_evidence_ledger` — הראיה הראשונה אחרי ניקוז מסחרי | `creditsRemaining` **מספר**, לא null (הראיה הראשונה מאז ומעולם) |
| `channel_sync_errors` בחצי השעה שאחרי | אפס שורות חדשות |
| `channel_dirty_ranges` `status='failed'` | ללא גידול |
| `booking_channel_reports` | הטבלה קיימת (מיגרציה 055) |

**סימן ה-rollback — כל אחד מאלה:**

1. **`channel_sync_errors` צומח עם `code` שאינו `credit_paused`/`rate_limited`** —
   סימן שהמיזוג הסמנטי ב-`beds24-ari.ts` או ב-`beds24-ari-sync.ts` שגה.
2. **`channel_dirty_ranges.status='failed'` קופץ** — C.1 מחייב עכשיו ניסיון על
   כשל אמיתי; קפיצה גדולה פירושה שהיה כשל אמיתי שנבלע קודם, או שהשער חמור מדי.
3. **הניקוז מפסיק לשלוח לגמרי** (`sentValues=0` על פני מחזורים רצופים) —
   `MAX_REQUESTS_PER_RUN=73` או שער הקרדיטים חוסמים יותר מדי.
4. **`reconcile_inventory` מפסיק לשחרר** — הסינתזה ב-`worker.ts` (#104 מול #106) שגתה.

**הפעולה:** `git revert -m 1 <merge-sha>` של הגל, ואז אותו `deploy:prod`.
הדפלוי הוא ff-only מול `origin/main`, כך שה-revert חייב לעבור PR — או, לחירום,
`git checkout <sha קודם>` + restart, כפי ש-`deploy-production.sh` מתעד.

---

## מה נשאר פתוח אחרי שהתור מתרוקן

**זה הסוף, לא עוד סבב.** מה שנשאר אינו עבודה תלויה — אלה החלטות ושתי חזיתות
שהוגדרו מראש מחוץ לתחום.

### דורש הכרעה של רונן — `docs/OPEN_DECISIONS_RONEN.md`

⚠️ **דחוף:** בין 15:21 ל-15:50 בוצעה עבודת מפעיל בממשק ש**פתחה את 1318 למכירה**:
ארבעה שיוכי `pricing_plan_units` ושלושה עדכונים קבוצתיים. `stop_sell` נוקה,
והמחיר 4,880 תומחר מחדש ל-**750**. קריאה חיה מ-Beds24: `numAvail=1, price1=750`.
זה **מכריע** את שאלות המחיר והשיוך, ו**מעלה** שאלה חדשה: 750 הוא המחיר הנכון?
(אף אחת מהפעולות אינה של הריצה הזו — הכתיבה היחידה שלנו הייתה `maxStay` על 7 ימים,
שהוחזרה לאחור ואומתה.)

עוד: תוכנית התעריף במיפוי (`fee07a5b` "ללא החזר" מול תוכנית הבסיס) · 66 טווחי
channex (מחיקת דאטה — אישור נפרד) · `fail-closed` שקט על `price:0` · ג'וב
`succeeded` על ניקוז ריק · `coalescing` שמוחק עקבות · תקרת `maxStay=365` בפאנל.

### שלוש חזיתות פתוחות

| מה | למה לא נסגר כאן |
|---|---|
| **מימוש `maxStay` "ללא הגבלה"** | האפיון מוכן (`MAXSTAY_NO_LIMIT_SPEC.md`), המדידה חד-משמעית. המימוש עצמו הוא שינוי בבונה המטען + בענף LOS — **שניהם מחוץ לתחום הריצה** (חוק ברזל: לא נוגעים ב-LOS). 4,830 שורות מחכות לו. |
| **#60** | 206 קומיטים מאחור, 21 קונפליקטים, נוגע ב-`CardFields.tsx`/`card-rules.ts` — **קוד כרטיסים, מחוץ לתחום מפורש**. D83–D86 אינם על main: זו עבודה אמיתית שלא נחתה. דורש ריצה ייעודית עם אישור נקודתי. |
| **#23** | לסגור. המיגרציה כבר על main זהה בייט-בייט. שווה להציל ממנו PR של 3 שורות: מיון מספרי של חדרים בלוח התפוסה. |

### להטמעה ידנית

`docs/GUARD_GAPS_PENDING.md` — 6 פערי שומרים, **בקובץ נפרד בכוונה**:
`GUARD_INTEGRITY.md` אינו על main ונתון למחלוקת בין ריצות. שניים מהם נסגרו
בריצה הזו (ה-grep של #104; החוב ההיסטורי מכוסה חלקית ע"י #114); ארבעה פתוחים.

---

## תוצרי הריצה

| קובץ | ענף |
|---|---|
| `MAXSTAY_NO_LIMIT_SPEC.md` | `spec/maxstay-no-limit` |
| `PR_TRIAGE_FINAL.md` · `GUARD_GAPS_PENDING.md` · `OPEN_DECISIONS_RONEN.md` · `CLOSURE_REPORT.md` | `docs/closure-2026-07-25` |
| `DIAG_MOTI_CANCELLATION.md` · `STABILIZATION_REPORT.md` (מחולצים) | `rescue/untracked-artifacts` |
| D97 | `night/p0-4-credit-backoff` |
| D98 | `diag/pricing-max-stay` |
