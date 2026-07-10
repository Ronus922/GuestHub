"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { CardTitle, Field } from "@/components/reservations/BookingPanel";
import { HEX_COLOR_RE, STATUS_PALETTE, readableTextColor } from "@/lib/colors";
import {
  createWorkflowStatusAction,
  deleteWorkflowStatusAction,
  reorderWorkflowStatusesAction,
  setDefaultWorkflowStatusAction,
  setWorkflowStatusActiveAction,
  updateWorkflowStatusAction,
  type WorkflowStatusDef,
} from "./status-actions";

// סטטוסי הזמנה (D77 §B2) — tenant workflow statuses: operator-facing tags that
// never touch inventory or payment state. Colors come from the design palette
// (or a validated hex); tag text color is DERIVED for WCAG readability.

function Tag({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="rounded-full px-3 py-1 text-xs font-bold"
      style={{ background: color, color: readableTextColor(color) }}
    >
      {label}
    </span>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const custom = !STATUS_PALETTE.includes(value as (typeof STATUS_PALETTE)[number]);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {STATUS_PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`בחר צבע ${c}`}
          aria-pressed={value === c}
          onClick={() => onChange(c)}
          className={`h-7 w-7 rounded-full border-2 transition ${
            value === c ? "border-ink scale-110" : "border-transparent"
          }`}
          style={{ background: c }}
        />
      ))}
      <input
        className={`bw-fld !w-28 ${value && !HEX_COLOR_RE.test(value) ? "bad" : ""}`}
        dir="ltr"
        placeholder="#RRGGBB"
        value={custom ? value : ""}
        onChange={(e) => onChange(e.target.value.trim())}
        aria-label="צבע מותאם (hex)"
      />
    </div>
  );
}

export function WorkflowStatusSection({ initial }: { initial: WorkflowStatusDef[] }) {
  const [rows, setRows] = useState(initial);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [label, setLabel] = useState("");
  const [color, setColor] = useState<string>(STATUS_PALETTE[0]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const apply = (res: { success: boolean; error?: string; data?: WorkflowStatusDef[] }, okMsg: string) => {
    if (res.success && res.data) {
      setRows(res.data);
      toast.success(okMsg);
      setEditing(null);
      setConfirmDelete(null);
    } else {
      toast.error(res.success ? "הפעולה נכשלה" : (res.error ?? "הפעולה נכשלה"));
    }
  };

  const startEdit = (row: WorkflowStatusDef | null) => {
    setEditing(row ? row.id : "new");
    setLabel(row?.label ?? "");
    setColor(row?.color ?? STATUS_PALETTE[0]);
  };

  const save = () =>
    startTransition(async () => {
      if (editing === "new") {
        apply(await createWorkflowStatusAction({ label, color }), "הסטטוס נוצר");
      } else if (editing) {
        apply(await updateWorkflowStatusAction({ id: editing, label, color }), "הסטטוס עודכן");
      }
    });

  const move = (index: number, dir: -1 | 1) =>
    startTransition(async () => {
      const next = [...rows];
      const [row] = next.splice(index, 1);
      next.splice(index + dir, 0, row);
      apply(await reorderWorkflowStatusesAction({ orderedIds: next.map((r) => r.id) }), "הסדר עודכן");
    });

  const valid = label.trim().length > 0 && label.trim().length <= 60 && HEX_COLOR_RE.test(color);

  return (
    <section className="bw-card max-w-3xl">
      <CardTitle icon="check" title="סטטוסי הזמנה (תפעוליים)" />
      <p className="bw-hint mb-4">
        תגית תפעולית לצוות — אינה משנה זמינות, מחזור חיים או מצב תשלום. סטטוס שבשימוש לא
        ניתן למחיקה — רק להשבתה; סטטוס מושבת נשאר מוצג בהזמנות היסטוריות.
      </p>

      <ul className="flex flex-col divide-y divide-line">
        {rows.map((row, i) => (
          <li key={row.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="flex flex-col gap-1">
              <button
                type="button"
                className="text-muted disabled:opacity-30"
                aria-label="העלה בסדר"
                disabled={pending || i === 0}
                onClick={() => move(i, -1)}
              >
                <Icon name="arrow-up" size={14} />
              </button>
              <button
                type="button"
                className="text-muted disabled:opacity-30"
                aria-label="הורד בסדר"
                disabled={pending || i === rows.length - 1}
                onClick={() => move(i, 1)}
              >
                <Icon name="arrow-down" size={14} />
              </button>
            </div>
            <Tag label={row.label} color={row.color} />
            {row.isDefault && (
              <span className="rounded bg-primary-050 px-2 py-0.5 text-xs font-bold text-primary">
                ברירת מחדל
              </span>
            )}
            {!row.isActive && (
              <span className="rounded bg-hover px-2 py-0.5 text-xs font-bold text-muted">מושבת</span>
            )}
            <span className="text-xs text-muted">{row.usedCount} הזמנות</span>
            <span className="flex-1" />
            {!row.isDefault && row.isActive && (
              <button
                type="button"
                className="bw-btn bw-btn-ghost"
                disabled={pending}
                onClick={() =>
                  startTransition(async () =>
                    apply(await setDefaultWorkflowStatusAction({ id: row.id }), "ברירת המחדל עודכנה"),
                  )
                }
              >
                קבע כברירת מחדל
              </button>
            )}
            <button type="button" className="bw-btn bw-btn-ghost" disabled={pending} onClick={() => startEdit(row)}>
              <Icon name="edit" size={14} />
              עריכה
            </button>
            {!row.isDefault && (
              <button
                type="button"
                className="bw-btn bw-btn-ghost"
                disabled={pending}
                onClick={() =>
                  startTransition(async () =>
                    apply(
                      await setWorkflowStatusActiveAction({ id: row.id, isActive: !row.isActive }),
                      row.isActive ? "הסטטוס הושבת" : "הסטטוס הופעל",
                    ),
                  )
                }
              >
                {row.isActive ? "השבת" : "הפעל"}
              </button>
            )}
            {row.usedCount === 0 && !row.isDefault && (
              confirmDelete === row.id ? (
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    className="bw-btn bw-btn-danger"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () =>
                        apply(await deleteWorkflowStatusAction({ id: row.id }), "הסטטוס נמחק"),
                      )
                    }
                  >
                    אישור מחיקה
                  </button>
                  <button type="button" className="bw-btn bw-btn-ghost" onClick={() => setConfirmDelete(null)}>
                    ביטול
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="bw-btn bw-btn-ghost text-status-danger"
                  disabled={pending}
                  onClick={() => setConfirmDelete(row.id)}
                >
                  <Icon name="trash" size={14} />
                </button>
              )
            )}
          </li>
        ))}
      </ul>

      {editing ? (
        <div className="mt-4 rounded-xl border border-line bg-surface p-4">
          <div className="bw-grid2">
            <Field label="שם הסטטוס" required>
              <input
                className="bw-fld"
                value={label}
                maxLength={60}
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
            <Field label="תצוגה מקדימה">
              <div className="flex h-[42px] items-center">
                <Tag label={label.trim() || "סטטוס"} color={HEX_COLOR_RE.test(color) ? color : "#6B7385"} />
              </div>
            </Field>
          </div>
          <div className="mt-3">
            <span className="bw-lbl mb-2 block">צבע</span>
            <ColorPicker value={color} onChange={setColor} />
          </div>
          <div className="mt-4 flex items-center gap-2">
            <button type="button" className="bw-btn bw-btn-primary" disabled={pending || !valid} onClick={save}>
              <Icon name="check" size={15} />
              {pending ? "שומר…" : "שמירה"}
            </button>
            <button type="button" className="bw-btn bw-btn-ghost" onClick={() => setEditing(null)}>
              ביטול
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="bw-addroom mt-4" onClick={() => startEdit(null)}>
          <Icon name="plus" size={16} />
          הוסף סטטוס חדש
        </button>
      )}
    </section>
  );
}
