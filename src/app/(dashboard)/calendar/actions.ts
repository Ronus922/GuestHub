"use server";

import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { writeAudit } from "@/lib/audit";
import { checkRoomAvailability, lockRooms, CONFLICT_LABEL } from "@/lib/inventory";
import { markAriDirty } from "@/lib/channel/outbox";
import { unionRange } from "@/lib/channel/ranges";
import { sortRoomsByNumber } from "@/lib/rooms/sort";
import { publishDomainEvent } from "@/lib/realtime/publish";
import { closureSchema, closureUpdateSchema } from "@/lib/validation/reservation";
import type { ClosureCategory } from "@/lib/closures/categories";
import type { ActionResult } from "./types";

const fail = (error: string): ActionResult<never> => ({ success: false, error });

class DomainError extends Error {}

function errorMessage(e: unknown): string {
  if (e instanceof AuthorizationError || e instanceof DomainError) return e.message;
  console.error("[calendar]", e);
  return "אירעה שגיאה בלתי צפויה";
}

// "סגור חדר" — a temporary date-range closure (guesthub.room_closures, D31).
// Start-inclusive / end-exclusive like every stay. Participates in the same
// availability function, so nothing can be booked/moved/resized over it.
export async function createClosureAction(raw: {
  roomId: string;
  startDate: string;
  endDate: string;
  reason?: string;
  kind?: "ooo" | "oos";
  /** 084 closed taxonomy — closureSchema rejects anything outside it */
  category?: ClosureCategory;
}): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rooms.edit");
    const parsed = closureSchema.safeParse(raw);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "קלט לא תקין");
    const input = parsed.data;
    const isOoo = input.kind === "ooo";

    await sql.begin(async (tx) => {
      await lockRooms(tx, actor.tenantId, [input.roomId]);
      // §8: only an OOO closure removes inventory, so only OOO must be conflict-
      // free. An OOS note (dirty-but-sellable) never reduces availability, so it
      // may overlap a stay or another closure harmlessly.
      if (isOoo) {
        const conflicts = await checkRoomAvailability(tx, {
          tenantId: actor.tenantId,
          roomIds: [input.roomId],
          checkIn: input.startDate,
          checkOut: input.endDate,
        });
        if (conflicts.length > 0) throw new DomainError(CONFLICT_LABEL[conflicts[0].conflict_kind]);
      }

      const [closure] = await tx<{ id: string }[]>`
        INSERT INTO guesthub.room_closures
          (tenant_id, room_id, start_date, end_date, reason, kind, category, created_by)
        VALUES (${actor.tenantId}, ${input.roomId}, ${input.startDate}, ${input.endDate},
                ${input.reason || null}, ${input.kind}, ${input.category || null}, ${actor.userId})
        RETURNING id`;

      await writeAudit(actor, {
        entityType: "room_closure",
        entityId: closure.id,
        action: "create",
        after: { room_id: input.roomId, start: input.startDate, end: input.endDate, kind: input.kind, category: input.category ?? null },
      }, tx);

      // Only an OOO closure changes availability → mark the ARI outbox + publish.
      // An OOS note leaves availability untouched, so nothing is synced.
      if (isOoo) {
        await markAriDirty(tx, {
          tenantId: actor.tenantId,
          roomIds: [input.roomId],
          dateFrom: input.startDate,
          dateTo: input.endDate,
        });
        await publishDomainEvent(tx, actor.tenantId, {
          type: "inventory.changed",
          roomIds: [input.roomId],
          dateFrom: input.startDate,
          dateTo: input.endDate,
        });
      }
    });

    revalidatePath("/calendar");
    return { success: true };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

export async function deleteClosureAction(id: string): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rooms.edit");
    await sql.begin(async (tx) => {
      const [closure] = await tx<
        { id: string; room_id: string; start_date: string; end_date: string; kind: string }[]
      >`
        SELECT c.id, c.room_id, c.start_date::text, c.end_date::text, c.kind
        FROM guesthub.room_closures c
        WHERE c.id = ${id} AND c.tenant_id = ${actor.tenantId}
        FOR UPDATE OF c`;
      if (!closure) throw new DomainError("חסימה לא נמצאה");

      await tx`
        DELETE FROM guesthub.room_closures
        WHERE id = ${id} AND tenant_id = ${actor.tenantId}`;
      await writeAudit(actor, {
        entityType: "room_closure",
        entityId: id,
        action: "delete",
        before: { room_id: closure.room_id, start: closure.start_date, end: closure.end_date, kind: closure.kind },
      }, tx);
      // Lifting an OOO closure returns those nights to sale → availability dirty.
      // An OOS note never affected availability, so removing it syncs nothing.
      if (closure.kind === "ooo") {
        await markAriDirty(tx, {
          tenantId: actor.tenantId,
          roomIds: [closure.room_id],
          dateFrom: closure.start_date,
          dateTo: closure.end_date,
        });
        await publishDomainEvent(tx, actor.tenantId, {
          type: "inventory.changed",
          roomIds: [closure.room_id],
          dateFrom: closure.start_date,
          dateTo: closure.end_date,
        });
      }
    });

    revalidatePath("/calendar");
    return { success: true };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// Editing an existing closure. Extending a lease used to mean deleting the
// closure and filing a new one — two writes, two audit rows, and a window in
// between where the room is on sale. This is one write.
//
// THE ARI MARK IS THE UNION OF THE OLD AND THE NEW RANGE, and that is the whole
// point of the function. Shortening a closure RELEASES nights that the channels
// still publish as unavailable; extending it BLOCKS nights they still publish as
// free. Marking only the new range leaves the released tail stale, marking only
// the old one leaves the new head stale. The union covers both, and a superset
// is always safe: re-publishing a night whose value did not change is a no-op
// upstream, while missing one is an overbooking or a lost sale.
export async function updateClosureAction(raw: {
  id: string;
  startDate: string;
  endDate: string;
  reason?: string;
  category?: ClosureCategory;
}): Promise<ActionResult> {
  try {
    const actor = await getActor();
    // the same permission the create and the delete demand — an edit is not a
    // lesser act than filing the closure it rewrites
    requirePermission(actor, "rooms.edit");
    const parsed = closureUpdateSchema.safeParse(raw);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "קלט לא תקין");
    const input = parsed.data;

    await sql.begin(async (tx) => {
      const [before] = await tx<
        { id: string; room_id: string; start_date: string; end_date: string; kind: string; category: string | null; reason: string | null }[]
      >`
        SELECT c.id, c.room_id, c.start_date::text, c.end_date::text, c.kind,
               c.category, c.reason
        FROM guesthub.room_closures c
        WHERE c.id = ${input.id} AND c.tenant_id = ${actor.tenantId}
        FOR UPDATE OF c`;
      if (!before) throw new DomainError("חסימה לא נמצאה");
      const isOoo = before.kind === "ooo";

      await lockRooms(tx, actor.tenantId, [before.room_id]);
      // Same gate as the create — an OOO closure may not overlap a stay or
      // another closure. The closure being edited is its OWN overlap, so it is
      // filtered out by id; without that, every edit would collide with itself.
      if (isOoo) {
        const conflicts = (
          await checkRoomAvailability(tx, {
            tenantId: actor.tenantId,
            roomIds: [before.room_id],
            checkIn: input.startDate,
            checkOut: input.endDate,
          })
        ).filter((c) => c.conflict_id !== before.id);
        if (conflicts.length > 0) throw new DomainError(CONFLICT_LABEL[conflicts[0].conflict_kind]);
      }

      await tx`
        UPDATE guesthub.room_closures
        SET start_date = ${input.startDate},
            end_date   = ${input.endDate},
            reason     = ${input.reason || null},
            category   = ${input.category || null}
        WHERE id = ${input.id} AND tenant_id = ${actor.tenantId}`;

      await writeAudit(actor, {
        entityType: "room_closure",
        entityId: input.id,
        action: "update",
        before: { start: before.start_date, end: before.end_date, category: before.category, reason: before.reason },
        after: { start: input.startDate, end: input.endDate, category: input.category ?? null, reason: input.reason || null },
      }, tx);

      // the union — see the note above, and unionRange's own. An OOS note never
      // moved availability in either range, so editing one syncs nothing,
      // exactly like filing it.
      if (isOoo) {
        const { date_from: dateFrom, date_to: dateTo } = unionRange(
          { date_from: before.start_date, date_to: before.end_date },
          { date_from: input.startDate, date_to: input.endDate },
        );
        await markAriDirty(tx, {
          tenantId: actor.tenantId,
          roomIds: [before.room_id],
          dateFrom,
          dateTo,
        });
        await publishDomainEvent(tx, actor.tenantId, {
          type: "inventory.changed",
          roomIds: [before.room_id],
          dateFrom,
          dateTo,
        });
      }
    });

    revalidatePath("/calendar");
    return { success: true };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// The rooms a closure may be filed against. The filter (physically healthy and
// active) used to live in the panel's JSX, which meant the panel could only
// open where a full calendar room list already sat in memory. It is a QUERY,
// so it belongs in a query — and now the panel opens anywhere.
export async function listClosableRoomsAction(): Promise<
  ActionResult<{ id: string; room_number: string; name: string | null }[]>
> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rooms.edit");
    const rooms = await sql<{ id: string; room_number: string; name: string | null }[]>`
      SELECT id, room_number, name
      FROM guesthub.rooms
      WHERE tenant_id = ${actor.tenantId}
        AND status = 'available' AND is_active`;
    // D86 — the ONE room comparator, so the picker reads 100 · 926 · 1006 like
    // every other room list instead of the lexicographic order SQL would give
    return { success: true, data: sortRoomsByNumber(rooms) };
  } catch (e) {
    return fail(errorMessage(e));
  }
}
