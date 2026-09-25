import { MAX_PUBLIC_ROOMS } from "./guests";

// ============================================================
// D195 (owner, 2026-09-25): which offered unit serves which requested room.
//
// The availability read model offers every unit that can host AT LEAST ONE of
// the requested parties and prices it per party — partyPrices[i] is the
// engine's price for room i, null where the unit cannot host that room's
// party. Rooms are therefore never assigned positionally: room i may only take
// a unit whose partyPrices[i] is a number.
//
// The rule (deterministic — sea-tower mirrors it to compute expectedTotal):
//   1. the preferred unit (the card the guest chose) serves room 0. It must be
//      offered AND host party 0 — otherwise an explicit error, never a swap.
//   2. the remaining rooms take the CHEAPEST VALID COMBINATION of the remaining
//      units: the minimum of Σ partyPrices[i] over rooms, each unit at most
//      once. Ties: the combination reached first when units are tried in the
//      offered order (price ASC, code) room by room.
//   With equal parties this is exactly the historical "cheapest N units" pick.
//
// Pure: no DB, no engine — every price here is already the engine's.
// ============================================================

export type AssignableUnit = { suId: string; partyPrices?: Array<number | null> };

export type UnitAssignment<U> =
  | { ok: true; units: U[] }
  | { ok: false; reason: "preferred_unavailable" | "preferred_mismatch" | "no_combination" };

export function assignUnitsToRooms<U extends AssignableUnit>(
  offered: U[],
  roomCount: number,
  preferredUnitId: string | null,
): UnitAssignment<U> {
  // a unit priced without a party list (no partyPrices) hosts nothing here:
  // the caller must have asked availability for the actual parties
  const priceOf = (u: U, room: number): number | null => u.partyPrices?.[room] ?? null;
  if (roomCount < 1 || roomCount > MAX_PUBLIC_ROOMS) return { ok: false, reason: "no_combination" };

  const fixed: U[] = [];
  if (preferredUnitId) {
    const pref = offered.find((u) => u.suId === preferredUnitId);
    if (!pref) return { ok: false, reason: "preferred_unavailable" };
    if (priceOf(pref, 0) === null) return { ok: false, reason: "preferred_mismatch" };
    fixed.push(pref);
  }
  const rest = offered.filter((u) => u !== fixed[0]);

  // exhaustive over ≤ MAX_PUBLIC_ROOMS rooms; prices are > 0, so a partial sum
  // that already reaches the best total cannot improve on it (prune)
  const best: { units: U[] | null; total: number } = { units: null, total: Infinity };
  const chosen: U[] = [];
  const used = new Set<string>();
  const walk = (room: number, total: number): void => {
    if (total >= best.total) return;
    if (room === roomCount) { best.units = [...chosen]; best.total = total; return; }
    for (const u of rest) {
      if (used.has(u.suId)) continue;
      const price = priceOf(u, room);
      if (price === null) continue;
      used.add(u.suId); chosen.push(u);
      walk(room + 1, total + price);
      chosen.pop(); used.delete(u.suId);
    }
  };
  walk(fixed.length, 0);
  if (!best.units) return { ok: false, reason: "no_combination" };
  return { ok: true, units: [...fixed, ...best.units] };
}
