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

// Canonical reservation payment state derived from the real money columns —
// never a free-standing flag, so a "payment status change" can never lose a
// reservation (§F). paid_amount/total_price come from the payments LEDGER
// (recomputePaymentAggregates, D51). "overpaid" (paid > total) is surfaced as a
// customer credit rather than silently collapsed into "paid" (D52 §6/§7).
export type PaymentState = "unpaid" | "partial" | "paid" | "overpaid";

export function paymentState(totalPrice: number, paidAmount: number): PaymentState {
  if (paidAmount <= 0) return "unpaid";
  if (paidAmount < totalPrice) return "partial";
  if (paidAmount > totalPrice) return "overpaid";
  return "paid";
}

// THE canonical balance (D52 §6). total − paid, NOT floored: a positive balance
// is due, a negative balance is a customer credit (overpayment). ONE definition
// shared by every surface (calendar tooltip, reservation panel, payment section)
// so a credit is never mis-displayed as a zero balance (§7). Rounded to agorot.
export function balanceOf(totalPrice: number, paidAmount: number): number {
  return Math.round((totalPrice - paidAmount) * 100) / 100;
}

export type BalanceView = { kind: "due" | "settled" | "credit"; amount: number; label: string };

// Display view for a balance: sign-classified kind, ABSOLUTE amount and Hebrew
// label. The UI formats money from this; it never recomputes the commercial
// balance itself (§9 — "the UI may format money but must not calculate totals").
export function formatBalance(totalPrice: number, paidAmount: number): BalanceView {
  const b = balanceOf(totalPrice, paidAmount);
  if (b > 0) return { kind: "due", amount: b, label: "יתרה לתשלום" };
  if (b < 0) return { kind: "credit", amount: -b, label: "זיכוי ללקוח" };
  return { kind: "settled", amount: 0, label: "שולם במלואו" };
}

// Calendar empty-cell price/min-nights strip display shape. Since Phase 4A the
// commercial source is guesthub.pricing_plan_rates (SU/plan-keyed) — these rows
// are derived from it per member room (room_id set, room_type_id null) so the
// grid's O(1) room-priority lookup is unchanged. The canonical pricing +
// restriction logic lives in src/lib/rates/rules.ts (the single validator);
// this type is display-only. min_nights carries min_stay_arrival for the strip.
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
