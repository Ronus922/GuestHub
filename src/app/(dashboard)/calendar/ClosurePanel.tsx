"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { SidePanel } from "@/components/ui/SidePanel";
import { nightsBetween } from "@/lib/dates";
import { createClosureAction } from "./actions";
import type { CalendarRoom } from "./types";

export type ClosurePrefill = {
  roomId?: string;
  startDate?: string;
  endDate?: string;
};

// "סגור חדר" — temporary date-range closure (start-inclusive / end-exclusive,
// minimum one hotel night). Uses guesthub.room_closures, never rooms.status.
export function ClosurePanel({
  open,
  onClose,
  prefill,
  rooms,
}: {
  open: boolean;
  onClose: () => void;
  prefill: ClosurePrefill;
  rooms: CalendarRoom[];
}) {
  const [roomId, setRoomId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");
  const [saving, startSaving] = useTransition();

  useEffect(() => {
    if (!open) return;
    setRoomId(prefill.roomId ?? "");
    setStartDate(prefill.startDate ?? "");
    setEndDate(prefill.endDate ?? "");
    setReason("");
  }, [open, prefill.roomId, prefill.startDate, prefill.endDate]);

  const nights =
    startDate && endDate && endDate > startDate ? nightsBetween(startDate, endDate) : 0;

  const submit = () =>
    startSaving(async () => {
      const res = await createClosureAction({ roomId, startDate, endDate, reason });
      if (res.success) {
        toast.success("החדר נסגר לטווח שנבחר");
        onClose();
      } else {
        toast.error(res.error);
      }
    });

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title="סגירת חדר זמנית"
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
            {saving ? "סוגר…" : "סגור חדר"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            ביטול
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <label className="field">
          <span className="field-label">חדר *</span>
          <select
            className="field-input"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
          >
            <option value="">בחירת חדר…</option>
            {rooms
              .filter((r) => r.status === "available" && r.is_active)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.room_number}
                  {r.name && r.name !== r.room_number ? ` · ${r.name}` : ""}
                </option>
              ))}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-4">
          <label className="field">
            <span className="field-label">מתאריך *</span>
            <input
              type="date"
              className="field-input"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">עד תאריך (לא כולל) *</span>
            <input
              type="date"
              className="field-input"
              value={endDate}
              min={startDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </label>
        </div>

        {nights > 0 && (
          <p className="cb-closenote">
            החדר ייסגר ל־<span className="ltr-num">{nights}</span> לילות
          </p>
        )}

        <label className="field">
          <span className="field-label">סיבה</span>
          <input
            className="field-input"
            value={reason}
            placeholder="תחזוקה, צביעה, ליקוי…"
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>

      </div>
    </SidePanel>
  );
}
