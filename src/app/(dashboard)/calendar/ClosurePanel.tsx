"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SidePanel } from "@/components/ui/SidePanel";
import { formatFullDate, nightsBetween } from "@/lib/dates";
import {
  CLOSURE_CATEGORIES,
  closureLastNight,
  closureMinEnd,
  type ClosureCategory,
} from "@/lib/closures/categories";
import {
  createClosureAction,
  deleteClosureAction,
  listClosableRoomsAction,
  updateClosureAction,
} from "./actions";
import type { CalendarClosure, CalendarRoom } from "./types";

export type ClosurePrefill = {
  roomId?: string;
  startDate?: string;
  endDate?: string;
};

// An EXISTING closure, opened for editing by a click on its bar (either board).
// The room is carried for display only: a closure CHANGES rooms by being dragged
// to another row, which is the gesture that moves a reservation too — this form
// edits the dates, the category and the free text.
export type ClosureEdit = {
  id: string;
  roomId: string;
  /** the room's display text, carried from the board so the pinned row reads
   *  correctly the instant the panel opens, before the picker query returns */
  roomLabel: string;
  startDate: string;
  endDate: string;
  category: ClosureCategory | null;
  reason: string | null;
};

type ClosureRoom = { id: string; room_number: string; name: string | null };

const roomText = (r: ClosureRoom) =>
  `${r.room_number}${r.name && r.name !== r.room_number ? ` · ${r.name}` : ""}`;

// Board row → the panel's edit payload. Both boards open the SAME panel on the
// same closure, so the translation is written once: a second copy is how the
// desktop and the mobile card start disagreeing about what they are editing.
export function closureEditOf(c: CalendarClosure, room: CalendarRoom): ClosureEdit {
  return {
    id: c.id,
    roomId: c.room_id,
    roomLabel: roomText(room),
    startDate: c.start_date,
    endDate: c.end_date,
    category: c.category,
    reason: c.reason,
  };
}

// "סגור חדר" — temporary date-range closure (start-inclusive / end-exclusive,
// minimum one hotel night). Uses guesthub.room_closures, never rooms.status.
//
// ONE panel for both verbs. Filing a closure and editing one ask the operator
// the same four questions, so a second component would be the same form twice,
// drifting apart the first time a field is added. `edit` is what switches: it
// pins the room, prefills the fields, and sends the update action.
export function ClosurePanel({
  open,
  onClose,
  prefill,
  edit,
}: {
  open: boolean;
  onClose: () => void;
  prefill: ClosurePrefill;
  /** present = edit an existing closure; absent = file a new one */
  edit?: ClosureEdit;
}) {
  const [rooms, setRooms] = useState<ClosureRoom[]>([]);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [roomId, setRoomId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  // the closed 084 taxonomy — the closure's CLASSIFIER. It was never sent
  // before, so every closure in production carries category NULL and the board
  // had only free text to render. "" = not chosen yet (the field is optional).
  const [category, setCategory] = useState<ClosureCategory | "">("");
  const [reason, setReason] = useState("");
  const [saving, startSaving] = useTransition();
  // the delete confirmation (§8 ConfirmDialog) — removing a closure puts a room
  // back on sale, which is not something a mis-aimed click may do in one step
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The picker's rows come from the server on open, not from a prop: that is
  // what lets this panel mount over the booking wizard, where no calendar room
  // list exists, with the SAME "healthy and active" filter the query owns.
  useEffect(() => {
    if (!open || edit) return; // editing pins the room — no picker, no query
    let alive = true;
    void listClosableRoomsAction().then((res) => {
      if (!alive) return;
      if (res.success) {
        setRooms(res.data ?? []);
        setRoomsError(null);
      } else {
        setRooms([]);
        setRoomsError(res.error);
      }
    });
    return () => {
      alive = false;
    };
  }, [open, edit]);

  useEffect(() => {
    if (!open) return;
    setRoomId(edit?.roomId ?? prefill.roomId ?? "");
    setStartDate(edit?.startDate ?? prefill.startDate ?? "");
    setEndDate(edit?.endDate ?? prefill.endDate ?? "");
    setCategory(edit?.category ?? "");
    setReason(edit?.reason ?? "");
    setConfirmDelete(false);
  }, [
    open,
    edit?.id,
    edit?.roomId,
    edit?.startDate,
    edit?.endDate,
    edit?.category,
    edit?.reason,
    prefill.roomId,
    prefill.startDate,
    prefill.endDate,
  ]);

  const nights =
    startDate && endDate && endDate > startDate ? nightsBetween(startDate, endDate) : 0;

  // A native <input type="date"> opens its picker ONLY from the little
  // indicator glyph; clicking the rest of the box just focuses it, so the field
  // reads as a control that answers in one place out of ten. showPicker() is the
  // platform's own opener — routing the field's click through it makes the whole
  // box the target it already looks like. Optional-called: the method is typed
  // as always-present, but a browser too old to have it must not throw here.
  const openPicker = (e: React.MouseEvent<HTMLInputElement>) => {
    e.currentTarget.showPicker?.();
  };

  // A closure is at least one night, so end (exclusive) is never on or before
  // start. The field's own `min` stops the picker from offering an illegal day;
  // this repairs the OTHER direction — a range that was legal until start moved
  // past it. Zod re-checks the same rule server-side; this is UX, not the guard.
  const minEnd = startDate ? closureMinEnd(startDate) : "";
  const pickStart = (v: string) => {
    setStartDate(v);
    if (v && endDate && endDate <= v) setEndDate(closureMinEnd(v));
  };

  const remove = () =>
    startSaving(async () => {
      if (!edit) return;
      const res = await deleteClosureAction(edit.id);
      if (res.success) {
        toast.success("החסימה הוסרה");
        setConfirmDelete(false);
        onClose();
      } else {
        toast.error(res.error);
      }
    });

  const submit = () =>
    startSaving(async () => {
      const res = edit
        ? await updateClosureAction({
            id: edit.id,
            startDate,
            endDate,
            category: category || undefined,
            reason,
          })
        : await createClosureAction({
            roomId,
            startDate,
            endDate,
            category: category || undefined,
            reason,
          });
      if (res.success) {
        toast.success(edit ? "הסגירה עודכנה" : "החדר נסגר לטווח שנבחר");
        onClose();
      } else {
        toast.error(res.error);
      }
    });

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title={edit ? "עריכת סגירת חדר" : "סגירת חדר זמנית"}
      icon="circle-slash"
      // §7 footer: canonical .dw-ft (border-top, 16px/24px). The PRIMARY action
      // is FIRST in the DOM — .dw-ft is row-reverse, so it hugs the LEFT edge
      // with "ביטול" to its right.
      footer={
        <>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || !roomId || !startDate || !endDate || nights < 1}
            onClick={submit}
          >
            {saving ? (edit ? "שומר…" : "סוגר…") : edit ? "שמור שינויים" : "סגור חדר"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            ביטול
          </button>
          {/* lifting the closure — only when there IS one. It sits at the far
              inline end of the row (.dw-ft is row-reverse), away from the
              primary, and it asks before it acts. */}
          {edit && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={saving}
              onClick={() => setConfirmDelete(true)}
            >
              <Icon name="trash" size={20} />
              הסר חסימה
            </button>
          )}
        </>
      }
    >
      <div className="space-y-5">
        <label className="field">
          <span className="field-label">חדר *</span>
          {/* read-only while editing. The room is not missing from this form by
              accident and it is not forbidden either: a closure is MOVED between
              rooms the way a reservation is — by dragging it to another row on
              the board, which is one act with one availability check and one ARI
              mark over both rooms. Here it is shown so the operator sees what
              they are editing. */}
          <select
            className="field-input"
            value={roomId}
            disabled={Boolean(edit)}
            onChange={(e) => setRoomId(e.target.value)}
          >
            {edit ? (
              <option value={edit.roomId}>{edit.roomLabel}</option>
            ) : (
              <>
                <option value="">בחירת חדר…</option>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {roomText(r)}
                  </option>
                ))}
              </>
            )}
          </select>
          {roomsError && !edit && (
            <p className="field-msg" role="alert">
              {roomsError}
            </p>
          )}
        </label>

        <div className="grid grid-cols-2 gap-4">
          <label className="field">
            <span className="field-label">מתאריך *</span>
            <input
              type="date"
              className="field-input"
              value={startDate}
              onClick={openPicker}
              onChange={(e) => pickStart(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">עד תאריך (לא כולל) *</span>
            <input
              type="date"
              className="field-input"
              value={endDate}
              min={minEnd}
              onClick={openPicker}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </label>
        </div>

        {nights > 0 && (
          <p className="cb-closenote">
            הסגירה מכסה <span className="ltr-num">{nights}</span> לילות · הלילה האחרון
            הסגור הוא <span className="ltr-num">{formatFullDate(closureLastNight(endDate))}</span>
          </p>
        )}

        <label className="field">
          <span className="field-label">סיבת הסגירה</span>
          <select
            className="field-input"
            value={category}
            onChange={(e) => setCategory(e.target.value as ClosureCategory | "")}
          >
            <option value="">בחירת סיבה…</option>
            {CLOSURE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <span className="field-hint">
            הסיבה היא מה שמוצג על היומן. הפירוט למטה הוא תוספת חופשית.
          </span>
        </label>

        <label className="field">
          <span className="field-label">פירוט</span>
          <input
            className="field-input"
            value={reason}
            placeholder="צביעה בחדר האמבטיה, ליקוי בדוד…"
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>

        {/* §8 confirmation. It portals to document.body, so it is above the
            drawer whatever this subtree's stacking context is. */}
        {confirmDelete && edit && (
          <ConfirmDialog
            title="הסרת סגירת חדר"
            onClose={() => setConfirmDelete(false)}
            footer={
              <>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={saving}
                  onClick={remove}
                >
                  {saving ? "מוחק…" : "מחיקה"}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={saving}
                  onClick={() => setConfirmDelete(false)}
                >
                  ביטול
                </button>
              </>
            }
          >
            <p className="cb-gate-msg">למחוק את הסגירה?</p>
            <p className="cb-gate-note">
              הלילות שהיא מכסה יחזרו למכירה ויפורסמו מחדש לערוצים.
            </p>
          </ConfirmDialog>
        )}
      </div>
    </SidePanel>
  );
}
