import Link from "next/link";
import { Icon } from "@/components/shared/Icon";
import type { StuckSummary } from "../data";

// ============================================================
// stk — הזמנות ערוץ שנתקעו. A COUNTER, not a list: the failure is technical
// (no room/rate-plan mapping, a transient import error), so the fix lives on
// /channels, and this card's job is to make the number impossible to miss.
//
// The tone IS the data: 0 renders the calm empty state, 1–2 amber, 3+ red —
// the card the operator glances at from across the room.
//
// SELF-DRAINING. import_status quarantined/failed is not terminal — the
// 5-minute pull retries every such revision each cycle, so fixing the mapping
// empties this card without anyone pressing anything. The button navigates to
// /channels, where the quarantine counter and the sync errors live.
// ============================================================

export function StuckWindow({ stuck }: { stuck: StuckSummary }) {
  if (stuck.count === 0) {
    return (
      <div className="empty-state empty-sm">
        <span className="empty-t">אין תקועות ✓</span>
        <span className="empty-s">כל הזמנות הערוץ נקלטו אוטומטית.</span>
      </div>
    );
  }
  const tone = stuck.count >= 3 ? "red" : "amber";
  return (
    <div className={`stk-hero stk-${tone}`}>
      <span className="stk-count ltr-num">{stuck.count}</span>
      <span className="stk-body">
        <span className="stk-title">
          {stuck.count === 1 ? "הזמנה אחת נתקעה בקליטה" : "הזמנות נתקעו בקליטה"}
        </span>
        <span className="stk-sub">{oldestLabel(stuck.oldestHours)}</span>
      </span>
      <Link href="/channels" className="btn btn-sm btn-secondary stk-open">
        <Icon name="channels" size={17} />
        פתח את הרשימה
      </Link>
    </div>
  );
}

// "הוותיקה ביותר לפני X שעות" — hours are the native unit; a day-old stuck
// booking escalates to days rather than stating "49 שעות".
function oldestLabel(hours: number | null): string {
  if (hours === null || hours < 1) return "הוותיקה ביותר — פחות משעה";
  if (hours === 1) return "הוותיקה ביותר לפני שעה";
  if (hours < 48) return `הוותיקה ביותר לפני ${hours} שעות`;
  return `הוותיקה ביותר לפני ${Math.floor(hours / 24)} ימים`;
}
