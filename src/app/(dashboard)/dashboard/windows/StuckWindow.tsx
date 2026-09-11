"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { StatusButton } from "@/components/shared/StatusButton";
import { resolveSyncErrorAction } from "@/lib/channel/admin";
import { formatDayMonth } from "@/lib/dates";
import type { StuckSummary } from "../data";
import type { StuckViolationRow } from "@/lib/channel/stuck-panel";

// ============================================================
// stk — הזמנות ערוץ שנתקעו. TWO sources, one window (D184):
//
// 1. THE COUNTER. import_status quarantined/failed is technical (no
//    room/rate-plan mapping, a transient import error), the fix lives on
//    /channels, and most parked revisions never became a reservation — so it
//    is a number, not a list, and its job is to be impossible to miss. The tone
//    IS the data: 1–2 amber, 3+ red. SELF-DRAINING: the 5-minute pull retries
//    every such revision, so fixing the mapping empties it by itself.
//
// 2. THE VIOLATIONS. An OTA booking that broke a stay restriction was imported
//    anyway (D153) and reported to channel_sync_errors. Unlike the counter this
//    IS a list — there is a reservation to open — and it is NOT self-draining:
//    the row is evidence of a defect upstream (the wrong restriction published,
//    or an extranet override), and only an operator saying "טופל" closes it.
//    resolveSyncErrorAction writes resolved_at + resolved_by; nothing is
//    deleted. A row whose booking ALSO has a parked revision carries "תקועה"
//    as well — the counter counts it, the list shows it, once.
//
// The empty state is unchanged and appears only when BOTH sources are empty.
// A resolved row keeps its place as the "טופל ✓" chip until the SSE refresh
// drops it — vanishing under the operator's hand is the hk window's
// documented trap, honoured here too.
// ============================================================

export function StuckWindow({
  stuck,
  canResolve,
}: {
  stuck: StuckSummary;
  /** canManageChannels — the same gate the action enforces server-side */
  canResolve: boolean;
}) {
  const { count, violations } = stuck;
  if (count === 0 && violations.length === 0) {
    return (
      <div className="empty-state empty-sm">
        <span className="empty-t">אין תקועות ✓</span>
        <span className="empty-s">כל הזמנות הערוץ נקלטו אוטומטית.</span>
      </div>
    );
  }
  return (
    <>
      {count > 0 && <StuckCounter count={count} oldestHours={stuck.oldestHours} />}
      {violations.length > 0 && <ViolationList rows={violations} canResolve={canResolve} />}
    </>
  );
}

function StuckCounter({ count, oldestHours }: { count: number; oldestHours: number | null }) {
  const tone = count >= 3 ? "red" : "amber";
  return (
    <div className={`stk-hero stk-${tone}`}>
      <span className="stk-count ltr-num">{count}</span>
      <span className="stk-body">
        <span className="stk-title">
          {count === 1 ? "הזמנה אחת נתקעה בקליטה" : "הזמנות נתקעו בקליטה"}
        </span>
        <span className="stk-sub">{oldestLabel(oldestHours)}</span>
      </span>
      <Link href="/channels" className="btn btn-sm btn-secondary stk-open">
        <Icon name="channels" size={17} />
        פתח את הרשימה
      </Link>
    </div>
  );
}

function ViolationList({ rows, canResolve }: { rows: StuckViolationRow[]; canResolve: boolean }) {
  const [resolved, setResolved] = useState<Record<string, true>>({});
  const [pending, start] = useTransition();

  const resolve = (r: StuckViolationRow) => {
    const revert = () =>
      setResolved((d) => {
        const next = { ...d };
        delete next[r.errorId];
        return next;
      });
    setResolved((d) => ({ ...d, [r.errorId]: true }));
    start(async () => {
      // the awaited action can THROW, not only return {success:false} (a
      // deploy that replaced the action id, a dropped connection) — both
      // shapes revert the optimistic chip and say so (the pay window's lesson)
      try {
        const res = await resolveSyncErrorAction(r.errorId);
        if (res.success) toast.success(`ההפרה בהזמנה ${r.reservationNumber} סומנה כטופלה`);
        else {
          revert();
          toast.error(res.error);
        }
      } catch (e) {
        revert();
        console.error("[stk] resolve failed", e);
        toast.error("הסימון לא נשמר — רענן את הדף ונסה שוב");
      }
    });
  };

  return (
    <div className="stk-vio-list">
      {rows.map((r) => {
        const done = r.errorId in resolved;
        return (
          <div key={r.errorId} className={`stk-vio-row${done ? " done" : ""}`}>
            <span className="alr-icon alr-red">
              <Icon name="warning" size={20} />
            </span>
            <Link href={`/reservations?open=${r.reservationId}`} className="stk-vio-body">
              <span className="stk-vio-title">
                <span className="stk-vio-guest">{r.guestName}</span>
                {r.stuck && <span className="chip stk-vio-tag-stuck">תקועה</span>}
                {r.cancelled && <span className="chip pay-tag-cxl">בוטלה</span>}
              </span>
              <span className="stk-vio-mark">
                <Icon name="warning" size={13.5} />
                {markerText(r)}
              </span>
              <span className="stk-vio-sub">{subline(r)}</span>
            </Link>
            {done ? (
              <StatusButton state="done" icon="check-circle" label="טופל ✓" />
            ) : (
              <StatusButton
                state="primary"
                label="סמן כטופל"
                disabled={pending || !canResolve}
                title={canResolve ? undefined : "סימון כטופל זמין למנהל-על בלבד"}
                onClick={() => resolve(r)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// "מפרה מינימום 2 לילות בטווח זה" — the engine's own sentence, prefixed
function markerText(r: StuckViolationRow): string {
  return `מפרה ${r.violationText}`;
}

// "#1164 · Booking.com · חדר 1245 · 11/09–12/09 · לילה אחד"
function subline(r: StuckViolationRow): string {
  const parts = [`#${r.reservationNumber}`];
  if (r.otaName) parts.push(OTA_LABEL[r.otaName.toLowerCase()] ?? r.otaName);
  if (r.roomNumber) parts.push(`חדר ${r.roomNumber}`);
  parts.push(`${formatDayMonth(r.checkIn)}–${formatDayMonth(r.checkOut)}`);
  parts.push(nightsLabel(r.nights));
  return parts.join(" · ");
}

const OTA_LABEL: Record<string, string> = {
  booking: "Booking.com",
  expedia: "Expedia",
  airbnb: "Airbnb",
  agoda: "Agoda",
};

function nightsLabel(n: number): string {
  if (n === 1) return "לילה אחד";
  if (n === 2) return "שני לילות";
  return `${n} לילות`;
}

// "הוותיקה ביותר לפני X שעות" — hours are the native unit; a day-old stuck
// booking escalates to days rather than stating "49 שעות".
function oldestLabel(hours: number | null): string {
  if (hours === null || hours < 1) return "הוותיקה ביותר — פחות משעה";
  if (hours === 1) return "הוותיקה ביותר לפני שעה";
  if (hours < 48) return `הוותיקה ביותר לפני ${hours} שעות`;
  return `הוותיקה ביותר לפני ${Math.floor(hours / 24)} ימים`;
}
