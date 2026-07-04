"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { setRolePermissionAction } from "./actions";
import type { Role, Permission, Grant } from "./types";

import { CATEGORY_LABEL, categoryIndex } from "./categories";

const PROTECTED = new Set(["super_admin", "admin"]);

// Reference scan order inside a category: view → my_tasks → create → … → delete.
const VERB_ORDER = [
  "view", "my_tasks", "create", "edit", "update", "manage",
  "cancel", "refund", "bulk_update", "disable", "delete",
];
const verbRank = (key: string) => {
  const i = VERB_ORDER.indexOf(key.split(".")[1] ?? "");
  return i === -1 ? 99 : i;
};

// "super_admin" → "Super Admin" — the reference's Latin role subtitle.
const roleSubtitle = (key: string) =>
  key.split("_").map((w) => (w[0]?.toUpperCase() ?? "") + w.slice(1)).join(" ");

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
    for (const perms of byCat.values())
      perms.sort((a, b) => verbRank(a.key) - verbRank(b.key) || a.key.localeCompare(b.key));
    return [...byCat.entries()].sort(
      (a, b) => categoryIndex(a[0]) - categoryIndex(b[0]),
    );
  }, [permissions]);

  const countByRole = useMemo(() => {
    const counts = new Map<string, number>();
    for (const key of granted) {
      const roleId = key.slice(0, key.indexOf(":"));
      counts.set(roleId, (counts.get(roleId) ?? 0) + 1);
    }
    return counts;
  }, [granted]);

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
    <div className="flex h-full flex-col gap-6 p-6 lg:p-8">
      <div className="flex flex-none flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">הרשאות</h1>
          <span className="rounded-lg bg-primary-050 px-3 py-1 text-[13px] font-bold text-primary">
            {permissions.length} הרשאות · {roles.length} תפקידים
          </span>
        </div>
        <p className="text-[13px] font-medium text-muted">
          מטריצת הרשאות לפי תפקיד. שינויים נכנסים לתוקף בבקשה הבאה של המשתמש, ללא צורך
          בהתחברות מחדש. עמודות מנהל-על ואדמין נעולות — גישה מלאה.
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        <div className="thin-scroll min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[860px] border-collapse text-sm">
            <thead>
              <tr>
                <th className="sticky start-0 top-0 z-30 border-b border-e border-line bg-surface px-5 py-3 text-start align-bottom text-xs font-bold tracking-wide text-faint">
                  הרשאה
                </th>
                {roles.map((role) => (
                  <th
                    key={role.id}
                    className="sticky top-0 z-20 border-b border-line bg-surface px-3 py-3 text-center"
                  >
                    <div className="flex flex-col items-center gap-1.5">
                      <div>
                        <div className="text-sm font-bold text-ink">{role.name}</div>
                        <div className="text-[11px] font-medium text-faint">
                          {roleSubtitle(role.key)}
                        </div>
                      </div>
                      {PROTECTED.has(role.key) ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-primary-050 px-2.5 py-0.5 text-[11px] font-bold text-primary">
                          <Icon name="lock" size={11} strokeWidth={2.4} />
                          גישה מלאה
                        </span>
                      ) : (
                        <span className="rounded-full bg-appbg px-2.5 py-0.5 text-[11px] font-extrabold tabular-nums text-muted">
                          {countByRole.get(role.id) ?? 0}/{permissions.length}
                        </span>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map(([cat, perms]) => (
                <CategoryGroup
                  key={cat}
                  label={CATEGORY_LABEL[cat] ?? cat}
                  count={perms.length}
                  colSpan={roles.length + 1}
                >
                  {perms.map((perm) => (
                    <tr
                      key={perm.id}
                      className="group border-b border-line/70 last:border-0 hover:bg-hover"
                    >
                      <th className="sticky start-0 z-10 border-e border-line bg-surface px-5 py-2.5 text-start font-normal transition-colors group-hover:bg-hover">
                        <div className="text-[13px] font-bold text-ink">
                          {perm.description ?? perm.key}
                        </div>
                        <div dir="ltr" className="text-end text-[11px] font-medium tracking-wide text-faint">
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

        <div className="flex flex-none flex-wrap items-center gap-x-5 gap-y-2 border-t border-line bg-appbg/40 px-5 py-2.5 text-xs font-semibold text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="grid h-4 w-4 place-items-center rounded-[5px] border-[1.5px] border-primary bg-primary text-white">
              <Icon name="check" size={10} strokeWidth={3.5} />
            </span>
            מוענק
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-4 w-4 rounded-[5px] border-[1.5px] border-faint/60 bg-surface" />
            לא מוענק
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="grid h-4 w-4 place-items-center rounded-[5px] border-[1.5px] border-primary-100 bg-primary-100 text-primary/60">
              <Icon name="check" size={10} strokeWidth={3.5} />
            </span>
            עמודה נעולה — גישה מלאה
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-status-warning" />
            שינוי שטרם נשמר
          </span>
          <span className="ms-auto font-medium text-faint">
            שינויים נכנסים לתוקף בבקשה הבאה של המשתמש
          </span>
        </div>
      </div>
    </div>
  );
}

function CategoryGroup({
  label,
  count,
  colSpan,
  children,
}: {
  label: string;
  count: number;
  colSpan: number;
  children: React.ReactNode;
}) {
  return (
    <>
      <tr>
        <td colSpan={colSpan} className="border-b border-line bg-appbg/50 px-5 py-2">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-extrabold text-ink">{label}</span>
            <span className="text-[11px] font-bold text-faint">{count} הרשאות</span>
          </div>
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
      className={`relative grid h-6 w-6 place-items-center rounded-lg border-[1.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 ${
        on
          ? protectedCol
            ? "border-primary-100 bg-primary-100 text-primary/60"
            : "border-primary bg-primary text-white"
          : "border-faint/60 bg-surface"
      } ${editable && !busy ? "cursor-pointer hover:border-primary" : "cursor-default"} ${
        busy ? "opacity-70" : ""
      }`}
    >
      {on ? <Icon name="check" size={15} strokeWidth={3} /> : null}
      {busy ? (
        <span className="absolute -end-1 -top-1 h-1.5 w-1.5 rounded-full bg-status-warning" />
      ) : null}
    </button>
  );
}
