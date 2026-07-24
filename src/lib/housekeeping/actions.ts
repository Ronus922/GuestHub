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
  taskType: string;
  title: string | null;
  roomId: string | null;
  roomNumber: string | null;
  status: string;
  priority: string;
  notes: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  dueDate: string | null;
  checkoutTime: string | null;
  orderIndex: number;
  createdAt: string;
};

export type OperationalTaskType = "housekeeping" | "maintenance" | "general";

type Result<T = undefined> = { success: true; data?: T } | { success: false; error: string };

// allowed cleaner transitions (self-service); manager adds completed→inspected.
const CLEANER_NEXT: Record<string, string> = { pending: "in_progress", in_progress: "completed" };

function mapRow(r: Record<string, unknown>): HousekeepingTaskView {
  return {
    id: r.id as string,
    taskType: (r.task_type as string) ?? "housekeeping",
    title: (r.title as string) ?? null,
    roomId: (r.room_id as string) ?? null,
    roomNumber: (r.room_number as string) ?? null,
    status: r.status as string,
    priority: r.priority as string,
    notes: (r.notes as string) ?? null,
    assignedTo: (r.assigned_to as string) ?? null,
    assignedToName: (r.assigned_to_name as string) ?? null,
    dueDate: (r.due_date as string) ?? null,
    checkoutTime: r.checkout_time ? new Date(r.checkout_time as string).toISOString() : null,
    orderIndex: typeof r.order_index === "number" ? r.order_index : Number(r.order_index ?? 0),
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
      SELECT h.id, h.task_type, h.title, h.due_date::text AS due_date, h.room_id, rm.room_number, h.status, h.priority, h.notes,
             h.assigned_to, u.full_name AS assigned_to_name,
             h.checkout_time::text AS checkout_time, h.created_at::text AS created_at
      FROM guesthub.housekeeping_tasks h
      LEFT JOIN guesthub.rooms rm ON rm.id = h.room_id AND rm.tenant_id = h.tenant_id
      LEFT JOIN guesthub.users u  ON u.id = h.assigned_to
      WHERE h.tenant_id = ${actor.tenantId}
        AND h.status IN ('pending','in_progress','completed')
        AND (h.assigned_to = ${actor.userId} OR h.assigned_to IS NULL)
      ORDER BY (h.assigned_to = ${actor.userId}) DESC, h.order_index, h.priority = 'high' DESC, h.created_at`;
    return { success: true, data: rows.map(mapRow) };
  } catch (e) {
    return fail(e);
  }
}

// ---- the drag-and-drop dispatch board reader (D88) ----
// Columns = assignable users; cards = tasks. Mirrors the PMS board's date rule:
// on TODAY show every active task (any date); on another day show that day's
// tasks (by checkout/due). Grouped server-side into byUser + the unassigned
// pool, each bucket already ordered by the persisted order_index. The client
// polls this every 5s (paused mid-drag). housekeeping.view.
export type TaskBoardColumn = { id: string; name: string };
export type TaskBoardRoom = { id: string; roomNumber: string };
export type TaskBoard = {
  users: TaskBoardColumn[];
  rooms: TaskBoardRoom[];
  byUser: Record<string, HousekeepingTaskView[]>;
  unassigned: HousekeepingTaskView[];
};

export async function getTaskBoardAction(
  scope: "housekeeping" | "maintenance",
  dateIso: string,
): Promise<Result<TaskBoard>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "housekeeping.view");
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateIso) ? dateIso : null;
    if (!date) return { success: false, error: "תאריך אינו תקין" };
    // each board is locked to its task_type, and its COLUMNS are only the
    // workers of that type — cleaners for /housekeeping, maintenance workers for
    // /maintenance. Managers / reception / admins are never board columns.
    const roleKey = scope === "housekeeping" ? "cleaner" : "maintenance";

    const rows = await sql<Record<string, unknown>[]>`
      SELECT h.id, h.task_type, h.title, h.due_date::text AS due_date, h.room_id, rm.room_number,
             h.status, h.priority, h.notes, h.order_index,
             h.assigned_to, u.full_name AS assigned_to_name,
             h.checkout_time::text AS checkout_time, h.created_at::text AS created_at
      FROM guesthub.housekeeping_tasks h
      LEFT JOIN guesthub.rooms rm ON rm.id = h.room_id AND rm.tenant_id = h.tenant_id
      LEFT JOIN guesthub.users u  ON u.id = h.assigned_to
      WHERE h.tenant_id = ${actor.tenantId}
        AND h.task_type = ${scope}
        AND h.status IN ('pending','in_progress','completed')
        AND (
          (${date}::date = CURRENT_DATE AND h.status IN ('pending','in_progress'))
          OR COALESCE(h.checkout_time::date, h.due_date, h.created_at::date) = ${date}::date
        )
      ORDER BY h.assigned_to NULLS FIRST, h.order_index, h.created_at`;

    const users = await sql<TaskBoardColumn[]>`
      SELECT u.id, COALESCE(u.full_name, u.username) AS name
      FROM guesthub.users u
      JOIN guesthub.roles r ON r.id = u.role_id AND r.tenant_id = u.tenant_id
      WHERE u.tenant_id = ${actor.tenantId} AND u.is_active = true AND r.key = ${roleKey}
      ORDER BY name`;

    const rooms = await sql<TaskBoardRoom[]>`
      SELECT id, room_number AS "roomNumber"
      FROM guesthub.rooms
      WHERE tenant_id = ${actor.tenantId} AND is_active = true
      ORDER BY room_number`;

    // seed every worker column so an empty worker still renders a droppable
    // column. A task assigned to someone who is NOT a worker of this board (no
    // matching column) falls back to the unassigned pool so it stays visible
    // and reassignable — never silently dropped into an invisible bucket.
    const byUser: Record<string, HousekeepingTaskView[]> = {};
    for (const u of users) byUser[u.id] = [];
    const unassigned: HousekeepingTaskView[] = [];
    for (const raw of rows) {
      const t = mapRow(raw);
      if (t.assignedTo && byUser[t.assignedTo]) byUser[t.assignedTo].push(t);
      else unassigned.push(t);
    }
    return { success: true, data: { users, rooms, byUser, unassigned } };
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
      SELECT h.id, h.task_type, h.title, h.due_date::text AS due_date, h.room_id, rm.room_number, h.status, h.priority, h.notes,
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

// Manager creates a task on the SAME unified store (§9) — maintenance or general
// follow-ups, not only auto-generated housekeeping. housekeeping.manage.
export async function createOperationalTaskAction(input: {
  taskType: OperationalTaskType;
  title: string;
  roomId?: string | null;
  priority?: "normal" | "high";
  dueDate?: string | null;
  notes?: string | null;
}): Promise<Result<{ id: string }>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "housekeeping.manage");
    const title = input.title?.trim();
    if (!title) return { success: false, error: "נדרשת כותרת למשימה" };
    if (!["housekeeping", "maintenance", "general"].includes(input.taskType))
      return { success: false, error: "סוג משימה אינו תקין" };
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO guesthub.housekeeping_tasks
        (tenant_id, task_type, title, room_id, status, priority, due_date, notes)
      VALUES (${actor.tenantId}, ${input.taskType}, ${title.slice(0, 200)},
              ${input.roomId ?? null}, 'pending', ${input.priority ?? "normal"},
              ${input.dueDate ?? null}, ${input.notes?.slice(0, 500) ?? null})
      RETURNING id`;
    await writeAudit(actor, {
      entityType: "operational_task", entityId: row.id, action: "create",
      after: { task_type: input.taskType, title, room_id: input.roomId ?? null },
    });
    revalidatePath("/housekeeping/my-tasks");
    return { success: true, data: { id: row.id } };
  } catch (e) {
    return fail(e);
  }
}

// Manager assigns a task to a cleaner (or back to the unassigned pool).
// housekeeping.manage. After the move the TARGET bucket's order_index is
// recomputed by natural sort (dropped card lands in its natural position, like
// the PMS board) — a follow-up reorder() then persists any manual re-drag.
export async function assignTaskAction(taskId: string, userId: string | null): Promise<Result> {
  try {
    const actor = await getActor();
    requirePermission(actor, "housekeeping.manage");
    const done = await sql.begin(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        UPDATE guesthub.housekeeping_tasks
        SET assigned_to = ${userId}, updated_at = now()
        WHERE id = ${taskId} AND tenant_id = ${actor.tenantId}
          AND status IN ('pending','in_progress')
        RETURNING id`;
      if (!row) return false;
      // renumber the destination bucket (including the unassigned pool) so
      // order_index is dense and reflects the natural sort as the baseline:
      // urgent first, then the soonest checkout/due, then age (like PMS)
      await tx`
        WITH ranked AS (
          SELECT id, ROW_NUMBER() OVER (
            ORDER BY (priority = 'high') DESC,
                     COALESCE(checkout_time, (due_date::timestamptz)) ASC NULLS LAST,
                     created_at ASC
          ) AS rn
          FROM guesthub.housekeeping_tasks
          WHERE tenant_id = ${actor.tenantId}
            AND status IN ('pending','in_progress','completed')
            AND assigned_to IS NOT DISTINCT FROM ${userId}
        )
        UPDATE guesthub.housekeeping_tasks t
        SET order_index = ranked.rn
        FROM ranked
        WHERE t.id = ranked.id AND t.tenant_id = ${actor.tenantId}`;
      return true;
    });
    if (!done) return { success: false, error: "המשימה לא נמצאה או אינה פתוחה" };
    await writeAudit(actor, {
      entityType: "housekeeping_task", entityId: taskId, action: "assign",
      after: { assigned_to: userId },
    });
    revalidatePath("/housekeeping");
    revalidatePath("/maintenance");
    revalidatePath("/housekeeping/my-tasks");
    return { success: true };
  } catch (e) {
    return fail(e);
  }
}

// Persist the MANUAL order of one column after an in-column drag. The ordered id
// list is applied as order_index 1..n; only rows in the named bucket are
// touched. housekeeping.manage.
export async function reorderTasksAction(
  bucketUserId: string | null,
  orderedIds: string[],
): Promise<Result> {
  try {
    const actor = await getActor();
    requirePermission(actor, "housekeeping.manage");
    if (orderedIds.length === 0) return { success: true };
    await sql`
      UPDATE guesthub.housekeeping_tasks t
      SET order_index = o.ord, updated_at = now()
      FROM unnest(${orderedIds}::uuid[]) WITH ORDINALITY AS o(id, ord)
      WHERE t.id = o.id
        AND t.tenant_id = ${actor.tenantId}
        AND t.assigned_to IS NOT DISTINCT FROM ${bucketUserId}`;
    revalidatePath("/housekeeping");
    revalidatePath("/maintenance");
    return { success: true };
  } catch (e) {
    return fail(e);
  }
}

// Manager sets a task's status directly from the board (the status pills).
// pending → in_progress → completed → inspected, and back down. housekeeping.manage.
const BOARD_STATUSES = ["pending", "in_progress", "completed", "inspected"] as const;
export async function setTaskStatusAction(taskId: string, status: string): Promise<Result> {
  try {
    const actor = await getActor();
    requirePermission(actor, "housekeeping.manage");
    if (!BOARD_STATUSES.includes(status as (typeof BOARD_STATUSES)[number]))
      return { success: false, error: "סטטוס אינו תקין" };
    const [row] = await sql<{ id: string }[]>`
      UPDATE guesthub.housekeeping_tasks
      SET status = ${status},
          completed_at = ${status === "completed" ? sql`now()` : sql`completed_at`},
          updated_at = now()
      WHERE id = ${taskId} AND tenant_id = ${actor.tenantId}
      RETURNING id`;
    if (!row) return { success: false, error: "המשימה לא נמצאה" };
    await writeAudit(actor, {
      entityType: "housekeeping_task", entityId: taskId, action: "set_status",
      after: { status },
    });
    revalidatePath("/housekeeping");
    revalidatePath("/maintenance");
    revalidatePath("/housekeeping/my-tasks");
    return { success: true };
  } catch (e) {
    return fail(e);
  }
}

// Manager edits a task's details from the side panel. housekeeping.manage.
export async function updateTaskAction(
  taskId: string,
  input: {
    title?: string | null;
    roomId?: string | null;
    priority?: "normal" | "high";
    dueDate?: string | null;
    notes?: string | null;
  },
): Promise<Result> {
  try {
    const actor = await getActor();
    requirePermission(actor, "housekeeping.manage");
    const [row] = await sql<{ id: string }[]>`
      UPDATE guesthub.housekeeping_tasks
      SET title    = ${input.title?.slice(0, 200) ?? null},
          room_id  = ${input.roomId ?? null},
          priority = ${input.priority ?? "normal"},
          due_date = ${input.dueDate ?? null},
          notes    = ${input.notes?.slice(0, 500) ?? null},
          updated_at = now()
      WHERE id = ${taskId} AND tenant_id = ${actor.tenantId}
      RETURNING id`;
    if (!row) return { success: false, error: "המשימה לא נמצאה" };
    await writeAudit(actor, {
      entityType: "housekeeping_task", entityId: taskId, action: "update",
      after: { title: input.title ?? null, priority: input.priority ?? "normal" },
    });
    revalidatePath("/housekeeping");
    revalidatePath("/maintenance");
    return { success: true };
  } catch (e) {
    return fail(e);
  }
}

// Manager deletes a task (manual follow-ups + obsolete auto tasks). housekeeping.manage.
export async function deleteTaskAction(taskId: string): Promise<Result> {
  try {
    const actor = await getActor();
    requirePermission(actor, "housekeeping.manage");
    const [row] = await sql<{ id: string }[]>`
      DELETE FROM guesthub.housekeeping_tasks
      WHERE id = ${taskId} AND tenant_id = ${actor.tenantId}
      RETURNING id`;
    if (!row) return { success: false, error: "המשימה לא נמצאה" };
    await writeAudit(actor, {
      entityType: "housekeeping_task", entityId: taskId, action: "delete",
    });
    revalidatePath("/housekeeping");
    revalidatePath("/maintenance");
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
