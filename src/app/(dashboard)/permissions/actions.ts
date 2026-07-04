"use server";

import { revalidatePath } from "next/cache";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { sql } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { canTogglePermission } from "@/lib/auth/guards";
import { togglePermissionSchema } from "@/lib/validation/user";
import type { ActionResult } from "./types";

const fail = (error: string): ActionResult => ({ success: false, error });

export async function setRolePermissionAction(input: unknown): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "permissions.update");

    const parsed = togglePermissionSchema.safeParse(input);
    if (!parsed.success) return fail("קלט לא תקין");
    const { role_id, permission_id, granted } = parsed.data;

    // role must belong to the actor's tenant
    const [role] = await sql<{ key: string }[]>`
      SELECT key FROM guesthub.roles
      WHERE id = ${role_id} AND tenant_id = ${actor.tenantId} LIMIT 1`;
    if (!role) return fail("תפקיד לא תקין");

    const [perm] = await sql<{ key: string }[]>`
      SELECT key FROM guesthub.permissions WHERE id = ${permission_id} LIMIT 1`;
    if (!perm) return fail("הרשאה לא תקינה");

    const guard = canTogglePermission(actor, role.key, perm.key, granted);
    if (!guard.ok) return fail(guard.error);

    if (granted) {
      await sql`
        INSERT INTO guesthub.role_permissions (role_id, permission_id)
        VALUES (${role_id}, ${permission_id})
        ON CONFLICT (role_id, permission_id) DO NOTHING`;
    } else {
      await sql`
        DELETE FROM guesthub.role_permissions
        WHERE role_id = ${role_id} AND permission_id = ${permission_id}`;
    }

    await writeAudit(actor, {
      entityType: "role_permission",
      entityId: role_id,
      action: granted ? "permission_grant" : "permission_revoke",
      after: { role: role.key, permission: perm.key, granted },
    });

    revalidatePath("/permissions");
    return { success: true };
  } catch (e) {
    if (e instanceof AuthorizationError) return fail(e.message);
    return fail("שגיאת שרת");
  }
}
