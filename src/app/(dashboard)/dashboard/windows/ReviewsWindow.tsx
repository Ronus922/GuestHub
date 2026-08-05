"use client";

import { Icon } from "@/components/shared/Icon";
import type { ReviewRow, ReviewsSummary } from "../data";
import { WindowHero } from "./WindowHero";

// ============================================================
// rvw — חוות דעת Booking.com, v2 (design-ref/DeshbordMain §5.4), read-only.
//
// HERO FIRST: the tenant's whole record in one tile — average, its word,
// count, month-over-month drift, and the amber "N ללא מענה" chip (omitted at
// zero: an empty warning is noise wearing a colour). Then the latest three
// reviews, WHOLE — no truncation, both sides when the guest wrote both.
//
// READ-ONLY REFLECTION: a reply is written only in the Booking.com extranet
// and arrives here through the Beds24 poll. No reply endpoint exists (Beds24
// support, 2026-08-02), the full-reviews screen does not exist yet — so no
// compose control, no footer button, no link pretending otherwise.
//
// THE BADGE IS THE ROW'S IDENTITY. A review's face is its number; below 7 it
// wears the danger tint (the mock's 6.3 is red). A score-only review
// (content NULL — a real, common wire state) is name + badge, no text block.
// ============================================================

export function ReviewsWindow({
  summary,
  rows,
}: {
  summary: ReviewsSummary;
  rows: ReviewRow[];
}) {
  if (summary.totalCount === 0 || rows.length === 0) {
    return (
      <div className="empty-state empty-sm">
        <span className="empty-t">אין חוות דעת</span>
      </div>
    );
  }
  return (
    <>
      <WindowHero
        value={(summary.avgScore ?? 0).toFixed(1)}
        headline={scoreWord(summary.avgScore ?? 0)}
        subline={
          <>
            <span className="ltr-num">{summary.totalCount}</span> חוות דעת
            {deltaText(summary.deltaVsLastMonth)}
          </>
        }
        chip={
          summary.awaitingReplyCount > 0 ? (
            <span className="chip chip-approval">
              <Icon name="forum" size={13.5} />
              <span className="ltr-num">{summary.awaitingReplyCount}</span> ללא מענה
            </span>
          ) : undefined
        }
      />
      {rows.map((r) => (
        <div className="win-row" key={r.reviewId}>
          <span className={`rvw-badge ltr-num${r.overallScore < 7 ? " low" : ""}`}>
            {scoreLabel(r.overallScore)}
          </span>
          <div className="win-row-body">
            <div className="win-row-name">
              {r.guestName}
              {r.countryCode && <span className="win-row-sub">· {countryLabel(r.countryCode)}</span>}
            </div>
            {r.positiveText && (
              <p className="win-row-text" dir="auto">
                {r.negativeText && <span className="win-row-k">חיובי · </span>}
                {r.positiveText}
              </p>
            )}
            {r.negativeText && (
              <p className="win-row-text" dir="auto">
                {r.positiveText && <span className="win-row-k">שלילי · </span>}
                {r.negativeText}
              </p>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

/** the hero's word for the average: ≥9 מצוין · ≥8 מעולה · ≥7 טוב · ≥6 סביר · else חלש */
function scoreWord(score: number): string {
  if (score >= 9) return "מצוין";
  if (score >= 8) return "מעולה";
  if (score >= 7) return "טוב";
  if (score >= 6) return "סביר";
  return "חלש";
}

/** 10 → "10", 7.5 → "7.5" — the wire's fractional score, no padded zeros. */
function scoreLabel(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

/** " · +0.2 מהחודש שעבר" — silent when there is nothing older to compare to. */
function deltaText(delta: number | null): React.ReactNode {
  if (delta === null) return null;
  if (delta === 0) return <> · ללא שינוי מהחודש שעבר</>;
  return (
    <>
      {" · "}
      <span className="ltr-num">{delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1)}</span>{" "}
      מהחודש שעבר
    </>
  );
}

// Hebrew country names straight from CLDR — a hand map would age the moment a
// guest arrives from somewhere it never listed. fallback:"code" keeps an
// unknown-but-well-formed code visible instead of dropping the fact.
const COUNTRY_NAMES = new Intl.DisplayNames(["he"], { type: "region", fallback: "code" });

function countryLabel(code: string): string {
  const cc = code.toUpperCase();
  try {
    return COUNTRY_NAMES.of(cc) ?? cc;
  } catch {
    // of() throws on a malformed code — the wire value is still worth showing
    return cc;
  }
}
