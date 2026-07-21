import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { addDays, eachDay, nightsBetween, type DateOnly } from "@/lib/dates";
import { EXCLUDED_SU_CODES, PUBLIC_TENANT_ID } from "./config";

// ============================================================
// Public availability read model — the aggregation behind both
// GET /api/public/availability and the booking transaction (which re-runs it
// inside the tx after lockRooms). Source of truth: effective_sell_state
// (migration 009) — the SAME function the internal rates grid reads, so the
// public site can never disagree with the back office.
//
// Correctness rule: a stay is bookable on a sellable unit only if THAT SAME
// physical unit passes every night — units are never combined across nights.
// The filter must never be MORE permissive than priceReservationStays, or
// guests hit dead-end checkouts.
// ============================================================

type UnitMetaRow = {
  su_id: string;
  code: string;
  room_id: string | null;
  room_type_id: string | null;
  room_type_name: string | null;
  base_price: number;
  max_occupancy: number;
};

type EssRow = {
  sellable_unit_id: string;
  day: string;
  availability: number;
  price: number | null;
  sellable: boolean;
  min_stay_arrival: number | null;
  min_stay_through: number | null;
  max_stay: number | null;
  closed_to_arrival: boolean;
  closed_to_departure: boolean;
  stop_sell: boolean;
};

export type BookableUnit = {
  suId: string;
  roomId: string;
  code: string;
  totalPrice: number;
  nightly: Array<{ date: DateOnly; price: number }>;
};

export type RoomTypeAvailability = {
  roomTypeId: string;
  name: string;
  maxOccupancy: number;
  basePrice: number;
  availableUnits: number;
  // cheapest bookable unit for the whole stay (null when sold out)
  totalPrice: number | null;
  pricePerNight: number | null;
  nightly: Array<{ date: DateOnly; price: number }>;
  // booking-time detail, sorted (totalPrice ASC, code ASC) — the deterministic
  // room-selection order, so the quoted "from" price is exactly what gets booked
  units: BookableUnit[];
};

export async function publicAvailability(
  db: Sql | TransactionSql,
  checkIn: DateOnly,
  checkOut: DateOnly,
): Promise<RoomTypeAvailability[]> {
  const nights = nightsBetween(checkIn, checkOut);
  const stayNights = eachDay(checkIn, checkOut);
  // +1 day: effective_sell_state's p_to is exclusive, and the departure-day row
  // is fetched solely to read closed_to_departure.
  const toPlusOne = addDays(checkOut, 1);

  // Unit meta — identity joined from the canonical rooms table (D74 pattern,
  // rates/grid-state.ts). Only sole-member units carry a room_id; today every
  // unit is sole-member. ponytail: pooled units are skipped for online booking
  // (no deterministic physical room) — revisit if pooling is ever enabled.
  const units = await db<UnitMetaRow[]>`
    SELECT su.id AS su_id,
           COALESCE(m.room_number, su.code) AS code,
           m.room_id,
           COALESCE(m.room_type_id, su.room_type_id) AS room_type_id,
           rt.name AS room_type_name,
           COALESCE(rt.base_price, 0)::float8 AS base_price,
           COALESCE(rt.max_occupancy, 2)::int AS max_occupancy
    FROM guesthub.sellable_units su
    LEFT JOIN LATERAL (
      SELECT r.id AS room_id, r.room_number, r.room_type_id
      FROM guesthub.sellable_unit_rooms sur
      JOIN guesthub.rooms r ON r.id = sur.room_id
      WHERE sur.sellable_unit_id = su.id
        AND NOT EXISTS (SELECT 1 FROM guesthub.sellable_unit_rooms s2
                        WHERE s2.sellable_unit_id = su.id AND s2.room_id <> r.id)
      LIMIT 1
    ) m ON true
    LEFT JOIN guesthub.room_types rt ON rt.id = COALESCE(m.room_type_id, su.room_type_id)
    WHERE su.tenant_id = ${PUBLIC_TENANT_ID} AND su.is_active`;

  const ess = await db<EssRow[]>`
    SELECT sellable_unit_id, day::text AS day, availability,
           price::float8 AS price, sellable,
           min_stay_arrival, min_stay_through, max_stay,
           closed_to_arrival, closed_to_departure, stop_sell
    FROM guesthub.effective_sell_state(${PUBLIC_TENANT_ID}, ${checkIn}, ${toPlusOne})`;
  const essByKey = new Map(ess.map((r) => [`${r.sellable_unit_id}|${r.day}`, r]));

  const round2 = (n: number) => Math.round(n * 100) / 100;

  const byType = new Map<string, RoomTypeAvailability>();
  for (const u of units) {
    if (!u.room_type_id || !u.room_type_name) continue;
    if (!u.room_id) continue;
    if (EXCLUDED_SU_CODES.includes(u.code)) continue;

    let type = byType.get(u.room_type_id);
    if (!type) {
      type = {
        roomTypeId: u.room_type_id,
        name: u.room_type_name,
        maxOccupancy: u.max_occupancy,
        basePrice: u.base_price,
        availableUnits: 0,
        totalPrice: null,
        pricePerNight: null,
        nightly: [],
        units: [],
      };
      byType.set(u.room_type_id, type);
    }

    // The same physical unit must pass EVERY night of the stay.
    let ok = true;
    const nightly: Array<{ date: DateOnly; price: number }> = [];
    for (const day of stayNights) {
      const row = essByKey.get(`${u.su_id}|${day}`);
      if (
        !row || !row.sellable || row.availability < 1 || row.stop_sell ||
        row.price == null ||
        nights < (row.min_stay_through ?? 1)
      ) { ok = false; break; }
      if (day === checkIn) {
        if (
          row.closed_to_arrival ||
          nights < (row.min_stay_arrival ?? 1) ||
          (row.max_stay != null && nights > row.max_stay)
        ) { ok = false; break; }
      }
      nightly.push({ date: day, price: round2(row.price) });
    }
    const departure = essByKey.get(`${u.su_id}|${checkOut}`);
    if (ok && departure?.closed_to_departure) ok = false;
    if (!ok) continue;

    type.units.push({
      suId: u.su_id,
      roomId: u.room_id,
      code: u.code,
      totalPrice: round2(nightly.reduce((s, n) => s + n.price, 0)),
      nightly,
    });
  }

  for (const type of byType.values()) {
    type.units.sort((a, b) => a.totalPrice - b.totalPrice || a.code.localeCompare(b.code, "he"));
    type.availableUnits = type.units.length;
    const cheapest = type.units[0];
    if (cheapest) {
      type.totalPrice = cheapest.totalPrice;
      type.pricePerNight = round2(cheapest.totalPrice / nights);
      type.nightly = cheapest.nightly;
    }
  }

  return [...byType.values()].sort((a, b) => a.basePrice - b.basePrice);
}
