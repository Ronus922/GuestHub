export type StaffUser = {
  id: string;
  full_name: string | null;
  username: string;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  allow_google_auth: boolean;
  role_id: string | null;
  role_key: string | null;
  role_name: string | null;
  created_at: string;
  // newest guesthub.audit_logs row authored by this user. NOT auth.users —
  // RLS is on there with zero policies, so guesthub_app reads it as empty and
  // every last_sign_in_at came back NULL ("לא התחבר" for everyone, always).
  // This is last ACTIVITY: browsing alone writes no audit row.
  last_seen_at: string | null;
};

export type RoleOption = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  is_system: boolean;
};

// role_id → effective permissions inherited from the role (real role_permissions rows)
export type RolePermission = { key: string; label: string; category: string | null };
export type RolePermissionsMap = Record<string, RolePermission[]>;

// full guesthub.permissions catalog — rows of the per-module effective matrix
export type PermissionDef = { key: string; label: string; category: string | null };

// personal override rows (guesthub.user_permission_overrides), grouped by user:
// 'grant' adds a permission the role lacks, 'revoke' removes one the role includes
export type UserOverride = { key: string; effect: "grant" | "revoke" };
export type OverridesByUser = Record<string, UserOverride[]>;

export type ActionResult = { success: boolean; error?: string };
