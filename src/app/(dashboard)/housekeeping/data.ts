import { sql } from "@/lib/db";
import { getActor } from "@/lib/auth/actor";
import { listOpenTasksAction, type HousekeepingTaskView } from "@/lib/housekeeping/actions";

export type AssignableUser = { id: string; name: string };
export type RoomOption = { id: string; roomNumber: string };
export type TaskBoardData = {
  tasks: HousekeepingTaskView[];
  users: AssignableUser[];
  rooms: RoomOption[];
};

// Shared server-side load for the two manager task boards (/housekeeping = cleaning,
// /tasks = all operational). listOpenTasksAction is the SINGLE source for the rows
// (gated by housekeeping.view); users + rooms feed the assign/create controls.
export async function loadTaskBoardData(): Promise<TaskBoardData | null> {
  const actor = await getActor();
  if (!actor) return null;

  const res = await listOpenTasksAction();
  const tasks = res.success ? res.data ?? [] : [];

  const users = await sql<AssignableUser[]>`
    SELECT id, COALESCE(full_name, username) AS name
    FROM guesthub.users
    WHERE tenant_id = ${actor.tenantId} AND is_active = true
    ORDER BY name`;

  const rooms = await sql<RoomOption[]>`
    SELECT id, room_number AS "roomNumber"
    FROM guesthub.rooms
    WHERE tenant_id = ${actor.tenantId} AND is_active = true
    ORDER BY room_number`;

  return { tasks, users, rooms };
}
