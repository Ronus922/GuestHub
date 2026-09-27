import "server-only";
import type { Sql, TransactionSql } from "postgres";
import type { DateOnly } from "@/lib/dates";
import { nightsBetween } from "@/lib/dates";
import { publicAvailability } from "@/lib/public-booking/availability";
import { getRoomCapacities } from "@/lib/inventory";

// ============================================================
// guesthub.search_availability (Phase 5).
//
// Composes two authoritative primitives — never a parallel algorithm:
//   1. publicAvailability() (src/lib/public-booking/availability.ts) — the
//      SAME date/status/closure/overlap facts (effective_sell_state,
//      checkRoomAvailability's own DB function underneath) the public
//      website and the booking transaction both read. It lists EVERY
//      individual bookable unit per room type, not just the cheapest.
//   2. getRoomCapacities() (src/lib/inventory.ts) — the SAME room→room-type
//      capacity fallback the pricing engine enforces (migration 091).
//
// This function only FILTERS that authoritative unit list down to units
// whose effective capacity fits the requested party — it invents no
// availability or capacity fact of its own. The exact, final, party-priced
// total always comes from guesthub.get_quote (calculateReservationPrice) —
// this endpoint's prices are a "from" hint for browsing, same as the public
// website's.
//
// availableRooms (D196): the booking inventory itself — every unit of the
// type that the engine offers for these dates AND that fits the party, with
// its effective capacity. These are the room ids a quote/booking may use.
// It is deliberately NOT the website catalog (publicWebsiteRooms, which also
// requires show_on_website + an image): a room without a photo is still
// sellable. Status/active rules are the engine's own (sellable_unit_inventory:
// status = 'available' AND is_active), not re-implemented here.
// ============================================================

export type BiosBotAvailabilityQuery = {
  checkIn: DateOnly;
  checkOut: DateOnly;
  adults: number;
  children: number;
  infants: number;
};

export type BiosBotAvailableRoom = {
  roomId: string;
  roomNumber: string;
  maxOccupancy: number;
  maxAdults: number;
  maxChildren: number;
  maxInfants: number;
};

export type BiosBotRoomTypeAvailability = {
  roomTypeId: string;
  name: string;
  availableUnits: number;
  fromTotalPrice: number;
  fromPricePerNight: number;
  currency: string;
  // additive (D196) — cheapest first, same order as the "from" price
  availableRooms: BiosBotAvailableRoom[];
};

export async function searchBiosBotAvailability(
  db: Sql | TransactionSql,
  tenantId: string,
  q: BiosBotAvailabilityQuery,
): Promise<BiosBotRoomTypeAvailability[]> {
  const nights = nightsBetween(q.checkIn, q.checkOut);
  const types = await publicAvailability(db, q.checkIn, q.checkOut, { tenantId });

  const allRoomIds = types.flatMap((t) => t.units.map((u) => u.roomId));
  const capacities = await getRoomCapacities(db, tenantId, allRoomIds);

  const fitsParty = (roomId: string): boolean => {
    const cap = capacities.get(roomId);
    if (!cap) return false; // no room row resolved → cannot vouch for it
    if (q.adults > cap.max_adults) return false;
    if (q.children > cap.max_children) return false;
    if (q.infants > cap.max_infants) return false;
    if (q.adults + q.children > cap.max_occupancy) return false;
    return true;
  };

  const results: BiosBotRoomTypeAvailability[] = [];
  for (const t of types) {
    const eligible = t.units.filter((u) => fitsParty(u.roomId));
    if (eligible.length === 0) continue;
    const cheapest = [...eligible].sort(
      (a, b) => a.totalPrice - b.totalPrice || a.code.localeCompare(b.code, "he"),
    )[0];
    results.push({
      roomTypeId: t.roomTypeId,
      name: t.name,
      availableUnits: eligible.length,
      fromTotalPrice: cheapest.totalPrice,
      fromPricePerNight: nights > 0 ? Math.round((cheapest.totalPrice / nights) * 100) / 100 : cheapest.totalPrice,
      currency: "ILS",
      availableRooms: [...eligible]
        .sort((a, b) => a.totalPrice - b.totalPrice || a.code.localeCompare(b.code, "he"))
        .map((u) => {
          const cap = capacities.get(u.roomId)!; // eligible ⇒ fitsParty found it
          return {
            roomId: u.roomId,
            roomNumber: u.code,
            maxOccupancy: cap.max_occupancy,
            maxAdults: cap.max_adults,
            maxChildren: cap.max_children,
            maxInfants: cap.max_infants,
          };
        }),
    });
  }
  return results.sort((a, b) => a.fromTotalPrice - b.fromTotalPrice);
}
