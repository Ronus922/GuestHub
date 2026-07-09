import "server-only";
import { getActor, hasPermission, type Actor } from "@/lib/auth/actor";
import { getReservationAction } from "@/app/(dashboard)/reservations/actions";
import { getTenantCurrency, getTenantVatRate } from "@/lib/settings";
import { getPublicPropertyName } from "@/lib/business/store";
import { formatFullDate, nightsBetween } from "@/lib/dates";
import { includedVatAmount } from "@/lib/vat";
import { sql } from "@/lib/db";

// ============================================================
// Server-only data loader for the Booking PDF + HTML print layout.
// Builds ONE plain, JSON-serializable BookingDoc from the canonical
// getReservationAction payload — permission-gated, tenant-scoped, and
// card-masked (last4 only; there is NO PAN and NO CVV anywhere in the
// system, so none is ever fabricated here).
// ============================================================

export type BookingDocRoom = {
  roomLabel: string;
  roomTypeName: string | null;
  checkIn: string; // "YYYY-MM-DD"
  checkOut: string; // "YYYY-MM-DD"
  nights: number;
  adults: number;
  children: number;
  infants: number;
  ratePerNight: number;
  priceTotal: number;
  guestName: string | null;
  guestPhone: string | null;
  guestIdNumber: string | null;
};

export type BookingDocPayment = {
  amount: number;
  method: string | null;
  methodLabel: string | null;
  paidAt: string | null;
  reference: string | null;
};

export type BookingDoc = {
  reservationId: string;
  reservationNumber: string;
  status: string;
  statusLabel: string;
  sourceLabel: string | null;
  createdAt: string;
  updatedAt: string;
  propertyName: string;
  currency: string;
  guest: {
    fullName: string;
    phone: string | null;
    email: string | null;
    idNumber: string | null;
  };
  rooms: BookingDocRoom[];
  stayCheckIn: string | null;
  stayCheckOut: string | null;
  totalNights: number;
  roomsSubtotal: number;
  discountAmount: number;
  extraCharges: number;
  vatRate: number;
  vatAmount: number;
  totalPrice: number;
  paidAmount: number;
  balance: number;
  payments: BookingDocPayment[];
  // masked stored-card line ONLY — never a PAN, never a CVV (D52: CVV removed
  // entirely; the read payload carries last4 metadata only).
  maskedCard: string | null;
  // internal/operational notes: the reservation has a single `notes` field.
  // Populated only when the actor may edit reservations; null otherwise.
  notes: string | null;
  canViewInternalNotes: boolean;
};

// --- Hebrew status labels (falls back to the raw status for anything new) ---
const STATUS_LABELS: Record<string, string> = {
  confirmed: "מאושרת",
  draft: "טיוטה",
  pending: "ממתינה",
  checked_in: "צ׳ק-אין בוצע",
  checked_out: "צ׳ק-אאוט בוצע",
  cancelled: "מבוטלת",
  canceled: "מבוטלת",
  no_show: "לא הופיע",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

// --- Money formatting shared by the PDF and the HTML print page ---
const CURRENCY_SYMBOL: Record<string, string> = {
  ILS: "₪",
  USD: "$",
  EUR: "€",
  GBP: "£",
};

export function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOL[currency] ?? `${currency} `;
}

export function formatMoney(amount: number, currency: string): string {
  return `${currencySymbol(currency)}${Math.round(amount).toLocaleString("he-IL")}`;
}

// Timestamp text ("YYYY-MM-DD HH:MM:SS+00") → "DD/MM/YYYY HH:MM"
export function formatTimestamp(ts: string | null): string {
  if (!ts) return "";
  const datePart = ts.slice(0, 10);
  const timePart = ts.slice(11, 16);
  return timePart ? `${formatFullDate(datePart)} ${timePart}` : formatFullDate(datePart);
}

// ASCII slug: lowercase, spaces→'-', strip non [a-z0-9-], collapse dashes.
function asciiSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Safe download basename WITHOUT extension, e.g. "booking-2481-israel-israeli".
// Hebrew names slug to empty → falls back to "guest".
export function bookingFileName(doc: BookingDoc): string {
  const slug = asciiSlug(doc.guest.fullName);
  const num = doc.reservationNumber.replace(/[^a-zA-Z0-9-]/g, "") || "0";
  return `booking-${num}-${slug || "guest"}`;
}

export async function loadBookingDocData(
  reservationId: string,
): Promise<{ actor: Actor; doc: BookingDoc } | null> {
  const actor = await getActor();
  if (!actor) return null;
  if (!hasPermission(actor, "reservations.view")) return null;

  const res = await getReservationAction(reservationId);
  if (!res.success || !res.data) return null;
  const r = res.data;

  const [currency, vatRate] = await Promise.all([
    getTenantCurrency(actor.tenantId),
    getTenantVatRate(actor.tenantId),
  ]);

  // Tenant payment-method labels (key → label) — the same source the edit panel
  // resolves method labels from. One cheap tenant-scoped lookup.
  const methodRows = await sql<{ key: string; label: string }[]>`
    SELECT key, label FROM guesthub.lookup_items
    WHERE tenant_id = ${actor.tenantId} AND category = 'payment_methods'`;
  const methodLabels = new Map(methodRows.map((m) => [m.key, m.label]));

  const rooms: BookingDocRoom[] = r.rooms.map((room) => ({
    roomLabel: room.roomLabel,
    roomTypeName: room.roomTypeName,
    checkIn: room.checkIn,
    checkOut: room.checkOut,
    nights: nightsBetween(room.checkIn, room.checkOut),
    adults: room.adults,
    children: room.children,
    infants: room.infants,
    ratePerNight: room.ratePerNight,
    priceTotal: room.priceTotal,
    guestName:
      [room.guestFirstName, room.guestLastName].filter(Boolean).join(" ").trim() || null,
    guestPhone: room.guestPhone,
    guestIdNumber: room.guestIdNumber,
  }));

  const checkIns = rooms.map((room) => room.checkIn).sort();
  const checkOuts = rooms.map((room) => room.checkOut).sort();
  const stayCheckIn = checkIns[0] ?? null;
  const stayCheckOut = checkOuts.length ? checkOuts[checkOuts.length - 1] : null;
  const totalNights = stayCheckIn && stayCheckOut ? nightsBetween(stayCheckIn, stayCheckOut) : 0;

  const roomsSubtotal = rooms.reduce((sum, room) => sum + room.priceTotal, 0);
  const vatAmount = includedVatAmount(r.total_price, vatRate);
  const canViewInternalNotes = hasPermission(actor, "reservations.edit");

  const guestFullName = [r.guest.first_name, r.guest.last_name].filter(Boolean).join(" ").trim();

  const card = r.card;
  const maskedCard = card
    ? `${card.brand ?? "כרטיס"} •••• ${card.last4} (${String(card.expMonth).padStart(2, "0")}/${card.expYear})`
    : null;

  const payments: BookingDocPayment[] = r.payments.map((p) => ({
    amount: p.amount,
    method: p.method,
    methodLabel: p.method ? methodLabels.get(p.method) ?? p.method : null,
    paidAt: p.paid_at,
    reference: p.reference,
  }));

  const doc: BookingDoc = {
    reservationId: r.id,
    reservationNumber: r.reservation_number,
    status: r.status,
    statusLabel: statusLabel(r.status),
    sourceLabel: r.source_label,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    propertyName: await getPublicPropertyName(actor.tenantId, actor.tenantName),
    currency,
    guest: {
      fullName: guestFullName,
      phone: r.guest.phone,
      email: r.guest.email,
      idNumber: r.guest.id_number,
    },
    rooms,
    stayCheckIn,
    stayCheckOut,
    totalNights,
    roomsSubtotal,
    discountAmount: r.discount_amount,
    extraCharges: r.extra_charges,
    vatRate,
    vatAmount,
    totalPrice: r.total_price,
    paidAmount: r.paid_amount,
    balance: r.balance,
    payments,
    maskedCard,
    notes: canViewInternalNotes ? r.notes : null,
    canViewInternalNotes,
  };

  return { actor, doc };
}
