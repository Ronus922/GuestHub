import { redirect } from "next/navigation";
import { getActor, hasPermission } from "@/lib/auth/actor";
import { getTenantCurrency } from "@/lib/settings";
import { listRooms, getExtraGuestDefaults } from "@/lib/commercial/service";
import { RoomsScreen } from "./RoomsScreen";

export const dynamic = "force-dynamic";

// /rooms — room occupancy + extra-guest pricing (inherit/override). Gated by
// rooms.view; mutations require rooms.edit (enforced server-side in the action).
export default async function RoomsPage() {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  if (!hasPermission(actor, "rooms.view")) redirect("/dashboard");

  const [rooms, property, currency] = await Promise.all([
    listRooms(actor.tenantId),
    getExtraGuestDefaults(actor.tenantId),
    getTenantCurrency(actor.tenantId),
  ]);

  return (
    <RoomsScreen
      rooms={rooms}
      property={property}
      currency={currency}
      canEdit={hasPermission(actor, "rooms.edit")}
    />
  );
}
