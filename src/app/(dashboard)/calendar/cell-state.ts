// The two INDEPENDENT axes a calendar day cell answers, in one place so the
// desktop board and the mobile board cannot drift apart on either of them.
//
// AXIS A — PHYSICAL (row-level): may this room be sold AT ALL, on any date?
// sellable() below. A pure function of two fields on the room row, so it is the
// same answer for every date in the row and no rate can change it.
//
// AXIS B — COMMERCIAL (per-cell): is this room-night closed for sale, or
// restricted in length? cellMark() decides that, and it lives in
// src/lib/rates/cell-mark.ts — a shared pure module with its own guard
// (check:cell-mark-ladder), which is why it is re-exported from here rather
// than moved: one import surface for a cell renderer, one home for the ladder.
//
// Conflating the two is the bug this module exists to prevent: a room that is
// physically unsellable is not "closed for sale today", and a commercially
// closed night is not a broken room.

import type { CalendarRoom } from "./types";

export { cellMark, cellMinNights, cellMaxNights, stayRangeLabel } from "@/lib/rates/cell-mark";
export type { CellMark, CellMarkRow, CellMarkResult } from "@/lib/rates/cell-mark";

/** AXIS A. Row-level and rate-independent: reads nothing but the room row. */
export function sellable(room: CalendarRoom): boolean {
  return room.status === "available" && room.is_active;
}
