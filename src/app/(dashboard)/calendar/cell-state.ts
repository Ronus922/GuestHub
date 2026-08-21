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

import { cellMark, type CellMarkRow } from "@/lib/rates/cell-mark";
import { STOP_SELL_TEXT } from "@/lib/rates/rules";
import { closureCategoryLabel } from "@/lib/closures/categories";
import type { CalendarRoom } from "./types";

export { cellMark, cellMinNights, cellMaxNights, stayRangeLabel } from "@/lib/rates/cell-mark";
export type { CellMark, CellMarkRow, CellMarkResult } from "@/lib/rates/cell-mark";

/** AXIS A. Row-level and rate-independent: reads nothing but the room row. */
export function sellable(room: CalendarRoom): boolean {
  return room.status === "available" && room.is_active;
}

/**
 * One date of a room's VISIBLE window, as the ROW LABEL needs to read it —
 * both axes for that one date:
 *   rate    — AXIS B. The row the cell draws from, or absent when the date has
 *             no rate row at all. Absent is UNKNOWN, never "closed" (see below).
 *   closure — AXIS A, dated. A room_closures row covers this date.
 */
export type RoomWindowCell = {
  rate: CellMarkRow | null | undefined;
  closure: boolean;
  /** The covering closure's 084/085 category, READ ONLY WHEN `closure` is true.
   *  A separate optional field rather than a richer `closure` value on purpose:
   *  `closure` is the axis-A boolean it has always been, every existing caller
   *  and fixture keeps compiling, and a date with no closure has nothing to say
   *  here. NULL/absent = a closure filed before the taxonomy existed. */
  closureCategory?: string | null;
};

/** The §1 status token the label wears; the dot and the word share it. */
export type RoomLabelTone = "free" | "busy" | "off" | "nosale";

/**
 * THE room row's status label, for both boards.
 *
 * WHY IT EXISTS. The label used to be computed from AXIS A alone — status and
 * is_active — so it could not know a room was unsellable for any other reason.
 * Room 1006 in production is a year-let: all 21 visible nights carry stop_sell,
 * every cell is tagged "סגור", and the label next to them read a green "פנוי".
 * A board that contradicts itself in two adjacent columns is worse than a board
 * that says nothing, so the label now answers BOTH axes.
 *
 * FOUR STATES, IN PRECEDENCE ORDER (the owner's ruling):
 *
 *  1. PHYSICALLY DISABLED — out_of_order or is_active=false. Unchanged from
 *     before, and it wins outright: a broken or withdrawn room is not "closed
 *     for sale".
 *  1b. FULLY CLOSED BY A DATED CLOSURE — every visible date is covered by a
 *     room_closures row. The label is the closure's CATEGORY ("שכירות ארוכה"),
 *     falling back to the generic "סגירת חדר", in the disabled tone. It sits
 *     after the room-level physical reading and before the commercial one: a
 *     closure IS the physical axis, so stop_sell may never outrank it. A
 *     PARTIAL closure is untouched — it stays state 3, exactly as before.
 *  2. PHYSICALLY FINE, COMMERCIALLY SHUT — every visible date is stop-sold.
 *     "סגור למכירה", in the board's amber. Never green.
 *  3. OTHERWISE — at least one night is sellable, so the room IS on the market
 *     and the label says so exactly as it always did. A PARTIAL closure stays
 *     "פנוי" on purpose: those nights already carry their own "סגור" tag, and
 *     downgrading the whole room for them would misreport a sellable room.
 *
 * A date with NO rate row is UNKNOWN, not closed (§2.2): nothing was ever said
 * about it commercially. So state 2 needs a row on EVERY visible date, and a
 * window with no rows at all is state 3.
 *
 * occupiedNow is the DESKTOP's extra reading ("תפוס") and defaults to false:
 * .cb-m-rlabel is a 50px two-line box with no room for a word, so mobile takes
 * the tone only and never asks the question.
 *
 * Pure — the same inputs give the same answer on the server and in both boards.
 */
export function roomLabel(
  room: CalendarRoom,
  cells: RoomWindowCell[],
  occupiedNow = false,
): { label: string; tone: RoomLabelTone } {
  // STATE 1. rooms.status is a CLOSED set of three since migration 009 —
  // available | inactive | out_of_order. 'maintenance' was folded into
  // out_of_order there and is rejected by rooms_status_check, so a "תחזוקה"
  // branch here would be unreachable: maintenance is a DATED closure
  // (room_closures.category = 'maintenance', 084), never a room status.
  if (!sellable(room))
    return room.status === "out_of_order"
      ? { label: "מושבת", tone: "off" }
      : { label: "לא פעיל", tone: "off" };

  const onTheMarket: { label: string; tone: RoomLabelTone } = occupiedNow
    ? { label: "תפוס", tone: "busy" }
    : { label: "פנוי", tone: "free" };

  // STATE 1b. A dated closure is AXIS A too, so it keeps state 1's precedence
  // over the commercial reading below — but only when it covers the WHOLE
  // window does it describe the ROOM. Rooms 1006/1042 are year-lets: somebody
  // lives there, every night is closed, and a green "פנוי" beside a bar that
  // runs off both edges of the screen is the same self-contradiction this
  // function exists to end, one axis over.
  //
  // The word is the CATEGORY's, read from the one taxonomy module — never the
  // operator's free text, which is a complement ("צביעה בחדר האמבטיה")
  // and says nothing about a room's state. Categories that DISAGREE across the
  // window fall back to the generic noun: two different closures butted
  // together are not "שכירות ארוכה", and picking the first would be a
  // coin toss rendered as fact.
  if (cells.length > 0 && cells.every((c) => c.closure)) {
    const labels = new Set(cells.map((c) => closureCategoryLabel(c.closureCategory)));
    const only = labels.size === 1 ? [...labels][0] : null;
    return { label: only ?? "סגירת חדר", tone: "off" };
  }

  // …while a PARTIAL closure keeps the label it has always had: the bar it
  // draws speaks for the nights it covers, and the room is still on the market.
  if (cells.some((c) => c.closure)) return onTheMarket;

  // STATE 2. Asked through cellMark() rather than rate.closed, so the label can
  // only say "סגור למכירה" when every cell actually DREW the stop-sell tag —
  // the contradiction this function exists to prevent cannot come back through
  // the ladder and the label reading the same field two different ways.
  if (cells.length > 0 && cells.every((c) => cellMark(c.rate)?.mark === "stop_sell"))
    return { label: STOP_SELL_TEXT, tone: "nosale" };

  // STATE 3.
  return onTheMarket;
}
