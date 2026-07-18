import { redirect } from "next/navigation";
import { getActor, hasPermission } from "@/lib/auth/actor";
import { TasksBoard } from "./TasksBoard";
import { loadTaskBoardData } from "./data";

export const dynamic = "force-dynamic";

// /housekeeping — manager cleaning board. Gated by housekeeping.view; assign/
// inspect/create enforce housekeeping.manage server-side. The cleaner's own
// mobile screen lives at /housekeeping/my-tasks (outside the dashboard shell).
export default async function HousekeepingPage() {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  if (!hasPermission(actor, "housekeeping.view")) redirect("/dashboard");

  const data = await loadTaskBoardData();
  if (!data) redirect("/auth/signout");

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <h1 className="h1 text-right">ניקיון</h1>
      <TasksBoard
        scope="housekeeping"
        tasks={data.tasks}
        users={data.users}
        rooms={data.rooms}
        canManage={hasPermission(actor, "housekeeping.manage")}
      />
    </div>
  );
}
