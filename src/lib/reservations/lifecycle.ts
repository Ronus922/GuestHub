import "server-only";
import type { TransactionSql } from "postgres";
import type { DateOnly } from "@/lib/dates";
import { INVENTORY_BLOCKING_STATUSES } from "@/lib/inventory-rules";
import { markAriDirty } from "@/lib/channel/outbox";
import { publishDomainEvent } from "@/lib/realtime/publish";

// ============================================================
// THE side effects of a reservation LIFECYCLE status change, in one place.
//
// Extracted from updateReservationAction, which was their only home. The
// dashboard's row-level check-in/out button cannot call that action (its schema
// demands the full guest object and the full rooms array — audit §3.3), so it
// needs its own status-only action. Two actions writing the same transition is
// exactly how a dashboard check-out and a panel check-out drift apart: one
// creates the housekeeping task, the other forgets; one marks ARI dirty, the
// other leaves the room selling. So the transition's consequences live HERE and
// both callers run the same body.
//
// Everything is expressed in terms of (fromStatus → toStatus) only. The update
// path previously wrote `input.status !== existing.status && input.status ===
// 'checked_out'`; since `nextStatus = input.status ?? existing.status`, an
// absent input.status makes from === to and every guard below is false — the
// same behaviour, without the undefined.
//
// NOT here, deliberately: pricing, payments, the confirmation enqueue and the
// audit row. Those belong to the caller that actually changed them; a
// status-only write must not re-price a stay.
// ============================================================

const isBlocking = (s: string) => (INVENTORY_BLOCKING_STATUSES as readonly string[]).includes(s);

export type LifecycleSideEffects = {
  tenantId: string;
  reservationId: string;
  fromStatus: string;
  toStatus: string;
  /** every room the change touches — OLD and NEW; nulls are ignored */
  roomIds: (string | null)[];
  /** the span covering both sides of the change (a superset is always safe) */
  dateFrom: DateOnly;
  dateTo: DateOnly;
};

/** The domain event a transition deserves — its own signal, not a generic save. */
export type LifecycleEventType =
  | "reservation.modified"
  | "reservation.checked_in"
  | "reservation.checked_out"
  | "reservation.no_show";

export function lifecycleEventType(fromStatus: string, toStatus: string): LifecycleEventType {
  if (toStatus === fromStatus) return "reservation.modified";
  if (toStatus === "checked_in") return "reservation.checked_in";
  if (toStatus === "checked_out") return "reservation.checked_out";
  if (toStatus === "no_show") return "reservation.no_show";
  return "reservation.modified";
}

/**
 * Run every consequence of a lifecycle status change, inside the caller's
 * transaction. Order matches the original block: ARI first, then the lifecycle
 * event, then housekeeping, then inventory.changed.
 */
export async function applyLifecycleSideEffects(
  tx: TransactionSql,
  args: LifecycleSideEffects,
): Promise<void> {
  const wasBlocking = isBlocking(args.fromStatus);
  const nowBlocking = isBlocking(args.toStatus);
  const changed = args.fromStatus !== args.toStatus;

  // Dirty when inventory consumption changed on either side — including a
  // status flip into or out of a blocking status (a cancel/restore). Both the
  // OLD and the NEW room/date ranges are marked: the released nights must be
  // re-published as available, not just the newly-taken ones.
  if (wasBlocking || nowBlocking) {
    await markAriDirty(tx, {
      tenantId: args.tenantId,
      roomIds: args.roomIds,
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
    });
  }

  await publishDomainEvent(tx, args.tenantId, {
    type: lifecycleEventType(args.fromStatus, args.toStatus),
    reservationId: args.reservationId,
    roomIds: args.roomIds,
    dateFrom: args.dateFrom,
    dateTo: args.dateTo,
    lifecycle: args.toStatus,
  });

  // §7 Housekeeping — a checkout makes the room(s) dirty and generates a
  // cleaning task, connecting housekeeping to the real reservation lifecycle.
  // Fires ONLY on the transition into checked_out; idempotent per room (skips a
  // room that already has an open task for this reservation). Cleanliness does
  // not reduce availability (a dirty room is still sellable before the next
  // arrival — the D64 0/1 model), so no outbox marking here.
  if (changed && args.toStatus === "checked_out") {
    const cleanRoomIds = [...new Set(args.roomIds.filter((r): r is string => !!r))];
    if (cleanRoomIds.length > 0) {
      await tx`
        INSERT INTO guesthub.housekeeping_tasks
          (tenant_id, room_id, reservation_id, checkout_time, status, priority, notes)
        SELECT ${args.tenantId}, rid, ${args.reservationId}, now(), 'pending', 'normal', 'נוצר אוטומטית ביציאת אורח'
        FROM unnest(${cleanRoomIds}::uuid[]) AS rid
        WHERE NOT EXISTS (
          SELECT 1 FROM guesthub.housekeeping_tasks h
          WHERE h.tenant_id = ${args.tenantId} AND h.room_id = rid
            AND h.reservation_id = ${args.reservationId} AND h.status IN ('pending','in_progress'))`;
    }
  }

  if (wasBlocking || nowBlocking) {
    await publishDomainEvent(tx, args.tenantId, {
      type: "inventory.changed",
      roomIds: args.roomIds,
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
    });
  }
}
