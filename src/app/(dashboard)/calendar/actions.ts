"use server";

import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { writeAudit } from "@/lib/audit";
import { checkRoomAvailability, lockRooms, CONFLICT_LABEL } from "@/lib/inventory";
import { markAriDirty } from "@/lib/channel/outbox";
import { closureSchema } from "@/lib/validation/reservation";
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
}): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rooms.edit");
    const parsed = closureSchema.safeParse(raw);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "קלט לא תקין");
    const input = parsed.data;

    await sql.begin(async (tx) => {
      await lockRooms(tx, actor.tenantId, [input.roomId]);
      const conflicts = await checkRoomAvailability(tx, {
        tenantId: actor.tenantId,
        roomIds: [input.roomId],
        checkIn: input.startDate,
        checkOut: input.endDate,
      });
      if (conflicts.length > 0) throw new DomainError(CONFLICT_LABEL[conflicts[0].conflict_kind]);

      const [closure] = await tx<{ id: string }[]>`
        INSERT INTO guesthub.room_closures
          (tenant_id, room_id, start_date, end_date, reason, created_by)
        VALUES (${actor.tenantId}, ${input.roomId}, ${input.startDate}, ${input.endDate},
                ${input.reason || null}, ${actor.userId})
        RETURNING id`;

      await writeAudit(actor, {
        entityType: "room_closure",
        entityId: closure.id,
        action: "create",
        after: { room_id: input.roomId, start: input.startDate, end: input.endDate, reason: input.reason },
      }, tx);

      const [room] = await tx<{ room_type_id: string | null }[]>`
        SELECT room_type_id FROM guesthub.rooms
        WHERE id = ${input.roomId} AND tenant_id = ${actor.tenantId}`;
      await markAriDirty(tx, {
        tenantId: actor.tenantId,
        roomTypeIds: [room?.room_type_id ?? null],
        dateFrom: input.startDate,
        dateTo: input.endDate,
      });
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
        { id: string; room_id: string; start_date: string; end_date: string; room_type_id: string | null }[]
      >`
        SELECT c.id, c.room_id, c.start_date::text, c.end_date::text, r.room_type_id
        FROM guesthub.room_closures c
        JOIN guesthub.rooms r ON r.id = c.room_id
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
        before: { room_id: closure.room_id, start: closure.start_date, end: closure.end_date },
      }, tx);
      await markAriDirty(tx, {
        tenantId: actor.tenantId,
        roomTypeIds: [closure.room_type_id],
        dateFrom: closure.start_date,
        dateTo: closure.end_date,
      });
    });

    revalidatePath("/calendar");
    return { success: true };
  } catch (e) {
    return fail(errorMessage(e));
  }
}
