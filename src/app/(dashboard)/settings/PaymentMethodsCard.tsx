"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import { Field, FormGrid, IconBtn, SettingsCard, Switch } from "./controls";
import {
  createPaymentMethodAction,
  deletePaymentMethodAction,
  reorderPaymentMethodsAction,
  setPaymentMethodActiveAction,
  updatePaymentMethodAction,
  type PaymentMethodDef,
} from "./payment-method-actions";

// אמצעי תשלום — the tenant's payment-method list (lookup_items). The order and
// the active flag set here ARE what the booking forms render: their queries
// read `is_active ORDER BY sort_order`, so this table is the single source of
// the payment-method <select> in create/edit reservation.
//
// Reorder is HTML5 drag armed ONLY by the grab handle (mousedown on ⋮⋮ arms
// the row; a plain click anywhere stays free). Double-click on the row opens
// the editor drawer — the same handler as the edit button; single click does
// nothing, and inner controls are excluded via closest().

export function PaymentMethodsCard({ initial }: { initial: PaymentMethodDef[] }) {
  const [rows, setRows] = useState(initial);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [armedId, setArmedId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const snapshotRef = useRef<PaymentMethodDef[] | null>(null);
  const [editing, setEditing] = useState<PaymentMethodDef | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // arm-then-abandon: the handle was pressed but no drag started — a global
  // mouseup disarms so the row doesn't stay draggable after a plain click
  useEffect(() => {
    if (!armedId) return;
    const disarm = () => setArmedId(null);
    document.addEventListener("mouseup", disarm);
    return () => document.removeEventListener("mouseup", disarm);
  }, [armedId]);

  const apply = (res: { success: boolean; error?: string; data?: PaymentMethodDef[] }, okMsg: string) => {
    if (res.success && res.data) {
      setRows(res.data);
      toast.success(okMsg);
      setEditing(null);
      setConfirmDelete(null);
    } else {
      toast.error(res.success ? "הפעולה נכשלה" : (res.error ?? "הפעולה נכשלה"));
    }
  };

  const onDragStart = (e: React.DragEvent, row: PaymentMethodDef) => {
    if (armedId !== row.id) {
      e.preventDefault();
      return;
    }
    snapshotRef.current = rowsRef.current;
    setDragId(row.id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", row.id);
  };

  // live preview: hovering another row while dragging moves the dragged row there
  const onDragOver = (e: React.DragEvent, row: PaymentMethodDef) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragId === row.id) return;
    setRows((prev) => {
      const from = prev.findIndex((r) => r.id === dragId);
      const to = prev.findIndex((r) => r.id === row.id);
      if (from === -1 || to === -1 || from === to) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  // dragend always fires (drop AND Escape) — dropEffect 'none' means cancelled
  const onDragEnd = (e: React.DragEvent) => {
    const cancelled = e.dataTransfer.dropEffect === "none";
    const snapshot = snapshotRef.current;
    setArmedId(null);
    setDragId(null);
    snapshotRef.current = null;
    if (!snapshot) return;
    if (cancelled) {
      setRows(snapshot);
      return;
    }
    const orderedIds = rowsRef.current.map((r) => r.id);
    if (orderedIds.join("|") === snapshot.map((r) => r.id).join("|")) return;
    // optimistic — the preview order is already on screen; roll back on failure
    startTransition(async () => {
      const res = await reorderPaymentMethodsAction({ orderedIds });
      if (res.success && res.data) setRows(res.data);
      else {
        setRows(snapshot);
        toast.error(res.success ? "שינוי הסדר נכשל" : (res.error ?? "שינוי הסדר נכשל"));
      }
    });
  };

  const rowDoubleClick = (e: React.MouseEvent, row: PaymentMethodDef) => {
    if ((e.target as HTMLElement).closest("button, input, a, .pm-handle")) return;
    setEditing(row);
  };

  const activeCount = rows.filter((r) => r.isActive).length;

  return (
    <section className="card">
      <header className="card-hd">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary-050 text-primary">
          <Icon name="credit-card" size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="h4">אמצעי תשלום</h3>
          <p className="t-secondary max-w-[640px]">
            הרשימה, הסדר והזמינות כאן הם מה שמוצג בבחירת אמצעי תשלום בהקמת הזמנה
            ובעריכתה. גרירה מהידית משנה סדר; אמצעי בשימוש ניתן רק להשבית.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary shrink-0"
          disabled={pending || editing === "new"}
          onClick={() => setEditing("new")}
        >
          <Icon name="plus" size={20} />
          הוסף אמצעי
        </button>
      </header>

      <div className="pm-scroll">
        <div className="pm-tbl mcard-rows">
          <div className="pm-thead mcard-head">
            <span className="c" aria-hidden="true" />
            <span className="c">#</span>
            <span>אמצעי תשלום</span>
            <span>מפתח</span>
            <span>שימוש</span>
            <span className="c">פעיל</span>
            <span className="pm-th-acts">פעולות</span>
          </div>

          {rows.map((row, i) => {
            const used = row.paymentsCount > 0;
            const undeletable = row.isProtected || used;
            return (
              <div
                key={row.id}
                className={`pm-trow mcard-row select-none ${row.isActive ? "" : "off"} ${dragId === row.id ? "dragging" : ""}`}
                draggable={armedId === row.id}
                onDragStart={(e) => onDragStart(e, row)}
                onDragOver={(e) => onDragOver(e, row)}
                onDrop={(e) => e.preventDefault()}
                onDragEnd={onDragEnd}
                onDoubleClick={(e) => rowDoubleClick(e, row)}
              >
                <span className="c" data-label="גרירה לשינוי סדר" data-mcard="inline">
                  <span
                    className="pm-handle"
                    title="גרירה לשינוי סדר"
                    onMouseDown={() => setArmedId(row.id)}
                  >
                    <Icon name="drag" size={20} label="גרירה לשינוי סדר" />
                  </span>
                </span>
                <span className="c pm-cnt ltr-num" data-mcard="hide">{i + 1}</span>
                <span className="pm-name" data-label="אמצעי תשלום">{row.label}</span>
                <span data-label="מפתח">
                  <span className="chip chip-neutral ltr-num">{row.key}</span>
                </span>
                <span className="pm-cnt" data-label="שימוש">
                  <b className="ltr-num">{row.paymentsCount}</b> תשלומים
                </span>
                <span className="c" data-label="פעיל" data-mcard="inline">
                  <Switch
                    checked={row.isActive}
                    disabled={pending}
                    label={`${row.label} — ${row.isActive ? "פעיל" : "מושבת"}`}
                    title={row.isActive ? "השבת" : "הפעל"}
                    onChange={() =>
                      startTransition(async () =>
                        apply(
                          await setPaymentMethodActiveAction({ id: row.id, isActive: !row.isActive }),
                          row.isActive ? "אמצעי התשלום הושבת" : "אמצעי התשלום הופעל",
                        ),
                      )
                    }
                  />
                </span>
                <span className="pm-acts" data-mcard="actions">
                  {confirmDelete === row.id ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () =>
                            apply(await deletePaymentMethodAction({ id: row.id }), "אמצעי התשלום נמחק"),
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
                      <IconBtn name="edit" label={`עריכת ${row.label}`} disabled={pending} onClick={() => setEditing(row)} />
                      <button
                        type="button"
                        className="icon-btn hover:text-status-danger"
                        title={
                          row.isProtected
                            ? "אמצעי מובנה במערכת — ניתן להשבית בלבד"
                            : used
                              ? "אמצעי בשימוש בתשלומים — ניתן להשבית בלבד"
                              : "מחיקה"
                        }
                        disabled={pending || undeletable}
                        onClick={() => setConfirmDelete(row.id)}
                      >
                        <Icon name="trash" size={20} label={`מחיקת ${row.label}`} />
                      </button>
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="pm-ft">
        <Icon name="info" size={17} />
        <span>
          <span className="ltr-num">{rows.length}</span> אמצעי תשלום סה״כ ·{" "}
          <span className="ltr-num">{activeCount}</span> פעילים
        </span>
      </div>

      {editing && (
        <MethodEditor
          method={editing === "new" ? null : editing}
          pending={pending}
          onClose={() => setEditing(null)}
          onSave={(input) =>
            startTransition(async () => {
              if (editing === "new") {
                apply(await createPaymentMethodAction({ label: input.label }), "אמצעי התשלום נוצר");
              } else {
                apply(
                  await updatePaymentMethodAction({ id: editing.id, label: input.label, isActive: input.isActive }),
                  "אמצעי התשלום עודכן",
                );
              }
            })
          }
        />
      )}
    </section>
  );
}

function MethodEditor({
  method,
  pending,
  onClose,
  onSave,
}: {
  method: PaymentMethodDef | null;
  pending: boolean;
  onClose: () => void;
  onSave: (input: { label: string; isActive: boolean }) => void;
}) {
  const [label, setLabel] = useState(method?.label ?? "");
  const [isActive, setIsActive] = useState(method?.isActive ?? true);
  const valid = label.trim().length > 0 && label.trim().length <= 60;

  return (
    <SidePanel
      open
      onClose={onClose}
      title={method ? "עריכת אמצעי תשלום" : "אמצעי תשלום חדש"}
      icon="credit-card"
      footer={
        <>
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending || !valid}
            onClick={() => onSave({ label, isActive })}
          >
            <Icon name="check" size={20} />
            {pending ? "שומר…" : "שמירה"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>ביטול</button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <SettingsCard icon="credit-card" title="פרטי אמצעי תשלום">
          <FormGrid>
            <Field label="שם" required>
              <input
                className="field-input"
                maxLength={60}
                value={label}
                placeholder="לדוגמה: מזומן"
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
            {method && (
              <Field label="מפתח (קבוע)">
                <span className="flex min-h-11 items-center">
                  <span className="chip chip-neutral ltr-num">{method.key}</span>
                </span>
              </Field>
            )}
          </FormGrid>
          <div className="mt-3 flex flex-wrap items-center gap-5">
            <label className="flex items-center gap-2 text-sm text-ink">
              <Switch checked={isActive} onChange={setIsActive} label="פעיל" /> פעיל
            </label>
          </div>
          {method?.isProtected && (
            <p className="field-hint mt-3">
              אמצעי מובנה — זרימת כרטיס האשראי במערכת מבוססת עליו, ולכן לא ניתן למחוק אותו.
            </p>
          )}
        </SettingsCard>
      </div>
    </SidePanel>
  );
}
