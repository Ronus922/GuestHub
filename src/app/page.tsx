import { redirect } from "next/navigation";
import { getActor } from "@/lib/auth/actor";

export default async function RootPage() {
  const actor = await getActor();
  // Session but no active guesthub user → clear it (avoids /login ↔ / loop).
  if (!actor) redirect("/auth/signout");
  if (actor.roleKey === "cleaner") redirect("/housekeeping/my-tasks");
  redirect("/dashboard");
}
