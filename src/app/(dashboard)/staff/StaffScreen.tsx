"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryState, parseAsString } from "nuqs";
import { Icon } from "@/components/shared/Icon";
import { StaffTable } from "./StaffTable";
import { EmployeeSidePanel } from "./EmployeeSidePanel";
import type {
  StaffUser,
  RoleOption,
  RolePermissionsMap,
  PermissionDef,
  OverridesByUser,
} from "./types";

type PanelState = { mode: "create" } | { mode: "edit"; user: StaffUser } | null;

const STATUS_OPTIONS = [
  { value: "all", label: "הכל" },
  { value: "active", label: "פעיל" },
  { value: "disabled", label: "מושבת" },
] as const;

export function StaffScreen({
  users,
  roles,
  rolePermissions,
  permissionCatalog,
  overridesByUser,
  currentUserId,
  actorRoleKey,
  canCreate,
  canUpdate,
  canDisable,
  canViewPermissions,
  canManageOverrides,
}: {
  users: StaffUser[];
  roles: RoleOption[];
  rolePermissions: RolePermissionsMap;
  permissionCatalog: PermissionDef[];
  overridesByUser: OverridesByUser;
  currentUserId: string;
  actorRoleKey: string;
  canCreate: boolean;
  canUpdate: boolean;
  canDisable: boolean;
  canViewPermissions: boolean;
  canManageOverrides: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useQueryState("q", parseAsString.withDefault(""));
  const [role, setRole] = useQueryState("role", parseAsString.withDefault("all"));
  // Reference default: the "פעיל" status filter is pre-selected.
  const [status, setStatus] = useQueryState("status", parseAsString.withDefault("active"));
  const [panel, setPanel] = useState<PanelState>(null);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const termDigits = term.replace(/\D/g, "");
    return users.filter((u) => {
      if (role !== "all" && u.role_key !== role) return false;
      if (status === "active" && !u.is_active) return false;
      if (status === "disabled" && u.is_active) return false;
      if (term) {
        const hay = [u.full_name, u.username, u.email, u.phone]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        // phones are stored formatted (050-...); match digits-only queries too
        const phoneDigits = (u.phone ?? "").replace(/\D/g, "");
        const hit =
          hay.includes(term) ||
          (termDigits.length >= 3 && phoneDigits.includes(termDigits));
        if (!hit) return false;
      }
      return true;
    });
  }, [users, q, role, status]);

  // Only roles the actor could ever assign appear in the panel; the filter pills
  // show every role that exists (filtering is read-only).
  return (
    <div className="p-6 lg:p-8">
      {/* header: title + count (start) · search + add (end) */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-extrabold text-ink">עובדים</h1>
          <span className="rounded-full bg-primary-050 px-3 py-1 text-sm font-semibold text-primary">
            {users.length} עובדים
          </span>
        </div>
        <div className="ms-auto flex flex-wrap items-center gap-3">
          <div className="relative w-full sm:w-[320px]">
            <Icon
              name="search"
              size={18}
              className="pointer-events-none absolute start-0 top-1/2 ms-3 -translate-y-1/2 text-faint"
            />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="חיפוש לפי שם, אימייל או טלפון…"
              className="field h-11 min-h-0 ps-11 pe-4 text-sm"
              aria-label="חיפוש עובדים"
            />
          </div>
          {canCreate ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setPanel({ mode: "create" })}
            >
              <Icon name="user-plus" size={18} />
              הוסף עובד
            </button>
          ) : null}
        </div>
      </div>

      {/* filter pills: role · status */}
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <PillGroup
          label="תפקיד:"
          value={role}
          onChange={setRole}
          options={[
            { value: "all", label: "הכל" },
            ...roles.map((r) => ({ value: r.key, label: r.name })),
          ]}
        />
        <span className="hidden h-6 w-px bg-line sm:block" aria-hidden />
        <PillGroup
          label="סטטוס:"
          value={status}
          onChange={setStatus}
          options={[...STATUS_OPTIONS]}
        />
      </div>

      <StaffTable
        users={filtered}
        totalCount={users.length}
        canUpdate={canUpdate}
        onEdit={(u) => setPanel({ mode: "edit", user: u })}
      />

      <EmployeeSidePanel
        open={panel !== null}
        mode={panel?.mode ?? "create"}
        user={panel?.mode === "edit" ? panel.user : undefined}
        roles={roles}
        rolePermissions={rolePermissions}
        permissionCatalog={permissionCatalog}
        overrides={
          panel?.mode === "edit" ? (overridesByUser[panel.user.id] ?? []) : []
        }
        currentUserId={currentUserId}
        actorRoleKey={actorRoleKey}
        canDisable={canDisable}
        canViewPermissions={canViewPermissions}
        canManageOverrides={canManageOverrides}
        onClose={() => setPanel(null)}
        onSaved={() => {
          setPanel(null);
          router.refresh();
        }}
      />
    </div>
  );
}

function PillGroup({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-medium text-muted">{label}</span>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={`h-11 rounded-xl border px-4 text-sm font-medium transition-colors ${
              active
                ? "border-primary bg-primary text-white"
                : "border-line bg-surface text-text2 hover:bg-hover"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
