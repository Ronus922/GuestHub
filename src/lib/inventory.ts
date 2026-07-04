import "server-only";
import type { Sql, TransactionSql } from "postgres";
import type { DateOnly } from "@/lib/dates";
import type { RoomCapacity } from "@/lib/inventory-rules";

// ============================================================
// Inventory integrity — server/DB half (Phase 3, DECISIONS D32/D34).
// Pure business rules live in src/lib/inventory-rules.ts; this module is the
// only TS entry point to guesthub.check_room_availability (migration 004).
// ============================================================

export {
  INVENTORY_BLOCKING_STATUSES,
  CALENDAR_VISIBLE_STATUSES,
  capacityViolation,
  paymentState,
} from "@/lib/inventory-rules";

export type Conflict = {
  room_id: string;
  conflict_kind: "room_missing" | "room_status" | "reservation" | "closure";
  conflict_id: string;
  conflict_from: string | null;
  conflict_to: string | null;
};

export const CONFLICT_LABEL: Record<Conflict["conflict_kind"], string> = {
  room_missing: "חדר לא נמצא",
  room_status: "החדר אינו זמין למכירה (לא פעיל / מושבת)",
  reservation: "קיימת הזמנה חופפת בחדר בטווח המבוקש",
  closure: "החדר סגור זמנית בטווח המבוקש",
};

// Serializes concurrent writers per room: every availability-checked write
// locks its room rows first, in the same transaction, so two operations can
// never both pass the same check (D34). Throws if a room is missing or
// belongs to another tenant — tenant isolation enforced server-side.
export async function lockRooms(
  tx: TransactionSql,
  tenantId: string,
  roomIds: string[],
): Promise<void> {
  if (roomIds.length === 0) return;
  const unique = [...new Set(roomIds)];
  const rows = await tx<{ id: string }[]>`
    SELECT id FROM guesthub.rooms
    WHERE tenant_id = ${tenantId} AND id = ANY(${unique}::uuid[])
    FOR UPDATE`;
  if (rows.length !== unique.length) {
    throw new Error("חדר לא נמצא");
  }
}

// The single server-side availability check. Zero conflicts ⇔ all rooms are
// sellable and free for [checkIn, checkOut). excludeReservationRoomIds lets an
// edit ignore only the rows it rewrites — sibling rooms still conflict.
export async function checkRoomAvailability(
  db: Sql | TransactionSql,
  args: {
    tenantId: string;
    roomIds: string[];
    checkIn: DateOnly;
    checkOut: DateOnly;
    excludeReservationRoomIds?: string[];
  },
): Promise<Conflict[]> {
  const exclude = args.excludeReservationRoomIds ?? [];
  return db<Conflict[]>`
    SELECT room_id, conflict_kind, conflict_id,
           conflict_from::text AS conflict_from, conflict_to::text AS conflict_to
    FROM guesthub.check_room_availability(
      ${args.tenantId}, ${args.roomIds}::uuid[],
      ${args.checkIn}, ${args.checkOut}, ${exclude}::uuid[])`;
}

// Resolved capacity of a physical room: COALESCE(room override, room-type
// default) per column (§L). Both layers are NOT NULL today, so the room row
// wins; COALESCE keeps the documented rule if overrides become nullable.
export async function getRoomCapacities(
  db: Sql | TransactionSql,
  tenantId: string,
  roomIds: string[],
): Promise<Map<string, RoomCapacity>> {
  const rows = await db<(RoomCapacity & { id: string })[]>`
    SELECT r.id,
           COALESCE(r.max_occupancy, rt.max_occupancy, 2)::int AS max_occupancy,
           COALESCE(r.max_adults,    rt.max_adults,    2)::int AS max_adults,
           COALESCE(r.max_children,  rt.max_children,  0)::int AS max_children,
           COALESCE(r.max_infants,   rt.max_infants,   0)::int AS max_infants
    FROM guesthub.rooms r
    LEFT JOIN guesthub.room_types rt ON rt.id = r.room_type_id
    WHERE r.tenant_id = ${tenantId} AND r.id = ANY(${roomIds}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r]));
}

// Rate reads moved to the canonical commercial model (§0.4): see
// getRoomPlanRates / getRoomStayRates in src/lib/rates/effective-state.ts,
// which resolve a physical room → its Sellable Unit → base pricing plan →
// guesthub.pricing_plan_rates. Legacy guesthub.rates is retired.
