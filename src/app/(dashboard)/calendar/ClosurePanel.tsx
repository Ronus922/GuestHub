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
    <SidePanel open={open} onClose={onClose} title="סגירת חדר זמנית" icon="circle-slash">
      <div className="space-y-5">
        <label className="block">
          <span className="mb-1.5 block text-sm font-semibold text-text2">חדר *</span>
          <select className="field" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
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
          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold text-text2">מתאריך *</span>
            <input
              type="date"
              className="field"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold text-text2">
              עד תאריך (לא כולל) *
            </span>
            <input
              type="date"
              className="field"
              value={endDate}
              min={startDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </label>
        </div>

        {nights > 0 && (
          <p className="rounded-xl bg-[#FDE7EC] px-4 py-3 text-sm font-semibold text-[#BE123C]">
            החדר ייסגר ל־{nights} לילות
          </p>
        )}

        <label className="block">
          <span className="mb-1.5 block text-sm font-semibold text-text2">סיבה</span>
          <input
            className="field"
            value={reason}
            placeholder="תחזוקה, צביעה, ליקוי…"
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>

        <div className="flex gap-3 pt-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || !roomId || !startDate || !endDate || nights < 1}
            onClick={submit}
          >
            {saving ? "סוגר…" : "סגור חדר"}
          </button>
          <button type="button" className="btn btn-outline" onClick={onClose}>
            ביטול
          </button>
        </div>
      </div>
    </SidePanel>
  );
}
