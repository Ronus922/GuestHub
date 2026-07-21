import { redirect } from "next/navigation";
import { getActor } from "@/lib/auth/actor";
import { MyTasksScreen } from "./MyTasksScreen";

export const dynamic = "force-dynamic";

// Cleaner screen — mobile, no sidebar/topbar (lives outside the (dashboard)
// group). The client screen loads the worker's own queue and polls; this page
// only resolves the actor for the header identity + auth gate.
export default async function MyTasksPage() {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");

  const initial = (actor.fullName ?? actor.username).trim().charAt(0) || "G";
  return <MyTasksScreen initial={initial} />;
}
