import { redirect } from "next/navigation";
import { getActor, hasPermission } from "@/lib/auth/actor";
import { sql } from "@/lib/db";
import { PermissionsMatrix } from "./PermissionsMatrix";
import type { Role, Permission, Grant } from "./types";

export const dynamic = "force-dynamic";

export default async function PermissionsPage() {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  if (!hasPermission(actor, "permissions.view")) redirect("/dashboard");

  const roles = await sql<Role[]>`
    SELECT id, key, name, is_system FROM guesthub.roles
    WHERE tenant_id = ${actor.tenantId}
    ORDER BY CASE key
      WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2
      WHEN 'receptionist' THEN 3 WHEN 'staff' THEN 4 WHEN 'cleaner' THEN 5 ELSE 9 END`;

  const permissions = await sql<Permission[]>`
    SELECT id, key, description, category FROM guesthub.permissions
    ORDER BY category, key`;

  const grants = await sql<Grant[]>`
    SELECT rp.role_id, rp.permission_id
    FROM guesthub.role_permissions rp
    JOIN guesthub.roles r ON r.id = rp.role_id
    WHERE r.tenant_id = ${actor.tenantId}`;

  return (
    <PermissionsMatrix
      roles={roles}
      permissions={permissions}
      grants={grants}
      canUpdate={hasPermission(actor, "permissions.update")}
    />
  );
}
