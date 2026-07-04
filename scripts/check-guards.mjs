// Runnable check for the pure authorization guards (src/lib/auth/guards.ts).
// Compiles the single file with tsc, imports it, and asserts the security rules.
// Usage: node scripts/check-guards.mjs
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const out = mkdtempSync(join(tmpdir(), "guards-"));
execSync(
  `pnpm exec tsc src/lib/auth/guards.ts --outDir ${out} --module esnext --target es2022 --moduleResolution bundler --skipLibCheck`,
  { stdio: "inherit" },
);
const g = await import(join(out, "guards.js"));

const su = { userId: "u-su", roleKey: "super_admin" };
const admin = { userId: "u-ad", roleKey: "admin" };
const manager = { userId: "u-mg", roleKey: "manager" };
const tSu = { id: "t-su", roleKey: "super_admin" };
const tAdmin = { id: "t-ad", roleKey: "admin" };
const tStaff = { id: "t-st", roleKey: "staff" };

// -- manage rank: a target must not outrank the actor --
assert.equal(g.canManageTarget(manager, tStaff), true);
assert.equal(g.canManageTarget(manager, tAdmin), false, "manager must not manage admin");
assert.equal(g.canManageTarget(manager, tSu), false);
assert.equal(g.canManageTarget(admin, tAdmin), true);
assert.equal(g.canManageTarget(admin, tSu), false, "admin must not manage super_admin");
assert.equal(g.canManageTarget(su, tSu), true);

// -- edit / disable inherit the rank rule; self-disable blocked --
assert.equal(g.canEditUser(manager, tAdmin).ok, false);
assert.equal(g.canDisableUser(manager, { id: "u-mg", roleKey: "manager" }).ok, false, "self-disable");
assert.equal(g.canDisableUser(admin, tStaff).ok, true);
assert.equal(g.canDisableUser(manager, tAdmin).ok, false, "manager must not disable admin");

// -- role assignment: cannot grant a rank above your own --
assert.equal(g.canAssignRole(manager, "admin").ok, false, "manager must not assign admin");
assert.equal(g.canAssignRole(manager, "super_admin").ok, false);
assert.equal(g.canAssignRole(manager, "receptionist").ok, true);
assert.equal(g.canAssignRole(admin, "admin").ok, true);
assert.equal(g.canAssignRole(admin, "super_admin").ok, false, "admin must not assign super_admin");
assert.equal(g.canAssignRole(su, "super_admin").ok, true);

// -- role change: self blocked entirely; rank enforced on target and new role --
assert.equal(g.canChangeRole(manager, { id: "u-mg", roleKey: "manager" }, "staff").ok, false, "self role-change");
assert.equal(g.canChangeRole(manager, tStaff, "admin").ok, false, "manager must not promote to admin");
assert.equal(g.canChangeRole(admin, tStaff, "admin").ok, true);
assert.equal(g.canChangeRole(admin, tSu, "staff").ok, false, "admin must not demote super_admin");

// -- dominance: cannot control an account whose role holds sensitive perms you lack --
const RECEPTION_PERMS = ["staff.update"]; // attacker: staff.update only
const MANAGER_PERMS = ["staff.view", "staff.create", "staff.update", "staff.disable", "permissions.view", "permissions.update"];
assert.equal(
  g.canControlRole("receptionist", RECEPTION_PERMS, MANAGER_PERMS).ok,
  false,
  "staff.update holder must not control a permissions.update role",
);
assert.equal(g.canControlRole("manager", MANAGER_PERMS, MANAGER_PERMS).ok, true, "equal sets OK");
assert.equal(g.canControlRole("manager", MANAGER_PERMS, ["housekeeping.view"]).ok, true);
assert.equal(g.canControlRole("admin", [], MANAGER_PERMS).ok, true, "admin bypasses dominance");
assert.equal(
  g.canControlRole("receptionist", RECEPTION_PERMS, ["staff.disable"]).ok,
  false,
  "missing staff.disable blocks control",
);

// -- per-user overrides: batch gate --
assert.equal(g.canManageUserOverrides(manager, tStaff).ok, true);
assert.equal(g.canManageUserOverrides(manager, { id: "u-mg", roleKey: "manager" }).ok, false, "self-overrides blocked");
assert.equal(g.canManageUserOverrides(manager, tAdmin).ok, false, "protected role has no overrides");
assert.equal(g.canManageUserOverrides(su, tSu).ok, false, "even su: full-access roles have no overrides");
assert.equal(g.canManageUserOverrides(manager, { id: "t-x", roleKey: null }).ok, true, "role-less target manageable");

// -- per-user overrides: sensitive grants require holding the key yourself --
assert.equal(g.isSensitivePermission("permissions.update"), true);
assert.equal(g.isSensitivePermission("settings.edit"), true);
assert.equal(g.isSensitivePermission("audit.view"), true);
assert.equal(g.isSensitivePermission("reports.view"), false);
assert.equal(
  g.canGrantOverride("manager", MANAGER_PERMS, "settings.edit").ok,
  false,
  "cannot grant a sensitive key you do not hold",
);
assert.equal(g.canGrantOverride("manager", MANAGER_PERMS, "staff.view").ok, true, "held sensitive key OK");
assert.equal(g.canGrantOverride("manager", MANAGER_PERMS, "reports.view").ok, true, "non-sensitive OK");
assert.equal(g.canGrantOverride("super_admin", [], "settings.edit").ok, true, "protected actor bypasses");

// -- permission matrix guards --
assert.equal(g.canTogglePermission(manager, "admin", "staff.view", true).ok, false, "protected column");
assert.equal(g.canTogglePermission(manager, "super_admin", "staff.view", false).ok, false);
assert.equal(g.canTogglePermission(manager, "manager", "permissions.update", false).ok, false, "self lockout");
assert.equal(g.canTogglePermission(manager, "manager", "permissions.update", true).ok, true);
assert.equal(g.canTogglePermission(manager, "receptionist", "staff.view", true).ok, true);

// -- channel management: super_admin ONLY, admin does not qualify (Phase 3) --
assert.equal(g.canManageChannels(su).ok, true, "super_admin manages channels");
assert.equal(g.canManageChannels(admin).ok, false, "admin must NOT manage channels");
assert.equal(g.canManageChannels(manager).ok, false);
assert.equal(g.canManageChannels({ userId: "u-r", roleKey: "receptionist" }).ok, false);
assert.equal(g.canManageChannels({ userId: "u-s", roleKey: "staff" }).ok, false);
assert.equal(g.canManageChannels({ userId: "u-c", roleKey: "cleaner" }).ok, false);

console.log("check-guards: all assertions passed");
