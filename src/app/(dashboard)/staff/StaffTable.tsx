"use client";

import { useState } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
} from "@tanstack/react-table";
import { Icon } from "@/components/shared/Icon";
import { Badge } from "@/components/ui/Badge";
import { roleMeta, AVATAR_TINT, initials } from "./role-meta";
import type { StaffUser } from "./types";

const timeFmt = new Intl.DateTimeFormat("he-IL", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Jerusalem",
});
const dateFmt = new Intl.DateTimeFormat("he-IL", {
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Asia/Jerusalem",
});

// "20:11 · 03.07.26" per the reference; "לא התחבר" when never signed in.
function lastLogin(iso: string | null) {
  if (!iso) return <span className="text-faint">לא התחבר</span>;
  const d = new Date(iso);
  return (
    <bdi className="ltr-num text-text2">
      {timeFmt.format(d)} · {dateFmt.format(d)}
    </bdi>
  );
}

const col = createColumnHelper<StaffUser>();

export function StaffTable({
  users,
  totalCount,
  canUpdate,
  onEdit,
}: {
  users: StaffUser[];
  totalCount: number;
  canUpdate: boolean;
  onEdit: (u: StaffUser) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "employee", desc: false },
  ]);

  const columns = [
    col.accessor((u) => u.full_name ?? u.username, {
      id: "employee",
      header: "עובד",
      cell: (c) => {
        const u = c.row.original;
        const tint = AVATAR_TINT[roleMeta(u.role_key).tone];
        return (
          <div className="flex items-center gap-3">
            <span
              className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-bold ${tint}`}
            >
              {initials(u.full_name ?? u.username)}
            </span>
            <div className="min-w-0">
              <p className="t-body truncate font-semibold text-ink">
                {u.full_name ?? u.username}
              </p>
              {u.email ? (
                <p className="t-label max-w-[260px] truncate text-faint">
                  <bdi className="ltr-num">{u.email}</bdi>
                </p>
              ) : null}
            </div>
          </div>
        );
      },
    }),
    col.accessor("phone", {
      header: "טלפון",
      enableSorting: false,
      // dir=ltr keeps digit order; text-end aligns with the RTL header (right)
      cell: (c) => (
        <bdi className="ltr-num block text-end text-text2">
          {c.getValue() || "—"}
        </bdi>
      ),
    }),
    col.accessor((u) => u.role_name ?? "", {
      id: "role",
      header: "תפקיד",
      enableSorting: false,
      cell: (c) => {
        const u = c.row.original;
        if (!u.role_name) return <span className="text-faint">—</span>;
        return <Badge tone={roleMeta(u.role_key).tone}>{u.role_name}</Badge>;
      },
    }),
    // No user↔areas model exists yet (DECISIONS D22) — honest placeholder.
    col.display({
      id: "areas",
      header: "אזורי דיווח",
      cell: () => <span className="text-faint">—</span>,
    }),
    col.accessor("is_active", {
      header: "סטטוס",
      enableSorting: false,
      cell: (c) =>
        c.getValue() ? (
          <Badge tone="success" dot>
            פעיל
          </Badge>
        ) : (
          <Badge tone="muted" dot>
            מושבת
          </Badge>
        ),
    }),
    col.accessor("last_sign_in_at", {
      header: "כניסה אחרונה",
      enableSorting: false,
      cell: (c) => lastLogin(c.getValue()),
    }),
    col.display({
      id: "actions",
      header: "",
      cell: (c) =>
        canUpdate ? (
          <button
            type="button"
            onClick={() => onEdit(c.row.original)}
            title="עריכה"
            className="icon-btn"
          >
            <Icon name="edit" size={20} label="עריכה" />
          </button>
        ) : null,
    }),
  ];

  const table = useReactTable({
    data: users,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] border-collapse text-sm">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-line bg-appbg/60">
                {hg.headers.map((h) => {
                  const sortable = h.column.getCanSort();
                  const dir = h.column.getIsSorted();
                  return (
                    <th key={h.id} className="t-label px-4 py-3 text-start tracking-wide">
                      {h.isPlaceholder ? null : sortable ? (
                        <button
                          type="button"
                          onClick={h.column.getToggleSortingHandler()}
                          className="inline-flex min-h-11 items-center gap-1 hover:text-ink"
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {dir ? (
                            <Icon
                              name={dir === "asc" ? "arrow-up" : "arrow-down"}
                              size={13.5}
                              className="text-primary"
                            />
                          ) : null}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className={`border-b border-line transition-colors last:border-0 hover:bg-hover ${
                  row.original.is_active ? "" : "opacity-60"
                }`}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-3 align-middle">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {users.length === 0 ? (
        <div className="empty-state">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-primary-050">
            <Icon name="guests" size={24} className="text-primary" />
          </div>
          <p className="empty-t">
            {totalCount === 0 ? "אין עדיין עובדים" : "לא נמצאו תוצאות"}
          </p>
          <p className="empty-s">
            {totalCount === 0
              ? "הוסף את העובד הראשון כדי להתחיל"
              : "נסה לשנות את מונחי החיפוש או הסינון"}
          </p>
        </div>
      ) : (
        <div className="t-label border-t border-line px-4 py-3">
          מציג <bdi className="ltr-num">{users.length}</bdi> מתוך{" "}
          <bdi className="ltr-num">{totalCount}</bdi> עובדים
        </div>
      )}
    </div>
  );
}
