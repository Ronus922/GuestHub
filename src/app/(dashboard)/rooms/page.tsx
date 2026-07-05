import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { getActor, hasPermission } from "@/lib/auth/actor";
import { getTenantCurrency } from "@/lib/settings";
import { getExtraGuestDefaults } from "@/lib/commercial/service";
import { todayInTz } from "@/lib/dates";
import {
  listBoardRooms,
  listOperationalAreas,
  listBuildings,
  listRoomTypes,
  listAmenities,
} from "@/lib/rooms/service";
import { RoomsScreen } from "./RoomsScreen";

export const dynamic = "force-dynamic";

// /rooms — the full Rooms & Areas board: floor-grouped room cards, operational
// areas, and the 3-step room wizard. Gated by rooms.view; mutations enforce
// rooms.create/edit/delete server-side in the actions.
export default async function RoomsPage() {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  if (!hasPermission(actor, "rooms.view")) redirect("/dashboard");

  const [tenant] = await sql<{ timezone: string }[]>`
    SELECT timezone FROM guesthub.tenants WHERE id = ${actor.tenantId}`;
  const today = todayInTz(tenant?.timezone || "Asia/Jerusalem");

  const [rooms, areas, buildings, roomTypes, amenities, property, currency] = await Promise.all([
    listBoardRooms(actor.tenantId, today),
    listOperationalAreas(actor.tenantId),
    listBuildings(actor.tenantId),
    listRoomTypes(actor.tenantId),
    listAmenities(actor.tenantId),
    getExtraGuestDefaults(actor.tenantId),
    getTenantCurrency(actor.tenantId),
  ]);

  return (
    <RoomsScreen
      rooms={rooms}
      areas={areas}
      buildings={buildings}
      roomTypes={roomTypes}
      amenities={amenities}
      property={property}
      currency={currency}
      today={today}
      can={{
        create: hasPermission(actor, "rooms.create"),
        edit: hasPermission(actor, "rooms.edit"),
        del: hasPermission(actor, "rooms.delete"),
      }}
    />
  );
}
