import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { publicWebsiteRooms, type PublicRoom, type PublicRoomLang } from "@/lib/public-booking/rooms";

// ============================================================
// guesthub.get_room / room catalog for BIOS Bot (Phase 5).
//
// Pure reuse of publicWebsiteRooms (src/lib/public-booking/rooms.ts) — the
// SAME content-only, customer-safe model the public website already uses.
// No new query, no new capacity/admin fields: room content and pricing/
// availability are deliberately separate concerns (see that file's header).
// ============================================================

export type BiosBotRoom = PublicRoom;

export async function listBiosBotRooms(
  db: Sql | TransactionSql,
  tenantId: string,
  lang: PublicRoomLang = "he",
): Promise<BiosBotRoom[]> {
  return publicWebsiteRooms(db, lang, { tenantId });
}

export async function getBiosBotRoom(
  db: Sql | TransactionSql,
  tenantId: string,
  roomId: string,
  lang: PublicRoomLang = "he",
): Promise<BiosBotRoom | null> {
  const [room] = await publicWebsiteRooms(db, lang, { tenantId, roomId });
  return room ?? null;
}
