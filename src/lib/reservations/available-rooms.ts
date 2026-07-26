import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { eachDay, nightsBetween, type DateOnly } from "@/lib/dates";
import { checkRoomAvailability } from "@/lib/inventory";
import { getRoomPlanRates } from "@/lib/rates/effective-state";
import { indexByDate, planNightlyPrice } from "@/lib/rates/rules";
import { resolveMaxQuoteNights } from "@/lib/pricing/types";

// ============================================================
// The booking-panel room picker: free/occupied flags and a display-only
// avg_price hint for a date window. Extracted from getAvailableRoomsAction so
// the guard (check:room-picker-window) drives the code the app runs.
//
// The window bound is the SAME per-tenant quote window the pricing engine
// enforces (resolveMaxQuoteNights, D100) — not a second constant. A leftover
// hardcoded 90 here kept refusing 91+-night pickers after D100 raised the
// engine to a default of 400.
// ============================================================

export type AvailableRoom = {
  id: string;
  room_number: string;
  name: string | null;
  room_type_id: string | null;
  room_type_name: string | null;
  max_occupancy: number;
  max_adults: number;
  max_children: number;
  max_infants: number;
  avg_price: number;
  free: boolean;
};

export type AvailableRoomsResult =
  | { ok: true; rooms: AvailableRoom[] }
  | { ok: false; error: string };

export async function listAvailableRooms(
  db: Sql | TransactionSql,
  tenantId: string,
  args: { checkIn: DateOnly; checkOut: DateOnly; excludeReservationId?: string },
): Promise<AvailableRoomsResult> {
  if (!(args.checkIn < args.checkOut)) return { ok: false, error: "טווח תאריכים לא תקין" };

  const [tenant] = await db<{ pricing: unknown }[]>`
    SELECT settings->'pricing' AS pricing
    FROM guesthub.tenants WHERE id = ${tenantId}`;
  const maxNights = resolveMaxQuoteNights(tenant?.pricing);
  if (nightsBetween(args.checkIn, args.checkOut) > maxNights) {
    // the engine's wording (engine.ts QUOTE_WINDOW_EXCEEDED): name the bound
    return { ok: false, error: `טווח התאריכים חורג מחלון התמחור המותר (${maxNights} לילות)` };
  }

  const rooms = await db<
    { id: string; room_number: string; name: string | null; room_type_id: string | null;
      room_type_name: string | null; base_price: number;
      max_occupancy: number; max_adults: number; max_children: number; max_infants: number }[]
  >`
    SELECT r.id, r.room_number, r.name, r.room_type_id, rt.name AS room_type_name,
           COALESCE(rt.base_price, 0)::float8 AS base_price,
           r.max_occupancy, r.max_adults, r.max_children, r.max_infants
    FROM guesthub.rooms r
    LEFT JOIN guesthub.room_types rt ON rt.id = r.room_type_id
    WHERE r.tenant_id = ${tenantId} AND r.status = 'available' AND r.is_active
    ORDER BY r.room_number`;

  const excludeRr = args.excludeReservationId
    ? (
        await db<{ id: string }[]>`
          SELECT id FROM guesthub.reservation_rooms
          WHERE reservation_id = ${args.excludeReservationId} AND tenant_id = ${tenantId}`
      ).map((r) => r.id)
    : [];

  const conflicts = await checkRoomAvailability(db, {
    tenantId,
    roomIds: rooms.map((r) => r.id),
    checkIn: args.checkIn,
    checkOut: args.checkOut,
    excludeReservationRoomIds: excludeRr,
  });
  const busy = new Set(conflicts.map((c) => c.room_id));

  // Canonical commercial prices (§0.4): room → SU → base plan → pricing_plan_rates.
  const planRates = await getRoomPlanRates(
    db, tenantId, rooms.map((r) => r.id), args.checkIn, args.checkOut,
  );

  const nights = eachDay(args.checkIn, args.checkOut);
  const data = rooms.map((r) => {
    const rp = planRates.get(r.id);
    const byDate = indexByDate(rp?.rows ?? []);
    const base = rp?.basePrice ?? r.base_price;
    const total = nights.reduce((sum, d) => sum + planNightlyPrice(byDate, d, base), 0);
    return {
      id: r.id,
      room_number: r.room_number,
      name: r.name,
      room_type_id: r.room_type_id,
      room_type_name: r.room_type_name,
      max_occupancy: r.max_occupancy,
      max_adults: r.max_adults,
      max_children: r.max_children,
      max_infants: r.max_infants,
      avg_price: nights.length > 0 ? Math.round(total / nights.length) : 0,
      free: !busy.has(r.id),
    };
  });
  return { ok: true, rooms: data };
}
