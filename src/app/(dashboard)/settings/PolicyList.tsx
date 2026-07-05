"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";

// Shared list chrome for the policy sections (cancellation / payment) — same card
// language, default/active badges, edit + archive actions, empty state. Keeps the
// two sections DRY (iron rule #10).

export function PolicyToolbar({ title, subtitle, onAdd }: { title: string; subtitle: string; onAdd: () => void }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <span className="bw-hi">
          <Icon name="documents" size={17} />
        </span>
        <div>
          <p className="font-bold text-ink">{title}</p>
          <p className="text-xs text-faint">{subtitle}</p>
        </div>
      </div>
      <button type="button" className="bw-btn bw-btn-primary" onClick={onAdd}>
        <Icon name="plus" size={16} />
        הוסף מדיניות
      </button>
    </div>
  );
}

const iconBtn =
  "grid h-9 w-9 place-items-center rounded-lg text-text2 transition-colors hover:bg-hover disabled:opacity-50";

export function PolicyCard({
  name,
  title,
  code,
  isDefault,
  isActive,
  summary,
  onEdit,
  onDelete,
}: {
  name: string;
  title: string;
  code: string;
  isDefault: boolean;
  isActive: boolean;
  summary: string;
  onEdit: () => void;
  onDelete: () => Promise<ActionResult>;
}) {
  const [pending, start] = useTransition();
  const del = () => {
    if (isDefault) {
      toast.error("לא ניתן למחוק מדיניות ברירת מחדל — קבע ברירת מחדל אחרת תחילה");
      return;
    }
    if (!window.confirm(`לארכב את המדיניות "${name}"?`)) return;
    start(async () => {
      const res = await onDelete();
      if (res.success) toast.success("המדיניות אורכבה");
      else toast.error(res.error);
    });
  };

  return (
    <div className="flex items-start justify-between gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-bold text-ink">{name}</p>
          {isDefault && <Badge tone="primary">ברירת מחדל</Badge>}
          <Badge tone={isActive ? "green" : "muted"}>{isActive ? "פעיל" : "לא פעיל"}</Badge>
          <span className="text-xs text-faint" dir="ltr">{code}</span>
        </div>
        <p className="mt-1 truncate text-sm text-text2">{title}</p>
        <p className="mt-0.5 text-xs text-faint">{summary}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button type="button" className={iconBtn} aria-label="עריכה" onClick={onEdit}>
          <Icon name="edit" size={16} />
        </button>
        <button type="button" className={`${iconBtn} hover:text-status-danger`} aria-label="מחיקה" onClick={del} disabled={pending}>
          <Icon name="trash" size={16} />
        </button>
      </div>
    </div>
  );
}

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-surface p-8 text-center">
      <p className="text-sm text-faint">{label}</p>
    </div>
  );
}

function Badge({ tone, children }: { tone: "primary" | "green" | "muted"; children: React.ReactNode }) {
  const cls =
    tone === "primary"
      ? "bg-primary-050 text-primary"
      : tone === "green"
        ? "bg-status-success-050 text-status-success"
        : "bg-hover text-faint";
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{children}</span>;
}
