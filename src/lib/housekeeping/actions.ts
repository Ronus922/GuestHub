"use server";

import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { getActor } from "@/lib/auth/actor";
import { requirePermission, hasPermission, AuthorizationError } from "@/lib/auth/permission-check";
import { writeAudit } from "@/lib/audit";

// ============================================================
// Housekeeping task operations (Stage 5 §7). Tasks are GENERATED automatically
// on checkout (reservations/actions.ts) — this module is the operational flow:
// the cleaner's my-tasks list + start/complete, and the manager's assign/inspect.
//
// Cleanliness lifecycle: pending (dirty) → in_progress (cleaning) → completed
// (clean) → inspected (manager-verified). Cleanliness does NOT change room
// availability (a dirty room stays sellable before the next arrival — D64 0/1
// model), so nothing here marks the ARI outbox.
// ============================================================

export type HousekeepingTaskView = {
  id: string;
  roomId: string | null;
  roomNumber: string | null;
  status: string;
  priority: string;
  notes: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  checkoutTime: string | null;
  createdAt: string;
};

type Result<T = undefined> = { success: true; data?: T } | { success: false; error: string };

// allowed cleaner transitions (self-service); manager adds completed→inspected.
const CLEANER_NEXT: Record<string, string> = { pending: "in_progress", in_progress: "completed" };

function mapRow(r: Record<string, unknown>): HousekeepingTaskView {
  return {
    id: r.id as string,
    roomId: (r.room_id as string) ?? null,
    roomNumber: (r.room_number as string) ?? null,
    status: r.status as string,
    priority: r.priority as string,
    notes: (r.notes as string) ?? null,
    assignedTo: (r.assigned_to as string) ?? null,
    assignedToName: (r.assigned_to_name as string) ?? null,
    checkoutTime: r.checkout_time ? new Date(r.checkout_time as string).toISOString() : null,
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

// The cleaner's queue: tasks assigned to them PLUS the unassigned open pool so
// they can pick up work. Requires housekeeping.my_tasks (or a broader view perm).
export async function getMyTasksAction(): Promise<Result<HousekeepingTaskView[]>> {
  try {
    const actor = await getActor();
    if (!actor) throw new AuthorizationError("לא מחובר למערכת");
    if (!hasPermission(actor, "housekeeping.my_tasks") && !hasPermission(actor, "housekeeping.view"))
      throw new AuthorizationError("חסרה הרשאה: housekeeping.my_tasks");
    const rows = await sql<Record<string, unknown>[]>`
      SELECT h.id, h.room_id, rm.room_number, h.status, h.priority, h.notes,
             h.assigned_to, u.full_name AS assigned_to_name,
             h.checkout_time::text AS checkout_time, h.created_at::text AS created_at
      FROM guesthub.housekeeping_tasks h
      LEFT JOIN guesthub.rooms rm ON rm.id = h.room_id AND rm.tenant_id = h.tenant_id
      LEFT JOIN guesthub.users u  ON u.id = h.assigned_to
      WHERE h.tenant_id = ${actor.tenantId}
        AND h.status IN ('pending','in_progress')
        AND (h.assigned_to = ${actor.userId} OR h.assigned_to IS NULL)
      ORDER BY (h.assigned_to = ${actor.userId}) DESC, h.priority = 'high' DESC, h.created_at`;
    return { success: true, data: rows.map(mapRow) };
  } catch (e) {
    return fail(e);
  }
}

// Manager view: every open task, for assignment + oversight. housekeeping.view.
export async function listOpenTasksAction(): Promise<Result<HousekeepingTaskView[]>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "housekeeping.view");
    const rows = await sql<Record<string, unknown>[]>`
      SELECT h.id, h.room_id, rm.room_number, h.status, h.priority, h.notes,
             h.assigned_to, u.full_name AS assigned_to_name,
             h.checkout_time::text AS checkout_time, h.created_at::text AS created_at
      FROM guesthub.housekeeping_tasks h
      LEFT JOIN guesthub.rooms rm ON rm.id = h.room_id AND rm.tenant_id = h.tenant_id
      LEFT JOIN guesthub.users u  ON u.id = h.assigned_to
      WHERE h.tenant_id = ${actor.tenantId} AND h.status IN ('pending','in_progress','completed')
      ORDER BY h.status, h.priority = 'high' DESC, h.created_at`;
    return { success: true, data: rows.map(mapRow) };
  } catch (e) {
    return fail(e);
  }
}

// Cleaner advances their own (or an unassigned) task one step. Claiming an
// unassigned task assigns it to the actor. Guarded so a cleaner can only move a
// task they own or the shared pool — never another cleaner's active task.
export async function advanceMyTaskAction(taskId: string): Promise<Result> {
  try {
    const actor = await getActor();
    if (!actor) throw new AuthorizationError("לא מחובר למערכת");
    if (!hasPermission(actor, "housekeeping.my_tasks") && !hasPermission(actor, "housekeeping.manage"))
      throw new AuthorizationError("חסרה הרשאה: housekeeping.my_tasks");

    const done = await sql.begin(async (tx) => {
      const [task] = await tx<{ id: string; status: string; assigned_to: string | null }[]>`
        SELECT id, status, assigned_to FROM guesthub.housekeeping_tasks
        WHERE id = ${taskId} AND tenant_id = ${actor.tenantId} FOR UPDATE`;
      if (!task) return { ok: false as const, error: "המשימה לא נמצאה" };
      if (task.assigned_to && task.assigned_to !== actor.userId && !hasPermission(actor, "housekeeping.manage"))
        return { ok: false as const, error: "המשימה משויכת למנקה אחר" };
      const next = CLEANER_NEXT[task.status];
      if (!next) return { ok: false as const, error: "לא ניתן לקדם משימה במצב זה" };
      await tx`
        UPDATE guesthub.housekeeping_tasks
        SET status = ${next},
            assigned_to = COALESCE(assigned_to, ${actor.userId}),
            completed_at = ${next === "completed" ? sql`now()` : sql`completed_at`},
            updated_at = now()
        WHERE id = ${taskId} AND tenant_id = ${actor.tenantId}`;
      await writeAudit(actor, {
        entityType: "housekeeping_task", entityId: taskId, action: "advance",
        before: { status: task.status }, after: { status: next },
      }, tx);
      return { ok: true as const };
    });
    if (!done.ok) return { success: false, error: done.error };
    revalidatePath("/housekeeping/my-tasks");
    revalidatePath("/rooms");
    return { success: true };
  } catch (e) {
    return fail(e);
  }
}

// Manager assigns a task to a cleaner. housekeeping.manage.
export async function assignTaskAction(taskId: string, userId: string | null): Promise<Result> {
  try {
    const actor = await getActor();
    requirePermission(actor, "housekeeping.manage");
    const [row] = await sql<{ id: string }[]>`
      UPDATE guesthub.housekeeping_tasks
      SET assigned_to = ${userId}, updated_at = now()
      WHERE id = ${taskId} AND tenant_id = ${actor.tenantId}
        AND status IN ('pending','in_progress')
      RETURNING id`;
    if (!row) return { success: false, error: "המשימה לא נמצאה או אינה פתוחה" };
    await writeAudit(actor, {
      entityType: "housekeeping_task", entityId: taskId, action: "assign",
      after: { assigned_to: userId },
    });
    revalidatePath("/housekeeping/my-tasks");
    return { success: true };
  } catch (e) {
    return fail(e);
  }
}

// Manager marks a completed room inspected (clean/dirty/INSPECTED lifecycle).
export async function inspectTaskAction(taskId: string): Promise<Result> {
  try {
    const actor = await getActor();
    requirePermission(actor, "housekeeping.manage");
    const [row] = await sql<{ id: string }[]>`
      UPDATE guesthub.housekeeping_tasks
      SET status = 'inspected', updated_at = now()
      WHERE id = ${taskId} AND tenant_id = ${actor.tenantId} AND status = 'completed'
      RETURNING id`;
    if (!row) return { success: false, error: "רק משימה שהושלמה ניתנת לאישור בדיקה" };
    await writeAudit(actor, {
      entityType: "housekeeping_task", entityId: taskId, action: "inspect",
      after: { status: "inspected" },
    });
    revalidatePath("/housekeeping/my-tasks");
    return { success: true };
  } catch (e) {
    return fail(e);
  }
}

function fail(e: unknown): { success: false; error: string } {
  if (e instanceof AuthorizationError) return { success: false, error: e.message };
  console.error("[housekeeping]", e);
  return { success: false, error: "אירעה שגיאה בלתי צפויה" };
}
