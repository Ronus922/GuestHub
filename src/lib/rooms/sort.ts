// Canonical room ordering (D86). Room numbers are stored as `text`, so both
// Postgres and JS default to a lexicographic sort ("1006" < "100" < "926") and
// the calendar showed rooms in an order that reads as random to staff.
//
// This is the ONE comparator every calendar surface orders by — the sticky room
// column, the grid body, closures, prices and drag targets all iterate the same
// array, so ordering is decided here and nowhere else. It is a VISUAL key only:
// room ids, room numbers and every mapping keyed by them are untouched.
//
// Rule: purely numeric room numbers first, in true numeric order; anything else
// (legacy "A12", "פנטהאוז") after them, in natural language order. Equal numeric
// values keep their input order — callers feed a deterministic list, and
// Array.prototype.sort is stable.

const NUMERIC = /^\d+$/;

/** Numeric value of a purely-numeric room number, else null. */
function numericValue(roomNumber: string): number | null {
  const trimmed = (roomNumber ?? "").trim();
  if (!NUMERIC.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Canonical comparator: numeric rooms ascending, then non-numeric naturally. */
export function compareRoomNumber(a: string, b: string): number {
  const na = numericValue(a);
  const nb = numericValue(b);
  if (na !== null && nb !== null) return na - nb; // 100 < 926 < 1006 — never localeCompare
  if (na !== null) return -1; // numeric rooms always come first
  if (nb !== null) return 1;
  return (a ?? "").localeCompare(b ?? "", "he", { numeric: true, sensitivity: "base" });
}

/** Sort any room-shaped rows by the canonical order. Returns a new array. */
export function sortRoomsByNumber<T extends { room_number: string }>(rooms: readonly T[]): T[] {
  return [...rooms].sort((a, b) => compareRoomNumber(a.room_number, b.room_number));
}
