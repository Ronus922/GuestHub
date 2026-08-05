"use client";

import { GuestRow } from "@/components/shared/GuestRow";
import { formatDayMonth } from "@/lib/dates";
import type { ReviewRow } from "../data";

// ============================================================
// rvw — חוות דעת Booking.com (DeshbordMain.md §5.4), read-only.
//
// THE SCORE WEARS THE AVATAR. GuestRow's leading circle is the row's one
// prominent slot, and a review's identity is its number, not its initials.
// Below 6 the circle goes warn — a poor score is an attention state, the same
// tone the departures column already wears.
//
// READ-ONLY REFLECTION: a reply is written only in the Booking.com extranet
// and arrives here through the Beds24 poll. No reply endpoint exists (Beds24
// support, 2026-08-02) — so there is no compose control, and
// channel_reviews.url is deliberately rendered nowhere.
//
// reservationId rides the row for the drill-in a later phase may add; a uuid
// is not an operator-readable fact, so it is not rendered.
// ============================================================

export function ReviewsWindow({ rows }: { rows: ReviewRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="empty-state empty-sm">
        <span className="empty-t">אין חוות דעת</span>
      </div>
    );
  }
  return (
    <>
      {rows.map((r) => (
        <GuestRow
          key={r.reviewId}
          initials={scoreLabel(r.overallScore)}
          name={r.guestName}
          subline={subline(r)}
          tone={r.overallScore < 6 ? "warn" : "brand"}
          trailing={
            r.awaitingReply ? <span className="chip chip-approval">ממתינה למענה</span> : undefined
          }
        />
      ))}
    </>
  );
}

/** 10 → "10", 7.5 → "7.5" — the wire's fractional score, no padded zeros. */
function scoreLabel(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

/** "4/8 · חיובי: … · שלילי: …" — a score-only review shows just the day. */
function subline(r: ReviewRow): React.ReactNode {
  return (
    <>
      <span className="ltr-num">{formatDayMonth(r.submittedAt)}</span>
      {r.positiveText && ` · חיובי: ${r.positiveText}`}
      {r.negativeText && ` · שלילי: ${r.negativeText}`}
    </>
  );
}
