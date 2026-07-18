import { redirect } from "next/navigation";
import { getActor, hasPermission } from "@/lib/auth/actor";
import { TasksBoard } from "../housekeeping/TasksBoard";
import { loadTaskBoardData } from "../housekeeping/data";

export const dynamic = "force-dynamic";

// /tasks — manager board for EVERY operational task (ניקיון + תחזוקה + כללי) on
// the one unified housekeeping_tasks store. Same gate + Server Actions as
// /housekeeping; here the type filter and free-type create are exposed.
export default async function TasksPage() {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  if (!hasPermission(actor, "housekeeping.view")) redirect("/dashboard");

  const data = await loadTaskBoardData();
  if (!data) redirect("/auth/signout");

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <h1 className="h1 text-right">משימות</h1>
      <TasksBoard
        scope="all"
        tasks={data.tasks}
        users={data.users}
        rooms={data.rooms}
        canManage={hasPermission(actor, "housekeeping.manage")}
      />
    </div>
  );
}
