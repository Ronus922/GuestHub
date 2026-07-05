"use client";

import { useEffect, useState, useTransition } from "react";
import { Icon } from "@/components/shared/Icon";
import { previewRescheduleAction } from "@/app/(dashboard)/reservations/actions";
import type { RescheduleOp } from "@/lib/calendar-interactions";
import type { DateOnly } from "@/lib/dates";

// Floating RTL confirmation for a drag/resize of an EXISTING reservation (§2/§3).
// Nothing is persisted until "אישור"; "דחייה", Escape and outside-click all
// reject and restore the original pill (the grid never mutated it). The
// proposed reservation total is fetched pre-commit via previewRescheduleAction
// (no writes); the commit re-validates on the server.

const OP_LABEL: Record<RescheduleOp, string> = {
  room: "שינוי חדר",
  dates: "שינוי תאריכים",
  extend: "הארכת שהות",
  shorten: "קיצור שהות",
  room_dates: "שינוי חדר ותאריכים",
  none: "אין שינוי",
};

export type MoveProposal = {
  rrId: string;
  op: RescheduleOp;
  guestName: string;
  reservationNumber: string;
  targetRoomId: string;
  before: { roomLabel: string; checkIn: DateOnly; checkOut: DateOnly; nights: number; total: number };
  after: { roomLabel: string; checkIn: DateOnly; checkOut: DateOnly; nights: number };
};

function Row({ label, from, to }: { label: string; from: string; to: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="text-muted">{label}</span>
      <span className="flex items-center gap-2 font-semibold" dir="ltr">
        <span className="text-muted line-through">{from}</span>
        <Icon name="chevron-left" size={14} />
        <span className="text-ink">{to}</span>
      </span>
    </div>
  );
}

export function MoveConfirmDialog({
  proposal,
  currency,
  committing,
  onConfirm,
  onReject,
}: {
  proposal: MoveProposal;
  currency: string;
  committing: boolean;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const { op, before, after } = proposal;
  const [proposedTotal, setProposedTotal] = useState<number | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [loadingPrice, startPrice] = useTransition();

  // Escape rejects (§3)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onReject();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onReject]);

  // fetch the pre-commit proposed total (no persistence)
  useEffect(() => {
    startPrice(async () => {
      const res = await previewRescheduleAction({
        rrId: proposal.rrId,
        targetRoomId: proposal.targetRoomId,
        checkIn: after.checkIn,
        checkOut: after.checkOut,
      });
      if (res.success && res.data) {
        setProposedTotal(res.data.proposedTotal);
        setPriceError(null);
      } else {
        setPriceError(res.success ? "שגיאה" : res.error);
      }
    });
  }, [proposal.rrId, proposal.targetRoomId, after.checkIn, after.checkOut, startPrice]);

  const money = (n: number) => `${currency}${Math.round(n).toLocaleString()}`;
  const roomChanged = before.roomLabel !== after.roomLabel;
  const ciChanged = before.checkIn !== after.checkIn;
  const coChanged = before.checkOut !== after.checkOut;
  const nightsChanged = before.nights !== after.nights;
  const nightsDelta = after.nights - before.nights;
  const priceDiff = proposedTotal === null ? null : proposedTotal - before.total;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30"
      dir="rtl"
      onClick={onReject}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={OP_LABEL[op]}
        className="w-[min(92vw,26rem)] rounded-2xl border border-black/10 bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2 text-base font-extrabold text-ink">
          <Icon name="calendar" size={18} />
          {OP_LABEL[op]}
        </div>

        <div className="mb-1 flex items-center justify-between text-sm">
          <span className="text-muted">אורח</span>
          <span className="font-semibold text-ink">{proposal.guestName}</span>
        </div>
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="text-muted">מספר הזמנה</span>
          <span className="font-semibold text-ink" dir="ltr">#{proposal.reservationNumber}</span>
        </div>

        <div className="my-2 border-t border-black/5" />

        {roomChanged && <Row label="חדר" from={before.roomLabel} to={after.roomLabel} />}
        {ciChanged && <Row label="כניסה" from={before.checkIn} to={after.checkIn} />}
        {coChanged && <Row label="יציאה" from={before.checkOut} to={after.checkOut} />}
        {nightsChanged && (
          <Row
            label="לילות"
            from={String(before.nights)}
            to={`${after.nights} (${nightsDelta > 0 ? "+" : ""}${nightsDelta})`}
          />
        )}

        <div className="my-2 border-t border-black/5" />

        <div className="flex items-center justify-between py-1 text-sm">
          <span className="text-muted">סה״כ הזמנה</span>
          <span className="flex items-center gap-2 font-semibold" dir="ltr">
            <span className="text-muted line-through">{money(before.total)}</span>
            <Icon name="chevron-left" size={14} />
            {loadingPrice || proposedTotal === null ? (
              <span className="text-muted">{priceError ?? "מחשב…"}</span>
            ) : (
              <span className="text-ink">{money(proposedTotal)}</span>
            )}
          </span>
        </div>
        {priceDiff !== null && priceDiff !== 0 && (
          <div className="flex items-center justify-between pb-1 text-sm">
            <span className="text-muted">הפרש מחיר</span>
            <span className={`font-bold ${priceDiff > 0 ? "text-red-600" : "text-emerald-600"}`} dir="ltr">
              {priceDiff > 0 ? "+" : ""}
              {money(priceDiff)}
            </span>
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" className="bw-btn bw-btn-ghost" onClick={onReject} disabled={committing}>
            דחייה
          </button>
          <button
            type="button"
            className="bw-btn bw-btn-o"
            onClick={onConfirm}
            disabled={committing || Boolean(priceError)}
          >
            <Icon name="check" size={15} />
            {committing ? "מעדכן…" : "אישור"}
          </button>
        </div>
      </div>
    </div>
  );
}
