import { redirect } from "next/navigation";
import { getActor, hasPermission } from "@/lib/auth/actor";
import { sql } from "@/lib/db";
import { StaffScreen } from "./StaffScreen";
import type {
  StaffUser,
  RoleOption,
  RolePermissionsMap,
  PermissionDef,
  OverridesByUser,
} from "./types";

export const dynamic = "force-dynamic";

export default async function StaffPage() {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  if (!hasPermission(actor, "staff.view")) redirect("/dashboard");

  const users = await sql<StaffUser[]>`
    SELECT u.id, u.full_name, u.username, u.email, u.phone, u.is_active,
           u.allow_google_auth, u.role_id, r.key AS role_key, r.name AS role_name,
           u.created_at,
           au.last_sign_in_at
    FROM guesthub.users u
    LEFT JOIN guesthub.roles r ON r.id = u.role_id
    LEFT JOIN auth.users au ON au.id = u.auth_user_id
    WHERE u.tenant_id = ${actor.tenantId}
    ORDER BY u.full_name NULLS LAST, u.username`;

  const roles = await sql<RoleOption[]>`
    SELECT id, key, name, description, is_system FROM guesthub.roles
    WHERE tenant_id = ${actor.tenantId}
    ORDER BY CASE key
      WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2
      WHEN 'receptionist' THEN 3 WHEN 'staff' THEN 4 WHEN 'cleaner' THEN 5 ELSE 9 END`;

  // Effective permissions per role (read-only display in the side panel).
  const permRows = await sql<{ role_id: string; key: string; label: string; category: string | null }[]>`
    SELECT rp.role_id, p.key, COALESCE(p.description, p.key) AS label, p.category
    FROM guesthub.role_permissions rp
    JOIN guesthub.roles r ON r.id = rp.role_id
    JOIN guesthub.permissions p ON p.id = rp.permission_id
    WHERE r.tenant_id = ${actor.tenantId}
    ORDER BY p.category NULLS LAST, p.key`;
  const rolePermissions: RolePermissionsMap = {};
  for (const row of permRows) {
    (rolePermissions[row.role_id] ??= []).push({
      key: row.key,
      label: row.label,
      category: row.category,
    });
  }

  // Full permission catalog — the module rows of the per-module effective matrix
  // shown inside the employee edit panel (unchecked cells need the full catalog).
  const permissionCatalog = await sql<PermissionDef[]>`
    SELECT p.key, COALESCE(p.description, p.key) AS label, p.category
    FROM guesthub.permissions p
    ORDER BY p.key`;

  // Personal overrides per user — the layer the matrix renders on top of the
  // role defaults (grant = added manually, revoke = removed manually).
  const overrideRows = await sql<{ user_id: string; key: string; effect: "grant" | "revoke" }[]>`
    SELECT o.user_id, p.key, o.effect
    FROM guesthub.user_permission_overrides o
    JOIN guesthub.permissions p ON p.id = o.permission_id
    WHERE o.tenant_id = ${actor.tenantId}`;
  const overridesByUser: OverridesByUser = {};
  for (const row of overrideRows) {
    (overridesByUser[row.user_id] ??= []).push({ key: row.key, effect: row.effect });
  }

  return (
    <StaffScreen
      users={users}
      roles={roles}
      rolePermissions={rolePermissions}
      permissionCatalog={permissionCatalog}
      overridesByUser={overridesByUser}
      currentUserId={actor.userId}
      actorRoleKey={actor.roleKey}
      canCreate={hasPermission(actor, "staff.create")}
      canUpdate={hasPermission(actor, "staff.update")}
      canDisable={hasPermission(actor, "staff.disable")}
      canViewPermissions={hasPermission(actor, "permissions.view")}
      canManageOverrides={hasPermission(actor, "permissions.update")}
    />
  );
}
