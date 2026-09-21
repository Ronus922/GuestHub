import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { balanceOf, displayPaymentState, type PaymentState } from "@/lib/inventory-rules";
import { BiosBotError } from "../errors";

// ============================================================
// guesthub.get_reservation / guesthub.get_guest_reservations (Phase 5).
//
// A NEW, deliberately narrow read model — NOT a reuse of getReservationAction
// (session-bound, and its response shape includes masked card metadata this
// boundary must never carry at all). guesthub.reservation_cards is never
// joined or selected here, by construction, not by stripping fields after
// the fact (Phase 5 §9).
//
// balance and paymentState are computed through the SAME canonical functions
// every other surface uses (balanceOf / displayPaymentState,
// src/lib/inventory-rules.ts) — never a second formula.
//
// notes/internal_notes are deliberately OMITTED: `notes` can carry
// staff-authored billing text (see migration 059), so exposing it here
// without a specific product decision about what it may contain risks a
// bot reading operator-only text back to a guest. Left for a future,
// explicit owner decision rather than guessed at.
// ============================================================

export type BiosBotReservationRoom = {
  roomId: string | null;
  roomNumber: string | null;
  roomName: string | null;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  infants: number;
  subtotal: number;
};

export type BiosBotReservation = {
  id: string;
  reservationNumber: string;
  status: string;
  workflowStatus: { key: string; label: string } | null;
  checkIn: string;
  checkOut: string;
  guest: { firstName: string | null; lastName: string | null; phone: string | null; email: string | null } | null;
  rooms: BiosBotReservationRoom[];
  totalPrice: number;
  paidAmount: number;
  balance: number;
  paymentState: PaymentState;
  currency: string;
  source: string | null;
  isChannelManaged: boolean;
};

type ReservationRow = {
  id: string;
  reservation_number: string;
  status: string;
  check_in: string;
  check_out: string;
  total_price: number;
  paid_amount: number;
  currency: string;
  channel_connection_id: string | null;
  workflow_key: string | null;
  workflow_label: string | null;
  guest_first_name: string | null;
  guest_last_name: string | null;
  guest_phone: string | null;
  guest_email: string | null;
  source_label: string | null;
};

type ReservationRoomRow = {
  room_id: string | null;
  room_number: string | null;
  room_name: string | null;
  check_in: string;
  check_out: string;
  adults: number;
  children: number;
  infants: number;
  price_total: number;
};

function toBiosBotReservation(row: ReservationRow, rooms: ReservationRoomRow[]): BiosBotReservation {
  const hasGuest = row.guest_first_name || row.guest_last_name || row.guest_phone || row.guest_email;
  return {
    id: row.id,
    reservationNumber: row.reservation_number,
    status: row.status,
    workflowStatus: row.workflow_key ? { key: row.workflow_key, label: row.workflow_label ?? row.workflow_key } : null,
    checkIn: row.check_in,
    checkOut: row.check_out,
    guest: hasGuest
      ? { firstName: row.guest_first_name, lastName: row.guest_last_name, phone: row.guest_phone, email: row.guest_email }
      : null,
    rooms: rooms.map((rr) => ({
      roomId: rr.room_id,
      roomNumber: rr.room_number,
      roomName: rr.room_name,
      checkIn: rr.check_in,
      checkOut: rr.check_out,
      adults: rr.adults,
      children: rr.children,
      infants: rr.infants,
      subtotal: rr.price_total,
    })),
    totalPrice: row.total_price,
    paidAmount: row.paid_amount,
    balance: balanceOf(row.total_price, row.paid_amount),
    paymentState: displayPaymentState(row.workflow_key, row.total_price, row.paid_amount),
    currency: row.currency,
    source: row.source_label,
    isChannelManaged: row.channel_connection_id != null,
  };
}

async function loadRooms(db: Sql | TransactionSql, tenantId: string, reservationId: string): Promise<ReservationRoomRow[]> {
  return db<ReservationRoomRow[]>`
    SELECT rr.room_id, ro.room_number, ro.name AS room_name,
           rr.check_in::text AS check_in, rr.check_out::text AS check_out,
           rr.adults, rr.children, rr.infants, rr.price_total::float8 AS price_total
    FROM guesthub.reservation_rooms rr
    LEFT JOIN guesthub.rooms ro ON ro.id = rr.room_id
    WHERE rr.tenant_id = ${tenantId} AND rr.reservation_id = ${reservationId}
    ORDER BY rr.check_in`;
}

export async function getBiosBotReservation(
  db: Sql | TransactionSql,
  tenantId: string,
  reservationId: string,
): Promise<BiosBotReservation> {
  const [row] = await db<ReservationRow[]>`
    SELECT r.id, r.reservation_number, r.status,
           r.check_in::text AS check_in, r.check_out::text AS check_out,
           r.total_price::float8 AS total_price, r.paid_amount::float8 AS paid_amount,
           r.currency, r.channel_connection_id,
           ws.key AS workflow_key, ws.label AS workflow_label,
           g.first_name AS guest_first_name, g.last_name AS guest_last_name,
           g.phone AS guest_phone, g.email AS guest_email,
           src.label AS source_label
    FROM guesthub.reservations r
    LEFT JOIN guesthub.lookup_items ws ON ws.id = r.workflow_status_id
    LEFT JOIN guesthub.guests g ON g.id = r.primary_guest_id
    LEFT JOIN guesthub.lookup_items src ON src.id = r.source_id
    WHERE r.tenant_id = ${tenantId} AND r.id = ${reservationId}`;
  if (!row) throw new BiosBotError("RESERVATION_NOT_FOUND", "reservation not found");
  const rooms = await loadRooms(db, tenantId, row.id);
  return toBiosBotReservation(row, rooms);
}

// Strict identifiers only — exact match, never a substring/ILIKE search (this
// is NOT a generic guest search API, Phase 5 §8E). Each identifier alone is
// specific enough to avoid enumeration (a real reservation number, or a
// caller's own exact phone/email); the union type keeps callers from OR'ing
// several identifiers together into a looser match.
export type BiosBotCustomerLookup =
  | { reservationNumber: string }
  | { phone: string }
  | { email: string };

const MAX_CUSTOMER_LOOKUP_RESULTS = 5;

export async function lookupBiosBotReservationsByCustomer(
  db: Sql | TransactionSql,
  tenantId: string,
  q: BiosBotCustomerLookup,
): Promise<BiosBotReservation[]> {
  let rows: ReservationRow[];
  if ("reservationNumber" in q) {
    rows = await db<ReservationRow[]>`
      SELECT r.id, r.reservation_number, r.status,
             r.check_in::text AS check_in, r.check_out::text AS check_out,
             r.total_price::float8 AS total_price, r.paid_amount::float8 AS paid_amount,
             r.currency, r.channel_connection_id,
             ws.key AS workflow_key, ws.label AS workflow_label,
             g.first_name AS guest_first_name, g.last_name AS guest_last_name,
             g.phone AS guest_phone, g.email AS guest_email,
             src.label AS source_label
      FROM guesthub.reservations r
      LEFT JOIN guesthub.lookup_items ws ON ws.id = r.workflow_status_id
      LEFT JOIN guesthub.guests g ON g.id = r.primary_guest_id
      LEFT JOIN guesthub.lookup_items src ON src.id = r.source_id
      WHERE r.tenant_id = ${tenantId} AND r.reservation_number = ${q.reservationNumber}
      LIMIT 1`;
  } else if ("phone" in q) {
    rows = await db<ReservationRow[]>`
      SELECT r.id, r.reservation_number, r.status,
             r.check_in::text AS check_in, r.check_out::text AS check_out,
             r.total_price::float8 AS total_price, r.paid_amount::float8 AS paid_amount,
             r.currency, r.channel_connection_id,
             ws.key AS workflow_key, ws.label AS workflow_label,
             g.first_name AS guest_first_name, g.last_name AS guest_last_name,
             g.phone AS guest_phone, g.email AS guest_email,
             src.label AS source_label
      FROM guesthub.reservations r
      LEFT JOIN guesthub.lookup_items ws ON ws.id = r.workflow_status_id
      JOIN guesthub.guests g ON g.id = r.primary_guest_id
      LEFT JOIN guesthub.lookup_items src ON src.id = r.source_id
      WHERE r.tenant_id = ${tenantId} AND g.phone = ${q.phone}
      ORDER BY r.check_in DESC
      LIMIT ${MAX_CUSTOMER_LOOKUP_RESULTS}`;
  } else {
    rows = await db<ReservationRow[]>`
      SELECT r.id, r.reservation_number, r.status,
             r.check_in::text AS check_in, r.check_out::text AS check_out,
             r.total_price::float8 AS total_price, r.paid_amount::float8 AS paid_amount,
             r.currency, r.channel_connection_id,
             ws.key AS workflow_key, ws.label AS workflow_label,
             g.first_name AS guest_first_name, g.last_name AS guest_last_name,
             g.phone AS guest_phone, g.email AS guest_email,
             src.label AS source_label
      FROM guesthub.reservations r
      LEFT JOIN guesthub.lookup_items ws ON ws.id = r.workflow_status_id
      JOIN guesthub.guests g ON g.id = r.primary_guest_id
      LEFT JOIN guesthub.lookup_items src ON src.id = r.source_id
      WHERE r.tenant_id = ${tenantId} AND lower(g.email) = lower(${q.email})
      ORDER BY r.check_in DESC
      LIMIT ${MAX_CUSTOMER_LOOKUP_RESULTS}`;
  }

  const results: BiosBotReservation[] = [];
  for (const row of rows) {
    const rooms = await loadRooms(db, tenantId, row.id);
    results.push(toBiosBotReservation(row, rooms));
  }
  return results;
}
