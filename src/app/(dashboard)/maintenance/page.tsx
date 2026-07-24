import { redirect } from "next/navigation";
import { getActor, hasPermission } from "@/lib/auth/actor";
import { TaskDispatchBoard } from "../housekeeping/TaskDispatchBoard";

export const dynamic = "force-dynamic";

// /maintenance — the manager dispatch board for maintenance / fault tasks
// (תחזוקה / תקלות), scope="maintenance" on the one housekeeping_tasks store
// (D88). Same gate + Server Actions as /housekeeping and /tasks; the board is
// type-locked to maintenance.
export default async function MaintenancePage() {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  if (!hasPermission(actor, "housekeeping.view")) redirect("/dashboard");

  return (
    <div className="p-4 sm:p-6">
      <TaskDispatchBoard scope="maintenance" canManage={hasPermission(actor, "housekeeping.manage")} />
    </div>
  );
}
