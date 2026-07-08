import { formatFullDate, nightsBetween } from "@/lib/dates";
import { formatBalance } from "@/lib/inventory-rules";

// Canonical booking template variables (D53). ONE variable system, resolved from
// the canonical saved booking record — never a duplicate/second source. Pure so
// it is unit-checkable (scripts/check-messaging.mjs) and usable on client
// (live preview) + server (authoritative render).

export type BookingMessageContext = {
  reservationNumber: string;
  statusLabel: string;
  sourceLabel: string | null;
  guestFirstName: string;
  guestLastName: string;
  checkIn: string | null; // earliest room check-in (ISO date)
  checkOut: string | null; // latest room check-out
  nights: number;
  roomNumbers: string;
  roomTypes: string;
  adults: number;
  children: number;
  infants: number;
  totalPrice: number;
  balanceDue: number; // signed: negative = customer credit
  propertyName: string;
  checkInInstructions?: string | null;
  bookingLink?: string | null;
};

// key → Hebrew label, shown in the composer's "insert variable" helper.
export const CANONICAL_VARIABLES: { key: string; label: string }[] = [
  { key: "guest_first_name", label: "שם פרטי" },
  { key: "guest_last_name", label: "שם משפחה" },
  { key: "booking_number", label: "מספר הזמנה" },
  { key: "booking_status", label: "סטטוס" },
  { key: "source", label: "מקור" },
  { key: "check_in_date", label: "תאריך הגעה" },
  { key: "check_out_date", label: "תאריך עזיבה" },
  { key: "nights", label: "מספר לילות" },
  { key: "room_number", label: "מספר חדר" },
  { key: "room_type", label: "סוג חדר" },
  { key: "guest_composition", label: "הרכב אורחים" },
  { key: "total_price", label: "סה״כ" },
  { key: "balance_due", label: "יתרה לתשלום" },
  { key: "property_name", label: "שם הנכס" },
  { key: "check_in_instructions", label: "הוראות צ׳ק-אין" },
  { key: "booking_link", label: "קישור להזמנה" },
];

function money(n: number): string {
  return "₪" + Math.round(n).toLocaleString("he-IL");
}

function guestComposition(a: number, c: number, i: number): string {
  const parts: string[] = [`${a} מבוגרים`];
  if (c > 0) parts.push(`${c} ילדים`);
  if (i > 0) parts.push(`${i} תינוקות`);
  return parts.join(" · ");
}

export function resolveBookingVariables(ctx: BookingMessageContext): Record<string, string> {
  const bal = formatBalance(ctx.totalPrice, ctx.totalPrice - ctx.balanceDue);
  const balanceText =
    bal.kind === "credit" ? `זיכוי ${money(bal.amount)}` : money(bal.amount);
  return {
    guest_first_name: ctx.guestFirstName || "",
    guest_last_name: ctx.guestLastName || "",
    booking_number: ctx.reservationNumber,
    booking_status: ctx.statusLabel,
    source: ctx.sourceLabel ?? "",
    check_in_date: ctx.checkIn ? formatFullDate(ctx.checkIn) : "",
    check_out_date: ctx.checkOut ? formatFullDate(ctx.checkOut) : "",
    nights: String(ctx.nights),
    room_number: ctx.roomNumbers,
    room_type: ctx.roomTypes,
    guest_composition: guestComposition(ctx.adults, ctx.children, ctx.infants),
    total_price: money(ctx.totalPrice),
    balance_due: balanceText,
    property_name: ctx.propertyName,
    check_in_instructions: ctx.checkInInstructions ?? "",
    booking_link: ctx.bookingLink ?? "",
  };
}

// Replace {{ key }} (optional inner spaces). Unknown variables render empty so a
// stray placeholder never ships literally to a guest.
export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
}

// Derive the context fields that depend on the room set (earliest in / latest out,
// total nights, room numbers/types) from the canonical reservation rooms.
export function summarizeRooms(
  rooms: { roomLabel: string; roomTypeName: string | null; checkIn: string; checkOut: string; adults: number; children: number; infants: number }[],
): { checkIn: string | null; checkOut: string | null; nights: number; roomNumbers: string; roomTypes: string; adults: number; children: number; infants: number } {
  if (rooms.length === 0)
    return { checkIn: null, checkOut: null, nights: 0, roomNumbers: "", roomTypes: "", adults: 0, children: 0, infants: 0 };
  const checkIn = rooms.reduce((m, r) => (r.checkIn < m ? r.checkIn : m), rooms[0].checkIn);
  const checkOut = rooms.reduce((m, r) => (r.checkOut > m ? r.checkOut : m), rooms[0].checkOut);
  const roomNumbers = [...new Set(rooms.map((r) => r.roomLabel))].join(", ");
  const roomTypes = [...new Set(rooms.map((r) => r.roomTypeName).filter(Boolean))].join(", ");
  return {
    checkIn,
    checkOut,
    nights: nightsBetween(checkIn, checkOut),
    roomNumbers,
    roomTypes,
    adults: rooms.reduce((n, r) => n + r.adults, 0),
    children: rooms.reduce((n, r) => n + r.children, 0),
    infants: rooms.reduce((n, r) => n + r.infants, 0),
  };
}
