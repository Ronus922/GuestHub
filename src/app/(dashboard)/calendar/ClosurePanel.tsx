"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SidePanel } from "@/components/ui/SidePanel";
import { formatDayMonth, nightsBetween, type DateOnly } from "@/lib/dates";
import { monthOf } from "@/lib/date-range";
import {
  CLOSURE_CATEGORIES,
  closureLastNight,
  closureMinEnd,
  type ClosureCategory,
} from "@/lib/closures/categories";
import {
  occupiedNights,
  pickNight,
  presetRange,
  rangeBlocks,
  rangeUnknownNights,
  type OccupancyClosure,
  type OccupancyStay,
} from "@/lib/closures/occupancy";
import { ClosureCalendar } from "./ClosureCalendar";
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

// The occupancy the panel paints its calendar with. It is the BOARD's own data,
// handed down — no endpoint of its own and no second query (owner ruling): the
// calendar already fetched every non-cancelled stay and every closure of the
// window it draws, and those are exactly the rows that decide whether a night
// can be closed. `from`/`to` are that window, so the panel knows the edge of
// what it knows and can say so instead of drawing an empty month as "free".
export type ClosureOccupancy = {
  today: DateOnly;
  from: DateOnly;
  /** EXCLUSIVE end of the loaded window */
  to: DateOnly;
  stays: readonly OccupancyStay[];
  closures: readonly OccupancyClosure[];
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
//
// THE DATES ARE PICKED ON A CALENDAR, not typed into two <input type="date">
// boxes (owner reference). The old pair asked for "עד תאריך (לא כולל)" — a
// checkout boundary, which is not a thing an operator thinks in — and it showed
// nothing about the room: a range straight through a booked week looked exactly
// like a free one until the server said no. Here the operator picks NIGHTS, and
// the nights that are already owed are painted and unclickable.
export function ClosurePanel({
  open,
  onClose,
  prefill,
  edit,
  occupancy,
}: {
  open: boolean;
  onClose: () => void;
  prefill: ClosurePrefill;
  /** present = edit an existing closure; absent = file a new one */
  edit?: ClosureEdit;
  /** the board's loaded stays + closures — what the calendar paints red */
  occupancy: ClosureOccupancy;
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
  // half of the two-click pick: true = the last click opened a one-night range
  // and the NEXT click sets the last night; false = the range is complete and a
  // click starts over. Without it a one-night range and a range-in-progress are
  // the same two dates and the second click could never extend anything.
  const [pending, setPending] = useState(false);
  const [view, setView] = useState<{ year: number; month: number } | null>(null);
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
    setPending(false);
    setConfirmDelete(false);
    // the month in view follows the range being edited, so opening a closure
    // three months out does not land the operator on today's grid
    setView(monthOf(edit?.startDate ?? prefill.startDate ?? occupancy.today));
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
    occupancy.today,
  ]);

  const nights =
    startDate && endDate && endDate > startDate ? nightsBetween(startDate, endDate) : 0;
  // the stored end is EXCLUSIVE; the calendar and every sentence here speak in
  // the LAST CLOSED NIGHT. One conversion, through the one function.
  const lastNight = endDate && endDate > startDate ? closureLastNight(endDate) : "";

  // The room's owed nights. In EDIT mode the closure being re-dated is left out:
  // a closure that counted itself as occupancy could never be shortened.
  const occupied = useMemo(
    () =>
      occupiedNights({
        roomId,
        stays: occupancy.stays,
        closures: occupancy.closures,
        ignoreClosureId: edit?.id,
      }),
    [roomId, occupancy.stays, occupancy.closures, edit?.id],
  );

  // named for what it is, not `window` — that identifier already means the
  // browser's global inside this module
  const occWindow = useMemo(
    () => ({ from: occupancy.from, to: occupancy.to }),
    [occupancy.from, occupancy.to],
  );

  // A taken night cannot be CLICKED, but a range can be drawn straight over one
  // — click before it, click after it. That is the collision this catches, in
  // the panel, before the save. The server's overlap check stays the gate.
  const conflicts = lastNight ? rangeBlocks(startDate, lastNight, occupied) : [];
  const unknown = lastNight ? rangeUnknownNights(startDate, lastNight, occWindow) : 0;

  const pick = (d: DateOnly) => {
    const next = pickNight(
      startDate && lastNight ? { start: startDate, lastNight, pending } : null,
      d,
    );
    setStartDate(next.start);
    setEndDate(closureMinEnd(next.lastNight));
    setPending(next.pending);
  };

  const applyPreset = (span: number | "month") => {
    const p = presetRange(occupancy.today, span);
    setStartDate(p.start);
    setEndDate(closureMinEnd(p.lastNight));
    setPending(false);
  };

  const picked = rooms.find((r) => r.id === roomId);
  const roomLabel = edit?.roomLabel ?? (picked ? roomText(picked) : "");

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

  const blocked = conflicts.length > 0;
  const summary =
    nights > 0 && lastNight ? (
      <div className="cp-ft-sum">
        <p className="cp-sum-l">
          <span className="ltr-num">{nights}</span> {nights === 1 ? "לילה" : "לילות"} ·{" "}
          <span className="ltr-num">
            {formatDayMonth(startDate)}–{formatDayMonth(lastNight)}
          </span>
        </p>
        <p className="cp-sum-s">
          {roomLabel ? `חדר ${roomLabel} · ` : ""}חוזר לזמינות ב-
          <span className="ltr-num">{formatDayMonth(endDate)}</span>
        </p>
      </div>
    ) : (
      <div className="cp-ft-sum">
        <p className="cp-sum-l">בחירת לילות</p>
        <p className="cp-sum-s">לחיצה ראשונה פותחת לילה · לחיצה שנייה קובעת את האחרון</p>
      </div>
    );

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title={edit ? "עריכת סגירת חדר" : "סגירת חדר זמנית"}
      subtitle="החדר לא יוצע להזמנה בתאריכים שתבחר"
      icon="circle-slash"
      // §7 footer: canonical .dw-ft (border-top, 16px/24px). Everything the
      // footer holds is wrapped in ONE child (.cp-ft) so the phone-width
      // `flex-wrap: wrap` on .dw-ft — which every OTHER drawer still needs and
      // which check:responsive still asserts — has nothing to wrap here. The
      // three actions keep their single row at 360px because .cp-ft-acts is
      // `nowrap` and the labels shorten in CSS; the summary moves ABOVE them.
      // The PRIMARY action is FIRST in the DOM — the row is row-reverse, so it
      // hugs the LEFT edge with "ביטול" to its right.
      footer={
        <div className="cp-ft">
          <div className="cp-ft-acts">
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || !roomId || !startDate || !endDate || nights < 1 || blocked}
              onClick={submit}
            >
              <span className="cp-lbl-full">
                {saving ? (edit ? "שומר…" : "סוגר…") : edit ? "שמור שינויים" : "סגור חדר"}
              </span>
              <span className="cp-lbl-short">
                {saving ? "שומר…" : edit ? "שמור" : "סגור"}
              </span>
            </button>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              ביטול
            </button>
            {/* lifting the closure — only when there IS one. It sits at the far
                inline end of the row (the row is row-reverse), away from the
                primary, and it asks before it acts. */}
            {edit && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={saving}
                onClick={() => setConfirmDelete(true)}
              >
                <Icon name="trash" size={20} className="cp-lbl-full" />
                <span className="cp-lbl-full">הסר חסימה</span>
                <span className="cp-lbl-short">מחק</span>
              </button>
            )}
          </div>
          {summary}
        </div>
      }
    >
      <div className="cp-body">
        <div className="cp-cols">
          <div className="cp-side">
            <section className="card cp-card">
              <span className="field-label">חדר *</span>
              {/* read-only while editing. The room is not missing from this form
                  by accident and it is not forbidden either: a closure is MOVED
                  between rooms the way a reservation is — by dragging it to
                  another row on the board, which is one act with one
                  availability check and one ARI mark over both rooms. Here it is
                  shown so the operator sees what they are editing.

                  A native <select>, not the reference's picture-rich picker: the
                  type, the nightly price and the "has future bookings" line that
                  picker draws are not in the props this panel is fed, and the
                  ruling on this pass is no new query. */}
              <select
                className="field-input cp-room"
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
            </section>

            <section className="card cp-card">
              <span className="field-label">סיבת הסגירה</span>
              {/* the CLOSED 084 taxonomy, as chips instead of a dropdown. Built
                  from CLOSURE_CATEGORIES, so a seventh value appears here
                  without this file being touched — and no Hebrew label is
                  retyped. Optional, exactly as it was: a closure may still be
                  filed with free text alone. */}
              <div className="cp-chips">
                {CLOSURE_CATEGORIES.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    className={`cp-chip${category === c.value ? " on" : ""}`}
                    aria-pressed={category === c.value}
                    onClick={() => setCategory(category === c.value ? "" : c.value)}
                  >
                    <Icon name={c.icon} size={20} />
                    {c.label}
                  </button>
                ))}
              </div>
              <div className="cp-note-hd">
                <span className="field-label">פירוט לצוות (לא חובה)</span>
                <span className="cp-count ltr-num">{reason.length}/200</span>
              </div>
              <textarea
                className="field-input cp-textarea"
                value={reason}
                placeholder="צביעה בחדר האמבטיה, ליקוי בדוד…"
                maxLength={200}
                onChange={(e) => setReason(e.target.value)}
              />
              <span className="field-hint">
                הסיבה היא מה שמוצג על היומן. הפירוט הוא תוספת חופשית.
              </span>
            </section>
          </div>

          {view && (
            <ClosureCalendar
              view={view}
              onView={setView}
              today={occupancy.today}
              start={startDate}
              lastNight={lastNight}
              occupied={occupied}
              occWindow={occWindow}
              onPick={pick}
              onPreset={applyPreset}
            />
          )}
        </div>

        {/* ONE status line, and it never lies about what it knows. Red when the
            range crosses a night the room already owes — the save is blocked
            here, not only by the server. Neutral when part of the range is
            outside the board's loaded window, because "no data" is not "free".
            Green only when every night of the range was actually checked. */}
        {nights > 0 && (
          <div
            className={`cp-status${blocked ? " bad" : unknown > 0 ? " unk" : " ok"}`}
            role={blocked ? "alert" : undefined}
          >
            <Icon name={blocked ? "warning" : unknown > 0 ? "info" : "check-circle"} size={24} />
            <div className="cp-status-t">
              <p className="cp-status-h">
                {blocked
                  ? `התנגשות עם ${conflicts.length} לילות תפוסים`
                  : unknown > 0
                    ? `${unknown} מהלילות מחוץ לחלון היומן הטעון`
                    : "הטווח פנוי — אין הזמנות שנפגעות"}
              </p>
              <p className="cp-status-s">
                {blocked
                  ? conflicts
                      .map((c) => `${formatDayMonth(c.date)} · ${c.label}`)
                      .join("   |   ")
                  : unknown > 0
                    ? "אין עליהם נתוני תפוסה כאן — החפיפה תיבדק בשמירה"
                    : "החדר יוסר מהזמינות בכל הערוצים המחוברים"}
              </p>
            </div>
          </div>
        )}

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
