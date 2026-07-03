"use server";

import { revalidatePath } from "next/cache";
import {
  getActor,
  requirePermission,
  effectivePermissionKeys,
  AuthorizationError,
} from "@/lib/auth/actor";
import { sql } from "@/lib/db";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit";
import {
  canEditUser,
  canDisableUser,
  canChangeRole,
  canAssignRole,
  canControlRole,
  canManageUserOverrides,
  canGrantOverride,
} from "@/lib/auth/guards";
import {
  createUserSchema,
  updateUserSchema,
  setActiveSchema,
  saveOverridesSchema,
} from "@/lib/validation/user";
import type { ActionResult } from "./types";

const BAN_DURATION = "876000h"; // ~100y — effectively disabled at the auth layer

const fail = (error: string): ActionResult => ({ success: false, error });

type TargetRow = {
  id: string;
  auth_user_id: string | null;
  role_id: string | null;
  role_key: string | null;
  username: string;
  email: string | null;
  is_active: boolean;
};

async function loadTarget(tenantId: string, id: string): Promise<TargetRow | null> {
  const [row] = await sql<TargetRow[]>`
    SELECT u.id, u.auth_user_id, u.role_id, r.key AS role_key,
           u.username, u.email, u.is_active
    FROM guesthub.users u
    LEFT JOIN guesthub.roles r ON r.id = u.role_id
    WHERE u.id = ${id} AND u.tenant_id = ${tenantId}
    LIMIT 1`;
  return row ?? null;
}

async function roleKeyById(tenantId: string, roleId: string): Promise<string | null> {
  const [r] = await sql<{ key: string }[]>`
    SELECT key FROM guesthub.roles WHERE id = ${roleId} AND tenant_id = ${tenantId} LIMIT 1`;
  return r?.key ?? null;
}

async function rolePermissionKeys(tenantId: string, roleId: string): Promise<string[]> {
  const rows = await sql<{ key: string }[]>`
    SELECT p.key
    FROM guesthub.role_permissions rp
    JOIN guesthub.roles r ON r.id = rp.role_id
    JOIN guesthub.permissions p ON p.id = rp.permission_id
    WHERE rp.role_id = ${roleId} AND r.tenant_id = ${tenantId}`;
  return rows.map((r) => r.key);
}

// Dominance guard (review fix): an actor may not control an account whose role
// holds sensitive permissions the actor itself lacks.
async function assertControlsRole(
  actor: { tenantId: string; roleKey: string; permissions: Set<string> },
  roleId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const guard = canControlRole(
    actor.roleKey,
    [...actor.permissions],
    await rolePermissionKeys(actor.tenantId, roleId),
  );
  return guard;
}

// Same dominance rule, but against a specific user's EFFECTIVE set (role defaults
// + personal overrides) — a personal grant of a sensitive key must protect the
// account exactly like the role-level key does.
async function assertControlsUser(
  actor: { tenantId: string; roleKey: string; permissions: Set<string> },
  target: { id: string; role_id: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  return canControlRole(
    actor.roleKey,
    [...actor.permissions],
    await effectivePermissionKeys(actor.tenantId, target.id, target.role_id),
  );
}

// Derive a unique tenant-scoped username from the email local part (used when the
// username+password login method is off — see DECISIONS D21).
async function deriveUsername(tenantId: string, email: string): Promise<string> {
  const base =
    email
      .split("@")[0]
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "")
      .slice(0, 40) || "user";
  const padded = base.length >= 3 ? base : `${base}123`.slice(0, 3);
  const taken = new Set(
    (
      await sql<{ username: string }[]>`
        SELECT username FROM guesthub.users
        WHERE tenant_id = ${tenantId} AND username LIKE ${padded + "%"}`
    ).map((r) => r.username.toLowerCase()),
  );
  if (!taken.has(padded)) return padded;
  for (let i = 2; i < 100; i++) {
    if (!taken.has(`${padded}${i}`)) return `${padded}${i}`;
  }
  return `${padded}${Date.now() % 100000}`;
}

// ---------- CREATE ----------
export async function createUserAction(input: unknown): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "staff.create");

    const parsed = createUserSchema.safeParse(input);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "קלט לא תקין");
    const data = parsed.data;

    const newRoleKey = await roleKeyById(actor.tenantId, data.role_id);
    if (!newRoleKey) return fail("תפקיד לא תקין");
    const assignGuard = canAssignRole(
      { userId: actor.userId, roleKey: actor.roleKey },
      newRoleKey,
    );
    if (!assignGuard.ok) return fail(assignGuard.error);
    // a minted account is under the creator's control — dominance rule applies
    const controlGuard = await assertControlsRole(actor, data.role_id);
    if (!controlGuard.ok) return fail(controlGuard.error);

    const username = data.enable_userpass
      ? data.username!.trim()
      : await deriveUsername(actor.tenantId, data.email);

    const [dupUser] = await sql`
      SELECT 1 FROM guesthub.users
      WHERE tenant_id = ${actor.tenantId} AND lower(username) = lower(${username})`;
    if (dupUser) return fail("שם המשתמש כבר קיים");
    const [dupEmail] = await sql`
      SELECT 1 FROM guesthub.users
      WHERE tenant_id = ${actor.tenantId} AND lower(email) = lower(${data.email})`;
    if (dupEmail) return fail("האימייל כבר קיים");

    // 1) create the GoTrue auth user. Without the username+password method no
    //    password is set — the identity exists but cannot password-login.
    const admin = createSupabaseAdminClient();
    const { data: created, error: authErr } = await admin.auth.admin.createUser({
      email: data.email,
      ...(data.enable_userpass ? { password: data.password } : {}),
      email_confirm: true,
      user_metadata: { full_name: data.full_name },
    });
    // Neutral, Hebrew failure — the raw GoTrue message would act as a cross-tenant
    // email-existence oracle (auth emails are global on the shared instance).
    if (authErr || !created?.user) return fail("לא ניתן ליצור משתמש עם אימייל זה");
    const authUserId = created.user.id;

    // 2) insert the linked guesthub row; on failure, delete the orphaned auth user
    let newId: string;
    try {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO guesthub.users
          (tenant_id, auth_user_id, username, full_name, email, phone,
           role_id, allow_google_auth, is_active)
        VALUES (${actor.tenantId}, ${authUserId}, ${username}, ${data.full_name},
                ${data.email}, ${data.phone}, ${data.role_id},
                ${data.allow_google_auth}, ${data.is_active})
        RETURNING id`;
      newId = row.id;
    } catch {
      await admin.auth.admin.deleteUser(authUserId).catch(() => {});
      return fail("שמירת המשתמש נכשלה");
    }

    // created disabled → ban immediately so no session can be established
    if (!data.is_active)
      await admin.auth.admin
        .updateUserById(authUserId, { ban_duration: BAN_DURATION })
        .catch(() => {});

    await writeAudit(actor, {
      entityType: "user",
      entityId: newId,
      action: "create",
      after: {
        username,
        email: data.email,
        role_id: data.role_id,
        is_active: data.is_active,
        allow_google_auth: data.allow_google_auth,
        userpass_login: data.enable_userpass,
      },
    });

    revalidatePath("/staff");
    return { success: true };
  } catch (e) {
    if (e instanceof AuthorizationError) return fail(e.message);
    return fail("שגיאת שרת");
  }
}

// ---------- UPDATE (profile + optional password reset + active + google flag) ----------
export async function updateUserAction(input: unknown): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "staff.update");

    const parsed = updateUserSchema.safeParse(input);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "קלט לא תקין");
    const data = parsed.data;

    const target = await loadTarget(actor.tenantId, data.id);
    if (!target) return fail("המשתמש לא נמצא");
    const gTarget = { id: target.id, roleKey: target.role_key };

    const editable = canEditUser(actor, gTarget);
    if (!editable.ok) return fail(editable.error);

    const newRoleKey = await roleKeyById(actor.tenantId, data.role_id);
    if (!newRoleKey) return fail("תפקיד לא תקין");

    // role change guard (blocks self-change and any above-rank assignment);
    // dominance against both the NEW role and the target's current effective set
    // (personal grants of sensitive keys protect the account like role keys do)
    if (data.role_id !== target.role_id) {
      const roleGuard = canChangeRole(actor, gTarget, newRoleKey);
      if (!roleGuard.ok) return fail(roleGuard.error);
      const controlGuard = await assertControlsRole(actor, data.role_id);
      if (!controlGuard.ok) return fail(controlGuard.error);
      const currentGuard = await assertControlsUser(actor, target);
      if (!currentGuard.ok) return fail(currentGuard.error);
    }

    // password reset = taking control of the target account — dominance rule
    // against the target's CURRENT effective set (review fix: lateral takeover).
    if (data.new_password) {
      const controlGuard = await assertControlsUser(actor, target);
      if (!controlGuard.ok) return fail(controlGuard.error);
    }

    // active-state change is a disable-level operation — requires staff.disable
    // in BOTH directions, exactly like setUserActiveAction.
    if (data.is_active !== target.is_active) {
      requirePermission(actor, "staff.disable");
      if (!data.is_active) {
        const disableGuard = canDisableUser(actor, gTarget);
        if (!disableGuard.ok) return fail(disableGuard.error);
      }
    }

    // tenant-scoped uniqueness excluding self
    const [dupUser] = await sql`
      SELECT 1 FROM guesthub.users
      WHERE tenant_id = ${actor.tenantId} AND id <> ${data.id}
        AND lower(username) = lower(${data.username})`;
    if (dupUser) return fail("שם המשתמש כבר קיים");
    const [dupEmail] = await sql`
      SELECT 1 FROM guesthub.users
      WHERE tenant_id = ${actor.tenantId} AND id <> ${data.id}
        AND lower(email) = lower(${data.email})`;
    if (dupEmail) return fail("האימייל כבר קיים");

    // Auth-layer sync runs FIRST and fails loudly (review fix): committing the
    // guesthub row before a failed GoTrue update silently diverged the displayed
    // email/password from the real login identity while reporting success.
    const admin = createSupabaseAdminClient();
    const emailChanged =
      !!target.auth_user_id &&
      data.email.toLowerCase() !== (target.email ?? "").toLowerCase();
    if (target.auth_user_id) {
      if (emailChanged) {
        const { error } = await admin.auth.admin.updateUserById(target.auth_user_id, {
          email: data.email,
          email_confirm: true,
        });
        if (error) return fail("עדכון האימייל נכשל — ייתכן שהאימייל כבר בשימוש");
      }
      if (data.new_password && data.new_password.length >= 8) {
        const { error } = await admin.auth.admin.updateUserById(target.auth_user_id, {
          password: data.new_password,
        });
        if (error) {
          // undo the email change so auth and DB stay consistent
          if (emailChanged)
            await admin.auth.admin
              .updateUserById(target.auth_user_id, {
                email: target.email ?? undefined,
                email_confirm: true,
              })
              .catch(() => {});
          return fail("איפוס הסיסמה נכשל");
        }
      }
    }

    try {
      await sql`
        UPDATE guesthub.users SET
          full_name = ${data.full_name},
          username = ${data.username},
          email = ${data.email},
          phone = ${data.phone || null},
          role_id = ${data.role_id},
          allow_google_auth = ${data.allow_google_auth},
          is_active = ${data.is_active}
        WHERE id = ${data.id} AND tenant_id = ${actor.tenantId}`;
    } catch {
      // roll the auth email back so the two layers cannot diverge
      if (emailChanged && target.auth_user_id)
        await admin.auth.admin
          .updateUserById(target.auth_user_id, {
            email: target.email ?? undefined,
            email_confirm: true,
          })
          .catch(() => {});
      return fail("שמירת המשתמש נכשלה");
    }

    // Role changed → drop personal overrides made redundant by the new role:
    // a grant the new role already includes, or a revoke of a key the new role
    // doesn't grant anyway. Overrides that still change the final result stay.
    if (data.role_id !== target.role_id) {
      const cleaned = await sql<{ key: string; effect: string }[]>`
        DELETE FROM guesthub.user_permission_overrides o
        USING guesthub.permissions p
        WHERE p.id = o.permission_id
          AND o.tenant_id = ${actor.tenantId} AND o.user_id = ${data.id}
          AND (
            (o.effect = 'grant' AND EXISTS (
              SELECT 1 FROM guesthub.role_permissions rp
              WHERE rp.role_id = ${data.role_id} AND rp.permission_id = o.permission_id))
            OR
            (o.effect = 'revoke' AND NOT EXISTS (
              SELECT 1 FROM guesthub.role_permissions rp
              WHERE rp.role_id = ${data.role_id} AND rp.permission_id = o.permission_id))
          )
        RETURNING p.key, o.effect`;
      if (cleaned.length > 0)
        await writeAudit(actor, {
          entityType: "user_permission_override",
          entityId: data.id,
          action: "override_cleanup",
          before: { overrides: cleaned.map((c) => ({ permission: c.key, effect: c.effect })) },
          after: { reason: "role_change", role_id: data.role_id },
        });
    }

    // Ban/unban stays best-effort: getActor's is_active=true filter is the hard
    // backstop (D17), so a transient failure here cannot re-admit a disabled user.
    if (target.auth_user_id && data.is_active !== target.is_active)
      await admin.auth.admin
        .updateUserById(target.auth_user_id, {
          ban_duration: data.is_active ? "none" : BAN_DURATION,
        })
        .catch(() => {});

    await writeAudit(actor, {
      entityType: "user",
      entityId: data.id,
      action: "update",
      before: {
        username: target.username,
        email: target.email,
        role_id: target.role_id,
        is_active: target.is_active,
      },
      after: {
        username: data.username,
        email: data.email,
        role_id: data.role_id,
        is_active: data.is_active,
        password_reset: Boolean(data.new_password),
      },
    });

    revalidatePath("/staff");
    return { success: true };
  } catch (e) {
    if (e instanceof AuthorizationError) return fail(e.message);
    return fail("שגיאת שרת");
  }
}

// ---------- PER-USER PERMISSION OVERRIDES ----------
// Receives the desired effective matrix (full vector of {key, checked}) and makes
// guesthub.user_permission_overrides match it: checked===role default ⇒ no row,
// extra ⇒ 'grant' row, missing ⇒ 'revoke' row. Guards run only on entries that
// actually change effective access; pure row normalization needs none.
export async function saveUserPermissionOverridesAction(
  input: unknown,
): Promise<ActionResult> {
  try {
    const actor = await getActor();
    // strongest existing permission governing permission management (see /permissions)
    requirePermission(actor, "permissions.update");

    const parsed = saveOverridesSchema.safeParse(input);
    if (!parsed.success) return fail("קלט לא תקין");
    const { user_id, entries } = parsed.data;

    const target = await loadTarget(actor.tenantId, user_id);
    if (!target) return fail("המשתמש לא נמצא");

    // batch gates: no self-editing, no full-access roles, rank dominance
    const gate = canManageUserOverrides(actor, { id: target.id, roleKey: target.role_key });
    if (!gate.ok) return fail(gate.error);
    // sensitive-account takeover guard vs the target's current effective set
    const domGuard = await assertControlsUser(actor, target);
    if (!domGuard.ok) return fail(domGuard.error);

    // desired state per key (last entry wins), resolved against the real catalog
    const desired = new Map<string, boolean>();
    for (const e of entries) desired.set(e.key, e.checked);
    const keys = [...desired.keys()];
    if (keys.length === 0) return { success: true };
    const catalog = await sql<{ id: string; key: string }[]>`
      SELECT id, key FROM guesthub.permissions WHERE key IN ${sql(keys)}`;
    if (catalog.length !== keys.length) return fail("הרשאה לא תקינה");

    const roleKeys = new Set(
      target.role_id ? await rolePermissionKeys(actor.tenantId, target.role_id) : [],
    );
    const existing = await sql<{ permission_id: string; effect: "grant" | "revoke" }[]>`
      SELECT permission_id, effect FROM guesthub.user_permission_overrides
      WHERE tenant_id = ${actor.tenantId} AND user_id = ${target.id}`;
    const existingEffect = new Map(existing.map((r) => [r.permission_id, r.effect]));

    type Op = {
      pid: string;
      key: string;
      prev: "grant" | "revoke" | null;
      next: "grant" | "revoke" | null;
      effectiveBefore: boolean;
      effectiveAfter: boolean;
    };
    const ops: Op[] = [];
    for (const { id: pid, key } of catalog) {
      const base = roleKeys.has(key);
      const prev = existingEffect.get(pid) ?? null;
      const effectiveBefore = prev === "grant" ? true : prev === "revoke" ? false : base;
      const want = desired.get(key)!;
      const next: Op["next"] = want === base ? null : want ? "grant" : "revoke";
      if (next === prev) continue;
      // adds effective access the target didn't have → sensitive-grant rule
      if (want && !effectiveBefore) {
        const g = canGrantOverride(actor.roleKey, [...actor.permissions], key);
        if (!g.ok) return fail(`${g.error} (${key})`);
      }
      ops.push({ pid, key, prev, next, effectiveBefore, effectiveAfter: want });
    }
    if (ops.length === 0) return { success: true };

    // one transaction — override rows and their audit trail commit together
    await sql.begin(async (tx) => {
      for (const op of ops) {
        if (op.next === null) {
          await tx`
            DELETE FROM guesthub.user_permission_overrides
            WHERE tenant_id = ${actor.tenantId} AND user_id = ${target.id}
              AND permission_id = ${op.pid}`;
        } else {
          await tx`
            INSERT INTO guesthub.user_permission_overrides
              (tenant_id, user_id, permission_id, effect, created_by, updated_by)
            VALUES (${actor.tenantId}, ${target.id}, ${op.pid}, ${op.next},
                    ${actor.userId}, ${actor.userId})
            ON CONFLICT (tenant_id, user_id, permission_id)
            DO UPDATE SET effect = EXCLUDED.effect, updated_by = EXCLUDED.updated_by`;
        }
        await writeAudit(
          actor,
          {
            entityType: "user_permission_override",
            entityId: target.id,
            action:
              op.next === null
                ? "override_clear"
                : op.next === "grant"
                  ? "override_grant"
                  : "override_revoke",
            before: { permission: op.key, effect: op.prev, effective: op.effectiveBefore },
            after: { permission: op.key, effect: op.next, effective: op.effectiveAfter },
          },
          tx,
        );
      }
    });

    revalidatePath("/staff");
    return { success: true };
  } catch (e) {
    if (e instanceof AuthorizationError) return fail(e.message);
    return fail("שגיאת שרת");
  }
}

// ---------- DISABLE / ENABLE ----------
export async function setUserActiveAction(input: unknown): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "staff.disable");

    const parsed = setActiveSchema.safeParse(input);
    if (!parsed.success) return fail("קלט לא תקין");
    const { id, is_active } = parsed.data;

    const target = await loadTarget(actor.tenantId, id);
    if (!target) return fail("המשתמש לא נמצא");
    const gTarget = { id: target.id, roleKey: target.role_key };

    if (!is_active) {
      const guard = canDisableUser(actor, gTarget);
      if (!guard.ok) return fail(guard.error);
    } else {
      const guard = canEditUser(actor, gTarget);
      if (!guard.ok) return fail(guard.error);
    }

    await sql`
      UPDATE guesthub.users SET is_active = ${is_active}
      WHERE id = ${id} AND tenant_id = ${actor.tenantId}`;

    // Kill/restore the auth session so a disabled user's session dies next request.
    if (target.auth_user_id) {
      const admin = createSupabaseAdminClient();
      await admin.auth.admin
        .updateUserById(target.auth_user_id, {
          ban_duration: is_active ? "none" : BAN_DURATION,
        })
        .catch(() => {});
    }

    await writeAudit(actor, {
      entityType: "user",
      entityId: id,
      action: is_active ? "enable" : "disable",
      before: { is_active: target.is_active },
      after: { is_active },
    });

    revalidatePath("/staff");
    return { success: true };
  } catch (e) {
    if (e instanceof AuthorizationError) return fail(e.message);
    return fail("שגיאת שרת");
  }
}
