"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { HEX_COLOR_RE, STATUS_PALETTE, readableTextColor } from "@/lib/colors";
import { Switch } from "./controls";
import {
  createWorkflowStatusAction,
  deleteWorkflowStatusAction,
  reorderWorkflowStatusesAction,
  setDefaultWorkflowStatusAction,
  setWorkflowStatusActiveAction,
  updateWorkflowStatusAction,
  type WorkflowStatusDef,
} from "./status-actions";

// סטטוסי הזמנה (D77 §B2) — tenant workflow statuses: operator tags that never
// touch inventory or payment state. The card, its header, the buttons, the fields
// and the status pill are the canonical primitives (GUIDELINES §3–§6); only the
// table grid and the colour palette are local (status-settings.css).

// The tag wears the tenant's chosen colour on the ONE chip anatomy (§3): 28px,
// radius 8, 13.5px/700. The text shade is derived (WCAG), never stored.
function StatusChip({ label, color }: { label: string; color: string }) {
  return (
    <span className="chip" style={{ background: color, color: readableTextColor(color) }}>
      {label}
    </span>
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
  const customColor = !STATUS_PALETTE.includes(color as (typeof STATUS_PALETTE)[number]);
  const activeCount = rows.filter((r) => r.isActive).length;
  const hexBad = color.length > 0 && !HEX_COLOR_RE.test(color);

  return (
    <section className="card max-w-4xl">
      <header className="card-hd">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary-050 text-primary">
          <Icon name="check-circle" size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="h4">סטטוסי הזמנה (תפעוליים)</h3>
          <p className="t-secondary max-w-[640px]">
            תגית תפעולית לצוות — אינה משנה זמינות, מחזור חיים או מצב תשלום. סטטוס שבשימוש לא ניתן
            למחיקה; רק להשבתה.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary shrink-0"
          disabled={pending || editing === "new"}
          onClick={() => startEdit(null)}
        >
          <Icon name="plus" size={20} />
          הוסף סטטוס
        </button>
      </header>

      {editing && (
        <div className="ws-form">
          <h4 className="ws-form-t">{editing === "new" ? "סטטוס חדש" : "עריכת סטטוס"}</h4>
          <div className="ws-form-grid">
            <div className="field">
              <label className="field-label" htmlFor="ws-name">
                שם הסטטוס<span className="text-status-danger"> *</span>
              </label>
              <input
                id="ws-name"
                className="field-input ws-inp"
                placeholder="לדוגמה: ממתין לאישוש"
                maxLength={60}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div className="field">
              <span className="field-label">צבע</span>
              <div className="ws-pal">
                {STATUS_PALETTE.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`ws-swatch ${color === c ? "on" : ""}`}
                    style={{ background: c }}
                    aria-label={`בחר צבע ${c}`}
                    aria-pressed={color === c}
                    title={c}
                    onClick={() => setColor(c)}
                  />
                ))}
                <input
                  className={`field-input ltr-num ws-hex ${hexBad ? "field-error" : ""}`}
                  placeholder="#RRGGBB"
                  value={customColor ? color : ""}
                  onChange={(e) => setColor(e.target.value.trim())}
                  aria-label="צבע מותאם (hex)"
                  aria-invalid={hexBad}
                />
              </div>
            </div>
          </div>
          <div className="ws-form-foot">
            <button type="button" className="btn btn-primary" disabled={pending || !valid} onClick={save}>
              {pending ? "שומר…" : "שמור"}
            </button>
            <button type="button" className="btn btn-tertiary" onClick={() => setEditing(null)}>
              ביטול
            </button>
          </div>
        </div>
      )}

      <div className="ws-scroll">
        <div className="ws-tbl">
          <div className="ws-thead">
            <span className="c">סדר</span>
            <span className="c">#</span>
            <span>סטטוס</span>
            <span>הזמנות</span>
            <span className="c">פעיל</span>
            <span className="c">ברירת מחדל</span>
            <span className="ws-th-acts">פעולות</span>
          </div>

          {rows.map((row, i) => (
            <div key={row.id} className={`ws-trow ${row.isActive ? "" : "off"}`}>
              <span className="c">
                <span className="ws-ord">
                  <button
                    type="button"
                    aria-label="הזז למעלה"
                    disabled={pending || i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <Icon name="arrow-up" size={13.5} />
                  </button>
                  <button
                    type="button"
                    aria-label="הזז למטה"
                    disabled={pending || i === rows.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <Icon name="arrow-down" size={13.5} />
                  </button>
                </span>
              </span>
              <span className="c ws-cnt ltr-num">{i + 1}</span>
              <span>
                <StatusChip label={row.label} color={row.color} />
              </span>
              <span className="ws-cnt">
                <b className="ltr-num">{row.usedCount}</b> הזמנות
              </span>
              <span className="c">
                <Switch
                  checked={row.isActive}
                  disabled={pending || row.isDefault}
                  label={`${row.label} — ${row.isActive ? "פעיל" : "מושבת"}`}
                  title={
                    row.isDefault
                      ? "לא ניתן להשבית את ברירת המחדל"
                      : row.isActive
                        ? "השבת"
                        : "הפעל"
                  }
                  onChange={() =>
                    startTransition(async () =>
                      apply(
                        await setWorkflowStatusActiveAction({ id: row.id, isActive: !row.isActive }),
                        row.isActive ? "הסטטוס הושבת" : "הסטטוס הופעל",
                      ),
                    )
                  }
                />
              </span>
              <span className="c">
                <button
                  type="button"
                  className={`icon-btn ws-star ${row.isDefault ? "on" : ""}`}
                  disabled={pending || row.isDefault || !row.isActive}
                  title={
                    row.isDefault
                      ? "ברירת המחדל"
                      : !row.isActive
                        ? "הפעל את הסטטוס לפני קביעתו כברירת מחדל"
                        : "קבע כברירת מחדל"
                  }
                  onClick={() =>
                    startTransition(async () =>
                      apply(await setDefaultWorkflowStatusAction({ id: row.id }), "ברירת המחדל עודכנה"),
                    )
                  }
                >
                  <Icon
                    name="star"
                    size={20}
                    label={row.isDefault ? `${row.label} — ברירת מחדל` : `קבע את ${row.label} כברירת מחדל`}
                  />
                </button>
              </span>
              <span className="ws-acts">
                {confirmDelete === row.id ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () =>
                          apply(await deleteWorkflowStatusAction({ id: row.id }), "הסטטוס נמחק"),
                        )
                      }
                    >
                      אישור מחיקה
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-tertiary"
                      onClick={() => setConfirmDelete(null)}
                    >
                      ביטול
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="icon-btn ws-ibtn"
                      title="עריכה"
                      disabled={pending}
                      onClick={() => startEdit(row)}
                    >
                      <Icon name="edit" size={20} label={`עריכת ${row.label}`} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn ws-ibtn danger"
                      title={
                        row.usedCount > 0
                          ? "סטטוס בשימוש — ניתן רק להשבית"
                          : row.isDefault
                            ? "לא ניתן למחוק את ברירת המחדל"
                            : "מחיקה"
                      }
                      disabled={pending || row.usedCount > 0 || row.isDefault}
                      onClick={() => setConfirmDelete(row.id)}
                    >
                      <Icon name="trash" size={20} label={`מחיקת ${row.label}`} />
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="ws-ft">
        <Icon name="info" size={17} />
        <span>
          <span className="ltr-num">{rows.length}</span> סטטוסים סה״כ ·{" "}
          <span className="ltr-num">{activeCount}</span> פעילים
        </span>
      </div>
    </section>
  );
}
