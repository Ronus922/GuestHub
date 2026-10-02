// ============================================================
// WHICH NIGHTS OF A ROOM ARE ALREADY TAKEN — the booking windows' stay picker
// paints them (light red, the closure calendar's look) so the operator sees a
// collision BEFORE drawing a range across it.
//
// VISUAL ONLY (owner decision 1): a taken night stays selectable and nothing
// here gates a save — the server's check_room_availability under lock stays
// the authority. This module only answers "what to paint", reusing the closure
// calendar's own model (occupiedNights) so the two calendars can never disagree
// on what a taken night is:
//   - a stay holds [check_in, check_out) — its departure day is FREE (D32);
//   - every status but 'cancelled' holds inventory (D126, blocksInventory);
//   - a closure holds [start_date, end_date) only when kind = 'ooo' — an OOS
//     closure is dirty-but-sellable and never a conflict (040 §8);
//   - the reservation being EDITED never paints itself (owner decision 4);
//   - another card of the SAME unsaved form on the same room paints its nights
//     (owner decision 6) — it is not in the DB yet, so the server can't say.
// Pure (no React, no DB) so scripts/check-datepicker.mjs RUNS it.
// ============================================================
import { addMonths, eachDay, type DateOnly } from "@/lib/dates";
import {
  occupiedNights,
  type OccupancyClosure,
  type OccupancyStay,
  type OccupancyWindow,
} from "@/lib/closures/occupancy";

/** a reservation_rooms row joined to its reservation's status */
export type StayRow = Omit<OccupancyStay, "guest_name"> & { reservation_id: string };
/** a room_closures row with its kind ('ooo' | 'oos') */
export type ClosureRow = OccupancyClosure & { kind: string };
/** another card in the same unsaved form */
export type SiblingStay = { roomId: string; checkIn: string; checkOut: string };

/** The taken nights of ONE room inside [window.from, window.to), sorted. */
export function roomTakenNights({
  roomId,
  stays,
  closures,
  window,
  excludeReservationId,
}: {
  roomId: string;
  stays: readonly StayRow[];
  closures: readonly ClosureRow[];
  window: OccupancyWindow;
  excludeReservationId?: string;
}): DateOnly[] {
  const owed = occupiedNights({
    roomId,
    stays: stays
      .filter((s) => s.reservation_id !== excludeReservationId)
      .map((s) => ({ ...s, guest_name: "" })),
    closures: closures.filter((c) => c.kind === "ooo"),
  });
  return [...owed.keys()].filter((d) => d >= window.from && d < window.to).sort();
}

/** the fetched nights plus the nights of sibling cards on the same room */
export function withSiblingNights(
  fetched: Iterable<DateOnly>,
  roomId: string,
  siblings: readonly SiblingStay[],
): Set<DateOnly> {
  const out = new Set(fetched);
  if (!roomId) return out;
  for (const s of siblings) {
    if (s.roomId !== roomId || !s.checkIn || !s.checkOut || !(s.checkOut > s.checkIn)) continue;
    for (const d of eachDay(s.checkIn, s.checkOut)) out.add(d);
  }
  return out;
}

/** does the stay [checkIn, checkOut) sleep through at least one taken night */
export function rangeHasTakenNight(
  taken: ReadonlySet<DateOnly>,
  checkIn: string,
  checkOut: string,
): boolean {
  if (!checkIn || !checkOut || !(checkOut > checkIn) || taken.size === 0) return false;
  return eachDay(checkIn, checkOut).some((d) => taken.has(d));
}

/** "YYYY-MM-01" of every month in [from, to) — the cache's unit */
export function monthsIn(window: OccupancyWindow): DateOnly[] {
  const out: DateOnly[] = [];
  for (let m = `${window.from.slice(0, 7)}-01`; m < window.to; m = addMonths(m, 1)) out.push(m);
  return out;
}
