# נדרשת החלטת מפעיל — the blocked-cancellation surface

**מה זה פותר.** D93 שומר ביטול נכנס מהערוץ שנוחת על אורח שנמצא בצ׳ק-אין: הביטול
אמיתי, `external_cancellation_confirmed_at` נחתם על השורה, והלילות **לא**
משוחררים בכוונה — שחרור אוטומטי היה מוחק שהות חיה מתחת לאורח שעומד בחדר. עד
עכשיו המקום היחיד שאמר את זה היה שורת `channel_sync_errors` עם הקוד
`cancelled_at_source_checked_in`, כלומר התראה במסך הערוצים בלבד.

כרטיס הביטול בפאנל ההזמנה נבנה רק כאשר `status === 'cancelled'`, והזמנה חסומה
היא בהגדרה **לא** מבוטלת. לכן מפעיל שפתח את ההזמנה ראה שהות מאושרת רגילה לגמרי
בזמן ש-Booking.com כבר הודיע לאורח שההזמנה בוטלה. זה human-in-the-loop בלי loop.

## המצב נגזר, לעולם לא נשמר

```
external_cancellation_confirmed_at IS NOT NULL AND status <> 'cancelled'
```

בדיוק הנוסחה שכתובה בהערה של שער D93 עצמו ב-`src/lib/channel/booking-import.ts`.
זהו כלל התחום-האחד של מיגרציה 031, אותה צורה כמו `cancellation_pending_external`.
**אין מיגרציה ואין עמודה חדשה:** דגל `needs_manual_decision` שמור היה מקור אמת
שני, שמתחיל לסטות ברגע שמפעיל מסדר את השהות דרך מסלול ששוכח לאפס אותו.

## הקבצים

| קובץ | תפקיד |
|------|--------|
| `src/lib/reservations/manual-decision.ts` | `isCancellationBlocked` (טהור, ללא imports) + `loadManualDecisionView` (מקבל את חיבור ה-DB כפרמטר, בדיוק כמו `loadCollectionView`) |
| `src/app/(dashboard)/reservations/manual-decision-actions.ts` | `getManualDecisionAction` — `reservations.view`, tenant-scoped, קריאה בלבד |
| `src/components/reservations/EditReservationPanel.tsx` | הכרטיס — ראשון בעמודה, בעברית RTL, על primitives קנוניים |
| `scripts/check-manual-decision-surface.mjs` | ה-guard |
| `docs/screenshots/b53-manual-decision-*.png` | ההוכחה מ-staging |

## הרצת ה-guard

```bash
node --env-file=.env.staging scripts/check-manual-decision-surface.mjs
```

שבע קביעות התנהגותיות מול DB אמיתי (זמן האישור והסטטוס הם של השורה; מספר
הלילות מול סכימה עצמאית מ-`reservation_rooms`; `check_room_availability` עדיין
מדווח התנגשות `reservation` על אותם תאריכים; שמות החדרים מטבלת `rooms`;
`openAlerts` עוקב אחרי `channel_sync_errors` לשני הכיוונים; ושתי השליליות —
הזמנה שבאמת בוטלה, ושהות רגילה) ועוד שתי קביעות המסומנות במפורש **CONTRACT**
בטקסט הכישלון שלהן: הן בודקות חיווט, לא התנהגות.

ה-guard מחזיק tenant סינתטי משלו עם UUID קבועים, זורע ב-upsert בלבד ולא מוחק
שום שורה — staging משותף. סמני URL של פרודקשן נדחים על הסף.

## מה נשאר פתוח

1. **ה-guard לא רשום ב-`package.json`.** אין `pnpm check:manual-decision-surface`.
   `package.json` שייך לדיף של `fix/beds24-checkin-cancellation-guard` (PR #112),
   והענף הזה תחת איסור מפורש לגעת בו. השורה להוספה כשהאיסור יוסר:

   ```json
   "check:manual-decision-surface": "node --env-file=.env.staging scripts/check-manual-decision-surface.mjs"
   ```

2. **`DECISIONS.md` לא עודכן** — מאותה סיבה בדיוק (#112 מחזיק גם אותו). התיעוד
   של ההחלטה יושב כאן עד שאפשר יהיה להעביר אותו לבית הקנוני.

3. **קריאה שנייה בפתיחת הפאנל.** הבית הטבעי של השדה הוא `getReservationAction`
   כ-`detail.manualDecision`, אבל `src/app/(dashboard)/reservations/actions.ts`
   שייך גם הוא ל-#112. הקיפול פנימה הוא follow-up מכני: הגזירה והכרטיס לא
   משתנים, רק מאיפה מגיע המידע.

4. **זריעת staging שנשארה.** על `guesthub_staging`: הזמנה `1044` קיבלה
   `external_cancellation_confirmed_at`, ונוספה שורת `channel_sync_errors` אחת
   עם הקוד `cancelled_at_source_checked_in` שמצביעה עליה. שתיהן additive, אף
   שורה לא נמחקה. לביטול (אם רוצים ש-staging יחזור למצב הקודם):

   ```sql
   UPDATE guesthub.reservations SET external_cancellation_confirmed_at = NULL
    WHERE reservation_number = '1044' AND status = 'checked_in';
   UPDATE guesthub.channel_sync_errors SET resolved_at = now()
    WHERE error_code = 'cancelled_at_source_checked_in' AND resolved_at IS NULL;
   ```

   ה-guard מייצר את הנתונים שלו בעצמו ולא תלוי בזריעה הזו.

5. **הצילום נעשה עם `scripts/staging-screenshot.mjs` מענף
   `stab/staging-ui-verification`.** הקובץ הועתק לעץ העבודה לצורך הצילום ולא
   נכנס לקומיט כאן, כדי לא ליצור שני עותקים של אותו סקריפט בשני ענפים.
