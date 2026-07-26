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

// The quote is MONEY read aloud to a guest: stricter than the room list. A
// quote renders only from a success-with-data response for the range on
// screen; every other outcome (failure, rejection, missing data) yields
// quote:null — so no number can render — plus the reason.
export type QuoteFetchOutcome<Q> = { quote: Q | null; error: string | null };

export const QUOTE_FETCH_FAILED = "חישוב המחיר נכשל — אין מחיר תקף לטווח שנבחר";

export function quoteFromResult<Q>(res: ActionResult<Q> | null): QuoteFetchOutcome<Q> {
  if (res?.success && res.data) return { quote: res.data, error: null };
  return { quote: null, error: res && !res.success && res.error ? res.error : QUOTE_FETCH_FAILED };
}
