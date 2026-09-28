import type { Sql, TransactionSql } from "postgres";

// ============================================================
// Website visibility — THE rule (owner decision D197, 2026-09-28).
//
// A room appears on the public website iff
//   show_on_website = true  AND  the room is ACTIVE,
// where ACTIVE means is_active = true AND status <> 'inactive'.
//
//   • Photos are NOT required: a room without an image is still listed (the
//     site renders its own neutral placeholder).
//   • out_of_order rooms ARE listed (e.g. 926) — bookability is decided
//     per date by the engine (sellable_unit_inventory / effective_sell_state),
//     never by this catalog predicate.
//   • An inactive room is ALWAYS hidden, whatever show_on_website says.
//
// Two spellings, one rule: the SQL fragment feeds publicWebsiteRooms (the
// only catalog query, which the website, the public API and the BIOS Bot
// read), and the pure predicate is the same test for rows already in memory.
// check:website-visibility proves the two agree on every case above.
// ============================================================

export type RoomActivityInput = { is_active: boolean; status: string };
export type WebsiteVisibilityInput = RoomActivityInput & { show_on_website: boolean };

export function isRoomActive(r: RoomActivityInput): boolean {
  return r.is_active && r.status !== "inactive";
}

export function isWebsiteVisibleRoom(r: WebsiteVisibilityInput): boolean {
  return r.show_on_website && isRoomActive(r);
}

// SQL fragment over the rooms table aliased `r` — embed as
// `WHERE ... AND ${websiteVisibleRoomSql(db)}`.
export function websiteVisibleRoomSql(db: Sql | TransactionSql) {
  return db`r.show_on_website AND r.is_active AND r.status <> 'inactive'`;
}
