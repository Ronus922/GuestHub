"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
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

// סטטוסי הזמנה (D77 §B2, visuals D77.2) — tenant workflow statuses: operator
// tags that never touch inventory or payment state. UI is a 1:1 port of
// ref/html/OrderStatus.html (OrderStatus.png / AddOrderStatusValue.png) over
// the EXISTING model/actions — same rules, same data, new presentation.

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span className="ws-pill" style={{ background: color, color: readableTextColor(color) }}>
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

  return (
    <section className="ws-card max-w-4xl">
      <div className="ws-head">
        <span className="ws-ico">
          <Icon name="check-circle" size={20} />
        </span>
        <div>
          <h3 className="ws-t">סטטוסי הזמנה (תפעוליים)</h3>
          <p className="ws-d">
            תגית תפעולית לצוות — אינה משנה זמינות, מחזור חיים או מצב תשלום. סטטוס שבשימוש לא
            ניתן למחיקה; רק להשבתה.
          </p>
        </div>
        <span className="flex-1" />
        <button
          type="button"
          className="bw-btn bw-btn-primary"
          disabled={pending || editing === "new"}
          onClick={() => startEdit(null)}
        >
          <Icon name="plus" size={16} />
          הוסף סטטוס
        </button>
      </div>

      {editing && (
        <div className="ws-form">
          <h4 className="ws-form-t">{editing === "new" ? "סטטוס חדש" : "עריכת סטטוס"}</h4>
          <div className="ws-form-grid">
            <div className="ws-fld">
              <label className="ws-fld-l" htmlFor="ws-name">
                שם הסטטוס<b>*</b>
              </label>
              <input
                id="ws-name"
                className="bw-fld ws-inp"
                placeholder="לדוגמה: ממתין לאישוש"
                maxLength={60}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div className="ws-fld">
              <span className="ws-fld-l">צבע</span>
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
                  className={`bw-fld ws-hex ${color && !HEX_COLOR_RE.test(color) ? "bad" : ""}`}
                  dir="ltr"
                  placeholder="#RRGGBB"
                  value={customColor ? color : ""}
                  onChange={(e) => setColor(e.target.value.trim())}
                  aria-label="צבע מותאם (hex)"
                />
              </div>
            </div>
          </div>
          <div className="ws-form-foot">
            <button
              type="button"
              className="bw-btn bw-btn-primary"
              disabled={pending || !valid}
              onClick={save}
            >
              {pending ? "שומר…" : "שמור"}
            </button>
            <button type="button" className="bw-btn bw-btn-ghost" onClick={() => setEditing(null)}>
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
                    <Icon name="arrow-up" size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label="הזז למטה"
                    disabled={pending || i === rows.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <Icon name="arrow-down" size={14} />
                  </button>
                </span>
              </span>
              <span className="c ws-cnt">{i + 1}</span>
              <span>
                <Pill label={row.label} color={row.color} />
              </span>
              <span className="ws-cnt">
                <b>{row.usedCount}</b> הזמנות
              </span>
              <span className="c">
                <button
                  type="button"
                  role="switch"
                  aria-checked={row.isActive}
                  aria-label={`${row.label} — ${row.isActive ? "פעיל" : "מושבת"}`}
                  className={`ws-sw ${row.isActive ? "on" : ""}`}
                  disabled={pending || row.isDefault}
                  title={
                    row.isDefault
                      ? "לא ניתן להשבית את ברירת המחדל"
                      : row.isActive
                        ? "השבת"
                        : "הפעל"
                  }
                  onClick={() =>
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
                  className={`ws-star ${row.isDefault ? "on" : ""}`}
                  disabled={pending || row.isDefault || !row.isActive}
                  title={
                    row.isDefault
                      ? "ברירת המחדל"
                      : !row.isActive
                        ? "הפעל את הסטטוס לפני קביעתו כברירת מחדל"
                        : "קבע כברירת מחדל"
                  }
                  aria-label={row.isDefault ? `${row.label} — ברירת מחדל` : `קבע את ${row.label} כברירת מחדל`}
                  onClick={() =>
                    startTransition(async () =>
                      apply(await setDefaultWorkflowStatusAction({ id: row.id }), "ברירת המחדל עודכנה"),
                    )
                  }
                >
                  <Icon name="star" size={19} />
                </button>
              </span>
              <span className="ws-acts">
                {confirmDelete === row.id ? (
                  <>
                    <button
                      type="button"
                      className="bw-btn bw-btn-danger !h-[34px]"
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
                      className="bw-btn bw-btn-ghost !h-[34px]"
                      onClick={() => setConfirmDelete(null)}
                    >
                      ביטול
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="ws-ibtn"
                      title="עריכה"
                      aria-label={`עריכת ${row.label}`}
                      disabled={pending}
                      onClick={() => startEdit(row)}
                    >
                      <Icon name="edit" size={16} />
                    </button>
                    <button
                      type="button"
                      className="ws-ibtn danger"
                      title={
                        row.usedCount > 0
                          ? "סטטוס בשימוש — ניתן רק להשבית"
                          : row.isDefault
                            ? "לא ניתן למחוק את ברירת המחדל"
                            : "מחיקה"
                      }
                      aria-label={`מחיקת ${row.label}`}
                      disabled={pending || row.usedCount > 0 || row.isDefault}
                      onClick={() => setConfirmDelete(row.id)}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="ws-ft">
        <Icon name="info" size={15} />
        <span>
          {rows.length} סטטוסים סה״כ · {activeCount} פעילים
        </span>
      </div>
    </section>
  );
}
