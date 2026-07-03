"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { setRolePermissionAction } from "./actions";
import type { Role, Permission, Grant } from "./types";

import { CATEGORY_LABEL, categoryIndex } from "./categories";

const PROTECTED = new Set(["super_admin", "admin"]);

export function PermissionsMatrix({
  roles,
  permissions,
  grants,
  canUpdate,
}: {
  roles: Role[];
  permissions: Permission[];
  grants: Grant[];
  canUpdate: boolean;
}) {
  const [granted, setGranted] = useState<Set<string>>(
    () => new Set(grants.map((g) => `${g.role_id}:${g.permission_id}`)),
  );
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [, startTransition] = useTransition();

  const groups = useMemo(() => {
    const byCat = new Map<string, Permission[]>();
    for (const p of permissions) {
      const cat = p.category ?? "אחר";
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat)!.push(p);
    }
    return [...byCat.entries()].sort(
      (a, b) => categoryIndex(a[0]) - categoryIndex(b[0]),
    );
  }, [permissions]);

  function toggle(role: Role, perm: Permission, next: boolean) {
    const key = `${role.id}:${perm.id}`;
    setGranted((prev) => {
      const s = new Set(prev);
      if (next) s.add(key);
      else s.delete(key);
      return s;
    });
    setPending((prev) => new Set(prev).add(key));
    startTransition(async () => {
      const res = await setRolePermissionAction({
        role_id: role.id,
        permission_id: perm.id,
        granted: next,
      });
      setPending((prev) => {
        const s = new Set(prev);
        s.delete(key);
        return s;
      });
      if (!res.success) {
        setGranted((prev) => {
          const s = new Set(prev);
          if (next) s.delete(key);
          else s.add(key);
          return s;
        });
        toast.error(res.error ?? "העדכון נכשל");
      } else {
        toast.success(next ? "ההרשאה נוספה" : "ההרשאה הוסרה");
      }
    });
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-extrabold text-ink">הרשאות</h1>
        <p className="mt-1 text-sm text-muted">
          מטריצת הרשאות לפי תפקיד. שינויים נכנסים לתוקף בבקשה הבאה של המשתמש, ללא צורך
          בהתחברות מחדש. עמודות מנהל-על ואדמין הן גישה מלאה — לקריאה בלבד.
        </p>
      </div>

      <div className="overflow-auto rounded-2xl border border-line bg-surface shadow-card">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr>
              <th className="sticky start-0 top-0 z-30 border-b border-e border-line bg-appbg px-4 py-3 text-start text-[11px] font-bold tracking-wide text-faint">
                הרשאה
              </th>
              {roles.map((role) => (
                <th
                  key={role.id}
                  className="sticky top-0 z-20 border-b border-line bg-appbg px-3 py-3 text-center"
                >
                  <div className="text-sm font-bold text-ink">{role.name}</div>
                  {PROTECTED.has(role.key) ? (
                    <div className="text-[10px] font-medium text-primary">גישה מלאה</div>
                  ) : (
                    <div className="text-[10px] text-faint">{role.key}</div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(([cat, perms]) => (
              <CategoryGroup key={cat} label={CATEGORY_LABEL[cat] ?? cat} colSpan={roles.length + 1}>
                {perms.map((perm) => (
                  <tr key={perm.id} className="border-b border-line last:border-0 hover:bg-hover">
                    <th className="sticky start-0 z-10 border-e border-line bg-surface px-4 py-2.5 text-start font-normal">
                      <div className="font-medium text-ink">{perm.description ?? perm.key}</div>
                      <div dir="ltr" className="text-start text-[11px] text-faint">
                        {perm.key}
                      </div>
                    </th>
                    {roles.map((role) => {
                      const key = `${role.id}:${role.key}:${perm.id}`;
                      const isProtected = PROTECTED.has(role.key);
                      const on = isProtected || granted.has(`${role.id}:${perm.id}`);
                      const editable = canUpdate && !isProtected;
                      const busy = pending.has(`${role.id}:${perm.id}`);
                      return (
                        <td key={key} className="px-3 py-2.5 text-center">
                          <Cell
                            on={on}
                            editable={editable}
                            protectedCol={isProtected}
                            busy={busy}
                            roleKey={role.key}
                            permKey={perm.key}
                            onToggle={() => toggle(role, perm, !granted.has(`${role.id}:${perm.id}`))}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </CategoryGroup>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CategoryGroup({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan: number;
  children: React.ReactNode;
}) {
  return (
    <>
      <tr>
        <td
          colSpan={colSpan}
          className="border-b border-line bg-appbg/70 px-4 py-1.5 text-[11px] font-bold tracking-wide text-muted"
        >
          {label}
        </td>
      </tr>
      {children}
    </>
  );
}

function Cell({
  on,
  editable,
  protectedCol,
  busy,
  roleKey,
  permKey,
  onToggle,
}: {
  on: boolean;
  editable: boolean;
  protectedCol: boolean;
  busy: boolean;
  roleKey: string;
  permKey: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      data-role={roleKey}
      data-perm={permKey}
      disabled={!editable || busy}
      onClick={onToggle}
      title={protectedCol ? "גישה מלאה — לקריאה בלבד" : editable ? "" : "אין הרשאת עריכה"}
      className={`grid h-6 w-6 place-items-center rounded-md border transition-colors ${
        on
          ? protectedCol
            ? "border-primary/40 bg-primary/40 text-white"
            : "border-primary bg-primary text-white"
          : "border-line bg-surface"
      } ${editable && !busy ? "cursor-pointer hover:border-primary" : "cursor-default"} ${
        busy ? "opacity-50" : ""
      }`}
    >
      {on ? <Icon name="check" size={14} strokeWidth={3} /> : null}
    </button>
  );
}
