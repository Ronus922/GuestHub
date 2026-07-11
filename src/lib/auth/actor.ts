import { cache } from "react";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { sql } from "@/lib/db";

// Server-side identity of the caller. Every Server Action must resolve this and
// tenant-scope its queries by actor.tenantId. Never trust a client-supplied tenantId.
export type Actor = {
  userId: string;
  tenantId: string;
  authUserId: string;
  username: string;
  fullName: string | null;
  email: string | null;
  roleKey: string;
  roleName: string | null;
  tenantName: string;
  tenantSlug: string;
  permissions: Set<string>;
};

// Plain, JSON-serializable shape streamed to the client (Set → string[]).
// Deliberately EXCLUDES the internal tenant label (tenants.name): the client
// receives only the formatted canonical identity (propertyIdentity), so the
// obsolete internal label can never leak into any client payload.
export type ActorContext = {
  userId: string;
  tenantId: string;
  username: string;
  fullName: string | null;
  email: string | null;
  roleKey: string;
  roleName: string | null;
  permissions: string[];
};

export class AuthorizationError extends Error {
  constructor(message = "אין הרשאה לבצע פעולה זו") {
    super(message);
    this.name = "AuthorizationError";
  }
}

type ActorRow = {
  user_id: string;
  tenant_id: string;
  auth_user_id: string;
  username: string;
  full_name: string | null;
  email: string | null;
  role_id: string | null;
  role_key: string | null;
  role_name: string | null;
  tenant_name: string;
  tenant_slug: string;
};

// The final permission set of a user: role defaults ∪ personal grants − personal
// revokes (guesthub.user_permission_overrides). Every authorization check —
// requirePermission / hasPermission via getActor, and the dominance guards in the
// staff actions — resolves through this, so overrides are enforced server-side.
export async function effectivePermissionKeys(
  tenantId: string,
  userId: string,
  roleId: string | null,
): Promise<string[]> {
  const rows = await sql<{ key: string }[]>`
    SELECT p.key
    FROM guesthub.role_permissions rp
    JOIN guesthub.permissions p ON p.id = rp.permission_id
    WHERE rp.role_id = ${roleId}
    UNION
    SELECT p.key
    FROM guesthub.user_permission_overrides o
    JOIN guesthub.permissions p ON p.id = o.permission_id
    WHERE o.tenant_id = ${tenantId} AND o.user_id = ${userId} AND o.effect = 'grant'
    EXCEPT
    SELECT p.key
    FROM guesthub.user_permission_overrides o
    JOIN guesthub.permissions p ON p.id = o.permission_id
    WHERE o.tenant_id = ${tenantId} AND o.user_id = ${userId} AND o.effect = 'revoke'`;
  return rows.map((r) => r.key);
}

// Resolves the Supabase session → the guesthub user, its tenant, role and effective
// permissions (role defaults + personal overrides). Memoized per request via cache().
export const getActor = cache(async (): Promise<Actor | null> => {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [row] = await sql<ActorRow[]>`
    SELECT u.id            AS user_id,
           u.tenant_id     AS tenant_id,
           u.auth_user_id  AS auth_user_id,
           u.username      AS username,
           u.full_name     AS full_name,
           u.email         AS email,
           u.role_id       AS role_id,
           r.key           AS role_key,
           r.name          AS role_name,
           t.name          AS tenant_name,
           t.slug          AS tenant_slug
    FROM guesthub.users u
    JOIN guesthub.tenants t ON t.id = u.tenant_id
    LEFT JOIN guesthub.roles r ON r.id = u.role_id
    WHERE u.auth_user_id = ${user.id} AND u.is_active = true
    LIMIT 1`;

  if (!row) return null;

  // Always resolved (even with no role) — personal grants exist without a role too.
  const permKeys = await effectivePermissionKeys(row.tenant_id, row.user_id, row.role_id);

  return {
    userId: row.user_id,
    tenantId: row.tenant_id,
    authUserId: row.auth_user_id,
    username: row.username,
    fullName: row.full_name,
    email: row.email,
    roleKey: row.role_key ?? "",
    roleName: row.role_name,
    tenantName: row.tenant_name,
    tenantSlug: row.tenant_slug,
    permissions: new Set(permKeys),
  };
});

export function toActorContext(actor: Actor): ActorContext {
  return {
    userId: actor.userId,
    tenantId: actor.tenantId,
    username: actor.username,
    fullName: actor.fullName,
    email: actor.email,
    roleKey: actor.roleKey,
    roleName: actor.roleName,
    permissions: [...actor.permissions],
  };
}

// Non-throwing check for gating pages / passing capability flags to the client.
export function hasPermission(actor: Actor, key: string): boolean {
  return (
    actor.roleKey === "super_admin" ||
    actor.roleKey === "admin" ||
    actor.permissions.has(key)
  );
}

// Server authority check — the first line of every business Server Action.
// super_admin / admin bypass the granular permission set.
export function requirePermission(
  actor: Actor | null,
  key: string,
): asserts actor is Actor {
  if (!actor) throw new AuthorizationError("לא מחובר למערכת");
  if (actor.roleKey === "super_admin" || actor.roleKey === "admin") return;
  if (!actor.permissions.has(key)) {
    throw new AuthorizationError(`חסרה הרשאה: ${key}`);
  }
}
