export type PermissionActor = {
  roleKey: string;
  permissions: Set<string>;
};

export class AuthorizationError extends Error {
  constructor(message = "אין הרשאה לבצע פעולה זו") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export function hasPermission(actor: PermissionActor, key: string): boolean {
  return (
    actor.roleKey === "super_admin" ||
    actor.roleKey === "admin" ||
    actor.permissions.has(key)
  );
}

export function requirePermission<T extends PermissionActor>(
  actor: T | null,
  key: string,
): asserts actor is T {
  if (!actor) throw new AuthorizationError("לא מחובר למערכת");
  if (!hasPermission(actor, key)) throw new AuthorizationError(`חסרה הרשאה: ${key}`);
}
