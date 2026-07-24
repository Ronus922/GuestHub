import { redirect } from "next/navigation";
import { getActor, hasPermission } from "@/lib/auth/actor";
import { TaskDispatchBoard } from "./TaskDispatchBoard";

export const dynamic = "force-dynamic";

// /housekeeping — the manager cleaning dispatch board (drag-to-assign, D88).
// Gated by housekeeping.view; assign/reorder/status/create/delete enforce
// housekeeping.manage server-side. The board loads its own data client-side and
// polls, so this page only resolves the actor + permission. The title lives in
// the board header (with the day-navigation + KPI filters).
export default async function HousekeepingPage() {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  if (!hasPermission(actor, "housekeeping.view")) redirect("/dashboard");

  return (
    <div className="p-4 sm:p-6">
      <TaskDispatchBoard scope="housekeeping" canManage={hasPermission(actor, "housekeeping.manage")} />
    </div>
  );
}
