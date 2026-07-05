"use server";

import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { writeAudit } from "@/lib/audit";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";
import { roomOccupancySchema } from "@/lib/validation/commercial";
import { validateRoomOccupancy } from "@/lib/commercial/room-pricing";
import { getExtraGuestDefaults } from "@/lib/commercial/service";

// Room occupancy + extra-guest override save (§7/§8). Gated by rooms.edit
// (server-side; hiding a control is not authorization). Validates with the shared
// pure validator against the room's published state and the property's configured
// state, then writes in one transaction with an audit row. In inherit mode the
// override columns are NULLED — property values are never copied into the room.
export async function saveRoomOccupancyAction(raw: unknown): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rooms.edit");

    const parsed = roomOccupancySchema.safeParse(raw);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    const r = parsed.data;

    // load the room (tenant-scoped) for its published state
    const [room] = await sql<{ is_active: boolean; status: string }[]>`
      SELECT is_active, status FROM guesthub.rooms
      WHERE id = ${r.id} AND tenant_id = ${actor.tenantId}`;
    if (!room) return { success: false, error: "החדר לא נמצא" };

    const property = await getExtraGuestDefaults(actor.tenantId);
    const published = room.is_active && room.status === "available";

    // inherit mode → override values are irrelevant; validate against inherited pricing
    const override = r.extra_guest_pricing_mode === "override";
    const { errors } = validateRoomOccupancy({
      maxOccupancy: r.max_occupancy,
      maxAdults: r.max_adults,
      maxChildren: r.max_children,
      maxInfants: r.max_infants,
      defaultOccupancy: r.default_occupancy,
      includedOccupancy: r.included_occupancy,
      mode: r.extra_guest_pricing_mode,
      extra_adult: override ? r.extra_adult_override : null,
      extra_child: override ? r.extra_child_override : null,
      extra_infant: override ? r.extra_infant_override : null,
      published,
      propertyConfigured: property.configured,
    });
    if (errors.length) return { success: false, error: errors[0] };

    // null out overrides in inherit mode — never persist copies of property values
    const oa = override ? r.extra_adult_override : null;
    const oc = override ? r.extra_child_override : null;
    const oi = override ? r.extra_infant_override : null;
    const of = override ? r.charge_frequency_override : null;

    await sql.begin(async (tx) => {
      const [before] = await tx<Record<string, unknown>[]>`
        SELECT max_occupancy, max_adults, max_children, max_infants, default_occupancy,
               included_occupancy, extra_guest_pricing_mode,
               extra_adult_override::float8 AS extra_adult_override,
               extra_child_override::float8 AS extra_child_override,
               extra_infant_override::float8 AS extra_infant_override,
               charge_frequency_override
        FROM guesthub.rooms WHERE id = ${r.id} AND tenant_id = ${actor.tenantId} FOR UPDATE`;
      await tx`
        UPDATE guesthub.rooms SET
          max_occupancy = ${r.max_occupancy}, max_adults = ${r.max_adults},
          max_children = ${r.max_children}, max_infants = ${r.max_infants},
          default_occupancy = ${r.default_occupancy}, included_occupancy = ${r.included_occupancy},
          extra_guest_pricing_mode = ${r.extra_guest_pricing_mode},
          extra_adult_override = ${oa}, extra_child_override = ${oc},
          extra_infant_override = ${oi}, charge_frequency_override = ${of}
        WHERE id = ${r.id} AND tenant_id = ${actor.tenantId}`;
      await writeAudit(actor, {
        entityType: "room_occupancy",
        entityId: r.id,
        action: "update",
        before: before ?? null,
        after: {
          max_occupancy: r.max_occupancy, included_occupancy: r.included_occupancy,
          extra_guest_pricing_mode: r.extra_guest_pricing_mode,
          extra_adult_override: oa, extra_child_override: oc, extra_infant_override: oi,
        },
      }, tx);
    });

    revalidatePath("/rooms");
    return { success: true };
  } catch (e) {
    if (e instanceof AuthorizationError) return { success: false, error: e.message };
    console.error("[rooms:save]", e);
    if ((e as { code?: string })?.code === "23514")
      return { success: false, error: "ערכי תפוסה אינם עקביים (חריגה ממגבלת המסד)" };
    return { success: false, error: "אירעה שגיאה בלתי צפויה" };
  }
}
