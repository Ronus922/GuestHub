import { redirect } from "next/navigation";
import { getActor, hasPermission } from "@/lib/auth/actor";
import { getTenantVatRate } from "@/lib/settings";
import { SettingsScreen } from "./SettingsScreen";

export const dynamic = "force-dynamic";

// /settings — tenant business settings (D41). Gated by settings.edit, the
// same permission the server action enforces.
export default async function SettingsPage() {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  if (!hasPermission(actor, "settings.edit")) redirect("/dashboard");

  const vatRate = await getTenantVatRate(actor.tenantId);
  return <SettingsScreen tenantName={actor.tenantName} vatRate={vatRate} />;
}
