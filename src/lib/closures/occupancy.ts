// ============================================================
// WHICH NIGHTS A ROOM ALREADY OWES — the model behind the closure calendar.
//
// The closure form used to ask for two dates and find out from a red toast that
// one of them was already sold. The calendar in the panel answers BEFORE the
// click: a night a blocking reservation or another closure holds is painted and
// is not a target. This module is that answer, kept pure (no React, no DB, no
// imports beyond the two rule modules) so scripts/check-closure-redesign.mjs
// can COMPILE and RUN it rather than describe it.
//
// THREE STATES, NOT TWO. The panel is fed from the calendar's own props — the
// board's loaded window and nothing else (owner ruling: no new endpoint, no new
// fetch). That window is 21 days wide; the calendar draws two months. So a
// night is "blocked", "free", or — outside the loaded window — "unknown", and
// the panel says so instead of painting an empty grid and calling it vacant.
// The server's overlap check stays the gate; this is the courtesy.
//
// Half-open ranges throughout, exactly like the rest of the app (D32): a stay
// [check_in, check_out) leaves the departure day free, and a closure
// [start_date, end_date) leaves its end boundary free.
// ============================================================
import { addDays, eachDay, type DateOnly } from "@/lib/dates";
import { INVENTORY_BLOCKING_STATUSES } from "@/lib/inventory-rules";

/** A calendar stay, narrowed to the fields occupancy actually reads. */
export type OccupancyStay = {
  room_id: string;
  check_in: DateOnly;
  /** EXCLUSIVE — the departure day is a night this stay does not hold */
  check_out: DateOnly;
  status: string;
  guest_name: string;
};

/** A calendar closure, narrowed the same way. */
export type OccupancyClosure = {
  id: string;
  room_id: string;
  start_date: DateOnly;
  /** EXCLUSIVE — same boundary rule as a stay */
  end_date: DateOnly;
};

/** The stretch of dates the panel has real data for: [from, to). */
export type OccupancyWindow = { from: DateOnly; to: DateOnly };

export type NightOwner = { kind: "stay" | "closure"; label: string };

export type NightState = "free" | "blocked" | "unknown";

/** D126 — every status but 'cancelled' consumes inventory. Read from the ONE
 *  declaration so the panel can never disagree with the exclusion constraint. */
export function blocksInventory(status: string): boolean {
  return (INVENTORY_BLOCKING_STATUSES as readonly string[]).includes(status);
}

// ============================================================
// Every night ONE room already owes, as date → who owes it.
//
// `ignoreClosureId` is the edit case and it is not a nicety: a closure being
// re-dated must not read its OWN nights as taken, or the panel would refuse to
// let an operator shorten the very closure they opened.
// ============================================================
export function occupiedNights({
  roomId,
  stays,
  closures,
  ignoreClosureId,
}: {
  roomId: string;
  stays: readonly OccupancyStay[];
  closures: readonly OccupancyClosure[];
  ignoreClosureId?: string;
}): Map<DateOnly, NightOwner> {
  const out = new Map<DateOnly, NightOwner>();
  if (!roomId) return out;
  // stays first: when a night is held by both, the guest's name is the more
  // useful thing to put in the cell's tooltip than the generic closure noun
  for (const s of stays) {
    if (s.room_id !== roomId || !blocksInventory(s.status)) continue;
    for (const d of eachDay(s.check_in, s.check_out)) {
      out.set(d, { kind: "stay", label: s.guest_name });
    }
  }
  for (const c of closures) {
    if (c.room_id !== roomId || c.id === ignoreClosureId) continue;
    for (const d of eachDay(c.start_date, c.end_date)) {
      if (!out.has(d)) out.set(d, { kind: "closure", label: "סגירה קיימת" });
    }
  }
  return out;
}

/** How one cell reads. A blocked night is blocked whether or not it is inside
 *  the loaded window — knowing it is taken is never uncertain. */
export function nightState(
  date: DateOnly,
  occupied: ReadonlyMap<DateOnly, NightOwner>,
  window: OccupancyWindow,
): NightState {
  if (occupied.has(date)) return "blocked";
  return date >= window.from && date < window.to ? "free" : "unknown";
}

/** The nights of a selection, INCLUSIVE of its last night. */
export function selectedNights(start: DateOnly, lastNight: DateOnly): DateOnly[] {
  return lastNight < start ? [] : eachDay(start, addDays(lastNight, 1));
}

// ============================================================
// The nights a selection would trample. Occupied days are not clickable, so
// this is about the range DRAWN OVER one: click before, click after, and the
// span in between crosses a booking nobody looked at.
// ============================================================
export function rangeBlocks(
  start: DateOnly,
  lastNight: DateOnly,
  occupied: ReadonlyMap<DateOnly, NightOwner>,
): { date: DateOnly; kind: NightOwner["kind"]; label: string }[] {
  const out: { date: DateOnly; kind: NightOwner["kind"]; label: string }[] = [];
  for (const d of selectedNights(start, lastNight)) {
    const owner = occupied.get(d);
    if (owner) out.push({ date: d, kind: owner.kind, label: owner.label });
  }
  return out;
}

/** How many nights of a selection fall outside the loaded window — the count
 *  the panel needs to say "the rest is checked on save" honestly. */
export function rangeUnknownNights(
  start: DateOnly,
  lastNight: DateOnly,
  window: OccupancyWindow,
): number {
  return selectedNights(start, lastNight).filter(
    (d) => d < window.from || d >= window.to,
  ).length;
}

// ============================================================
// ONE click on a day cell (the owner's reference, §3): the first click opens a
// ONE-NIGHT range, the second sets the LAST NIGHT. The operator picks nights,
// never a checkout date — "עד תאריך (לא כולל)" is the phrase the redesign
// exists to delete.
// ============================================================
export type NightPick = { start: DateOnly; lastNight: DateOnly; pending: boolean };

export function pickNight(current: NightPick | null, clicked: DateOnly): NightPick {
  if (current && current.pending && clicked >= current.start) {
    return { start: current.start, lastNight: clicked, pending: false };
  }
  return { start: clicked, lastNight: clicked, pending: true };
}

/** The shortcut chips — all of them start today. */
export function presetRange(
  today: DateOnly,
  span: number | "month",
): { start: DateOnly; lastNight: DateOnly } {
  if (span !== "month") return { start: today, lastNight: addDays(today, span - 1) };
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  // day 0 of the NEXT month is the last day of this one — leap years included
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: today, lastNight: `${today.slice(0, 7)}-${String(last).padStart(2, "0")}` };
}
