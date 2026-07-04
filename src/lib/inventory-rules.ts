// ============================================================
// PURE inventory & pricing rules (no imports, no DB) — the business half of
// src/lib/inventory.ts, kept pure so scripts/check-calendar.mjs can compile
// and assert it directly (same pattern as auth/guards.ts).
// ============================================================

// Which reservation statuses consume inventory (overview §8). Mirror of
// guesthub.inventory_blocking_statuses() (migration 004) — the two are
// asserted equal by scripts/check-inventory.mjs. cancelled / draft /
// checked_out / no_show do NOT block.
export const INVENTORY_BLOCKING_STATUSES = ["confirmed", "checked_in", "blocked"] as const;

// Statuses the calendar renders (everything except cancelled).
export const CALENDAR_VISIBLE_STATUSES = [
  "draft", "confirmed", "checked_in", "checked_out", "no_show", "blocked",
] as const;

export type RoomCapacity = {
  max_occupancy: number;
  max_adults: number;
  max_children: number;
  max_infants: number;
};

// Occupancy-vs-capacity rule, shared by create / edit / move (§L). Infants
// are NOT silently accepted: rooms without infant capacity reject them.
// Adults+children are bounded by max_occupancy; infants only by max_infants.
export function capacityViolation(
  cap: RoomCapacity,
  occ: { adults: number; children: number; infants: number },
): string | null {
  if (occ.adults < 1) return "נדרש מבוגר אחד לפחות בחדר";
  if (occ.adults > cap.max_adults) return `מקסימום ${cap.max_adults} מבוגרים בחדר`;
  if (occ.children > cap.max_children) return `מקסימום ${cap.max_children} ילדים בחדר`;
  if (occ.infants > cap.max_infants)
    return cap.max_infants === 0
      ? "החדר אינו מאפשר תינוקות"
      : `מקסימום ${cap.max_infants} תינוקות בחדר`;
  if (occ.adults + occ.children > cap.max_occupancy)
    return `קיבולת החדר היא ${cap.max_occupancy} אורחים`;
  return null;
}

// Payment state derived from real money columns — never a free-standing flag,
// so a "payment status change" can never lose a reservation (§F).
export type PaymentState = "unpaid" | "partial" | "paid";

export function paymentState(totalPrice: number, paidAmount: number): PaymentState {
  if (paidAmount <= 0) return "unpaid";
  if (paidAmount < totalPrice) return "partial";
  return "paid";
}

// One nightly rate row as loaded from guesthub.rates (room- or type-level).
export type RateRow = {
  date: string; // DateOnly
  room_id: string | null;
  room_type_id: string | null;
  price: string | number | null;
  min_nights: number | null;
  max_nights: number | null;
  closed: boolean;
  closed_to_arrival: boolean;
  closed_to_departure: boolean;
};

// Effective rate resolution for one date (§9/§K): specific room row wins over
// room-type row; base_price is the documented fallback when neither has price.
export function resolveRate(
  rows: RateRow[],
  date: string,
  roomId: string,
  roomTypeId: string | null,
): RateRow | null {
  let typeRow: RateRow | null = null;
  for (const r of rows) {
    if (r.date !== date) continue;
    if (r.room_id === roomId) return r;
    if (r.room_id == null && roomTypeId != null && r.room_type_id === roomTypeId)
      typeRow = typeRow ?? r;
  }
  return typeRow;
}

export function effectiveNightlyPrice(
  rows: RateRow[],
  date: string,
  roomId: string,
  roomTypeId: string | null,
  basePrice: number,
): number {
  const rate = resolveRate(rows, date, roomId, roomTypeId);
  const p = rate?.price;
  return p == null ? basePrice : Number(p);
}

// Stay-restriction validation for a NEW sale / reschedule (§K): the calendar
// must not permit what the reservation engine rejects. `nights(d)` iterates
// the stay's occupied nights [checkIn, checkOut).
export function restrictionViolation(
  rows: RateRow[],
  stay: { checkIn: string; checkOut: string; nights: string[] },
  roomId: string,
  roomTypeId: string | null,
): string | null {
  const arrival = resolveRate(rows, stay.checkIn, roomId, roomTypeId);
  const nightsCount = stay.nights.length;
  if (arrival) {
    if (arrival.closed_to_arrival) return "התאריך סגור לצ׳ק-אין (CTA)";
    if (arrival.min_nights != null && nightsCount < arrival.min_nights)
      return `מינימום ${arrival.min_nights} לילות בתאריך זה`;
    if (arrival.max_nights != null && nightsCount > arrival.max_nights)
      return `מקסימום ${arrival.max_nights} לילות בתאריך זה`;
  }
  const departure = resolveRate(rows, stay.checkOut, roomId, roomTypeId);
  if (departure?.closed_to_departure) return "התאריך סגור לצ׳ק-אאוט (CTD)";
  for (const d of stay.nights) {
    const rate = resolveRate(rows, d, roomId, roomTypeId);
    if (rate?.closed) return `התאריך ${d} סגור למכירה`;
  }
  return null;
}
