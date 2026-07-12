"use client";

import { useEffect, useState, useTransition } from "react";
import { Icon } from "@/components/shared/Icon";
import { previewRescheduleAction } from "@/app/(dashboard)/reservations/actions";
import type { RescheduleOp } from "@/lib/calendar-interactions";
import type { DateOnly } from "@/lib/dates";

// Floating RTL confirmation for a drag/resize of an EXISTING reservation (§2/§3),
// styled 1:1 to ref/screens/Change of stay.png (ref/html/Calendar messages.html
// .ch window): brand header, before/after cards with a 3-column grid, changed
// values highlighted, primary "אישור שינוי". Behavior unchanged (D43): nothing
// is persisted until אישור; ביטול, Escape and outside-click all reject and
// restore the original pill. The proposed total is fetched pre-commit via
// previewRescheduleAction (no writes); the commit re-validates on the server.

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

const dmy = (d: DateOnly) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

function StayCard({
  tag,
  aft,
  nights,
  checkIn,
  checkOut,
  roomLabel,
  changed,
  children,
}: {
  tag: string;
  aft?: boolean;
  nights: number;
  checkIn: DateOnly;
  checkOut: DateOnly;
  roomLabel: string;
  changed?: { ci: boolean; co: boolean; room: boolean };
  children?: React.ReactNode;
}) {
  return (
    <div className={`ch-card ${aft ? "aft" : ""}`}>
      <div className="ch-cr">
        <span className="ch-tag">{tag}</span>
        <span className="ch-n">{nights} לילות</span>
      </div>
      <div className="ch-grid">
        <div className="ch-cell">
          <span className="ch-cl">כניסה</span>
          <span className={`ch-cv ${changed?.ci ? "chg" : ""}`}>{dmy(checkIn)}</span>
        </div>
        <div className="ch-cell">
          <span className="ch-cl">יציאה</span>
          <span className={`ch-cv ${changed?.co ? "chg" : ""}`}>{dmy(checkOut)}</span>
        </div>
        <div className="ch-cell">
          <span className="ch-cl">חדר</span>
          <span className={`ch-cv ${changed?.room ? "chg" : ""}`} title={roomLabel}>
            {roomLabel}
          </span>
        </div>
      </div>
      {children}
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
        className="modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="md-hd">
          <span className="md-icon">
            <Icon name="calendar" size={20} />
          </span>
          <div className="min-w-0">
            <div className="md-title">{OP_LABEL[op]}</div>
            <div className="md-sub">
              {proposal.guestName} · הזמנה <span className="ltr-num">#{proposal.reservationNumber}</span>
            </div>
          </div>
        </div>

        <div className="md-bd ch-body">
          <StayCard
            tag="לפני"
            nights={before.nights}
            checkIn={before.checkIn}
            checkOut={before.checkOut}
            roomLabel={before.roomLabel}
          />
          <div className="ch-arrow">
            <Icon name="arrow-up" size={20} />
          </div>
          <StayCard
            tag="אחרי"
            aft
            nights={after.nights}
            checkIn={after.checkIn}
            checkOut={after.checkOut}
            roomLabel={after.roomLabel}
            changed={{
              ci: before.checkIn !== after.checkIn,
              co: before.checkOut !== after.checkOut,
              room: before.roomLabel !== after.roomLabel,
            }}
          >
            {/* proposed total — pre-commit preview, never persisted here */}
            <div className="ch-money">
              <span className="lbl">סה״כ הזמנה</span>
              <span className="old">{money(before.total)}</span>
              {loadingPrice || proposedTotal === null ? (
                <span className="new">{priceError ?? "מחשב…"}</span>
              ) : (
                <span className="new">{money(proposedTotal)}</span>
              )}
              {priceDiff !== null && priceDiff !== 0 && (
                <span className={`diff ${priceDiff > 0 ? "up" : "down"}`}>
                  {priceDiff > 0 ? "+" : ""}
                  {money(priceDiff)}
                </span>
              )}
            </div>
          </StayCard>
        </div>

        {/* §7 footer: the primary action hugs the LEFT edge, "ביטול" to its right */}
        <div className="md-ft">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onConfirm}
            disabled={committing || Boolean(priceError)}
          >
            <Icon name="check-circle" size={20} />
            {committing ? "מעדכן…" : "אישור שינוי"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onReject}
            disabled={committing}
          >
            ביטול
          </button>
        </div>
      </div>
    </div>
  );
}
