// Pure, server-side authorization guards for staff/permission mutations. The Server
// Actions call these; they never rely on the UI hiding a control. Kept pure so they
// are unit-checkable (scripts/check-guards.mjs).

export type GuardActor = { userId: string; roleKey: string };
export type GuardTarget = { id: string; roleKey: string | null };
export type GuardResult = { ok: true } | { ok: false; error: string };

const ok: GuardResult = { ok: true };
const no = (error: string): GuardResult => ({ ok: false, error });

// Role ranks. `admin` and `super_admin` bypass granular permission checks
// (see requirePermission), so both managing them and assigning them must be
// restricted to actors of at least the same rank — otherwise any holder of
// staff.create/staff.update could mint or hijack a full-bypass account.
const ROLE_RANK: Record<string, number> = { super_admin: 3, admin: 2 };
const rank = (key: string | null | undefined) => ROLE_RANK[key ?? ""] ?? 1;

// An actor may act on a target only if the target does not outrank them.
export function canManageTarget(actor: GuardActor, target: GuardTarget): boolean {
  return rank(target.roleKey) <= rank(actor.roleKey);
}

const MANAGE_ERR = "אין הרשאה לנהל משתמש בדרגה גבוהה משלך";

export function canEditUser(actor: GuardActor, target: GuardTarget): GuardResult {
  if (!canManageTarget(actor, target)) return no(MANAGE_ERR);
  return ok;
}

export function canDisableUser(actor: GuardActor, target: GuardTarget): GuardResult {
  if (target.id === actor.userId) return no("לא ניתן להשבית את המשתמש שלך");
  if (!canManageTarget(actor, target)) return no(MANAGE_ERR);
  return ok;
}

// May the actor grant `newRoleKey` at all? (used by create + role change)
export function canAssignRole(actor: GuardActor, newRoleKey: string): GuardResult {
  if (rank(newRoleKey) > rank(actor.roleKey))
    return no("אין הרשאה להעניק תפקיד בדרגה גבוהה משלך");
  return ok;
}

// Changing your own role at all is blocked (covers self-demote and self-escalation).
export function canChangeRole(
  actor: GuardActor,
  target: GuardTarget,
  newRoleKey: string,
): GuardResult {
  if (target.id === actor.userId) return no("לא ניתן לשנות את התפקיד של עצמך");
  if (!canManageTarget(actor, target)) return no(MANAGE_ERR);
  return canAssignRole(actor, newRoleKey);
}

// Sensitive permission keys: holding them means controlling accounts/permissions.
// An actor may not control (create with a chosen password, reset the password of,
// or assign) an account whose role holds a sensitive permission the actor lacks —
// otherwise staff.update alone becomes a lateral takeover of e.g. permissions.update.
const SENSITIVE_KEYS = [
  "permissions.update",
  "staff.create",
  "staff.update",
  "staff.disable",
];

export function canControlRole(
  actorRoleKey: string,
  actorPermissionKeys: readonly string[],
  targetRolePermissionKeys: readonly string[],
): GuardResult {
  if (PROTECTED_ROLE_KEYS.includes(actorRoleKey)) return ok;
  const actorSet = new Set(actorPermissionKeys);
  const missing = SENSITIVE_KEYS.filter(
    (k) => targetRolePermissionKeys.includes(k) && !actorSet.has(k),
  );
  if (missing.length > 0)
    return no("אין הרשאה לשלוט בחשבון עם הרשאות רגישות שאינן ברשותך");
  return ok;
}

// Role columns that bypass permission checks and are therefore read-only in the matrix.
export const PROTECTED_ROLE_KEYS = ["super_admin", "admin"];
const CRITICAL_SELF_KEYS = ["permissions.view", "permissions.update"];

// ---- per-user permission overrides (guesthub.user_permission_overrides) ----

// Sensitive areas (staff/users management, roles/permissions, settings, audit):
// personally granting one of these requires the actor to hold it themselves —
// otherwise permissions.update alone lets an actor mint capabilities beyond its own.
const SENSITIVE_PREFIXES = ["staff.", "permissions.", "roles.", "users.", "settings.", "lookups.", "audit."];

export function isSensitivePermission(key: string): boolean {
  return SENSITIVE_PREFIXES.some((p) => key.startsWith(p));
}

// Batch-level gate for editing a user's personal overrides. Callers must ALSO
// hold permissions.update (requirePermission) and pass the canControlRole
// dominance check against the target's current EFFECTIVE permission set.
export function canManageUserOverrides(
  actor: GuardActor,
  target: GuardTarget,
): GuardResult {
  // Self-service escalation/lockout — blocked entirely, like self role-change.
  if (target.id === actor.userId) return no("לא ניתן לערוך הרשאות אישיות של עצמך");
  // Full-access roles bypass permission checks — overrides would be dead rows.
  if (PROTECTED_ROLE_KEYS.includes(target.roleKey ?? ""))
    return no("תפקיד עם גישה מלאה — אין הרשאות אישיות");
  if (!canManageTarget(actor, target)) return no(MANAGE_ERR);
  return ok;
}

// Per-key gate for a grant override that adds effective access.
export function canGrantOverride(
  actorRoleKey: string,
  actorPermissionKeys: readonly string[],
  permissionKey: string,
): GuardResult {
  if (PROTECTED_ROLE_KEYS.includes(actorRoleKey)) return ok;
  if (isSensitivePermission(permissionKey) && !actorPermissionKeys.includes(permissionKey))
    return no("אין הרשאה להעניק הרשאה רגישה שאינה ברשותך");
  return ok;
}

// ---- channel-manager management — Phase 3 locked decision ----
// ONLY super_admin may touch connections, credentials, mappings, sync or
// webhook configuration. admin does NOT qualify (unlike requirePermission's
// generic bypass) — integration secrets outrank ordinary full access.
export function canManageChannels(actor: GuardActor): GuardResult {
  if (actor.roleKey === "super_admin") return ok;
  return no("ניהול חיבורי ערוצים זמין למנהל-על בלבד");
}

// ---- messaging providers (Gmail / GREEN-API / Twilio) — D53 ----
// Same posture as channel connections: provider CREDENTIALS are integration
// secrets and outrank ordinary full access, so ONLY super_admin may view or
// modify them (admin does NOT qualify).
export function canManageMessaging(actor: GuardActor): GuardResult {
  if (actor.roleKey === "super_admin") return ok;
  return no("ניהול ספקי תקשורת זמין למנהל-על בלבד");
}

export function canTogglePermission(
  actor: GuardActor,
  targetRoleKey: string,
  permissionKey: string,
  granted: boolean,
): GuardResult {
  if (PROTECTED_ROLE_KEYS.includes(targetRoleKey))
    return no("תפקיד עם גישה מלאה — לקריאה בלבד");
  // Prevent locking yourself out of the permissions screen.
  if (targetRoleKey === actor.roleKey && !granted && CRITICAL_SELF_KEYS.includes(permissionKey))
    return no("לא ניתן להסיר את הגישה שלך למסך ההרשאות");
  return ok;
}
