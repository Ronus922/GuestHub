import type { ActionResult } from "@/app/(dashboard)/calendar/types";

// ============================================================
// How the room picker applies an availability response. PURE and client-safe —
// StayEditor runs exactly this, and the guard (check:room-picker-window)
// asserts on it.
//
// The one invariant: a failed (or missing-data) refresh must NEVER leave the
// previous window's rows on screen — their free/occupied flags and avg_price
// belong to other dates, and the operator has no way to tell. Failure always
// clears the list and says why (audit finding, docs/PRICING_AUDIT.md §יא).
// ============================================================

export type RoomsFetchOutcome<R> = { rooms: R[]; error: string | null };

export const ROOMS_FETCH_FAILED = "טעינת החדרים הזמינים נכשלה — נסו לרענן או לשנות תאריכים";
export const NO_ROOMS_AVAILABLE = "לא נמצאו חדרים פעילים להצגה";

export function roomsFromResult<R>(res: ActionResult<R[]> | null): RoomsFetchOutcome<R> {
  if (!res || !res.success || !res.data) {
    return { rooms: [], error: res && !res.success && res.error ? res.error : ROOMS_FETCH_FAILED };
  }
  if (res.data.length === 0) return { rooms: [], error: NO_ROOMS_AVAILABLE };
  return { rooms: res.data, error: null };
}
