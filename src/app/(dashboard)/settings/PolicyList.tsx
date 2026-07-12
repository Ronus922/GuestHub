"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { IconBtn } from "./controls";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";

// Shared list chrome for the policy sections (cancellation / payment) — same card
// language, default/active chips, edit + archive actions, empty state. Keeps the
// two sections DRY (iron rule #10). Every visual here is a canonical primitive.

export function PolicyToolbar({ title, subtitle, onAdd }: { title: string; subtitle: string; onAdd: () => void }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary-050 text-primary">
          <Icon name="documents" size={20} />
        </span>
        <div className="min-w-0">
          <p className="h4">{title}</p>
          <p className="t-secondary">{subtitle}</p>
        </div>
      </div>
      <button type="button" className="btn btn-primary shrink-0" onClick={onAdd}>
        <Icon name="plus" size={20} />
        הוסף מדיניות
      </button>
    </div>
  );
}

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
    <div className="flex items-start justify-between gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="t-body font-bold text-ink">{name}</p>
          {/* not a §3.1 payment state — the canonical brand tag */}
          {isDefault && <span className="chip chip-brand">ברירת מחדל</span>}
          <span className={`chip ${isActive ? "chip-paid" : "chip-cancelled"}`}>
            <span className="dot" />
            {isActive ? "פעיל" : "לא פעיל"}
          </span>
          <span className="chip chip-neutral ltr-num">{code}</span>
        </div>
        <p className="mt-1 truncate text-sm text-text2">{title}</p>
        <p className="field-hint mt-0.5">{summary}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <IconBtn name="edit" label="עריכה" onClick={onEdit} />
        <IconBtn name="trash" label="מחיקה" onClick={del} disabled={pending} danger />
      </div>
    </div>
  );
}

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="empty-state rounded-xl border border-dashed border-line bg-surface">
      <span className="empty-s">{label}</span>
    </div>
  );
}
