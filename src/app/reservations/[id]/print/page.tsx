import { auditRequestContext, writeAudit } from "@/lib/audit";
import { formatFullDate } from "@/lib/dates";
import { formatVatRate } from "@/lib/vat";
import {
  loadBookingDocData,
  formatMoney,
  formatTimestamp,
  type BookingDoc,
  type BookingDocRoom,
} from "@/lib/pdf/booking-doc-data";
import { AutoPrint } from "./AutoPrint";

// /reservations/[id]/print — a standalone, print-optimised RTL Hebrew booking
// document. This route lives OUTSIDE the (dashboard) group, so it has no app
// shell/sidebar/editor chrome. Node runtime + always dynamic (per-request auth).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Self-contained print stylesheet (inline so the page needs no external assets).
// Rubik is served from /public/fonts so print matches the PDF.
const PRINT_CSS = `
@font-face {
  font-family: "RubikPrint";
  src: url("/fonts/Rubik-Regular.ttf") format("truetype");
  font-weight: 400;
  font-display: swap;
}
@font-face {
  font-family: "RubikPrint";
  src: url("/fonts/Rubik-Bold.ttf") format("truetype");
  font-weight: 700;
  font-display: swap;
}
@page { size: A4; margin: 14mm; }
.bk-print {
  font-family: "RubikPrint", system-ui, "Segoe UI", Arial, sans-serif;
  direction: rtl;
  text-align: right;
  color: #111827;
  background: #ffffff;
  line-height: 1.5;
  font-size: 13px;
}
.bk-sheet {
  max-width: 190mm;
  margin: 0 auto;
  padding: 10mm;
  background: #ffffff;
  box-sizing: border-box;
}
.bk-header {
  border-bottom: 2px solid #111827;
  padding-bottom: 12px;
  margin-bottom: 18px;
}
.bk-property { font-size: 26px; font-weight: 700; margin: 0; }
.bk-header-row {
  display: flex; justify-content: space-between; align-items: flex-end;
  margin-top: 8px; gap: 16px; flex-wrap: wrap;
}
.bk-title { font-size: 16px; font-weight: 700; margin: 0; }
.bk-pill {
  display: inline-block; margin-top: 6px; font-size: 11px; font-weight: 700;
  background: #f3f4f6; border: 1px solid #d1d5db; border-radius: 5px;
  padding: 2px 8px;
}
.bk-meta { text-align: left; direction: ltr; font-size: 11px; color: #6b7280; }
.bk-meta .bk-meta-rtl { direction: rtl; text-align: right; }
.bk-section { margin-bottom: 16px; break-inside: avoid; page-break-inside: avoid; }
.bk-section-title {
  font-size: 14px; font-weight: 700; margin: 0 0 8px;
  padding-bottom: 4px; border-bottom: 1px solid #d1d5db;
}
.bk-field { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
.bk-field .bk-label { color: #6b7280; }
.bk-field .bk-value { text-align: left; direction: ltr; }
.bk-field .bk-value-rtl { text-align: right; direction: rtl; }
.bk-room {
  border: 1px solid #d1d5db; border-radius: 6px; padding: 10px; margin-bottom: 8px;
  break-inside: avoid; page-break-inside: avoid;
}
.bk-room-head { display: flex; justify-content: space-between; margin-bottom: 6px; gap: 12px; }
.bk-room-title { font-weight: 700; }
.bk-room-price { font-weight: 700; direction: ltr; }
.bk-total {
  display: flex; justify-content: space-between; gap: 12px;
  margin-top: 8px; padding-top: 8px; border-top: 1px solid #111827;
  font-size: 15px; font-weight: 700;
}
.bk-total .bk-total-value { direction: ltr; }
.bk-credit { color: #047857; }
.bk-notes { white-space: pre-wrap; }
.bk-footer {
  margin-top: 22px; padding-top: 10px; border-top: 1px solid #d1d5db;
  font-size: 10px; color: #6b7280; text-align: center;
}
.bk-empty { max-width: 520px; margin: 60px auto; text-align: center; font-size: 16px; }
@media print {
  .bk-sheet { padding: 0; max-width: none; }
  .bk-print { font-size: 12px; }
}
`;

function occupancyLine(room: BookingDocRoom): string {
  const parts = [`${room.adults} מבוגרים`];
  if (room.children > 0) parts.push(`${room.children} ילדים`);
  if (room.infants > 0) parts.push(`${room.infants} תינוקות`);
  return parts.join(" · ");
}

function Field({ label, value, rtl }: { label: string; value: string; rtl?: boolean }) {
  return (
    <div className="bk-field">
      <span className="bk-label">{label}</span>
      <span className={rtl ? "bk-value-rtl" : "bk-value"}>{value}</span>
    </div>
  );
}

function BookingSheet({ doc }: { doc: BookingDoc }) {
  const c = doc.currency;
  const balanceIsCredit = doc.balance < 0;

  return (
    <div className="bk-sheet">
      <header className="bk-header">
        <h1 className="bk-property">{doc.propertyName}</h1>
        <div className="bk-header-row">
          <div>
            <p className="bk-title">{`אישור הזמנה #${doc.reservationNumber}`}</p>
            <span className="bk-pill">{doc.statusLabel}</span>
          </div>
          <div className="bk-meta">
            <div>{`נוצר: ${formatTimestamp(doc.createdAt)}`}</div>
            <div>{`עודכן: ${formatTimestamp(doc.updatedAt)}`}</div>
            {doc.sourceLabel ? <div className="bk-meta-rtl">{`מקור: ${doc.sourceLabel}`}</div> : null}
          </div>
        </div>
      </header>

      <section className="bk-section">
        <h2 className="bk-section-title">פרטי האורח</h2>
        <Field label="שם מלא" value={doc.guest.fullName || "—"} rtl />
        {doc.guest.phone ? <Field label="טלפון" value={doc.guest.phone} /> : null}
        {doc.guest.email ? <Field label="דוא״ל" value={doc.guest.email} /> : null}
        {doc.guest.idNumber ? <Field label="ת.ז. / דרכון" value={doc.guest.idNumber} /> : null}
      </section>

      <section className="bk-section">
        <h2 className="bk-section-title">פרטי השהייה</h2>
        {doc.stayCheckIn && doc.stayCheckOut ? (
          <>
            <Field label="צ׳ק-אין" value={formatFullDate(doc.stayCheckIn)} />
            <Field label="צ׳ק-אאוט" value={formatFullDate(doc.stayCheckOut)} />
            <Field label="סה״כ לילות" value={String(doc.totalNights)} />
          </>
        ) : (
          <p>לא הוזנו תאריכי שהייה</p>
        )}
        <Field label="מספר חדרים" value={String(doc.rooms.length)} />
      </section>

      {doc.rooms.length > 0 ? (
        <section className="bk-section">
          <h2 className="bk-section-title">חדרים</h2>
          {doc.rooms.map((room, i) => (
            <div className="bk-room" key={i}>
              <div className="bk-room-head">
                <span className="bk-room-title">
                  {`חדר ${room.roomLabel}${room.roomTypeName ? ` · ${room.roomTypeName}` : ""}`}
                </span>
                <span className="bk-room-price">{formatMoney(room.priceTotal, c)}</span>
              </div>
              <Field
                label="תאריכים"
                value={`${formatFullDate(room.checkIn)} – ${formatFullDate(room.checkOut)} (${room.nights} לילות)`}
              />
              <Field label="אורחים" value={occupancyLine(room)} rtl />
              <Field label="מחיר ללילה" value={formatMoney(room.ratePerNight, c)} />
              {room.guestName ? <Field label="אורח בחדר" value={room.guestName} rtl /> : null}
              {room.guestPhone ? <Field label="טלפון אורח" value={room.guestPhone} /> : null}
              {room.guestIdNumber ? <Field label="ת.ז. אורח" value={room.guestIdNumber} /> : null}
            </div>
          ))}
        </section>
      ) : null}

      <section className="bk-section">
        <h2 className="bk-section-title">פירוט תמחור</h2>
        <Field label="סכום חדרים" value={formatMoney(doc.roomsSubtotal, c)} />
        {doc.discountAmount > 0 ? (
          <Field label="הנחה" value={`- ${formatMoney(doc.discountAmount, c)}`} />
        ) : null}
        {doc.extraCharges > 0 ? (
          <Field label="חיובים נוספים" value={`+ ${formatMoney(doc.extraCharges, c)}`} />
        ) : null}
        {doc.vatRate > 0 ? (
          <Field label={`מזה מע״מ (${formatVatRate(doc.vatRate)}%)`} value={formatMoney(doc.vatAmount, c)} />
        ) : null}
        <div className="bk-total">
          <span>סה״כ לתשלום</span>
          <span className="bk-total-value">{formatMoney(doc.totalPrice, c)}</span>
        </div>
      </section>

      <section className="bk-section">
        <h2 className="bk-section-title">תשלומים</h2>
        {doc.payments.length > 0 ? (
          doc.payments.map((p, i) => (
            <Field
              key={i}
              label={`${p.methodLabel ?? "תשלום"}${p.paidAt ? ` · ${formatTimestamp(p.paidAt)}` : ""}`}
              value={formatMoney(p.amount, c)}
              rtl
            />
          ))
        ) : (
          <p>לא נרשמו תשלומים</p>
        )}
        <Field label="שולם עד כה" value={formatMoney(doc.paidAmount, c)} />
        <div className="bk-total">
          <span>{balanceIsCredit ? "זיכוי ללקוח" : "יתרה לתשלום"}</span>
          <span className={`bk-total-value${balanceIsCredit ? " bk-credit" : ""}`}>
            {formatMoney(Math.abs(doc.balance), c)}
          </span>
        </div>
      </section>

      {doc.maskedCard ? (
        <section className="bk-section">
          <h2 className="bk-section-title">אמצעי תשלום שמור</h2>
          <p>{doc.maskedCard}</p>
        </section>
      ) : null}

      {doc.canViewInternalNotes && doc.notes ? (
        <section className="bk-section">
          <h2 className="bk-section-title">בקשות מיוחדות / הערות</h2>
          <p className="bk-notes">{doc.notes}</p>
        </section>
      ) : null}

      <footer className="bk-footer">{`${doc.propertyName} · הזמנה #${doc.reservationNumber}`}</footer>
    </div>
  );
}

export default async function ReservationPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const loaded = await loadBookingDocData(id);

  if (!loaded) {
    return (
      <div className="bk-print" dir="rtl" lang="he">
        <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
        <div className="bk-empty">לא נמצא / אין הרשאה</div>
      </div>
    );
  }

  const { actor, doc } = loaded;
  const { ip, session } = await auditRequestContext();
  await writeAudit(actor, {
    entityType: "reservation",
    entityId: id,
    action: "print",
    after: { reservation_number: doc.reservationNumber },
    ip,
    session,
  });

  return (
    <div className="bk-print" dir="rtl" lang="he">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      <BookingSheet doc={doc} />
      <AutoPrint />
    </div>
  );
}
