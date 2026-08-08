"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Icon, type IconName } from "@/components/shared/Icon";
import { StatusButton } from "@/components/shared/StatusButton";
import { setReservationStatusAction } from "@/app/(dashboard)/reservations/actions";
import type { AlertRow } from "../data";

// ============================================================
// alr — דורש טיפול (DeshbordMain.md §5.1). CURATED, not exhaustive.
//
// Only signals a GUEST feels: money owed, a card that will fail at the desk, a
// booking nobody approved, a message that never arrived, a channel connection
// that has actually stopped working (D133 — six measured conditions, none of
// them the access token's TTL, which is a constant and never an alert).
//
// EXCLUDED DELIBERATELY, and this is the point of the window:
//  · channel_dirty_ranges — 1,041 permanent rows (audit §7.1). An operational
//    backlog, not a guest-facing alert. It would be the permanent top line and
//    would drown every real signal beneath it.
//  · "חוסר מלאי" — the schema has no stock concept at all (contradiction 15).
//    A row with no source is a lie with a nice icon.
//
// The live counts are low, so this window looks sparse. That is the honest
// state of the property; padding it would make the sparse case unreadable on
// the day it finally matters.
//
// THE אישור BUTTON. An approval row whose check-in has arrived and whose
// lifecycle is still draft carries the one action the operator needs right
// there: draft → confirmed, the same setReservationStatusAction the arr
// buttons use. On success the row's button becomes the "אושרה" chip and the
// row stays — vanishing under the operator's hand is the hk window's
// documented trap, honoured here too.
// ============================================================

const ICON: Record<AlertRow["kind"], IconName> = {
  unpaid: "money-off",
  partial: "payments",
  card: "credit-card",
  approval: "hourglass",
  message: "mail-unread",
  connection: "channels",
};

export function AlertsWindow({ rows }: { rows: AlertRow[] }) {
  const [approved, setApproved] = useState<Record<string, true>>({});
  const [pending, start] = useTransition();

  const approve = (a: AlertRow) => {
    const id = a.approveReservationId;
    if (!id) return;
    setApproved((d) => ({ ...d, [a.id]: true }));
    start(async () => {
      const res = await setReservationStatusAction(id, "confirmed");
      if (res.success) toast.success("ההזמנה אושרה");
      else {
        setApproved((d) => {
          const next = { ...d };
          delete next[a.id];
          return next;
        });
        toast.error(res.error);
      }
    });
  };

  if (rows.length === 0) {
    return (
      <div className="empty-state empty-sm">
        <span className="empty-t">אין פריטים שדורשים טיפול ✓</span>
      </div>
    );
  }
  return (
    <>
      {rows.map((a) => {
        const body = (
          <>
            <span className={`alr-icon alr-${a.severity}`}>
              <Icon name={ICON[a.kind]} size={20} />
            </span>
            <span className="alr-body">
              <span className="alr-title">
                {a.title}
                {a.cancelled && <span className="chip alr-tag-cxl">בוטלה</span>}
              </span>
              <span className="alr-sub">{a.detail}</span>
            </span>
          </>
        );
        if (a.approveReservationId) {
          // the row needs BOTH a navigation and a button — a button inside a
          // <Link> is invalid markup, so the link wraps only the text half
          return (
            <div key={a.id} className="alr-row">
              {a.href ? (
                <Link href={a.href} className="alr-link">
                  {body}
                </Link>
              ) : (
                body
              )}
              {approved[a.id] ? (
                <StatusButton state="done" icon="check-circle" label="אושרה" />
              ) : (
                <StatusButton
                  state="primary"
                  label="אישור"
                  disabled={pending}
                  onClick={() => approve(a)}
                />
              )}
            </div>
          );
        }
        return a.href ? (
          <Link key={a.id} href={a.href} className="alr-row">
            {body}
          </Link>
        ) : (
          <div key={a.id} className="alr-row">
            {body}
          </div>
        );
      })}
    </>
  );
}
