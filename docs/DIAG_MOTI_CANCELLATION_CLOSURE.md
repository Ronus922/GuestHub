מסמך זה סוגר את docs/DIAG_MOTI_CANCELLATION.md שנמצא ב-/var/www/wt-stab. המקור לא נערך — הוא עבודה זרה של פאזה מקבילה. איחוד שני המסמכים באחריות רונן אחרי סגירת פאזות 2/5/6.

# סגירת אירוע Moti Grosman — אין באג

**פסק דין: אין באג. המערכת התנהגה נכון — היא לא פינתה חדר של הזמנה פעילה. הדיווח המקורי נשען על הנחה שגויה: ההזמנה מעולם לא בוטלה.**

ריצה 2026-07-25, worktree `/var/www/wt-1318`. קריאה בלבד לצורך המסמך הזה — אפס כתיבה להזמנה, אפס שחרור חדר, אפס שינוי קוד.

---

## 1. ההזמנה מעולם לא בוטלה

```sql
SELECT r.reservation_number, r.status, r.check_in, r.check_out,
       r.external_booking_id, r.external_revision_id, r.ota_name,
       r.cancelled_at, r.cancellation_origin, r.external_cancellation_requested_at,
       r.total_price, r.created_at, r.updated_at
FROM guesthub.reservations r
JOIN guesthub.guests g ON g.id = r.primary_guest_id
WHERE r.tenant_id = '68139d06-58c4-4043-b256-4691f83e1556'
  AND (g.first_name ILIKE '%moti%' OR g.last_name ILIKE '%grosman%');
```

```
 reservation_number                 │ '1026'
 status                             │ 'confirmed'
 check_in                           │ '2026-07-28'
 check_out                          │ '2026-07-29'
 external_booking_id                │ '90359426'
 external_revision_id               │ '90359426:2026-07-25T11:57:43Z'
 ota_name                           │ 'booking'
 cancelled_at                       │ null
 cancellation_origin                │ null
 external_cancellation_requested_at │ null
 total_price                        │ 488
 created_at                         │ '2026-07-24 08:52:12.379699+00'
 updated_at                         │ '2026-07-25 12:02:40.359641+00'
```

שורה אחת, בלי כפילויות. `status='confirmed'`, `cancelled_at=NULL`, אף שדה ביטול אינו מאוכלס. במקור ב-Beds24: `status:"new"`, `cancelTime:null`.

ההזמנה **שונתה** ב-11:57:43 — היא לא **בוטלה**. חדר שלא שוחרר עבור הזמנה פעילה הוא ההתנהגות הנכונה, לא תקלה. אילו המערכת הייתה מפנה אותו, זה היה הבאג.

## 2. הראיה החיה — הנתיב הנכנס עובד, על אותה הזמנה עצמה

| שעה | אירוע | ראיה |
|---|---|---|
| 11:57:43 | `modifiedTime` השתנה ב-Beds24 | חתום בתוך `external_revision_id = '90359426:2026-07-25T11:57:43Z'` |
| 12:02:40.359 | הרוויזיה נקלטה אצלנו | `reservations.updated_at = 12:02:40.359641`, `total_price = 488` |
| 12:02:40.359 | הקליטה לכלכה זמינות | `channel_dirty_ranges` revision 1751 — חדר 1130, `availability`, 2026-07-28 → 2026-07-29 |
| 12:02:40.546 | ה-drain ניקז אותה החוצה | `channel_evidence_ledger`: `outcome:'success', requests:1, claimed:1, sentValues:1` |

```
=== dirty range created by the ingest ===
 room_number │ kind           │ date_from    │ date_to      │ status   │ created_at                      │ revision
 '1130'      │ 'availability' │ '2026-07-28' │ '2026-07-29' │ 'synced' │ '2026-07-25 12:02:40.359641+00' │ '1751'
```

**מקצה לקצה: ~5 דקות** — בדיוק מרווח ה-poll (`INBOUND_POLL_MINUTES = 5`, `src/lib/channel/worker.ts:209`) — ועוד **187 מילישניות** עד שהזמינות המעודכנת יצאה ל-Beds24.

הנתיב הנכנס לא סתם "אמור לעבוד": הוא הוכח חי, על ההזמנה שבמחלוקת, על טווח התאריכים שלה, מקצה לקצה. בנוסף, `pull_booking_revisions` הצליח 3,055 פעמים מאז הפעלתו.

## 3. מה שהמסמך המקורי קבע, ומה השתנה מאז

`/var/www/wt-stab/docs/DIAG_MOTI_CANCELLATION.md` (703 שורות, פאזה קודמת) קבע:

> NEITHER STATE A NOR STATE B · root cause: the cancellation never reached Beds24 — GuestHub is correctly mirroring a source that still says the booking is live · released: NO

**הקביעה הזו נכונה ועומדת בעינה.** המסמך הנוכחי מוסיף לה שתי שכבות שלא היו זמינות אז:

1. המסמך המקורי מדד `modifiedTime: 2026-07-24T08:50:35Z` — "unchanged since creation". מאז ההזמנה **כן** שונתה, ב-2026-07-25 11:57:43, וזה נתן את הראיה החיה שסעיף 2 נשען עליה. עדיין ללא ביטול.
2. המסמך המקורי הוכיח שהמקור לא ביטל. המסמך הזה מוכיח בנוסף שהצינור הנכנס **פעיל ומהיר** — כך שכשהביטול האמיתי יגיע, הוא ייקלט.

המסקנה המשותפת: **GuestHub משקף נכון מקור שאומר שההזמנה חיה. אין מה לתקן.**

## 4. פריט מעקב (תיעוד בלבד)

> **כשהזמנה 1026 (Beds24 booking 90359426) תבוטל בפועל — לאמת שהחדר משוחרר תוך מחזור poll אחד (≤ 5 דקות, `INBOUND_POLL_MINUTES`), ואם לא — תוך מחזור reconciliation אחד (`reconcile_inventory`).**

לא ממתינים לזה. לא נבנה מנגנון מעקב, לא נרשמה משימה מתוזמנת, לא נוסף שומר. שורת תיעוד בלבד, בהתאם להנחיה.

---

**סטטוס: סגור.** אין באג, אין תיקון נדרש, אין חדר לשחרר.
ההקשר המלא של הריצה שסגרה את האירוע: `docs/CLOSE_1318.md`.
