import path from "node:path";
import { Document, Page, View, Text, Font, StyleSheet } from "@react-pdf/renderer";
import { formatFullDate } from "@/lib/dates";
import { formatVatRate } from "@/lib/vat";
import {
  type BookingDoc,
  type BookingDocRoom,
  formatMoney,
  formatTimestamp,
} from "./booking-doc-data";
import { DOC_COLORS } from "./doc-tokens";

// ============================================================
// Booking confirmation PDF (@react-pdf/renderer).
// RTL Hebrew: every text/container carries direction:'rtl' + textAlign:'right';
// row layouts use flexDirection:'row' inside an rtl container so the main axis
// starts on the right. The bundled Rubik font (Hebrew + ₪ U+20AA) is registered
// once at module load; hyphenation is disabled so Hebrew words never break.
// SECURITY: the payload has NO PAN and NO CVV — only doc.maskedCard (last4).
// ============================================================

// Register the Hebrew font ONCE (module-level guard against double registration
// across renders in the same Node process).
let fontsRegistered = false;
function ensureFonts(): void {
  if (fontsRegistered) return;
  Font.register({
    family: "Rubik",
    fonts: [
      { src: path.join(process.cwd(), "public/fonts/Rubik-Regular.ttf") },
      { src: path.join(process.cwd(), "public/fonts/Rubik-Bold.ttf"), fontWeight: 700 },
    ],
  });
  // Keep Hebrew words intact — react-pdf's default hyphenation splits by char.
  Font.registerHyphenationCallback((word) => [word]);
  fontsRegistered = true;
}

// GUIDELINES §1 — the document consumes the canonical tokens (DOC_COLORS reads
// them from lib/colors + lib/status-colors); no colour is re-typed here.
const COLORS = {
  ink: DOC_COLORS.ink,
  muted: DOC_COLORS.muted,
  line: DOC_COLORS.line,
  soft: DOC_COLORS.soft,
  accent: DOC_COLORS.ink,
  credit: DOC_COLORS.credit,
};

const styles = StyleSheet.create({
  page: {
    paddingVertical: 36,
    paddingHorizontal: 36,
    fontFamily: "Rubik",
    fontSize: 10,
    color: COLORS.ink,
    direction: "rtl",
    textAlign: "right",
    lineHeight: 1.4,
  },
  header: {
    borderBottomWidth: 2,
    borderBottomColor: COLORS.accent,
    paddingBottom: 10,
    marginBottom: 14,
  },
  propertyName: { fontSize: 20, fontWeight: 700, textAlign: "right", direction: "rtl" },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginTop: 6,
    direction: "rtl",
  },
  headerTitle: { fontSize: 13, fontWeight: 700, textAlign: "right" },
  headerMeta: { fontSize: 9, color: COLORS.muted, textAlign: "left", direction: "ltr" },
  statusPill: {
    fontSize: 9,
    fontWeight: 700,
    color: COLORS.accent,
    backgroundColor: COLORS.soft,
    borderWidth: 1,
    borderColor: COLORS.line,
    borderRadius: 4,
    paddingVertical: 2,
    paddingHorizontal: 6,
  },
  section: { marginBottom: 12 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 700,
    textAlign: "right",
    direction: "rtl",
    marginBottom: 6,
    paddingBottom: 3,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.line,
  },
  fieldRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 3,
    direction: "rtl",
  },
  fieldLabel: { color: COLORS.muted, textAlign: "right", direction: "rtl" },
  fieldValue: { textAlign: "left", direction: "ltr", maxWidth: "70%" },
  fieldValueRtl: { textAlign: "left", direction: "rtl", maxWidth: "70%" },
  roomCard: {
    borderWidth: 1,
    borderColor: COLORS.line,
    borderRadius: 4,
    padding: 8,
    marginBottom: 6,
  },
  roomHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 4,
    direction: "rtl",
  },
  roomTitle: { fontSize: 10.5, fontWeight: 700, textAlign: "right", direction: "rtl" },
  roomPrice: { fontSize: 10.5, fontWeight: 700, textAlign: "left", direction: "ltr" },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: COLORS.accent,
    direction: "rtl",
  },
  totalLabel: { fontSize: 12, fontWeight: 700, textAlign: "right", direction: "rtl" },
  totalValue: { fontSize: 12, fontWeight: 700, textAlign: "left", direction: "ltr" },
  notesText: { textAlign: "right", direction: "rtl", color: COLORS.ink },
  cardLine: { textAlign: "right", direction: "rtl", color: COLORS.ink },
  footer: {
    marginTop: 18,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: COLORS.line,
    fontSize: 8,
    color: COLORS.muted,
    textAlign: "center",
    direction: "rtl",
  },
});

function Field({ label, value, rtl }: { label: string; value: string; rtl?: boolean }) {
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={rtl ? styles.fieldValueRtl : styles.fieldValue}>{value}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section} wrap={false}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function occupancyLine(room: BookingDocRoom): string {
  const parts = [`${room.adults} מבוגרים`];
  if (room.children > 0) parts.push(`${room.children} ילדים`);
  if (room.infants > 0) parts.push(`${room.infants} תינוקות`);
  return parts.join(" · ");
}

function RoomBlock({ room, currency }: { room: BookingDocRoom; currency: string }) {
  const typeSuffix = room.roomTypeName ? ` · ${room.roomTypeName}` : "";
  return (
    <View style={styles.roomCard} wrap={false}>
      <View style={styles.roomHead}>
        <Text style={styles.roomTitle}>{`חדר ${room.roomLabel}${typeSuffix}`}</Text>
        <Text style={styles.roomPrice}>{formatMoney(room.priceTotal, currency)}</Text>
      </View>
      <Field
        label="תאריכים"
        value={`${formatFullDate(room.checkIn)} – ${formatFullDate(room.checkOut)} (${room.nights} לילות)`}
      />
      <Field label="אורחים" value={occupancyLine(room)} rtl />
      <Field label="מחיר ללילה" value={formatMoney(room.ratePerNight, currency)} />
      {room.guestName ? <Field label="אורח בחדר" value={room.guestName} rtl /> : null}
      {room.guestPhone ? <Field label="טלפון אורח" value={room.guestPhone} /> : null}
      {room.guestIdNumber ? <Field label="ת.ז. אורח" value={room.guestIdNumber} /> : null}
    </View>
  );
}

export function BookingPdf({ doc }: { doc: BookingDoc }) {
  ensureFonts();
  const c = doc.currency;
  const balanceIsCredit = doc.balance < 0;

  return (
    <Document
      title={`הזמנה ${doc.reservationNumber}`}
      author={doc.propertyName}
      language="he"
    >
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.propertyName}>{doc.propertyName}</Text>
          <View style={styles.headerRow}>
            <View>
              <Text style={styles.headerTitle}>{`אישור הזמנה #${doc.reservationNumber}`}</Text>
              <Text style={styles.statusPill}>{doc.statusLabel}</Text>
            </View>
            <View>
              <Text style={styles.headerMeta}>{`נוצר: ${formatTimestamp(doc.createdAt)}`}</Text>
              <Text style={styles.headerMeta}>{`עודכן: ${formatTimestamp(doc.updatedAt)}`}</Text>
              {doc.sourceLabel ? (
                <Text style={[styles.headerMeta, { direction: "rtl", textAlign: "right" }]}>
                  {`מקור: ${doc.sourceLabel}`}
                </Text>
              ) : null}
            </View>
          </View>
        </View>

        {/* Guest */}
        <Section title="פרטי האורח">
          <Field label="שם מלא" value={doc.guest.fullName || "—"} rtl />
          {doc.guest.phone ? <Field label="טלפון" value={doc.guest.phone} /> : null}
          {doc.guest.email ? <Field label="דוא״ל" value={doc.guest.email} /> : null}
          {doc.guest.idNumber ? <Field label="ת.ז. / דרכון" value={doc.guest.idNumber} /> : null}
        </Section>

        {/* Stay summary */}
        <Section title="פרטי השהייה">
          {doc.stayCheckIn && doc.stayCheckOut ? (
            <>
              <Field label="צ׳ק-אין" value={formatFullDate(doc.stayCheckIn)} />
              <Field label="צ׳ק-אאוט" value={formatFullDate(doc.stayCheckOut)} />
              <Field label="סה״כ לילות" value={String(doc.totalNights)} />
            </>
          ) : (
            <Text style={styles.notesText}>לא הוזנו תאריכי שהייה</Text>
          )}
          <Field label="מספר חדרים" value={String(doc.rooms.length)} />
        </Section>

        {/* Rooms */}
        {doc.rooms.length > 0 ? (
          <Section title="חדרים">
            {doc.rooms.map((room, i) => (
              <RoomBlock key={i} room={room} currency={c} />
            ))}
          </Section>
        ) : null}

        {/* Pricing */}
        <Section title="פירוט תמחור">
          <Field label="סכום חדרים" value={formatMoney(doc.roomsSubtotal, c)} />
          {doc.discountAmount > 0 ? (
            <Field label="הנחה" value={`- ${formatMoney(doc.discountAmount, c)}`} />
          ) : null}
          {doc.extraCharges > 0 ? (
            <Field label="חיובים נוספים" value={`+ ${formatMoney(doc.extraCharges, c)}`} />
          ) : null}
          {doc.vatRate > 0 ? (
            <Field
              label={`מזה מע״מ (${formatVatRate(doc.vatRate)}%)`}
              value={formatMoney(doc.vatAmount, c)}
            />
          ) : null}
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>סה״כ לתשלום</Text>
            <Text style={styles.totalValue}>{formatMoney(doc.totalPrice, c)}</Text>
          </View>
        </Section>

        {/* Payments */}
        <Section title="תשלומים">
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
            <Text style={styles.notesText}>לא נרשמו תשלומים</Text>
          )}
          <Field label="שולם עד כה" value={formatMoney(doc.paidAmount, c)} />
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>
              {balanceIsCredit ? "זיכוי ללקוח" : "יתרה לתשלום"}
            </Text>
            <Text style={[styles.totalValue, balanceIsCredit ? { color: COLORS.credit } : {}]}>
              {formatMoney(Math.abs(doc.balance), c)}
            </Text>
          </View>
        </Section>

        {/* Stored card (masked — last4 only, never PAN/CVV) */}
        {doc.maskedCard ? (
          <Section title="אמצעי תשלום שמור">
            <Text style={styles.cardLine}>{doc.maskedCard}</Text>
          </Section>
        ) : null}

        {/* Special requests / notes — internal, gated on edit permission */}
        {doc.canViewInternalNotes && doc.notes ? (
          <Section title="בקשות מיוחדות / הערות">
            <Text style={styles.notesText}>{doc.notes}</Text>
          </Section>
        ) : null}

        <Text style={styles.footer} fixed>
          {`${doc.propertyName} · הזמנה #${doc.reservationNumber}`}
        </Text>
      </Page>
    </Document>
  );
}
