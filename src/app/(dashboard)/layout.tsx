import { redirect } from "next/navigation";
import { getActor, toActorContext } from "@/lib/auth/actor";
import { Shell } from "@/components/layout/Shell";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  // Cleaners get the dedicated mobile task screen, no shell.
  if (actor.roleKey === "cleaner") redirect("/housekeeping/my-tasks");

  return <Shell actor={toActorContext(actor)}>{children}</Shell>;
}
