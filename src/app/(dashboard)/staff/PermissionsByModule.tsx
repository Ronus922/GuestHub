"use client";

import { useMemo } from "react";
import { Icon } from "@/components/shared/Icon";
import { CATEGORY_LABEL, CATEGORY_ICON, categoryIndex } from "../permissions/categories";
import type { PermissionDef } from "./types";

// The employee-permissions reference groups the catalog into module rows with
// צפייה/עריכה/מחיקה columns. Real permission keys are finer-grained (create,
// cancel, refund…), so a column cell aggregates every catalog action in its
// bucket: full = employee has them all, partial = some, empty = none. The
// employee's effective set = role defaults + personal grant/revoke overrides;
// cells whose effective state differs from the role default carry a colored
// override marker (green = נוסף ידנית, red = הוסר ידנית). When editable,
// clicking a cell stages the whole bucket to checked/unchecked.
const COLUMNS = [
  { id: "view", label: "צפייה" },
  { id: "edit", label: "עריכה" },
  { id: "delete", label: "מחיקה" },
] as const;

type ColumnId = (typeof COLUMNS)[number]["id"];

function actionBucket(key: string): ColumnId {
  const action = key.split(".")[1] ?? "";
  if (action === "view" || action === "my_tasks") return "view";
  if (action === "delete") return "delete";
  return "edit"; // create / edit / update / cancel / manage / refund / bulk_update / disable
}

export function PermissionsByModule({
  catalog,
  effectiveKeys,
  roleKeys,
  fullAccess,
  editable,
  onToggle,
}: {
  catalog: PermissionDef[];
  effectiveKeys: Set<string>;
  roleKeys: Set<string>;
  fullAccess: boolean;
  editable: boolean;
  onToggle: (keys: string[], next: boolean) => void;
}) {
  const rows = useMemo(() => {
    const byCat = new Map<string, PermissionDef[]>();
    for (const p of catalog) {
      const cat = p.category ?? "אחר";
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat)!.push(p);
    }
    return [...byCat.entries()].sort((a, b) => categoryIndex(a[0]) - categoryIndex(b[0]));
  }, [catalog]);

  const hasOverrides =
    !fullAccess && catalog.some((p) => effectiveKeys.has(p.key) !== roleKeys.has(p.key));

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[420px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-appbg">
              <th className="t-label px-4 py-3 text-start tracking-wide text-faint">מודול</th>
              {COLUMNS.map((c) => (
                <th key={c.id} className="t-label w-20 px-3 py-3 text-center tracking-wide text-faint">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([cat, perms], i) => (
              <tr
                key={cat}
                className={`border-b border-line last:border-0 ${i % 2 ? "bg-appbg/60" : ""}`}
              >
                <th className="px-4 py-2.5 text-start font-normal">
                  <span className="t-secondary flex items-center gap-2.5 text-ink">
                    <span className="text-faint">
                      <Icon name={CATEGORY_ICON[cat] ?? "info"} size={17} />
                    </span>
                    {CATEGORY_LABEL[cat] ?? cat}
                  </span>
                </th>
                {COLUMNS.map((c) => {
                  const bucket = perms.filter((p) => actionBucket(p.key) === c.id);
                  return (
                    <td key={c.id} className="px-3 py-2.5 text-center">
                      <MatrixCell
                        bucket={bucket}
                        effectiveKeys={effectiveKeys}
                        roleKeys={roleKeys}
                        fullAccess={fullAccess}
                        editable={editable}
                        onToggle={onToggle}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(hasOverrides || editable) && !fullAccess ? (
        <div className="t-label flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="flex items-center gap-1.5">
            <span className="inline-grid h-5 w-5 place-items-center rounded-[7px] border border-primary bg-primary text-white">
              <Icon name="check" size={13.5} />
            </span>
            ברירת מחדל מהתפקיד
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-grid h-5 w-5 place-items-center rounded-[7px] border border-status-success bg-status-success text-white">
              <Icon name="plus" size={13.5} />
            </span>
            נוסף ידנית
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-grid h-5 w-5 place-items-center rounded-[7px] border border-dashed border-status-danger bg-status-danger-050" />
            הוסר ידנית
          </span>
        </div>
      ) : null}
    </div>
  );
}

// One aggregated cell. Its tri-state comes from the EFFECTIVE set; override
// styling compares effective vs role default per permission in the bucket.
function MatrixCell({
  bucket,
  effectiveKeys,
  roleKeys,
  fullAccess,
  editable,
  onToggle,
}: {
  bucket: PermissionDef[];
  effectiveKeys: Set<string>;
  roleKeys: Set<string>;
  fullAccess: boolean;
  editable: boolean;
  onToggle: (keys: string[], next: boolean) => void;
}) {
  if (bucket.length === 0) {
    // this action doesn't exist in the catalog for this module — nothing to grant
    return (
      <span className="text-faint" title="לא קיים במודול זה" aria-label="לא רלוונטי">
        —
      </span>
    );
  }
  const has = (p: PermissionDef) => fullAccess || effectiveKeys.has(p.key);
  const granted = bucket.filter(has);
  const state = granted.length === 0 ? "none" : granted.length === bucket.length ? "all" : "some";
  const grants = fullAccess ? [] : bucket.filter((p) => has(p) && !roleKeys.has(p.key));
  const revokes = fullAccess ? [] : bucket.filter((p) => !has(p) && roleKeys.has(p.key));

  const label = (p: PermissionDef) =>
    grants.includes(p)
      ? `${p.label} (נוסף ידנית)`
      : revokes.includes(p)
        ? `${p.label} (הוסר ידנית)`
        : has(p)
          ? `${p.label} (ברירת מחדל)`
          : p.label;
  const title =
    state === "none"
      ? `לא מוענק: ${bucket.map(label).join(", ")}`
      : state === "all"
        ? `מוענק: ${granted.map(label).join(", ")}`
        : `מוענק: ${granted.map(label).join(", ")} · לא מוענק: ${bucket
            .filter((p) => !granted.includes(p))
            .map(label)
            .join(", ")}`;

  // fully checked cell whose access is entirely manual → success box; a cell the
  // role grants but is now fully revoked → dashed danger box; mixed → corner dots
  const allManual = state === "all" && grants.length === granted.length && grants.length > 0;
  const allRevoked = state === "none" && revokes.length > 0;
  const box = allManual
    ? "border-status-success bg-status-success text-white"
    : allRevoked
      ? "border-dashed border-status-danger bg-status-danger-050"
      : state === "all"
        ? "border-primary bg-primary text-white"
        : state === "some"
          ? "border-primary/40 bg-primary-050 text-primary"
          : "border-line bg-surface";

  const cell = (
    <span
      className={`relative inline-grid h-6 w-6 place-items-center rounded-[7px] border transition-colors ${box} ${
        editable ? "cursor-pointer hover:border-primary" : ""
      }`}
    >
      {state === "all" ? (
        <Icon name={allManual ? "plus" : "check"} size={13.5} />
      ) : state === "some" ? (
        <span className="h-0.5 w-2.5 rounded-full bg-primary" aria-hidden />
      ) : null}
      {!allManual && grants.length > 0 ? (
        <span
          aria-hidden
          className="absolute -end-1 -top-1 h-2.5 w-2.5 rounded-full border border-surface bg-status-success"
        />
      ) : null}
      {!allRevoked && revokes.length > 0 ? (
        <span
          aria-hidden
          className="absolute -bottom-1 -end-1 h-2.5 w-2.5 rounded-full border border-surface bg-status-danger"
        />
      ) : null}
    </span>
  );

  if (!editable) {
    return (
      <span
        role="checkbox"
        aria-checked={state === "some" ? "mixed" : state === "all"}
        aria-disabled="true"
        title={title}
      >
        {cell}
      </span>
    );
  }
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "some" ? "mixed" : state === "all"}
      title={title}
      onClick={() =>
        onToggle(
          bucket.map((p) => p.key),
          state !== "all",
        )
      }
      // 44px touch target around the 24px box, without growing the row
      className="-m-2.5 inline-grid h-11 w-11 place-items-center align-middle"
      data-perms={bucket.map((p) => p.key).join(" ")}
    >
      {cell}
    </button>
  );
}
