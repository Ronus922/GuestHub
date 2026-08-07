"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { StatusButton } from "@/components/shared/StatusButton";
import { setWorkflowStatusAction } from "@/app/(dashboard)/reservations/actions";
import { formatDayMonth } from "@/lib/dates";
import type { PayRow } from "../data";

// ============================================================
// pay — כרטיסי אשראי לחיוב. NOT a charging terminal: no gateway is configured
// (getPaymentGateway() returns null) and this window never attempts a real
// charge. "חויב" is the operator's STATEMENT that the deal is settled, and per
// D89 that statement has exactly one home — the workflow lookup key
// 'approved', written through the SAME setWorkflowStatusAction the edit
// panel's status select calls. One action, one audit trail
// (workflow_status_change), zero new writes.
//
// The id it writes arrives from the server resolved BY KEY on every read —
// never a hardcoded uuid. When the tenant deactivated the approved status,
// approvedId is null and the button disables: assigning a retired status is
// exactly what setWorkflowStatusAction rejects, so the window does not offer
// it.
//
// D139: the list has NO status whitelist — every lifecycle status is in
// until the deal is approved, and a CANCELLED booking is in deliberately (a
// no-cancellation policy entitles full payment — the debt easiest to miss).
// It carries a "בוטלה" tag so the row is not read as an in-house guest;
// sort, severity and the amount branches treat it like any other row. The
// one exception is draft (D140: not an unpaid booking — a booking not yet
// made).
//
// BALANCE IS DISPLAY ONLY (D52 §6 — the derived cache, total − paid, not
// floored). A zero balance still lists — the condition is the approval, not
// the money — and renders "0 — לאישור בלבד" with an unemphasized button. A
// negative balance is a customer credit and renders as one, never as debt.
// The footer sums POSITIVE balances only: credits are money to give back, and
// netting them against other guests' debts would understate what the desk
// must collect today.
//
// An approved row keeps its place as the "חויב ✓" chip until the SSE refresh
// drops it — vanishing under the operator's hand is the hk window's
// documented trap, honoured here too.
// ============================================================

const ils = (n: number) => `₪${Math.round(Math.abs(n)).toLocaleString("he-IL")}`;

// days since check-in → the row's severity tone (0 neutral · 1–2 amber · 3+ red)
const tone = (days: number): "neutral" | "amber" | "red" =>
  days >= 3 ? "red" : days >= 1 ? "amber" : "neutral";

export function PayWindow({
  rows,
  approvedId,
}: {
  rows: PayRow[];
  approvedId: string | null;
}) {
  const [charged, setCharged] = useState<Record<string, true>>({});
  const [pending, start] = useTransition();

  const markCharged = (r: PayRow) => {
    if (!approvedId) return;
    setCharged((d) => ({ ...d, [r.reservationId]: true }));
    start(async () => {
      const res = await setWorkflowStatusAction({
        reservationId: r.reservationId,
        workflowStatusId: approvedId,
      });
      if (res.success) toast.success(`ההזמנה של ${r.guestName} סומנה כחויבה`);
      else {
        setCharged((d) => {
          const next = { ...d };
          delete next[r.reservationId];
          return next;
        });
        toast.error(res.error);
      }
    });
  };

  if (rows.length === 0) {
    return (
      <div className="empty-state empty-sm">
        <span className="empty-t">אין כרטיסים לחיוב ✓</span>
      </div>
    );
  }

  const open = rows.filter((r) => !(r.reservationId in charged));
  // credits are NOT netted — the footer states what there is to collect
  const totalDue = open.reduce((s, r) => s + Math.max(0, r.balance), 0);

  return (
    <>
      {rows.map((r) => {
        const done = r.reservationId in charged;
        const t = tone(r.daysSince);
        return (
          <div key={r.reservationId} className={`pay-row${done ? " done" : ""}`}>
            <span className={`alr-icon${t === "neutral" ? " pay-neutral" : ` alr-${t}`}`}>
              <Icon name="credit-card" size={20} />
            </span>
            <Link
              href={`/reservations?open=${r.reservationId}`}
              className="pay-body"
            >
              <span className="pay-title">
                <span className="pay-dot" style={{ background: r.sourceDotColor }} aria-hidden />
                {r.guestName}
                {r.cancelled && <span className="chip pay-tag-cxl">בוטלה</span>}
              </span>
              <span className="pay-sub">
                {r.roomNumber ? `חדר ${r.roomNumber} · ` : ""}
                צ׳ק-אין {formatDayMonth(r.checkIn)}
                {r.daysSince > 0 && ` · לפני ${r.daysSince === 1 ? "יום" : `${r.daysSince} ימים`}`}
              </span>
            </Link>
            {r.balance < 0 ? (
              <span className="pay-amount pay-credit">
                זיכוי <span className="ltr-num">{ils(r.balance)}</span>
              </span>
            ) : r.balance === 0 ? (
              <span className="pay-amount pay-zero">0 — לאישור בלבד</span>
            ) : (
              <span className="pay-amount ltr-num">{ils(r.balance)}</span>
            )}
            {done ? (
              <StatusButton state="done" icon="check-circle" label="חויב ✓" />
            ) : r.balance > 0 ? (
              <StatusButton
                state="primary"
                label="חויב"
                disabled={pending || !approvedId}
                title={approvedId ? undefined : "סטטוס האישור מושבת בהגדרות"}
                onClick={() => markCharged(r)}
              />
            ) : (
              <button
                type="button"
                className="btn btn-sm btn-secondary btn-status"
                disabled={pending || !approvedId}
                title={approvedId ? undefined : "סטטוס האישור מושבת בהגדרות"}
                onClick={() => markCharged(r)}
              >
                חויב
              </button>
            )}
          </div>
        );
      })}
      <div className="pay-foot">
        סה״כ לחיוב: <span className="ltr-num">{ils(totalDue)}</span> ·{" "}
        <span className="ltr-num">{open.length}</span> כרטיסים
      </div>
    </>
  );
}
